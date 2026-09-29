// PaPadel cloud layer — pure logic: no DOM, no supabase-js, no localStorage.
// The client is injected, so every rule here is testable without a network.
//
// Shape on the server (supabase/migrations/0001_sessions.sql): one row per
// session, the whole engine session in `doc`. The client may only write `id`
// and `doc`; every other column is GENERATED from the doc.

export const ROW_COLUMNS = ['id', 'doc'];

export function toRow(session) {
  if (!session || typeof session !== 'object' || !session.id) return null;
  return { id: session.id, doc: session };
}

export function fromRow(row) {
  if (!row || typeof row !== 'object') return null;
  return row.doc ?? null;
}

// The remote is the source of truth when it answers: one live session, the
// rest is history ordered newest-first. Anything the engine cannot use is
// dropped here rather than crashing a render later.
export function splitSessions(docs) {
  const list = (Array.isArray(docs) ? docs : []).filter(
    (d) => d && typeof d === 'object' && d.id
  );
  const live = list.filter((d) => d.status === 'live').sort(byCreatedDesc);
  const finished = list.filter((d) => d.status !== 'live').sort(byDateDesc);
  // More than one live row means two browsers started a session at the same
  // time. Keep the newest and treat the others as finished so no data vanishes.
  const orphans = live.slice(1).map((d) => ({ ...d, status: 'finished' }));
  return { live: live[0] ?? null, finished: [...orphans, ...finished].sort(byDateDesc) };
}

function byDateDesc(a, b) {
  const da = String(a.date ?? '');
  const db = String(b.date ?? '');
  if (da !== db) return db.localeCompare(da);
  return byCreatedDesc(a, b);
}

function byCreatedDesc(a, b) {
  // Engine ids are `sess_<base36 timestamp>_<seq>`, so they order by creation.
  return String(b.id ?? '').localeCompare(String(a.id ?? ''));
}

// Debounced, retried, last-write-wins per session id. A flush that fails keeps
// the queue intact so the next attempt (or the next save) sends it again.
export function createSyncQueue({
  upsert,
  remove,
  debounceMs = 800,
  now = () => Date.now(),
  onState = () => {},
}) {
  const pending = new Map();
  let timer = null;
  let inFlight = null;

  const drain = async () => {
    if (inFlight) return inFlight;
    const batch = [...pending.entries()];
    if (!batch.length) {
      onState('idle', 0);
      return { ok: true, sent: 0 };
    }
    inFlight = (async () => {
      onState('sending', batch.length);
      try {
        for (const [id, op] of batch) {
          if (op.delete) await remove(id);
          else await upsert(op.doc);
          pending.delete(id);
        }
        onState('synced', 0);
        return { ok: true, sent: batch.length };
      } catch (err) {
        // Whatever is left stays queued; the UI shows it as pending so nobody
        // reads a failed write as a saved one.
        onState('error', pending.size);
        return { ok: false, error: err, queued: pending.size };
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };

  const schedule = () => {
    if (timer) clearTimeout(timer);
    onState('pending', pending.size);
    timer = setTimeout(() => {
      timer = null;
      void drain();
    }, debounceMs);
  };

  return {
    // A newer write for the same id replaces the older one: the doc is the
    // whole session, so only the last version matters.
    put(session) {
      if (!session?.id) return;
      pending.set(session.id, { doc: session });
      schedule();
    },
    drop(id) {
      if (!id) return;
      pending.set(id, { delete: true });
      schedule();
    },
    get size() {
      return pending.size;
    },
    flush() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      return drain();
    },
    clear() {
      pending.clear();
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      onState('idle', 0);
    },
  };
}

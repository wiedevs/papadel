// PaPadel cloud layer — pure logic: no DOM, no supabase-js, no localStorage.
// The client is injected, so every rule here is testable without a network.
//
// Shape on the server (supabase/migrations/0001_sessions.sql): one row per
// session, the whole engine session in `doc`. The client may only write `id`
// and `doc`; every other column is GENERATED from the doc.

export const ROW_COLUMNS = ['id', 'doc'];

// ---------------------------------------------------------------------------
// Alur login: lupa sandi + OAuth
// ---------------------------------------------------------------------------

const VERIFIER_BYTES = 32;

function toBase64Url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// PKCE: verifier stays in this tab, the server only ever sees its SHA-256.
export async function createPkcePair(webCrypto = globalThis.crypto) {
  const bytes = new Uint8Array(VERIFIER_BYTES);
  webCrypto.getRandomValues(bytes);
  const verifier = toBase64Url(bytes);
  const digest = new Uint8Array(await webCrypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  return { verifier, challenge: toBase64Url(digest) };
}

export function buildAuthorizeUrl({ url, provider, redirectTo, challenge }) {
  if (!provider) throw new Error('Provider login tidak disebut.');
  const q = new URLSearchParams({ provider, redirect_to: redirectTo });
  if (challenge) {
    q.set('flow_type', 'pkce');
    q.set('code_challenge', challenge);
    q.set('code_challenge_method', 'S256');
  }
  return `${url}/auth/v1/authorize?${q.toString()}`;
}

// Supabase hands the result back two ways: a `code` in the query (PKCE) or the
// tokens in the fragment (implicit). Recovery links arrive the same way, tagged
// `type=recovery`, so one reader covers both.
export function parseAuthRedirect({ search = '', hash = '' } = {}) {
  const query = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const frag = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
  const pick = (name) => query.get(name) ?? frag.get(name);
  const code = pick('code');
  if (code) return { kind: 'code', code };
  if (pick('error_description') || pick('error')) {
    return { kind: 'error', message: pick('error_description') || pick('error') };
  }
  const access = pick('access_token');
  if (!access) return null;
  return {
    kind: 'token',
    session: {
      access_token: access,
      refresh_token: pick('refresh_token'),
      expires_in: Number(pick('expires_in')) || 3600,
      token_type: pick('token_type'),
    },
    recovery: pick('type') === 'recovery',
  };
}

// The tokens sit in the address bar; leaving them there risks browser history
// and a shoulder. Strip only the auth parts, keep real query params.
const FRAGMENT_AUTH_KEYS = [
  'access_token',
  'refresh_token',
  'expires_in',
  'token_type',
  'type',
  'provider_token',
];

export function cleanAuthUrl(href) {
  const u = new URL(href);
  for (const k of ['code', 'state']) u.searchParams.delete(k);
  if (![...u.searchParams.keys()].length) u.search = '';
  const raw = u.hash.startsWith('#') ? u.hash.slice(1) : u.hash;
  if (!raw || !FRAGMENT_AUTH_KEYS.some((k) => new URLSearchParams(raw).has(k))) return u.toString();
  const rest = [...new URLSearchParams(raw)].filter(([k]) => !FRAGMENT_AUTH_KEYS.includes(k));
  u.hash = rest.length ? `#${new URLSearchParams(rest).toString()}` : '';
  return u.toString();
}


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

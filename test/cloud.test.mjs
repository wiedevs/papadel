import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSession } from '../src/engine.mjs';
import { toRow, fromRow, splitSessions, createSyncQueue } from '../src/cloud.mjs';

const mk = (over = {}) =>
  createSession({
    name: 'Sesi',
    date: '2026-09-27',
    playerNames: ['Ayu', 'Budi'],
    ...over,
  });

test('toRow hanya mengirim id + doc', () => {
  const s = mk();
  assert.deepEqual(Object.keys(toRow(s)).sort(), ['doc', 'id']);
  assert.equal(toRow(s).id, s.id);
  assert.equal(toRow(s).doc, s);
});

test('toRow menolak sesi tanpa id, fromRow toleran', () => {
  assert.equal(toRow(null), null);
  assert.equal(toRow({ name: 'x' }), null);
  assert.equal(fromRow({ doc: { id: 'a' } }).id, 'a');
  assert.equal(fromRow({ id: 'a' }), null);
  assert.equal(fromRow(null), null);
});

test('splitSessions: satu live, sisanya history', () => {
  const live = mk({ date: '2026-09-27' });
  const done = { ...mk({ date: '2026-09-20' }), status: 'finished', id: 'sess_a' };
  const res = splitSessions([live, done]);
  assert.equal(res.live.id, live.id);
  assert.deepEqual(res.finished.map((s) => s.id), ['sess_a']);
});

test('splitSessions: dua live tidak menghilangkan satu pun', () => {
  const a = { ...mk(), id: 'sess_1' };
  const b = { ...mk(), id: 'sess_2' };
  const res = splitSessions([a, b]);
  assert.equal(res.live.id, 'sess_2', 'yang baru menang');
  assert.equal(res.finished.length, 1);
  assert.equal(res.finished[0].id, 'sess_1');
  assert.equal(res.finished[0].status, 'finished', 'yang lama ditutup, bukan dibuang');
});

test('splitSessions: history urut tanggal turun', () => {
  const res = splitSessions([
    { id: 'a', status: 'finished', date: '2026-09-01' },
    { id: 'b', status: 'finished', date: '2026-09-28' },
    { id: 'c', status: 'finished', date: '2026-09-15' },
  ]);
  assert.deepEqual(res.finished.map((s) => s.id), ['b', 'c', 'a']);
});

test('splitSessions: buang baris rusak', () => {
  const res = splitSessions([null, undefined, 3, {}, { id: 'ok', status: 'live' }]);
  assert.equal(res.live.id, 'ok');
  assert.deepEqual(res.finished, []);
  assert.deepEqual(splitSessions(null).live, null);
});

const flushQueue = async (q) => {
  const res = await q.flush();
  return res;
};

test('queue: satu tulis per id, versi terakhir yang dikirim', async () => {
  const sent = [];
  const q = createSyncQueue({ upsert: (d) => sent.push(d), remove: () => {}, debounceMs: 0 });
  q.put({ id: 'x', v: 1 });
  q.put({ id: 'x', v: 2 });
  q.put({ id: 'y', v: 1 });
  assert.equal(q.size, 2);
  const res = await flushQueue(q);
  assert.equal(res.ok, true);
  assert.deepEqual(sent.map((d) => [d.id, d.v]), [['x', 2], ['y', 1]]);
  assert.equal(q.size, 0);
});

test('queue: hapus menang atas tulis untuk id yang sama', async () => {
  const ups = [];
  const dels = [];
  const q = createSyncQueue({ upsert: (d) => ups.push(d.id), remove: (id) => dels.push(id), debounceMs: 0 });
  q.put({ id: 'x' });
  q.drop('x');
  await flushQueue(q);
  assert.deepEqual(ups, []);
  assert.deepEqual(dels, ['x']);
});

test('queue: gagal tidak menghapus antrean', async () => {
  let calls = 0;
  const q = createSyncQueue({
    upsert: () => {
      calls += 1;
      throw new Error('offline');
    },
    remove: () => {},
    debounceMs: 0,
  });
  q.put({ id: 'x' });
  const res = await flushQueue(q);
  assert.equal(res.ok, false);
  assert.equal(q.size, 1, 'masih mengantre untuk percobaan berikutnya');
  q.put({ id: 'y' });
  assert.equal(q.size, 2);
});

test('queue: flush saat kosong adalah no-op', async () => {
  let calls = 0;
  const q = createSyncQueue({ upsert: () => (calls += 1), remove: () => (calls += 1), debounceMs: 0 });
  const res = await flushQueue(q);
  assert.deepEqual(res, { ok: true, sent: 0 });
  assert.equal(calls, 0);
});

test('queue: clear membuang semua yang menunggu', async () => {
  let calls = 0;
  const q = createSyncQueue({ upsert: () => (calls += 1), remove: () => (calls += 1), debounceMs: 0 });
  q.put({ id: 'x' });
  q.clear();
  await flushQueue(q);
  assert.equal(calls, 0);
});

test('queue: tulis tanpa id diabaikan', async () => {
  let calls = 0;
  const q = createSyncQueue({ upsert: () => (calls += 1), remove: () => (calls += 1), debounceMs: 0 });
  q.put(null);
  q.put({});
  q.drop(undefined);
  assert.equal(q.size, 0);
  await flushQueue(q);
  assert.equal(calls, 0);
});

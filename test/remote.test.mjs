import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRemote } from '../src/remote.mjs';

// Fake transport: records every call, answers from a queue.
function harness({ clock = () => 1_000_000, handlers = {} } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const path = String(url).replace(/^https:\/\/[^/]+/, '');
    calls.push({ path, init, body: init.body ? JSON.parse(init.body) : null });
    const fn = handlers[new URL(url).pathname + (new URL(url).search ? new URL(url).search : '')]
      ?? handlers[new URL(url).pathname];
    if (!fn) return respond(500, { message: 'tidak ada handler untuk ' + path });
    return fn(calls[calls.length - 1]);
  };
  return { calls, remote: createRemote({ url: 'https://x.supabase.co', anonKey: 'sb_publishable_test', fetchImpl, now: clock }) };
}

const respond = (status, obj) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (typeof obj === 'string' ? obj : JSON.stringify(obj)),
});

const TOKEN = { access_token: 'AT1', refresh_token: 'RT1', expires_in: 3600, user: { email: 'a@b.c' } };

test('fetchSessions jalan tanpa login (peran anon)', async () => {
  const { calls, remote } = harness({
    handlers: { '/rest/v1/sessions': () => respond(200, [{ doc: { id: 's1', status: 'live' } }, { doc: null }, null]) },
  });
  const docs = await remote.fetchSessions();
  assert.deepEqual(docs, [{ id: 's1', status: 'live' }]);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer sb_publishable_test');
  assert.equal(remote.signedIn, false);
});

test('fetchSessions: bukan array → kosong', async () => {
  const { remote } = harness({ handlers: { '/rest/v1/sessions': () => respond(200, { message: 'x' }) } });
  assert.deepEqual(await remote.fetchSessions(), []);
});

test('tulis tanpa login ditolak sebelum menyentuh jaringan', async () => {
  let sent = 0;
  const remote = createRemote({
    url: 'https://x.supabase.co',
    anonKey: 'k',
    fetchImpl: () => { sent += 1; throw new Error('tidak boleh dipanggil'); },
  });
  await assert.rejects(() => remote.upsert({ id: 's1' }), /masuk/);
  await assert.rejects(() => remote.remove('s1'), /masuk/);
  assert.equal(sent, 0);
});

test('signIn menyimpan sesi, upsert mengirim {id, doc} + Bearer', async () => {
  const { calls, remote } = harness({
    handlers: {
      '/auth/v1/token': () => respond(200, TOKEN),
      '/rest/v1/sessions': () => respond(201, null),
    },
  });
  const s = await remote.signIn('a@b.c', 'pw');
  assert.equal(s.email, 'a@b.c');
  assert.equal(remote.signedIn, true);
  await remote.upsert({ id: 's9', name: 'X' });
  const w = calls[1];
  assert.equal(w.init.method, 'POST');
  assert.deepEqual(w.body, { id: 's9', doc: { id: 's9', name: 'X' } });
  assert.equal(w.init.headers.Authorization, 'Bearer AT1');
  assert.match(w.init.headers.Prefer, /merge-duplicates/);
});

test('upsert menolak doc tanpa id', async () => {
  const { remote } = harness({ handlers: { '/auth/v1/token': () => respond(200, TOKEN) } });
  await remote.signIn('a@b.c', 'pw');
  await assert.rejects(() => remote.upsert({ name: 'X' }), /tanpa id/);
});

test('token dekat kedaluwarsa → refresh lalu kirim dengan token baru', async () => {
  let t = 1_000_000;
  const { calls, remote } = harness({
    clock: () => t,
    handlers: {
      '/auth/v1/token': (c) =>
        c.body.refresh_token ? respond(200, { ...TOKEN, access_token: 'AT2' }) : respond(200, TOKEN),
      '/rest/v1/sessions': () => respond(201, null),
    },
  });
  await remote.signIn('a@b.c', 'pw');
  // tinggal 30 detik — di bawah ambang 60 detik
  remote.storedSession.expires_at = t + 30_000;
  await remote.upsert({ id: 's1' });
  const refreshCall = calls.find((c) => c.body?.refresh_token === 'RT1');
  assert.ok(refreshCall, 'refresh dipanggil');
  assert.equal(calls.at(-1).init.headers.Authorization, 'Bearer AT2');
});

test('401 dari server → refresh sekali lalu ulangi', async () => {
  let writes = 0;
  const { remote } = harness({
    handlers: {
      '/auth/v1/token': (c) => (c.body.refresh_token ? respond(200, { ...TOKEN, access_token: 'AT2' }) : respond(200, TOKEN)),
      '/rest/v1/sessions': () => {
        writes += 1;
        return writes === 1 ? respond(401, { message: 'expired' }) : respond(201, null);
      },
    },
  });
  await remote.signIn('a@b.c', 'pw');
  remote.storedSession.expires_at = Date.now() + 999_999_999;
  await remote.upsert({ id: 's1' });
  assert.equal(writes, 2);
});

test('refresh gagal → sesi dibersihkan, error asli diteruskan', async () => {
  const { remote } = harness({
    handlers: {
      '/auth/v1/token': (c) => (c.body.refresh_token ? respond(400, { message: 'invalid_grant' }) : respond(200, TOKEN)),
      '/rest/v1/sessions': () => respond(401, { message: 'expired' }),
    },
  });
  await remote.signIn('a@b.c', 'pw');
  remote.storedSession.expires_at = Date.now() + 999_999_999;
  await assert.rejects(() => remote.upsert({ id: 's1' }), /expired/);
  assert.equal(remote.signedIn, false);
});

test('body error teks polos tetap terbaca', async () => {
  const { remote } = harness({ handlers: { '/rest/v1/sessions': () => respond(200, []) } });
  await assert.rejects(
    () => createRemote({
      url: 'https://x.supabase.co',
      anonKey: 'k',
      fetchImpl: async () => ({ ok: false, status: 500, text: async () => 'Bad Gateway' }),
    }).fetchSessions(),
    /Bad Gateway/
  );
  assert.deepEqual(await remote.fetchSessions(), []);
});

test('remove meng-escape id', async () => {
  const { calls, remote } = harness({
    handlers: {
      '/auth/v1/token': () => respond(200, TOKEN),
      '/rest/v1/sessions': () => respond(204, null),
    },
  });
  await remote.signIn('a@b.c', 'pw');
  await remote.remove('sess/../x');
  const path = calls.at(-1).path;
  // Garis miring harus ter-encode supaya tidak bisa naik ke path lain;
  // titik-titik yang tidak berdiri sebagai path segment aman dibiarkan.
  assert.ok(path.includes('id=eq.sess%2F..%2Fx'), path);
  assert.ok(!path.includes('/../'), 'traversal literal tidak boleh muncul di path');
});

test('signOut menghapus sesi lokal lalu logout di server', async () => {
  const { calls, remote } = harness({
    handlers: {
      '/auth/v1/token': () => respond(200, TOKEN),
      '/auth/v1/logout': () => respond(200, {}),
    },
  });
  await remote.signIn('a@b.c', 'pw');
  await remote.signOut();
  assert.equal(remote.signedIn, false);
  assert.equal(calls.at(-1).path, '/auth/v1/logout');
  assert.equal(calls.at(-1).init.headers.Authorization, 'Bearer AT1');
});

test('signOut tanpa sesi = no-op', async () => {
  let n = 0;
  const remote = createRemote({
    url: 'https://x.supabase.co',
    anonKey: 'k',
    fetchImpl: async () => { n += 1; return respond(200, {}); },
  });
  await remote.signOut();
  assert.equal(n, 0);
});

test('restore: refresh token yang masih segar dipakai langsung', async () => {
  let n = 0;
  const { remote } = harness({
    handlers: { '/rest/v1/sessions': () => { n += 1; return respond(201, null); } },
  });
  const ok = await remote.restore({ access_token: 'ATX', refresh_token: 'RTX', expires_at: Date.now() + 3_600_000, email: 'a@b.c' });
  assert.equal(ok.access_token, 'ATX');
  assert.equal(remote.signedIn, true);
  await remote.upsert({ id: 's1' });
  assert.equal(n, 1);
});

test('restore: tanpa refresh token → tidak ada sesi', async () => {
  const { remote } = harness({ handlers: {} });
  assert.equal(await remote.restore(null), null);
  assert.equal(await remote.restore({ access_token: 'a' }), null);
  assert.equal(remote.signedIn, false);
});

test('restore: sesi kedaluwarsa di-refresh', async () => {
  const NOW = 1_000_000;
  const { calls, remote } = harness({
    clock: () => NOW,
    handlers: { '/auth/v1/token': () => respond(200, { ...TOKEN, access_token: 'AT2' }) },
  });
  const ok = await remote.restore({ access_token: 'OLD', refresh_token: 'RT', expires_at: NOW - 1000, email: 'a@b.c' });
  assert.equal(ok.access_token, 'AT2');
  assert.equal(calls[0].body.refresh_token, 'RT');
});

test('restore: refresh gagal → tidak ada sesi tersisa', async () => {
  const NOW = 1_000_000;
  const { remote } = harness({
    clock: () => NOW,
    handlers: { '/auth/v1/token': () => respond(400, { message: 'invalid_grant' }) },
  });
  assert.equal(await remote.restore({ access_token: 'OLD', refresh_token: 'RT', expires_at: NOW - 1000 }), null);
  assert.equal(remote.signedIn, false);
});

test('signIn: kredensial salah → error, tidak ada sesi', async () => {
  const { remote } = harness({
    handlers: { '/auth/v1/token': () => respond(400, { error_code: 'invalid_credentials', message: 'Invalid login credentials' }) },
  });
  await assert.rejects(() => remote.signIn('a@b.c', 'salah'), /Invalid login/);
  assert.equal(remote.signedIn, false);
});

test('signIn: respons tanpa access_token tidak jadi sesi', async () => {
  const { remote } = harness({ handlers: { '/auth/v1/token': () => respond(200, { foo: 1 }) } });
  assert.equal(await remote.signIn('a@b.c', 'pw'), null);
  assert.equal(remote.signedIn, false);
});

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

// --- lupa sandi + OAuth ----------------------------------------------------

test('recover: email dikirim apa adanya, tanpa klaim berhasil', async () => {
  const { calls, remote } = harness({
    handlers: { '/auth/v1/recover': () => respond(200, { sent_at: '2026-09-30T00:00:00Z' }) },
  });
  await remote.recover('  Ayu@Example.com  ');
  assert.equal(calls[0].path, '/auth/v1/recover');
  assert.deepEqual(calls[0].body, { email: 'Ayu@Example.com' });
  assert.equal(remote.signedIn, false, 'minta tautan reset tidak boleh jadi sesi');
});

test('recover: email kosong ditolak server, bukan oleh klien', async () => {
  const { calls, remote } = harness({
    handlers: { '/auth/v1/recover': () => respond(422, { message: 'Unable to validate email address: invalid format' }) },
  });
  await assert.rejects(() => remote.recover('bukan-email'), /validate email/);
  assert.equal(calls.length, 1);
});

// --- ganti kata sandi ------------------------------------------------------

test('updatePassword: memakai token sesi, bukan anon key', async () => {
  const { calls, remote } = harness({
    handlers: {
      '/auth/v1/token': () => respond(200, TOKEN),
      '/auth/v1/user': () => respond(200, { id: 'u1' }),
    },
  });
  await remote.signIn('a@b.c', 'pw');
  await remote.updatePassword('rahasia123');
  const w = calls[1];
  assert.equal(w.init.method, 'PUT');
  assert.equal(w.init.headers.Authorization, 'Bearer AT1');
  assert.deepEqual(w.body, { password: 'rahasia123' });
});

test('updatePassword: sandi kosong ditolak tanpa menyentuh jaringan', async () => {
  let sent = 0;
  const remote = createRemote({
    url: 'https://x.supabase.co',
    anonKey: 'k',
    fetchImpl: () => { sent += 1; throw new Error('tidak boleh dipanggil'); },
  });
  await assert.rejects(() => remote.updatePassword(''), /tidak boleh kosong/);
  await assert.rejects(() => remote.updatePassword(null), /tidak boleh kosong/);
  assert.equal(sent, 0);
});

test('updatePassword: 422 dari GoTrue diteruskan dengan pesannya', async () => {
  const { remote } = harness({
    handlers: {
      '/auth/v1/token': () => respond(200, TOKEN),
      '/auth/v1/user': () => respond(422, { message: 'New password should be different from the old password.' }),
    },
  });
  await remote.signIn('a@b.c', 'pw');
  await assert.rejects(() => remote.updatePassword('rahasia123'), /different from the old/);
});

test('verifyPassword: benar → true, dan sesi yang ada tidak terganti', async () => {
  const { calls, remote } = harness({
    handlers: { '/auth/v1/token': () => respond(200, { ...TOKEN, access_token: 'AT2' }) },
  });
  await remote.signIn('a@b.c', 'pw');
  const before = remote.storedSession;
  assert.equal(await remote.verifyPassword('pw'), true);
  // The re-auth token must not be adopted: it would silently extend or replace
  // the session the rest of the app is holding.
  assert.equal(remote.storedSession, before);
  assert.deepEqual(calls[1].body, { email: 'a@b.c', password: 'pw' });
});

test('verifyPassword: salah → false, bukan error', async () => {
  const { remote } = harness({
    handlers: {
      // First call signs in, second one is the re-check that must fail.
      '/auth/v1/token': (call) =>
        call.init.body && JSON.parse(call.init.body).password === 'salah'
          ? respond(400, { message: 'Invalid login credentials' })
          : respond(200, TOKEN),
    },
  });
  await remote.signIn('a@b.c', 'pw');
  assert.equal(await remote.verifyPassword('salah'), false);
  assert.equal(remote.signedIn, true, 'percobaan gagal tidak boleh mengeluarkan sesi');
});

test('verifyPassword: tanpa sesi → false tanpa jaringan', async () => {
  let sent = 0;
  const remote = createRemote({
    url: 'https://x.supabase.co',
    anonKey: 'k',
    fetchImpl: () => { sent += 1; throw new Error('tidak boleh dipanggil'); },
  });
  assert.equal(await remote.verifyPassword('pw'), false);
  assert.equal(sent, 0);
});

test('exchangeAuthCode: menukar code + verifier jadi sesi', async () => {
  const { calls, remote } = harness({
    handlers: {
      '/auth/v1/token?grant_type=pkce': () => respond(200, { ...TOKEN, email: null, user: { email: 'ayu@gmail.com' } }),
    },
  });
  const s = await remote.exchangeAuthCode('CODE123', 'verifier-dari-tab-ini');
  assert.equal(calls[0].path, '/auth/v1/token?grant_type=pkce');
  assert.deepEqual(calls[0].body, { auth_code: 'CODE123', code_verifier: 'verifier-dari-tab-ini' });
  assert.equal(s.email, 'ayu@gmail.com');
  assert.equal(remote.signedIn, true);
  assert.equal(remote.email, 'ayu@gmail.com');
});

test('exchangeAuthCode: bagian yang hilang tidak dikirim', async () => {
  const { calls, remote } = harness({ handlers: { '/auth/v1/token': () => respond(200, TOKEN) } });
  await assert.rejects(() => remote.exchangeAuthCode('CODE', null), /tidak lengkap/);
  await assert.rejects(() => remote.exchangeAuthCode(null, 'V'), /tidak lengkap/);
  assert.equal(calls.length, 0);
});

test('adoptTokenPayload: link recovery (implicit) langsung jadi sesi', () => {
  const { remote } = harness({ handlers: {} });
  const s = remote.adoptTokenPayload({
    access_token: 'AT9',
    refresh_token: 'RT9',
    expires_in: 3600,
    token_type: 'bearer',
  });
  assert.equal(s.access_token, 'AT9');
  assert.equal(remote.signedIn, true);
  // user tidak ikut di fragment: email diisi dari JWT, bukan dari paket ini.
  assert.equal(remote.email, null);
});

test('isAdmin: hanya true kalau Postgres menjawab true', async () => {
  const { calls, remote } = harness({
    handlers: {
      '/auth/v1/token': () => respond(200, TOKEN),
      '/rest/v1/rpc/is_admin': () => respond(200, true),
    },
  });
  await remote.signIn('a@b.c', 'pw');
  assert.equal(await remote.isAdmin(), true);
  assert.equal(calls[1].init.headers.Authorization, 'Bearer AT1');
  assert.deepEqual(calls[1].body, {});
});

test('isAdmin: akun yang login tapi tidak ada di daftar → false', async () => {
  const { remote } = harness({
    handlers: {
      '/auth/v1/token': () => respond(200, TOKEN),
      '/rest/v1/rpc/is_admin': () => respond(200, false),
    },
  });
  await remote.signIn('a@b.c', 'pw');
  assert.equal(await remote.isAdmin(), false);
});

test('isAdmin: tanpa sesi tidak bertanya, dan kegagalan tidak dianggap admin', async () => {
  const { calls, remote } = harness({
    handlers: {
      '/auth/v1/token': () => respond(200, TOKEN),
      '/rest/v1/rpc/is_admin': () => respond(401, { message: 'row-level security' }),
    },
  });
  assert.equal(await remote.isAdmin(), false);
  assert.equal(calls.length, 0, ' jangan pernah memanggil RPC sebelum ada token');
  await remote.signIn('a@b.c', 'pw');
  assert.equal(await remote.isAdmin(), false);
});

test('isAdmin: jawaban yang bukan boolean bukan izin', async () => {
  const { remote } = harness({
    handlers: {
      '/auth/v1/token': () => respond(200, TOKEN),
      '/rest/v1/rpc/is_admin': () => respond(200, { error: 'function not found' }),
    },
  });
  await remote.signIn('a@b.c', 'pw');
  assert.equal(await remote.isAdmin(), false);
});


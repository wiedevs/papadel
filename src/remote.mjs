// PaPadel remote client — plain fetch against the same REST + Auth endpoints
// supabase-js wraps. Staying on fetch keeps the prototype dependency-free and
// lets every call here be tested with an injected fake.
//
// Authority comes from the access token, which Postgres reads as the
// `authenticated` role. Without one the same endpoints still answer SELECT
// (policy "sessions readable by everyone") and refuse every write.

import { SUPABASE_URL, SUPABASE_ANON_KEY, LOGIN_ALIASES } from './cloud-config.mjs';

const TIMEOUT_MS = 15_000;
// Refresh this early so a save never races the expiry of the token it needs.
const REFRESH_BEFORE_MS = 60_000;

export function createRemote({
  url = SUPABASE_URL,
  anonKey = SUPABASE_ANON_KEY,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
} = {}) {
  let session = null;

  const request = async (path, { method = 'GET', body, headers = {}, token = null } = {}) => {
    const res = await fetchImpl(`${url}${path}`, {
      method,
      headers: { apikey: anonKey, Authorization: `Bearer ${token || anonKey}`, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    if (!res.ok) {
      let message = text;
      try {
        message = JSON.parse(text)?.message || text;
      } catch {
        /* some auth errors come back as plain text */
      }
      const err = new Error(message || `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  };

  const adopt = (raw) => {
    if (!raw?.access_token) return null;
    session = {
      access_token: raw.access_token,
      refresh_token: raw.refresh_token ?? null,
      expires_at: now() + (raw.expires_in ?? 3600) * 1000,
      email: raw.user?.email ?? null,
    };
    return session;
  };

  async function refresh() {
    if (!session?.refresh_token) return null;
    try {
      return adopt(
        await request('/auth/v1/token?grant_type=refresh_token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: { refresh_token: session.refresh_token },
        })
      );
    } catch {
      session = null;
      return null;
    }
  }

  // PostgREST answers 401 for an expired token in two different ways: as the
  // `authenticated` role it is an RLS denial, as an invalid JWT it is rejected
  // before the request is parsed. Both mean "get a new token, then try again",
  // and only a retry that fails a second time is reported.
  const authorized = async (path, init = {}) => {
    if (!session) {
      const err = new Error('Perlu masuk sebagai admin.');
      err.status = 401;
      throw err;
    }
    if (session.expires_at - now() < REFRESH_BEFORE_MS) await refresh();
    if (!session) {
      const err = new Error('Sesi login kedaluwarsa.');
      err.status = 401;
      throw err;
    }
    try {
      return await request(path, { ...init, token: session.access_token });
    } catch (err) {
      if (err.status !== 401) throw err;
      const next = await refresh();
      if (!next) throw err;
      return request(path, { ...init, token: next.access_token });
    }
  };

  // Lets the admin type `admin` where a login is expected. The alias only picks
  // which account to authenticate as — the secret is still checked by GoTrue —
  // so this is a shortcut, not a second door.
  function resolveLogin(name) {
    const key = String(name ?? '').trim().toLowerCase();
    return LOGIN_ALIASES[key] ?? String(name ?? '').trim();
  }

  async function signIn(email, password) {
    const data = await request('/auth/v1/token?grant_type=password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { email: resolveLogin(email), password: String(password ?? '') },
    });
    return adopt(data);
  }

  // Re-checks a password without adopting the session it returns. Changing a
  // password through GoTrue needs no current password, so without this a
  // borrowed session (a shared laptop left signed in) could lock the real owner
  // out. The token is fetched only to learn whether it was accepted, then
  // dropped on the floor.
  async function verifyPassword(password) {
    const email = resolveLogin(session?.email);
    if (!email || !session) return false;
    try {
      await request('/auth/v1/token?grant_type=password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { email, password: String(password ?? '') },
      });
      return true;
    } catch {
      return false;
    }
  }

  // Changing a password needs the signed-in session, not the anon key: GoTrue
  // identifies whose password to replace from the bearer token. Wrong current
  // password comes back 422 with `errors.password`; the caller surfaces it.
  async function updatePassword(newPassword) {
    const body = { password: String(newPassword ?? '') };
    // A blank secret is rejected by the server, but sending it is pointless.
    if (!body.password) throw new Error('Kata sandi baru tidak boleh kosong.');
    return authorized('/auth/v1/user', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
  }

  // GoTrue answers 200 whether or not the address has an account, so the UI
  // must not claim a mail was sent to a specific one.
  async function recover(email) {
    return request('/auth/v1/recover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { email: String(email ?? '').trim() },
    });
  }

  // PKCE callback: the one-time code plus the verifier this tab generated.
  async function exchangeAuthCode(code, codeVerifier) {
    if (!code || !codeVerifier) throw new Error('Kode login tidak lengkap.');
    return adopt(
      await request('/auth/v1/token?grant_type=pkce', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { auth_code: code, code_verifier: codeVerifier },
      })
    );
  }

  // Implicit callback (recovery links and providers without PKCE).
  function adoptTokenPayload(payload) {
    return adopt(payload);
  }

  // Not every signed-in account may write: see 0002_admin_allowlist.sql. The
  // server is still the one that decides; this only tells the UI which buttons
  // to hide.
  async function isAdmin() {
    if (!session) return false;
    try {
      const out = await authorized('/rest/v1/rpc/is_admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: {},
      });
      return out === true;
    } catch {
      return false;
    }
  }

  // Destructive actions and user management: see 0003_superadmin.sql. Asked
  // separately from is_admin so the UI can offer a superadmin both answers and
  // the client never assumes the first implies the second.
  async function isSuperAdmin() {
    if (!session) return false;
    try {
      const out = await authorized('/rest/v1/rpc/is_superadmin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: {},
      });
      return out === true;
    } catch {
      return false;
    }
  }

  // Both lists plus the account directory, so the admin menu shows everyone
  // who has signed in — including accounts with no role yet, which is the
  // whole point of the directory.
  async function fetchRoles() {
    const read = async (table) => {
      try {
        const rows = await authorized(`/rest/v1/${table}?select=email`, { method: 'GET' });
        return new Set((Array.isArray(rows) ? rows : []).map((r) => String(r?.email ?? '').toLowerCase()).filter(Boolean));
      } catch {
        return new Set();
      }
    };
    let accounts = [];
    try {
      const rows = await authorized(
        '/rest/v1/accounts?select=email,full_name,avatar_url,provider,first_login_at,last_login_at&order=last_login_at.desc',
        { method: 'GET' }
      );
      accounts = (Array.isArray(rows) ? rows : []).filter((r) => r?.email);
    } catch {
      accounts = [];
    }
    const [admins, superadmins] = await Promise.all([read('admins'), read('superadmins')]);
    return { admins, superadmins, accounts };
  }

  // Upsert so re-granting an existing address is a no-op rather than a conflict.
  // A superadmin is always an admin too, so granting the higher role writes
  // both tables — otherwise the UI would show someone as superadmin while
  // Postgres refused their session writes.
  async function grantRole(email, role) {
    const address = String(email ?? '').trim().toLowerCase();
    if (!address) throw new Error('Email kosong.');
    if (!address.includes('@')) throw new Error('Email tidak valid.');
    if (role !== 'admin' && role !== 'superadmin') throw new Error('Peran tidak dikenal.');
    const put = (table) =>
      authorized(`/rest/v1/${table}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: { email: address },
      });
    await put('admins');
    if (role === 'superadmin') await put('superadmins');
  }

  // Removing admin is separate from removing superadmin: the second is what
  // actually strips destructive power, and the trigger refuses to drop the last
  // one — that rejection is surfaced, not swallowed.
  async function revokeRole(email, role) {
    const address = String(email ?? '').trim().toLowerCase();
    if (!address) throw new Error('Email kosong.');
    const del = (table) =>
      authorized(`/rest/v1/${table}?email=eq.${encodeURIComponent(address)}`, { method: 'DELETE' });
    if (role === 'superadmin') await del('superadmins');
    await del('admins');
  }

  async function signOut() {
    const token = session?.access_token;
    session = null;
    if (!token) return;
    // Invalidating the refresh token server-side; a failure here must not leave
    // the browser thinking it is still signed in.
    await request('/auth/v1/logout', { method: 'POST', token }).catch(() => null);
  }

  return {
    get signedIn() {
      return !!session && session.expires_at > now();
    },
    get email() {
      return this.signedIn ? session.email : null;
    },
    get storedSession() {
      return session;
    },
    signIn,
    signOut,
    refresh,
    recover,
    verifyPassword,
    updatePassword,
    exchangeAuthCode,
    adoptTokenPayload,
    isAdmin,
    isSuperAdmin,
    fetchRoles,
    grantRole,
    revokeRole,

    // A stored refresh token outlives the one-hour access token, so reopening
    // the page restores admin without typing the password again.
    async restore(stored) {
      if (!stored?.refresh_token) return null;
      session = { ...stored };
      if (session.expires_at - now() > REFRESH_BEFORE_MS) return session;
      const next = await refresh();
      if (!next) session = null;
      return next;
    },

    // Whole board in one read. `doc` is the engine session; the generated
    // columns exist for the server to index and order, not for the client.
    async fetchSessions() {
      const rows = await request('/rest/v1/sessions?select=doc&order=updated_at.desc');
      return Array.isArray(rows) ? rows.map((r) => r?.doc).filter(Boolean) : [];
    },

    // The engine owns the id, so an upsert keyed on it is the whole write.
    async upsert(doc) {
      if (!doc?.id) throw new Error('Sesi tanpa id tidak bisa disimpan.');
      return authorized('/rest/v1/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: { id: doc.id, doc },
      });
    },

    async remove(id) {
      if (!id) throw new Error('Id sesi hilang.');
      return authorized(`/rest/v1/sessions?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });
    },
  };
}

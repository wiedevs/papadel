// PaPadel cloud endpoint config.
//
// Both values are PUBLIC BY DESIGN and safe to serve: they identify the
// project and carry only the anon role, which RLS limits to SELECT.
// Write access comes from a signed-in Supabase Auth session, never from
// this file. The service_role / sb_secret_ key must never appear here, in
// the client, or in a commit — test/secret-leak.test.mjs enforces that.
export const SUPABASE_URL = "https://abjtyduurdbytdwbklsb.supabase.co";
export const SUPABASE_ANON_KEY = "sb_publishable_Btc5NS3SeFmQqCbEGiPFLg_KSZkpQ8W";

// Flip to true only after the Google provider is enabled in Supabase Auth and
// its OAuth client secret lives server-side. The client never holds that
// secret: /auth/v1/authorize takes the provider name and Supabase adds it.
export const GOOGLE_LOGIN = true;

// Usernames that stand in for a real login address, so the admin can type
// `admin` instead of an email. Only the mapping lives here — the password is
// never in this file, let alone in the repo. GoTrue still checks it against
// the account this alias points at, so this grants nothing on its own.
export const LOGIN_ALIASES = {
  admin: 'wiedevs@gmail.com',
};

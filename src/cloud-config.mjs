// PaPadel cloud endpoint config.
//
// Both values are PUBLIC BY DESIGN and safe to serve: they identify the
// project and carry only the anon role, which RLS limits to SELECT.
// Write access comes from a signed-in Supabase Auth session, never from
// this file. The service_role / sb_secret_ key must never appear here, in
// the client, or in a commit — test/secret-leak.test.mjs enforces that.
export const SUPABASE_URL = "https://abjtyduurdbytdwbklsb.supabase.co";
export const SUPABASE_ANON_KEY = "sb_publishable_Btc5NS3SeFmQqCbEGiPFLg_KSZkpQ8W";

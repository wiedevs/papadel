-- PaPadel 0002: siapa yang boleh menulis, ditegakkan di Postgres
--
-- 0001 memberi hak tulis kepada SEMUA pemegang JWT `authenticated`. Begitu login
-- Google diaktifkan, itu berarti semua pemilik akun Google bisa mengubah papan.
-- Jadi hak tulis dipindah ke daftar email:
--
--   admin  -> authenticated DAN email-nya ada di public.admins
--   viewer -> selain itu (termasuk yang sudah login tapi tidak terdaftar)
--
-- Isinya dibaca lewat fungsi security-definer, jadi daftar email tidak bisa
-- ditelusuri orang luar dan policy tidak bersentuhan dengan RLS-nya admins.
--
-- PENTING: 0001 tidak boleh dijalankan ulang setelah migrasi ini. 0001 membuat
-- policy tulis lama ("... by signed-in users") yang longgar; 0002 membuangnya.
-- Kalau 0001 jalan lagi, policy longgar itu ikut kembali dan daftar email
-- dilewati. Urutan aman: 0001 sekali, lalu 0002 sekali (bisa diulang).

create table if not exists public.admins (
  email      text primary key check (email = lower(email)),
  created_at timestamptz not null default now()
);

-- Bootstrap: akun yang sudah ada saat migrasi jalan dianggap boleh menulis.
-- Sengaja tidak menuliskan email apa pun ke file ini — repo ini publik.
insert into public.admins (email)
select lower(u.email)
from auth.users u
where coalesce(u.email, '') <> ''
on conflict (email) do nothing;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.admins a
    where a.email = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

-- Hanya pemilik email itu sendiri yang bisa melihat barisnya.
alter table public.admins enable row level security;
revoke all on table public.admins from anon, authenticated;
grant select on table public.admins to authenticated;

drop policy if exists "admins readable by their own email" on public.admins;
create policy "admins readable by their own email"
  on public.admins for select
  to authenticated
  using (email = lower(coalesce(auth.jwt() ->> 'email', '')));

-- Tulis: boleh kalau email ada di daftar.
-- Nama lama ikut dibuang supaya migrasi ini bisa dijalankan ulang
-- (create policy tidak punya OR REPLACE).
drop policy if exists "sessions writable by signed-in users" on public.sessions;
drop policy if exists "sessions writable by allowlisted users" on public.sessions;
create policy "sessions writable by allowlisted users"
  on public.sessions for insert
  to authenticated
  with check (public.is_admin());

-- Ubah: syarat dibaca dua kali — baris mana yang tersentuh, dan boleh tidak.
drop policy if exists "sessions updatable by signed-in users" on public.sessions;
drop policy if exists "sessions updatable by allowlisted users" on public.sessions;
create policy "sessions updatable by allowlisted users"
  on public.sessions for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists "sessions deletable by signed-in users" on public.sessions;
drop policy if exists "sessions deletable by allowlisted users" on public.sessions;
create policy "sessions deletable by allowlisted users"
  on public.sessions for delete
  to authenticated
  using (public.is_admin());

-- UI butuh jawaban yang sama tanpa menebak: apakah saya boleh menulis?
grant execute on function public.is_admin() to anon, authenticated;
comment on function public.is_admin() is
  'True when the signed-in JWT email is listed in public.admins. Exposed as an RPC so the UI can show read-only mode honestly.';

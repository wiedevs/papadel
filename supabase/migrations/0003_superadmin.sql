-- PaPadel 0003: superadmin, dan pemisahan wewenang destruktif
--
-- 0002 memberi hak tulis penuh (create/update/delete) ke setiap email di
-- public.admins. Permintaan yang perlu dipenuhi: memisahkan "input & update"
-- dari "hapus". Jadi hak TULIS tetap milik admin, tapi hak HAPUS ditarik ke
-- tabel baru public.superadmins.
--
--   viewer    -> hanya baca
--   admin     -> buat sesi, main, submit skor, ubah data
--   superadmin-> semua di atas PLUS hapus round/sesi/player, hapus semua
--                data, dan kelola daftar user
--
-- Tabel dipisah (bukan satu tabel role) supaya daftar pengelola tetap punya
-- aturan RLS sendiri: satu orang yang mengurus role tidak otomatis boleh
-- menghapus papan. Kalau satu tabel, mengelola role dan mengelola data akan
-- bercampur di satu policy yang sulit dibaca.
--
-- Urutan aman: 0001 sekali, 0002 sekali, 0003 sekali (0003 bisa diulang).

create table if not exists public.superadmins (
  email      text primary key check (email = lower(email)),
  created_at timestamptz not null default now()
);

-- Bootstrap: whoever was already an admin becomes the first superadmin, so
-- nobody can be locked out of destructive actions by running this migration.
insert into public.superadmins (email)
select email from public.admins
on conflict (email) do nothing;

-- Security-definer, same shape as is_admin(): the table must not be readable
-- through the caller's own RLS, or the allowlist leaks to anyone who asks.
create or replace function public.is_superadmin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.superadmins s
    where s.email = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

alter table public.superadmins enable row level security;
revoke all on table public.superadmins from anon, authenticated;
grant select on table public.superadmins to authenticated;

drop policy if exists "superadmins readable by their own email" on public.superadmins;
create policy "superadmins readable by their own email"
  on public.superadmins for select
  to authenticated
  using (email = lower(coalesce(auth.jwt() ->> 'email', '')));

-- Only a superadmin manages the lists. Self-demotion is blocked by the trigger
-- below, not here — otherwise the last superadmin could remove themselves.
drop policy if exists "superadmins writable by superadmins" on public.superadmins;
create policy "superadmins writable by superadmins"
  on public.superadmins for all
  to authenticated
  using (public.is_superadmin())
  with check (public.is_superadmin());

-- --- Memisahkan wewenang pada public.sessions ------------------------------
--
-- INSERT/UPDATE tetap milik admin (0002), jadi admin masih bisa membuat sesi
-- dan mengubah skor. DELETE naik ke superadmin: menghapus papan bukan bagian
-- dari "input & update".
drop policy if exists "sessions deletable by allowlisted users" on public.sessions;
drop policy if exists "sessions deletable by superadmins" on public.sessions;
create policy "sessions deletable by superadmins"
  on public.sessions for delete
  to authenticated
  using (public.is_superadmin());

-- Guard against the last superadmin being removed, by any path: the policy
-- above allows a superadmin to delete their own row, which would leave the
-- table empty and no one able to restore it.
create or replace function public.protect_last_superadmin()
returns trigger
language plpgsql
as $$
begin
  if (tg_op = 'DELETE' or (tg_op = 'UPDATE' and new.email <> old.email)) then
    if (select count(*) from public.superadmins) <= 1 then
      raise exception 'Tidak bisa menghapus superadmin terakhir';
    end if;
  end if;
  return coalesce(new, old);
end;
$$;

drop trigger if exists superadmins_guard_last on public.superadmins;
create trigger superadmins_guard_last
  before delete or update of email on public.superadmins
  for each row
  execute function public.protect_last_superadmin();

grant execute on function public.is_superadmin() to anon, authenticated;
comment on function public.is_superadmin() is
  'True when the signed-in JWT email is listed in public.superadmins. Destructive actions and user management are gated on this.';
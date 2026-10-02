-- PaPadel 0004: direktori akun, dengan jejak login
--
-- Dua allowlist (0002 admins, 0003 superadmins) menjawab "boleh atau tidak",
-- tapi tidak menjawab "siapa yang sudah pernah masuk". Karena itu tabel ini:
-- setiap akun yang berhasil login ada di sini, lengkap dengan kapan pertama dan
-- kapan terakhir. Superadmin punya semua data untuk memutuskan, dan RLS tetap
-- menutup tabel ini dari ditulis langsung.
--
-- Penulisannya lewat trigger di auth.users, bukan lewat klien. Alasannya: sesi
-- bisa datang dari Google, dari email+sandi, atau dari tautan pemulihan — dan
-- hanya di server semua itu terlihat sebagai satu peristiwa. Kalau klien yang
-- mencatat, satu jalur yang lupa memanggil akan hilang tanpa jejak.
--
-- first_login_at tidak pernah berubah; last_login_at mengikuti last_sign_in_at
-- milik auth.users, jadi nilainya sama dengan yang tercatat GoTrue sendiri.

create table if not exists public.accounts (
  email          text primary key check (email = lower(email)),
  full_name      text,
  avatar_url     text,
  provider       text,
  first_login_at timestamptz not null default now(),
  last_login_at  timestamptz not null default now(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists accounts_last_login_idx
  on public.accounts (last_login_at desc);

-- Backfill: anyone who already has a row in auth.users has, by definition,
-- logged in at least once. Without this the table starts empty and the first
-- person to sign in looks like the only person who ever has.
insert into public.accounts (email, full_name, avatar_url, provider, first_login_at, last_login_at)
select
  lower(u.email),
  nullif(coalesce(u.raw_user_meta_data ->> 'full_name', u.raw_user_meta_data ->> 'name'), ''),
  nullif(u.raw_user_meta_data ->> 'avatar_url', ''),
  coalesce(
    (select p.provider from auth.identities p where p.user_id = u.id order by p.created_at limit 1),
    'email'
  ),
  coalesce(u.created_at, now()),
  coalesce(u.last_sign_in_at, u.created_at, now())
from auth.users u
where coalesce(u.email, '') <> ''
on conflict (email) do nothing;

-- One row per sign-in. INSERT fires on signup, UPDATE fires on every later
-- login because GoTrue bumps last_sign_in_at. The conflict clause keeps
-- first_login_at and fills in anything new from the identity, so a user who
-- later turns on a Google photo gets a name and an avatar they did not have.
create or replace function public.record_account_login()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(new.email, '') = '' then
    return new;
  end if;

  insert into public.accounts (email, full_name, avatar_url, provider, first_login_at, last_login_at)
  values (
    lower(new.email),
    nullif(coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'), ''),
    nullif(new.raw_user_meta_data ->> 'avatar_url', ''),
    coalesce(
      (select p.provider from auth.identities p where p.user_id = new.id order by p.created_at limit 1),
      'email'
    ),
    coalesce(new.last_sign_in_at, now()),
    coalesce(new.last_sign_in_at, now())
  )
  on conflict (email) do update
    set last_login_at = excluded.last_login_at,
        updated_at    = now(),
        full_name     = coalesce(excluded.full_name, public.accounts.full_name),
        avatar_url    = coalesce(excluded.avatar_url, public.accounts.avatar_url);

  return new;
end;
$$;

drop trigger if exists accounts_on_auth_user_insert on auth.users;
create trigger accounts_on_auth_user_insert
  after insert on auth.users
  for each row
  execute function public.record_account_login();

drop trigger if exists accounts_on_auth_user_signin on auth.users;
create trigger accounts_on_auth_user_signin
  after update of last_sign_in_at on auth.users
  for each row
  when (old.last_sign_in_at is distinct from new.last_sign_in_at)
  execute function public.record_account_login();

-- Directori, bukan tempat data diubah klien: writes only ever come from the
-- trigger, so no role gets INSERT/UPDATE/DELETE here. Selecting is how the
-- admin menu gets its rows, and staff is the least role that needs to see who
-- exists — a viewer has no use for it and no business knowing either.
alter table public.accounts enable row level security;
revoke all on table public.accounts from anon, authenticated;
grant select on table public.accounts to authenticated;

drop policy if exists "accounts readable by staff" on public.accounts;
create policy "accounts readable by staff"
  on public.accounts for select
  to authenticated
  using (public.is_admin() or public.is_superadmin());

comment on table public.accounts is
  'Every account that has signed in, with first and last login. Written only by the trigger on auth.users.';
comment on column public.accounts.first_login_at is
  'Set once, on first sight of the address. Never updated by a later sign-in.';
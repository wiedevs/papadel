-- PaPadel 0001: shared session store (Supabase / Postgres)
--
-- Model penyimpanan: satu baris per sesi, objek sesi milik src/engine.mjs utuh
-- di kolom `doc` (jsonb). Kolom lain GENERATED dari doc, jadi tidak ada dua
-- sumber kebenaran dan klien cukup menulis doc saja.
--
-- Pemetaan peran dari src/authz.mjs:
--   viewer  -> peran DB `anon`        : hanya SELECT   (data.read)
--   admin   -> peran DB `authenticated`: SELECT+INSERT+UPDATE+DELETE
-- Menandatangani lewat Supabase Auth = satu-satunya jalan mendapat hak tulis.
-- Passcode demo 2468 tidak lagi jadi pagar; ia cuma affordance prototipe.

-- Kolom GENERATED wajib immutable, tapi cast text::date tidak immutable
-- (hasilnya ikut DateStyle). Jadi tanggal ISO diurai manual lewat make_date,
-- yang immutable. Bentuknya sudah dipastikan oleh constraint sessions_date_iso.
create or replace function public.iso_date(text)
returns date
language plpgsql
immutable
strict
as $$
begin
  if $1 !~ '^\d{4}-\d{2}-\d{2}$' then
    return null;
  end if;
  return make_date(
    substring($1 from 1 for 4)::int,
    substring($1 from 6 for 2)::int,
    substring($1 from 9 for 2)::int
  );
end;
$$;

create table if not exists public.sessions (
  id           text primary key,              -- id buatan engine: sess_<base36>
  doc          jsonb not null,
  name         text      generated always as (doc ->> 'name') stored,
  session_date date      generated always as (public.iso_date(doc ->> 'date')) stored,
  status       text      generated always as (doc ->> 'status') stored,
  duration_min integer   generated always as ((doc ->> 'durationMinutes')::int) stored,
  game_min     integer   generated always as ((doc ->> 'gameMinutes')::int) stored,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint sessions_status_known  check (doc ->> 'status' in ('live', 'finished')),
  -- jsonb_array_length melempar error (bukan gagal check) kalau players bukan array,
  -- dan urutan evaluasi antar-constraint tidak dijamin. CASE menjaga agar
  -- doc yang cacat selalu ditolak sebagai pelanggaran check, bukan error mentah.
  constraint sessions_has_players    check (
    case
      when jsonb_typeof(doc -> 'players') = 'array'
        then jsonb_array_length(doc -> 'players') >= 1
      else false
    end
  ),
  constraint sessions_id_matches_doc check (id = doc ->> 'id'),
  constraint sessions_date_iso       check (doc ->> 'date' ~ '^\d{4}-\d{2}-\d{2}$')
);

create index if not exists sessions_recent_idx
  on public.sessions (session_date desc, status);

-- updated_at tidak boleh bergantung pada klien.
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists sessions_touch_updated_at on public.sessions;
create trigger sessions_touch_updated_at
  before update on public.sessions
  for each row
  execute function public.touch_updated_at();

alter table public.sessions enable row level security;

-- RLS hanya berlaku kalau peran memang boleh menyentuh tabelnya. Di Supabase ini
-- biasanya sudah ditanggung default privileges, tapi ditulis eksplisit supaya
-- migration ini berdiri sendiri dan tidak bergantung pada pengaturan proyek.
-- Catatan: anon sengaja TIDAK diberi insert/update/delete, jadi penolakan terjadi
-- di dua lapis — hak tabel dan policy RLS.
grant usage on schema public to anon, authenticated;
grant select on table public.sessions to anon, authenticated;
grant insert, update, delete on table public.sessions to authenticated;

-- Papan terbuka: siapa pun (tanpa login) boleh melihat.
drop policy if exists "sessions readable by everyone" on public.sessions;
create policy "sessions readable by everyone"
  on public.sessions for select
  to anon, authenticated
  using (true);

-- Tulis khusus untuk pengguna yang sudah login.
drop policy if exists "sessions writable by signed-in users" on public.sessions;
create policy "sessions writable by signed-in users"
  on public.sessions for insert
  to authenticated
  with check (true);

drop policy if exists "sessions updatable by signed-in users" on public.sessions;
create policy "sessions updatable by signed-in users"
  on public.sessions for update
  to authenticated
  using (true)
  with check (true);

drop policy if exists "sessions deletable by signed-in users" on public.sessions;
create policy "sessions deletable by signed-in users"
  on public.sessions for delete
  to authenticated
  using (true);

-- Opsional: subscription perubahan sesi (skor real-time di HP).
-- Lewati baris ini kalau publication supabase_realtime belum ada.
do $$
begin
  alter publication supabase_realtime add table public.sessions;
exception
  when undefined_object or duplicate_object then
    null;
end;
$$;

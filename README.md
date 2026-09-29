# PaPadel — prototipe rotasi & skor Americano

Prototipe browser untuk sesi padel mingguan: satu lapangan, 4 pemain per permainan, rotasi merata, dan skor format Americano. Tujuannya **memvalidasi logika domain** (pencocokan, keadilan jumlah permainan, pembobotan pasangan/lawan) sebelum dibangun versi produksi. Bukan MVP, bukan produk jadi.

Live: <https://wiedevs.github.io/papadel/>

## Menjalankan lokal

Perlu server HTTP — `file://` tidak bisa memuat ES module.

```bash
python3 -m http.server 8080   # lalu buka http://localhost:8080
```

Tidak ada dependensi, tidak ada build step, tidak ada `package.json`.

## Test

```bash
node --test "test/*.test.mjs"
```

111 test di tujuh file: `engine`, `authz`, `csv`, `i18n`, `cloud`, `remote`, `secret-leak`. `node --test test/` (menunjuk direktori) gagal di beberapa versi Node, jadi pakai glob atau sebutkan file-nya langsung. Semua logika inti sengaja dipisah dari DOM supaya bisa diuji tanpa browser.

## Struktur

| File | Isi |
| --- | --- |
| `src/engine.mjs` | Logika rotasi & skor: penjedaan, pencocokan, statistik, normalisasi sesi. Tanpa DOM. |
| `src/authz.mjs` | Kebijakan izin `can(role, action)` + pemetaan aksi UI → action. |
| `src/csv.mjs` | Parser teks-tempel (bukan impor file) → daftar nama. |
| `src/cloud.mjs` | Pemetaan sesi ↔ baris `doc`, pembagian live/finished, antrean sinkronisasi (debounce, retry). Tanpa DOM, tanpa network. |
| `src/remote.mjs` | Klien Supabase murni `fetch`: REST + GoTrue, refresh token, logout. Tidak pakai SDK supaya tetap zero-dependency. |
| `src/cloud-config.mjs` | Project URL + publishable key. Sengaja ikut repo (keduanya publik by design); `test/secret-leak.test.mjs` gagal kalau key rahasia ikut tersaji. |
| `supabase/migrations/` | Skema `sessions` + RLS + realtime. |
| `src/app.mjs` | Render + handler + penyimpanan localStorage. |
| `src/i18n.mjs` | Kamus `id` (default) dan `en`, 201 kunci masing-masing. |
| `test/` | 111 test murni Node (`node:test` + `node:assert/strict`). |
| `PRD.md` | Dokumen produk yang jadi acuan aturan main. |

## Papan bersama (Supabase)

Sesi kini hidup di satu tabel `public.sessions`: satu baris = satu sesi, utuh di kolom `doc` jsonb, dengan kolom generated (`name`, `session_date`, `status`, `duration_min`, `game_min`) untuk query papan peringkat. Write path diuji terhadap project asli, bukan hanya unit test.

- **Tayang**: `SUPABASE_URL` + publishable key ada di `src/cloud-config.mjs`. Keduanya memang publik — anon key bukan rahasia, ia hanya identitas project.
- **Login**: admin masuk dengan email + password (GoTrue). Viewer tidak perlu akun.
- **Sinkron**: perubahan masuk antrean (debounce 800 ms) → upsert. Gagal kirim tidak menghapus data lokal; tab ditutup/hidden memicu flush. Pill di kanan atas montre status: *connecting / tersimpan / menunggu n / offline / lokal*.
- **Kunci admin** dibuat lewat GoTrue admin API; kredensialnya ada di `.env.local` (git-ignored), bukan di README ini.

```bash
supabase db push --linked          # terapkan migrasi
supabase projects api-keys --project-ref <ref> -o json   # ambil key
```

## Peran, passcode, dan batasnya

Dua peran: **admin** (boleh tulis) dan **viewer** (hanya baca, default pengunjung baru).

**Yang ditegakkan server**: Row Level Security. `anon` hanya `SELECT`; `INSERT/UPDATE/DELETE` butuh JWT `authenticated`. Sudah dibuktikan dari browser — tulis tanpa login ditolak `42501` meski request-nya manual, dan pembaca tanpa akun tetap bisa melihat papan. Ini batas yang sebenarnya.

**Yang bukan keamanan**: toggle peran di UI. `canWrite()` menahan tombol dan menolak submit di sisi klien, jadi salah-klik dan iseng berhenti di situ — tapi source yang disajikan bisa dibaca siapa pun. Passcode `2468` masih ada di mode lokal (kalau `cloud-config` dikosongkan) dan tetap tidak aman; di mode cloud ia tidak muncul sama sekali, diganti dialog login.

**Konsekuensi yang perlu disadari sebelum papan ini dipakai beneran**: siapa pun dengan URL bisa membaca seluruh sesi beserta nama pemain dan skornya. Kalau itu tidak diinginkan, aktifkan RLS yang membatasi `SELECT` juga. Aturan rotasi (`engine.mjs`) masih dieksekusi di browser, jadi angka dari klien belum bisa dipercaya sepenuhnya — pemindahan ke server tetap pekerjaan rumah.

## Data

localStorage masih jadi cache perangkat (`papadel.current.v1`, `papadel.history.v1`) supaya aplikasi jalan tanpa jaringan, plus `papadel.auth.v1` berisi sesi login. Saat dibuka, cache ditimpa oleh isi papan bersama. Di mode cloud, menghapus "riwayatkan" juga menghapus barisnya di server.

## Menambah pemain dari teks

Di layar setup ada kotak **Tempel banyak nama sekaligus** — menempel teks, bukan unggah file. Aturan baca:

- Pemisah `koma`, `titik-koma`, atau `tab` ditebak dari kontennya (Excel Indonesia umumnya `;`).
- Satu baris tunggal = daftar nama (`Ayu, Budi, Citra` → 3 pemain).
- Banyak baris = ambil kolom pertama, kolom lain diabaikan; baris judul (`name`/`nama`/`player`/`pemain`) dibuang.
- Field berkutip dipatuhi (`"Budi, Jr."` utuh), `""` jadi `"`, CRLF/CR/baris kosong tidak membuat baris hantu.
- Nama di-trim, dedup kasus-abai terhadap daftar yang sudah ada maupun terhadap batch-nya sendiri, dan dipotong ke 24 karakter — tiap kejadian dilaporkan lewat toast, tidak diam-diam.

## Bahasa

Dua kamus (`id`, `en`) wajib identik kunci demi kunci tanpa duplikat; jumlah dan urutannya diverifikasi sebelum commit. Bahasa tersimpan per perangkat.

## Deploy

Push ke `main` = deploy. GitHub Pages dibangun dari root repo tanpa build step (<https://wiedevs.github.io/papadel/>).

## Langkah berikutnya

Sesuai `PRD.md`: pindahkan aturan rotasi `engine.mjs` ke server (Supabase Edge Function atau Postgres) supaya data dari klien bisa divalidasi, batasi `SELECT` kalau papan tidak boleh publik, lalu pertimbangkan Next.js untuk shell-nya.

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
node --test test/engine.test.mjs test/authz.test.mjs test/csv.test.mjs
```

`node --test test/` (menunjuk direktori) gagal di beberapa versi Node, jadi sebutkan file-nya langsung. Semua logika inti sengaja dipisah dari DOM supaya bisa diuji tanpa browser.

## Struktur

| File | Isi |
| --- | --- |
| `src/engine.mjs` | Logika rotasi & skor: penjedaan, pencocokan, statistik, normalisasi sesi. Tanpa DOM. |
| `src/authz.mjs` | Kebijakan izin `can(role, action)` + pemetaan aksi UI → action. |
| `src/csv.mjs` | Parser teks-tempel (bukan impor file) → daftar nama. |
| `src/app.mjs` | Render + handler + penyimpanan localStorage. |
| `src/i18n.mjs` | Kamus `id` (default) dan `en`, 181 kunci masing-masing. |
| `test/` | 73 test murni Node (`node:test` + `node:assert/strict`). |
| `PRD.md` | Dokumen produk yang jadi acuan aturan main. |

## Peran, passcode, dan batasnya

Ada dua peran di UI: **admin** (boleh tulis) dan **viewer** (hanya baca, default untuk pengunjung baru). Gerbangnya passcode `2468`.

**Ini bukan kontrol akses.** Cek passcode terjadi di browser pengunjung, jadi kodenya terbaca di source dan perannya bisa diubah langsung lewat localStorage. Fungsinya membuat dua peran itu *terasa* nyata sambil logika domain diuji. Penegalan izin dibuat siap pindah: satu tabel `POLICY` dan dua peta (`CLICK_ACTION`, `SUBMIT_ACTION`) yang aksi-aksi UI-nya 1:1 dengan kebijakan RLS Supabase nanti — termasuk test yang memindai `app.mjs` dan gagal kalau ada tombol tulis tanpa aturan.

## Data

Tanpa backend: semuanya di localStorage browser itu sendiri, per origin.

`papadel.current.v1` (sesi berjalan) · `papadel.history.v1` (sesi selesai) · `papadel.role.v1` · `papadel.theme.v1`

Konsekuensinya: HP dan laptop tidak akan pernah berbagi sesi, dan siapa pun yang membuka URL di perangkat baru mulai dari kosong.

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

Sesuai `PRD.md`: Next.js + Supabase, dengan Auth untuk peran (server-signed) dan Row Level Security sebagai penegalan izin yang sebenarnya, lalu memindahkan aturan rotasi `engine.mjs` ke server supaya bisa dipercaya.

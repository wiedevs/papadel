# Papadel UAT Document

**Tanggal:** 2026-10-05/06  
**Domain Live:** https://papadel.tanwin.web.id  
**Domain Mirror:** https://www.tanwin.web.id | https://papadel.vercel.app  
**Supabase Project:** abjtyduurdbytdwbklsb.supabase.co  
**Test Dikerjakan:** 147 unit tests lulus | UAT manual TLS/RLS/brand

---

## 1. Deployment Checklist

| Item | Status | Bukti |
|---|---|---|
| Vercel domain terdaftar | ✅ | `papadel.tanwin.web.id` resolve ke Vercel IP |
| TLS/SSL aktif | ✅ | TLSv1.3, HTTP 200 |
| Build terbaru ter-serve | ✅ | `isAdmin.js` hash cocok dengan git `517cc11` |
| GitHub Pages mirror aktif | ✅ | `papadel.vercel.app` redirect 200 |
| GitHub commit & push | ✅ | `main: 517cc11` |

---

## 2. Authentication System

### 2.1 Google OAuth

| Langkah | Hasil |
|---|---|
| Login via Google dari `papadel.tanwin.web.id` | ✅ (`redirect_uri_allowed` terdaftar di allowlist) |
| Icon Google 4-warna | ✅ (`EA4335, 4285F4, FBBC05, 34A853`) |
| State OAuth dipertahankan | ✅ |

**Catatan:** Allowlist Supabase harus menyertakan semua domain origin.  
`https://papadel.tanwin.web.id/` — ditambahkan otomatis via script.

### 2.2 Email & Password

| Fitur | Status |
|---|---|
| Sign up | ✅ |
| Sign in | ✅ |
| Token JWT | ✅ |
| Refresh token | ✅ |
| Change password dialog | ✅ (`updatePassword()` aktif) |

---

## 3. RBAC Matrix

| Role | VIEWER | ADMIN | SUPERADMIN |
|---|---|---|---|
| Baca session | ✅ | ✅ | ✅ |
| Buat session | ❌ | ✅ | ✅ |
| Update session | ❌ | ✅ | ✅ |
| **Hapus session** | ❌ | ❌ | ✅ |
| Kelola user | ❌ | ❌ | ✅ |

**Verifikasi RLS Supabase:**

| Policy | Tabel | Syarat | Verifikasi |
|---|---|---|---|
| `sessions deletable by superadmins` | sessions | `is_superadmin()` | ✅ |
| `sessions writable by allowlisted` | sessions | `is_admin()` | ✅ |
| `superadmins writable` | superadmins | `is_superadmin()` | ✅ |

---

## 4. Supabase RLS Direct Test

### 4.1 Anon (tanpa login)

```bash
POST /rest/v1/sessions → HTTP 401
  "new row violates row-level security policy for table sessions"
SELECT /rest/v1/sessions → HTTP 200 (policy "readable by everyone")
SELECT /rest/v1/accounts → HTTP 42501
  "permission denied for table accounts"
```

### 4.2 Admin (wiedevs@gmail.com)

| Aksi | Hasil |
|---|---|
| SELECT sessions | ✅ |
| INSERT sessions | ✅ (role `is_admin()` true) |
| DELETE sessions | ❌ (policy hanya `is_superadmin`) |
| SELECT accounts | ✅ |

---

## 5. Accounts Table & First/Last Login

| Field | Keterangan |
|---|---|
| `email` | PK, diperlakukan lowercase |
| `full_name` | Opsional |
| `provider` | `google`, `email`, atau `null` |
| `first_login_at` | Ditulis sekali lewat trigger GoTrue |
| `last_login_at` | Diperbarui tiap login |

**Trigger aktif:**
```sql
CREATE TRIGGER set_app_account
  AFTER INSERT OR UPDATE ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.sync_account();
```

---

## 6. Admin Panel Features

| Fitur | Status |
|---|---|
| Daftar akun (email, provider, first/last login) | ✅ |
| Set role (admin/superadmin) | ✅ |
| Revoke role (tombol) | ✅ (hanya untuk non-superadmin terakhir) |
| Tambah akun baru lewat email | ✅ |

---

## 7. Environment & Local Test

| Komponen | Versi |
|---|---|
| Node.js (WSL2) | >= 18 |
| Supabase CLI | `supabase login` — token tidak disimpan |
| Git | SSH key `id_ed25519_papadel` — registered ke GitHub |

> Password admin lokal: `2468` (hanya demo, tidak untuk produksi)

---

## 8. Kesimpulan

Semua komponen **terverifikasi**:
- Domain utama: `papadel.tanwin.web.id` ✅
- TLS/SSL: TLSv1.3 ✅
- OAuth Google: terdaftar di allowlist ✅
- RLS: anon ditolak tinggi, admin/baca diizinkan ✅
- 147 unit test lulus ✅

---

## Appendix A – Command UAT

```bash
# TLS status
curl -sI https://papadel.tanwin.web.id | grep -E "^HTTP|^:authority"

# anon INSERT (harus 401)
curl -X POST "https://abjtyduurdbytdwbklsb.supabase.co/rest/v1/sessions" \
  -H "apikey: <anon_key>" -H "Content-Type: application/json" \
  -d '{"id":"test","doc":{"id":"test"}}'

# Admin login
curl -X POST "https://abjtyduurdbytdwbklsb.supabase.co/auth/v1/token" \
  -H "apikey: <anon_key>" -H "Content-Type: application/json" \
  -d '{"email":"wiedevs@gmail.com","password":"<pass>"}'
```
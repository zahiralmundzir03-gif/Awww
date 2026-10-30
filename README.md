# Yūgen Nexus — GitHub + Supabase Auth + Supabase Edge Function

Paket ini berisi frontend HTML, SQL untuk akun/profil, Supabase Edge Function untuk deploy Vercel/Netlify, dan backend Vercel alternatif.

## Struktur repository GitHub

Upload **isi folder** ini ke root repository (jangan upload ZIP saja):

```text
index.html
README.md
supabase-schema.sql
api/deploy.js                         # backend alternatif jika memakai Vercel
supabase/functions/deploy/index.ts    # backend utama di Supabase Edge Functions
```

## 1. Siapkan Supabase dan tabel akun

1. Buka https://supabase.com/dashboard lalu pilih project kamu (atau buat project baru).
2. Masuk ke **SQL Editor → New query**.
3. Buka `supabase-schema.sql`, salin semua isinya, tempel ke SQL Editor, lalu klik **Run**.
4. Buka **Project Settings → API** (atau Connect/API Keys, tergantung tampilan dashboard).
5. Salin **Project URL** dan **publishable key** (atau legacy `anon` key). Keduanya boleh digunakan di frontend. **Jangan pernah gunakan `service_role` key di HTML/GitHub.**

### Sambungkan HTML ke project kamu

Buka `index.html`, cari `YN_SUPABASE_CONFIG` dan ganti placeholder:

```js
const YN_SUPABASE_CONFIG = window.YN_SUPABASE_CONFIG || {
  url: "https://YOUR_PROJECT_REF.supabase.co",
  anonKey: "YOUR_SUPABASE_PUBLISHABLE_OR_ANON_KEY"
};
```

Ganti kedua nilai dengan nilai asli dari dashboard Supabase kamu. Setelah itu simpan dan commit ke GitHub.

## 2. Simpan akun user

- User mendaftar lewat tab **Daftar** pada website.
- Supabase Auth menyimpan email/password dengan aman; password tidak disimpan ke tabel profil.
- Trigger SQL otomatis membuat row pada `public.profiles` dengan username, email, role `basic`, dan tanggal pembuatan.
- RLS membatasi user biasa membaca profil miliknya sendiri.
- Jika email confirmation diaktifkan, user perlu klik tautan dari email sebelum login.
- Untuk URL konfirmasi, buka **Authentication → URL Configuration** dan atur Site URL serta Redirect URLs ke domain website yang kamu deploy.
- User lama yang tersimpan hanya di localStorage/IndexedDB tidak otomatis dimigrasikan. Mereka perlu daftar ulang atau dibuatkan proses migrasi terpisah.

### Jadikan akunmu admin/developer

1. Daftar dengan akunmu sendiri dan konfirmasi email jika diminta.
2. Login sekali agar profil dibuat.
3. Di Supabase → SQL Editor, jalankan perintah ini dengan username yang kamu daftarkan:

```sql
update public.profiles
set role = 'developers'
where username_key = lower('USERNAME_KAMU');
```

Ganti `USERNAME_KAMU`. Jalankan hanya untuk akunmu sendiri. Role admin dicek kembali oleh RPC di server, bukan hanya dari tampilan browser.

## 3. Menjalankan backend di Supabase

Backend utama untuk fitur deploy berada di `supabase/functions/deploy/index.ts`.

### Deploy Edge Function

1. Install Node.js dan Supabase CLI di komputer.
2. Buka terminal dari folder project yang berisi folder `supabase/`.
3. Jalankan:

```bash
npx supabase login
npx supabase link --project-ref PROJECT_REF_KAMU
npx supabase functions deploy deploy
```

Ganti `PROJECT_REF_KAMU` dengan project ref dari URL/dashboard Supabase kamu. Jika CLI meminta login atau konfirmasi project, ikuti instruksinya.

Supabase Edge Functions menyediakan `SUPABASE_URL` dan `SUPABASE_ANON_KEY` sebagai environment bawaan. Function juga memverifikasi access token Supabase pengguna. Frontend akan otomatis memanggil:

```text
https://PROJECT_REF_KAMU.supabase.co/functions/v1/deploy
```

setelah URL dan anon/publishable key Supabase di `index.html` diganti. Pengguna harus login sebelum endpoint dapat memvalidasi token Vercel/Netlify atau menjalankan deploy.

### Apa yang dilakukan backend

- `action: "validate"`: memvalidasi token Vercel/Netlify dengan API penyedia.
- `action: "deploy"`: mengirim HTML ke Vercel atau Netlify.
- Token deploy hanya digunakan selama request; tidak ditulis ke `localStorage`, database Supabase, atau log aplikasi.
- Request memerlukan sesi Supabase yang valid.

## 4. Backend alternatif di Vercel (opsional)

Folder `api/deploy.js` adalah versi backend alternatif jika kamu memilih menjalankan endpoint deploy di Vercel, bukan Supabase Edge Functions. Jika memilih alternatif ini:

1. Deploy repository ke Vercel.
2. Tambahkan environment variables `SUPABASE_URL` dan `SUPABASE_ANON_KEY` di Vercel Project Settings.
3. Atur endpoint di frontend sebelum script aplikasi dimuat, dengan `window.YN_DEPLOY_BACKEND_URL = "/api/deploy"`.
4. Redeploy project.

Tidak perlu menjalankan kedua backend sekaligus; Supabase Edge Function adalah pilihan default dalam paket ini.

## 5. Upload ke GitHub

1. Buat repository baru di GitHub.
2. Extract ZIP ini, lalu upload **isi folder `yugen-nexus-serverless/`** ke root repository.
3. Pastikan `index.html` ada di root, dan path `supabase/functions/deploy/index.ts` tidak berubah.
4. Commit perubahan konfigurasi Supabase setelah memasukkan URL dan anon/publishable key.
5. Kamu bisa host HTML sebagai static site; Supabase menangani auth dan Edge Function.

## Keamanan dan batasan

- Jangan menaruh Supabase `service_role` key, password database, atau token Vercel/Netlify di HTML atau repository.
- Publishable/anon key memang terlihat oleh browser; keamanan database harus berasal dari RLS dan pemeriksaan role server-side.
- Aktifkan rate limiting dan pertimbangkan membatasi fitur deploy hanya untuk akun tepercaya sebelum membuka website ke publik.
- Endpoint API eksternal di `API_CENTER` merupakan layanan pihak ketiga; fallback harus diuji untuk kompatibilitas masing-masing.
- Aku sudah memeriksa sintaks JavaScript HTML dan backend Node.js, tetapi belum dapat menguji koneksi ke project Supabase kamu tanpa URL/key project tersebut.

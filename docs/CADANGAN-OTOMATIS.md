# Cadangan otomatis database

Setiap malam pukul **02.17 WIB**, GitHub Actions (`.github/workflows/backup.yml`) menjalankan `scripts/backup.sh`:

1. menyalin struktur, data, dan hak akses skema `public` (`database.sql`),
2. mengekspor setiap tabel `pentol_*` ke CSV (bisa dibuka di Excel / Google Sheets),
3. membungkus semuanya menjadi **file 7z terenkripsi AES-256** (nama file di dalamnya ikut disembunyikan),
4. menyimpannya sebagai *artifact* GitHub selama **90 hari**.

Repo ini **publik**, jadi file cadangan selalu dienkripsi. Tanpa kata sandi, isinya tidak bisa dibaca siapa pun, termasuk GitHub.

Selama dua secret di bawah belum diisi, alur ini **dilewati tanpa galat**.

## Pemasangan (sekali, dari laptop, ±10 menit)

### 1. Ambil connection string dari Supabase
1. Buka project Supabase → tombol **Connect** (di atas) atau **Project Settings → Database**.
2. Pilih **Session pooler** (bukan *Direct connection*, karena server GitHub hanya memakai IPv4).
3. Salin URI-nya, bentuknya seperti:
   `postgresql://postgres.gnwzgiiarbxutattxhcy:[YOUR-PASSWORD]@aws-0-<region>.pooler.supabase.com:5432/postgres`
4. Ganti `[YOUR-PASSWORD]` dengan kata sandi database. Kalau lupa: **Project Settings → Database → Reset database password**. Sebaiknya pakai kata sandi berisi **huruf dan angka saja**, karena simbol seperti `@ : / #` merusak URI.

### 2. Tambahkan 2 secret di GitHub
Repo `dromadi/pentol-gilaaa` → **Settings → Secrets and variables → Actions → New repository secret**:

| Name | Secret |
|---|---|
| `SUPABASE_DB_URL` | URI dari langkah 1 (dengan kata sandi asli) |
| `BACKUP_PASSWORD` | Kata sandi cadangan buatan Anda sendiri, minimal 12 karakter. **Simpan di catatan aman.** Tanpa ini cadangan tidak bisa dibuka. |

### 3. Coba jalankan sekarang
1. Repo → tab **Actions** → **Cadangan database** → **Run workflow** → **Run workflow**.
2. Tunggu ±2 menit sampai tanda ✓ hijau.
3. Buka hasilnya → bagian **Artifacts** → unduh `cadangan-pentol-gilaaa-N`. GitHub mengunduhnya sebagai `.zip`, dan di dalamnya ada file `.7z`.
4. Buka file `.7z` dengan **ZArchiver** (Android), **7-Zip** (Windows), atau **Keka** (Mac), lalu masukkan `BACKUP_PASSWORD`.
5. Isinya: `RINGKASAN.txt` (jumlah baris per tabel), folder `csv/`, dan `database.sql`.

Setelah itu cadangan berjalan sendiri setiap malam.

## Yang perlu diketahui
- **Kalau gagal**, GitHub mengirim email ke pemilik repo. Penyebab umum: kata sandi database diganti (perbarui secret `SUPABASE_DB_URL`) atau project Supabase sedang di-*pause*.
- **GitHub menonaktifkan jadwal setelah 60 hari tanpa aktivitas di repo** dan mengirim email pemberitahuan. Aktifkan lagi di tab Actions (**Enable workflow**).
- Cadangan setiap malam kemungkinan besar juga menjaga project Supabase gratis tetap aktif. Project gratis di-*pause* setelah 7 hari tanpa aktivitas.
- Cadangan manual tetap ada di admin: **Laporan → Unduh cadangan** (Excel, langsung ke HP).

## Memulihkan data

**Kehilangan sebagian data** (misalnya beberapa baris terhapus): buka file CSV tabel yang bersangkutan, lalu salin baris yang hilang. Bisa juga lewat Supabase **Table Editor → Insert → Import data from CSV** ke tabel yang sama. Minta bantuan agen bila ragu.

**Project hilang total**, dipulihkan ke project Supabase baru:
1. Buat project baru. Di **SQL Editor**, jalankan isi `database.sql`. Kalau terlalu besar untuk SQL Editor, pakai `psql "<connection string project baru>" -f database.sql`.
2. Galat tentang `pentol_admins` / `auth.users` wajar terjadi, karena akun admin lama tidak ikut pindah. Buat akun admin lagi dan daftarkan UUID-nya (langkah 2–3 di `admin/README.md`).
3. Ganti `admin/config.js` dan `connect-src` CSP di `admin/index.html` serta `index.html` ke URL project baru.

Prosedur ini sudah diuji (14 Nov 2026) di Postgres lokal: cadangan dibuat, file 7z tidak bisa dibuka tanpa kata sandi, lalu dipulihkan ke database kosong. Jumlah baris semua tabel sama, 14 fungsi kembali, dan hak akses katalog publik serta admin berjalan.

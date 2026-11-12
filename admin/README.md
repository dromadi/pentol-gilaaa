# Admin Pentol Gilaaa

Katalog pelanggan memakai GitHub Pages. Area admin memakai Supabase Auth dan Postgres.

## Aktivasi

1. Buat project Supabase untuk toko. Di **SQL Editor**, jalankan `schema.sql` sekali.
2. Nonaktifkan pendaftaran mandiri di pengaturan Auth. Buat pengguna di **Authentication → Users** dan salin UUID pengguna.
3. Daftarkan UUID tersebut lewat SQL Editor.

   ```sql
   insert into public.pentol_admins (user_id)
   values ('UUID-AKUN-ADMIN')
   on conflict do nothing;
   ```

4. Isi `config.js` dengan Project URL berbentuk `https://PROJECT.supabase.co` dan publishable key berawalan `sb_publishable_`. Jangan memasukkan kata sandi, secret key, atau service role key ke GitHub.
5. Commit konfigurasi dan buka `/pentol-gilaaa/admin/`. Coba masuk sebagai admin dan sebagai akun biasa. Akun biasa tidak boleh melihat atau mengubah stok.

## Pencatatan

Setiap kode batch dan varian memiliki satu baris. Diterima, terpesan, dan diantar adalah jumlah pack. Saat menyerahkan pesanan, kurangi jumlah terpesan dan naikkan jumlah diantar dalam penyimpanan yang sama. Analitik merangkum stok dan pengantaran. Pesanan, pembayaran, omzet, dan laba masih dikelola di pembukuan. Data katalog publik dan label sold out diperbarui terpisah. Data stok lama belum diimpor.

# Admin Pentol Gilaaa

Katalog pelanggan (`/index.html`) memakai GitHub Pages. Area admin (`/admin/`) memakai Supabase Auth dan Postgres.

## Aktivasi project Supabase baru

1. Buat project Supabase. Di **SQL Editor**, jalankan file berikut **berurutan, masing-masing sekali**:
   1. `schema.sql` – admin & stok batch
   2. `orders.sql` – pesanan
   3. `operations.sql` – pembayaran, restok, harga, inbox checkout (berisi data contoh BATCH-01/02)
   4. `security-2026-11.sql` – perbaikan audit: batas checkout, katalog v2 dengan batas stok (boleh dijalankan ulang)
   5. `receipts-2026-11.sql` – penerimaan bertahap dari PO (boleh dijalankan ulang)
2. Nonaktifkan pendaftaran mandiri di pengaturan Auth. Buat pengguna di **Authentication → Users** dan salin UUID pengguna.
3. Daftarkan UUID tersebut lewat SQL Editor.

   ```sql
   insert into public.pentol_admins (user_id)
   values ('UUID-AKUN-ADMIN')
   on conflict do nothing;
   ```

4. Isi `config.js` dengan Project URL `https://PROJECT.supabase.co` dan publishable key `sb_publishable_…`. Jangan memasukkan kata sandi, secret key, atau service role key ke GitHub.
5. **Jika Project URL berubah, ubah juga `connect-src` di tag Content-Security-Policy pada `admin/index.html`**, kalau tidak admin tidak bisa memuat data.
6. Commit konfigurasi dan buka `/pentol-gilaaa/admin/`. Coba masuk sebagai admin dan sebagai akun biasa. Akun biasa tidak boleh melihat atau mengubah stok.

## Pencatatan

- **Stok per batch:** satu baris per kode batch + varian. Diterima, terpesan, dan diantar dalam pack. Pesanan dan pengantaran mengubah angka terpesan/diantar otomatis lewat `pentol_order_action`; edit manual di form stok hanya untuk koreksi atau booking lama yang belum tercatat sebagai pesanan.
- **Pesanan, pembayaran, pengantaran:** dicatat di menu Pesanan dan Packing & Tagihan. Setiap pembayaran disimpan dengan tanggalnya, dan laporan kas mengikuti tanggal itu.
- **Restok, HPP, harga jual, laba:** di menu Restok & Supplier dan Harga & Laba.
- **Checkout katalog:** pembeli mengirim permintaan ke inbox (`pentol_submit_checkout`). Batasnya 8 per nomor per jam, 40 total per jam, dan 150 yang menunggu. Jika batas tercapai, pembeli tetap diarahkan ke WhatsApp. Jumlah per varian tidak boleh melebihi stok bebas; katalog menampilkan "Sisa N pack" saat stok tinggal 1–9.

### Aktifkan penerimaan PO pada produksi yang sudah berjalan

Jalankan hanya `receipts-2026-11.sql` di Supabase SQL Editor, lalu buka **Restok & Supplier → Terima barang**. Angka diterima yang sudah tercatat di Stok per Batch menjadi saldo awal. Isi jumlah fisik tambahan pada setiap penerimaan, bukan total kumulatif. Tanggal di Stok per Batch menunjukkan tanggal penerimaan terakhir, dan rincian masing-masing kedatangan tersimpan di riwayat PO.

Riwayat audit dan catatan teknis: `../docs/AUDIT-2026-11.md`.

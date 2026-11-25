# Admin Pentol Gilaaa

Katalog pelanggan (`/index.html`) memakai GitHub Pages. Area admin (`/admin/`) memakai Supabase Auth dan Postgres.

## Aktivasi project Supabase baru

1. Buat project Supabase. Di **SQL Editor**, jalankan file berikut **berurutan, masing-masing sekali**:
   1. `schema.sql` – admin & stok batch
   2. `orders.sql` – pesanan
   3. `operations.sql` – pembayaran, restok, harga, inbox checkout (berisi data contoh BATCH-01/02)
   4. `security-2026-11.sql` – perbaikan audit: batas checkout, katalog v2 dengan batas stok (boleh dijalankan ulang)
   5. `receipts-2026-11.sql` – penerimaan bertahap dari PO (boleh dijalankan ulang)
   6. `invoice-reference-2026-11.sql` – penyimpanan nomor invoice Excel (boleh dijalankan ulang)
   7. `reconciliation-history-2026-11.sql` – riwayat koreksi Excel (boleh dijalankan ulang)
   8. `stock-integrity-2026-11.sql` – stok hanya berubah lewat PO, pesanan, dan koreksi beralasan (boleh dijalankan ulang). **Wajib setelah no. 5 dan 7**, karena setelah ini barang masuk hanya bisa dicatat lewat Terima barang
   9. `operasional-2026-11.sql` – catatan pengiriman bertanggal, koreksi transaksi (batal bayar, kurangi antar, batal sisa), dan stok opname (boleh dijalankan ulang). Sebelum file ini dijalankan, tombol Koreksi dan Hitung stok tersembunyi dan laporan memakai tanggal pesanan
   10. `ubah-pesanan-2026-11.sql` – ubah pesanan yang sudah dibayar atau sebagian diantar (tambah/kurangi/ganti varian, harga, ongkir), tercatat di Riwayat Perubahan (boleh dijalankan ulang). **Setelah no. 9.** Sebelum file ini dijalankan, pesanan yang belum dibayar & belum diantar tetap bisa diubah; yang sudah dibayar/diantar menampilkan pesan bahwa SQL ini perlu dijalankan
   11. `tanggal-antar-2026-11.sql` – antar bisa dicatat pada tanggal lain (pencatatan terlambat), memengaruhi laporan menurut tanggal antar (boleh dijalankan ulang). **Setelah no. 9.** Sebelum dijalankan, antar hanya bisa dicatat pada hari ini
   12. `hapus-transaksi-2026-11.sql` – tombol Hapus semua transaksi di Rekonsiliasi → Impor & ekspor (boleh dijalankan ulang). **Setelah no. 11.**
   13. `perbaikan-temuan-2026-11-16.sql` – metode & waktu catat pembayaran, tabel biaya harian, permintaan → pesanan hasilnya, relasi stok batch → varian & PO (boleh dijalankan ulang). **Setelah no. 12.** Sudah dijalankan di produksi 16 Nov; isi file disusun ulang dari laporannya
   14. `metode-bayar-2026-11.sql` – metode bayar diberi nilai bawaan `lainnya` agar Catat pembayaran tidak gagal (boleh dijalankan ulang). **Setelah no. 13. Jalankan juga di produksi.**
   15. `preorder-2026-11.sql` – pre-order di katalog: varian kosong yang masih ada di PO bisa dipesan pembeli, dibatasi sisa PO, dengan perkiraan tiba (boleh dijalankan ulang). **Setelah no. 4 dan 5.** Sebelum dijalankan, katalog tetap menulis Stok habis
   16. `varian-2026-11.sql` – varian dikelola dari admin (Laporan → Varian & harga): tambah varian, ubah nama/ukuran/kategori/harga, sembunyikan varian; katalog membaca varian dari database (`pentol_catalog_v4`) (boleh dijalankan ulang). **Setelah no. 15.** Sebelum dijalankan, hanya harga yang bisa diubah dan daftar varian tetap 9 varian bawaan
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

> **Produksi:** file 4–11 di atas sudah dijalankan di Supabase produksi pada 16 Nov 2026 (berurutan, tanpa galat). File SQL baru berikutnya cukup dijalankan sendiri sesuai keterangannya.

## Pencatatan

- **Stok per batch:** satu baris per kode batch + varian, dibuat dari **Catat restok**. Diterima bertambah lewat **Terima barang**; terpesan dan diantar berubah otomatis dari pesanan. Admin tidak bisa mengubah tabel stok langsung. Salah hitung atau barang rusak: tombol **Koreksi** (alasan wajib, tercatat di Riwayat Perubahan).
- **Booking tanpa pesanan** (sisa data lama/Excel) ditampilkan di Stok per Batch. Bereskan dengan **Catat pesanan → Pakai booking lama**, sehingga booking itu menjadi milik pelanggan. Rekonsiliasi Excel tidak lagi menambah booking.
- **Pesanan, pembayaran, pengantaran:** dicatat di menu Pesanan dan Packing & Tagihan. Setiap pembayaran disimpan dengan tanggalnya, dan laporan kas mengikuti tanggal itu.
- **Restok, HPP, harga jual, laba:** di menu Restok & Supplier dan Harga & Laba.
- **Checkout katalog:** pembeli mengirim permintaan ke inbox (`pentol_submit_checkout`). Batasnya 8 per nomor per jam, 40 total per jam, dan 150 yang menunggu. Jika batas tercapai, pembeli tetap diarahkan ke WhatsApp. Jumlah per varian tidak boleh melebihi stok bebas, ditambah sisa PO yang belum dibooking bila `preorder-2026-11.sql` sudah dijalankan (varian tampil PRE-ORDER); katalog tidak menampilkan jumlah sisa; pembeli hanya dibatasi (tombol + berhenti, keterangan "Jumlah maksimal tercapai").

### Aktifkan penerimaan PO pada produksi yang sudah berjalan

Jalankan hanya `receipts-2026-11.sql` di Supabase SQL Editor, lalu buka **Restok & Supplier → Terima barang**. Angka diterima yang sudah tercatat di Stok per Batch menjadi saldo awal. Isi jumlah fisik tambahan pada setiap penerimaan, bukan total kumulatif. Tanggal di Stok per Batch menunjukkan tanggal penerimaan terakhir, dan rincian masing-masing kedatangan tersimpan di riwayat PO.

### Aktifkan penyimpanan nomor invoice Excel

Jalankan `invoice-reference-2026-11.sql` di Supabase SQL Editor. Di admin, bandingkan file pada **Rekonsiliasi Excel**, buka invoice untuk pesanan yang cocok, lalu pilih **Simpan nomor Excel**. Nomor invoice berformat `PG-YYYYMMDD-NNN` dapat disimpan satu kali per pesanan dan harus unik. Kode internal pesanan tetap digunakan untuk identifikasi di database.

### Aktifkan riwayat koreksi Excel

Jalankan `reconciliation-history-2026-11.sql` di Supabase SQL Editor. Koreksi dari **Rekonsiliasi Excel** akan meminta alasan dan tampil di **Riwayat Perubahan**. Pencatatan dimulai saat migrasi aktif. Riwayat menampilkan waktu WIB, ID admin, nilai sebelum dan sesudah, serta alasan.

Riwayat audit dan catatan teknis: `../docs/AUDIT-2026-11.md`.

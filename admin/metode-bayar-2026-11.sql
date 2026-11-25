-- Pastikan pencatatan pembayaran tidak gagal karena kolom metode bayar (lihat perbaikan-temuan-2026-11-16.sql).
-- Aman dijalankan ulang. Jalankan SETELAH perbaikan-temuan-2026-11-16.sql.
--
-- Fungsi pentol_order_action ('pay') menyisipkan 4 nilai tanpa nama kolom: id, order_id, paid_on, amount.
-- Kolom method & created_at ditambahkan sesudahnya, jadi keduanya diisi dari nilai bawaan. Bila method wajib
-- tanpa nilai bawaan, setiap "Catat pembayaran" gagal. Nilai bawaan 'lainnya' = metode belum dicatat.
begin;
alter table public.pentol_payments alter column method set default 'lainnya';
alter table public.pentol_payments alter column created_at set default now();
commit;

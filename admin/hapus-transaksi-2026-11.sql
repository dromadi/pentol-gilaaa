-- Hapus semua transaksi (lihat docs/EVALUASI-FITUR-2026-11.md, "Impor & ekspor").
-- Aman dijalankan ulang. Jalankan SETELAH tanggal-antar-2026-11.sql.
--
-- pentol_wipe_transactions: menghapus pesanan, pembayaran, pengantaran, permintaan katalog, stok batch, PO,
-- penerimaan, riwayat koreksi, dan biaya harian (bila ada). Harga jual/daftar varian (pentol_products) dan akun admin TIDAK dihapus.
-- Nomor invoice mulai lagi dari 1. Wajib teks konfirmasi persis 'HAPUS SEMUA'.
-- Aplikasi mengunduh cadangan Excel lebih dulu sebelum memanggil fungsi ini.
begin;

create or replace function public.pentol_wipe_transactions(confirm_text text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare counts jsonb;
begin
  perform public.pentol_assert_admin();
  if confirm_text is distinct from 'HAPUS SEMUA' then
    raise exception 'Konfirmasi salah. Ketik HAPUS SEMUA untuk menghapus semua transaksi.';
  end if;
  -- Satu penghapusan pada satu waktu; tabel dikunci agar tidak ada transaksi baru di tengah jalan.
  lock table public.pentol_orders, public.pentol_order_items, public.pentol_payments, public.pentol_shipments,
    public.pentol_inbox, public.pentol_batch_stock, public.pentol_purchases, public.pentol_purchase_items,
    public.pentol_purchase_receipts, public.pentol_reconciliation_history in exclusive mode;
  select jsonb_build_object(
    'pesanan', (select count(*) from public.pentol_orders),
    'pembayaran', (select count(*) from public.pentol_payments),
    'pengantaran', (select count(*) from public.pentol_shipments),
    'permintaan', (select count(*) from public.pentol_inbox),
    'stok_batch', (select count(*) from public.pentol_batch_stock),
    'po', (select count(*) from public.pentol_purchases),
    'riwayat', (select count(*) from public.pentol_reconciliation_history)) into counts;
  -- Permintaan katalog dihapus sebelum pesanan: kolom converted_order_id (migrasi 16 Nov) bisa merujuk ke pesanan.
  delete from public.pentol_inbox where true;
  delete from public.pentol_shipments where true;
  delete from public.pentol_payments where true;
  delete from public.pentol_order_items where true;
  delete from public.pentol_orders where true;
  -- Biaya harian (pentol_expenses, migrasi 16 Nov) ikut terhapus bila tabelnya ada.
  if to_regclass('public.pentol_expenses') is not null then
    execute 'delete from public.pentol_expenses where true';
  end if;
  delete from public.pentol_purchase_receipts where true;
  delete from public.pentol_reconciliation_history where true;
  delete from public.pentol_batch_stock where true;
  delete from public.pentol_purchase_items where true;
  delete from public.pentol_purchases where true;
  alter table public.pentol_orders alter column invoice_no restart with 1;
  return counts;
end $$;
revoke all on function public.pentol_wipe_transactions(text) from public, anon, authenticated;
grant execute on function public.pentol_wipe_transactions(text) to authenticated;

notify pgrst, 'reload schema';
commit;

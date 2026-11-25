-- Perbaikan temuan 16 Nov 2026 (lihat docs/EVALUASI-FITUR-2026-11.md, "Migrasi produksi di luar repo").
-- Aman dijalankan ulang. Jalankan SETELAH hapus-transaksi-2026-11.sql.
--
-- CATATAN: migrasi ini SUDAH dijalankan langsung di Supabase produksi pada 16 Nov 2026 sebelum masuk repo.
-- Isi file ini disusun ulang dari laporan perubahannya, karena file aslinya tidak tersimpan. Semua perintah
-- memakai "if not exists" / pemeriksaan katalog, jadi menjalankannya di produksi tidak mengubah apa pun.
-- Pengisian data sekali jalan di produksi (delivered_at 17 pesanan dari pentol_shipments, riwayat Terima barang
-- Batch 1 & 2 di pentol_purchase_receipts) TIDAK diulang di sini karena hanya berlaku untuk data produksi saat itu.
begin;

-- 1. Metode & waktu catat pembayaran.
alter table public.pentol_payments
  add column if not exists method text not null default 'lainnya',
  add column if not exists created_at timestamptz not null default now();
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.pentol_payments'::regclass
                 and contype = 'c' and pg_get_constraintdef(oid) like '%method%') then
    alter table public.pentol_payments add constraint pentol_payments_method_check
      check (method in ('tunai','bni','gopay','transfer_lain','lainnya'));
  end if;
end $$;

-- 2. Biaya harian (admin saja).
create table if not exists public.pentol_expenses (
  id bigint generated always as identity primary key,
  spent_on date not null,
  category text not null check (category in
    ('plastik','kemasan','ongkir_antar','es_batu','listrik_freezer','promosi','lainnya')),
  amount integer not null check (amount between 1 and 100000000),
  note text not null default '' check (length(note) <= 500),
  created_at timestamptz not null default now()
);
create index if not exists pentol_expenses_by_date on public.pentol_expenses (spent_on);
alter table public.pentol_expenses enable row level security;
revoke all on public.pentol_expenses from public, anon, authenticated;
grant select on public.pentol_expenses to authenticated;
drop policy if exists admin_read on public.pentol_expenses;
create policy admin_read on public.pentol_expenses for select to authenticated
  using (exists (select 1 from public.pentol_admins where user_id = (select auth.uid())));

-- 3. Permintaan katalog -> pesanan hasilnya.
alter table public.pentol_inbox
  add column if not exists converted_order_id uuid references public.pentol_orders(id);

-- 4. Relasi wajib stok batch -> varian & PO (ditambahkan hanya bila belum ada relasi serupa).
do $$ begin
  if not exists (select 1 from pg_constraint where contype = 'f'
                 and conrelid = 'public.pentol_batch_stock'::regclass and confrelid = 'public.pentol_products'::regclass) then
    alter table public.pentol_batch_stock add constraint pentol_batch_stock_sku_fkey
      foreign key (sku) references public.pentol_products(sku);
  end if;
  if not exists (select 1 from pg_constraint where contype = 'f'
                 and conrelid = 'public.pentol_batch_stock'::regclass and confrelid = 'public.pentol_purchases'::regclass) then
    alter table public.pentol_batch_stock add constraint pentol_batch_stock_batch_code_fkey
      foreign key (batch_code) references public.pentol_purchases(batch_code);
  end if;
end $$;

commit;

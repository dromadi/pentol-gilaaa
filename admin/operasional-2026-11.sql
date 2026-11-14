-- Operasional toko (lihat docs/EVALUASI-FITUR-2026-11.md, bagian "Operasional").
-- Aman dijalankan ulang. Jalankan SETELAH stock-integrity-2026-11.sql.
--
-- 1. pentol_shipments: catatan setiap pengiriman dengan tanggalnya (diisi otomatis oleh trigger).
-- 2. pentol_correct_order: batalkan pembayaran, kurangi jumlah antar, batalkan sisa pesanan (alasan wajib).
-- 3. pentol_stock_opname: simpan hitungan fisik freezer untuk banyak batch sekaligus.
begin;

-- ===== 1. Catatan pengiriman =====
create table if not exists public.pentol_shipments (
  id bigint generated always as identity primary key,
  order_id uuid not null references public.pentol_orders(id) on delete restrict,
  stock_id uuid not null references public.pentol_batch_stock(id) on delete restrict,
  quantity integer not null check (quantity <> 0),          -- negatif = koreksi antar
  unit_price integer not null check (unit_price >= 0),
  shipped_on date not null,
  created_at timestamptz not null default now()
);
create index if not exists pentol_shipments_by_date on public.pentol_shipments (shipped_on);
create index if not exists pentol_shipments_by_order on public.pentol_shipments (order_id);
alter table public.pentol_shipments enable row level security;
revoke all on public.pentol_shipments from public, anon, authenticated;
grant select on public.pentol_shipments to authenticated;
drop policy if exists "Admins read shipments" on public.pentol_shipments;
create policy "Admins read shipments" on public.pentol_shipments for select to authenticated
  using (exists (select 1 from public.pentol_admins where user_id = (select auth.uid())));

-- Data lama: satu baris per item yang sudah diantar, bertanggal tanggal antar tercatat (atau tanggal pesan).
insert into public.pentol_shipments (order_id, stock_id, quantity, unit_price, shipped_on)
select i.order_id, i.stock_id, i.shipped, i.unit_price,
       coalesce((o.delivered_at at time zone 'Asia/Jakarta')::date, o.order_date)
from public.pentol_order_items i join public.pentol_orders o on o.id = i.order_id
where i.shipped > 0
  and not exists (select 1 from public.pentol_shipments s where s.order_id = i.order_id and s.stock_id = i.stock_id);

create or replace function public.pentol_log_shipment() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.shipped is distinct from old.shipped then
    insert into public.pentol_shipments (order_id, stock_id, quantity, unit_price, shipped_on)
    values (new.order_id, new.stock_id, new.shipped - old.shipped, new.unit_price,
            (now() at time zone 'Asia/Jakarta')::date);
  end if;
  return new;
end $$;
revoke all on function public.pentol_log_shipment() from public, anon, authenticated;
drop trigger if exists pentol_log_shipment on public.pentol_order_items;
create trigger pentol_log_shipment after update of shipped on public.pentol_order_items
for each row execute function public.pentol_log_shipment();

-- Riwayat menerima jenis koreksi baru.
alter table public.pentol_reconciliation_history drop constraint if exists pentol_reconciliation_history_action_check;
alter table public.pentol_reconciliation_history add constraint pentol_reconciliation_history_action_check
  check (action in ('stock', 'ship', 'pay', 'void_pay', 'unship', 'cancel_rest'));

-- ===== 2. Koreksi transaksi =====
create or replace function public.pentol_correct_order(
  change_type text, target uuid, expected_revision integer, payload jsonb, change_reason text
) returns void language plpgsql security definer set search_path = '' as $$
declare
  o public.pentol_orders%rowtype;
  item public.pentol_order_items%rowtype;
  reason_text text := trim(change_reason);
  amount bigint;
  qty integer;
  paid_total bigint;
  order_total bigint;
  before_data jsonb;
  after_data jsonb;
  label_text text;
begin
  perform public.pentol_assert_admin();
  if change_type is null or change_type not in ('void_pay', 'unship', 'cancel_rest') then
    raise exception 'Jenis koreksi tidak dikenal.';
  end if;
  if reason_text is null or length(reason_text) not between 1 and 500 then
    raise exception 'Alasan koreksi wajib diisi, maksimal 500 karakter.';
  end if;
  select * into o from public.pentol_orders where id = target for update;
  if not found or o.cancelled then raise exception 'Pesanan aktif tidak ditemukan.'; end if;
  if o.revision is distinct from expected_revision then raise exception 'Pesanan sudah berubah. Muat ulang daftar.'; end if;
  label_text := o.customer || ' · ' || coalesce(o.excel_invoice_no, lpad(o.invoice_no::text, 5, '0'));

  if change_type = 'void_pay' then
    select p.amount into amount from public.pentol_payments p
      where p.id = (payload->>'payment_id')::uuid and p.order_id = target;
    if not found then raise exception 'Pembayaran tidak ditemukan.'; end if;
    select coalesce(sum(p.amount), 0) into paid_total from public.pentol_payments p where p.order_id = target;
    before_data := jsonb_build_object('dibayar', paid_total, 'pembayaran_dibatalkan', amount);
    delete from public.pentol_payments where id = (payload->>'payment_id')::uuid;
    after_data := jsonb_build_object('dibayar', paid_total - amount);

  elsif change_type = 'unship' then
    qty := (payload->>'quantity')::integer;
    select * into item from public.pentol_order_items
      where order_id = target and stock_id = (payload->>'stock_id')::uuid for update;
    if not found then raise exception 'Item pesanan tidak ditemukan.'; end if;
    if qty is null or qty < 1 or qty > item.shipped then
      raise exception 'Jumlah koreksi antar harus 1–% pack.', item.shipped;
    end if;
    perform 1 from public.pentol_batch_stock where id = item.stock_id for update;
    before_data := jsonb_build_object('pack_diantar', item.shipped);
    -- Item dulu, lalu stok, agar pemeriksaan stok terhubung tetap konsisten.
    update public.pentol_order_items set shipped = shipped - qty where order_id = target and stock_id = item.stock_id;
    update public.pentol_batch_stock set delivered = delivered - qty, reserved = reserved + qty, revision = revision + 1
      where id = item.stock_id;
    update public.pentol_orders set delivered = false where id = target;
    after_data := jsonb_build_object('pack_diantar', item.shipped - qty);

  else -- cancel_rest
    if not exists (select 1 from public.pentol_order_items where order_id = target and shipped > 0) then
      raise exception 'Belum ada yang diantar. Batalkan pembayaran lalu batalkan seluruh pesanan.';
    end if;
    if not exists (select 1 from public.pentol_order_items where order_id = target and shipped < quantity) then
      raise exception 'Tidak ada sisa pesanan yang belum diantar.';
    end if;
    select jsonb_agg(jsonb_build_object('stock_id', stock_id, 'pesan', quantity, 'diantar', shipped) order by stock_id)
      into before_data from public.pentol_order_items where order_id = target;
    perform 1 from public.pentol_batch_stock s where s.id in (select stock_id from public.pentol_order_items where order_id = target)
      order by s.id for update;
    for item in select * from public.pentol_order_items where order_id = target and shipped < quantity order by stock_id loop
      if item.shipped = 0 and not exists (select 1 from public.pentol_shipments where order_id = target and stock_id = item.stock_id) then
        delete from public.pentol_order_items where order_id = target and stock_id = item.stock_id;
      elsif item.shipped = 0 then
        raise exception 'Item % pernah diantar lalu dikoreksi ke 0; koreksi antar dulu sebelum membatalkan sisa.', item.stock_id;
      else
        update public.pentol_order_items set quantity = shipped where order_id = target and stock_id = item.stock_id;
      end if;
      update public.pentol_batch_stock set reserved = reserved - (item.quantity - item.shipped), revision = revision + 1
        where id = item.stock_id;
    end loop;
    update public.pentol_orders set delivered = true where id = target;
    select jsonb_agg(jsonb_build_object('stock_id', stock_id, 'pesan', quantity, 'diantar', shipped) order by stock_id)
      into after_data from public.pentol_order_items where order_id = target;
  end if;

  -- Status lunas mengikuti total baru dan pembayaran yang tersisa.
  select coalesce(sum(i.quantity::bigint * i.unit_price), 0) + o.shipping_charge into order_total
    from public.pentol_order_items i where i.order_id = target;
  select coalesce(sum(p.amount), 0) into paid_total from public.pentol_payments p where p.order_id = target;
  update public.pentol_orders set paid = paid_total > 0 and paid_total >= order_total, revision = revision + 1 where id = target;

  insert into public.pentol_reconciliation_history (changed_by, action, target_id, label, reason, before_value, after_value)
  values (auth.uid(), change_type, target, label_text, reason_text, before_data, after_data);
end $$;
revoke all on function public.pentol_correct_order(text, uuid, integer, jsonb, text) from public, anon, authenticated;
grant execute on function public.pentol_correct_order(text, uuid, integer, jsonb, text) to authenticated;

-- ===== 3. Stok opname =====
-- counts: [{stock_id, expected_revision, physical}] — physical = pack yang ada di freezer (diterima − diantar).
create or replace function public.pentol_stock_opname(counts jsonb, change_reason text)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  entry record;
  row_now public.pentol_batch_stock%rowtype;
  changed integer := 0;
begin
  perform public.pentol_assert_admin();
  if jsonb_typeof(counts) is distinct from 'array' or jsonb_array_length(counts) not between 1 and 200 then
    raise exception 'Isi hitungan untuk 1–200 baris stok.';
  end if;
  for entry in select * from jsonb_to_recordset(counts) as x(stock_id uuid, expected_revision integer, physical integer) order by stock_id loop
    if entry.physical is null or entry.physical < 0 or entry.physical > 1000000 then
      raise exception 'Jumlah fisik tidak valid.';
    end if;
    select * into row_now from public.pentol_batch_stock where id = entry.stock_id;
    if not found then raise exception 'Baris stok tidak ditemukan.'; end if;
    if row_now.received - row_now.delivered = entry.physical then continue; end if;
    perform public.pentol_correct_received(entry.stock_id, entry.expected_revision, row_now.delivered + entry.physical,
      coalesce(row_now.received_on, (now() at time zone 'Asia/Jakarta')::date), change_reason);
    changed := changed + 1;
  end loop;
  return changed;
end $$;
revoke all on function public.pentol_stock_opname(jsonb, text) from public, anon, authenticated;
grant execute on function public.pentol_stock_opname(jsonb, text) to authenticated;

notify pgrst, 'reload schema';
commit;

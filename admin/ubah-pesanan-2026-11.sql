-- Ubah pesanan yang sudah dibayar atau sebagian diantar (lihat docs/EVALUASI-FITUR-2026-11.md, "Ubah pesanan").
-- Aman dijalankan ulang. Jalankan SETELAH operasional-2026-11.sql.
--
-- pentol_edit_order: tambah, kurangi, ganti varian, ubah harga/ongkir/jadwal pada pesanan aktif.
-- Aturan:
--   * varian yang sudah diantar tidak boleh dihapus atau dikurangi di bawah jumlah yang sudah diantar;
--   * total baru tidak boleh lebih kecil dari pembayaran yang sudah tercatat (batalkan pembayaran dulu lewat Koreksi);
--   * status lunas dan selesai antar dihitung ulang; setiap perubahan tercatat di Riwayat Perubahan.
begin;

alter table public.pentol_reconciliation_history drop constraint if exists pentol_reconciliation_history_action_check;
alter table public.pentol_reconciliation_history add constraint pentol_reconciliation_history_action_check
  check (action in ('stock', 'ship', 'pay', 'void_pay', 'unship', 'cancel_rest', 'edit'));

create or replace function public.pentol_edit_order(
  target uuid, expected_revision integer, payload jsonb, change_reason text
) returns void language plpgsql security definer set search_path = '' as $$
declare
  o public.pentol_orders%rowtype;
  old_item record;
  new_item record;
  new_items jsonb := payload->'items';
  reason_text text := coalesce(nullif(trim(change_reason), ''), 'Pesanan diubah');
  paid_total bigint;
  new_total bigint;
  legacy_total bigint;
  before_data jsonb;
  after_data jsonb;
begin
  perform public.pentol_assert_admin();
  if length(reason_text) > 500 then raise exception 'Alasan maksimal 500 karakter.'; end if;
  select * into o from public.pentol_orders where id = target for update;
  if not found or o.cancelled then raise exception 'Pesanan aktif tidak ditemukan.'; end if;
  if o.revision is distinct from expected_revision then raise exception 'Pesanan sudah berubah. Muat ulang daftar.'; end if;

  if jsonb_typeof(new_items) is distinct from 'array' or jsonb_array_length(new_items) not between 1 and 30 then
    raise exception 'Isi 1–30 item.';
  end if;
  if exists(select 1 from jsonb_to_recordset(new_items) as x(stock_id uuid, quantity integer, unit_price integer)
    where stock_id is null or quantity is null or quantity not between 1 and 1000000
       or unit_price is null or unit_price not between 0 and 10000000) then
    raise exception 'Periksa varian, jumlah dan harga.';
  end if;
  if (select count(distinct stock_id) from jsonb_to_recordset(new_items) as x(stock_id uuid)) <> jsonb_array_length(new_items) then
    raise exception 'Gabungkan varian yang sama pada batch yang sama.';
  end if;
  if exists(select 1 from jsonb_to_recordset(new_items) as x(stock_id uuid)
    where not exists(select 1 from public.pentol_batch_stock s where s.id = x.stock_id)) then
    raise exception 'Varian batch tidak ditemukan.';
  end if;

  -- Varian yang sudah diantar tetap ada dengan jumlah minimal sebanyak yang diantar.
  for old_item in
    select i.*, p.name from public.pentol_order_items i
      join public.pentol_batch_stock s on s.id = i.stock_id
      left join public.pentol_products p on p.sku = s.sku
    where i.order_id = target and i.shipped > 0
  loop
    if coalesce((select x.quantity from jsonb_to_recordset(new_items) as x(stock_id uuid, quantity integer)
                 where x.stock_id = old_item.stock_id), 0) < old_item.shipped then
      raise exception '% sudah diantar % pack, jumlahnya tidak bisa kurang dari itu.', coalesce(old_item.name, 'Varian'), old_item.shipped;
    end if;
  end loop;

  select coalesce(sum(i.quantity::bigint * i.unit_price), 0) + o.shipping_charge into legacy_total
    from public.pentol_order_items i where i.order_id = target;
  select coalesce(sum(p.amount), 0) into paid_total from public.pentol_payments p where p.order_id = target;
  select coalesce(sum(x.quantity::bigint * x.unit_price), 0) + coalesce((payload->>'shipping_charge')::integer, 0) into new_total
    from jsonb_to_recordset(new_items) as x(quantity integer, unit_price integer);
  if paid_total > new_total then
    raise exception 'Total baru Rp% lebih kecil dari yang sudah dibayar Rp%. Batalkan pembayaran dulu lewat Koreksi.', new_total, paid_total;
  end if;
  -- Lunas lama tanpa catatan pembayaran: totalnya tidak boleh naik (tidak ada nominal untuk menghitung sisa).
  if o.paid and paid_total = 0 and new_total > legacy_total then
    raise exception 'Pesanan ini ditandai lunas tanpa catatan pembayaran. Untuk tambahan, buat pesanan baru.';
  end if;

  select jsonb_build_object('items', coalesce(jsonb_agg(jsonb_build_object('stock_id', stock_id, 'pesan', quantity, 'diantar', shipped, 'harga', unit_price) order by stock_id), '[]'), 'total', legacy_total)
    into before_data from public.pentol_order_items where order_id = target;

  -- Kunci semua baris stok yang terlibat, urut id.
  perform s.id from public.pentol_batch_stock s where s.id in (
    select stock_id from public.pentol_order_items where order_id = target
    union select stock_id from jsonb_to_recordset(new_items) as x(stock_id uuid)
  ) order by s.id for update;

  -- Varian yang dihapus (pasti belum diantar): lepas booking.
  for old_item in select * from public.pentol_order_items i where i.order_id = target
    and not exists(select 1 from jsonb_to_recordset(new_items) as x(stock_id uuid) where x.stock_id = i.stock_id)
  loop
    if exists(select 1 from public.pentol_shipments where order_id = target and stock_id = old_item.stock_id) then
      raise exception 'Varian ini pernah diantar lalu dikoreksi; kurangi jumlahnya saja, jangan dihapus.';
    end if;
    delete from public.pentol_order_items where order_id = target and stock_id = old_item.stock_id;
    update public.pentol_batch_stock set reserved = reserved - (old_item.quantity - old_item.shipped), revision = revision + 1
      where id = old_item.stock_id;
  end loop;

  -- Varian yang tetap ada: ubah jumlah & harga di tempat (jumlah antar tidak berubah). Varian baru: tambah.
  for new_item in select * from jsonb_to_recordset(new_items) as x(stock_id uuid, quantity integer, unit_price integer) order by stock_id loop
    select * into old_item from public.pentol_order_items where order_id = target and stock_id = new_item.stock_id;
    if found then
      update public.pentol_order_items set quantity = new_item.quantity, unit_price = new_item.unit_price
        where order_id = target and stock_id = new_item.stock_id;
      update public.pentol_batch_stock set reserved = reserved + (new_item.quantity - old_item.quantity), revision = revision + 1
        where id = new_item.stock_id;
    else
      insert into public.pentol_order_items(order_id, stock_id, quantity, unit_price)
        values (target, new_item.stock_id, new_item.quantity, new_item.unit_price);
      update public.pentol_batch_stock set reserved = reserved + new_item.quantity, revision = revision + 1
        where id = new_item.stock_id;
    end if;
  end loop;

  update public.pentol_orders set
    order_date = coalesce((payload->>'date')::date, order_date),
    customer = coalesce(nullif(trim(payload->>'customer'), ''), customer),
    delivery_on = (payload->>'delivery_on')::date,
    shipping_charge = coalesce((payload->>'shipping_charge')::integer, 0),
    shipping_cost = coalesce((payload->>'shipping_cost')::integer, 0),
    contact = coalesce(payload->>'contact', ''),
    delivery_location = coalesce(payload->>'delivery_location', ''),
    delivery_note = coalesce(payload->>'delivery_note', ''),
    delivered = not exists(select 1 from public.pentol_order_items where order_id = target and shipped < quantity),
    paid = case when paid_total > 0 then paid_total >= new_total else paid end,
    revision = revision + 1
  where id = target;

  select jsonb_build_object('items', jsonb_agg(jsonb_build_object('stock_id', stock_id, 'pesan', quantity, 'diantar', shipped, 'harga', unit_price) order by stock_id), 'total', new_total)
    into after_data from public.pentol_order_items where order_id = target;
  insert into public.pentol_reconciliation_history (changed_by, action, target_id, label, reason, before_value, after_value)
  values (auth.uid(), 'edit', target, o.customer || ' · ' || coalesce(o.excel_invoice_no, lpad(o.invoice_no::text, 5, '0')),
          reason_text, before_data, after_data);
end $$;
revoke all on function public.pentol_edit_order(uuid, integer, jsonb, text) from public, anon, authenticated;
grant execute on function public.pentol_edit_order(uuid, integer, jsonb, text) to authenticated;

notify pgrst, 'reload schema';
commit;

-- Tanggal antar yang bisa diatur (lihat docs/EVALUASI-FITUR-2026-11.md, "Tanggal antar").
-- Aman dijalankan ulang. Jalankan SETELAH operasional-2026-11.sql.
--
-- pentol_ship_order: sama dengan aksi 'ship' pada pentol_order_action, tetapi antar dicatat pada tanggal tertentu
-- (untuk pencatatan terlambat). Tanggal tidak boleh di masa depan dan tidak boleh sebelum tanggal pesanan.
-- Laporan (menurut tanggal antar) dan catatan pengiriman memakai tanggal itu; stok tidak terpengaruh.
begin;

create or replace function public.pentol_log_shipment() returns trigger
language plpgsql security definer set search_path = '' as $$
declare day date;
begin
  if new.shipped is distinct from old.shipped then
    day := coalesce(nullif(current_setting('pentol.ship_date', true), '')::date, (now() at time zone 'Asia/Jakarta')::date);
    insert into public.pentol_shipments (order_id, stock_id, quantity, unit_price, shipped_on)
    values (new.order_id, new.stock_id, new.shipped - old.shipped, new.unit_price, day);
  end if;
  return new;
end $$;
revoke all on function public.pentol_log_shipment() from public, anon, authenticated;

create or replace function public.pentol_ship_order(target uuid, expected_revision integer, payload jsonb, ship_date date)
returns void language plpgsql security definer set search_path = '' as $$
declare o public.pentol_orders%rowtype;
begin
  perform public.pentol_assert_admin();
  select * into o from public.pentol_orders where id = target;
  if not found or o.cancelled then raise exception 'Pesanan aktif tidak ditemukan.'; end if;
  if ship_date is null or ship_date > (now() at time zone 'Asia/Jakarta')::date then
    raise exception 'Tanggal antar tidak boleh di masa depan.';
  end if;
  if ship_date < o.order_date then
    raise exception 'Tanggal antar tidak boleh sebelum tanggal pesanan (%).', o.order_date;
  end if;
  perform set_config('pentol.ship_date', ship_date::text, true);
  perform public.pentol_order_action('ship', target, expected_revision, payload);
  perform set_config('pentol.ship_date', '', true);
  -- Waktu selesai antar mengikuti tanggal itu (siang WIB), bukan waktu pencatatan.
  update public.pentol_orders set delivered_at = ((ship_date::text || ' 12:00')::timestamp at time zone 'Asia/Jakarta')
    where id = target;
end $$;
revoke all on function public.pentol_ship_order(uuid, integer, jsonb, date) from public, anon, authenticated;
grant execute on function public.pentol_ship_order(uuid, integer, jsonb, date) to authenticated;

notify pgrst, 'reload schema';
commit;

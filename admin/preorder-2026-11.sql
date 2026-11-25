-- Pre-order di katalog pembeli (25 Nov 2026). Aman dijalankan ulang.
-- Jalankan SETELAH security-2026-11.sql dan receipts-2026-11.sql.
--
-- Varian yang stok bebasnya habis tetapi masih ada barang dalam PO yang belum
-- diterima bisa dipesan pembeli sebagai pre-order, paling banyak sebanyak sisa
-- PO yang belum dibooking. Varian tanpa PO tetap "Stok habis".
begin;

-- Ruang pre-order per varian: sisa PO yang belum diterima dikurangi booking yang
-- sudah melebihi stok fisik (pesanan "Tunggu stok" dari admin), plus tanggal tiba
-- PO paling awal. Hanya varian yang masih punya ruang yang muncul.
-- Sisa PO dihitung sama seperti "+N dalam PO" di admin (jumlah PO - diterima).
create or replace function public.pentol_preorder_stock() returns table(sku text, room bigint, eta date)
language sql stable set search_path='' as $$
  with b as (
    select s.sku,
      greatest(coalesce(pi.quantity,0) - greatest(s.received, r.total), 0) as incoming,
      case when pi.quantity > greatest(s.received, r.total) then p.expected_on end as expected_on,
      s.received - s.reserved - s.delivered as net,
      greatest(s.received - s.reserved - s.delivered, 0) as free
    from public.pentol_batch_stock s
    left join public.pentol_purchase_items pi on pi.batch_code = s.batch_code and pi.sku = s.sku
    left join public.pentol_purchases p on p.batch_code = s.batch_code
    -- Total yang pernah diterima lewat Terima barang. Koreksi/opname yang menurunkan
    -- "diterima" (barang rusak, selisih hitung) tidak membuat PO terlihat belum datang lagi.
    cross join lateral (
      select coalesce(sum((i->>'quantity')::integer),0) as total
      from public.pentol_purchase_receipts pr, jsonb_array_elements(pr.items) i
      where pr.batch_code = s.batch_code and i->>'sku' = s.sku
    ) r
  )
  select sku, room, eta from (
    select sku,
      -- Total yang bisa dijanjikan (stok + PO - booking) dikurangi stok bebas yang sudah dijual biasa.
      (greatest(sum(net + incoming), 0) - sum(free))::bigint as room,
      min(expected_on) as eta,
      sum(incoming) as incoming
    from b group by sku
  ) t where incoming > 0 and room > 0
$$;
revoke all on function public.pentol_preorder_stock() from public,anon,authenticated;

-- Katalog v3: seperti v2, ditambah pre-order.
--   available: 1 bila stok bebas ada atau pre-order terbuka.
--   max_qty:   batas jumlah bila total (stok bebas + ruang pre-order) tinggal 1–9 pack.
--   preorder:  true bila stok bebas habis dan pesanan akan dikirim setelah PO datang.
--   eta:       perkiraan tiba PO paling awal (null bila tanggal belum diisi).
create or replace function public.pentol_catalog_v3()
returns table(sku text, price integer, available bigint, max_qty integer, preorder boolean, eta date)
language sql stable security definer set search_path='' as $$
  select p.sku, p.price,
    case when coalesce(f.free,0) + coalesce(o.room,0) > 0 then 1::bigint else 0::bigint end,
    case when coalesce(f.free,0) + coalesce(o.room,0) between 1 and 9 then (coalesce(f.free,0) + coalesce(o.room,0))::integer end,
    coalesce(f.free,0) = 0 and coalesce(o.room,0) > 0,
    case when coalesce(f.free,0) = 0 then o.eta end
  from public.pentol_products p
  left join public.pentol_free_stock() f on f.sku = p.sku
  left join public.pentol_preorder_stock() o on o.sku = p.sku
$$;
revoke all on function public.pentol_catalog_v3() from public,anon,authenticated;
grant execute on function public.pentol_catalog_v3() to anon,authenticated;

-- Checkout publik: sama seperti security-2026-11.sql, tetapi batas jumlah kini
-- stok bebas + ruang pre-order.
create or replace function public.pentol_submit_checkout(request_id uuid,customer_name text,contact text,area_name text,customer_note text,cart jsonb)
returns void language plpgsql security definer set search_path='' as $$
declare bad record;
begin
  if request_id is null or length(trim(coalesce(customer_name,''))) not between 1 and 120
     or coalesce(contact,'') !~ '^[+0-9 ()-]{8,24}$'
     or length(coalesce(area_name,''))>200 or length(coalesce(customer_note,''))>500
     or jsonb_typeof(cart) is distinct from 'array' or jsonb_array_length(cart) not between 1 and 9 then
    raise exception 'Data pesanan tidak valid.';
  end if;
  if exists(select 1 from jsonb_to_recordset(cart) as x(sku text,quantity integer)
    left join public.pentol_products p using(sku)
    where p.sku is null or quantity is null or quantity not between 1 and 100) then
    raise exception 'Varian atau jumlah tidak valid.';
  end if;
  if (select count(distinct sku) from jsonb_to_recordset(cart) as x(sku text))<>jsonb_array_length(cart) then
    raise exception 'Varian ganda.';
  end if;
  contact:=regexp_replace(contact,'[^0-9]','','g');
  if length(contact) not between 8 and 16 then raise exception 'Nomor WhatsApp tidak valid.'; end if;
  perform pg_advisory_xact_lock(hashtextextended('pentol_submit_checkout', 0));
  if exists(select 1 from public.pentol_inbox where id=request_id) then return; end if;
  -- Jumlah tidak boleh melebihi stok bebas + ruang pre-order dari PO yang ditunggu.
  select x.sku, x.quantity, p.name, coalesce(f.free,0) + coalesce(o.room,0) as free into bad
  from jsonb_to_recordset(cart) as x(sku text,quantity integer)
  join public.pentol_products p using(sku)
  left join public.pentol_free_stock() f on f.sku=x.sku
  left join public.pentol_preorder_stock() o on o.sku=x.sku
  where x.quantity>coalesce(f.free,0) + coalesce(o.room,0) order by x.sku limit 1;
  if found then
    raise exception 'Stok % tersisa % pack.', bad.name, bad.free using errcode='P0001', hint='stock';
  end if;
  if (select count(*) from public.pentol_inbox where phone=contact and created_at>now()-interval '1 hour')>=8 then
    raise exception 'Terlalu banyak permintaan. Hubungi toko lewat WhatsApp.';
  end if;
  if (select count(*) from public.pentol_inbox where created_at>now()-interval '1 hour')>=40
     or (select count(*) from public.pentol_inbox where status='pending')>=150 then
    raise exception 'Antrean pesanan sedang penuh. Hubungi toko lewat WhatsApp.';
  end if;
  insert into public.pentol_inbox(id,customer,phone,area,note,items)
  values(request_id,trim(customer_name),contact,coalesce(area_name,''),coalesce(customer_note,''),cart)
  on conflict(id) do nothing;
end $$;
revoke all on function public.pentol_submit_checkout(uuid,text,text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.pentol_submit_checkout(uuid,text,text,text,text,jsonb) to anon,authenticated;

notify pgrst,'reload schema';
commit;

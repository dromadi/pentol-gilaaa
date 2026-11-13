-- Migrasi keamanan November 2026 (lihat docs/AUDIT-2026-11.md).
-- Aman dijalankan ulang: setiap perintah idempotent.
-- Jalankan SETELAH schema.sql, orders.sql, dan operations.sql.
begin;

-- 1. Cabut fungsi lama. Admin panel sudah memakai pentol_order_action.
--    pentol_update_order(mark_paid) menandai "Lunas" tanpa baris pembayaran,
--    pentol_create_order melewati validasi harga/kontak/varian ganda.
do $$
begin
  if to_regprocedure('public.pentol_create_order(uuid,date,text,boolean,jsonb)') is not null then
    revoke all on function public.pentol_create_order(uuid,date,text,boolean,jsonb) from public, anon, authenticated;
  end if;
  if to_regprocedure('public.pentol_update_order(uuid,boolean,boolean)') is not null then
    revoke all on function public.pentol_update_order(uuid,boolean,boolean) from public, anon, authenticated;
  end if;
end $$;

-- 2a. Stok bebas per varian, dipakai katalog dan checkout.
create or replace function public.pentol_free_stock() returns table(sku text, free bigint)
language sql stable set search_path='' as $$
  select s.sku, sum(greatest(s.received-s.reserved-s.delivered,0))::bigint
  from public.pentol_batch_stock s group by s.sku
$$;
revoke all on function public.pentol_free_stock() from public,anon,authenticated;

-- 2b. Katalog v2: seperti pentol_catalog, ditambah max_qty saat stok tinggal
--     1–9 pack (null = stok cukup; jumlah pasti tidak dibuka ke publik).
--     pentol_catalog lama tetap ada agar halaman lama tetap jalan.
create or replace function public.pentol_catalog_v2() returns table(sku text,price integer,available bigint,max_qty integer)
language sql stable security definer set search_path='' as $$
  select p.sku, p.price,
    case when coalesce(f.free,0)>0 then 1::bigint else 0::bigint end,
    case when coalesce(f.free,0) between 1 and 9 then f.free::integer end
  from public.pentol_products p left join public.pentol_free_stock() f on f.sku=p.sku
$$;
revoke all on function public.pentol_catalog_v2() from public,anon,authenticated;
grant execute on function public.pentol_catalog_v2() to anon,authenticated;

-- 2c. Checkout publik: tolak jumlah di atas stok bebas, dan batas global agar inbox tidak bisa dibanjiri
--    dengan nomor WhatsApp acak. Pembeli yang terkena batas tetap bisa
--    mengirim pesanan lewat tombol WhatsApp (index.html menangani kegagalan).
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
  -- Satu kunci bersama untuk semua checkout: pengecekan batas dan penyimpanan
  -- berjalan bergantian, sehingga permintaan bersamaan tidak bisa melewati batas.
  perform pg_advisory_xact_lock(hashtextextended('pentol_submit_checkout', 0));
  -- Retry dengan request_id yang sama selalu sukses, juga saat antrean penuh,
  -- dan dicek setelah kunci didapat agar retry bersamaan tetap satu entri.
  if exists(select 1 from public.pentol_inbox where id=request_id) then return; end if;
  -- Jumlah tidak boleh melebihi stok bebas (diterima - terpesan - diantar).
  select x.sku, x.quantity, p.name, coalesce(f.free,0) as free into bad
  from jsonb_to_recordset(cart) as x(sku text,quantity integer)
  join public.pentol_products p using(sku)
  left join public.pentol_free_stock() f on f.sku=x.sku
  where x.quantity>coalesce(f.free,0) order by x.sku limit 1;
  if found then
    raise exception 'Stok % tersisa % pack.', bad.name, bad.free using errcode='P0001', hint='stock';
  end if;
  -- Batas per nomor: 8 per jam.
  if (select count(*) from public.pentol_inbox where phone=contact and created_at>now()-interval '1 hour')>=8 then
    raise exception 'Terlalu banyak permintaan. Hubungi toko lewat WhatsApp.';
  end if;
  -- Batas global: 40 permintaan baru per jam dan 150 permintaan menunggu.
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

create index if not exists pentol_inbox_by_created on public.pentol_inbox(created_at);

notify pgrst,'reload schema';
commit;

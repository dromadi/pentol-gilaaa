-- Migrasi keamanan November 2026 (lihat docs/AUDIT.md).
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

-- 2. Checkout publik: tambah batas global agar inbox tidak bisa dibanjiri
--    dengan nomor WhatsApp acak. Pembeli yang terkena batas tetap bisa
--    mengirim pesanan lewat tombol WhatsApp (index.html menangani kegagalan).
create or replace function public.pentol_submit_checkout(request_id uuid,customer_name text,contact text,area_name text,customer_note text,cart jsonb)
returns void language plpgsql security definer set search_path='' as $$
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
  -- Permintaan ulang dengan request_id yang sama selalu boleh (idempotent).
  if exists(select 1 from public.pentol_inbox where id=request_id) then return; end if;
  perform pg_advisory_xact_lock(hashtextextended(contact, 0));
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

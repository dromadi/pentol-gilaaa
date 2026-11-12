begin;

alter table public.pentol_orders add column cancelled boolean not null default false,
  add column revision integer not null default 1,
  add column delivery_on date, add column delivered_at timestamptz,
  add column invoice_no bigint generated always as identity unique,
  add column shipping_charge integer not null default 0 check (shipping_charge between 0 and 10000000),
  add column shipping_cost integer not null default 0 check (shipping_cost between 0 and 10000000);
alter table public.pentol_orders
  add column if not exists contact text not null default '' check (length(contact)<=24),
  add column if not exists delivery_location text not null default '' check (length(delivery_location)<=200),
  add column if not exists delivery_note text not null default '' check (length(delivery_note)<=500);

alter table public.pentol_order_items add column shipped integer not null default 0
  check (shipped between 0 and quantity);
update public.pentol_order_items i set shipped=i.quantity
from public.pentol_orders o where o.id=i.order_id and o.delivered;

create table public.pentol_payments (
  id uuid primary key,
  order_id uuid not null references public.pentol_orders,
  paid_on date not null,
  amount bigint not null check (amount > 0)
);
create index on public.pentol_payments(order_id);

create table public.pentol_products (
  sku text primary key,
  name text not null,
  price integer not null check (price between 0 and 10000000)
);
insert into public.pentol_products values
 ('UR','Pentol Urat',36000),('PK','Pentol Kecil',39000),('TP','Tahu Pentol',29000),
 ('JM','Pentol Jamur',36000),('MZ','Pentol Mozzarella',36000),('RJ','Pentol Ranjau',36000),
 ('TD','Tahu Pedas',35000),('PG','Pentol Goreng',41000),('SG','Sambal Gila Tambahan',15000);

create table public.pentol_purchases (
  batch_code text primary key check (char_length(trim(batch_code)) between 1 and 40),
  supplier text not null check (char_length(trim(supplier)) between 1 and 120),
  reference text not null default '' check (length(reference)<=80),
  ordered_on date, expected_on date,
  shipping integer not null check (shipping between 0 and 100000000),
  packaging integer not null check (packaging between 0 and 100000000),
  other_cost integer not null check (other_cost between 0 and 100000000)
);
create table public.pentol_purchase_items (
  batch_code text references public.pentol_purchases,
  sku text references public.pentol_products,
  quantity integer not null check (quantity between 1 and 1000000),
  unit_cost integer not null check (unit_cost between 0 and 10000000),
  primary key (batch_code, sku)
);

create table public.pentol_inbox (
  id uuid primary key,
  created_at timestamptz not null default now(),
  customer text not null,
  phone text not null,
  area text not null,
  note text not null,
  items jsonb not null,
  status text not null default 'pending' check (status in ('pending','converted','dismissed'))
);
create index on public.pentol_inbox(phone,created_at);
create index on public.pentol_inbox(status,created_at);

do $$
declare tab text;
begin
  foreach tab in array array['pentol_payments','pentol_products','pentol_purchases','pentol_purchase_items','pentol_inbox']
  loop
    execute format('alter table public.%I enable row level security',tab);
    execute format('revoke all on public.%I from anon, authenticated',tab);
    execute format('grant select on public.%I to authenticated',tab);
    execute format('create policy admin_read on public.%I for select to authenticated using (exists (select 1 from public.pentol_admins where user_id=(select auth.uid())))',tab);
  end loop;
end $$;

create function public.pentol_assert_admin() returns void
language plpgsql set search_path='' as $$
begin
  if not exists(select 1 from public.pentol_admins where user_id=(select auth.uid())) then
    raise insufficient_privilege;
  end if;
end $$;
revoke all on function public.pentol_assert_admin() from public,anon,authenticated;

create or replace function public.pentol_check_linked_stock() returns trigger
language plpgsql set search_path='' as $$
declare pending bigint; shipped_count bigint;
begin
  select coalesce(sum(i.quantity-i.shipped) filter(where not o.cancelled),0),coalesce(sum(i.shipped),0)
  into pending,shipped_count
  from public.pentol_order_items i join public.pentol_orders o on o.id=i.order_id where i.stock_id=old.id;
  if new.reserved<pending or new.delivered<shipped_count or
     (pending+shipped_count>0 and (new.sku,new.batch_code)<>(old.sku,old.batch_code)) then
    raise exception 'Stok terhubung ke pesanan.';
  end if;
  return new;
end $$;

create or replace function public.pentol_order_action(action text, target uuid, version integer, payload jsonb)
returns void language plpgsql security definer set search_path='' as $$
declare
  o public.pentol_orders%rowtype;
  item record;
  new_items jsonb;
  balance bigint;
  paid_total bigint;
  order_total bigint;
  amount bigint;
  delta integer;
begin
  perform public.pentol_assert_admin();
  if action='create' then
    insert into public.pentol_orders(id,order_date,customer,paid,delivery_on,shipping_charge,shipping_cost)
    values(target,(payload->>'date')::date,trim(payload->>'customer'),coalesce((payload->>'paid')::boolean,false),
      (payload->>'delivery_on')::date,coalesce((payload->>'shipping_charge')::integer,0),coalesce((payload->>'shipping_cost')::integer,0))
    on conflict (id) do nothing;
    if not found then return; end if;
    if payload->>'inbox_id' is not null then
      update public.pentol_inbox set status='converted' where id=(payload->>'inbox_id')::uuid and status='pending';
      if not found then raise exception 'Pesanan WhatsApp sudah diproses.'; end if;
    end if;
  end if;

  select * into strict o from public.pentol_orders where id=target for update;
  if action<>'create' and (o.cancelled or o.revision is distinct from version) then
    raise exception 'Pesanan sudah berubah. Muat ulang daftar.';
  end if;
  select coalesce(sum(i.quantity::bigint*i.unit_price),0)+o.shipping_charge into order_total
    from public.pentol_order_items i where i.order_id=target;
  select coalesce(sum(p.amount),0) into paid_total from public.pentol_payments p where p.order_id=target;

  if action in ('create','edit','cancel') then
    if action in ('edit','cancel') and (o.paid or paid_total>0 or exists(
      select 1 from public.pentol_order_items where order_id=target and shipped>0)) then
      raise exception 'Ralat atau batal hanya tersedia sebelum pembayaran atau pengantaran.';
    end if;
    new_items := case when action='cancel' then '[]'::jsonb else payload->'items' end;
    if action<>'cancel' and (jsonb_typeof(new_items) is distinct from 'array' or jsonb_array_length(new_items) not between 1 and 30) then
      raise exception 'Isi 1–30 item.';
    end if;
    if exists(select 1 from jsonb_to_recordset(new_items) as x(stock_id uuid,quantity integer,unit_price integer)
      where stock_id is null or quantity is null or quantity not between 1 and 1000000
      or unit_price is null or unit_price not between 0 and 10000000) then
      raise exception 'Periksa varian, jumlah dan harga.';
    end if;
    if (select count(distinct stock_id) from jsonb_to_recordset(new_items) as x(stock_id uuid))<>jsonb_array_length(new_items) then
      raise exception 'Gabungkan varian yang sama pada batch yang sama.';
    end if;
    -- Lock all affected stock rows before replacing reservations.
    perform s.id from public.pentol_batch_stock s where s.id in (
      select stock_id from public.pentol_order_items where order_id=target
      union select stock_id from jsonb_to_recordset(new_items) as x(stock_id uuid)
    ) order by s.id for update;
    for item in select stock_id,quantity from public.pentol_order_items where order_id=target order by stock_id loop
      if action='cancel' then
        update public.pentol_orders set cancelled=true where id=target;
      else
        delete from public.pentol_order_items where order_id=target and stock_id=item.stock_id;
      end if;
      update public.pentol_batch_stock set reserved=reserved-item.quantity,revision=revision+1 where id=item.stock_id;
    end loop;
    if action<>'cancel' then
      update public.pentol_orders set order_date=(payload->>'date')::date,customer=trim(payload->>'customer'),
        delivery_on=(payload->>'delivery_on')::date,shipping_charge=coalesce((payload->>'shipping_charge')::integer,0),
        shipping_cost=coalesce((payload->>'shipping_cost')::integer,0) where id=target;
      for item in select * from jsonb_to_recordset(new_items) as x(stock_id uuid,quantity integer,unit_price integer) order by stock_id loop
        if action='create' and coalesce((payload->>'use_existing_booking')::boolean,false) then
          if not exists(
            select 1 from public.pentol_batch_stock s where s.id=item.stock_id
              and s.reserved >= item.quantity + coalesce((
                select sum(i.quantity-i.shipped) from public.pentol_order_items i
                join public.pentol_orders r on r.id=i.order_id
                where i.stock_id=s.id and not r.cancelled
              ),0)
          ) then raise exception 'Booking lama yang belum terhubung tidak cukup untuk varian ini.'; end if;
          update public.pentol_batch_stock set revision=revision+1 where id=item.stock_id;
        else
          update public.pentol_batch_stock set reserved=reserved+item.quantity,revision=revision+1 where id=item.stock_id;
          if not found then raise exception 'Varian batch tidak ditemukan.'; end if;
        end if;
        insert into public.pentol_order_items(order_id,stock_id,quantity,unit_price) values(target,item.stock_id,item.quantity,item.unit_price);
      end loop;
    end if;
  elsif action='ship' then
    if jsonb_typeof(payload->'items') is distinct from 'array' or jsonb_array_length(payload->'items') not between 1 and 30 then
      raise exception 'Pilih jumlah yang sudah diantar.';
    end if;
    for item in select * from jsonb_to_recordset(payload->'items') as x(stock_id uuid,quantity integer) order by stock_id loop
      delta:=item.quantity;
      if delta is null or delta<1 then raise exception 'Jumlah pengantaran harus positif.'; end if;
      update public.pentol_order_items set shipped=shipped+delta
      where order_id=target and stock_id=item.stock_id and quantity-shipped>=delta;
      if not found then raise exception 'Jumlah antar melampaui sisa pesanan.'; end if;
      update public.pentol_batch_stock set reserved=reserved-delta,delivered=delivered+delta,revision=revision+1
      where id=item.stock_id and reserved>=delta and received-delivered>=delta;
      if not found then raise exception 'Stok fisik belum cukup untuk pengantaran.'; end if;
    end loop;
    update public.pentol_orders set delivered=not exists(
      select 1 from public.pentol_order_items where order_id=target and shipped<quantity
    ),delivered_at=now() where id=target;
  elsif action='pay' then
    if exists(select 1 from public.pentol_payments where id=(payload->>'payment_id')::uuid and order_id=target) then return; end if;
    balance:=order_total-paid_total;
    amount:=(payload->>'amount')::bigint;
    if o.paid or amount is null or amount<1 or amount>balance then raise exception 'Nominal melebihi sisa tagihan atau pesanan sudah lunas.'; end if;
    insert into public.pentol_payments values((payload->>'payment_id')::uuid,target,(payload->>'date')::date,amount);
    update public.pentol_orders set paid=(amount=balance) where id=target;
  elsif action='schedule' then
    update public.pentol_orders set delivery_on=(payload->>'delivery_on')::date where id=target;
  else raise exception 'Aksi tidak dikenali.';
  end if;
  if action in ('create','edit') then
    update public.pentol_orders set contact=coalesce(payload->>'contact',''),
      delivery_location=coalesce(payload->>'delivery_location',''),
      delivery_note=coalesce(payload->>'delivery_note','') where id=target;
  end if;
  update public.pentol_orders set revision=revision+1 where id=target;
end $$;
revoke all on function public.pentol_order_action(text,uuid,integer,jsonb) from public,anon,authenticated;
grant execute on function public.pentol_order_action(text,uuid,integer,jsonb) to authenticated;

create or replace function public.pentol_update_order(order_id uuid,mark_paid boolean,mark_delivered boolean)
returns void language plpgsql security definer set search_path='' as $$
declare o public.pentol_orders%rowtype; parts jsonb;
begin
  perform public.pentol_assert_admin();
  select * into strict o from public.pentol_orders where id=order_id for update;
  if o.cancelled then raise exception 'Pesanan dibatalkan.'; end if;
  if mark_delivered and not o.delivered then
    select jsonb_agg(jsonb_build_object('stock_id',i.stock_id,'quantity',i.quantity-i.shipped)) into parts
      from public.pentol_order_items i where i.order_id=o.id and i.shipped<i.quantity;
    perform public.pentol_order_action('ship',o.id,o.revision,jsonb_build_object('items',parts));
  end if;
  if mark_paid and not o.paid then
    update public.pentol_orders set paid=true,revision=revision+1 where id=o.id;
  end if;
end $$;

create function public.pentol_admin_action(action text,payload jsonb)
returns void language plpgsql security definer set search_path='' as $$
declare code text; item record;
begin
  perform public.pentol_assert_admin();
  if action='price' then
    update public.pentol_products set price=(payload->>'price')::integer where sku=payload->>'sku';
    if not found then raise exception 'Varian tidak ditemukan.'; end if;
  elsif action='dismiss' then
    update public.pentol_inbox set status='dismissed' where id=(payload->>'id')::uuid and status='pending';
  elsif action='purchase' then
    code:=upper(trim(payload->>'batch_code'));
    if jsonb_typeof(payload->'items') is distinct from 'array' or jsonb_array_length(payload->'items') not between 1 and 9 then
      raise exception 'Pilih 1–9 varian restok.';
    end if;
    insert into public.pentol_purchases
    values(code,trim(payload->>'supplier'),coalesce(payload->>'reference',''),(payload->>'ordered_on')::date,
      (payload->>'expected_on')::date,(payload->>'shipping')::integer,(payload->>'packaging')::integer,(payload->>'other_cost')::integer)
    on conflict (batch_code) do update set supplier=excluded.supplier,reference=excluded.reference,
      ordered_on=excluded.ordered_on,expected_on=excluded.expected_on,shipping=excluded.shipping,
      packaging=excluded.packaging,other_cost=excluded.other_cost;
    delete from public.pentol_purchase_items where batch_code=code;
    for item in select * from jsonb_to_recordset(payload->'items') as x(sku text,quantity integer,unit_cost integer) order by sku loop
      insert into public.pentol_purchase_items values(code,item.sku,item.quantity,item.unit_cost);
      insert into public.pentol_batch_stock(batch_code,sku) values(code,item.sku) on conflict(batch_code,sku) do nothing;
    end loop;
  else raise exception 'Aksi tidak dikenali.';
  end if;
end $$;
revoke all on function public.pentol_admin_action(text,jsonb) from public,anon,authenticated;
grant execute on function public.pentol_admin_action(text,jsonb) to authenticated;

create function public.pentol_catalog() returns table(sku text,price integer,available bigint)
language sql stable security definer set search_path='' as $$
  select p.sku,p.price,case when coalesce(bool_or(s.received>s.reserved+s.delivered),false) then 1::bigint else 0::bigint end
  from public.pentol_products p left join public.pentol_batch_stock s on s.sku=p.sku
  group by p.sku,p.price
$$;
revoke all on function public.pentol_catalog() from public,anon,authenticated;
grant execute on function public.pentol_catalog() to anon,authenticated;

create function public.pentol_submit_checkout(request_id uuid,customer_name text,contact text,area_name text,customer_note text,cart jsonb)
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
  perform pg_advisory_xact_lock(hashtextextended(contact, 0));
  if (select count(*) from public.pentol_inbox where phone=contact and created_at>now()-interval '1 hour')>=8
    and not exists(select 1 from public.pentol_inbox where id=request_id) then
    raise exception 'Terlalu banyak permintaan. Hubungi toko lewat WhatsApp.';
  end if;
  insert into public.pentol_inbox(id,customer,phone,area,note,items)
  values(request_id,trim(customer_name),contact,coalesce(area_name,''),coalesce(customer_note,''),cart)
  on conflict(id) do nothing;
end $$;
revoke all on function public.pentol_submit_checkout(uuid,text,text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.pentol_submit_checkout(uuid,text,text,text,text,jsonb) to anon,authenticated;

insert into public.pentol_purchases values
 ('BATCH-01','Pentol Gilaaa Surabaya','',date '2026-11-07',null,132000,15000,13770),
 ('BATCH-02','Pentol Gilaaa Surabaya','',null,null,118287,15000,0);
insert into public.pentol_purchase_items values
 ('BATCH-01','UR',7,23200),('BATCH-01','PK',7,26400),('BATCH-01','TP',5,17600),
 ('BATCH-01','JM',6,23200),('BATCH-01','MZ',7,23200),('BATCH-01','RJ',7,23200),
 ('BATCH-01','TD',5,23200),('BATCH-01','PG',2,28000),('BATCH-01','SG',6,8000),
 ('BATCH-02','UR',15,23200),('BATCH-02','PK',15,26400),('BATCH-02','TP',15,17600),
 ('BATCH-02','MZ',5,23200),('BATCH-02','JM',5,23200);

notify pgrst,'reload schema';
commit;

begin;

create table if not exists public.pentol_orders (
  id uuid primary key,
  order_date date not null,
  customer text not null check (char_length(trim(customer)) between 1 and 120),
  paid boolean not null default false,
  delivered boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists pentol_orders_by_date on public.pentol_orders (order_date, created_at, id);

create table if not exists public.pentol_order_items (
  order_id uuid references public.pentol_orders(id) on delete restrict,
  stock_id uuid references public.pentol_batch_stock(id) on delete restrict,
  quantity integer not null check (quantity between 1 and 1000000),
  unit_price integer not null check (unit_price between 0 and 10000000),
  primary key (order_id, stock_id)
);
create index if not exists pentol_order_items_by_stock on public.pentol_order_items (stock_id);

alter table public.pentol_orders enable row level security;
alter table public.pentol_order_items enable row level security;
revoke all on public.pentol_orders, public.pentol_order_items from anon, authenticated;
grant select on public.pentol_orders, public.pentol_order_items to authenticated;
create policy "Store admins read orders" on public.pentol_orders for select to authenticated
  using (exists (select 1 from public.pentol_admins where user_id = (select auth.uid())));
create policy "Store admins read order items" on public.pentol_order_items for select to authenticated
  using (exists (select 1 from public.pentol_admins where user_id = (select auth.uid())));

create or replace function public.pentol_check_linked_stock()
returns trigger language plpgsql set search_path = '' as $$
declare
  pending bigint;
  shipped bigint;
begin
  select coalesce(sum(i.quantity) filter (where not o.delivered), 0),
         coalesce(sum(i.quantity) filter (where o.delivered), 0)
  into pending, shipped
  from public.pentol_order_items i join public.pentol_orders o on o.id = i.order_id
  where i.stock_id = old.id;
  if new.reserved < pending or new.delivered < shipped or
     ((pending + shipped) > 0 and (new.sku, new.batch_code) <> (old.sku, old.batch_code)) then
    raise exception 'Stok terhubung ke pesanan.';
  end if;
  return new;
end;
$$;
revoke all on function public.pentol_check_linked_stock() from public, anon, authenticated;
create or replace trigger pentol_guard_order_stock before update on public.pentol_batch_stock
for each row execute function public.pentol_check_linked_stock();

create or replace function public.pentol_create_order(
  order_id uuid, order_day date, customer_name text, is_paid boolean, items jsonb
) returns void language plpgsql security definer set search_path = '' as $$
declare
  item record;
begin
  if not exists (select 1 from public.pentol_admins where user_id = (select auth.uid())) then
    raise insufficient_privilege;
  end if;
  if jsonb_typeof(items) is distinct from 'array' or jsonb_array_length(items) not between 1 and 30 then
    raise exception 'Isi 1–30 item.';
  end if;
  insert into public.pentol_orders (id, order_date, customer, paid)
  values (order_id, order_day, trim(customer_name), is_paid) on conflict (id) do nothing;
  if not found then return; end if;

  for item in
    select * from jsonb_to_recordset(items) as x(stock_id uuid, quantity integer, unit_price integer)
    order by stock_id
  loop
    if item.quantity is null or item.quantity not between 1 and 1000000 then
      raise exception 'Jumlah pack tidak valid.';
    end if;
    update public.pentol_batch_stock
    set reserved = reserved + item.quantity, revision = revision + 1
    where id = item.stock_id;
    if not found then raise exception 'Varian batch tidak ditemukan.'; end if;
    insert into public.pentol_order_items values (order_id, item.stock_id, item.quantity, item.unit_price);
  end loop;
end;
$$;

create or replace function public.pentol_update_order(
  order_id uuid, mark_paid boolean, mark_delivered boolean
) returns void language plpgsql security definer set search_path = '' as $$
declare
  current_order public.pentol_orders%rowtype;
  item record;
begin
  if not exists (select 1 from public.pentol_admins where user_id = (select auth.uid())) then
    raise insufficient_privilege;
  end if;
  select * into strict current_order from public.pentol_orders where id = order_id for update;
  update public.pentol_orders
  set paid = paid or mark_paid, delivered = delivered or mark_delivered
  where id = order_id;
  if mark_delivered and not current_order.delivered then
    for item in
      select i.stock_id, i.quantity from public.pentol_order_items i
      where i.order_id = current_order.id order by i.stock_id
    loop
      update public.pentol_batch_stock
      set reserved = reserved - item.quantity, delivered = delivered + item.quantity, revision = revision + 1
      where id = item.stock_id and reserved >= item.quantity and received - delivered >= item.quantity;
      if not found then raise exception 'Stok fisik belum cukup untuk pengantaran.'; end if;
    end loop;
  end if;
end;
$$;

revoke all on function public.pentol_create_order(uuid,date,text,boolean,jsonb),
  public.pentol_update_order(uuid,boolean,boolean) from public, anon, authenticated;
grant execute on function public.pentol_create_order(uuid,date,text,boolean,jsonb),
  public.pentol_update_order(uuid,boolean,boolean) to authenticated;
notify pgrst, 'reload schema';
commit;

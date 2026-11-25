-- Varian dikelola dari admin (lihat docs/EVALUASI-FITUR-2026-11.md, "Varian & harga").
-- Aman dijalankan ulang. Jalankan SETELAH preorder-2026-11.sql.
--
-- 1. pentol_products dilengkapi: ukuran, kategori, dijual (active), urutan tampil.
-- 2. Daftar kode varian tetap (UR, PK, …) di pentol_batch_stock dihapus; stok tetap wajib merujuk varian yang ada.
-- 3. pentol_save_product: admin menambah/mengubah varian (nama, ukuran, kategori, harga, dijual).
-- 4. pentol_catalog_v4: katalog v3 (stok + pre-order) + data varian, hanya varian yang dijual, urut tampil.
begin;

alter table public.pentol_products add column if not exists size text not null default '';
alter table public.pentol_products add column if not exists category text not null default 'Pentol';
alter table public.pentol_products add column if not exists active boolean not null default true;
alter table public.pentol_products add column if not exists sort_order integer not null default 100;
alter table public.pentol_products drop constraint if exists pentol_products_size_check;
alter table public.pentol_products add constraint pentol_products_size_check check (length(size) <= 40);
alter table public.pentol_products drop constraint if exists pentol_products_category_check;
alter table public.pentol_products add constraint pentol_products_category_check check (category in ('Pentol', 'Tahu', 'Sambal', 'Lainnya'));
alter table public.pentol_products drop constraint if exists pentol_products_sort_check;
alter table public.pentol_products add constraint pentol_products_sort_check check (sort_order between 0 and 999);

-- Data varian lama (hanya bila belum diisi).
update public.pentol_products p set size = v.size, category = v.category, sort_order = v.sort
from (values ('UR','9 pcs / pack','Pentol',10), ('PK','30 pcs / pack','Pentol',20), ('TP','30 pcs / pack','Tahu',30),
             ('JM','9 pcs / pack','Pentol',40), ('MZ','9 pcs / pack','Pentol',50), ('RJ','9 pcs / pack','Pentol',60),
             ('TD','9 pcs / pack','Tahu',70), ('PG','9 pcs / pack','Pentol',80), ('SG','±100 g / pack','Sambal',90))
  as v(sku, size, category, sort)
where p.sku = v.sku and p.size = '';

-- Kode varian tidak lagi dibatasi daftar tetap; cukup harus ada di pentol_products.
do $$
declare c record;
begin
  for c in select conname from pg_constraint
    where conrelid = 'public.pentol_batch_stock'::regclass and contype = 'c' and pg_get_constraintdef(oid) ilike '%sku%'
  loop
    execute format('alter table public.pentol_batch_stock drop constraint %I', c.conname);
  end loop;
  if not exists (select 1 from pg_constraint where contype = 'f'
                 and conrelid = 'public.pentol_batch_stock'::regclass and confrelid = 'public.pentol_products'::regclass) then
    alter table public.pentol_batch_stock add constraint pentol_batch_stock_sku_fkey foreign key (sku) references public.pentol_products(sku);
  end if;
end $$;

create or replace function public.pentol_save_product(payload jsonb) returns text
language plpgsql security definer set search_path = '' as $$
declare
  code text := upper(trim(coalesce(payload->>'sku', '')));
  product_name text := trim(coalesce(payload->>'name', ''));
begin
  perform public.pentol_assert_admin();
  if code !~ '^[A-Z]{2,6}$' then raise exception 'Kode varian 2–6 huruf, misalnya BK.'; end if;
  if length(product_name) not between 1 and 60 then raise exception 'Nama varian wajib diisi, maksimal 60 huruf.'; end if;
  if (payload->>'price') is null or (payload->>'price')::integer not between 0 and 10000000 then raise exception 'Harga tidak valid.'; end if;
  if exists (select 1 from public.pentol_products where lower(name) = lower(product_name) and sku <> code) then
    raise exception 'Nama varian sudah dipakai varian lain.';
  end if;
  insert into public.pentol_products (sku, name, price, size, category, active, sort_order)
  values (code, product_name, (payload->>'price')::integer, left(trim(coalesce(payload->>'size', '')), 40),
          coalesce(nullif(payload->>'category', ''), 'Pentol'), coalesce((payload->>'active')::boolean, true),
          coalesce((payload->>'sort_order')::integer, 100))
  on conflict (sku) do update set name = excluded.name, price = excluded.price, size = excluded.size,
    category = excluded.category, active = excluded.active,
    sort_order = coalesce((payload->>'sort_order')::integer, public.pentol_products.sort_order);
  return code;
end $$;
revoke all on function public.pentol_save_product(jsonb) from public, anon, authenticated;
grant execute on function public.pentol_save_product(jsonb) to authenticated;

create or replace function public.pentol_catalog_v4()
returns table(sku text, name text, size text, category text, price integer, available bigint, max_qty integer, preorder boolean, eta date)
language sql stable security definer set search_path = '' as $$
  select p.sku, p.name, p.size, p.category, c.price, c.available, c.max_qty, c.preorder, c.eta
  from public.pentol_catalog_v3() c join public.pentol_products p using (sku)
  where p.active
  order by p.sort_order, p.sku
$$;
revoke all on function public.pentol_catalog_v4() from public, anon, authenticated;
grant execute on function public.pentol_catalog_v4() to anon, authenticated;

notify pgrst, 'reload schema';
commit;

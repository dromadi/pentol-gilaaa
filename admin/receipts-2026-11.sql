begin;

create table if not exists public.pentol_purchase_receipts (
  id uuid primary key,
  batch_code text not null references public.pentol_purchases(batch_code),
  received_on date not null,
  items jsonb not null,
  created_at timestamptz not null default now(),
  received_by uuid not null
);
alter table public.pentol_purchase_receipts enable row level security;
revoke all on public.pentol_purchase_receipts from public, anon, authenticated;
grant select on public.pentol_purchase_receipts to authenticated;
drop policy if exists "Admins read purchase receipts" on public.pentol_purchase_receipts;
create policy "Admins read purchase receipts" on public.pentol_purchase_receipts
  for select to authenticated
  using (exists (select 1 from public.pentol_admins where user_id = (select auth.uid())));

create or replace function public.pentol_receive_purchase(
  receipt_id uuid, purchase_code text, arrival_date date, receipt_items jsonb
) returns void language plpgsql security definer set search_path='' as $$
declare
  prior public.pentol_purchase_receipts%rowtype;
  item record;
  expected integer;
  normalized_items jsonb;
begin
  perform public.pentol_assert_admin();

  if receipt_id is null or arrival_date is null or arrival_date > (now() at time zone 'Asia/Jakarta')::date then
    raise exception 'Penerimaan memerlukan tanggal aktual yang valid.';
  end if;
  if jsonb_typeof(receipt_items) is distinct from 'array' or jsonb_array_length(receipt_items) not between 1 and 9 then
    raise exception 'Pilih jumlah diterima untuk 1–9 varian.';
  end if;

  if exists (
    select 1 from jsonb_to_recordset(receipt_items) as x(sku text, quantity integer)
    where sku is null or quantity is null or quantity not between 1 and 1000000
  ) or (
    select count(distinct sku) from jsonb_to_recordset(receipt_items) as x(sku text)
  ) <> jsonb_array_length(receipt_items) then
    raise exception 'Jumlah penerimaan tidak valid atau ada varian ganda.';
  end if;
  select jsonb_agg(jsonb_build_object('sku', sku, 'quantity', quantity) order by sku)
    into normalized_items from jsonb_to_recordset(receipt_items) as x(sku text, quantity integer);

  -- Serialize repeat submissions, then lock the PO before reading its quantities.
  perform pg_advisory_xact_lock(hashtextextended('pentol-receipt:' || receipt_id::text, 0));
  select * into prior from public.pentol_purchase_receipts where id = receipt_id;
  if found then
    if (prior.batch_code, prior.received_on, prior.items)
       is distinct from (purchase_code, arrival_date, normalized_items) then
      raise exception 'Penerimaan ini sudah disimpan dengan rincian berbeda. Muat ulang daftar PO.';
    end if;
    return;
  end if;

  perform 1 from public.pentol_purchases where batch_code = purchase_code for update;
  if not found then raise exception 'PO tidak ditemukan.'; end if;

  for item in select * from jsonb_to_recordset(normalized_items) as x(sku text, quantity integer) order by sku loop
    select quantity into expected from public.pentol_purchase_items
      where batch_code = purchase_code and sku = item.sku;
    if not found then raise exception 'Varian tidak ada di PO.'; end if;

    update public.pentol_batch_stock
      set received = received + item.quantity,
          received_on = greatest(received_on, arrival_date),
          revision = revision + 1
      where batch_code = purchase_code and sku = item.sku and received + item.quantity <= expected;
    if not found then
      raise exception 'Jumlah % melampaui sisa PO atau baris stok tidak ditemukan. Muat ulang daftar PO.', item.sku;
    end if;
  end loop;

  insert into public.pentol_purchase_receipts(id,batch_code,received_on,items,received_by)
    values(receipt_id,purchase_code,arrival_date,normalized_items,auth.uid());
end $$;
revoke all on function public.pentol_receive_purchase(uuid,text,date,jsonb) from public,anon,authenticated;
grant execute on function public.pentol_receive_purchase(uuid,text,date,jsonb) to authenticated;
notify pgrst,'reload schema';

commit;

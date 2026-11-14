begin;

alter table public.pentol_orders add column if not exists excel_invoice_no text;
create unique index if not exists pentol_orders_excel_invoice_no_unique
  on public.pentol_orders (excel_invoice_no) where excel_invoice_no is not null;

create or replace function public.pentol_save_excel_invoice(
  order_id uuid, expected_revision integer, invoice_reference text
) returns void language plpgsql security definer set search_path='' as $$
declare
  current_order public.pentol_orders%rowtype;
  normalized text := upper(trim(invoice_reference));
begin
  perform public.pentol_assert_admin();
  if normalized is null or normalized !~ '^PG-[0-9]{8}-[0-9]{3,9}$' then
    raise exception 'Nomor invoice Excel harus berformat PG-YYYYMMDD-NNN.';
  end if;
  select * into current_order from public.pentol_orders where id=order_id for update;
  if not found or current_order.cancelled then
    raise exception 'Pesanan aktif tidak ditemukan.';
  end if;
  if current_order.excel_invoice_no = normalized then return; end if;
  if current_order.excel_invoice_no is not null then
    raise exception 'Nomor invoice sudah tersimpan untuk pesanan ini.';
  end if;
  if current_order.revision is distinct from expected_revision then
    raise exception 'Pesanan sudah berubah. Bandingkan ulang Excel.';
  end if;
  update public.pentol_orders set excel_invoice_no=normalized, revision=revision+1 where id=order_id;
exception when unique_violation then
  raise exception 'Nomor invoice sudah digunakan pada pesanan lain.';
end $$;
revoke all on function public.pentol_save_excel_invoice(uuid,integer,text) from public,anon,authenticated;
grant execute on function public.pentol_save_excel_invoice(uuid,integer,text) to authenticated;
notify pgrst,'reload schema';

commit;

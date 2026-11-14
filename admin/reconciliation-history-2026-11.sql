begin;

create table if not exists public.pentol_reconciliation_history (
  id bigint generated always as identity primary key,
  changed_at timestamptz not null default now(),
  changed_by uuid not null,
  action text not null check (action in ('stock','ship','pay')),
  target_id uuid not null,
  label text not null,
  reason text not null check (length(reason) between 1 and 500),
  before_value jsonb not null,
  after_value jsonb not null
);

alter table public.pentol_reconciliation_history enable row level security;
revoke all on public.pentol_reconciliation_history from public, anon, authenticated;
grant select on public.pentol_reconciliation_history to authenticated;
drop policy if exists "Admins read reconciliation history" on public.pentol_reconciliation_history;
create policy "Admins read reconciliation history" on public.pentol_reconciliation_history
  for select to authenticated
  using (exists (select 1 from public.pentol_admins where user_id = (select auth.uid())));

create or replace function public.pentol_reconcile_with_history(
  change_type text, target uuid, expected_revision integer, payload jsonb, change_reason text
) returns void language plpgsql security definer set search_path='' as $$
declare
  order_row public.pentol_orders%rowtype;
  order_total bigint;
  captured_paid bigint;
  before_data jsonb;
  after_data jsonb;
  description text;
  reason_text text := trim(change_reason);
begin
  perform public.pentol_assert_admin();
  if reason_text is null or length(reason_text) not between 1 and 500 then
    raise exception 'Alasan koreksi wajib diisi, maksimal 500 karakter.';
  end if;

  if change_type = 'stock' then
    -- Booking harus selalu milik pesanan. Selisih booking dari Excel dicatat sebagai pesanan.
    raise exception 'Booking dari Excel dicatat sebagai pesanan, bukan koreksi stok.';
  elsif change_type in ('ship','pay') then
    select * into order_row from public.pentol_orders where id=target for update;
    if not found or order_row.cancelled or order_row.revision is distinct from expected_revision then
      raise exception 'Pesanan berubah. Bandingkan ulang Excel.';
    end if;
    description := order_row.customer || ' · ' || coalesce(to_jsonb(order_row)->>'excel_invoice_no', order_row.invoice_no::text);
    if change_type = 'ship' then
      select jsonb_build_object('antar_selesai',order_row.delivered,'pack_diantar',coalesce(sum(shipped),0))
        into before_data from public.pentol_order_items where order_id=target;
    else
      select coalesce(sum(quantity::bigint*unit_price),0)+order_row.shipping_charge
        into order_total from public.pentol_order_items where order_id=target;
      select coalesce(sum(amount),0) into captured_paid from public.pentol_payments where order_id=target;
      before_data := jsonb_build_object('dibayar',captured_paid,'sisa_tagihan',order_total-captured_paid);
    end if;
    perform public.pentol_order_action(change_type,target,expected_revision,payload);
    select * into order_row from public.pentol_orders where id=target;
    if change_type = 'ship' then
      select jsonb_build_object('antar_selesai',order_row.delivered,'pack_diantar',coalesce(sum(shipped),0))
        into after_data from public.pentol_order_items where order_id=target;
    else
      select coalesce(sum(amount),0) into captured_paid from public.pentol_payments where order_id=target;
      after_data := jsonb_build_object('dibayar',captured_paid,'sisa_tagihan',order_total-captured_paid);
    end if;
  else
    raise exception 'Jenis koreksi tidak dikenal.';
  end if;

  if before_data is distinct from after_data then
    insert into public.pentol_reconciliation_history(changed_by,action,target_id,label,reason,before_value,after_value)
    values(auth.uid(),change_type,target,description,reason_text,before_data,after_data);
  end if;
end $$;

revoke all on function public.pentol_reconcile_with_history(text,uuid,integer,jsonb,text) from public,anon,authenticated;
grant execute on function public.pentol_reconcile_with_history(text,uuid,integer,jsonb,text) to authenticated;
notify pgrst,'reload schema';

commit;

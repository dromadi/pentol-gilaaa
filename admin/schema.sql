begin;

create table public.pentol_admins (
  user_id uuid primary key references auth.users(id) on delete cascade
);
alter table public.pentol_admins enable row level security;
revoke all on public.pentol_admins from anon, authenticated;
grant select on public.pentol_admins to authenticated;
create policy "Admin can verify own membership" on public.pentol_admins
  for select to authenticated using (user_id = (select auth.uid()));

create table public.pentol_batch_stock (
  id uuid primary key default gen_random_uuid(),
  batch_code text not null check (char_length(trim(batch_code)) between 1 and 40),
  sku text not null check (sku in ('UR','PK','TP','JM','MZ','RJ','TD','PG','SG')),
  received_on date,
  received integer not null default 0 check (received between 0 and 1000000),
  reserved integer not null default 0 check (reserved between 0 and 1000000),
  delivered integer not null default 0 check (delivered between 0 and 1000000),
  revision integer not null default 1 check (revision > 0),
  unique (batch_code, sku),
  check (delivered <= received),
  check (received_on is not null or received = 0)
);
alter table public.pentol_batch_stock enable row level security;
revoke all on public.pentol_batch_stock from anon, authenticated;
grant select, insert, update on public.pentol_batch_stock to authenticated;
create policy "Only store admins manage batch stock" on public.pentol_batch_stock
  for all to authenticated
  using (exists (select 1 from public.pentol_admins where user_id = (select auth.uid())))
  with check (exists (select 1 from public.pentol_admins where user_id = (select auth.uid())));

commit;

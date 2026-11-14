-- Skenario aturan database. Setiap pemeriksaan yang salah menghentikan uji (ON_ERROR_STOP).
\set ON_ERROR_STOP on
\set QUIET on
create function pg_temp.expect_error(statement text, pattern text) returns void language plpgsql as $$
begin
  execute statement;
  raise exception 'DIHARAPKAN GAGAL (%): %', pattern, statement;
exception when others then
  if sqlerrm like 'DIHARAPKAN GAGAL%' then raise; end if;
  if sqlerrm !~* pattern then raise exception 'Pesan salah untuk %: % (diharapkan ~ %)', statement, sqlerrm, pattern; end if;
end $$;
grant execute on function pg_temp.expect_error(text,text) to anon, authenticated;

insert into auth.users values ('11111111-1111-1111-1111-111111111111'),('22222222-2222-2222-2222-222222222222');
insert into pentol_admins values ('11111111-1111-1111-1111-111111111111');

\echo '• publik: fungsi lama dicabut, tabel tertutup'
set role anon;
select pg_temp.expect_error($$select public.pentol_create_order(gen_random_uuid(),current_date,'x',false,'[]')$$, 'permission denied');
select pg_temp.expect_error($$select * from public.pentol_orders$$, 'permission denied');
reset role;

\echo '• admin: PO, terima bertahap, batas PO'
set role authenticated;
select set_config('request.uid','11111111-1111-1111-1111-111111111111',false);
select public.pentol_admin_action('purchase','{"batch_code":"B3","supplier":"Pusat","shipping":0,"packaging":0,"other_cost":0,"items":[{"sku":"UR","quantity":10,"unit_cost":23200},{"sku":"JM","quantity":5,"unit_cost":23200}]}');
select public.pentol_receive_purchase('aaaaaaaa-0000-0000-0000-000000000001','B3',current_date,'[{"sku":"UR","quantity":6}]');
select pg_temp.expect_error($$select public.pentol_receive_purchase('aaaaaaaa-0000-0000-0000-000000000002','B3',current_date,'[{"sku":"UR","quantity":5}]')$$, 'melampaui sisa PO');
do $$ begin assert (select received from public.pentol_batch_stock where batch_code='B3' and sku='UR') = 6, 'diterima harus 6'; end $$;

\echo '• integritas stok: tulis langsung ditolak, koreksi wajib alasan'
select pg_temp.expect_error($$update public.pentol_batch_stock set received=50 where batch_code='B3'$$, 'permission denied');
select pg_temp.expect_error($$select public.pentol_correct_received(id,revision,5,current_date,' ') from public.pentol_batch_stock where batch_code='B3' and sku='UR'$$, 'Alasan koreksi');
select pg_temp.expect_error($$select public.pentol_reconcile_with_history('stock',id,revision,'{"reserved":2}','Excel') from public.pentol_batch_stock where batch_code='B3' and sku='UR'$$, 'dicatat sebagai pesanan');

\echo '• pesanan: buat, antar sebagian, bayar, batas bayar, batal dikunci'
select public.pentol_order_action('create','cccccccc-0000-0000-0000-000000000001',null,
  (select jsonb_build_object('date',current_date,'customer','Sari','items',jsonb_build_array(jsonb_build_object('stock_id',id,'quantity',4,'unit_price',36000)))
   from public.pentol_batch_stock where batch_code='B3' and sku='UR'));
select public.pentol_order_action('ship','cccccccc-0000-0000-0000-000000000001',2,
  (select jsonb_build_object('items',jsonb_build_array(jsonb_build_object('stock_id',id,'quantity',2))) from public.pentol_batch_stock where batch_code='B3' and sku='UR'));
select public.pentol_order_action('pay','cccccccc-0000-0000-0000-000000000001',3,'{"payment_id":"dddddddd-0000-0000-0000-000000000001","date":"2026-11-14","amount":50000}');
select pg_temp.expect_error($$select public.pentol_order_action('pay','cccccccc-0000-0000-0000-000000000001',4,'{"payment_id":"dddddddd-0000-0000-0000-000000000002","date":"2026-11-14","amount":999999}')$$, 'Nominal melebihi');
select pg_temp.expect_error($$select public.pentol_order_action('cancel','cccccccc-0000-0000-0000-000000000001',4,'{}')$$, 'sebelum pembayaran');
do $$ begin assert (select (reserved, delivered) from public.pentol_batch_stock where batch_code='B3' and sku='UR') = (2, 2), 'terpesan 2 / diantar 2'; end $$;
select public.pentol_correct_received(id,revision,5,current_date,'1 pack rusak') from public.pentol_batch_stock where batch_code='B3' and sku='UR';
do $$ begin assert (select count(*) from public.pentol_reconciliation_history where reason='1 pack rusak') = 1, 'koreksi tercatat'; end $$;

\echo '• bukan admin ditolak'
select set_config('request.uid','22222222-2222-2222-2222-222222222222',false);
select pg_temp.expect_error($$select public.pentol_order_action('pay','cccccccc-0000-0000-0000-000000000001',4,'{}')$$, 'insufficient_privilege');
reset role;

\echo '• katalog & checkout publik: batas stok, retry, batas global'
set role anon;
do $$ begin assert (select max_qty from public.pentol_catalog_v2() where sku='UR') = 1, 'max_qty UR = 1 (5 diterima - 2 terpesan - 2 diantar)'; end $$;
select pg_temp.expect_error($$select public.pentol_submit_checkout(gen_random_uuid(),'A','081111111111','','','[{"sku":"UR","quantity":2}]')$$, 'tersisa 1 pack');
select public.pentol_submit_checkout('eeeeeeee-0000-0000-0000-000000000001','A','081111111111','','','[{"sku":"UR","quantity":1}]');
select public.pentol_submit_checkout('eeeeeeee-0000-0000-0000-000000000001','A','081111111111','','','[{"sku":"UR","quantity":1}]');
reset role;
do $$ begin assert (select count(*) from public.pentol_inbox) = 1, 'retry tidak menggandakan'; end $$;
insert into public.pentol_inbox(id,customer,phone,area,note,items) select gen_random_uuid(),'P','0899'||g,'','','[]' from generate_series(1,39) g;
set role anon;
select pg_temp.expect_error($$select public.pentol_submit_checkout(gen_random_uuid(),'Z','082222222222','','','[{"sku":"UR","quantity":1}]')$$, 'Antrean pesanan sedang penuh');
reset role;
\echo 'SQL: semua pemeriksaan lolos.'

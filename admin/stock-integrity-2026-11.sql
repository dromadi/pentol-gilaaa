-- Integritas stok (lihat docs/EVALUASI-FITUR-2026-11.md, bug B6 dan B7).
-- Aman dijalankan ulang. Jalankan SETELAH reconciliation-history-2026-11.sql.
--
-- Setelah migrasi ini angka stok hanya berubah lewat:
--   * Restok & Supplier: Catat restok (membuat baris batch) dan Terima barang (menambah Diterima)
--   * Pesanan: catat, antar, batal (mengubah Terpesan dan Diantar)
--   * pentol_correct_received: koreksi Diterima dengan alasan, tercatat di riwayat
begin;

-- 1. Admin tidak lagi menulis langsung ke tabel stok. Fungsi security definer tetap bisa.
revoke insert, update, delete on public.pentol_batch_stock from authenticated;

-- 2. Koreksi jumlah diterima (salah hitung, barang rusak) dengan alasan.
create or replace function public.pentol_correct_received(
  stock_id uuid, expected_revision integer, new_received integer, new_received_on date, change_reason text
) returns void language plpgsql security definer set search_path='' as $$
declare
  row_before public.pentol_batch_stock%rowtype;
  reason_text text := trim(change_reason);
begin
  perform public.pentol_assert_admin();
  if reason_text is null or length(reason_text) not between 1 and 500 then
    raise exception 'Alasan koreksi wajib diisi, maksimal 500 karakter.';
  end if;
  select * into row_before from public.pentol_batch_stock where id = stock_id for update;
  if not found or row_before.revision is distinct from expected_revision then
    raise exception 'Stok berubah. Muat ulang daftar stok.';
  end if;
  if new_received is null or new_received < row_before.delivered or new_received > 1000000 then
    raise exception 'Jumlah diterima tidak boleh kurang dari jumlah yang sudah diantar (% pack).', row_before.delivered;
  end if;
  if new_received > 0 and new_received_on is null then
    raise exception 'Isi tanggal diterima.';
  end if;
  if new_received_on > (now() at time zone 'Asia/Jakarta')::date then
    raise exception 'Tanggal diterima tidak boleh di masa depan.';
  end if;
  if (row_before.received, row_before.received_on) is not distinct from (new_received, new_received_on) then
    return;
  end if;
  update public.pentol_batch_stock
    set received = new_received, received_on = new_received_on, revision = revision + 1
    where id = stock_id;
  insert into public.pentol_reconciliation_history(changed_by,action,target_id,label,reason,before_value,after_value)
  values (auth.uid(), 'stock', stock_id, row_before.batch_code || ' · ' || row_before.sku, reason_text,
    jsonb_build_object('diterima', row_before.received, 'tanggal_terima', row_before.received_on),
    jsonb_build_object('diterima', new_received, 'tanggal_terima', new_received_on));
end $$;
revoke all on function public.pentol_correct_received(uuid,integer,integer,date,text) from public,anon,authenticated;
grant execute on function public.pentol_correct_received(uuid,integer,integer,date,text) to authenticated;

notify pgrst,'reload schema';
commit;

#!/usr/bin/env bash
# Cadangan database Pentol Gilaaa -> satu file 7z berkata sandi.
# Isi: database.sql (struktur + data skema public, bisa dipulihkan dengan psql) dan CSV per tabel (bisa dibuka di Excel/Sheets).
#
# Pemakaian:  SUPABASE_DB_URL=... BACKUP_PASSWORD=... bash scripts/backup.sh [folder-keluaran]
# SUPABASE_DB_URL  : connection string Postgres (Supabase: "Session pooler", port 5432).
# BACKUP_PASSWORD  : kata sandi file 7z. Tanpa kata sandi ini cadangan tidak bisa dibuka.
set -euo pipefail
: "${SUPABASE_DB_URL:?SUPABASE_DB_URL belum diisi}"
: "${BACKUP_PASSWORD:?BACKUP_PASSWORD belum diisi}"
out="${1:-backup-out}"
stamp="$(TZ=Asia/Jakarta date +%Y-%m-%d)"
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
mkdir -p "$work/csv" "$out"
export PGCONNECT_TIMEOUT=20

# 1. Struktur + data + hak akses skema public (tanpa owner) agar bisa dipulihkan ke project Supabase baru.
#    Baris pembuatan skema public dibuang karena skema itu sudah ada di setiap database.
pg_dump "$SUPABASE_DB_URL" --schema=public --no-owner --file="$work/database.sql"
sed -i -e '/^CREATE SCHEMA public;$/d' -e '/^COMMENT ON SCHEMA public IS/d' "$work/database.sql"

# 2. CSV per tabel pentol_* (urut stabil) supaya bisa dibaca tanpa Postgres.
tables=$(psql "$SUPABASE_DB_URL" -At -c "select tablename from pg_tables where schemaname='public' and tablename like 'pentol\_%' order by 1")
summary="$work/RINGKASAN.txt"
{ echo "Cadangan Pentol Gilaaa $stamp (WIB)"; echo "Dibuat: $(date -u +%Y-%m-%dT%H:%M:%SZ)"; echo; echo "Tabel dan jumlah baris:"; } > "$summary"
for table in $tables; do
  psql "$SUPABASE_DB_URL" -q -c "\\copy (select * from public.$table) to '$work/csv/$table.csv' with (format csv, header true)"
  echo "  $table: $(( $(wc -l < "$work/csv/$table.csv") - 1 ))" >> "$summary"
done
cat >> "$summary" <<'TXT'

Cara memulihkan: lihat docs/CADANGAN-OTOMATIS.md di repo pentol-gilaaa.
TXT

# 3. Bungkus terenkripsi (AES-256, nama file ikut disembunyikan).
archive="$(cd "$out" && pwd)/cadangan-pentol-gilaaa-$stamp.7z"
rm -f "$archive"
( cd "$work" && 7z a -t7z -mhe=on -mx=9 -p"$BACKUP_PASSWORD" "$archive" database.sql RINGKASAN.txt csv >/dev/null )
echo "Cadangan dibuat: $archive ($(du -h "$archive" | cut -f1))"
sed -n '4,100p' "$summary" | grep -v "^Cara\|^$" || true

#!/usr/bin/env bash
# Uji SQL di Postgres lokal sementara: bash tests/sql/run.sh
# Butuh Postgres 14+ (initdb, pg_ctl, psql). Data dibuang setelah selesai.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"; admin="$here/../../admin"
bin="$(dirname "$(command -v initdb 2>/dev/null || ls /usr/lib/postgresql/*/bin/initdb | tail -1)")"
dir="$(mktemp -d)"; chmod 777 "$dir"
as_pg() { if [ "$(id -u)" = 0 ]; then su postgres -c "$*"; else bash -c "$*"; fi; }
cleanup() { as_pg "$bin/pg_ctl -D $dir/data stop -m fast" >/dev/null 2>&1 || true; rm -rf "$dir"; }
trap cleanup EXIT
as_pg "$bin/initdb -D $dir/data -A trust" >/dev/null
as_pg "$bin/pg_ctl -D $dir/data -o \"-k $dir -p 5498 -c listen_addresses=\" -l $dir/log start" >/dev/null
sleep 2
user=$( [ "$(id -u)" = 0 ] && echo postgres || id -un )
psql_run() { "$bin/psql" -h "$dir" -p 5498 -U "$user" -d postgres -q -v ON_ERROR_STOP=1 "$@"; }
psql_run -f "$here/stub.sql"
# Urutan migrasi sama dengan admin/README.md; file yang boleh diulang dijalankan dua kali.
for f in schema orders operations security-2026-11 receipts-2026-11 invoice-reference-2026-11 reconciliation-history-2026-11 stock-integrity-2026-11 operasional-2026-11; do
  psql_run -f "$admin/$f.sql" 2>&1 | grep -v NOTICE || true
done
for f in security-2026-11 receipts-2026-11 invoice-reference-2026-11 reconciliation-history-2026-11 stock-integrity-2026-11 operasional-2026-11; do
  psql_run -f "$admin/$f.sql" 2>&1 | grep -v NOTICE || true
done
# Hanya baris "•", galat, dan hasil akhir yang ditampilkan; status keluar mengikuti psql.
if psql_run -t -f "$here/scenario.sql" > "$dir/out.txt" 2>&1; then
  grep -E "^•|lolos" "$dir/out.txt"
else
  grep -E "^•|ERROR|DIHARAPKAN|Pesan salah|assert" "$dir/out.txt"
  echo "SQL: ada pemeriksaan yang GAGAL."; exit 1
fi

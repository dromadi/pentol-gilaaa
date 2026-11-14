# Uji otomatis Pentol Gilaaa

Jalankan sebelum dan sesudah mengubah kode. Uji ini **tidak menyentuh Supabase produksi**: browser memakai Supabase tiruan (`mock.js`) dan SQL memakai Postgres lokal sementara.

## Browser + unit (admin & katalog)

```bash
cd tests
npm install            # sekali: memasang Playwright
npx playwright install chromium   # sekali, bila Chromium belum ada
node run.js            # atau: npm test
```

Isi:
- `unit.test.js` — pembaca teks GPT (`admin/gpt.js`) dan `groupBy`.
- `admin.test.js` — admin di ukuran HP: semua halaman, Hari Ini, badge, tombol cepat Pesanan, aksi & WhatsApp, form − / +, saran pelanggan, Tempel dari GPT, Batalkan arsip, pembagian packing per pesanan, stok per varian & koreksi, laporan, HP lama tanpa `Map.groupBy`.
- `catalog.test.js` — katalog pembeli: batas stok, banner gagal muat, penolakan stok dari server, CSP.

Data tiruan ada di `defaultData()` (`mock.js`). Saat menambah fitur, tambahkan satu `test(...)` yang memakai data itu.

## SQL (Postgres lokal)

```bash
bash tests/sql/run.sh
```

Menjalankan semua migrasi di `admin/` sesuai urutan README (yang boleh diulang dijalankan dua kali), lalu `sql/scenario.sql`: hak akses publik, PO & terima bertahap, larangan tulis langsung ke stok, koreksi beralasan, siklus pesanan, batas bayar, katalog `max_qty`, retry checkout, dan batas antrean. Butuh Postgres 14+ (`initdb`, `pg_ctl`, `psql`).

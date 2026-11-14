# Evaluasi fitur & logika — 14 November 2026 (branch `main`, commit c208d53)

Tujuan aplikasi: **memudahkan mengelola toko pentol**, bukan menambah fitur.
Ukurannya: apakah pekerjaan harian (terima pesanan → kemas & antar → terima bayar → restok) makin cepat dan angkanya bisa dipercaya.

## Cara pengujian

- **Database:** semua 7 migrasi dijalankan berurutan di Postgres 16 lokal (stub Supabase), yang "boleh diulang" dijalankan dua kali. Lalu satu siklus toko lengkap: PO → terima sebagian → checkout katalog → jadi pesanan → antar sebagian → bayar sebagian → lunas, ditambah kasus salah (bayar lebih, batal setelah bayar, antar tanpa stok, akun bukan admin, proses inbox dua kali, koreksi Excel, nomor invoice Excel).
- **Admin:** 11 menu dibuka di Chromium ukuran HP (Pixel 7) dengan data tiruan: error, panjang halaman, jumlah tombol/isian, geser ke samping.
- Belum diuji: Supabase produksi (tanpa akses login), file Excel asli untuk Rekonsiliasi.

## Yang sudah kuat (pertahankan)

| Alur | Hasil uji |
|---|---|
| Checkout katalog → inbox → jadi pesanan | ✅ Stok terpesan naik, inbox jadi "converted", inbox yang sama tidak bisa diproses dua kali |
| Pembayaran | ✅ Cicilan tercatat dengan tanggal, bayar melebihi sisa ditolak, lunas otomatis saat sisa 0 |
| Pengantaran | ✅ Antar sebagian/bertahap, ditolak jika stok fisik kurang |
| Batal pesanan | ✅ Booking stok dilepas; dikunci setelah ada bayar/antar |
| Penerimaan PO | ✅ Bertahap, tidak bisa melebihi jumlah PO, aman dikirim ulang |
| Keamanan | ✅ Akun bukan admin tidak bisa membaca/mengubah apa pun |
| Tampilan HP | ✅ 11 menu tanpa error JavaScript, tanpa geser ke samping |

## Bug logika (berdampak ke pekerjaan harian)

| # | Masalah | Bukti | Dampak |
|---|---|---|---|
| B1 | **Hari Ini menyembunyikan antaran yang terlambat.** Hanya jadwal = hari ini; jadwal kemarin yang belum diantar hilang | Pesanan berjadwal kemarin tidak muncul di Hari Ini | Pesanan bisa terlupa |
| B2 | **Piutang dari antar sebagian tidak terlihat.** Hari Ini & Ringkasan Piutang hanya membaca pesanan `delivered = true` | Pesanan 4 pack, diantar 2, belum bayar: tidak muncul di Hari Ini maupun Piutang | Tagihan terlewat |
| B3 | **Pesanan tanpa jadwal antar tidak muncul di Hari Ini** | Pesanan tanpa `delivery_on` hanya terlihat di Packing → "Belum dijadwalkan" | Pesanan terlupa |
| B4 | **Status "siap dikemas" dihitung per varian-batch, bukan per pesanan** | `packingReady` membandingkan stok fisik dengan seluruh booking batch | Satu pesanan kurang stok membuat semua pesanan varian itu "tertahan" |
| B5 | **Laba mengikuti tanggal pesan, bukan tanggal antar** | `finance()` menyaring `order_date` | Laba harian/mingguan bergeser |
| B6 | **"Diterima" di Stok per Batch bisa diedit bebas**, melewati PO | Uji: PO 10, diterima via PO 6, edit manual jadi 50 diterima | Stok dan HPP tidak bisa dipercaya |
| B7 | **Booking tanpa pelanggan** bisa dibuat dari edit stok manual dan dari koreksi Rekonsiliasi | Koreksi menaikkan booking 0→2 tanpa pesanan | Stok "terpesan" tidak jelas milik siapa |
| B8 | Ringkasan Piutang memakai `Map.groupBy` (Chrome 117+, Safari 17.4+) | Kode `receivables()` | Menu bisa gagal di HP Android lama |
| B9 | Label "Permintaan baru: 1 **pesanan**" padahal belum jadi pesanan | Hari Ini | Membingungkan |
| B10 | Instal baru: PO contoh BATCH-01/02 tidak punya baris stok, jadi tidak bisa "Terima barang" | Uji `pentol_receive_purchase('BATCH-01')` | Hanya project baru |

### Status perbaikan

| Bug | Status |
|---|---|
| B1, B3, B9 | **Diperbaiki.** Kartu "Perlu diantar" di Hari Ini memuat antaran terlambat ("terlambat N hari"), jadwal hari ini, dan pesanan belum dijadwalkan, dengan urutan itu. Jadwal setelah hari ini tidak ditampilkan. Label permintaan kini "N permintaan". Tombol membuka Packing → "Semua belum diantar" |
| B2 | **Diperbaiki.** "Diantar, belum lunas" berarti belum lunas dan sudah ada pack yang diantar. Definisi yang sama dipakai di Hari Ini, Ringkasan Piutang, dan Packing. Pesanan antar sebagian diberi tanda "antar sebagian". Sisa yang ditampilkan adalah sisa seluruh pesanan |
| B6 | **Diperbaiki** (`stock-integrity-2026-11.sql`). Hak tulis langsung admin ke `pentol_batch_stock` dicabut. Diterima hanya bertambah lewat Terima barang dari PO; koreksi lewat `pentol_correct_received` (alasan wajib, tidak boleh di bawah jumlah diantar, tidak boleh tanggal masa depan, cek revisi) dan tercatat di Riwayat Perubahan. Form stok kini hanya untuk koreksi Diterima; "Tambah stok batch" diganti "Catat restok →" |
| B7 | **Diperbaiki.** Rekonsiliasi tidak lagi bisa menaikkan booking (`pentol_reconcile_with_history` menolak jenis `stock`; UI menampilkan "Excel punya booking N pack yang belum jadi pesanan · catat di menu Pesanan"). Booking lama tanpa pesanan ditampilkan di Stok per Batch dan dibereskan lewat Catat pesanan → Pakai booking lama |
| B8 | **Diperbaiki.** `Map.groupBy` diganti `groupBy()` di `admin/reconcile.js` (dipakai juga oleh Tagihan), `Object.hasOwn` diganti `hasOwnProperty`. Diuji di Chromium dengan kedua fungsi dihapus (simulasi HP lama): Tagihan tampil normal |
| B4 | **Diperbaiki.** `allocatePacking()` membagi stok fisik (diterima − diantar) per batch ke pesanan belum diantar menurut jadwal antar paling awal, lalu tanggal pesan; Packing menampilkan "Siap dikemas", "Siap sebagian · X dari Y pack", atau "Tertahan" per pesanan, dan Hari Ini memakai perhitungan yang sama |
| Lainnya | Belum dikerjakan (B5 menunggu SQL: perlu tanggal per pengantaran) |

Pengujian B6/B7: Postgres lokal (tulis langsung ditolak; rekonsiliasi stok ditolak; koreksi valid/tidak valid; PO, pesanan, antar, bayar tetap jalan) dan Chromium HP (form koreksi hanya memanggil RPC, indikator booking tanpa pesanan, tombol Catat restok).

Pengujian B1–B3 (Chromium, Pixel 7, data tiruan dengan 8 jenis pesanan): pesanan terlambat, hari ini, dan tanpa jadwal tampil; jadwal besok tidak tampil; pesanan antar sebagian yang belum bayar tampil di ketiga tempat; pesanan lunas tidak tampil; tanpa error.

### Mode sementara sebelum SQL dijalankan

Sampai `stock-integrity-2026-11.sql` dijalankan di produksi, tombol **Koreksi** di Stok per Batch memanggil `pentol_correct_received`; jika fungsi itu belum ada (404), jumlah diterima disimpan langsung ke `pentol_batch_stock` dengan cek revisi, seperti form lama, dan tidak tercatat di riwayat. Alur barang masuk akhir pekan: Catat restok → Koreksi. Setelah migrasi berjalan, jalur sementara ini tidak terpakai (tulis langsung ditolak) dan bisa dihapus dari `admin/app.js`.

## Upgrade UI/UX (paket 1–3)

1. **Aksi langsung di kartu pesanan** (`orderButtons(order, target, context)` di `admin/operations.js`). Daftar pesanan: Antar / Bayar; Packing: Antar / Kabari diantar / Bayar; Tagihan: Bayar / Ingatkan via WA. Aksi jarang (Invoice, Jadwal antar, Edit, Batalkan, WA lain) di menu "⋯". Dialog bayar & antar = `payDialog` / `shipDialog`.
2. **WhatsApp siap kirim** (`waTemplates`, `waNumber`, `waLink`). Nomor 08…/+62…/8… dinormalkan ke 62…; tombol hanya muncul bila kolom WhatsApp pesanan terisi. Template pengingat tagihan dan kabar pengantaran ada di satu tempat (`waTemplates`) agar mudah diubah. Kartu tagihan di Hari Ini juga punya tombol "Ingatkan WA".
3. **Form Catat pesanan dengan − / + per varian** (`renderQuickPick`, `setSkuQuantity`, `allocate` di `admin/app.js`). Batch dan harga diatur otomatis (batch yang cukup dipakai utuh, kalau tidak dibagi; kekurangan stok membuka "Detail lain" dan memberi pesan). Tanggal, ongkir, catatan, rincian batch & harga, dan booking lama ada di "Detail lain". Mengubah jumlah satu varian hanya mengatur ulang baris varian itu dan mempertahankan harga yang sudah diubah.

Diuji di Chromium HP dengan data tiruan: aksi utama per konteks, isi tautan WA, bayar 1 ketukan, − / + dan ketik jumlah, kekurangan stok, simpan pesanan (payload benar), edit pesanan lama, Tempel dari GPT, dan 11 halaman tanpa error.

## Upgrade UI/UX (paket 4–8)

4. **Pesanan: tombol cepat** Perlu tindakan (bawaan) · Belum bayar · Belum antar · Per tanggal (`orderChip`, `chipFilters` di `admin/app.js`). Tiga tombol pertama memuat semua tanggal; "Per tanggal" memakai tanggal/status di "Filter lain". Empat kartu angka diganti satu baris ringkasan. Di HP, label kecil dan kalimat penjelasan judul halaman disembunyikan supaya isi naik.
5. **Notifikasi di bawah layar** (`status(message, error, action)`): sukses hilang setelah 4 detik, galat tetap sampai ditutup (×). "Arsipkan" permintaan katalog memakai tombol **Batalkan** 6 detik; penyimpanan ke database baru terjadi setelah itu (atau saat notifikasi berikutnya muncul). Bayar dan antar tidak punya Batalkan.
6. **Stok per varian** (`renderVariants`): kartu "siap jual" per varian; kuning ≤ 5 pack (`LOW_STOCK`), merah habis, tombol Restok. Tabel per batch dan Koreksi ada di "Rincian per batch & koreksi".
7. **Laporan**: angka utama (laba setelah biaya antar, atau penjualan diantar bila HPP belum lengkap) dan grafik batang penjualan diantar 4 minggu terakhir (menurut tanggal pesanan). Tabel di "Rincian laporan", harga jual di "Harga jual default".
8. **Saran pelanggan langganan** (`loadCustomers`, `<datalist id="customer-list">`): 500 pesanan terakhir; memilih nama mengisi WhatsApp dan lokasi bila masih kosong.

Diuji di Chromium HP dengan data tiruan (filter URL per tombol, Batalkan/arsip setelah 6 detik, isi otomatis pelanggan, warna stok, navigasi Restok, laporan & grafik) plus seluruh uji sebelumnya (11 halaman, Tempel dari GPT, aksi & form − / +, navigasi tab) tanpa error.

## Pasang sebagai aplikasi & badge navigasi

- **PWA:** `admin/manifest.webmanifest`, ikon di `admin/icons/`, `admin/sw.js`. Service worker **tidak menyimpan cache** (supaya versi baru selalu termuat); ia hanya menampilkan halaman "Tidak ada koneksi" saat offline. CSP ditambah `manifest-src 'self'; worker-src 'self'`. Tombol "⬇ Pasang aplikasi" muncul di header bila browser mendukung (`beforeinstallprompt`); di iPhone: Bagikan → Tambahkan ke Layar Utama. Chrome melaporkan 0 galat kelayakan pasang.
- **Badge:** `badgeCounts()` (operations.js) + `refreshBadges()` (app.js): Pesanan = permintaan katalog menunggu, Hari Ini = antaran yang lewat jadwal. Diperbarui saat masuk, tiap 2 menit, saat aplikasi dibuka lagi, dan setelah perubahan pesanan; jumlahnya juga di judul tab, mis. "(3) Hari Ini".

## Uji otomatis & perapian (14 Nov)

- `tests/`: uji unit, browser (admin & katalog, Supabase tiruan), dan SQL (Postgres lokal). Lihat `tests/README.md`. Uji dipastikan bisa gagal: dengan kode packing lama, uji B4 gagal; dengan harapan SQL yang salah, uji SQL gagal.
- Kode mati dihapus: halaman Analitik Stok, filter "Diantar, belum lunas" di Packing, jalur PATCH booking di Rekonsiliasi.
- Katalog: CSP dipasang setelah skrip dan gaya dipindah ke file.

## Input lewat ChatGPT (tahap 1: tempel)

Keputusan: **aplikasi (Supabase) tetap sumber kebenaran**; ChatGPT hanya pintu masuk. Tidak ada data yang tersimpan tanpa konfirmasi admin di form aplikasi, sehingga semua validasi database tetap berlaku.

- Pesanan → **✦ Tempel dari GPT**. Tombol "Salin instruksi untuk ChatGPT" menyalin aturan format (daftar kode varian, tanggal hari ini) untuk dikirim sekali ke ChatGPT.
- Format JSON: `{"aksi":[{"jenis":"pesanan|bayar|antar", ...}]}`; definisi lengkap di `gptInstructions()` (`admin/gpt.js`). Pembaca menerima teks di sekitar blok JSON, kode atau nama varian (nama ambigu seperti "tahu" ditolak), dan nominal seperti "100rb", "1,5jt", "100.000".
- Hasil tampil sebagai daftar aksi. **Pesanan** membuka form Catat pesanan yang sudah terisi (batch dipilih otomatis); **bayar** dan **antar** mencari pesanan menurut nomor invoice atau nama pelanggan, lalu membuka dialog yang sudah terisi; jika lebih dari satu pesanan cocok, admin memilih; jika tidak ada, diberi tahu.
- Diuji di Chromium HP dengan data tiruan: 4 aksi valid + 1 ditolak; form pesanan terisi benar (ongkir 5rb → 5000); bayar dan antar tersimpan lewat `pentol_order_action`; nama yang tidak cocok diberi pesan.

Tahap 2 (belum): Custom GPT dengan Actions ke Edge Function Supabase berkunci terbatas, setelah migrasi SQL berjalan.

## Fitur yang tumpang tindih (bikin ribet, bukan memudahkan)

| Tumpang tindih | Saran |
|---|---|
| **Analitik Stok** menampilkan angka yang sama dengan kartu di **Stok per Batch** | Hapus menu Analitik Stok |
| **Packing → "Sudah diantar, belum lunas"** sama dengan **Ringkasan Piutang** | Satu tempat saja: Piutang |
| **Dua nomor invoice** (nomor aplikasi `00007` dan nomor Excel `PG-YYYYMMDD-NNN`) | Pakai satu format, buat otomatis oleh aplikasi |
| **Rekonsiliasi Excel + Riwayat Perubahan + Simpan nomor Excel + Rekap Tutup Hari** = 4 fitur untuk menyamakan aplikasi dengan Excel | Gejala dua pembukuan. Tentukan satu sumber kebenaran (lihat di bawah) |
| "Riwayat Perubahan" hanya mencatat koreksi Excel, bukan edit stok/pesanan biasa | Ganti nama atau catat semua koreksi |
| Dua cara menaikkan stok diterima (edit stok & terima PO) | Hanya lewat Terima barang di PO |

## Upgrade UI/UX (tahap 1)

- **Navigasi bawah di HP** (≤900 px): Hari Ini, Pesanan, Antar, Stok, Lainnya. "Lainnya" membuka menu lengkap sebagai lembar bawah (tutup dengan Esc, ketuk di luar, atau pilih menu). Bar menu gelap di atas dihapus.
- **Menu dikelompokkan:** Harian (Hari Ini, Pesanan, Packing & Antar, Piutang) · Stok (Stok per Batch, Restok & Supplier) · Laporan & Promosi · Pembukuan Excel. Menu **Analitik Stok dihapus dari navigasi** (angka sama dengan Stok per Batch; bagian HTML-nya masih ada untuk sementara).
- **Hari Ini:** kartu pastel dengan angka besar; "Bisa dikemas" tidak mengulang daftar nama; daftar maksimal 3 nama + "N lainnya"; tanggal di kartu hanya di HP.
- Kartu, tabel, dan filter lebih lembut (radius 18 px, bayangan tipis), tombol berbentuk pil.
- Diuji di Chromium HP (Pixel 7) dan desktop 1366 px: 11 menu tanpa error dan tanpa geser ke samping; navigasi bawah, lembar menu, Esc, dan ketuk di luar berfungsi.

## Upgrade UI/UX (tahap 2)

- **11 menu → 5 menu utama + 2 menu Excel.** Sidebar dan navigasi bawah: Hari Ini · Pesanan · Stok · Laporan · Promosi (di HP: Promosi lewat "Lainnya"), lalu Rekonsiliasi Excel dan Riwayat Perubahan.
- **Tab bagian** di atas halaman: Pesanan = Daftar pesanan / Packing & antar / Tagihan; Stok = Stok per batch / Restok & PO; Laporan = Laba & harga / Tutup hari. Menu utama membuka tab terakhir yang dipakai.
- Packing tidak lagi punya filter "Diantar, belum lunas" (sudah ada di tab Tagihan).
- **Permintaan dari katalog** dipindah ke paling atas halaman Pesanan dan otomatis terbuka saat ada permintaan baru.
- Kode: `viewGroups`, `selectView`, `openNav` di `admin/app.js`; tombol bagian dibuat di `#subtabs`. Untuk pindah halaman dari kode, panggil `selectView('<id bagian>')`, jangan klik tombol menu.
- Diuji di Chromium HP dan desktop: semua 11 bagian tampil, tab dan menu bawah menyala sesuai halaman, tab terakhir diingat, tombol dari Hari Ini dan tombol Edit dari Packing membuka bagian yang benar; tanpa error dan tanpa geser ke samping.

## Rekomendasi utama: 11 menu → 5 menu

| Menu baru | Isi (dari menu lama) | Pertanyaan yang dijawab |
|---|---|---|
| **Hari Ini** | Permintaan baru, perlu dikemas, perlu diantar (**termasuk terlambat & tanpa jadwal**), belum lunas (**termasuk antar sebagian**) | "Apa yang harus saya kerjakan sekarang?" |
| **Pesanan** | Pesanan + inbox + packing + piutang (filter status) | "Bagaimana status pesanan si A?" |
| **Stok** | Stok per Batch + Restok & Supplier (terima PO) | "Apa yang masih bisa dijual, apa yang harus dipesan?" |
| **Laporan** | Harga & Laba + Rekap Tutup Hari | "Untung berapa minggu ini?" |
| **Promosi** | Tetap | "Apa yang saya posting hari ini?" |

**Satu sumber kebenaran:** selama Excel masih dipakai, Rekonsiliasi tetap berguna sebagai jembatan. Targetkan tanggal berhenti mencatat di Excel; setelah itu Rekonsiliasi, Riwayat koreksi Excel, dan nomor invoice Excel bisa disembunyikan, dan Rekap Tutup Hari cukup jadi tombol "Unduh Excel" di Laporan.

## Urutan perbaikan yang disarankan

1. **B1, B2, B3, B9** — Hari Ini menampilkan semua pekerjaan yang tertunda (kecil, dampak terbesar).
2. **B6, B7** — Diterima hanya dari PO; booking selalu milik pesanan.
3. **B8** — ganti `Map.groupBy` dengan pengelompokan biasa.
4. Gabung menu 11 → 5 (tanpa mengubah database).
5. **B4, B5** — packing per pesanan dan laba per tanggal antar.
6. Putuskan tanggal berhenti Excel.

## Aturan untuk agen berikutnya

- Sebelum menambah fitur, tanyakan: pekerjaan harian mana yang jadi lebih cepat? Jika tidak ada, jangan ditambah.
- Perbaiki atau gabungkan dulu sebelum menambah menu baru.

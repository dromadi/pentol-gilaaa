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
| B5 | **Diperbaiki setelah `operasional-2026-11.sql` dijalankan**: laporan memakai `pentol_shipments` (tanggal antar per pengiriman) |
| Lainnya | Belum dikerjakan |

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

## Cadangan data (manual + pengingat)

- `downloadBackup()` (operations.js): semua tabel (`backupTables`) ke satu file `Cadangan-Pentol-Gilaaa-YYYY-MM-DD.xlsx` dengan lembar Info (waktu ekspor, jumlah baris). Tabel yang belum ada (migrasi belum dijalankan) dilewati dan dicatat. Tombol di Laporan; pengingat di Hari Ini bila cadangan terakhir ≥ 7 hari atau belum pernah (tanggal disimpan di `localStorage` per perangkat).
- `close-day.js`: nama kolom Excel mendukung > 26 kolom (AA, AB, …).
- Diuji: unduh, isi lembar, tabel 404 dilewati, pengingat hilang; file dibuka dengan openpyxl.
- **Cadangan otomatis disiapkan**: `.github/workflows/backup.yml` + `scripts/backup.sh` (pg_dump + CSV → 7z AES-256, artifact 90 hari, 02.17 WIB). Aktif setelah pemilik mengisi secret `SUPABASE_DB_URL` dan `BACKUP_PASSWORD` — lihat `docs/CADANGAN-OTOMATIS.md`. Diuji lokal termasuk pemulihan ke database kosong.

## Katalog v2 & perapian admin (14 Nov)

**Katalog (HP):** pembuka ringkas (gambar tipis, judul, tombol; kalimat & baris manfaat disembunyikan) sehingga produk pertama terlihat di layar awal; kartu produk satu baris (nama · isi · harga · tombol, ±92 px, dari ±640 px); varian habis diurutkan ke bawah dan diredupkan; tinggi halaman 2.884 → ±1.900 px. Checkout: cara menerima berupa dua tombol (radio `name="method"`), data pembeli diingat di HP pembeli (`pentol-gilaaa-buyer` di localStorage, bisa dimatikan lewat centang), total + tombol kirim menempel di bawah laci (`.sticky-foot`), laci penuh lebar (`dialog { max-width:100% }`). Desktop tidak berubah selain urutan varian habis.

**Admin:** Restok & PO — tabel item jadi kartu bertumpuk di HP (`table()` kini memberi `data-label` per sel), "Terima barang" jadi tombol utama, "Lihat stok batch" dihapus (sudah ada tab Stok). Promosi — pilihan varian berupa chip dua kolom, bawaan hanya varian yang ada stoknya. Tutup hari & Rekonsiliasi — tombol utama ditandai, kolom pilih file lebih rapi.

Uji baru di `tests/catalog.test.js`: urutan varian habis, Diantar mewajibkan alamat, data pembeli terisi otomatis saat kunjungan ulang.

## Operasional: koreksi, opname, tanggal antar (14 Nov)

Migrasi `admin/operasional-2026-11.sql` (jalankan setelah `stock-integrity-2026-11.sql`):
- **`pentol_shipments`** — satu baris per perubahan jumlah diantar (negatif untuk koreksi), dengan `shipped_on` (WIB) dan harga satuan. Diisi trigger `pentol_log_shipment` pada `pentol_order_items.shipped`, jadi semua jalur (Antar, rekonsiliasi, koreksi) tercatat tanpa mengubah `pentol_order_action`. Data lama diisi sekali (tanggal = `delivered_at` atau tanggal pesan), aman diulang.
- **`pentol_correct_order(change_type, target, expected_revision, payload, change_reason)`** — `void_pay` (hapus pembayaran salah), `unship` (kurangi jumlah diantar; stok kembali ke terpesan), `cancel_rest` (sisa yang belum diantar dihapus, booking dilepas; perlu minimal satu item sudah diantar). Status lunas dihitung ulang, alasan wajib, revisi dicek, dicatat di `pentol_reconciliation_history` (constraint `action` diperluas).
- **`pentol_stock_opname(counts, change_reason)`** — hitungan fisik (diterima − diantar) untuk banyak baris dalam satu transaksi, memanggil `pentol_correct_received` hanya untuk baris yang berbeda.

Admin: menu "⋯" pesanan → **Koreksi**; Stok → **🧊 Hitung stok**; pengingat opname mingguan di Hari Ini; laporan (penjualan, HPP, ongkir, grafik) memakai **tanggal antar**. Ketersediaan dicek sekali per sesi lewat `pentol_shipments` (`hasOpsTools()`); sebelum migrasi semua ini tersembunyi dan laporan kembali ke tanggal pesanan. Ini menutup bug B5 dan catatan `delivered_at` antar sebagian.

Diuji: SQL (`tests/sql/scenario.sql`: catatan pengiriman, alasan & revisi, batal bayar, kurangi antar, batal sisa, opname) + pengisian data lama & jalankan ulang; browser (`tests/admin.test.js`: dialog Koreksi, opname, tersembunyi sebelum SQL, laporan per tanggal antar).

## Evaluasi per menu: Hari Ini (14 Nov)

Temuan & perbaikan:
- Angka kartu "Perlu diantar" ≠ daftar yang dibuka (daftar ikut memuat jadwal besok) → Packing punya mode `due` (terlambat, hari ini, tanpa jadwal; urutan sama dengan kartu, `dueOrders()`) dan `dueReady` (yang siap dikemas sekarang).
- Kartu tidak ikut diperbarui saat ada permintaan baru → `refreshBadges()` memuat ulang Hari Ini bila jumlah badge berubah dan Hari Ini sedang terbuka (tidak saat dialog terbuka). Simpan bayar/antar dari mana pun juga memuat ulang Hari Ini.
- Nama di kartu tidak bisa diketuk → aksi langsung per baris: Permintaan → **Proses**; Perlu diantar → **Antar**; Tagihan → **Bayar** + **WA**.
- Pengingat cadangan & hitung stok pindah ke bawah kartu, lebih ringkas; tombol "Muat ulang" di halaman disembunyikan (sudah ada ↻ di header).
- Info tambahan: permintaan menampilkan lama menunggu; "Bisa dikemas" memisahkan siap penuh / sebagian; tagihan diurutkan dari yang paling lama belum dibayar, dengan umur (hari sejak antar).

Diuji (`tests/admin.test.js`): urutan & aksi per baris, jumlah kartu = jumlah daftar, kartu diperbarui saat permintaan baru, Proses membuka form.

## Evaluasi per menu: Pesanan (14 Nov)

- **Daftar pesanan:** kartu ringkas (±510 px dari ±750 px): nama + total, baris info `Invoice · WA · lokasi`, varian tanpa kode batch, status + jadwal antar dalam satu baris (kolom "Status" menggantikan Pembayaran/Pengantaran). Pencarian juga mencocokkan nomor WA (08…/62…), nomor invoice, dan lokasi.
- **Permintaan katalog:** lama menunggu + tombol **Balas WA** berisi konfirmasi pesanan (`confirmMessage`).
- **Packing:** dibuka di mode `due` (Perlu diantar), label pilihan dipersingkat, tanggal "Sab, 14 Nov" (`dayLabel`), hanya tombol pertama yang berwarna penuh.
- **Tagihan:** per pelanggan dengan > 1 invoice: **Ingatkan semua (n)** dalam satu pesan WA (`remindAllMessage`) dan **Bayar sekaligus** (`payTogetherDialog`: nominal dibagi ke invoice tertua lebih dulu, masing-masing lewat `pentol_order_action('pay')`; bila gagal di tengah, pesan menyebut berapa yang sudah tersimpan). Tombol muat ulang ganda dihapus, tanggal mudah dibaca.
- **Bug:** label kolom ganda di tabel ringkasan (aturan `td[data-label]::before` global) dibatasi ke `.stock-table`.

Diuji: pencarian WA/invoice/nama, Balas WA, mode bawaan Packing, Ingatkan semua, pembagian Bayar sekaligus.

## Evaluasi per menu: Stok (14 Nov)

Masalah yang ditemukan dan perbaikannya (versi `stok-15`):
- **Kartu varian merah + "Restok" walau barang sudah dipesan ke supplier.** Sekarang kartu yang tertutup PO aktif berwarna biru "menunggu kiriman" dengan keterangan "+N dalam PO · tiba <tanggal>", dan tombol Restok hanya muncul bila memang belum dipesan.
- **Form restok panjang dan harus diketik dari nol.** Kode batch disarankan otomatis (BATCH-NN berikutnya), tanggal pesan = hari ini, jumlah pakai tombol − / +, harga beli/pack terisi dari harga terakhir varian itu, dan biaya tambahan (supplier, ongkir, kemasan, lain-lain) dilipat.
- **Terima barang mulai dari 0.** Sekarang langsung terisi sisa PO; cukup ubah bila datangnya kurang.
- **Daftar PO campur aduk.** PO yang masih ditunggu tampil di atas (urut estimasi tiba), PO selesai dilipat di "PO selesai (n)". Tanggal ditulis "Sen, 16 Nov".
- Uji baru: `stok & restok: barang dalam PO, form restok terisi, terima barang = sisa PO`.

## Evaluasi per menu: Laporan (14 Nov)

Perbaikan (versi `laporan-16`):
- **Laba & harga:** tombol periode Hari ini · Minggu ini · Bulan ini · Bulan lalu (tanggal manual tetap ada). Kartu utama berisi 4 angka: Penjualan (barang diantar), Laba (setelah ongkir; "Belum lengkap" bila harga beli kurang), Uang masuk, Belum dibayar (dari pesanan periode itu). Tabel baru **Laba per varian** (diantar, penjualan, laba). Urutan: angka → laba per varian → grafik → rincian → harga jual → cadangan.
- **Tutup hari:** langsung tampil tanpa tombol pratinjau dan ikut berganti saat tanggal diubah. Isinya: uang masuk (siapa saja), pack keluar per varian (tanggal antar dari `pentol_shipments` bila ada), sisa stok siap jual (yang habis dijadikan satu baris), siapa yang belum bayar, dan antar besok. Ada tombol **Kirim ke WA** (teks rekap, pilih kontak sendiri) dan **Excel** (isi file sama seperti sebelumnya).
- Belum dikerjakan (perlu SQL): pencatatan biaya harian (bensin, plastik, es, listrik) supaya laba benar-benar bersih.
- Uji baru: `laporan: tombol periode, 4 angka, laba per varian; tutup hari langsung tampil + kirim WA`. Mock kini melayani `pentol_payments`.

## Arsip permintaan katalog bisa dilihat lagi (14 Nov)

"Arsipkan" hanya mengubah status permintaan menjadi `dismissed` (data tidak dihapus), tetapi sebelumnya tidak ada tempat untuk melihatnya lagi. Sekarang di bawah "Permintaan dari katalog" ada lipatan **Diarsipkan 14 hari terakhir** dengan tombol **Buat pesanan** (form terisi; dikirim tanpa `inbox_id` agar tidak ditolak RPC karena statusnya bukan `pending`) dan **Balas WA**. Versi `arsip-17`. Uji: `permintaan yang diarsipkan masih terlihat dan bisa dijadikan pesanan`.

## Evaluasi alur pesan dari katalog (14 Nov)

Ditelusuri dari katalog → keranjang → data pemesan → kirim → kotak "Permintaan dari katalog" di admin → form pesanan.

Masalah dan perbaikan (katalog `v=3`, admin `katalog-18`):
- **Setelah kirim, pembeli melihat "Belum ada camilan pilihanmu" dan tombol mati**, sementara tanda berhasil terselip di bawah dengan kode UUID panjang. Sekarang ada layar selesai sendiri: ✓ "Pesananmu sudah masuk", rincian varian, subtotal, cara terima dan jadwal, kode pendek 8 karakter (sama dengan "Kode" di admin), tombol utama **Kabari toko lewat WhatsApp** dan **Selesai**. Bila gagal tercatat: "!" "Pesanan belum sampai ke toko" dan WhatsApp jadi jalan utama; isi keranjang tetap.
- Layar selesai tetap ada saat keranjang dibuka lagi atau halaman dimuat ulang, dan hilang saat menekan Selesai atau memilih varian baru. Sebelumnya struk lama bisa muncul di bawah keranjang baru.
- Tombol "Catat permintaan" (istilah toko) diganti **Kirim pesanan**. Setelah gagal, tombol tidak lagi berubah menjadi "Lanjut ke WhatsApp".
- **Jadwal terima:** pilihan Secepatnya / Besok / Pilih tanggal (judulnya ikut "diambil"/"diantar"). Jadwal dikirim di catatan sebagai `Jadwal: YYYY-MM-DD` (tanpa ubah SQL), ditulis di pesan WA, tampil "Jadwal Sen, 16 Nov" di kartu admin, dan **mengisi otomatis "Jadwal antar"** saat Proses pesanan. Catatan tidak lagi berakhiran " · " kosong.
- WhatsApp tetap disarankan karena toko hanya tahu ada permintaan baru saat admin dibuka.
- Uji baru: `jadwal terima ikut terkirim; layar selesai menggantikan keranjang kosong` (katalog) dan `permintaan katalog dengan jadwal: tampil "Jadwal", form terisi jadwal antar` (admin).

## Ubah pesanan kapan saja (14 Nov)

Permintaan pemilik: admin bisa mengubah pesanan saat pembeli menambah, mengurangi, atau mengganti varian. Sebelumnya **Edit** tersembunyi di ⋯ dan hanya muncul sebelum ada pembayaran atau pengantaran.

- Tombol **Ubah pesanan** sekarang ada di menu ⋯ setiap pesanan aktif (urutan pertama).
- Pesanan belum dibayar & belum diantar: memakai aturan lama (`pentol_order_action` 'edit'), langsung jalan tanpa SQL baru.
- Pesanan sudah dibayar / sebagian diantar: memakai `pentol_edit_order` dari **`admin/ubah-pesanan-2026-11.sql`** (jalankan setelah operasional). Aturan: varian yang sudah diantar tidak bisa dihapus atau dikurangi di bawah jumlah antar; total baru tidak boleh di bawah pembayaran tercatat (batalkan bayar dulu lewat Koreksi); lunas lama tanpa catatan bayar tidak bisa dinaikkan; status lunas & selesai antar dihitung ulang; perubahan tercatat di Riwayat (aksi `edit`, sebelum/sesudah per varian + total). Sebelum SQL dijalankan, aplikasi menampilkan pesan dan tidak menyimpan apa pun.
- Form: catatan kuning "Sudah diantar … / Sudah dibayar …"; tombol − berhenti di jumlah antar; baris batch yang sudah diantar terkunci; stok "sisa" ikut menghitung booking pesanan itu sendiri sehingga menambah tidak pindah batch tanpa perlu.
- Riwayat Perubahan kini menampilkan Batal bayar, Koreksi antar, Batal sisa, dan Ubah pesanan dengan benar (sebelumnya terbaca "Dibayar undefined").
- Uji: SQL `ubah pesanan setelah bayar & antar sebagian`; browser `ubah pesanan setelah bayar & antar sebagian…` dan `ubah pesanan sebelum SQL…`. Versi `ubah-19`.

## Permintaan katalog: tombol Ubah dan Hapus dengan konfirmasi (14 Nov)

Kartu permintaan sekarang: **Proses pesanan** · **Ubah** · **Balas WA** · **Hapus**. "Arsipkan" (dengan Batalkan 6 detik) diganti **Hapus** yang memunculkan kotak "Hapus pesanan X? Yakin hapus permintaan ini?" dengan tombol merah **Ya, hapus** / Tutup. Di database tetap status `dismissed` (tidak dihapus permanen) dan tampil di lipatan **Dihapus 14 hari terakhir** dengan tombol Buat pesanan. Form dari katalog berjudul "Pesanan dari katalog · Nama" dengan petunjuk bahwa varian/jumlah/jadwal bisa diubah sebelum disimpan. `showDialog` kini menerima `submitLabel` dan `danger`. Versi `hapus-20`.

## Menu Pesanan: 5 sub menu (14 Nov)

Permintaan pemilik: pisahkan "Perlu tindakan" dari daftar lain, dan pisahkan Packing dari Antar.
- **Perlu tindakan** (`#actions`, panel `#orders`): permintaan dari katalog + pesanan belum bayar/belum antar, dengan tombol cepat Semua · Belum bayar · Belum antar. Tanpa filter tanggal. Bawaan saat membuka menu Pesanan.
- **Semua pesanan** (`#orders`): per hari/minggu (bawaan minggu ini) dengan filter status, termasuk yang selesai & batal. Tanpa permintaan katalog dan tombol cepat.
- **Packing** (`#packing`): Siap dikemas sekarang · Siap dikemas per tanggal · Semua per tanggal jadwal, dengan tabel total pack per varian/batch.
- **Antar** (`#delivery`, panel baru): Perlu diantar · Belum dijadwalkan · Semua belum diantar · Per tanggal jadwal. "Buka daftar antar" di Hari Ini membuka sub menu ini.
- **Tagihan**: tetap.
- Di HP kelima sub menu muat satu baris (kelas `.subtabs.many`, teks boleh 2 baris). Membuka form pesanan dari ⋯ / Hari Ini tidak lagi memindahkan Perlu tindakan ↔ Semua pesanan (`toOrders`). Versi `pesanan-21`. Uji: `Pesanan: 5 sub menu…`.

## Tanggal antar yang bisa diatur (14 Nov)

Untuk mencatat antaran yang sudah lewat (misalnya rekap Excel 9–13 Nov) tanpa semuanya tercatat "hari ini".
- Kotak **Antar** punya kolom **Tanggal antar** (bawaan hari ini, tidak boleh masa depan, tidak boleh sebelum tanggal pesanan). Dari **Tempel dari GPT** kolom `tanggal` mengisinya otomatis.
- Hari ini: jalur lama (`pentol_order_action` 'ship'), tidak perlu SQL baru. Tanggal lain: `pentol_ship_order` dari **`admin/tanggal-antar-2026-11.sql`** (jalankan setelah operasional): mengatur `pentol.ship_date` selama transaksi sehingga trigger `pentol_log_shipment` menulis `shipped_on` = tanggal itu, dan `delivered_at` = siang WIB tanggal itu. Laporan (per tanggal antar), grafik mingguan, dan Tutup hari ikut tanggal itu. Stok tidak terpengaruh. Sebelum SQL dijalankan: pesan jelas, tidak ada yang tersimpan.
- Uji: SQL `tanggal antar…`, browser `tanggal antar: bawaan hari ini…` dan `Tempel dari GPT: tanggal antar…`. Versi `tanggal-22`.

## Tempel dari GPT: nominal "lunas" dan Simpan semua (14 Nov)

Untuk memasukkan rekap lama (31 pesanan diantar & lunas) tanpa 62 kali Simpan.
- `"nominal":"lunas"` pada aksi `bayar` melunasi seluruh sisa tagihan pesanan itu (form bayar terisi sisa tagihan).
- Tombol **Simpan semua yang cocok tunggal (n)** di hasil GPT (muncul bila ada ≥2 aksi antar/bayar) dengan kotak konfirmasi. Berurutan, jadi antar lalu bayar untuk orang yang sama aman. Aksi dilewati (dengan keterangan, tetap bisa manual) bila: nama cocok dengan >1 pesanan atau tidak ada, jumlah antar tidak sesuai sisa, tanggal antar di luar batas, nominal bayar melebihi sisa tagihan. Aksi `pesanan` tidak ikut (tetap lewat form). Penyimpanan memakai jalur yang sama dengan kotak dialog (`submitOrderAction`), termasuk antar bertanggal lain via `pentol_ship_order`.
- Tidak ada pembatalan massal; koreksi satu per satu lewat Koreksi. Satu tempelan GPT maksimal 30 aksi. Versi `simpan-24`. Uji: `Tempel dari GPT: Simpan semua hanya menyimpan yang cocok tunggal`, unit `bayar "lunas"`.

## Laporan: Unduh Excel per periode (14 Nov)

Tombol **⬇ Unduh Excel** di Laporan → Laba & harga, mengikuti periode yang tampil (Hari ini/Minggu ini/Bulan ini/Bulan lalu/tanggal bebas). File `Laporan-Pentol-Gilaaa-<dari>_<sampai>.xlsx`, 7 lembar: **Ringkasan** (penjualan, HPP, laba, margin, uang masuk, tagihan, belum dibayar, nilai stok + catatan dasar tanggal), **Laba per varian**, **Penjualan per minggu** (4 minggu terakhir), **Pesanan** (pesanan periode: invoice, pelanggan, WA, isi, total, dibayar, sisa, status, jadwal), **Pembayaran** (tanggal bayar, pelanggan, invoice, nominal; nama dari embed `pentol_orders`), **Tagihan terbuka** (semua yang belum lunas saat ini, urut paling lama sejak diantar), **Stok** (per batch + harga beli & nilai siap jual). Angka rupiah disimpan sebagai angka agar bisa dijumlah di Excel. Tanpa SQL baru. Versi `excel-25`. Uji: `laporan: Unduh Excel berisi 7 lembar…`.

## Tampilan tablet & laptop (16 Nov)

Laporan pemilik: tabel Pesanan di laptop/tablet tidak rapi. Diperbaiki (versi `rapi-26`, hanya CSS ≥621px; HP tidak berubah):
- Sel **Status** sebelumnya `display:flex` sehingga keluar dari baris tabel (garis bawah tidak sejajar). Kini tetap sel tabel, chip berjajar dengan jarak.
- **Aksi**: tombol berdampingan rapat (Invoice/Antar/Bayar + ⋯), menu ⋯ melayang di atas tabel (tidak mendorong tinggi baris), kolom selebar isinya. Tanggal/Tagihan/Status selebar isi; Pelanggan & Pesanan mendapat sisa ruang.
- **Tablet (621–1100px)**: status boleh 2 baris, tombol aksi bertumpuk agar kolom Aksi tidak terpotong.
- **Laporan**: tombol periode satu baris penuh di tablet; jarak kosong di atas "Laba per varian" dihapus.

## Migrasi produksi selesai (16 Nov)

Pemilik (dibantu Claude di browser) menjalankan 8 file SQL berurutan di Supabase produksi, tanpa galat: security → receipts → invoice-reference → reconciliation-history → stock-integrity → operasional → ubah-pesanan → tanggal-antar. Pengecekan di database: 11 fungsi baru ada, 3 tabel baru ada, kolom `excel_invoice_no` ada, `pentol_shipments` terisi 39 baris dari data lama, tulis langsung ke tabel stok ditolak, data utuh (21 pesanan, diterima 107 pack). Dari luar: `pentol_catalog_v2` menjawab dengan `max_qty`, tabel pesanan tertutup untuk anon (401).

Setelah itu: fallback sementara di form koreksi stok (PATCH langsung ke `pentol_batch_stock` bila `pentol_correct_received` belum ada) dihapus; koreksi stok kini hanya lewat fungsi beralasan. Pemeriksaan 404 lain dibiarkan karena hanya menampilkan pesan dan tidak menulis apa pun. Versi `live-27`.

## Laporan: Tahun ini + laba per hari/minggu/bulan (16 Nov)

- Tombol periode ke-5: **Tahun ini** (1 Januari s.d. hari ini).
- Kartu baru **Laba per hari / minggu / bulan** di bawah angka utama: kolom Periode, Pack diantar (disembunyikan di HP), Penjualan, Laba (penjualan − HPP − ongkir toko; "belum lengkap" bila HPP kurang), Uang masuk, plus baris **Total**. Urut terbaru di atas; periode kosong tetap tampil. Bawaan: ≤14 hari → per hari, ≤92 hari → per minggu, lebih → per bulan; bisa diganti lewat tombol (per hari maks 62 hari). Label minggu = rentang yang masuk periode (mis. "9–15 Nov", "1 Nov").
- Data dari catatan yang sama dengan angka utama (pengiriman per tanggal antar + ongkir pesanan selesai; pembayaran per tanggal bayar). Tanpa SQL.
- Excel laporan kini 8 lembar: tambah **Laba per periode** (mengikuti pilihan hari/minggu/bulan yang tampil). Versi `laba-28`. Uji: `laporan: Tahun ini + rincian laba…` dan uji Excel 8 lembar.

## Rekonsiliasi → Impor & ekspor (16 Nov)

Permintaan pemilik: menu baru di Rekonsiliasi untuk ekspor/impor Excel dan hapus seluruh data. Pilihan pemilik: impor memakai **template aplikasi**; hapus = **transaksi saja**.
- Sub menu baru **Impor & ekspor** (`#dataExcel`) di grup Rekonsiliasi.
- **Ekspor:** `Data-Pentol-Gilaaa-<tanggal>.xlsx` dengan lembar Petunjuk, PO (satu baris per varian per batch: dipesan, harga beli, diterima, tanggal diterima, biaya batch), Pesanan (satu baris per pesanan, kolom jumlah per varian, status antar/bayar, ID sistem). Modul murni `admin/data-excel.js`.
- **Impor:** pratinjau dulu (jumlah PO/pesanan baru, yang dilewati, baris bermasalah beserta alasannya), lalu disimpan berurutan lewat fungsi yang sudah ada: `pentol_admin_action('purchase')`, `pentol_receive_purchase`, `pentol_order_action('create')`, antar via `submitOrderAction` (bertanggal → `pentol_ship_order`), bayar. **Idempoten:** batch yang sudah ada dilewati; pesanan memakai ID sistem atau UUID tetap dari SHA-256 isi baris (+ urutan kemunculan), penerimaan & pembayaran memakai UUID tetap → impor ulang tidak menggandakan. Stok diambil dari batch tertua (`allocateStock`). Harga = harga jual saat ini. "Sebagian" diantar tidak diimpor (diselesaikan di aplikasi). Maks 500 pesanan per impor.
- **Hapus semua transaksi:** `pentol_wipe_transactions('HAPUS SEMUA')` dari **`admin/hapus-transaksi-2026-11.sql`** menghapus pesanan, item, pembayaran, pengantaran, permintaan katalog, penerimaan, riwayat, stok batch, PO; harga/varian & admin tetap; nomor invoice mulai dari 1. Aplikasi meminta ketik HAPUS SEMUA, mengunduh cadangan Excel dulu (gagal unduh = batal), baru memanggil fungsi.
- Uji: unit (tanggal/angka, baca template, alokasi stok), browser `impor & ekspor…`, SQL `hapus semua transaksi…`. Versi `data-29`.

## Migrasi produksi di luar repo: perbaikan-temuan-2026-11-16 (16 Nov)

Claude di browser menjalankan migrasi `perbaikan-temuan-2026-11-16.sql` langsung di Supabase produksi. **File-nya belum ada di repo** (minta pemilik menempelkan isinya). Menurut laporannya: `delivered_at` diisi dari `pentol_shipments` (17 pesanan), riwayat Terima barang Batch 1 & 2 ditambahkan ke `pentol_purchase_receipts` (stok tidak berubah), kolom `pentol_payments.method` (tunai/bni/gopay/transfer_lain/lainnya) + `created_at`, tabel `pentol_expenses` (kategori plastik, kemasan, ongkir antar, es batu, listrik freezer, promosi, lainnya; admin saja), kolom `pentol_inbox.converted_order_id`, dan relasi wajib stok → produk & PO.

Dampak ke kode: `hapus-transaksi-2026-11.sql` kini menghapus inbox **sebelum** pesanan (FK `converted_order_id`) dan ikut menghapus `pentol_expenses` bila ada; uji SQL meniru kedua perubahan itu. Yang perlu dicek setelah isi file diterima: apakah `method` boleh kosong/ber-default (fungsi bayar lama menyisipkan 4 kolom secara posisi); bila wajib tanpa default, pencatatan bayar di produksi gagal.

## Tombol back tetap di admin (16 Nov)

Keluhan pemilik: setelah masuk admin, tombol back HP langsung kembali ke katalog. Penyebab: pindah menu memakai `history.replaceState`, jadi riwayat browser hanya berisi [katalog, admin]. Sekarang (versi `back-30`): saat dasbor tampil, riwayat diberi entri penjaga + entri menu (`armHistory`), setiap pindah menu menambah entri (`pushState`), back berpindah ke menu sebelumnya, back di menu pertama tertahan dengan pesan "tekan Keluar dulu", back saat kotak dialog terbuka hanya menutup dialog. Setelah **Keluar**, entri admin dibuang (`releaseHistory`) sehingga back berikutnya kembali ke katalog. "Lihat katalog ↗" tetap membuka tab baru. Uji: `tombol back: …`.

## Pesanan → Selesai (16 Nov)

Sub menu ke-6 **Selesai** (`#done`, panel `#orders`): pesanan aktif yang sudah lunas **dan** sudah diantar semua (`paid=true&delivered=true&cancelled=false`), terbaru di atas, dengan kotak cari; tanpa permintaan katalog, tombol cepat, atau filter tanggal. Ringkasan: "N pesanan selesai · RpX terjual & dibayar". Grid sub menu di HP memakai `--tabs` (jumlah tab grup). Versi `selesai-32`. Uji: `Pesanan → Selesai…`.

## Stok → Per batch & koreksi jadi tab (16 Nov)

Lipatan "Rincian per batch & koreksi" di halaman Stok dipindah menjadi sub menu sendiri **Per batch & koreksi** (`#batches`, panel `#stock` yang sama): ringkasan angka, filter batch/cari varian, tabel per batch, dan tombol Koreksi. Tab **Stok** kini hanya kartu per varian. Urutan sub menu: Stok · Per batch & koreksi · Restok & PO. Versi `batch-33`.

## Stok → PO selesai jadi tab (16 Nov)

Lipatan "PO selesai" di Restok & Supplier dipindah ke sub menu sendiri **PO selesai** (`#poDone`, panel baru, `purchasing(target, 'done')`): kartu PO yang sudah diterima semua, terbaru di atas, tanpa tombol Catat restok. Tab **Restok & PO** kini hanya tombol Catat restok + PO yang menunggu kiriman, dengan petunjuk jumlah PO selesai. Sub menu Stok: Stok · Per batch & koreksi · Restok & PO · PO selesai. Versi `po-34`.

## PO selesai: baris ringkas + halaman (16 Nov)

Pemilik tidak suka menggulir panjang. PO selesai kini satu baris per PO (`BATCH · tanggal diterima terakhir · total biaya`, di laptop juga supplier & jumlah pack), **6 per halaman di HP / 8 di laptop** sehingga daftar + tombol ‹ Sebelumnya · 1/n · Berikutnya › muat satu layar, kotak cari (batch/supplier/varian), terbaru di atas. Tekan baris → rincian di `<dialog class="po-detail">` tersendiri (bukan `#ops-dialog`, agar Edit restok bisa membuka form restok; rincian ditutup dulu). Tombol Terima barang disembunyikan untuk PO yang sudah diterima semua. Versi `po-35`. Uji: `PO selesai: 6 per halaman…`. Pola ini bisa dipakai juga untuk Pesanan → Selesai.

## Laporan: Harga & Laba dipisah (16 Nov)

Sub menu Laporan kini **Laba · Harga jual · Tutup hari** (versi `harga-36`).
- **Laba** (`#finance`): periode, angka utama, laba per hari/minggu/bulan, per varian, grafik, rincian, Unduh Excel. Lipatan harga jual & kartu cadangan dikeluarkan.
- **Harga jual** (`#prices`, `priceList`): tabel Varian · Harga jual · Harga beli terakhir (HPP batch terbaru, termasuk bagian ongkir/kemasan) · Untung/pack (%) · Ubah. Dialog ubah harga menampilkan harga beli terakhir. Di HP kolom harga beli disembunyikan agar muat satu layar.
- **Cadangan data** pindah ke Rekonsiliasi Excel → Impor & ekspor (bersama ekspor/impor/hapus). Pengingat cadangan di Hari Ini tetap. `docs/CADANGAN-OTOMATIS.md` dan `AGENTS.md` ikut diperbarui.

## Laba hari ini / minggu ini / bulan ini / tahun ini (16 Nov)

Di atas halaman Laporan → Laba ada 4 kartu yang selalu tampil: **Laba hari ini · minggu ini · bulan ini · tahun ini** (laba = penjualan − HPP − ongkir toko, plus penjualannya; "Belum lengkap" bila HPP kurang). Data diambil sekali untuk 1 Januari s.d. hari ini (`loadQuick`, cara hitung sama dengan laporan: tanggal antar bila `pentol_shipments` ada). Tekan kartu = periode di bawah ikut berganti. Rincian kini juga punya pilihan **Per tahun** (untuk periode > 27 hari). Versi `laba-37`. Uji: `laporan: 4 kartu laba…`.

## Laporan: Laba waktu & Laba varian (16 Nov)

Sub menu Laporan: **Laba waktu · Laba varian · Harga jual · Tutup hari** (versi `varian-38`). Keduanya memakai `finance(target, mode)` yang sama sehingga angkanya konsisten.
- **Laba waktu** (`#finance`): 4 kartu (hari/minggu/bulan/tahun ini), periode, angka utama, laba per hari/minggu/bulan/tahun, grafik, rincian, Unduh Excel. Tabel laba per varian dipindah.
- **Laba varian** (`#profitVariant`): periode + daftar varian urut laba terbesar: pack & penjualan, laba, margin (laba ÷ penjualan varian, sebelum ongkir toko), porsi dari total laba (bilah). **⚠ margin < 15%** disorot + kotak saran dengan tombol **Ubah harga →** (ke Harga jual). Tekan varian = tren varian itu per hari/minggu/bulan (mengikuti panjang periode). Catatan bertanggal (`dated`) kini menyimpan `sku`.
- Uji: `Laba varian: urut laba terbesar…`; uji laporan lama disesuaikan.

## Tombol besar "+ Catat pesanan" di semua halaman (16 Nov)

Keluhan pemilik: Catat pesanan "ngumpet" (hanya kecil di kepala halaman Pesanan), padahal dipakai tiap hari. Sekarang ada tombol melayang `#quick-order` di semua halaman admin: di HP tepat di atas menu bawah (kanan), di laptop pojok kanan bawah. Tekan = pindah ke Pesanan → Perlu tindakan (bila belum di Pesanan), form pesanan baru terbuka, kursor di kolom nama. Tombol sembunyi selama form terbuka dan muncul lagi setelah Simpan/Batal (`syncQuickOrder`). Ruang bawah halaman HP ditambah agar tidak menutupi isi. Versi `catat-39`. Uji: `tombol besar + Catat pesanan…`.

## Pesanan → Selesai: baris ringkas + halaman (16 Nov)

Pola PO selesai dipasang di Pesanan → Selesai (`renderDoneList`, `#done-list`; tabel disembunyikan di mode ini): satu baris per pesanan (`nama · invoice` | `tanggal pesan · total`), **6 per halaman di HP / 8 di laptop**, tombol ‹ Sebelumnya · n/m · Berikutnya › **di atas daftar** (agar tidak tertutup), kotak cari yang sama (cari baru = kembali ke halaman 1). Tekan baris = rincian di kotak tersendiri (dipesan, diantar, ✓ Selesai, isi, total, pembayaran, kontak) dengan tombol Invoice dan ⋯ (Ubah/Koreksi; rincian ditutup dulu). Tombol melayang "+ Catat pesanan" disembunyikan khusus di tab ini (tombol besar di kepala halaman tetap). Versi `selesai-40`. Uji: `Pesanan → Selesai: 6 per halaman…`.

## Perlu tindakan: baris ringkas + halaman (16 Nov)

Pola Selesai dipasang di **Perlu tindakan** (semua tombol cepat: Semua/Belum bayar/Belum antar): satu baris per pesanan dengan tanda yang masih perlu dikerjakan (**Antar**, **Antar · telat** merah, **Bayar**) + total; tekan = kotak rincian (status bayar/antar, jadwal, isi, pembayaran, kontak) berisi tombol **Antar · Bayar · ⋯** (`showOrderDetail`, dipakai juga oleh Selesai). **Permintaan dari katalog** juga diringkas jadi satu baris per permintaan (nama · varian | pack · waktu), tekan = kartu lengkap (Proses, Ubah, Balas WA, Hapus) di kotak tersendiri. **Jumlah baris per halaman mengikuti tinggi layar** (3–8, dihitung dari posisi daftar sampai menu bawah) sehingga tanpa menggulir; tombol halaman di atas daftar; baris ringkasan ganda disembunyikan; tombol melayang "+ Catat pesanan" disembunyikan di Perlu tindakan & Selesai (tombol besar di kepala halaman tetap). "Semua pesanan" tetap tabel. Versi `tindakan-44`. Uji lama disesuaikan (hitung baris di semua halaman; aksi lewat kotak rincian).

## Semua pesanan: baris ringkas + halaman (16 Nov)

Pola yang sama dipasang di **Semua pesanan**: satu baris per pesanan (`nama` | `tanggal pesan · status · total`), status: **✓ Selesai** (hijau), **Batal** (abu), atau **Antar/Bayar** yang belum; jumlah baris mengikuti tinggi layar, tombol halaman di atas, tekan = kotak rincian. Lipatan **Tanggal & status** kini tertutup bawaan dan judulnya menampilkan pilihan aktif (mis. "Tanggal & status · 16–22 Nov 2026 · Belum lunas"); ganti tanggal/status/minggu = kembali ke halaman 1. Tabel lama tidak dipakai lagi di Pesanan. Tombol melayang disembunyikan di ketiga daftar Pesanan. Versi `semua-45`. Uji: `Semua pesanan: baris ringkas…`.

## Tagihan: baris ringkas per pelanggan + halaman (16 Nov)

Pola yang sama di **Pesanan → Tagihan**: satu baris per pelanggan (`nama · n invoice` | umur tagihan tertua dalam hari — merah bila ≥ 7 hari — dan total sisa), tagihan paling lama di atas, kotak cari (nama/WA/invoice), tombol halaman di atas, jumlah baris mengikuti tinggi layar. Tekan baris = kartu pelanggan lengkap di kotak tersendiri (per invoice: Bayar, Ingatkan via WA, ⋯; untuk >1 invoice: Bayar sekaligus, Ingatkan semua). Ringkasan atas: total sisa + jumlah pelanggan. Daftar memakai helper umum `pagedList` (operations.js) yang bisa dipakai halaman lain. Tombol melayang disembunyikan di Tagihan. Versi `tagihan-46`. Uji lama disesuaikan.

## Ubah nama pemesan lebih mudah (16 Nov)

Mengganti nama pemesan sebenarnya sudah bisa lewat ⋯ → Ubah pesanan (pesanan biasa via `pentol_order_action` 'edit', yang sudah dibayar/diantar via `pentol_edit_order`), tetapi tersembunyi tiga langkah. Kotak rincian pesanan kini punya tombol **✎ Ubah** di sebelah nama: membuka form ubah pesanan dengan kursor di kolom nama (teks terpilih, langsung ketik). Versi `nama-47`. Uji: `ubah nama pemesan…`.

## Pesan dulu, tunggu restok (17 Nov)

Masalah lapangan: pelanggan memesan saat stok kosong padahal restok sudah direncanakan; form menolak ("Pilih batch untuk sisanya"). Database sudah mengizinkan booking melebihi stok (`create` hanya menambah `reserved`), jadi perbaikan tanpa SQL (versi `restok-48`):
- `allocate`: bila stok bebas kurang, kekurangan dibooking ke `restockTarget(sku)`: batch dari **PO yang masih ditunggu** (estimasi tiba paling awal), kalau tidak ada **batch terbaru** varian itu (digabung ke baris yang sama bila sudah ada). Pesan: "Pentol Jamur 2 pack menunggu restok BATCH-03 (tiba Kam, 19 Nov)" atau "… belum ada PO: catat restok". Varian yang belum pernah punya batch tetap diminta catat restok dulu. Pilihan varian menandai "N tunggu restok".
- Pengantaran tetap aman: Packing/Antar menulis "Tertahan · stok fisik belum cukup" dan `ship` ditolak database sampai Terima barang.
- Daftar pesanan (Perlu tindakan, Semua pesanan): tanda **Tunggu stok** (biru) untuk pesanan yang stok fisiknya belum cukup menurut pembagian Packing (`ops.waitingStock`, jadwal paling awal dapat stok dulu); rincian menjelaskan "Menunggu restok". Kartu varian: "N pack dipesan menunggu restok".
- Katalog pembeli tidak berubah (tetap tidak bisa memesan melebihi stok).
- Uji: `pesan dulu, tunggu restok…`, `daftar pesanan: tanda Tunggu stok…`.

## Katalog: jumlah sisa stok tidak ditampilkan ke pembeli (17 Nov)

Permintaan pemilik: "sisanya jangan tampil di konsumen". Label "Sisa N pack" di kartu varian dihapus. Batas tetap berlaku (dari `max_qty` katalog v2): tombol + berhenti, lalu muncul keterangan **"Jumlah maksimal tercapai"** tanpa angka. Pesan saat server menolak karena stok kini "Stok Pentol X tidak cukup untuk jumlah itu…" (angka dari server hanya dipakai di dalam untuk menyesuaikan keranjang), dan penyesuaian keranjang saat sinkron menulis "X disesuaikan dengan stok". Katalog `catalog.js?v=4`. Uji katalog diperbarui.

## Pre-order: stok kosong tapi bisa dipesan (25 Nov)

Masalah: setelah "Pesan dulu, tunggu restok", varian yang stoknya 0 masih tertulis "habis" di admin dan "SOLD OUT / Stok habis" di katalog, padahal admin bisa mencatat pesanannya. Pembeli sama sekali belum bisa memesan.
- **Admin** (versi `preorder-49`, tanpa SQL): kartu stok "kosong · bisa pre-order" bila ada PO yang ditunggu (estimasi tiba tetap di baris "+N dalam PO"), "kosong · pre-order setelah catat PO" bila belum ada PO, "kosong · belum pernah direstok" bila belum pernah ada batch. Form pesanan: "sisa 0" diganti "kosong · pre-order, tiba Kam, 27 Nov" dan tidak dipudarkan.
- **Katalog** (`catalog.js?v=5`, perlu `admin/preorder-2026-11.sql`): `pentol_catalog_v3` menambah `preorder` dan `eta`. Varian kosong yang masih punya sisa PO tampil **PRE-ORDER** dengan "Stok sedang kosong · dikirim setelah stok datang, perkiraan Jum, 27 Nov", tombol **+ Pre-order**, dan baris keranjang/WhatsApp/layar selesai menulis "(pre-order, perkiraan stok datang …)". Varian tanpa PO tetap SOLD OUT.
- Batas: `pentol_submit_checkout` kini menerima sampai stok bebas + ruang pre-order. Ruang pre-order = sisa PO yang belum diterima dikurangi booking yang sudah melebihi stok fisik (pesanan Tunggu stok), jadi pembeli tidak bisa memesan lebih dari yang akan datang. Sisa PO dihitung dari total Terima barang, sehingga koreksi/opname yang menurunkan "diterima" tidak membuka pre-order palsu.
- Sebelum SQL dijalankan katalog otomatis memakai v2 (perilaku lama).
- Uji: SQL `Pre-order (preorder-2026-11.sql)`, katalog `pre-order: stok kosong tapi ada PO…`, admin `pesan dulu, tunggu restok…` & `stok & restok…`.

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

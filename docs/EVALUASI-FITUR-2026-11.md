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

## Fitur yang tumpang tindih (bikin ribet, bukan memudahkan)

| Tumpang tindih | Saran |
|---|---|
| **Analitik Stok** menampilkan angka yang sama dengan kartu di **Stok per Batch** | Hapus menu Analitik Stok |
| **Packing → "Sudah diantar, belum lunas"** sama dengan **Ringkasan Piutang** | Satu tempat saja: Piutang |
| **Dua nomor invoice** (nomor aplikasi `00007` dan nomor Excel `PG-YYYYMMDD-NNN`) | Pakai satu format, buat otomatis oleh aplikasi |
| **Rekonsiliasi Excel + Riwayat Perubahan + Simpan nomor Excel + Rekap Tutup Hari** = 4 fitur untuk menyamakan aplikasi dengan Excel | Gejala dua pembukuan. Tentukan satu sumber kebenaran (lihat di bawah) |
| "Riwayat Perubahan" hanya mencatat koreksi Excel, bukan edit stok/pesanan biasa | Ganti nama atau catat semua koreksi |
| Dua cara menaikkan stok diterima (edit stok & terima PO) | Hanya lewat Terima barang di PO |

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

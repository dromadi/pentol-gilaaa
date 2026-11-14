# Panduan agen — Pentol Gilaaa

- `index.html`: katalog pembeli (GitHub Pages, branch `main`). `admin/`: panel admin (Supabase).
- Baca `admin/README.md` (urutan migrasi) , `docs/AUDIT-2026-11.md` (riwayat audit & aturan), dan `docs/EVALUASI-FITUR-2026-11.md` (evaluasi fitur: utamakan kemudahan, bukan jumlah fitur) sebelum mengubah apa pun.
- `main` = produksi (langsung tayang). Kerjakan di branch lain lalu gabungkan lewat pull request.
- Database Supabase dipakai bersama oleh semua branch; perubahan SQL tidak otomatis jalan — pemilik menjalankannya manual di SQL Editor.

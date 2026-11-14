# Panduan agen — Pentol Gilaaa

- `index.html`: katalog pembeli (GitHub Pages, branch `main`). `admin/`: panel admin (Supabase).
- Baca `admin/README.md` (urutan migrasi) , `docs/AUDIT-2026-11.md` (riwayat audit & aturan), dan `docs/EVALUASI-FITUR-2026-11.md` (evaluasi fitur: utamakan kemudahan, bukan jumlah fitur) sebelum mengubah apa pun.
- `main` = produksi (langsung tayang di GitHub Pages). Bawaannya: kerjakan di branch lain lalu gabungkan lewat pull request. **Perubahan yang sudah diuji boleh langsung ke `main` bila pemilik memintanya** di percakapan itu. Setelah push, pastikan versi baru sudah tayang (cek `app.js?v=` di `/admin/`) dan naikkan parameter `?v=` pada file JS/CSS yang berubah agar cache HP ikut terbarui.
- Database Supabase dipakai bersama oleh semua branch; perubahan SQL tidak otomatis jalan — pemilik menjalankannya manual di SQL Editor.

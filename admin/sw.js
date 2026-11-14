// Service worker admin: tidak menyimpan cache data atau halaman, supaya admin selalu memuat versi terbaru.
// Hanya memberi halaman "tidak ada koneksi" saat admin dibuka tanpa internet.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
  if (event.request.mode !== 'navigate') return;
  event.respondWith(fetch(event.request).catch(() => new Response(
    '<!doctype html><html lang="id"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
    + '<title>Tidak ada koneksi</title><body style="font:16px/1.5 system-ui;background:#f7f5ef;color:#2e2521;padding:32px">'
    + '<h1 style="font-size:22px">Tidak ada koneksi internet</h1><p>Admin Pentol Gilaaa butuh internet untuk memuat data. '
    + 'Periksa sinyal lalu buka lagi.</p></body></html>',
    { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } })));
});

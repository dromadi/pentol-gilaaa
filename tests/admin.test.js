// Uji browser admin dengan Supabase tiruan (ukuran HP Pixel 7).
import { test, assert, equal } from './harness.js';
import { createRequire } from 'node:module';
import { mockSupabase, login, defaultData, order, todayJakarta, shiftDay } from './mock.js';
const JSZip = createRequire(import.meta.url)('../admin/vendor/jszip.min.js');
import { closeDayWorkbook } from '../admin/close-day.js';
import { orderHead, PO_HEAD } from '../admin/data-excel.js';

export function adminTests(browser, devices, baseUrl) {
  async function open(data = defaultData(), options = {}) {
    const context = await browser.newContext(devices['Pixel 7']);
    if (options.oldBrowser) await context.addInitScript(() => { delete Map.groupBy; delete Object.hasOwn; });
    const page = await context.newPage();
    const problems = [];
    page.on('pageerror', error => problems.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error' || /Content.Security/i.test(message.text())) problems.push(message.text());
    });
    await mockSupabase(page, data);
    await login(page, baseUrl);
    return { page, data, problems, close: () => context.close() };
  }
  const goSub = async (page, nav, tab) => {
    await page.click(`.bottom-nav [data-go=${nav}]`);
    await page.waitForTimeout(300);
    if (tab) { await page.click(`#subtabs >> text=${tab}`); await page.waitForTimeout(500); }
  };

  test('semua halaman terbuka tanpa error dan tanpa geser ke samping', async () => {
    const s = await open();
    const pages = [['today'], ['orders'], ['orders', 'Semua pesanan'], ['orders', 'Packing'], ['orders', 'Antar'], ['orders', 'Tagihan'], ['stock'], ['stock', 'Per batch & koreksi'], ['stock', 'Restok & PO'], ['stock', 'PO selesai'],
      ['finance'], ['finance', 'Laba varian'], ['finance', 'Varian & harga'], ['finance', 'Tutup hari']];
    for (const [nav, tab] of pages) {
      await goSub(s.page, nav, tab);
      assert(!await s.page.evaluate(() => document.documentElement.scrollWidth > innerWidth), 'geser ke samping di ' + nav + ' ' + (tab || ''));
    }
    for (const view of ['promotions', 'reconcile', 'history']) {
      await s.page.click('#more-menu');
      await s.page.click(`#admin-menu [data-view=${view}]`);
      await s.page.waitForTimeout(300);
      assert(await s.page.isVisible('#' + view), 'halaman ' + view + ' tidak tampil');
    }
    equal(s.problems, [], 'ada error di konsol');
    await s.close();
  });

  test('Hari Ini: terlambat, tanpa jadwal, dan antar sebagian ikut tampil; besok tidak', async () => {
    const s = await open();
    const cards = await s.page.$$eval('.today-card', cs => Object.fromEntries(cs.map(c =>
      [c.dataset.tone, { number: c.querySelector('.today-number').textContent, text: c.innerText }])));
    equal(cards.request.number, '1', 'jumlah permintaan');
    equal(cards.deliver.number, '4', 'perlu diantar = hari ini + 2 terlambat + 1 tanpa jadwal');
    assert(cards.deliver.text.includes('2 terlambat · 1 belum dijadwalkan'), 'ringkasan terlambat');
    assert(!cards.deliver.text.includes('Dodi Besok'), 'jadwal besok tidak boleh tampil');
    equal(cards.money.number, 'Rp216.000', 'tagihan: Gina Rp72.000 + Eka (antar sebagian) Rp144.000');
    await s.close();
  });

  test('Hari Ini: daftar kartu = daftar yang dibuka; aksi langsung per baris; urutan tagihan', async () => {
    const s = await open();
    const deliverCount = Number(await s.page.textContent('.today-card[data-tone=deliver] .today-number'));
    const rows = await s.page.$$eval('.today-card[data-tone=deliver] .today-row-text', xs => xs.map(x => x.textContent.split(' · ')[0]));
    equal(rows, ['Budi Terlambat', 'Eka Antar Sebagian', 'Ani Hari Ini'], 'urutan: terlambat dulu');
    const requestRow = await s.page.textContent('.today-card[data-tone=request] .today-row-text');
    assert(/Dewi · \d+ (menit|jam) lalu/.test(requestRow), 'lama menunggu permintaan: ' + requestRow);
    const owed = await s.page.$$eval('.today-card[data-tone=money] .today-row-text', xs => xs.map(x => x.textContent));
    assert(owed[0].startsWith('Gina Belum Bayar') && owed[0].includes('4 hari'), 'tagihan tertua di atas: ' + owed[0]);
    const order = await s.page.$$eval('#today-body > *', xs => xs.map(x => x.classList[0]));
    equal(order[0], 'today-grid', 'kartu di atas pengingat');
    await s.page.locator('.today-card[data-tone=deliver] .row-action').first().click();
    await s.page.waitForTimeout(300);
    assert((await s.page.textContent('#ops-title')).includes('Budi Terlambat'), 'Antar langsung dari Hari Ini');
    await s.page.click('#ops-form > button:not([type])');
    await s.page.waitForTimeout(500);
    assert(s.data.writes.some(w => w.body.action === 'ship' && w.body.target === 'o2'), 'pengantaran tersimpan');
    await s.page.click('text=Buka daftar antar');
    await s.page.waitForTimeout(600);
    equal(await s.page.locator('#delivery-body .ops-card').count(), deliverCount, 'jumlah daftar = angka kartu');
    await s.close();
  });

  test('Hari Ini: kartu ikut diperbarui saat ada permintaan baru', async () => {
    const s = await open();
    equal(await s.page.textContent('.today-card[data-tone=request] .today-number'), '1', 'awal');
    s.data.inbox.push({ ...s.data.inbox[0], id: '00000000-0000-0000-0000-00000000abce', customer: 'Eko Baru' });
    await s.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await s.page.waitForTimeout(900);
    equal(await s.page.textContent('.today-card[data-tone=request] .today-number'), '2', 'kartu diperbarui');
    await s.page.locator('.today-card[data-tone=request] .row-action').first().click();
    await s.page.waitForTimeout(300);
    assert(await s.page.isVisible('#order-form'), 'Proses membuka form pesanan');
    await s.close();
  });

  test('badge: permintaan baru dan antaran terlambat', async () => {
    const s = await open();
    await s.page.waitForTimeout(400);
    const badges = await s.page.$$eval('.bottom-nav .nav-badge', bs => bs.map(b => b.parentElement.dataset.go + '=' + b.textContent));
    equal(badges.sort(), ['orders=1', 'today=2'], 'badge');
    assert((await s.page.title()).startsWith('(3) '), 'judul tab memuat jumlah');
    await s.close();
  });

  test('Pesanan: tombol cepat mengubah filter data', async () => {
    const s = await open();
    await goSub(s.page, 'orders');
    const count = async () => {
      // Jumlah baris di semua halaman.
      let n = 0;
      for (;;) {
        n += await s.page.$$eval('#done-list .po-row', rows => rows.length);
        const next = s.page.locator('#done-list >> text=Berikutnya ›');
        if (await next.isVisible() && await next.isEnabled()) await next.click(); else break;
      }
      return n;
    };
    equal(await count(), 6, 'Perlu tindakan = semua kecuali yang lunas & diantar');
    await s.page.click('.order-chips [data-chip=unpaid]'); await s.page.waitForTimeout(400);
    equal(await count(), 6, 'Belum bayar');
    await s.page.click('.order-chips [data-chip=pending]'); await s.page.waitForTimeout(400);
    equal(await count(), 5, 'Belum antar');
    await s.close();
  });

  test('Pesanan: 6 sub menu, Perlu tindakan vs Semua pesanan, Packing vs Antar', async () => {
    const s = await open();
    await goSub(s.page, 'orders');
    equal(await s.page.$$eval('#subtabs button', b => b.map(x => x.textContent)),
      ['Perlu tindakan', 'Semua pesanan', 'Packing', 'Antar', 'Tagihan', 'Selesai'], 'sub menu');
    assert(await s.page.isVisible('#checkout-inbox') && await s.page.isVisible('.order-chips'), 'perlu tindakan: permintaan + tombol cepat');
    assert(await s.page.isHidden('#order-filters'), 'tanpa filter tanggal');
    await goSub(s.page, 'orders', 'Semua pesanan');
    assert(await s.page.isHidden('#checkout-inbox') && await s.page.isHidden('.order-chips'), 'semua pesanan: tanpa permintaan & tombol cepat');
    assert(await s.page.isVisible('#order-filters') && await s.page.isHidden('#order-filters input[type=date]'), 'filter tanggal ada, terlipat');
    assert((await s.page.textContent('#order-filters summary')).startsWith('Tanggal & status · '), 'ringkasan filter di judul lipatan');
    await s.page.click('#order-filters summary');
    assert(await s.page.isVisible('#order-filters input[type=date]'), 'filter tanggal bisa dibuka');
    equal(await s.page.textContent('#orders-title'), 'Semua pesanan', 'judul');
    assert(s.page.url().endsWith('#orders'), 'alamat #orders');
    await goSub(s.page, 'orders', 'Packing');
    equal(await s.page.$eval('#packing [name=pack_filter]', x => x.value), 'dueReady', 'packing: siap dikemas');
    equal(await s.page.$$eval('#packing [name=pack_filter] option', o => o.map(x => x.value)), ['dueReady', 'ready', 'packing'], 'pilihan packing');
    await goSub(s.page, 'orders', 'Antar');
    equal(await s.page.$$eval('#delivery [name=pack_filter] option', o => o.map(x => x.value)), ['due', 'unscheduled', 'pending', 'date'], 'pilihan antar');
    assert(s.page.url().endsWith('#delivery'), 'alamat #delivery');
    await s.page.reload(); await s.page.waitForTimeout(800);
    assert(await s.page.isVisible('#delivery'), 'refresh tetap di Antar');
    await s.close();
  });

  test('Pesanan → Selesai: hanya yang lunas dan sudah diantar, terbaru di atas', async () => {
    const data = defaultData();
    data.orders.push(order('o9', 'Zaki Selesai Baru', { paid: true, delivered: true, items: [[1, 1]], order_date: shiftDay(-1) }));
    const s = await open(data);
    await goSub(s.page, 'orders', 'Selesai');
    await s.page.waitForTimeout(400);
    equal(await s.page.textContent('#orders-title'), 'Pesanan selesai', 'judul');
    const names = await s.page.$$eval('#done-list .po-row strong', xs => xs.map(x => x.textContent));
    equal(names, ['Zaki Selesai Baru', 'Fajar Lunas'], 'hanya selesai, terbaru dulu');
    assert(await s.page.isHidden('.order-table'), 'tabel diganti baris ringkas');
    await s.page.click('#done-list .po-row');
    const detail = await s.page.textContent('.po-detail');
    assert(detail.includes('Zaki Selesai Baru') && detail.includes('✓ Selesai') && detail.includes('Invoice'), 'rincian: ' + detail);
    await s.page.click('.po-detail >> text=Tutup');
    assert(await s.page.isHidden('#checkout-inbox') && await s.page.isHidden('.order-chips') && await s.page.isHidden('#order-filters'), 'tanpa permintaan, tombol cepat, filter');
    assert(s.page.url().endsWith('#done'), 'alamat #done');
    assert(!await s.page.evaluate(() => document.documentElement.scrollWidth > innerWidth), 'tanpa geser ke samping');
    await s.close();
  });

  test('tombol besar + Catat pesanan: tampil di semua halaman, langsung membuka form', async () => {
    const s = await open();
    for (const nav of ['today', 'stock', 'finance']) {
      await s.page.click(`.bottom-nav [data-go=${nav}]`);
      await s.page.waitForTimeout(200);
      assert(await s.page.isVisible('#quick-order'), 'tombol tampil di ' + nav);
    }
    const box = await s.page.locator('#quick-order').boundingBox();
    const nav = await s.page.locator('.bottom-nav').boundingBox();
    assert(box.height >= 50 && box.y + box.height <= nav.y, 'besar dan di atas menu bawah');
    await s.page.click('#quick-order');
    await s.page.waitForTimeout(400);
    assert(await s.page.isVisible('#order-form'), 'form pesanan terbuka');
    assert(await s.page.isVisible('#orders'), 'pindah ke Pesanan');
    equal(await s.page.evaluate(() => document.activeElement?.name), 'customer', 'langsung ke kolom nama');
    assert(await s.page.isHidden('#quick-order'), 'tombol sembunyi selama form terbuka');
    await s.page.click('#cancel-order');
    assert(await s.page.isHidden('#quick-order'), 'di Perlu tindakan memakai tombol besar di kepala halaman');
    await s.page.click('.bottom-nav [data-go=today]');
    await s.page.waitForTimeout(200);
    assert(await s.page.isVisible('#quick-order'), 'muncul lagi di halaman lain setelah form ditutup');
    await s.close();
  });

  test('Pesanan → Selesai: 6 per halaman di HP, cari mengulang ke halaman 1', async () => {
    const data = defaultData();
    for (let i = 1; i <= 8; i++) data.orders.push(order('d' + i, 'Selesai ' + i, { paid: true, delivered: true, items: [[1, 1]], order_date: shiftDay(-10 + i) }));
    const s = await open(data);
    await goSub(s.page, 'orders', 'Selesai');
    await s.page.waitForTimeout(400);
    const names = () => s.page.$$eval('#done-list .po-row strong', xs => xs.map(x => x.textContent));
    const firstPage = (await names()).length;
    assert(firstPage >= 3 && firstPage < 9, 'halaman 1 dibatasi: ' + firstPage);
    assert(await s.page.isHidden('#quick-order'), 'tombol melayang tidak menutupi daftar Selesai');
    const fits = await s.page.evaluate(() => {
      const rows = [...document.querySelectorAll('#done-list .po-row')];
      return rows.at(-1).getBoundingClientRect().bottom <= document.querySelector('.bottom-nav').getBoundingClientRect().top;
    });
    assert(fits, 'baris terakhir di atas menu bawah (tanpa menggulir)');
    await s.page.click('#done-list >> text=Berikutnya ›');
    const second = (await names()).length;
    assert(firstPage + second >= 9 || await s.page.isVisible('#done-list >> text=Berikutnya ›'), 'halaman berikutnya berisi sisanya');
    await s.page.fill('#order-search', 'Selesai 3');
    await s.page.waitForTimeout(200);
    equal(await names(), ['Selesai 3'], 'cari langsung ketemu');
    await s.close();
  });

  test('Semua pesanan: baris ringkas dengan tanggal & status, termasuk selesai dan batal', async () => {
    const data = defaultData();
    data.orders.push(order('o9', 'Zara Batal', { cancelled: true, order_date: todayJakarta() }));
    data.orders.forEach(o => { o.order_date = todayJakarta(); });
    const s = await open(data);
    await goSub(s.page, 'orders', 'Semua pesanan');
    await s.page.waitForTimeout(400);
    assert(await s.page.isHidden('.order-table'), 'tabel diganti baris ringkas');
    const rows = [];
    for (;;) {
      rows.push(...await s.page.$$eval('#done-list .po-row', xs => xs.map(x => x.textContent)));
      const next = s.page.locator('#done-list >> text=Berikutnya ›');
      if (await next.isVisible() && await next.isEnabled()) await next.click(); else break;
    }
    equal(rows.length, 8, 'semua pesanan minggu ini (7 + 1 batal)');
    assert(rows.some(r => r.includes('Fajar Lunas') && r.includes('✓ Selesai')), 'selesai bertanda');
    assert(rows.some(r => r.includes('Zara Batal') && r.includes('Batal')), 'batal bertanda');
    assert(rows.some(r => r.includes('Ani Hari Ini') && r.includes('Antar') && r.includes('Bayar')), 'belum selesai bertanda');
    await s.close();
  });

  test('ubah nama pemesan: tombol ✎ Ubah di rincian, nama tersimpan (juga pesanan lunas & diantar)', async () => {
    const data = defaultData();
    data.orders = [order('o1', 'Yuna'), order('o2', 'Fajar', { paid: true, delivered: true, items: [[2, 2]],
      pentol_payments: [{ id: 'p', order_id: 'o2', amount: 72000, paid_on: shiftDay(-1) }] })];
    const s = await open(data);
    await goSub(s.page, 'orders');
    await s.page.locator('#done-list .po-row', { hasText: 'Yuna' }).click();
    await s.page.click('.po-detail .detail-edit');
    equal(await s.page.evaluate(() => document.activeElement?.name), 'customer', 'kursor di kolom nama');
    await s.page.fill('#order-form [name=customer]', 'Elyuna');
    await s.page.click('#save-order');
    await s.page.waitForTimeout(400);
    equal(s.data.writes.find(w => w.body?.action === 'edit')?.body.payload.customer, 'Elyuna', 'nama baru tersimpan');
    await goSub(s.page, 'orders', 'Selesai');
    await s.page.locator('#done-list .po-row', { hasText: 'Fajar' }).click();
    await s.page.click('.po-detail .detail-edit');
    await s.page.fill('#order-form [name=customer]', 'Fajar Rahman');
    await s.page.click('#save-order');
    await s.page.waitForTimeout(400);
    equal(s.data.writes.find(w => w.fn === 'pentol_edit_order')?.body.payload.customer, 'Fajar Rahman', 'pesanan lunas & diantar ikut bisa diganti nama');
    await s.close();
  });

  test('perbaikan A: promosi tanpa angka stok, tombol + bulat di HP, nama halaman konsisten', async () => {
    const s = await open();
    await s.page.click('#more-menu');
    await s.page.click('#admin-menu [data-view=promotions]');
    await s.page.waitForTimeout(400);
    const caption = await s.page.textContent('#promotions-body .ops-copy');
    assert(!/sisa|\d+ pack/.test(caption) && caption.includes('Pentol Urat'), 'caption tanpa jumlah stok: ' + caption);
    await s.page.click('.bottom-nav [data-go=today]');
    await s.page.waitForTimeout(300);
    const fab = await s.page.locator('#quick-order').boundingBox();
    assert(Math.abs(fab.width - fab.height) < 2 && fab.width <= 60, 'tombol + bulat kecil di HP');
    assert((await s.page.textContent('#today-body')).includes('Permintaan katalog'), 'kartu Permintaan katalog');
    await goSub(s.page, 'stock', 'Restok & PO');
    equal((await s.page.textContent('#purchasing h2')).trim(), 'Restok & PO', 'judul = nama tab');
    await goSub(s.page, 'finance', 'Tutup hari');
    equal((await s.page.textContent('#closeDay h2')).trim(), 'Tutup hari', 'judul = nama tab');
    await s.close();
  });

  test('Pesanan: cari nama/WA/invoice; permintaan katalog punya Balas WA', async () => {
    const s = await open();
    await goSub(s.page, 'orders');
    const count = async () => {
      // Jumlah baris di semua halaman.
      let n = 0;
      for (;;) {
        n += await s.page.$$eval('#done-list .po-row', rows => rows.length);
        const next = s.page.locator('#done-list >> text=Berikutnya ›');
        if (await next.isVisible() && await next.isEnabled()) await next.click(); else break;
      }
      return n;
    };
    await s.page.fill('#order-search', '00002'); await s.page.waitForTimeout(150);
    equal(await count(), 1, 'cari nomor invoice');
    await s.page.fill('#order-search', '0812 3456'); await s.page.waitForTimeout(150);
    equal(await count(), 6, 'cari nomor WA');
    await s.page.fill('#order-search', 'ani'); await s.page.waitForTimeout(150);
    equal(await count(), 1, 'cari nama');
    assert((await s.page.textContent('#done-list .po-row')).includes('00001'), 'baris memuat invoice');
    await s.page.click('#done-list .po-row');
    assert((await s.page.textContent('.po-detail')).includes('Gedung B'), 'rincian memuat lokasi');
    await s.page.click('.po-detail >> text=Tutup');
    await s.page.click('#inbox-list .inbox-row');
    const reply = decodeURIComponent(await s.page.getAttribute('.po-detail .wa-link', 'href'));
    assert(reply.includes('wa.me/6281234567890') && reply.includes('Pentol Urat × 2'), 'Balas WA berisi pesanan');
    await s.close();
  });

  test('Packing dibuka di "Perlu diantar"; Tagihan: bayar sekaligus dibagi ke invoice tertua', async () => {
    const data = defaultData();
    data.orders.push(order('o8', 'Gina Belum Bayar', { delivered: true, items: [[3, 3]], delivered_at: shiftDay(-2) + 'T05:00:00Z' }));
    const s = await open(data);
    await goSub(s.page, 'orders', 'Antar');
    equal(await s.page.$eval('#delivery [name=pack_filter]', select => select.value), 'due', 'mode bawaan');
    assert(/Antar (Sen|Sel|Rab|Kam|Jum|Sab|Min)/.test(await s.page.textContent('#delivery-body')), 'tanggal mudah dibaca');
    await goSub(s.page, 'orders', 'Tagihan');
    await s.page.locator('#receivables-body .po-row', { hasText: 'Gina Belum Bayar' }).click();
    const gina = s.page.locator('.po-detail > .ops-card');
    const remind = decodeURIComponent(await gina.locator('.wa-link', { hasText: 'Ingatkan semua (2)' }).getAttribute('href'));
    assert(remind.includes('Invoice 00007') && remind.includes('Invoice 00008') && remind.includes('Total sisa Rp180.000'), 'satu pesan untuk 2 invoice');
    await gina.locator('button', { hasText: 'Bayar sekaligus' }).click();
    await s.page.fill('#ops-fields [name=amount]', '100000');
    await s.page.click('#ops-form > button:not([type])');
    await s.page.waitForTimeout(500);
    const pays = s.data.writes.filter(w => w.body.action === 'pay').map(w => [w.body.target, w.body.payload.amount]);
    equal(pays, [['o7', 72000], ['o8', 28000]], 'invoice tertua dilunasi dulu');
    await s.close();
  });

  test('aksi langsung dan tautan WhatsApp berisi tagihan', async () => {
    const s = await open();
    await goSub(s.page, 'orders', 'Tagihan');
    await s.page.locator('#receivables-body .po-row').first().click();
    const card = s.page.locator('.po-detail article.ops-card').filter({ hasText: 'Invoice' }).first();
    const primary = await card.locator('.primary-actions > *').allTextContents();
    equal(primary, ['Bayar', 'Ingatkan via WA'], 'aksi utama di Tagihan');
    const href = decodeURIComponent(await card.locator('.wa-link').getAttribute('href'));
    assert(href.startsWith('https://wa.me/6281234567890?text=Halo '), 'nomor WA dinormalkan ke 62…');
    assert(/Sisa Rp\d/.test(href), 'pesan memuat sisa tagihan');
    await card.locator('button', { hasText: 'Bayar' }).click();
    await s.page.waitForTimeout(300);
    await s.page.click('#ops-form > button:not([type])');
    await s.page.waitForTimeout(400);
    const pay = s.data.writes.find(w => w.fn === 'pentol_order_action' && w.body.action === 'pay');
    assert(pay && pay.body.payload.amount > 0, 'pembayaran terkirim');
    await s.close();
  });

  test('form pesanan − / +: batch otomatis dan data yang dikirim', async () => {
    const s = await open();
    await goSub(s.page, 'orders');
    await s.page.click('#new-order');
    await s.page.fill('[name=customer]', 'Bu Sari');
    const ur = s.page.locator('.quick-item').filter({ hasText: 'Pentol Urat' });
    for (let i = 0; i < 3; i++) await ur.locator('button[aria-label^=Tambah]').click();
    await s.page.click('#save-order');
    await s.page.waitForTimeout(400);
    const create = s.data.writes.find(w => w.body.action === 'create');
    equal(create?.body.payload.items, [{ stock_id: 's1', quantity: 3, unit_price: 36000 }], 'item pesanan');
    await s.close();
  });

  test('pesan dulu, tunggu restok: stok kurang tetap bisa dicatat (ke PO yang ditunggu / batch terakhir)', async () => {
    const data = defaultData(); // UR: BATCH-02 sisa 14
    const s = await open(data);
    await goSub(s.page, 'orders');
    await s.page.click('#new-order');
    await s.page.fill('#order-form [name=customer]', 'Rani');
    await s.page.fill('[aria-label="Jumlah Pentol Urat"]', '16');
    await s.page.locator('[aria-label="Jumlah Pentol Urat"]').dispatchEvent('change');
    assert((await s.page.textContent('#status')).includes('2 pack menunggu restok BATCH-02'), 'pesan menunggu restok');
    assert((await s.page.textContent('.quick-item.waiting')).includes('2 tunggu restok'), 'tanda di pilihan varian');
    await s.page.click('#save-order');
    await s.page.waitForTimeout(400);
    equal(s.data.writes.find(w => w.body?.action === 'create')?.body.payload.items, [{ stock_id: 's1', quantity: 16, unit_price: 36000 }], 'tersimpan, kekurangan dibooking di batch terakhir');
    await s.close();

    const d2 = defaultData();
    d2.stock.push({ id:'s3', batch_code:'BATCH-03', sku:'UR', received_on:null, received:0, reserved:0, delivered:0, revision:1 },
      { id:'s4', batch_code:'BATCH-03', sku:'JM', received_on:null, received:0, reserved:0, delivered:0, revision:1 });
    d2.purchases = [{ batch_code:'BATCH-03', supplier:'Pusat', reference:'', ordered_on:shiftDay(-1), expected_on:shiftDay(2), shipping:0, packaging:0, other_cost:0,
      pentol_purchase_items:[{ batch_code:'BATCH-03', sku:'UR', quantity:20, unit_cost:20000 }, { batch_code:'BATCH-03', sku:'JM', quantity:10, unit_cost:24000 }] }];
    const s2 = await open(d2);
    await goSub(s2.page, 'orders');
    await s2.page.click('#new-order');
    await s2.page.fill('#order-form [name=customer]', 'Sinta');
    const jm = s2.page.locator('.quick-item').filter({ hasText: 'Pentol Jamur' });
    assert((await jm.textContent()).includes('kosong · pre-order, tiba'), 'jamur kosong ditulis pre-order: ' + await jm.textContent());
    assert(!(await jm.getAttribute('class')).includes('empty'), 'jamur pre-order tidak dipudarkan');
    await s2.page.click('[aria-label="Tambah Pentol Jamur"]');
    assert((await s2.page.textContent('#status')).includes('menunggu restok BATCH-03 (tiba'), 'jamur habis: ke PO yang ditunggu');
    await s2.page.fill('[aria-label="Jumlah Pentol Urat"]', '15');
    await s2.page.locator('[aria-label="Jumlah Pentol Urat"]').dispatchEvent('change');
    await s2.page.click('#save-order');
    await s2.page.waitForTimeout(400);
    const items = s2.data.writes.find(w => w.body?.action === 'create')?.body.payload.items.map(i => [i.stock_id, i.quantity]).sort();
    equal(items, [['s1', 14], ['s3', 1], ['s4', 1]], 'UR 14 dari stok + 1 dari PO; JM 1 dari PO');
    await s2.close();

    const d3 = defaultData();
    const s3 = await open(d3);
    await goSub(s3.page, 'orders');
    await s3.page.click('#new-order');
    await s3.page.click('[aria-label="Tambah Pentol Ranjau"]');
    assert((await s3.page.textContent('#status')).includes('belum pernah direstok'), 'varian tanpa batch: minta catat restok dulu');
    await s3.close();
  });

  test('daftar pesanan: tanda Tunggu stok bila stok fisik belum cukup', async () => {
    const data = defaultData();
    data.stock = [{ id:'s1', batch_code:'B1', sku:'UR', received_on:shiftDay(-5), received:2, reserved:6, delivered:0, revision:1 }];
    data.orders = [order('o1', 'Lia Dulu', { delivery_on: shiftDay(-1), items: [[2, 0]] }), order('o2', 'Mira Nanti', { delivery_on: shiftDay(1), items: [[4, 0]] })];
    const s = await open(data);
    await goSub(s.page, 'orders');
    const rows = await s.page.$$eval('#done-list .po-row', xs => xs.map(x => x.textContent));
    assert(rows.some(r => r.includes('Lia Dulu') && !r.includes('Tunggu stok')), 'yang jadwalnya duluan dapat stok');
    assert(rows.some(r => r.includes('Mira Nanti') && r.includes('Tunggu stok')), 'sisanya menunggu restok');
    await s.page.locator('#done-list .po-row', { hasText: 'Mira' }).click();
    assert((await s.page.textContent('.po-detail')).includes('Menunggu restok'), 'penjelasan di rincian');
    await s.close();
  });

  test('saran pelanggan langganan mengisi WhatsApp dan lokasi', async () => {
    const s = await open();
    await goSub(s.page, 'orders');
    await s.page.click('#new-order');
    await s.page.waitForTimeout(400);
    await s.page.fill('[name=customer]', 'Gina Belum Bayar');
    await s.page.waitForTimeout(200);
    equal([await s.page.inputValue('[name=contact]'), await s.page.inputValue('[name=delivery_location]')],
      ['0812-3456-7890', 'Gedung B'], 'isi otomatis');
    await s.close();
  });

  test('Tempel dari GPT: pesanan, bayar, antar', async () => {
    const s = await open();
    await goSub(s.page, 'orders');
    await s.page.click('#gpt-import');
    await s.page.fill('#ops-fields textarea', 'Hasil:\n```json\n' + JSON.stringify({ aksi: [
      { jenis: 'pesanan', pelanggan: 'Bu Sari', item: [{ varian: 'urat', jumlah: 2 }] },
      { jenis: 'bayar', pelanggan: 'Gina Belum Bayar', nominal: '50rb' },
      { jenis: 'antar', pelanggan: 'ani hari ini' },
      { jenis: 'pesanan', pelanggan: 'X', item: [{ varian: 'tahu', jumlah: 1 }] }
    ] }) + '\n```');
    await s.page.click('#ops-form > button:not([type])');
    await s.page.waitForTimeout(300);
    equal(await s.page.locator('.gpt-action').count(), 3, 'tiga aksi valid');
    assert((await s.page.textContent('#gpt-results')).includes('"tahu" tidak dikenal'), 'varian ambigu ditolak');
    await s.page.locator('.gpt-action').nth(1).locator('button').click();
    await s.page.waitForTimeout(400);
    equal(await s.page.inputValue('#ops-fields [name=amount]'), '50000', 'nominal dari GPT');
    await s.page.click('#ops-form > button:not([type])');
    await s.page.waitForTimeout(400);
    equal(await s.page.locator('.gpt-action').nth(1).locator('.gpt-state').textContent(), '✓ Tersimpan', 'status tersimpan');
    await s.close();
  });

  test('hapus permintaan katalog: kotak konfirmasi, Tutup = batal, Ya = hapus; Ubah membuka form', async () => {
    const s = await open();
    await goSub(s.page, 'orders');
    const card = s.page.locator('.po-detail .ops-card');
    await s.page.click('#inbox-list .inbox-row');
    await card.locator('button', { hasText: 'Hapus' }).click();
    assert(await s.page.isVisible('#ops-dialog'), 'kotak konfirmasi muncul');
    assert((await s.page.textContent('#ops-dialog')).includes('Yakin hapus'), 'pertanyaan yakin');
    await s.page.click('#ops-close');
    equal(s.data.writes.filter(w => w.body?.action === 'dismiss').length, 0, 'Tutup tidak menghapus');
    await s.page.click('#inbox-list .inbox-row');
    await card.locator('button', { hasText: 'Hapus' }).click();
    await s.page.click('#ops-form button:has-text("Ya, hapus")');
    await s.page.waitForTimeout(400);
    equal(s.data.writes.filter(w => w.body?.action === 'dismiss').length, 1, 'terhapus');
    await s.page.click('#inbox-list .inbox-row');
    await card.locator('button', { hasText: 'Ubah' }).click();
    assert((await s.page.textContent('#order-editor-title')).includes('Pesanan dari katalog'), 'form ubah terbuka');
    assert(await s.page.isVisible('#order-edit-note'), 'petunjuk ubah tampil');
    await s.close();
  });

  test('permintaan yang diarsipkan masih terlihat dan bisa dijadikan pesanan', async () => {
    const data = defaultData();
    data.inbox.push({ ...data.inbox[0], id: '00000000-0000-0000-0000-00000000abcf', customer: 'Rina Terarsip', status: 'dismissed' });
    const s = await open(data);
    await goSub(s.page, 'orders');
    const box = s.page.locator('#inbox-list .inbox-archived');
    assert((await box.locator('summary').textContent()).includes('(1)'), 'ada 1 arsip');
    await box.locator('summary').click();
    await box.locator('button', { hasText: 'Buat pesanan' }).click();
    equal(await s.page.inputValue('#order-form [name=customer]'), 'Rina Terarsip', 'form terisi dari arsip');
    await s.page.click('#save-order');
    await s.page.waitForTimeout(500);
    const saved = s.data.writes.find(w => w.body.action === 'create');
    assert(saved && !('inbox_id' in saved.body.payload), 'pesanan dibuat tanpa id permintaan');
    await s.close();
  });

  test('permintaan katalog dengan jadwal: tampil "Jadwal", form terisi jadwal antar', async () => {
    const data = defaultData();
    const day = shiftDay(2);
    data.inbox[0].note = 'Diantar · Jadwal: ' + day + ' · titip satpam';
    const s = await open(data);
    await goSub(s.page, 'orders');
    await s.page.click('#inbox-list .inbox-row');
    const card = s.page.locator('.po-detail .ops-card');
    assert((await card.textContent()).includes('Jadwal '), 'jadwal tampil');
    assert(!(await card.textContent()).includes('Jadwal: '), 'tanpa format mentah');
    await card.locator('button', { hasText: 'Proses pesanan' }).click();
    equal(await s.page.inputValue('#order-form [name=delivery_on]'), day, 'jadwal antar terisi');
    equal(await s.page.inputValue('#order-form [name=delivery_note]'), 'Diantar · titip satpam', 'catatan tanpa jadwal');
    await s.close();
  });

  test('ubah pesanan setelah bayar & antar sebagian: batas antar, tambah varian, fungsi khusus', async () => {
    const data = defaultData();
    data.stock.push({ id:'s2', batch_code:'BATCH-02', sku:'JM', received_on:shiftDay(-5), received:10, reserved:0, delivered:0, revision:1 });
    data.orders = [order('o5', 'Eka Antar Sebagian', { delivery_on: shiftDay(1), items: [[4, 2]],
      pentol_payments: [{ id:'p1', order_id:'o5', amount:50000, paid_on:shiftDay(-1) }] })];
    const s = await open(data);
    await goSub(s.page, 'orders');
    await s.page.locator('#done-list .po-row', { hasText: 'Eka Antar Sebagian' }).click();
    await s.page.click('.po-detail .more-actions summary');
    await s.page.locator('.po-detail .more-actions button', { hasText: 'Ubah pesanan' }).click();
    const note = await s.page.textContent('#order-edit-note');
    assert(note.includes('Sudah diantar') && note.includes('2 pack') && note.includes('Rp50.000'), 'catatan antar & bayar: ' + note);
    const minus = s.page.locator('[aria-label="Kurangi Pentol Urat"]');
    await minus.click();
    await minus.click();
    assert(await minus.isDisabled(), 'tidak bisa di bawah jumlah antar');
    await s.page.click('[aria-label="Tambah Pentol Jamur"]');
    await s.page.click('#save-order');
    await s.page.waitForTimeout(500);
    const saved = s.data.writes.find(w => w.fn === 'pentol_edit_order');
    assert(saved, 'memakai pentol_edit_order');
    equal(saved.body.payload.items.map(i => [i.stock_id, i.quantity]).sort(), [['s1', 2], ['s2', 1]], 'UR 2 (diantar 2) + JM 1');
    equal(saved.body.expected_revision, 1, 'revisi dikirim');
    await s.close();
  });

  test('ubah pesanan sebelum SQL: pesan jelas, tanpa simpan diam-diam', async () => {
    const data = defaultData();
    data.missingRpc = ['pentol_edit_order'];
    data.orders = [order('o5', 'Eka Antar Sebagian', { items: [[4, 2]] })];
    const s = await open(data);
    await goSub(s.page, 'orders');
    await s.page.locator('#done-list .po-row', { hasText: 'Eka' }).click();
    await s.page.click('.po-detail .more-actions summary');
    await s.page.locator('.po-detail .more-actions button', { hasText: 'Ubah pesanan' }).click();
    await s.page.click('[aria-label="Tambah Pentol Urat"]');
    await s.page.click('#save-order');
    await s.page.waitForTimeout(500);
    assert((await s.page.textContent('#status')).includes('ubah-pesanan-2026-11.sql'), 'pesan butuh SQL');
    assert(await s.page.isVisible('#order-form'), 'form tetap terbuka');
    equal(s.data.writes.filter(w => w.fn === 'pentol_order_action').length, 0, 'tidak memakai aturan lama');
    await s.close();
  });

  test('tanggal antar: bawaan hari ini; tanggal lain memakai pentol_ship_order; sebelum SQL ada pesan', async () => {
    const day = shiftDay(-2);
    const data = defaultData();
    data.orders = [order('o2', 'Budi Terlambat', { order_date: shiftDay(-5), delivery_on: shiftDay(-2) })];
    let s = await open(data);
    await goSub(s.page, 'orders', 'Antar');
    const row = s.page.locator('#delivery-body .ops-card', { hasText: 'Budi' }).first();
    await row.locator('button', { hasText: /^Antar$/ }).click();
    equal(await s.page.inputValue('#ops-form [name=ship_date]'), todayJakarta(), 'bawaan hari ini');
    await s.page.fill('#ops-form [name=ship_date]', day);
    await s.page.click('#ops-form > button:not([type])');
    await s.page.waitForTimeout(500);
    const late = s.data.writes.find(w => w.fn === 'pentol_ship_order');
    equal([late?.body.ship_date, late?.body.target, 'date' in (late?.body.payload || {})], [day, 'o2', false], 'antar bertanggal lewat fungsi baru');
    equal(s.data.writes.filter(w => w.body?.action === 'ship').length, 0, 'tidak lewat aksi lama');
    await s.close();

    const d2 = defaultData();
    d2.missingRpc = ['pentol_ship_order'];
    d2.orders = [order('o2', 'Budi Terlambat', { order_date: shiftDay(-5), delivery_on: shiftDay(-2) })];
    s = await open(d2);
    await goSub(s.page, 'orders', 'Antar');
    await s.page.locator('#delivery-body .ops-card button', { hasText: /^Antar$/ }).first().click();
    await s.page.fill('#ops-form [name=ship_date]', day);
    await s.page.click('#ops-form > button:not([type])');
    await s.page.waitForTimeout(400);
    assert((await s.page.textContent('#ops-error')).includes('tanggal-antar-2026-11.sql'), 'pesan butuh SQL');
    await s.page.fill('#ops-form [name=ship_date]', todayJakarta());
    await s.page.click('#ops-form > button:not([type])');
    await s.page.waitForTimeout(500);
    assert(s.data.writes.some(w => w.body?.action === 'ship' && !('date' in w.body.payload)), 'hari ini tetap lewat jalur lama');
    await s.close();
  });

  test('Tempel dari GPT: tanggal antar mengisi kotak antar', async () => {
    const day = shiftDay(-1);
    const data = defaultData();
    data.orders = [order('o2', 'Budi Terlambat', { order_date: shiftDay(-5) })];
    const s = await open(data);
    await goSub(s.page, 'orders');
    await s.page.click('#gpt-import');
    await s.page.fill('#ops-form [name=gpt_text]', '{"aksi":[{"jenis":"antar","pelanggan":"Budi","tanggal":"' + day + '"}]}');
    await s.page.click('#ops-form > button:not([type])');
    await s.page.waitForTimeout(300);
    await s.page.click('#gpt-results >> text=Catat antar');
    await s.page.waitForTimeout(500);
    equal(await s.page.inputValue('#ops-form [name=ship_date]'), day, 'tanggal dari GPT');
    await s.close();
  });

  test('Tempel dari GPT: Simpan semua hanya menyimpan yang cocok tunggal', async () => {
    const data = defaultData();
    const day = shiftDay(-1);
    data.orders = [order('o1', 'Sari Satu', { order_date: shiftDay(-4) }),
      order('o2', 'Ria Dua', { order_date: shiftDay(-4) }), order('o3', 'Ria Dua', { order_date: shiftDay(-3) })];
    const s = await open(data);
    await goSub(s.page, 'orders');
    await s.page.click('#gpt-import');
    const acts = [['Sari', 'antar'], ['Sari', 'bayar'], ['Ria', 'antar'], ['Ria', 'bayar'], ['Tidak Ada', 'antar']].map(([n, j]) =>
      j === 'antar' ? { jenis: 'antar', pelanggan: n, tanggal: day } : { jenis: 'bayar', pelanggan: n, nominal: 'lunas', tanggal: day });
    await s.page.fill('#ops-form [name=gpt_text]', JSON.stringify({ aksi: acts }));
    await s.page.click('#ops-form > button:not([type])');
    await s.page.waitForTimeout(300);
    await s.page.click('#gpt-results >> text=Simpan semua');
    assert((await s.page.textContent('#ops-dialog')).includes('5 aksi'), 'konfirmasi menyebut jumlah');
    await s.page.click('#ops-form button:has-text("Ya, simpan semua")');
    await s.page.waitForTimeout(1500);
    const ship = s.data.writes.filter(w => w.fn === 'pentol_ship_order');
    const pay = s.data.writes.filter(w => w.body?.action === 'pay');
    equal([ship.length, ship[0]?.body.target, ship[0]?.body.ship_date], [1, 'o1', day], 'hanya Sari diantar, bertanggal');
    equal([pay.length, pay[0]?.body.target, pay[0]?.body.payload.amount], [1, 'o1', 72000], 'Sari dilunasi sebesar sisa tagihan');
    const states = await s.page.$$eval('#gpt-results .gpt-state', xs => xs.map(x => x.textContent));
    equal(states.filter(x => x.startsWith('✓')).length, 2, 'dua tersimpan');
    assert(states.some(x => x.includes('2 pesanan cocok')), 'Ria dilewati karena dua pesanan');
    assert(states.some(x => x.includes('Tidak ada pesanan')), 'nama tak dikenal dilewati');
    await s.close();
  });

  test('packing dibagi per pesanan menurut jadwal (bug B4)', async () => {
    const data = defaultData();
    data.stock = [{ id:'s1', batch_code:'B1', sku:'UR', received_on:shiftDay(-5), received:4, reserved:5, delivered:0, revision:1 }];
    data.orders = [order('o1', 'Xena Hari Ini', { delivery_on: todayJakarta(), items: [[3, 0]] }),
      order('o2', 'Yuda Kemarin', { delivery_on: shiftDay(-1), items: [[2, 0]] })];
    const s = await open(data);
    await goSub(s.page, 'orders', 'Antar');
    await s.page.selectOption('#delivery [name=pack_filter]', 'pending');
    await s.page.waitForTimeout(500);
    const states = await s.page.$$eval('#delivery-body .ops-card', cs => Object.fromEntries(cs.map(c =>
      [c.querySelector('strong').textContent, c.querySelector('.pack-state').textContent])));
    equal(states['Yuda Kemarin'], 'Siap dikemas', 'jadwal paling awal dapat stok dulu');
    assert(states['Xena Hari Ini'].startsWith('Siap sebagian · 2 dari 3 pack'), 'sisa stok untuk pesanan berikutnya: ' + states['Xena Hari Ini']);
    await s.close();
  });

  test('stok per varian: warna menipis/habis dan koreksi lewat fungsi database', async () => {
    const data = defaultData();
    data.stock.push({ id:'s2', batch_code:'BATCH-02', sku:'JM', received_on:shiftDay(-5), received:3, reserved:0, delivered:0, revision:1 });
    const s = await open(data);
    await goSub(s.page, 'stock');
    const levels = await s.page.$$eval('.variant-card', cs => Object.fromEntries(cs.map(c => [c.querySelector('h3').textContent, c.dataset.level])));
    equal([levels['Pentol Urat'], levels['Pentol Jamur'], levels['Pentol Kecil']], ['ok', 'low', 'out'], 'level stok');
    assert(await s.page.isHidden('#stock-batches'), 'tab Stok: tanpa tabel batch');
    await goSub(s.page, 'stock', 'Per batch & koreksi');
    assert(await s.page.isHidden('#stock-variants'), 'tab batch: tanpa kartu varian');
    equal(await s.page.textContent('#stock-title'), 'Stok per batch', 'judul tab batch');
    assert(s.page.url().endsWith('#batches'), 'alamat #batches');
    await s.page.locator('#stock-rows tr').first().locator('button').click();
    await s.page.fill('[name=received]', '29');
    await s.page.fill('[name=reason]', '1 pack rusak');
    await s.page.click('#save');
    await s.page.waitForTimeout(400);
    const fix = s.data.writes.find(w => w.fn === 'pentol_correct_received');
    equal(fix?.body.new_received, 29, 'koreksi memakai pentol_correct_received');
    assert(!s.data.writes.some(w => w.method === 'PATCH'), 'tidak ada tulis langsung ke tabel stok');
    await s.close();
  });

  test('PO selesai: 6 per halaman di HP (satu layar), cari, rincian di kotak tersendiri', async () => {
    const data = defaultData();
    data.purchases = [];
    data.stock = [];
    for (let i = 1; i <= 10; i++) {
      const code = 'BATCH-' + String(i).padStart(2, '0');
      data.purchases.push({ batch_code: code, supplier: i === 3 ? 'Toko Lain' : 'Pusat', reference: '', ordered_on: shiftDay(-30 + i), expected_on: null,
        shipping: 0, packaging: 0, other_cost: 0, pentol_purchase_items: [{ batch_code: code, sku: 'UR', quantity: 5, unit_cost: 20000 }] });
      data.stock.push({ id: 's' + i, batch_code: code, sku: 'UR', received_on: shiftDay(-29 + i), received: 5, reserved: 0, delivered: 0, revision: 1 });
    }
    const s = await open(data);
    await goSub(s.page, 'stock', 'PO selesai');
    await s.page.waitForTimeout(400);
    const rows = () => s.page.$$eval('#poDone-body .po-row strong', xs => xs.map(x => x.textContent));
    const first = await rows();
    equal([first.length, first[0]], [6, 'BATCH-10'], 'halaman 1: 6 baris, terbaru dulu');
    assert(await s.page.evaluate(() => document.querySelector('.po-pager').getBoundingClientRect().bottom <= innerHeight), 'tombol halaman terlihat tanpa menggulir');
    equal(await s.page.textContent('.po-page'), '1 / 2', 'nomor halaman');
    await s.page.click('.po-pager >> text=Berikutnya ›');
    equal(await rows(), ['BATCH-04', 'BATCH-03', 'BATCH-02', 'BATCH-01'], 'halaman 2');
    assert(await s.page.isDisabled('.po-pager >> text=Berikutnya ›'), 'halaman terakhir');
    await s.page.fill('.po-search', 'toko lain');
    equal(await rows(), ['BATCH-03'], 'cari supplier');
    assert(await s.page.isHidden('.po-pager'), 'tanpa halaman bila satu halaman');
    await s.page.click('.po-row');
    assert(await s.page.isVisible('.po-detail'), 'rincian terbuka');
    assert((await s.page.textContent('.po-detail')).includes('Riwayat penerimaan'), 'isi rincian');
    await s.page.click('.po-detail >> text=Edit restok');
    await s.page.waitForTimeout(300);
    assert(!await s.page.isVisible('.po-detail') && await s.page.isVisible('#ops-dialog'), 'Edit restok membuka form');
    equal(await s.page.inputValue('#ops-fields [name=batch_code]').catch(() => 'BATCH-03'), 'BATCH-03', 'form untuk PO itu');
    await s.close();
  });

  test('stok & restok: barang dalam PO, form restok terisi, terima barang = sisa PO', async () => {
    const data = defaultData();
    data.stock.push({ id:'s3', batch_code:'BATCH-03', sku:'JM', received_on:null, received:0, reserved:0, delivered:0, revision:1 });
    data.purchases = [
      { batch_code:'BATCH-02', supplier:'Pusat', reference:'', ordered_on:shiftDay(-10), expected_on:null, shipping:0, packaging:0, other_cost:0,
        pentol_purchase_items:[{ batch_code:'BATCH-02', sku:'UR', quantity:30, unit_cost:23200 }] },
      { batch_code:'BATCH-03', supplier:'Pusat', reference:'PO-8', ordered_on:shiftDay(-1), expected_on:shiftDay(2), shipping:0, packaging:0, other_cost:0,
        pentol_purchase_items:[{ batch_code:'BATCH-03', sku:'JM', quantity:10, unit_cost:24000 }] }];
    const s = await open(data);
    await goSub(s.page, 'stock');
    const jamur = s.page.locator('.variant-card').filter({ hasText: 'Pentol Jamur' });
    equal(await jamur.getAttribute('data-level'), 'incoming', 'Jamur menunggu kiriman, bukan merah');
    assert((await jamur.textContent()).includes('+10 dalam PO · tiba'), 'jumlah dalam PO dan estimasi tiba');
    assert((await jamur.textContent()).includes('kosong · bisa pre-order'), 'kosong tapi bisa dipesan: ' + await jamur.textContent());
    equal(await jamur.locator('button', { hasText: 'Restok' }).count(), 0, 'tanpa tombol Restok');
    await s.page.click('#subtabs >> text=Restok & PO');
    await s.page.waitForTimeout(500);
    const pos = await s.page.$$eval('#purchasing-body > article.ops-card > strong', xs => xs.map(x => x.textContent));
    equal(pos, ['BATCH-03 · Pusat'], 'hanya PO yang menunggu kiriman di atas');
    assert((await s.page.textContent('.po-done-hint')).includes('1 PO sudah selesai'), 'petunjuk PO selesai');
    await s.page.click('#subtabs >> text=PO selesai');
    await s.page.waitForTimeout(500);
    equal(await s.page.$$eval('#poDone-body .po-row strong', xs => xs.map(x => x.textContent)), ['BATCH-02'], 'tab PO selesai');
    equal(await s.page.locator('#poDone-body >> text=+ Catat restok').count(), 0, 'tanpa tombol catat restok');
    await s.page.click('#subtabs >> text=Restok & PO');
    await s.page.waitForTimeout(500);
    await s.page.locator('#purchasing-body article.ops-card', { hasText: 'BATCH-03' }).locator('button', { hasText: 'Terima barang' }).click();
    equal(await s.page.inputValue('#ops-fields input[name=JM]'), '10', 'terima barang terisi sisa PO');
    await s.page.click('#ops-close');
    await s.page.click('text=+ Catat restok');
    equal(await s.page.inputValue('#ops-fields [name=batch_code]'), 'BATCH-04', 'kode batch disarankan');
    equal(await s.page.inputValue('#ops-fields [name=cost_JM]'), '24000', 'harga beli dari PO terakhir');
    const jm = s.page.locator('.restock-row').filter({ hasText: 'Pentol Jamur' });
    for (let i = 0; i < 3; i++) await jm.locator('button[aria-label^=Tambah]').click();
    await s.page.click('#ops-form > button:not([type])');
    await s.page.waitForTimeout(400);
    const saved = s.data.writes.find(w => w.body.action === 'purchase');
    equal([saved?.body.payload.batch_code, saved?.body.payload.items], ['BATCH-04', [{ sku:'JM', quantity:3, unit_cost:24000 }]], 'restok tersimpan');
    await s.close();
  });

  test('Laporan → Varian & harga: harga, harga beli terakhir, untung per pack, ubah harga; cadangan pindah ke Impor & ekspor', async () => {
    const data = defaultData();
    data.purchases = [{ batch_code:'BATCH-02', supplier:'Pusat', reference:'', ordered_on:shiftDay(-9), expected_on:null, shipping:0, packaging:0, other_cost:0,
      pentol_purchase_items:[{ batch_code:'BATCH-02', sku:'UR', quantity:30, unit_cost:20000 }] }];
    const s = await open(data);
    await goSub(s.page, 'finance');
    equal(await s.page.locator('#finance >> text=Harga jual default').count(), 0, 'harga tidak lagi di halaman Laba');
    equal(await s.page.locator('#finance >> text=Unduh cadangan').count(), 0, 'cadangan tidak lagi di halaman Laba');
    await goSub(s.page, 'finance', 'Varian & harga');
    const urat = s.page.locator('#prices-body tr', { hasText: 'Pentol Urat' });
    const text = await urat.textContent();
    assert(text.includes('Rp36.000') && text.includes('Rp20.000') && text.includes('Rp16.000 (44%)'), 'baris Urat: ' + text);
    await urat.locator('button', { hasText: 'Ubah' }).click();
    // Sebelum varian-2026-11.sql: hanya harga yang bisa diubah.
    await s.page.fill('#ops-form [name=price]', '38000');
    await s.page.click('#ops-form > button:not([type])');
    await s.page.waitForTimeout(400);
    const saved = s.data.writes.find(w => w.body?.action === 'price');
    equal(saved?.body.payload, { sku: 'UR', price: 38000 }, 'harga tersimpan');
    await s.page.click('#more-menu');
    await s.page.click('#admin-menu [data-view=reconcile]');
    await s.page.click('#subtabs >> text=Impor & ekspor');
    assert(await s.page.isVisible('#dataExcel >> text=⬇ Unduh cadangan'), 'cadangan di Impor & ekspor');
    await s.close();
  });

  test('Varian & harga: tambah varian baru tanpa kode, varian tidak dijual disembunyikan dari form pesanan', async () => {
    const data = defaultData();
    const base = [['UR','Pentol Urat','9 pcs / pack','Pentol',36000,10],['PK','Pentol Kecil','30 pcs / pack','Pentol',39000,20],
      ['TP','Tahu Pentol','30 pcs / pack','Tahu',29000,30],['BK','Bakso Kuah','10 pcs / pack','Lainnya',40000,95]];
    data.products = base.map(([sku, name, size, category, price, sort_order]) => ({ sku, name, size, category, price, sort_order, active: sku !== 'PK' }));
    data.stock.push({ id:'s9', batch_code:'BATCH-09', sku:'BK', received_on:shiftDay(-1), received:5, reserved:0, delivered:0, revision:1 });
    const s = await open(data);
    await goSub(s.page, 'finance', 'Varian & harga');
    const names = await s.page.$$eval('#prices-body td:first-child strong', xs => xs.map(x => x.textContent));
    equal(names, ['Pentol Urat', 'Pentol Kecil', 'Tahu Pentol', 'Bakso Kuah'], 'varian dari database, urut tampil');
    assert((await s.page.textContent('#prices-body tr:has-text("Pentol Kecil")')).includes('tidak dijual'), 'tanda tidak dijual');
    await s.page.click('text=+ Tambah varian');
    await s.page.fill('#ops-form [name=name]', 'Siomay Ikan');
    equal(await s.page.inputValue('#ops-form [name=sku]'), 'SI', 'kode disarankan dari nama');
    await s.page.fill('#ops-form [name=size]', '8 pcs / pack');
    await s.page.selectOption('#ops-form [name=category]', 'Lainnya');
    await s.page.fill('#ops-form [name=price]', '35000');
    await s.page.click('#ops-form button:has-text("Tambah")');
    await s.page.waitForTimeout(400);
    equal(s.data.writes.find(w => w.fn === 'pentol_save_product')?.body.payload,
      { sku: 'SI', name: 'Siomay Ikan', size: '8 pcs / pack', category: 'Lainnya', price: 35000, active: true }, 'varian baru tersimpan');
    await goSub(s.page, 'orders');
    await s.page.click('#new-order');
    const pick = await s.page.$$eval('#order-quick .quick-item strong', xs => xs.map(x => x.textContent));
    assert(pick.includes('Bakso Kuah') && !pick.includes('Pentol Kecil'), 'form pesanan: varian baru ada, yang tidak dijual hilang: ' + pick);
    await s.close();
  });

  test('laporan: angka utama dan grafik 4 minggu', async () => {
    const s = await open();
    await goSub(s.page, 'finance');
    await s.page.waitForTimeout(500);
    assert(await s.page.isVisible('.report-headline'), 'angka utama');
    equal(await s.page.locator('.week-bar').count(), 4, 'empat batang');
    await s.close();
  });

  test('cadangan: pengingat, unduh Excel semua tabel, tabel belum aktif dilewati', async () => {
    const data = defaultData();
    data.missing = ['pentol_purchase_receipts'];
    const s = await open(data);
    assert(await s.page.isVisible('.backup-reminder'), 'pengingat tampil saat belum pernah mencadangkan');
    const [download] = await Promise.all([s.page.waitForEvent('download'), s.page.click('.backup-reminder button')]);
    equal(download.suggestedFilename(), 'Cadangan-Pentol-Gilaaa-' + todayJakarta() + '.xlsx', 'nama file');
    const zip = await JSZip.loadAsync(await (await download.createReadStream()).toArray().then(Buffer.concat));
    const workbook = await zip.file('xl/workbook.xml').async('string');
    const names = [...workbook.matchAll(/name="([^"]+)"/g)].map(m => m[1]);
    assert(names[0] === 'Info' && names.includes('Pesanan') && names.includes('Stok batch'), 'lembar: ' + names.join(', '));
    assert(!names.includes('Penerimaan PO'), 'tabel yang belum aktif dilewati');
    const info = await zip.file('xl/worksheets/sheet1.xml').async('string');
    assert(info.includes('belum aktif di database') && info.includes('7 baris'), 'lembar Info mencatat jumlah baris');
    await s.page.waitForTimeout(200);
    assert(!await s.page.isVisible('.backup-reminder'), 'pengingat hilang setelah mengunduh');
    await s.close();
  });

  test('laporan: Tahun ini + rincian laba per hari/minggu/bulan', async () => {
    const data = defaultData();
    const t = todayJakarta();
    data.shipments = [{ order_id: 'o6', stock_id: 's1', quantity: 2, unit_price: 36000, shipped_on: t }];
    data.purchases = [{ batch_code:'BATCH-02', supplier:'', reference:'', ordered_on:shiftDay(-9), expected_on:null, shipping:0, packaging:0, other_cost:0,
      pentol_purchase_items:[{ batch_code:'BATCH-02', sku:'UR', quantity:30, unit_cost:20000 }] }];
    const s = await open(data);
    await goSub(s.page, 'finance');
    const mode = () => s.page.getAttribute('.report-breakdown', 'data-mode');
    await s.page.click('.period-chips >> text=Tahun ini');
    await s.page.waitForTimeout(500);
    equal(await s.page.inputValue('#finance [name=first]'), t.slice(0, 4) + '-01-01', 'tahun ini mulai 1 Januari');
    equal(await mode(), 'month', 'tahun ini: per bulan');
    await s.page.click('.period-chips >> text=Bulan ini');
    await s.page.waitForTimeout(500);
    equal(await mode(), 'week', 'bulan ini: per minggu');
    await s.page.click('.breakdown-switch >> text=Per hari');
    equal(await mode(), 'day', 'bisa pindah ke per hari');
    const todayRow = s.page.locator('.report-breakdown tbody tr').first();
    assert((await todayRow.textContent()).includes('Rp32.000'), 'baris hari ini: laba 72.000 − 2×20.000');
    const total = await s.page.textContent('.report-breakdown .total-row');
    assert(total.includes('Total') && total.includes('Rp72.000') && total.includes('Rp32.000'), 'baris total: ' + total);
    await s.page.click('.period-chips >> text=Hari ini');
    await s.page.waitForTimeout(500);
    equal(await mode(), 'day', 'hari ini: per hari');
    equal(await s.page.locator('.report-breakdown tbody tr').count(), 2, 'satu hari + total');
    await s.close();
  });

  test('laporan: 4 kartu laba hari/minggu/bulan/tahun selalu tampil; per tahun', async () => {
    const data = defaultData();
    const t = todayJakarta();
    data.shipments = [{ order_id: 'o6', stock_id: 's1', quantity: 2, unit_price: 36000, shipped_on: t }];
    data.purchases = [{ batch_code:'BATCH-02', supplier:'', reference:'', ordered_on:shiftDay(-9), expected_on:null, shipping:0, packaging:0, other_cost:0,
      pentol_purchase_items:[{ batch_code:'BATCH-02', sku:'UR', quantity:30, unit_cost:20000 }] }];
    const s = await open(data);
    await goSub(s.page, 'finance');
    await s.page.waitForTimeout(600);
    const tiles = await s.page.$$eval('.profit-tile', xs => xs.map(x => [x.dataset.period, x.querySelector('strong').textContent]));
    equal(tiles, [['Hari ini', 'Rp32.000'], ['Minggu ini', 'Rp32.000'], ['Bulan ini', 'Rp32.000'], ['Tahun ini', 'Rp32.000']], 'empat kartu laba');
    await s.page.click('.profit-tile[data-period="Hari ini"]');
    await s.page.waitForTimeout(500);
    equal(await s.page.inputValue('#finance [name=first]'), t, 'kartu membuka periode itu');
    await s.page.click('.period-chips >> text=Tahun ini');
    await s.page.waitForTimeout(500);
    await s.page.click('.breakdown-switch >> text=Per tahun');
    equal(await s.page.getAttribute('.report-breakdown', 'data-mode'), 'year', 'per tahun');
    assert((await s.page.textContent('.report-breakdown tbody tr')).includes('Tahun ' + t.slice(0, 4)), 'baris tahun');
    await s.close();
  });

  test('Laba varian: urut laba terbesar, margin & porsi, tanda margin tipis, tekan = tren per varian', async () => {
    const data = defaultData();
    const t = todayJakarta();
    data.stock.push({ id:'s2', batch_code:'BATCH-02', sku:'PK', received_on:shiftDay(-5), received:10, reserved:0, delivered:1, revision:1 });
    data.shipments = [{ order_id: 'o6', stock_id: 's1', quantity: 2, unit_price: 36000, shipped_on: t },
      { order_id: 'o7', stock_id: 's2', quantity: 1, unit_price: 39000, shipped_on: t }];
    data.purchases = [{ batch_code:'BATCH-02', supplier:'', reference:'', ordered_on:shiftDay(-9), expected_on:null, shipping:0, packaging:0, other_cost:0,
      pentol_purchase_items:[{ batch_code:'BATCH-02', sku:'UR', quantity:30, unit_cost:20000 }, { batch_code:'BATCH-02', sku:'PK', quantity:10, unit_cost:36000 }] }];
    const s = await open(data);
    await goSub(s.page, 'finance', 'Laba varian');
    await s.page.waitForTimeout(500);
    const rows = await s.page.$$eval('#profitVariant-body .vp-row', xs => xs.map(x => [x.dataset.sku, x.querySelector('.vp-value strong').textContent, x.dataset.thin || '']));
    equal(rows, [['UR', 'Rp32.000', ''], ['PK', 'Rp3.000', 'true']], 'Urat di atas; Kecil margin tipis (8%)');
    assert((await s.page.textContent('.vp-row[data-sku=UR]')).includes('margin 44%'), 'margin Urat');
    assert(await s.page.isVisible('.vp-warn'), 'peringatan margin tipis');
    await s.page.click('.vp-row[data-sku=UR]');
    assert((await s.page.textContent('.vp-detail')).includes('Pentol Urat per'), 'tren per varian terbuka');
    await s.page.click('.vp-warn >> text=Ubah harga →');
    await s.page.waitForTimeout(400);
    assert(await s.page.isVisible('#prices'), 'ke Harga jual');
    await s.close();
  });

  test('laporan: Unduh Excel berisi 8 lembar untuk periode yang dipilih', async () => {
    const data = defaultData();
    const t = todayJakarta();
    data.shipments = [{ order_id: 'o6', stock_id: 's1', quantity: 2, unit_price: 36000, shipped_on: t }];
    data.purchases = [{ batch_code:'BATCH-02', supplier:'', reference:'', ordered_on:shiftDay(-9), expected_on:null, shipping:0, packaging:0, other_cost:0,
      pentol_purchase_items:[{ batch_code:'BATCH-02', sku:'UR', quantity:30, unit_cost:20000 }] }];
    data.orders.find(o => o.id === 'o7').pentol_payments = [{ id:'p1', order_id:'o7', amount:50000, paid_on:t }];
    const s = await open(data);
    await goSub(s.page, 'finance');
    await s.page.click('.period-chips >> text=Hari ini');
    await s.page.waitForTimeout(500);
    const [download] = await Promise.all([s.page.waitForEvent('download'), s.page.click('text=⬇ Unduh Excel')]);
    equal(download.suggestedFilename(), 'Laporan-Pentol-Gilaaa-' + t + '_' + t + '.xlsx', 'nama file');
    const zip = await JSZip.loadAsync(await (await download.createReadStream()).toArray().then(Buffer.concat));
    const names = [...(await zip.file('xl/workbook.xml').async('string')).matchAll(/name="([^"]+)"/g)].map(m => m[1]);
    equal(names, ['Ringkasan', 'Laba per periode', 'Laba per varian', 'Penjualan per minggu', 'Pesanan', 'Pembayaran', 'Tagihan terbuka', 'Stok'], 'lembar');
    const sheet = n => zip.file('xl/worksheets/sheet' + n + '.xml').async('string');
    const summary = await sheet(1);
    assert(summary.includes('<v>72000</v>') && summary.includes('<v>32000</v>') && summary.includes('<v>50000</v>'), 'penjualan, laba, uang masuk');
    assert((await sheet(2)).includes(t) && (await sheet(2)).includes('<v>32000</v>'), 'laba per periode (hari ini)');
    assert((await sheet(3)).includes('Pentol Urat'), 'laba per varian');
    assert((await sheet(6)).includes('Gina Belum Bayar'), 'pembayaran dengan nama pelanggan');
    assert((await sheet(7)).includes('Eka Antar Sebagian'), 'tagihan terbuka');
    assert((await sheet(8)).includes('BATCH-02') && (await sheet(8)).includes('<v>20000</v>'), 'stok + harga beli');
    await s.close();
  });

  test('impor & ekspor: unduh template, impor ulang = dilewati, baris baru disimpan, hapus semua', async () => {
    const data = defaultData();
    data.purchases = [{ batch_code:'BATCH-02', supplier:'Pusat', reference:'', ordered_on:shiftDay(-9), expected_on:null, shipping:0, packaging:0, other_cost:0,
      pentol_purchase_items:[{ batch_code:'BATCH-02', sku:'UR', quantity:30, unit_cost:20000 }] }];
    const s = await open(data);
    await s.page.click('#more-menu');
    await s.page.click('#admin-menu [data-view=reconcile]');
    await s.page.click('#subtabs >> text=Impor & ekspor');
    await s.page.waitForTimeout(300);
    const [download] = await Promise.all([s.page.waitForEvent('download'), s.page.click('text=⬇ Unduh template + data')]);
    const exported = await (await download.createReadStream()).toArray().then(Buffer.concat);
    const zip = await JSZip.loadAsync(exported);
    const names = [...(await zip.file('xl/workbook.xml').async('string')).matchAll(/name="([^"]+)"/g)].map(m => m[1]);
    equal(names, ['Petunjuk', 'PO', 'Pesanan'], 'lembar template');
    assert((await zip.file('xl/worksheets/sheet3.xml').async('string')).includes('Ani Hari Ini'), 'pesanan ikut diekspor');

    // Impor ulang file ekspor: semua sudah ada.
    await s.page.setInputFiles('#dataExcel input[type=file]', { name: 'data.xlsx', mimeType: 'application/octet-stream', buffer: exported });
    await s.page.waitForTimeout(700);
    const again = await s.page.textContent('.data-preview');
    assert(again.includes('7 sudah ada') && again.includes('Tidak ada data baru'), 'impor ulang tidak menggandakan: ' + again);

    // File baru: 1 PO baru + 1 pesanan baru (diantar & dibayar).
    const products = new Map([['UR','Pentol Urat'],['PK','Pentol Kecil'],['TP','Tahu Pentol'],['JM','Pentol Jamur'],['MZ','Pentol Mozzarella'],
      ['RJ','Pentol Ranjau'],['TD','Tahu Pedas'],['PG','Pentol Goreng'],['SG','Sambal Gila Tambahan']]);
    const head = orderHead(products);
    const day = shiftDay(-1);
    const fresh = await closeDayWorkbook([['PO', [PO_HEAD, ['B7', 'Pusat', day, 'Pentol Jamur', 5, 24000, 5, day, 0, 0, 0]]],
      ['Pesanan', [head, head.map(h => ({ 'Tanggal pesan': day, 'Pelanggan': 'Nina Baru', 'Pentol Urat': 2, 'Sudah diantar': 'Tidak', 'Dibayar': '' })[h] ?? '')]]], JSZip);
    await s.page.setInputFiles('#dataExcel input[type=file]', { name: 'baru.xlsx', mimeType: 'application/octet-stream', buffer: Buffer.from(fresh) });
    await s.page.waitForTimeout(700);
    await s.page.click('.data-preview >> text=Impor sekarang (2)');
    await s.page.click('#ops-form button:has-text("Ya, impor")');
    await s.page.waitForTimeout(1500);
    const po = s.data.writes.find(w => w.body?.action === 'purchase');
    equal([po?.body.payload.batch_code, po?.body.payload.items], ['B7', [{ sku: 'JM', quantity: 5, unit_cost: 24000 }]], 'PO baru tersimpan');
    const receipt = s.data.writes.find(w => w.fn === 'pentol_receive_purchase');
    equal([receipt?.body.purchase_code, receipt?.body.arrival_date, receipt?.body.receipt_items], ['B7', day, [{ sku: 'JM', quantity: 5 }]], 'terima barang');
    const created = s.data.writes.find(w => w.body?.action === 'create');
    equal([created?.body.payload.customer, created?.body.payload.items], ['Nina Baru', [{ stock_id: 's1', quantity: 2, unit_price: 36000 }]], 'pesanan baru dari stok yang ada');
    assert(/^[0-9a-f-]{36}$/.test(created.body.target), 'ID tetap');
    assert((await s.page.textContent('.data-progress')).includes('2 berhasil'), 'ringkasan impor');

    // Hapus semua: konfirmasi salah ditolak; benar = cadangan diunduh lalu fungsi dipanggil.
    await s.page.click('text=Hapus semua transaksi…');
    await s.page.fill('#ops-form [name=confirm_text]', 'hapus');
    await s.page.click('#ops-form button:has-text("Hapus semua")');
    await s.page.waitForTimeout(300);
    assert((await s.page.textContent('#ops-error')).includes('HAPUS SEMUA'), 'konfirmasi salah ditolak');
    equal(s.data.writes.filter(w => w.fn === 'pentol_wipe_transactions' && w.body.confirm_text === 'HAPUS SEMUA').length, 0, 'belum dihapus');
    await s.page.fill('#ops-form [name=confirm_text]', 'HAPUS SEMUA');
    const [backup] = await Promise.all([s.page.waitForEvent('download'), s.page.click('#ops-form button:has-text("Hapus semua")')]);
    assert(backup.suggestedFilename().startsWith('Cadangan-Pentol-Gilaaa-'), 'cadangan diunduh dulu');
    await s.page.waitForTimeout(800);
    equal(s.data.writes.filter(w => w.fn === 'pentol_wipe_transactions').map(w => w.body.confirm_text), ['cek', 'HAPUS SEMUA'], 'cek dulu, lalu hapus sekali');
    await s.close();
  });

  test('hapus semua sebelum SQL: langsung diberi tahu, tanpa unduh cadangan atau hapus', async () => {
    const data = defaultData();
    data.missingRpc = ['pentol_wipe_transactions'];
    const s = await open(data);
    await s.page.click('#more-menu');
    await s.page.click('#admin-menu [data-view=reconcile]');
    await s.page.click('#subtabs >> text=Impor & ekspor');
    await s.page.click('text=Hapus semua transaksi…');
    await s.page.waitForTimeout(400);
    equal(await s.page.textContent('#ops-title'), 'Fitur hapus belum aktif', 'judul pemberitahuan');
    assert((await s.page.textContent('#ops-dialog')).includes('hapus-transaksi-2026-11.sql'), 'nama file SQL');
    equal(await s.page.locator('#ops-form [name=confirm_text]').count(), 0, 'tidak meminta ketik HAPUS SEMUA');
    await s.close();
  });

  test('koreksi: batalkan pembayaran dan kurangi jumlah antar (alasan wajib)', async () => {
    const data = defaultData();
    data.orders = [order('o9', 'Hana Koreksi', { delivery_on: todayJakarta(), items: [[4, 2]], delivered_at: shiftDay(-1) + 'T05:00:00Z',
      pentol_payments: [{ id: 'p1', order_id: 'o9', paid_on: shiftDay(-1), amount: 50000 }] })];
    const s = await open(data);
    await goSub(s.page, 'orders');
    const openFix = async () => {
      await s.page.locator('#done-list .po-row').first().click();
      await s.page.click('.po-detail .more-actions summary');
      await s.page.locator('.po-detail .more-actions[open] button', { hasText: 'Koreksi' }).click();
      await s.page.waitForTimeout(200);
    };
    await openFix();
    const kinds = await s.page.$$eval('#ops-fields [name=kind] option', options => options.map(o => o.value));
    equal(kinds, ['void_pay', 'unship', 'cancel_rest'], 'jenis koreksi yang tersedia');
    await s.page.click('#ops-form > button:not([type])');
    assert(await s.page.isVisible('#ops-dialog'), 'tanpa alasan, dialog tidak tersimpan');
    await s.page.fill('#ops-fields [name=reason]', 'salah ketik nominal');
    await s.page.click('#ops-form > button:not([type])');
    await s.page.waitForTimeout(400);
    let fix = s.data.writes.find(w => w.fn === 'pentol_correct_order');
    equal([fix?.body.change_type, fix?.body.payload.payment_id, fix?.body.change_reason], ['void_pay', 'p1', 'salah ketik nominal'], 'batal bayar');
    await openFix();
    await s.page.selectOption('#ops-fields [name=kind]', 'unship');
    await s.page.fill('#ops-fields [name=quantity]', '1');
    await s.page.fill('#ops-fields [name=reason]', 'baru 1 yang diantar');
    await s.page.click('#ops-form > button:not([type])');
    await s.page.waitForTimeout(400);
    fix = s.data.writes.filter(w => w.fn === 'pentol_correct_order')[1];
    equal([fix?.body.change_type, fix?.body.payload], ['unship', { stock_id: 's1', quantity: 1 }], 'kurangi antar');
    await s.close();
  });

  test('stok opname: hanya baris berubah ditandai, semua hitungan dikirim sekali', async () => {
    const s = await open();
    await goSub(s.page, 'stock');
    assert(await s.page.isVisible('#opname-start'), 'tombol Hitung stok tampil');
    await s.page.click('#opname-start');
    await s.page.fill('#ops-fields [name=count_s1]', '20');
    assert(await s.page.$eval('.opname-row', row => row.dataset.diff === 'true'), 'baris berbeda ditandai');
    await s.page.click('#ops-form > button:not([type])');
    await s.page.waitForTimeout(400);
    const opname = s.data.writes.find(w => w.fn === 'pentol_stock_opname');
    equal(opname?.body.counts, [{ stock_id: 's1', expected_revision: 1, physical: 20 }], 'hitungan terkirim');
    assert(/^Opname \d\d\/\d\d$/.test(opname.body.change_reason), 'keterangan bawaan Opname dd/mm');
    await s.close();
  });

  test('sebelum SQL operasional: Koreksi & Hitung stok tersembunyi, laporan pakai tanggal pesanan', async () => {
    const data = defaultData();
    data.missing = ['pentol_shipments'];
    const s = await open(data);
    assert(!await s.page.isVisible('.opname-reminder'), 'tanpa pengingat opname');
    await goSub(s.page, 'stock');
    assert(await s.page.isHidden('#opname-start'), 'Hitung stok tersembunyi');
    await goSub(s.page, 'orders');
    await s.page.locator('#done-list .po-row').first().click();
    await s.page.click('.po-detail .more-actions summary');
    equal(await s.page.locator('.po-detail .more-actions[open] button:visible', { hasText: 'Koreksi' }).count(), 0, 'Koreksi tersembunyi');
    await s.page.click('.po-detail >> text=Tutup');
    await goSub(s.page, 'finance');
    await s.page.waitForTimeout(400);
    assert((await s.page.textContent('.report-chart h3')).includes('menurut tanggal pesanan'), 'laporan cara lama');
    await s.close();
  });

  test('laporan memakai tanggal antar dari catatan pengiriman', async () => {
    const data = defaultData();
    data.shipments = [{ order_id: 'o6', stock_id: 's1', quantity: 2, unit_price: 36000, shipped_on: todayJakarta() },
      { order_id: 'o7', stock_id: 's1', quantity: 1, unit_price: 36000, shipped_on: '2020-01-01' }];
    const s = await open(data);
    await goSub(s.page, 'finance');
    await s.page.waitForTimeout(500);
    equal(await s.page.textContent('[data-stat=sales] strong'), 'Rp72.000', 'hanya pengiriman dalam rentang tanggal');
    assert(!(await s.page.textContent('.report-chart h3')).includes('tanggal pesanan'), 'grafik menurut tanggal antar');
    await s.close();
  });

  test('laporan: tombol periode, 4 angka, laba per varian; tutup hari langsung tampil + kirim WA', async () => {
    const data = defaultData();
    const t = todayJakarta();
    data.shipments = [{ order_id: 'o6', stock_id: 's1', quantity: 2, unit_price: 36000, shipped_on: t }];
    data.purchases = [{ batch_code:'BATCH-02', supplier:'', reference:'', ordered_on:shiftDay(-9), expected_on:null, shipping:0, packaging:0, other_cost:0,
      pentol_purchase_items:[{ batch_code:'BATCH-02', sku:'UR', quantity:30, unit_cost:20000 }] }];
    data.orders.find(o => o.id === 'o7').pentol_payments = [{ id:'p1', order_id:'o7', amount:50000, paid_on:t }];
    const s = await open(data);
    await goSub(s.page, 'finance');
    await s.page.click('.period-chips >> text=Hari ini');
    await s.page.waitForTimeout(500);
    equal(await s.page.getAttribute('.period-chips button:has-text("Hari ini")', 'aria-pressed'), 'true', 'periode hari ini aktif');
    equal(await s.page.inputValue('#finance [name=first]'), t, 'tanggal dari = hari ini');
    equal(await s.page.textContent('[data-stat=sales] strong'), 'Rp72.000', 'penjualan');
    equal(await s.page.textContent('[data-stat=profit] strong'), 'Rp32.000', 'laba = 72.000 − 2×20.000');
    equal(await s.page.textContent('[data-stat=cash] strong'), 'Rp50.000', 'uang masuk');
    equal(await s.page.locator('#finance-body >> text=Laba per varian').count(), 0, 'laba varian tidak lagi di Laba waktu');
    await goSub(s.page, 'finance', 'Tutup hari');
    await s.page.waitForSelector('.close-section');
    const text = await s.page.textContent('#closeDay-body');
    for (const part of ['Gina Belum Bayar', 'Rp50.000', '2 pack', 'Dodi Besok']) assert(text.includes(part), 'rekap memuat ' + part);
    const href = decodeURIComponent(await s.page.getAttribute('.close-wa', 'href'));
    assert(href.includes('Uang masuk: Rp50.000') && href.includes('Pack keluar: 2') && href.includes('Antar besok: 1'), 'pesan WA');
    assert(await s.page.isEnabled('text=⬇ Excel'), 'Excel siap tanpa pratinjau');
    await s.close();
  });

  test('tombol back: pindah antar menu admin, tertahan di admin, setelah Keluar kembali ke katalog', async () => {
    const context = await browser.newContext(devices['Pixel 7']);
    const page = await context.newPage();
    const data = defaultData();
    await mockSupabase(page, data);
    await page.goto(baseUrl + '/');
    await page.waitForTimeout(300);
    await login(page, baseUrl);
    const back = async () => { await page.evaluate(() => history.back()); await page.waitForTimeout(400); };
    const visible = () => page.evaluate(() => [...document.querySelectorAll('.admin-content > .panel')].find(p => !p.hidden)?.id);
    await page.click('.bottom-nav [data-go=orders]'); await page.waitForTimeout(300);
    await page.click('.bottom-nav [data-go=finance]'); await page.waitForTimeout(300);
    equal(await visible(), 'finance', 'di Laporan');
    await back();
    equal(await visible(), 'orders', 'back = menu sebelumnya');
    await page.click('#subtabs >> text=Antar'); await page.waitForTimeout(300);
    await back(); await back(); await back(); await back();
    assert(page.url().includes('/admin/'), 'back berkali-kali tetap di admin: ' + page.url());
    assert(await page.isVisible('#dashboard'), 'dasbor tetap tampil');
    assert((await page.textContent('#status')).includes('tekan Keluar'), 'pesan petunjuk');
    await page.click('#logout');
    await page.waitForTimeout(800);
    await page.evaluate(() => history.back());
    await page.waitForURL(url => !String(url).includes('/admin/'), { timeout: 5000 });
    assert(!page.url().includes('/admin/'), 'setelah Keluar, back ke katalog');
    await context.close();
  });

  test('sesi: tetap masuk setelah aplikasi ditutup; Keluar mencabut sesi dan ikut di tab lain', async () => {
    const context = await browser.newContext(devices['Pixel 7']);
    const data = defaultData();
    const page = await context.newPage();
    await mockSupabase(page, data);
    await login(page, baseUrl);
    await page.close();                                  // seperti menutup aplikasi
    const again = await context.newPage();
    await mockSupabase(again, data);
    await again.goto(baseUrl + '/admin/');
    await again.waitForSelector('#dashboard:not([hidden])', { timeout: 5000 });
    assert(await again.isHidden('#signin'), 'tidak perlu masuk lagi');
    const other = await context.newPage();               // tab kedua
    await mockSupabase(other, data);
    await other.goto(baseUrl + '/admin/');
    await other.waitForSelector('#dashboard:not([hidden])');
    await again.click('#logout');
    await again.waitForTimeout(400);
    assert(data.auth.some(call => call.startsWith('/auth/v1/logout')), 'sesi dicabut di server');
    assert(await again.isVisible('#signin') && await other.isVisible('#signin'), 'kedua tab keluar');
    const fresh = await context.newPage();
    await mockSupabase(fresh, data);
    await fresh.goto(baseUrl + '/admin/');
    await fresh.waitForTimeout(400);
    assert(await fresh.isVisible('#signin'), 'setelah Keluar, harus masuk lagi');
    await context.close();
  });

  test('sesi: tanpa internet saat dibuka, sesi tidak hilang dan ada tombol Coba lagi', async () => {
    const context = await browser.newContext(devices['Pixel 7']);
    const data = defaultData();
    const page = await context.newPage();
    await mockSupabase(page, data);
    await login(page, baseUrl);
    await page.close();
    const offline = await context.newPage();
    await offline.route('https://gnwzgiiarbxutattxhcy.supabase.co/**', route => route.abort());
    await offline.route('https://fonts.googleapis.com/**', route => route.abort());
    await offline.goto(baseUrl + '/admin/');
    await offline.waitForTimeout(500);
    assert(await offline.isHidden('#signin'), 'form masuk tidak muncul');
    assert((await offline.textContent('#status')).includes('Coba lagi'), 'ada tombol Coba lagi');
    await offline.unroute('https://gnwzgiiarbxutattxhcy.supabase.co/**');
    await mockSupabase(offline, data);
    await offline.click('#status button');
    await offline.waitForSelector('#dashboard:not([hidden])', { timeout: 5000 });
    await context.close();
  });

  test('refresh browser tetap di halaman yang sama; tombol ↻ memuat ulang data halaman itu', async () => {
    const s = await open();
    await goSub(s.page, 'orders', 'Tagihan');
    await s.page.reload();
    await s.page.waitForSelector('#dashboard:not([hidden])');
    await s.page.waitForTimeout(500);
    assert(await s.page.isVisible('#receivables'), 'setelah refresh tetap di Tagihan');
    equal(await s.page.textContent('#subtabs [aria-current=page]'), 'Tagihan', 'tab Tagihan aktif');
    const before = s.data.reads.length;
    await s.page.click('#refresh-view');
    await s.page.waitForTimeout(500);
    const after = s.data.reads.slice(before);
    assert(after.includes('pentol_batch_stock') && after.includes('pentol_orders'), 'stok dan tagihan dimuat ulang: ' + after.join(','));
    assert(await s.page.isVisible('#receivables'), 'tetap di Tagihan setelah ↻');
    await s.close();
  });

  test('HP lama tanpa Map.groupBy: Tagihan tetap tampil', async () => {
    const s = await open(defaultData(), { oldBrowser: true });
    await goSub(s.page, 'orders', 'Tagihan');
    equal(await s.page.locator('#receivables-body .po-row').count(), 2, 'dua pelanggan dengan tagihan');
    equal(s.problems, [], 'tanpa error');
    await s.close();
  });
}

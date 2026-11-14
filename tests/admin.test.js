// Uji browser admin dengan Supabase tiruan (ukuran HP Pixel 7).
import { test, assert, equal } from './harness.js';
import { createRequire } from 'node:module';
import { mockSupabase, login, defaultData, order, todayJakarta, shiftDay } from './mock.js';
const JSZip = createRequire(import.meta.url)('../admin/vendor/jszip.min.js');

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
    const pages = [['today'], ['orders'], ['orders', 'Packing & antar'], ['orders', 'Tagihan'], ['stock'], ['stock', 'Restok & PO'],
      ['finance'], ['finance', 'Tutup hari']];
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
    const count = () => s.page.$$eval('#order-rows tr', rows => rows.filter(r => !r.querySelector('td[colspan]')).length);
    equal(await count(), 6, 'Perlu tindakan = semua kecuali yang lunas & diantar');
    await s.page.click('.order-chips [data-chip=unpaid]'); await s.page.waitForTimeout(400);
    equal(await count(), 6, 'Belum bayar');
    await s.page.click('.order-chips [data-chip=pending]'); await s.page.waitForTimeout(400);
    equal(await count(), 5, 'Belum antar');
    await s.close();
  });

  test('aksi langsung dan tautan WhatsApp berisi tagihan', async () => {
    const s = await open();
    await goSub(s.page, 'orders', 'Tagihan');
    const card = s.page.locator('#receivables-body article.ops-card').filter({ hasText: 'Invoice' }).first();
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

  test('arsip permintaan bisa dibatalkan, lalu tersimpan setelah 6 detik', async () => {
    const s = await open();
    await goSub(s.page, 'orders');
    const card = s.page.locator('#inbox-list .ops-card').first();
    await card.locator('button', { hasText: 'Arsipkan' }).click();
    await s.page.click('#status button');
    assert(await card.isVisible(), 'kartu kembali setelah Batalkan');
    equal(s.data.writes.filter(w => w.body.action === 'dismiss').length, 0, 'belum ada arsip');
    await card.locator('button', { hasText: 'Arsipkan' }).click();
    await s.page.waitForTimeout(6500);
    equal(s.data.writes.filter(w => w.body.action === 'dismiss').length, 1, 'arsip tersimpan');
    await s.close();
  });

  test('packing dibagi per pesanan menurut jadwal (bug B4)', async () => {
    const data = defaultData();
    data.stock = [{ id:'s1', batch_code:'B1', sku:'UR', received_on:shiftDay(-5), received:4, reserved:5, delivered:0, revision:1 }];
    data.orders = [order('o1', 'Xena Hari Ini', { delivery_on: todayJakarta(), items: [[3, 0]] }),
      order('o2', 'Yuda Kemarin', { delivery_on: shiftDay(-1), items: [[2, 0]] })];
    const s = await open(data);
    await goSub(s.page, 'orders', 'Packing & antar');
    await s.page.selectOption('[name=pack_filter]', 'pending');
    await s.page.waitForTimeout(500);
    const states = await s.page.$$eval('#packing-body .ops-card', cs => Object.fromEntries(cs.map(c =>
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
    await s.page.click('#stock-batches summary');
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

  test('HP lama tanpa Map.groupBy: Tagihan tetap tampil', async () => {
    const s = await open(defaultData(), { oldBrowser: true });
    await goSub(s.page, 'orders', 'Tagihan');
    equal(await s.page.locator('#receivables-body > .ops-card').count(), 2, 'dua pelanggan dengan tagihan');
    equal(s.problems, [], 'tanpa error');
    await s.close();
  });
}

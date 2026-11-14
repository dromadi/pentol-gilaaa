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
    const pages = [['today'], ['orders'], ['orders', 'Semua pesanan'], ['orders', 'Packing'], ['orders', 'Antar'], ['orders', 'Tagihan'], ['stock'], ['stock', 'Restok & PO'],
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
    const count = () => s.page.$$eval('#order-rows tr', rows => rows.filter(r => !r.querySelector('td[colspan]')).length);
    equal(await count(), 6, 'Perlu tindakan = semua kecuali yang lunas & diantar');
    await s.page.click('.order-chips [data-chip=unpaid]'); await s.page.waitForTimeout(400);
    equal(await count(), 6, 'Belum bayar');
    await s.page.click('.order-chips [data-chip=pending]'); await s.page.waitForTimeout(400);
    equal(await count(), 5, 'Belum antar');
    await s.close();
  });

  test('Pesanan: 5 sub menu, Perlu tindakan vs Semua pesanan, Packing vs Antar', async () => {
    const s = await open();
    await goSub(s.page, 'orders');
    equal(await s.page.$$eval('#subtabs button', b => b.map(x => x.textContent)),
      ['Perlu tindakan', 'Semua pesanan', 'Packing', 'Antar', 'Tagihan'], 'sub menu');
    assert(await s.page.isVisible('#checkout-inbox') && await s.page.isVisible('.order-chips'), 'perlu tindakan: permintaan + tombol cepat');
    assert(await s.page.isHidden('#order-filters'), 'tanpa filter tanggal');
    await goSub(s.page, 'orders', 'Semua pesanan');
    assert(await s.page.isHidden('#checkout-inbox') && await s.page.isHidden('.order-chips'), 'semua pesanan: tanpa permintaan & tombol cepat');
    assert(await s.page.isVisible('#order-filters input[type=date]'), 'filter tanggal terbuka');
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

  test('Pesanan: cari nama/WA/invoice; permintaan katalog punya Balas WA', async () => {
    const s = await open();
    await goSub(s.page, 'orders');
    const count = () => s.page.$$eval('#order-rows tr', rows => rows.filter(r => !r.querySelector('td[colspan]')).length);
    await s.page.fill('#order-search', '00002'); await s.page.waitForTimeout(150);
    equal(await count(), 1, 'cari nomor invoice');
    await s.page.fill('#order-search', '0812 3456'); await s.page.waitForTimeout(150);
    equal(await count(), 6, 'cari nomor WA');
    await s.page.fill('#order-search', 'ani'); await s.page.waitForTimeout(150);
    equal(await count(), 1, 'cari nama');
    const meta = await s.page.textContent('#order-rows .order-meta');
    assert(meta.startsWith('Invoice 00001') && meta.includes('Gedung B'), 'baris info: ' + meta);
    const reply = decodeURIComponent(await s.page.getAttribute('#inbox-list .wa-link', 'href'));
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
    const gina = s.page.locator('#receivables-body > .ops-card').filter({ hasText: 'Gina Belum Bayar' });
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

  test('hapus permintaan katalog: kotak konfirmasi, Tutup = batal, Ya = hapus; Ubah membuka form', async () => {
    const s = await open();
    await goSub(s.page, 'orders');
    const card = s.page.locator('#inbox-list .ops-card').first();
    await card.locator('button', { hasText: 'Hapus' }).click();
    assert(await s.page.isVisible('#ops-dialog'), 'kotak konfirmasi muncul');
    assert((await s.page.textContent('#ops-dialog')).includes('Yakin hapus'), 'pertanyaan yakin');
    await s.page.click('#ops-close');
    equal(s.data.writes.filter(w => w.body?.action === 'dismiss').length, 0, 'Tutup tidak menghapus');
    await card.locator('button', { hasText: 'Hapus' }).click();
    await s.page.click('#ops-form button:has-text("Ya, hapus")');
    await s.page.waitForTimeout(400);
    equal(s.data.writes.filter(w => w.body?.action === 'dismiss').length, 1, 'terhapus');
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
    const card = s.page.locator('#inbox-list .ops-card').first();
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
    const row = s.page.locator('#order-rows tr', { hasText: 'Eka Antar Sebagian' }).first();
    await row.locator('.more-actions summary').click();
    await row.locator('.more-actions button', { hasText: 'Ubah pesanan' }).click();
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
    const row = s.page.locator('#order-rows tr', { hasText: 'Eka' }).first();
    await row.locator('.more-actions summary').click();
    await row.locator('.more-actions button', { hasText: 'Ubah pesanan' }).click();
    await s.page.click('[aria-label="Tambah Pentol Urat"]');
    await s.page.click('#save-order');
    await s.page.waitForTimeout(500);
    assert((await s.page.textContent('#status')).includes('ubah-pesanan-2026-11.sql'), 'pesan butuh SQL');
    assert(await s.page.isVisible('#order-form'), 'form tetap terbuka');
    equal(s.data.writes.filter(w => w.fn === 'pentol_order_action').length, 0, 'tidak memakai aturan lama');
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
    equal(await jamur.locator('button', { hasText: 'Restok' }).count(), 0, 'tanpa tombol Restok');
    await s.page.click('#subtabs >> text=Restok & PO');
    await s.page.waitForTimeout(500);
    const pos = await s.page.$$eval('#purchasing-body > article.ops-card > strong', xs => xs.map(x => x.textContent));
    equal(pos, ['BATCH-03 · Pusat'], 'hanya PO yang menunggu kiriman di atas');
    assert((await s.page.textContent('.po-done summary')).includes('PO selesai (1)'), 'PO selesai dilipat');
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

  test('koreksi: batalkan pembayaran dan kurangi jumlah antar (alasan wajib)', async () => {
    const data = defaultData();
    data.orders = [order('o9', 'Hana Koreksi', { delivery_on: todayJakarta(), items: [[4, 2]], delivered_at: shiftDay(-1) + 'T05:00:00Z',
      pentol_payments: [{ id: 'p1', order_id: 'o9', paid_on: shiftDay(-1), amount: 50000 }] })];
    const s = await open(data);
    await goSub(s.page, 'orders');
    const openFix = async () => {
      await s.page.locator('#order-rows .more-actions summary').first().click();
      await s.page.locator('#order-rows .more-actions[open] button', { hasText: 'Koreksi' }).click();
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
    await s.page.locator('#order-rows .more-actions summary').first().click();
    equal(await s.page.locator('#order-rows .more-actions[open] button:visible', { hasText: 'Koreksi' }).count(), 0, 'Koreksi tersembunyi');
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
    const row = s.page.locator('#finance-body tr', { hasText: 'Pentol Urat' }).first();
    assert((await row.textContent()).includes('Rp32.000'), 'laba per varian');
    await goSub(s.page, 'finance', 'Tutup hari');
    await s.page.waitForSelector('.close-section');
    const text = await s.page.textContent('#closeDay-body');
    for (const part of ['Gina Belum Bayar', 'Rp50.000', '2 pack', 'Dodi Besok']) assert(text.includes(part), 'rekap memuat ' + part);
    const href = decodeURIComponent(await s.page.getAttribute('.close-wa', 'href'));
    assert(href.includes('Uang masuk: Rp50.000') && href.includes('Pack keluar: 2') && href.includes('Antar besok: 1'), 'pesan WA');
    assert(await s.page.isEnabled('text=⬇ Excel'), 'Excel siap tanpa pratinjau');
    await s.close();
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
    equal(await s.page.locator('#receivables-body > .ops-card').count(), 2, 'dua pelanggan dengan tagihan');
    equal(s.problems, [], 'tanpa error');
    await s.close();
  });
}

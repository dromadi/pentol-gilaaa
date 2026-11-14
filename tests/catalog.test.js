// Uji katalog pembeli (index.html + catalog.js) dengan Supabase tiruan.
import { test, assert, equal } from './harness.js';
import { SUPABASE } from './mock.js';

const base = [['UR',36000,1,null],['PK',39000,0,null],['TP',29000,1,null],['JM',36000,1,2],['MZ',36000,0,null],
  ['RJ',36000,1,null],['TD',35000,1,null],['PG',41000,1,null],['SG',15000,1,null]];
const catalog = (patch = {}) => base.map(([sku, price, available, max_qty]) => ({ sku, price, available, max_qty, ...(patch[sku] || {}) }));

export function catalogTests(browser, devices, baseUrl) {
  async function open(handler) {
    const context = await browser.newContext(devices['Pixel 7']);
    const page = await context.newPage();
    const problems = [];
    page.on('pageerror', error => problems.push(error.message));
    page.on('console', message => { if (/Content.Security/i.test(message.text())) problems.push(message.text()); });
    await page.route('https://fonts.googleapis.com/**', r => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
    await page.route(SUPABASE + '/**', route => handler(route, route.request().url().split('/rpc/')[1]));
    await page.goto(baseUrl + '/');
    await page.waitForTimeout(400);
    return { page, problems, close: () => context.close() };
  }
  const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const card = (page, id) => page.locator(`[data-product="${id}"]`);

  test('stok tipis: label "Sisa N pack" dan tombol + berhenti di batas', async () => {
    const s = await open(route => json(route, catalog()));
    await card(s.page, 'JM').locator('[data-add]').click();
    await card(s.page, 'JM').locator('[data-menu-change="1"]').click();
    equal(await card(s.page, 'JM').locator('.stock-left').textContent(), 'Sisa 2 pack', 'label');
    assert(await card(s.page, 'JM').locator('[data-menu-change="1"]').isDisabled(), 'tombol + mati di batas');
    equal(s.problems, [], 'tanpa error / pelanggaran CSP');
    await s.close();
  });

  test('gagal memuat stok: banner dan tombol Coba lagi', async () => {
    let fail = true;
    const s = await open(route => fail ? route.abort() : json(route, catalog()));
    assert(await s.page.isVisible('#stock-status'), 'banner tampil');
    fail = false;
    await s.page.click('#stock-retry');
    await s.page.waitForTimeout(300);
    assert(await s.page.isHidden('#stock-status'), 'banner hilang setelah berhasil');
    await s.close();
  });

  test('server menolak karena stok: keranjang diturunkan', async () => {
    const s = await open((route, fn) => fn === 'pentol_submit_checkout'
      ? json(route, { code: 'P0001', hint: 'stock', message: 'Stok Pentol Urat tersisa 3 pack.', details: null }, 400)
      : json(route, catalog()));
    await card(s.page, 'UR').locator('[data-add]').click();
    for (let i = 0; i < 4; i++) await card(s.page, 'UR').locator('[data-menu-change="1"]').click();
    await s.page.click('#dock [data-cart]');
    await s.page.click('#continue-checkout');
    await s.page.fill('[name=buyer]', 'Budi');
    await s.page.fill('[name=phone]', '081234567890');
    await s.page.click('#whatsapp');
    await s.page.waitForTimeout(500);
    equal(await s.page.locator('#cart-items .qty span').first().textContent(), '3', 'jumlah disesuaikan');
    assert((await s.page.textContent('#feedback')).startsWith('Stok Pentol Urat tersisa 3 pack.'), 'pesan stok');
    await s.close();
  });

  test('varian habis di bawah; Diantar mewajibkan alamat; data pembeli diingat', async () => {
    const s = await open((route, fn) => fn === 'pentol_submit_checkout' ? route.fulfill({ status: 204 }) : json(route, catalog()));
    const order = await s.page.$$eval('[data-product]', cards => cards.map(card => card.dataset.product));
    equal(order.slice(-2), ['PK', 'MZ'], 'varian habis di urutan terakhir');
    await card(s.page, 'UR').locator('[data-add]').click();
    await s.page.click('#dock [data-cart]');
    await s.page.click('#continue-checkout');
    await s.page.fill('[name=buyer]', 'Budi');
    await s.page.fill('[name=phone]', '081234567890');
    await s.page.locator('.method-choice span', { hasText: 'Diantar' }).click();
    assert(await s.page.$eval('[name=location]', input => input.required), 'alamat wajib saat Diantar');
    await s.page.fill('[name=location]', 'Gedung B');
    await s.page.click('#whatsapp');
    await s.page.waitForTimeout(400);
    await s.page.reload();
    await s.page.waitForTimeout(400);
    await card(s.page, 'TP').locator('[data-add]').click();
    await s.page.click('#dock [data-cart]');
    await s.page.click('#continue-checkout');
    const values = await s.page.evaluate(() => { const e = document.getElementById('order-form').elements;
      return [e.buyer.value, e.phone.value, e.location.value, e.method.value]; });
    equal(values, ['Budi', '081234567890', 'Gedung B', 'Diantar'], 'data pembeli terisi otomatis');
    await s.close();
  });

  test('CSP katalog memblokir skrip sisipan', async () => {
    const s = await open(route => json(route, catalog()));
    const ran = await s.page.evaluate(() => new Promise(resolve => {
      window.injected = 0;
      const script = document.createElement('script');
      script.textContent = 'window.injected = 1';
      document.head.append(script);
      setTimeout(() => resolve(window.injected), 200);
    }));
    equal(ran, 0, 'skrip sisipan tidak jalan');
    await s.close();
  });
}

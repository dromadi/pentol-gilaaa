// Supabase tiruan untuk uji browser: data di memori, filter PostgREST yang dipakai aplikasi, dan catatan tulis.
export const SUPABASE = 'https://gnwzgiiarbxutattxhcy.supabase.co';
export const todayJakarta = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Jakarta' }).format(new Date());
export const shiftDay = (n, from = todayJakarta()) => new Date(Date.parse(from) + n * 864e5).toISOString().slice(0, 10);

export const PRICES = { UR:36000, PK:39000, TP:29000, JM:36000, MZ:36000, RJ:36000, TD:35000, PG:41000, SG:15000 };

export function order(id, customer, extra = {}) {
  const items = extra.items || [[2, 0]];
  return { id, customer, order_date: shiftDay(-3), created_at: shiftDay(-3) + 'T02:00:00Z', paid: false, delivered: false,
    cancelled: false, revision: 1, delivery_on: null, delivered_at: null, invoice_no: Number(id.replace(/\D/g, '')) || 1,
    excel_invoice_no: null, shipping_charge: 0, shipping_cost: 0, contact: '0812-3456-7890', delivery_location: 'Gedung B',
    delivery_note: '', pentol_payments: [], ...extra,
    pentol_order_items: items.map(([quantity, shipped, stock_id = 's1', unit_price = 36000]) =>
      ({ order_id: id, quantity, shipped, stock_id, unit_price })) };
}

export function defaultData() {
  return {
    stock: [{ id:'s1', batch_code:'BATCH-02', sku:'UR', received_on:shiftDay(-5), received:30, reserved:10, delivered:6, revision:1 }],
    inbox: [{ id:'00000000-0000-0000-0000-00000000abcd', created_at: todayJakarta() + 'T03:00:00Z', customer:'Dewi',
      phone:'081234567890', area:'Kantor', note:'Ambil sendiri · ', items:[{ sku:'UR', quantity:2 }], status:'pending' }],
    orders: [
      order('o1', 'Ani Hari Ini', { delivery_on: todayJakarta() }),
      order('o2', 'Budi Terlambat', { delivery_on: shiftDay(-2) }),
      order('o3', 'Citra Tanpa Jadwal'),
      order('o4', 'Dodi Besok', { delivery_on: shiftDay(1) }),
      order('o5', 'Eka Antar Sebagian', { delivery_on: shiftDay(-1), items: [[4, 2]], delivered_at: shiftDay(-1) + 'T05:00:00Z' }),
      order('o6', 'Fajar Lunas', { paid: true, delivered: true, items: [[2, 2]], delivered_at: shiftDay(-1) + 'T05:00:00Z' }),
      order('o7', 'Gina Belum Bayar', { delivered: true, items: [[2, 2]], delivered_at: shiftDay(-4) + 'T05:00:00Z' })
    ],
    writes: []
  };
}

function matches(o, url) {
  const q = new URL(url).searchParams;
  const eq = (key, value) => !q.has(key) || q.getAll(key).every(rule => {
    const [op, arg] = [rule.slice(0, rule.indexOf('.')), rule.slice(rule.indexOf('.') + 1)];
    const v = value;
    if (op === 'eq') return String(v) === arg;
    if (op === 'lt') return v != null && v < arg;
    if (op === 'gte') return v != null && v >= arg;
    if (op === 'lte') return v != null && v <= arg;
    if (op === 'is') return arg === 'null' ? v == null : String(v) === arg;
    return true;
  });
  if (q.has('or') && q.get('or') === '(paid.eq.false,delivered.eq.false)' && o.paid && o.delivered) return false;
  return eq('cancelled', o.cancelled) && eq('paid', o.paid) && eq('delivered', o.delivered) && eq('delivery_on', o.delivery_on)
    && eq('order_date', o.order_date) && eq('id', o.id) && eq('status', o.status);
}

const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

export async function mockSupabase(page, data) {
  await page.route('https://fonts.googleapis.com/**', r => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await page.route(SUPABASE + '/**', route => {
    const request = route.request();
    const url = request.url();
    const path = new URL(url).pathname;
    if (path.startsWith('/auth/v1/token')) return json(route, { access_token: 'a', refresh_token: 'r', expires_in: 3600 });
    if (path.startsWith('/rest/v1/rpc/')) {
      data.writes.push({ fn: path.split('/').pop(), body: JSON.parse(request.postData() || '{}') });
      return route.fulfill({ status: 204 });
    }
    if (request.method() !== 'GET') { data.writes.push({ method: request.method(), path }); return json(route, []); }
    const table = path.split('/').pop();
    if (table === 'pentol_admins') return json(route, [{ user_id: 'x' }]);
    if (table === 'pentol_batch_stock') return json(route, data.stock);
    if (table === 'pentol_inbox') return json(route, data.inbox.filter(entry => matches(entry, url)));
    if (table === 'pentol_products') return json(route, Object.entries(PRICES).map(([sku, price]) => ({ sku, price })));
    if (table === 'pentol_orders') return json(route, data.orders.filter(o => matches(o, url)));
    if (table === 'pentol_order_items') return json(route, data.orders.flatMap(o => o.cancelled ? [] :
      o.pentol_order_items.map(i => ({ ...i, pentol_orders: { cancelled: o.cancelled } }))));
    return json(route, []);
  });
}

export async function login(page, baseUrl) {
  await page.goto(baseUrl + '/admin/');
  await page.fill('[name=email]', 'admin@contoh.test');
  await page.fill('[name=password]', 'rahasia');
  await page.click('#login button');
  await page.waitForSelector('#dashboard:not([hidden])');
  await page.waitForTimeout(500);
}

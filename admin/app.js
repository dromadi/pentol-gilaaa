import { supabaseUrl, supabasePublishableKey } from './config.js';

const products = new Map([
  ['UR','Pentol Urat'], ['PK','Pentol Kecil'], ['TP','Tahu Pentol'],
  ['JM','Pentol Jamur'], ['MZ','Pentol Mozzarella'], ['RJ','Pentol Ranjau'],
  ['TD','Tahu Pedas'], ['PG','Pentol Goreng'], ['SG','Sambal Gila Tambahan']
]);
const $ = id => document.getElementById(id);
const format = new Intl.NumberFormat('id-ID');
const login = $('login');
const form = $('batch-form');
const filter = $('batch-filter');
const stockBatch = $('stock-batch');
const stockSearch = $('stock-search');
const orderForm = $('order-form');
const orderDate = $('order-date');
const orderPeriod = $('order-period');
const menuToggle = $('menu-toggle');
const menu = $('admin-menu');
const menuButtons = menu.querySelectorAll('[data-view]');
const displayDate = new Intl.DateTimeFormat('id-ID', {
  day:'numeric', month:'short', year:'numeric', timeZone:'UTC'
});
const orderItems = $('order-items');
const prices = { UR:36000, PK:39000, TP:29000, JM:36000, MZ:36000, RJ:36000, TD:35000, PG:41000, SG:15000 };
let draftId;
let orderLoad = 0;
const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone:'Asia/Jakarta' }).format(new Date());
orderDate.value = today();
let session = null;
let rows = [];
let editing = null;
let busy = false;
let expiry;
const configured = /^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/.test(supabaseUrl)
  && /^sb_publishable_[A-Za-z0-9_-]+$/.test(supabasePublishableKey);
const base = supabaseUrl.replace(/\/$/, '');

function status(message, error = false) {
  $('status').textContent = message;
  $('status').dataset.error = String(error);
}

async function request(path, { method = 'GET', body, token = session, prefer } = {}) {
  const headers = { apikey: supabasePublishableKey };
  if (token) headers.Authorization = 'Bearer ' + token;
  if (body) headers['Content-Type'] = 'application/json';
  if (prefer) headers.Prefer = prefer;
  const response = await fetch(base + path, { method, headers, body: body && JSON.stringify(body) });
  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    const error = new Error(detail?.message || 'Permintaan gagal.');
    error.status = response.status;
    throw error;
  }
  return response.status === 204 ? null : response.json();
}

function resetEditor() {
  editing = null;
  form.reset();
  form.hidden = true;
  $('new-entry').setAttribute('aria-expanded', 'false');
  $('editor-title').textContent = 'Tambah varian ke batch';
  $('save').textContent = 'Tambah varian ke batch';
}

function endSession(message) {
  clearTimeout(expiry);
  session = null;
  rows = [];
  orderLoad++;
  resetOrderForm();
  $('order-rows').replaceChildren();
  $('orders-summary').textContent = '';
  setMenuExpanded(false);
  $('dashboard').hidden = true;
  $('logout').hidden = true;
  $('stock-rows').replaceChildren();
  $('analytics-rows').replaceChildren();
  $('metrics').replaceChildren();
  filter.replaceChildren(new Option('Semua batch', ''));
  stockBatch.replaceChildren(new Option('Semua batch', ''));
  stockSearch.value = '';
  resetEditor();
  $('signin').hidden = false;
  status(message);
}

function quantities(row) {
  const remaining = row.received - row.delivered - row.reserved;
  return [row.received, row.reserved, row.delivered, Math.max(remaining, 0), Math.max(-remaining, 0)];
}

function tableRow(values) {
  const tr = document.createElement('tr');
  for (const value of values) {
    const td = tr.insertCell();
    td.textContent = typeof value === 'number' ? format.format(value) : value;
  }
  return tr;
}

function emptyRow(target, columns, label) {
  if (target.children.length) return;
  const tr = tableRow([label]);
  tr.cells[0].colSpan = columns;
  target.append(tr);
}

function renderAnalytics() {
  const totals = [0, 0, 0, 0, 0];
  const perProduct = new Map();
  for (const row of rows.filter(item => !filter.value || item.batch_code === filter.value)) {
    const product = perProduct.get(row.sku) || [0, 0, 0, 0, 0];
    quantities(row).forEach((value, i) => { totals[i] += value; product[i] += value; });
    perProduct.set(row.sku, product);
  }
  const labels = ['Diterima','Terpesan','Diantar','Sisa jual','Belum terpenuhi'];
  $('metrics').replaceChildren(...labels.map((label, i) => {
    const card = document.createElement('div');
    card.className = 'metric';
    const number = document.createElement('strong');
    number.textContent = format.format(totals[i]);
    card.append(number, label);
    return card;
  }));
  const target = $('analytics-rows');
  target.replaceChildren(...Array.from(perProduct, ([sku, counts]) => tableRow([products.get(sku), ...counts])));
  emptyRow(target, 6, 'Belum ada data batch.');
}

function edit(row) {
  editing = row;
  for (const name of ['batch_code','sku','received_on','received','reserved','delivered']) {
    form.elements[name].value = row[name] ?? '';
  }
  showEditor();
  $('editor-title').textContent = 'Edit stok batch';
  $('save').textContent = 'Simpan perubahan';
}

function showEditor() {
  form.hidden = false;
  $('new-entry').setAttribute('aria-expanded', 'true');
  form.elements.batch_code.focus();
}

function renderStock() {
  const target = $('stock-rows');
  const query = stockSearch.value.trim().toLocaleLowerCase('id');
  const visible = rows.filter(row => (!stockBatch.value || stockBatch.value === row.batch_code)
    && products.get(row.sku).toLocaleLowerCase('id').includes(query));
  $('stock-summary').textContent = visible.length + ' baris stok';
  const labels = ['Batch', 'Varian', 'Diterima', 'Terpesan', 'Diantar', 'Sisa jual', 'Belum terpenuhi'];
  target.replaceChildren(...visible.map(row => {
    const tr = tableRow([row.batch_code, products.get(row.sku), ...quantities(row)]);
    Array.from(tr.cells).forEach((cell, i) => { cell.dataset.label = labels[i]; });
    const button = document.createElement('button');
    button.className = 'secondary';
    button.textContent = 'Edit';
    button.type = 'button';
    button.setAttribute('aria-label', 'Edit ' + row.batch_code + ' ' + products.get(row.sku));
    button.addEventListener('click', () => { if (!busy) edit(row); });
    tr.insertCell().append(button);
    return tr;
  }));
  emptyRow(target, 8, rows.length ? 'Tidak ada stok yang cocok dengan filter.' : 'Belum ada data batch. Tambahkan varian untuk mulai mencatat.');
}

function renderRows() {
  const batches = Array.from(new Set(rows.map(row => row.batch_code)));
  for (const select of [filter, stockBatch]) {
    const previous = select.value;
    select.replaceChildren(new Option('Semua batch', ''), ...batches.map(code => new Option(code, code)));
    if (batches.includes(previous)) select.value = previous;
  }
  renderStock();
  renderAnalytics();
  for (const select of orderItems.querySelectorAll('select')) populateOrderStock(select);
}

async function loadRows() {
  const token = session;
  const loaded = [];
  const pageSize = 500;
  for (let offset = 0; ; offset += pageSize) {
    const page = await request('/rest/v1/pentol_batch_stock?select=*&order=batch_code,sku,id&limit=' + pageSize + '&offset=' + offset);
    if (session !== token) return;
    loaded.push(...page);
    if (page.length < pageSize) break;
  }
  rows = loaded;
  renderRows();
}

async function run(button, action) {
  if (busy) return;
  busy = true;
  button.disabled = true;
  try { await action(); }
  finally { busy = false; button.disabled = false; }
}

login.addEventListener('submit', event => {
  event.preventDefault();
  run(login.querySelector('button'), async () => {
    status('Memeriksa akses…');
    const { email, password } = Object.fromEntries(new FormData(login));
    try {
      const auth = await request('/auth/v1/token?grant_type=password', { method:'POST', body:{ email, password }, token:null });
      const access = await request('/rest/v1/pentol_admins?select=user_id&limit=1', { token:auth.access_token });
      if (!access.length) return status('Akun ini belum terdaftar sebagai admin.', true);
      session = auth.access_token;
      await loadRows();
      expiry = setTimeout(() => endSession('Sesi berakhir. Silakan masuk kembali.'), auth.expires_in * 1000);
      $('signin').hidden = true;
      $('dashboard').hidden = false;
      $('logout').hidden = false;
      status('');
      if (!$('orders').hidden) loadOrders();
    } catch (error) {
      session = null;
      status(error.status === 400 || error.status === 401 ? 'Periksa kembali email dan kata sandi.' : 'Akses admin belum bisa dimuat. Coba lagi.', true);
    } finally { login.elements.password.value = ''; }
  });
});

form.addEventListener('submit', event => {
  event.preventDefault();
  run($('save'), async () => {
    const entry = Object.fromEntries(new FormData(form));
    entry.batch_code = entry.batch_code.trim().toUpperCase();
    entry.received_on ||= null;
    for (const key of ['received','reserved','delivered']) entry[key] = Number(entry[key]);
    if (!entry.batch_code || (entry.received && !entry.received_on) || entry.delivered > entry.received) {
      status('Isi kode batch dan tanggal terima saat barang tiba. Jumlah diantar maksimal sama dengan jumlah diterima.', true);
      return;
    }
    const current = editing;
    const path = '/rest/v1/pentol_batch_stock';
    let saved = false;
    try {
      const result = current
        ? await request(path + '?id=eq.' + encodeURIComponent(current.id) + '&revision=eq.' + current.revision,
          { method:'PATCH', body:{ ...entry, revision:current.revision + 1 }, prefer:'return=representation' })
        : await request(path, { method:'POST', body:entry, prefer:'return=representation' });
      if (current && !result.length) {
        await loadRows();
        resetEditor();
        return status('Data sudah berubah. Buka kembali baris terbaru sebelum mengedit.', true);
      }
      saved = true;
      resetEditor();
      await loadRows();
      status('Stok batch tersimpan.');
    } catch (error) {
      if (error.status === 401 || error.status === 403) return endSession('Akses berakhir. Silakan masuk kembali.');
      status(saved ? 'Stok tersimpan, tetapi daftar gagal dimuat. Masuk kembali untuk melihat data terbaru.'
        : error.status === 409 ? 'Varian ini sudah ada di batch tersebut. Gunakan Edit.'
        : 'Penyimpanan belum terkonfirmasi. Masuk kembali untuk memeriksa data sebelum mencoba lagi.', true);
    }
  });
});

for (const [sku, label] of products) form.elements.sku.add(new Option(label, sku));
$('new-entry').addEventListener('click', () => {
  if (busy) return;
  resetEditor();
  if (stockBatch.value) form.elements.batch_code.value = stockBatch.value;
  showEditor();
});
$('cancel').addEventListener('click', () => {
  if (busy) return;
  resetEditor();
  $('new-entry').focus();
});
stockBatch.addEventListener('change', renderStock);
stockSearch.addEventListener('input', renderStock);
$('logout').addEventListener('click', () => {
  if (!busy) endSession('Anda sudah keluar.');
});
filter.addEventListener('change', renderAnalytics);
function setMenuExpanded(expanded) {
  menuToggle.setAttribute('aria-expanded', String(expanded));
}

menuToggle.addEventListener('click', () => {
  setMenuExpanded(menuToggle.getAttribute('aria-expanded') !== 'true');
});
menu.parentElement.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || !menuToggle.getClientRects().length
      || menuToggle.getAttribute('aria-expanded') !== 'true') return;
  setMenuExpanded(false);
  menuToggle.focus();
});

menuButtons.forEach(button => button.addEventListener('click', () => {
  menuButtons.forEach(tab => {
    const selected = tab === button;
    tab.setAttribute('aria-pressed', String(selected));
    $(tab.dataset.view).hidden = !selected;
  });
  if (menuToggle.getClientRects().length) {
    setMenuExpanded(false);
    $(button.dataset.view).querySelector('h2').focus();
  }
  if (button.dataset.view === 'orders') loadOrders();
}));
if (configured) $('signin').hidden = false;
else status('Login admin menunggu konfigurasi database.');

function resetOrderForm() {
  draftId = null;
  orderForm.reset();
  orderItems.replaceChildren();
  orderForm.hidden = true;
  $('new-order').setAttribute('aria-expanded', 'false');
}

function populateOrderStock(select) {
  const previous = select.value;
  select.replaceChildren(new Option('Pilih varian dan batch', ''), ...rows.map(row =>
    new Option(products.get(row.sku) + ' · ' + row.batch_code + ' · sisa ' + quantities(row)[3], row.id)));
  if (rows.some(row => row.id === previous)) select.value = previous;
}

function addOrderItem() {
  if (orderItems.childElementCount >= 30) return;
  const line = document.createElement('div');
  line.className = 'fields order-item';
  line.innerHTML = `
    <label>Varian dan batch <select name="stock_id" required></select></label>
    <label>Jumlah (pack) <input name="quantity" type="number" min="1" max="1000000" value="1" required></label>
    <label>Harga per pack (Rp) <input name="unit_price" type="number" min="0" max="10000000" required></label>
    <button type="button" class="secondary">Hapus varian</button>`;
  const select = line.querySelector('select');
  populateOrderStock(select);
  select.addEventListener('change', () => {
    const row = rows.find(item => item.id === select.value);
    line.querySelector('[name="unit_price"]').value = row ? prices[row.sku] : '';
  });
  line.querySelector('button').addEventListener('click', () => {
    if (!busy && orderItems.childElementCount > 1) line.remove();
  });
  orderItems.append(line);
}

function orderRange(day, weekly) {
  if (!weekly) return { first:day, last:day };
  const date = new Date(day + 'T00:00:00Z');
  date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
  const first = date.toISOString().slice(0, 10);
  date.setUTCDate(date.getUTCDate() + 6);
  return { first, last:date.toISOString().slice(0, 10) };
}

function moveOrderWeek(days) {
  const date = new Date((orderDate.value || today()) + 'T00:00:00Z');
  date.setUTCDate(date.getUTCDate() + days);
  orderDate.value = date.toISOString().slice(0, 10);
  loadOrders();
}

async function loadOrders() {
  const generation = ++orderLoad;
  const weekly = orderPeriod.value === 'week';
  $('order-date-column').hidden = !weekly;
  $('week-navigation').hidden = !weekly;
  $('order-date-label').textContent = weekly ? 'Tanggal dalam minggu' : 'Tanggal';
  const target = $('order-rows');
  const summary = $('orders-summary');
  target.replaceChildren();
  if (!orderDate.value) {
    summary.textContent = 'Pilih tanggal untuk melihat pesanan.';
    return;
  }
  const { first, last } = orderRange(orderDate.value, weekly);
  const rangeFilter = '&order_date=gte.' + first + '&order_date=lte.' + last;
  const period = weekly ? displayDate.formatRange(new Date(first), new Date(last)) + ' · ' : '';
  summary.textContent = period + 'Memuat pesanan…';
  try {
    const orders = [];
    for (let offset = 0; ; offset += 200) {
      const page = await request('/rest/v1/pentol_orders?select=id,order_date,customer,paid,delivered,pentol_order_items(quantity,unit_price,stock_id)&order=order_date,created_at,id&limit=200&offset='
        + offset + rangeFilter);
      if (generation !== orderLoad || !session) return;
      orders.push(...page);
      if (page.length < 200) break;
    }
    const stockById = new Map(rows.map(row => [row.id, row]));
    let packs = 0;
    let charges = 0;
    target.replaceChildren(...orders.map(order => {
      const items = order.pentol_order_items;
      const descriptions = items.map(item => {
        const row = stockById.get(item.stock_id);
        return (row ? products.get(row.sku) + ' · ' + row.batch_code : 'Varian batch') + ' × ' + format.format(item.quantity);
      });
      const total = items.reduce((sum, item) => sum + item.quantity * item.unit_price, 0);
      charges += total;
      packs += items.reduce((sum, item) => sum + item.quantity, 0);
      const dates = weekly ? [displayDate.format(new Date(order.order_date))] : [];
      const tr = tableRow([...dates, order.customer, descriptions.join('\n'), 'Rp' + format.format(total),
        order.paid ? 'Lunas' : 'Belum dibayar', order.delivered ? 'Sudah diantar' : 'Belum diantar']);
      tr.cells[weekly ? 2 : 1].className = 'order-description';
      const actions = tr.insertCell();
      if (!order.paid) actions.append(orderAction('Tandai lunas', order.id, true, false));
      if (!order.delivered) actions.append(orderAction('Tandai diantar', order.id, false, true));
      return tr;
    }));
    emptyRow(target, weekly ? 7 : 6, weekly
      ? 'Belum ada pesanan tercatat pada minggu ini.'
      : 'Belum ada pesanan tercatat pada tanggal ini.');
    summary.textContent = period + format.format(orders.length) + ' pesanan · '
      + format.format(packs) + ' pack · Tagihan Rp' + format.format(charges);
  } catch (error) {
    if (generation !== orderLoad || !session) return;
    summary.textContent = error.status === 404
      ? 'Database pesanan belum diaktifkan.'
      : 'Daftar pesanan gagal dimuat. Pilih ulang tanggal untuk mencoba lagi.';
  }
}

function orderAction(label, id, paid, delivered) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'secondary';
  button.textContent = label;
  button.addEventListener('click', () => run(button, async () => {
    try {
      await request('/rest/v1/rpc/pentol_update_order', { method:'POST',
        body:{ order_id:id, mark_paid:paid, mark_delivered:delivered } });
    } catch (error) {
      status(error.message === 'Stok fisik belum cukup untuk pengantaran.' ? error.message
        : 'Perubahan belum terkonfirmasi. Periksa kembali daftar pesanan.', true);
      await loadOrders();
      return;
    }
    await refreshAfterOrder('Status pesanan tersimpan.');
  }));
  return button;
}

async function refreshAfterOrder(message) {
  try {
    await loadRows();
    await loadOrders();
    status(message);
  } catch {
    status('Perubahan tersimpan. Masuk kembali untuk memuat stok terbaru.', true);
  }
}

$('new-order').addEventListener('click', () => {
  if (busy || !orderForm.hidden) return;
  if (!rows.length) return status('Tambahkan varian ke batch sebelum mencatat pesanan.', true);
  draftId = crypto.randomUUID();
  orderForm.elements.order_date.value = orderDate.value || today();
  addOrderItem();
  orderForm.hidden = false;
  $('new-order').setAttribute('aria-expanded', 'true');
  orderForm.elements.customer.focus();
});
$('add-item').addEventListener('click', () => { if (!busy) addOrderItem(); });
$('cancel-order').addEventListener('click', () => {
  if (busy) return;
  resetOrderForm();
  $('new-order').focus();
});
orderDate.addEventListener('change', loadOrders);
orderPeriod.addEventListener('change', loadOrders);
$('previous-week').addEventListener('click', () => moveOrderWeek(-7));
$('next-week').addEventListener('click', () => moveOrderWeek(7));

orderForm.addEventListener('submit', event => {
  event.preventDefault();
  run($('save-order'), async () => {
    const customer = orderForm.elements.customer.value.trim();
    if (!customer) return status('Isi nama pelanggan.', true);
    const items = Array.from(orderItems.children, line => ({
      stock_id:line.querySelector('select').value,
      quantity:Number(line.querySelector('[name="quantity"]').value),
      unit_price:Number(line.querySelector('[name="unit_price"]').value)
    }));
    if (new Set(items.map(item => item.stock_id)).size !== items.length) {
      return status('Gabungkan jumlah untuk varian yang sama pada batch yang sama.', true);
    }
    const date = orderForm.elements.order_date.value;
    try {
      await request('/rest/v1/rpc/pentol_create_order', { method:'POST',
        body:{ order_id:draftId, order_day:date, customer_name:customer, is_paid:orderForm.elements.paid.checked, items } });
    } catch (error) {
      return status(error.status === 404 ? 'Database pesanan belum diaktifkan.'
        : 'Penyimpanan belum terkonfirmasi. Periksa daftar atau coba lagi dari form yang sama.', true);
    }
    resetOrderForm();
    orderDate.value = date;
    await refreshAfterOrder('Pesanan tersimpan dan stok batch diperbarui.');
  });
});

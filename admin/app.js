import { supabaseUrl, supabasePublishableKey } from './config.js';
import { initOperations } from './operations.js?v=ui-4';

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
let draftOrder;
let draftInbox;
let orderLoad = 0;
let loadedOrders = [];
let loadedPeriod = { weekly:false, period:'' };
const orderSearch = $('order-search');
const orderStatus = $('order-status');
const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone:'Asia/Jakarta' }).format(new Date());
orderDate.value = today();
$('business-date').textContent = new Intl.DateTimeFormat('id-ID', {
  weekday:'short', day:'numeric', month:'short', year:'numeric', timeZone:'Asia/Jakarta'
}).format(new Date());
let session = null;
let rows = [];
let editing = null;
let busy = false;
const configured = /^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/.test(supabaseUrl)
  && /^sb_publishable_[A-Za-z0-9_-]+$/.test(supabasePublishableKey);
const base = supabaseUrl.replace(/\/$/, '');

const sessionKey = 'pentol-admin-session:' + base;

function saveSession(current) {
  try {
    if (!current) sessionStorage.removeItem(sessionKey);
    else {
      const { accessToken, refreshToken, expiresAt } = current;
      sessionStorage.setItem(sessionKey, JSON.stringify({ accessToken, refreshToken, expiresAt }));
    }
  } catch {
    // Login still works in memory when browser storage is disabled.
  }
}

function readSession() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(sessionKey));
    if (typeof saved?.accessToken === 'string' && typeof saved.refreshToken === 'string'
        && Number.isFinite(saved.expiresAt)) return { ...saved, refreshing: null };
  } catch {
    // Treat unavailable or invalid storage as a fresh visit.
  }
  return null;
}

function status(message, error = false) {
  $('status').textContent = message;
  $('status').dataset.error = String(error);
}

async function refreshSession(current) {
  if (current.refreshing) return current.refreshing;
  current.refreshing = (async () => {
    try {
      const auth = await request('/auth/v1/token?grant_type=refresh_token', {
        method: 'POST', body: { refresh_token: current.refreshToken }, token: null
      });
      if (session !== current) throw new Error('Sesi sudah ditutup.');
      current.accessToken = auth.access_token;
      current.refreshToken = auth.refresh_token;
      current.expiresAt = Date.now() + auth.expires_in * 1000;
      saveSession(current);
    } catch (error) {
      if (session === current && [400, 401, 403].includes(error.status)) {
        endSession('Sesi berakhir. Silakan masuk kembali.');
      }
      throw error;
    } finally {
      current.refreshing = null;
    }
  })();
  return current.refreshing;
}

async function request(path, { method = 'GET', body, token, prefer } = {}) {
  const current = token === undefined ? session : null;
  const headers = { apikey: supabasePublishableKey };
  if (body) headers['Content-Type'] = 'application/json';
  if (prefer) headers.Prefer = prefer;

  const send = accessToken => {
    if (accessToken) headers.Authorization = 'Bearer ' + accessToken;
    return fetch(base + path, { method, headers, body: body && JSON.stringify(body) });
  };

  if (current && current.expiresAt - Date.now() < 60_000) await refreshSession(current);
  if (current && session !== current) throw new Error('Sesi sudah ditutup.');
  const accessToken = current?.accessToken ?? token;
  let response = await send(accessToken);
  if (response.status === 401 && current && session === current) {
    if (current.accessToken === accessToken) await refreshSession(current);
    if (session !== current) throw new Error('Sesi sudah ditutup.');
    response = await send(current.accessToken);
  }
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
}

function endSession(message) {
  session = null;
  saveSession(null);
  rows = [];
  orderLoad++;
  ops.clear();
  resetOrderForm();
  $('order-rows').replaceChildren();
  $('orders-summary').textContent = '';
  loadedOrders = [];
  orderSearch.value = '';
  orderStatus.value = 'all';
  $('order-metrics').replaceChildren();
  $('stock-metrics').replaceChildren();
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

function metricCards(target, values) {
  target.replaceChildren(...values.map(([label, value]) => {
    const card = document.createElement('div');
    card.className = 'metric';
    const number = document.createElement('strong');
    number.textContent = typeof value === 'number' ? format.format(value) : value;
    card.append(number, label);
    return card;
  }));
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
  form.reset();
  form.elements.received_on.value = row.received_on ?? '';
  form.elements.received.value = row.received;
  form.elements.received.min = row.delivered;
  $('editor-target').textContent = row.batch_code + ' · ' + products.get(row.sku) + ' · sudah diantar ' + row.delivered + ' pack';
  form.hidden = false;
  form.elements.received.focus();
}

// Booking yang tidak dimiliki pesanan aktif (sisa data lama atau Excel), per baris stok.
let ownedBookings = null;
const unowned = row => ownedBookings ? Math.max(0, row.reserved - (ownedBookings.get(row.id) || 0)) : 0;

function renderStock() {
  const target = $('stock-rows');
  const query = stockSearch.value.trim().toLocaleLowerCase('id');
  const visible = rows.filter(row => (!stockBatch.value || stockBatch.value === row.batch_code)
    && products.get(row.sku).toLocaleLowerCase('id').includes(query));
  $('stock-summary').textContent = visible.length + ' varian batch ditampilkan';
  const batchRows = rows.filter(row => !stockBatch.value || stockBatch.value === row.batch_code);
  const counts = batchRows.reduce((sum, row) => {
    quantities(row).forEach((value, i) => { sum[i] += value; });
    return sum;
  }, [0,0,0,0,0]);
  const orphan = batchRows.reduce((sum, row) => sum + unowned(row), 0);
  metricCards($('stock-metrics'), [
    ['Siap dijual · pack', counts[3]], ['Terpesan · pack', counts[1]],
    ['Sudah diantar · pack', counts[2]], ['Belum terpenuhi · pack', counts[4]],
    ...(orphan ? [['Booking tanpa pesanan · pack', orphan]] : [])
  ]);
  const labels = ['Batch', 'Varian', 'Diterima', 'Terpesan', 'Diantar', 'Sisa jual', 'Belum terpenuhi'];
  target.replaceChildren(...visible.map(row => {
    const tr = tableRow([row.batch_code, products.get(row.sku), ...quantities(row)]);
    Array.from(tr.cells).forEach((cell, i) => { cell.dataset.label = labels[i]; });
    if (unowned(row)) tr.cells[3].textContent += ' · ' + format.format(unowned(row)) + ' tanpa pesanan';
    const button = document.createElement('button');
    button.className = 'secondary';
    button.textContent = 'Koreksi';
    button.type = 'button';
    button.setAttribute('aria-label', 'Koreksi diterima ' + row.batch_code + ' ' + products.get(row.sku));
    button.addEventListener('click', () => { if (!busy) edit(row); });
    const actionCell = tr.insertCell();
    actionCell.dataset.label = 'Aksi';
    actionCell.append(button);
    return tr;
  }));
  emptyRow(target, 8, rows.length ? 'Tidak ada stok yang cocok dengan filter.' : 'Belum ada data batch. Catat restok di Restok & Supplier untuk mulai.');
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
  ownedBookings = await loadOwnedBookings().catch(() => null);
  if (session !== token) return;
  renderRows();
}

async function loadOwnedBookings() {
  const owned = new Map();
  for (let offset = 0; ; offset += 1000) {
    const page = await request('/rest/v1/pentol_order_items?select=stock_id,quantity,shipped,pentol_orders!inner(cancelled)'
      + '&pentol_orders.cancelled=eq.false&order=order_id,stock_id&limit=1000&offset=' + offset);
    for (const item of page) owned.set(item.stock_id, (owned.get(item.stock_id) || 0) + item.quantity - item.shipped);
    if (page.length < 1000) return owned;
  }
}

async function run(button, action) {
  if (busy) return;
  busy = true;
  button.disabled = true;
  try { await action(); }
  finally { busy = false; button.disabled = false; }
}

async function showDashboard() {
  await loadRows();
  await ops.loadPrices().catch(() => {});
  $('signin').hidden = true;
  $('dashboard').hidden = false;
  $('logout').hidden = false;
  status('');
  selectView(currentView);
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
      session = {
        accessToken: auth.access_token,
        refreshToken: auth.refresh_token,
        expiresAt: Date.now() + auth.expires_in * 1000,
        refreshing: null
      };
      await showDashboard();
      saveSession(session);
    } catch (error) {
      session = null;
      status(error.status === 400 || error.status === 401 ? 'Periksa kembali email dan kata sandi.' : 'Akses admin belum bisa dimuat. Coba lagi.', true);
    } finally { login.elements.password.value = ''; }
  });
});

form.addEventListener('submit', event => {
  event.preventDefault();
  run($('save'), async () => {
    const current = editing;
    if (!current) return;
    const received = Number(form.elements.received.value);
    const receivedOn = form.elements.received_on.value || null;
    const reason = form.elements.reason.value.trim();
    if (!reason) return status('Isi alasan koreksi.', true);
    if (received > 0 && !receivedOn) return status('Isi tanggal diterima.', true);
    if (received < current.delivered) return status('Diterima tidak boleh kurang dari yang sudah diantar (' + current.delivered + ' pack).', true);
    let saved = false;
    let message = 'Koreksi stok tersimpan dan tercatat di Riwayat Perubahan.';
    try {
      try {
        await request('/rest/v1/rpc/pentol_correct_received', { method:'POST', body:{
          stock_id:current.id, expected_revision:current.revision, new_received:received,
          new_received_on:receivedOn, change_reason:reason } });
      } catch (error) {
        if (error.status !== 404) throw error;
        // Sementara, sebelum stock-integrity-2026-11.sql dijalankan: simpan langsung seperti form lama.
        const updated = await request('/rest/v1/pentol_batch_stock?id=eq.' + encodeURIComponent(current.id)
          + '&revision=eq.' + current.revision, { method:'PATCH', prefer:'return=representation',
          body:{ received, received_on:receivedOn, revision:current.revision + 1 } });
        if (!updated?.length) throw Object.assign(new Error('Stok berubah. Muat ulang daftar stok.'), {status:409});
        message = 'Jumlah diterima tersimpan. Riwayat koreksi aktif setelah SQL terbaru dijalankan di Supabase.';
      }
      saved = true;
      resetEditor();
      await loadRows();
      status(message);
    } catch (error) {
      status(saved ? 'Koreksi tersimpan, tetapi daftar gagal dimuat. Masuk kembali untuk melihat data terbaru.'
        : /^(Stok berubah|Jumlah diterima|Isi tanggal|Tanggal diterima|Alasan koreksi)/.test(error.message) ? error.message
        : 'Koreksi belum terkonfirmasi. Muat ulang daftar stok sebelum mencoba lagi.', true);
    }
  });
});

$('new-entry').addEventListener('click', () => {
  if (!busy) selectView('purchasing');
});
$('cancel').addEventListener('click', () => {
  if (busy) return;
  resetEditor();
});
stockBatch.addEventListener('change', renderStock);
stockSearch.addEventListener('input', renderStock);
$('logout').addEventListener('click', () => {
  if (!busy) endSession('Anda sudah keluar.');
});
filter.addEventListener('change', renderAnalytics);
const isMobile = () => matchMedia('(max-width: 900px)').matches;
const moreMenu = $('more-menu');
const quickButtons = document.querySelectorAll('.bottom-nav [data-go]');

function setMenuExpanded(expanded) {
  menuToggle.setAttribute('aria-expanded', String(expanded));
  moreMenu.setAttribute('aria-expanded', String(expanded));
  document.body.classList.toggle('menu-open', expanded);
}

// Navigasi bawah di HP: empat menu harian dan "Lainnya" untuk menu lengkap.
function syncQuickNav(view) {
  let matched = false;
  quickButtons.forEach(button => {
    const current = button.dataset.go === view;
    matched ||= current;
    if (current) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  if (matched) moreMenu.removeAttribute('aria-current');
  else moreMenu.setAttribute('aria-current', 'page');
}
quickButtons.forEach(button => button.addEventListener('click', () => {
  setMenuExpanded(false);
  openNav(button.dataset.go);
}));
moreMenu.addEventListener('click', () => setMenuExpanded(moreMenu.getAttribute('aria-expanded') !== 'true'));
syncQuickNav('today');
document.addEventListener('click', event => {
  if (document.body.classList.contains('menu-open') && !event.target.closest('.admin-sidebar, .bottom-nav')) setMenuExpanded(false);
});

menuToggle.addEventListener('click', () => {
  setMenuExpanded(menuToggle.getAttribute('aria-expanded') !== 'true');
});
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || !isMobile()
      || menuToggle.getAttribute('aria-expanded') !== 'true') return;
  setMenuExpanded(false);
  moreMenu.focus();
});

// Menu utama dengan beberapa bagian ditampilkan sebagai tab di atas halaman.
const viewGroups = {
  orders: [['orders', 'Daftar pesanan'], ['packing', 'Packing & antar'], ['receivables', 'Tagihan']],
  stock: [['stock', 'Stok per batch'], ['purchasing', 'Restok & PO']],
  finance: [['finance', 'Laba & harga'], ['closeDay', 'Tutup hari']]
};
const groupOf = view => Object.keys(viewGroups).find(group => viewGroups[group].some(([id]) => id === view));
const lastInGroup = Object.fromEntries(Object.keys(viewGroups).map(group => [group, group]));
let currentView = 'today';

function renderSubtabs(group, view) {
  const bar = $('subtabs');
  bar.hidden = !group;
  if (!group) return bar.replaceChildren();
  bar.replaceChildren(...viewGroups[group].map(([id, label]) => {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.textContent = label;
    if (id === view) tab.setAttribute('aria-current', 'page');
    tab.addEventListener('click', () => { if (id !== currentView) selectView(id); });
    return tab;
  }));
}

function selectView(view, packingMode) {
  const group = groupOf(view);
  if (group) lastInGroup[group] = view;
  currentView = view;
  const navView = group || view;
  menuButtons.forEach(tab => tab.setAttribute('aria-pressed', String(tab.dataset.view === navView)));
  document.querySelectorAll('.admin-content > .panel').forEach(panel => { panel.hidden = panel.id !== view; });
  renderSubtabs(group, view);
  const navLabel = Array.from(menuButtons).find(tab => tab.dataset.view === navView).querySelector('span:last-child').textContent;
  const subLabel = group ? viewGroups[group].find(([id]) => id === view)[1] : '';
  $('mobile-view-label').textContent = navLabel;
  document.title = (subLabel && subLabel !== navLabel ? subLabel + ' · ' : '') + navLabel + ' · Admin Pentol Gilaaa';
  syncQuickNav(navView);
  if (isMobile()) {
    setMenuExpanded(false);
    scrollTo({top:0});
    $(view).querySelector('h2').focus({preventScroll:true});
  }
  if (view === 'orders') { loadOrders(); ops.inbox(); }
  else ops.open(view, packingMode);
}

// Menu utama membuka bagian terakhir yang dipakai di grup itu.
const openNav = view => selectView(viewGroups[view] ? lastInGroup[view] : view);
menuButtons.forEach(button => button.addEventListener('click', () => openNav(button.dataset.view)));
$('refresh-today').addEventListener('click', () => run($('refresh-today'), async () => {
  try { await loadRows(); }
  catch { return status('Stok belum bisa diperbarui. Coba muat ulang lagi.', true); }
  status('');
  await ops.open('today');
}));

function resetOrderForm() {
  draftId = null;
  draftOrder = null;
  draftInbox = null;
  orderForm.reset();
  orderItems.replaceChildren();
  $('order-estimate').textContent = '';
  orderForm.hidden = true;
  $('new-order').setAttribute('aria-expanded', 'false');
}

function populateOrderStock(select) {
  const previous = select.value;
  select.replaceChildren(new Option('Pilih varian dan batch', ''), ...rows.map(row =>
    new Option(products.get(row.sku) + ' · ' + row.batch_code + ' · sisa ' + quantities(row)[3], row.id)));
  if (rows.some(row => row.id === previous)) select.value = previous;
}

function addOrderItem(item) {
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
  if (item) {
    select.value = item.stock_id || '';
    line.querySelector('[name="quantity"]').value = item.quantity;
    line.querySelector('[name="unit_price"]').value = item.unit_price ?? '';
  }
  select.addEventListener('change', () => {
    const row = rows.find(item => item.id === select.value);
    line.querySelector('[name="unit_price"]').value = row ? prices[row.sku] : '';
    updateOrderEstimate();
  });
  line.querySelector('button').addEventListener('click', () => {
    if (!busy && orderItems.childElementCount > 1) { line.remove(); updateOrderEstimate(); }
  });
  orderItems.append(line);
  updateOrderEstimate();
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
  loadedOrders = [];
  $('order-metrics').replaceChildren();
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
      const page = await request('/rest/v1/pentol_orders?select=id,order_date,customer,paid,delivered,cancelled,revision,delivery_on,invoice_no,shipping_charge,shipping_cost,contact,delivery_location,delivery_note,pentol_payments(id,paid_on,amount),pentol_order_items(quantity,unit_price,stock_id,shipped)&order=order_date,created_at,id&limit=200&offset='
        + offset + rangeFilter);
      if (generation !== orderLoad || !session) return;
      orders.push(...page);
      if (page.length < 200) break;
    }
    loadedOrders = orders;
    loadedPeriod = { weekly, period };
    renderOrderList();
  } catch (error) {
    if (generation !== orderLoad || !session) return;
    summary.textContent = error.status === 404
      ? 'Database pesanan belum diaktifkan.'
      : 'Daftar pesanan gagal dimuat. Pilih ulang tanggal untuk mencoba lagi.';
  }
}

function renderOrderList() {
  const { weekly, period } = loadedPeriod;
  const stockById = new Map(rows.map(row => [row.id, row]));
  const active = loadedOrders.filter(order => !order.cancelled);
  const charges = active.reduce((sum, order) => sum + ops.total(order), 0);
  const packs = active.reduce((sum, order) => sum + order.pentol_order_items.reduce((qty, item) => qty + item.quantity, 0), 0);
  metricCards($('order-metrics'), [
    ['Total tagihan periode', 'Rp' + format.format(charges)],
    ['Pesanan aktif', active.length],
    ['Belum lunas', active.filter(order => !order.paid).length],
    ['Belum selesai diantar', active.filter(order => !order.delivered).length]
  ]);
  const query = orderSearch.value.trim().toLocaleLowerCase('id');
  const selectedStatus = orderStatus.value;
  const visible = loadedOrders.filter(order => {
    if (!order.customer.toLocaleLowerCase('id').includes(query)) return false;
    switch (selectedStatus) {
      case 'unpaid': return !order.cancelled && !order.paid;
      case 'pending': return !order.cancelled && !order.delivered;
      case 'delivered-unpaid': return !order.cancelled && order.delivered && !order.paid;
      case 'cancelled': return order.cancelled;
      default: return true;
    }
  });
  const target = $('order-rows');
  target.replaceChildren(...visible.map(order => {
    const descriptions = order.pentol_order_items.map(item => {
      const row = stockById.get(item.stock_id);
      return (row ? products.get(row.sku) : 'Varian batch') + ' × ' + format.format(item.quantity)
        + (row ? ' · ' + row.batch_code : '');
    });
    const dates = weekly ? [displayDate.format(new Date(order.order_date))] : [];
    const tr = tableRow([...dates, order.customer, descriptions.join('\n'), 'Rp' + format.format(ops.total(order)),
      ops.paymentLabel(order), ops.deliveryLabel(order)]);
    const labels = [...(weekly ? ['Tanggal'] : []), 'Pelanggan', 'Pesanan', 'Tagihan', 'Pembayaran', 'Pengantaran'];
    Array.from(tr.cells).forEach((cell, index) => { cell.dataset.label = labels[index]; });
    tr.cells[weekly ? 2 : 1].className = 'order-description';
    const offset = weekly ? 1 : 0;
    for (const [index, complete] of [[3,order.paid],[4,order.delivered]]) {
      const cell = tr.cells[offset + index];
      const chip = document.createElement('span');
      chip.className = 'status-chip ' + (order.cancelled ? 'cancelled' : complete ? 'good' : 'waiting');
      chip.textContent = cell.textContent;
      cell.replaceChildren(chip);
    }
    const actions = tr.insertCell();
    actions.dataset.label = 'Aksi';
    ops.orderButtons(order, actions);
    return tr;
  }));
  emptyRow(target, weekly ? 7 : 6, loadedOrders.length
    ? 'Tidak ada pesanan yang cocok. Ubah pencarian atau filter status.'
    : weekly ? 'Belum ada pesanan pada minggu ini.' : 'Belum ada pesanan pada tanggal ini.');
  $('orders-summary').textContent = period + visible.length + ' dari ' + loadedOrders.length
    + ' pesanan ditampilkan · ' + format.format(packs) + ' pack dalam periode ini';
}

function updateOrderEstimate() {
  const amount = Array.from(orderItems.children).reduce((sum, line) => sum
    + Number(line.querySelector('[name="quantity"]').value) * Number(line.querySelector('[name="unit_price"]').value), 0)
    + Number(orderForm.elements.shipping_charge.value);
  $('order-estimate').textContent = 'Total tagihan Rp' + format.format(amount);
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

function openOrder(order = null, inboxEntry = null) {
  if (busy) return;
  if (!rows.length) return status('Tambahkan varian ke batch sebelum mencatat pesanan.', true);
  resetOrderForm();
  draftId = order?.id || crypto.randomUUID();
  draftOrder = order;
  draftInbox = inboxEntry;
  const e = orderForm.elements;
  e.order_date.value = order?.order_date || (inboxEntry ? today() : orderDate.value || today());
  e.customer.value = order?.customer || inboxEntry?.customer || '';
  e.delivery_on.value = order?.delivery_on || '';
  $('existing-booking-option').hidden = Boolean(order || inboxEntry);
  e.contact.value = order?.contact || inboxEntry?.phone || '';
  e.delivery_location.value = order?.delivery_location || inboxEntry?.area || '';
  e.delivery_note.value = order?.delivery_note || inboxEntry?.note || '';
  e.shipping_charge.value = order?.shipping_charge || 0;
  e.shipping_cost.value = order?.shipping_cost || 0;
  if (order) order.pentol_order_items.forEach(addOrderItem);
  else if (inboxEntry) {
    for (const item of inboxEntry.items) {
      const batches = rows.filter(row => row.sku === item.sku);
      const wholeBatch = batches.find(row => quantities(row)[3] >= item.quantity);
      let remaining = item.quantity;
      for (const batch of wholeBatch ? [wholeBatch] : batches) {
        const quantity = Math.min(remaining, quantities(batch)[3]);
        if (!quantity) continue;
        addOrderItem({ stock_id:batch.id, quantity, unit_price:prices[item.sku] });
        remaining -= quantity;
        if (!remaining) break;
      }
      if (remaining) {
        addOrderItem({ quantity:remaining, unit_price:prices[item.sku] });
        status('Sebagian stok belum tersedia. Pilih batch untuk sisa jumlah sebelum menyimpan.', true);
      }
    }
  }
  else addOrderItem();
  orderForm.hidden = false;
  $('order-editor-title').textContent = order ? 'Edit pesanan · ' + order.customer : 'Catat pesanan';
  updateOrderEstimate();
  $('new-order').setAttribute('aria-expanded', 'true');
  $('save-order').textContent = order ? 'Simpan perubahan' : 'Simpan pesanan';
  e.customer.focus();
}
$('new-order').addEventListener('click', () => { if (orderForm.hidden) openOrder(); });
$('add-item').addEventListener('click', () => { if (!busy) addOrderItem(); });
$('cancel-order').addEventListener('click', () => {
  if (busy) return;
  resetOrderForm();
  $('new-order').focus();
});
orderSearch.addEventListener('input', renderOrderList);
orderStatus.addEventListener('change', renderOrderList);
$('refresh-orders').addEventListener('click', () => run($('refresh-orders'), async () => {
  await loadOrders();
  await ops.inbox();
}));
orderForm.addEventListener('input', updateOrderEstimate);
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
      const e = orderForm.elements;
      await ops.mutate(draftOrder ? 'edit' : 'create', draftId, draftOrder?.revision, {
        date, customer, delivery_on:e.delivery_on.value || null,
        shipping_charge:Number(e.shipping_charge.value), shipping_cost:Number(e.shipping_cost.value),
        contact:e.contact.value.trim(), delivery_location:e.delivery_location.value.trim(),
        delivery_note:e.delivery_note.value.trim(), inbox_id:draftInbox?.id,
        use_existing_booking:e.use_existing_booking.checked, items
      });
    } catch (error) {
      return status(error.status === 404 ? 'Database pesanan belum diaktifkan.'
        : ops.errorMessage(error), true);
    }
    resetOrderForm();
    orderDate.value = date;
    await refreshAfterOrder('Pesanan tersimpan dan stok batch diperbarui.');
    ops.inbox();
  });
});

const ops = initOperations({
  $, request, status, products, prices, today, format, tableRow, emptyRow, quantities,
  getRows:() => rows, getSession:() => session, openOrder,
  refresh:refreshAfterOrder, selectView, loadRows
});

async function restoreSession() {
  if (!configured) {
    status('Login admin menunggu konfigurasi database.');
    return;
  }
  session = readSession();
  if (!session) {
    $('signin').hidden = false;
    return;
  }
  status('Memulihkan sesi…');
  try {
    const access = await request('/rest/v1/pentol_admins?select=user_id&limit=1');
    if (!access.length) {
      endSession('Akun ini belum terdaftar sebagai admin.');
      return;
    }
    await showDashboard();
  } catch (error) {
    if (!session) return;
    if ([401, 403].includes(error.status)) {
      endSession('Sesi berakhir. Silakan masuk kembali.');
      return;
    }
    session = null;
    $('signin').hidden = false;
    status('Sesi belum bisa dimuat. Periksa koneksi lalu muat ulang halaman.', true);
  }
}

restoreSession();

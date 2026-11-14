import { supabaseUrl, supabasePublishableKey } from './config.js';
import { initOperations } from './operations.js?v=lunas-23';

const products = new Map([
  ['UR','Pentol Urat'], ['PK','Pentol Kecil'], ['TP','Tahu Pentol'],
  ['JM','Pentol Jamur'], ['MZ','Pentol Mozzarella'], ['RJ','Pentol Ranjau'],
  ['TD','Tahu Pedas'], ['PG','Pentol Goreng'], ['SG','Sambal Gila Tambahan']
]);
const $ = id => document.getElementById(id);
const format = new Intl.NumberFormat('id-ID');
const login = $('login');
const form = $('batch-form');
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

// Sesi disimpan di localStorage agar tetap masuk setelah aplikasi/tab ditutup.
// Sesi hanya berakhir lewat tombol Keluar, atau bila server menolak perpanjangan sesi.
function saveSession(current) {
  try {
    if (!current) localStorage.removeItem(sessionKey);
    else {
      const { accessToken, refreshToken, expiresAt } = current;
      localStorage.setItem(sessionKey, JSON.stringify({ accessToken, refreshToken, expiresAt }));
    }
    sessionStorage.removeItem(sessionKey);
  } catch {
    // Login still works in memory when browser storage is disabled.
  }
}

function parseSaved(text) {
  try {
    const saved = JSON.parse(text);
    if (typeof saved?.accessToken === 'string' && typeof saved.refreshToken === 'string'
        && Number.isFinite(saved.expiresAt)) return { ...saved, refreshing: null };
  } catch {
    // Treat invalid storage as a fresh visit.
  }
  return null;
}

function readSession() {
  try {
    // Sesi lama dari sessionStorage (versi sebelumnya) ikut dipakai sekali.
    return parseSaved(localStorage.getItem(sessionKey)) || parseSaved(sessionStorage.getItem(sessionKey));
  } catch {
    return null;
  }
}

// Tab lain sudah memperpanjang sesi? Pakai tokennya, jangan memperpanjang lagi dengan token lama
// (Supabase bisa mencabut seluruh sesi bila refresh token lama dipakai ulang).
function adoptStoredSession(current) {
  const stored = readSession();
  if (!stored || stored.refreshToken === current.refreshToken || stored.expiresAt - Date.now() < 60_000) return false;
  current.accessToken = stored.accessToken;
  current.refreshToken = stored.refreshToken;
  current.expiresAt = stored.expiresAt;
  return true;
}

addEventListener('storage', event => {
  if (event.key !== sessionKey || !session) return;
  if (event.newValue === null) endSession('Anda sudah keluar di tab lain.');
  else adoptStoredSession(session);
});

// Notifikasi di bawah layar. Pesan sukses hilang sendiri; pesan galat tetap sampai ditutup.
// action: {label, undo, commit} -> tombol Batalkan; commit dijalankan bila tidak dibatalkan.
let statusTimer;
let pendingCommit = null;
function status(message, error = false, action = null) {
  const box = $('status');
  clearTimeout(statusTimer);
  if (pendingCommit) { const commit = pendingCommit; pendingCommit = null; commit(); }
  box.replaceChildren();
  box.dataset.error = String(error);
  if (!message) return;
  const text = document.createElement('span');
  text.textContent = message;
  box.append(text);
  if (action) {
    pendingCommit = action.commit;
    const undo = document.createElement('button');
    undo.type = 'button';
    undo.textContent = action.label;
    undo.addEventListener('click', () => { pendingCommit = null; action.undo(); status(''); });
    box.append(undo);
  } else if (error) {
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = '×';
    close.setAttribute('aria-label', 'Tutup pesan');
    close.addEventListener('click', () => status(''));
    box.append(close);
  }
  if (!error) statusTimer = setTimeout(() => status(''), action ? 6000 : 4000);
}

async function refreshSession(current) {
  if (current.refreshing) return current.refreshing;
  current.refreshing = (async () => {
    try {
      if (adoptStoredSession(current)) return;
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
  setOrderChip('action');
  clearInterval(badgeTimer);
  badgeTotal = 0;
  lastCounts = '';
  document.querySelectorAll('.nav-badge').forEach(badge => badge.remove());
  customerBook = null;
  $('customer-list').replaceChildren();
  $('order-metrics').replaceChildren();
  $('stock-metrics').replaceChildren();
  setMenuExpanded(false);
  $('dashboard').hidden = true;
  $('logout').hidden = true;
  $('refresh-view').hidden = true;
  $('stock-rows').replaceChildren();
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

// Kartu per varian: angka besar "siap jual", warna saat menipis/habis, tombol Restok.
const LOW_STOCK = 5;
let openPurchases = [];
// Barang yang sudah dipesan ke supplier tapi belum diterima, per varian, dengan estimasi tiba terdekat.
function incomingStock() {
  const incoming = new Map();
  for (const purchase of openPurchases || []) {
    for (const item of purchase.pentol_purchase_items || []) {
      const row = rows.find(r => r.batch_code === purchase.batch_code && r.sku === item.sku);
      const left = item.quantity - (row?.received || 0);
      if (left <= 0) continue;
      const known = incoming.get(item.sku) || { quantity: 0, eta: '' };
      known.quantity += left;
      if (purchase.expected_on && (!known.eta || purchase.expected_on < known.eta)) known.eta = purchase.expected_on;
      incoming.set(item.sku, known);
    }
  }
  return incoming;
}
function renderVariants() {
  const incoming = incomingStock();
  $('stock-variants').replaceChildren(...Array.from(products, ([sku, name]) => {
    const own = rows.filter(row => row.sku === sku);
    const sums = own.reduce((sum, row) => { quantities(row).forEach((value, i) => { sum[i] += value; }); return sum; }, [0,0,0,0,0]);
    const ready = sums[3];
    const card = document.createElement('article');
    card.className = 'variant-card';
    const coming = incoming.get(sku);
    const needs = ready === 0 ? 'out' : ready <= LOW_STOCK ? 'low' : 'ok';
    // Sudah dipesan ke supplier: jangan minta restok lagi.
    card.dataset.level = needs !== 'ok' && coming ? 'incoming' : needs;
    const title = document.createElement('h3');
    title.textContent = name;
    const number = document.createElement('strong');
    number.textContent = format.format(ready);
    const label = document.createElement('p');
    label.textContent = card.dataset.level === 'incoming' ? (ready === 0 ? 'habis' : 'menipis') + ' · menunggu kiriman'
      : ready === 0 ? 'habis · siap jual' : ready <= LOW_STOCK ? 'menipis · siap jual' : 'pack siap jual';
    const meta = document.createElement('p');
    meta.className = 'variant-meta';
    meta.textContent = format.format(sums[1]) + ' terpesan · ' + own.length + ' batch'
      + (sums[4] ? ' · kurang ' + format.format(sums[4]) + ' untuk pesanan' : '');
    card.append(title, number, label, meta);
    if (coming) card.append(Object.assign(document.createElement('p'), { className: 'variant-incoming',
      textContent: '+' + format.format(coming.quantity) + ' dalam PO' + (coming.eta ? ' · tiba ' + ops.dayLabel(coming.eta) : '') }));
    if (card.dataset.level === 'out' || card.dataset.level === 'low') {
      const restock = document.createElement('button');
      restock.type = 'button';
      restock.className = 'secondary';
      restock.textContent = 'Restok';
      restock.addEventListener('click', () => selectView('purchasing'));
      card.append(restock);
    }
    return card;
  }));
}

function renderStock() {
  renderVariants();
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
  const previous = stockBatch.value;
  stockBatch.replaceChildren(new Option('Semua batch', ''), ...batches.map(code => new Option(code, code)));
  if (batches.includes(previous)) stockBatch.value = previous;
  renderStock();
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
  [ownedBookings, openPurchases] = await Promise.all([
    loadOwnedBookings().catch(() => null),
    request('/rest/v1/pentol_purchases?select=batch_code,expected_on,pentol_purchase_items(sku,quantity)&order=batch_code').catch(() => [])
  ]);
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
  $('refresh-view').hidden = false;
  status('');
  selectView(currentView);
  startBadges();
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
  if (busy || !session) return;
  // Cabut sesi di server juga (tanpa menunggu); data di perangkat langsung dihapus.
  const token = session.accessToken;
  fetch(base + '/auth/v1/logout?scope=local', { method: 'POST',
    headers: { apikey: supabasePublishableKey, Authorization: 'Bearer ' + token } }).catch(() => {});
  endSession('Anda sudah keluar.');
});
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
  orders: [['actions', 'Perlu tindakan'], ['orders', 'Semua pesanan'], ['packing', 'Packing'], ['delivery', 'Antar'], ['receivables', 'Tagihan']],
  stock: [['stock', 'Stok'], ['purchasing', 'Restok & PO']],
  finance: [['finance', 'Laba & harga'], ['closeDay', 'Tutup hari']]
};
const groupOf = view => Object.keys(viewGroups).find(group => viewGroups[group].some(([id]) => id === view));
const lastInGroup = Object.fromEntries(Object.keys(viewGroups).map(group => [group, viewGroups[group][0][0]]));
// "Perlu tindakan" dan "Semua pesanan" memakai panel yang sama (#orders) dengan tampilan berbeda.
const panelOf = view => view === 'actions' ? 'orders' : view;
const deliveryModes = ['due', 'pending', 'unscheduled', 'date'];
// Halaman terakhir disimpan di alamat (#tagihan dsb.) agar refresh browser membuka halaman yang sama.
const knownViews = () => [...Array.from(document.querySelectorAll('.admin-content > .panel'), panel => panel.id), 'actions'];
let currentView = (() => {
  const wanted = decodeURIComponent(location.hash.slice(1));
  return knownViews().includes(wanted) && wanted !== 'signin' ? wanted : 'today';
})();

function renderSubtabs(group, view) {
  const bar = $('subtabs');
  bar.hidden = !group;
  bar.classList.toggle('many', Boolean(group) && viewGroups[group].length > 3);
  if (!group) return bar.replaceChildren();
  bar.replaceChildren(...viewGroups[group].map(([id, label]) => {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.textContent = label;
    if (id === view) tab.setAttribute('aria-current', 'page');
    tab.addEventListener('click', () => { if (id !== currentView) selectView(id); });
    return tab;
  }));
  // 5 sub menu di HP bisa lebih lebar dari layar: geser agar yang aktif terlihat.
  bar.querySelector('[aria-current]')?.scrollIntoView({ inline:'nearest', block:'nearest' });
}

function selectView(view, packingMode, { keepScroll = false } = {}) {
  if (view === 'packing' && deliveryModes.includes(packingMode)) view = 'delivery';
  const group = groupOf(view);
  if (group) lastInGroup[group] = view;
  currentView = view;
  const navView = group || view;
  menuButtons.forEach(tab => tab.setAttribute('aria-pressed', String(tab.dataset.view === navView)));
  document.querySelectorAll('.admin-content > .panel').forEach(panel => { panel.hidden = panel.id !== panelOf(view); });
  renderSubtabs(group, view);
  const navLabel = Array.from(menuButtons).find(tab => tab.dataset.view === navView).querySelector('span:not(.nav-icon):not(.nav-badge)').textContent;
  const subLabel = group ? viewGroups[group].find(([id]) => id === view)[1] : '';
  $('mobile-view-label').textContent = navLabel;
  document.title = (badgeTotal ? '(' + badgeTotal + ') ' : '') + (subLabel && subLabel !== navLabel ? subLabel + ' · ' : '') + navLabel + ' · Admin Pentol Gilaaa';
  syncQuickNav(navView);
  try { history.replaceState(null, '', '#' + view); } catch {}
  if (isMobile() && !keepScroll) {
    setMenuExpanded(false);
    scrollTo({top:0});
    $(panelOf(view)).querySelector('h2').focus({preventScroll:true});
  }
  if (view === 'orders' || view === 'actions') { setOrdersMode(view); loadOrders(); ops.inbox(); }
  else ops.open(view, packingMode);
}

// Tombol ↻ di header: muat ulang data halaman yang sedang dibuka, tanpa pindah halaman.
$('refresh-view').addEventListener('click', () => run($('refresh-view'), async () => {
  $('refresh-view').classList.add('spinning');
  try {
    await loadRows();
    selectView(currentView, undefined, { keepScroll: true });
    refreshBadges();
    status('Data diperbarui.');
  } catch {
    status('Data belum bisa dimuat. Periksa internet lalu coba lagi.', true);
  } finally {
    $('refresh-view').classList.remove('spinning');
  }
}));

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
  $('order-edit-note').hidden = true;
  orderItems.replaceChildren();
  $('order-quick').replaceChildren();
  $('order-more').open = false;
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
    if (item.sku) line.dataset.sku = item.sku;
    // Baris dari pesanan yang sedang diubah: jumlah antar menjadi batas bawah, batch & baris dikunci.
    if (item.shipped) {
      line.dataset.shipped = item.shipped;
      line.querySelector('[name="quantity"]').min = item.shipped;
      select.disabled = true;
      line.querySelector('button').disabled = true;
      line.querySelector('button').title = 'Sudah diantar ' + item.shipped + ' pack';
    }
  }
  select.addEventListener('change', () => {
    const row = rows.find(item => item.id === select.value);
    line.querySelector('[name="unit_price"]').value = row ? prices[row.sku] : '';
    updateOrderEstimate();
  });
  line.querySelector('button').addEventListener('click', () => {
    if (!busy) { line.remove(); updateOrderEstimate(); }
  });
  orderItems.append(line);
  updateOrderEstimate();
}

// ===== Pilih varian dengan tombol − / +. Baris batch & harga diatur otomatis. =====
const lineSku = line => rows.find(row => row.id === line.querySelector('select').value)?.sku || line.dataset.sku;

// Booking pesanan yang sedang diubah ikut dihitung sebagai stok yang boleh dipakai lagi.
const ownBooked = stockId => {
  const item = draftOrder?.pentol_order_items.find(i => i.stock_id === stockId);
  return item ? item.quantity - item.shipped : 0;
};
const freeFor = row => quantities(row)[3] + ownBooked(row.id);
const lineShipped = line => Number(line.dataset.shipped || 0);

// Bagi jumlah ke batch: satu batch yang cukup, kalau tidak dibagi; sisa tanpa batch dipilih admin.
function allocate(sku, quantity, price, skip = new Set()) {
  const batches = rows.filter(row => row.sku === sku && !skip.has(row.id)).map(row => ({ ...row, free: freeFor(row) }));
  const whole = batches.find(row => row.free >= quantity);
  let remaining = quantity;
  for (const batch of whole ? [whole] : batches) {
    const take = Math.min(remaining, batch.free);
    if (!take) continue;
    addOrderItem({ stock_id:batch.id, quantity:take, unit_price:price, sku });
    remaining -= take;
    if (!remaining) break;
  }
  if (remaining) {
    addOrderItem({ quantity:remaining, unit_price:price, sku });
    $('order-more').open = true;
    status('Stok ' + products.get(sku) + ' kurang ' + remaining + ' pack. Pilih batch untuk sisanya di Rincian batch & harga.', true);
  }
}

function setSkuQuantity(sku, quantity) {
  const lines = Array.from(orderItems.children).filter(line => lineSku(line) === sku);
  const price = Number(lines[0]?.querySelector('[name="unit_price"]').value) || prices[sku];
  if ($('status').dataset.error === 'true' && $('status').textContent.startsWith('Stok ')) status('');
  // Baris yang sudah diantar tetap di batch-nya; sisanya dibagi ulang.
  const kept = lines.filter(line => lineShipped(line) > 0);
  const keptMin = kept.reduce((sum, line) => sum + lineShipped(line), 0);
  quantity = Math.max(quantity, keptMin);
  lines.filter(line => !kept.includes(line)).forEach(line => line.remove());
  let remaining = quantity - keptMin;
  for (const line of kept) {
    // Di atas jumlah antar, baris ini boleh memakai booking lamanya + stok bebas batch-nya.
    const row = rows.find(r => r.id === line.querySelector('select').value);
    const add = Math.min(remaining, row ? freeFor(row) : 0);
    line.querySelector('[name="quantity"]').value = lineShipped(line) + add;
    remaining -= add;
  }
  if (remaining > 0) allocate(sku, remaining, price, new Set(kept.map(line => line.querySelector('select').value)));
  renderQuickPick();
  updateOrderEstimate();
}

function renderQuickPick() {
  const counts = new Map();
  for (const line of orderItems.children) {
    const sku = lineSku(line);
    if (sku) counts.set(sku, (counts.get(sku) || 0) + Number(line.querySelector('[name="quantity"]').value || 0));
  }
  $('order-quick').replaceChildren(...Array.from(products, ([sku, name]) => {
    const count = counts.get(sku) || 0;
    const free = rows.filter(row => row.sku === sku).reduce((sum, row) => sum + freeFor(row), 0);
    const minimum = Array.from(orderItems.children).filter(line => lineSku(line) === sku).reduce((sum, line) => sum + lineShipped(line), 0);
    const item = document.createElement('div');
    item.className = 'quick-item' + (count ? ' selected' : free ? '' : ' empty');
    const info = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = name;
    const meta = document.createElement('small');
    meta.textContent = 'Rp' + format.format(prices[sku]) + ' · sisa ' + format.format(free);
    info.append(title, meta);
    const stepper = document.createElement('div');
    stepper.className = 'quick-stepper';
    const minus = document.createElement('button');
    minus.type = 'button';
    minus.textContent = '−';
    minus.disabled = count <= minimum;
    minus.setAttribute('aria-label', 'Kurangi ' + name);
    minus.addEventListener('click', () => setSkuQuantity(sku, count - 1));
    const value = document.createElement('input');
    value.type = 'number';
    value.min = '0';
    value.max = '1000';
    value.inputMode = 'numeric';
    value.value = count;
    value.setAttribute('aria-label', 'Jumlah ' + name);
    value.addEventListener('change', () => setSkuQuantity(sku, Math.max(0, Math.min(1000, Math.round(Number(value.value) || 0)))));
    const plus = document.createElement('button');
    plus.type = 'button';
    plus.textContent = '+';
    plus.setAttribute('aria-label', 'Tambah ' + name);
    plus.addEventListener('click', () => setSkuQuantity(sku, count + 1));
    stepper.append(minus, value, plus);
    item.append(info, stepper);
    return item;
  }));
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
  setOrderChip('all');
  loadOrders();
}

// Tombol cepat: tiga tampilan kerja (tanpa batas tanggal) dan "Semua" yang memakai filter tanggal/status.
let orderChip = 'action';
const chipFilters = {
  action: '&cancelled=eq.false&or=(paid.eq.false,delivered.eq.false)',
  unpaid: '&cancelled=eq.false&paid=eq.false',
  pending: '&cancelled=eq.false&delivered=eq.false'
};
const chipLabels = { action:'Perlu tindakan', unpaid:'Belum bayar', pending:'Belum antar', all:'Per tanggal' };
// Perlu tindakan: permintaan katalog + pesanan belum bayar/antar (tombol cepat).
// Semua pesanan: per tanggal/minggu dengan filter status.
function setOrdersMode(view) {
  const actions = view === 'actions';
  if (actions && orderChip === 'all') setOrderChip('action');
  if (!actions) setOrderChip('all');
  $('orders-title').textContent = actions ? 'Perlu tindakan' : 'Semua pesanan';
  $('orders-desc').textContent = actions ? 'Permintaan baru dan pesanan yang belum dibayar atau belum diantar.'
    : 'Semua pesanan per tanggal atau minggu, termasuk yang selesai dan dibatalkan.';
  $('checkout-inbox').hidden = !actions;
  document.querySelector('.order-chips').hidden = !actions;
  $('order-filters').hidden = actions;
  if (!actions) $('order-filters').open = true;
  // Pertama kali dibuka: minggu ini (harian sering kosong).
  if (!actions && !ordersModeSeen) { ordersModeSeen = true; orderPeriod.value = 'week'; }
}
let ordersModeSeen = false;
function setOrderChip(chip) {
  orderChip = chip;
  document.querySelectorAll('.order-chips [data-chip]').forEach(button =>
    button.setAttribute('aria-pressed', String(button.dataset.chip === chip)));
}
document.querySelectorAll('.order-chips [data-chip]').forEach(button => button.addEventListener('click', () => {
  setOrderChip(button.dataset.chip);
  loadOrders();
}));

async function loadOrders() {
  const generation = ++orderLoad;
  const chipMode = orderChip !== 'all';
  const weekly = chipMode || orderPeriod.value === 'week';
  $('order-date-column').hidden = !weekly;
  $('week-navigation').hidden = orderPeriod.value !== 'week';
  $('order-date-label').textContent = orderPeriod.value === 'week' ? 'Tanggal dalam minggu' : 'Tanggal';
  const target = $('order-rows');
  const summary = $('orders-summary');
  target.replaceChildren();
  loadedOrders = [];
  $('order-metrics').replaceChildren();
  if (!chipMode && !orderDate.value) {
    summary.textContent = 'Pilih tanggal untuk melihat pesanan.';
    return;
  }
  let rangeFilter = chipFilters[orderChip] || '';
  let period = chipLabels[orderChip] + ' · ';
  if (!chipMode) {
    const { first, last } = orderRange(orderDate.value, orderPeriod.value === 'week');
    rangeFilter = '&order_date=gte.' + first + '&order_date=lte.' + last;
    period = orderPeriod.value === 'week' ? displayDate.formatRange(new Date(first), new Date(last)) + ' · '
      : displayDate.format(new Date(orderDate.value)) + ' · ';
  }
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
  $('order-metrics').textContent = active.length + ' aktif · ' + active.filter(order => !order.paid).length + ' belum bayar · '
    + active.filter(order => !order.delivered).length + ' belum antar · Rp' + format.format(charges) + ' tagihan';
  const query = orderSearch.value.trim().toLocaleLowerCase('id');
  const digits = query.replace(/\D/g, '');
  // Cari nama, lokasi, nomor invoice, atau nomor WA (08… / 62…).
  const matchesQuery = order => !query
    || [order.customer, order.delivery_location || '', ops.invoiceNumber(order)].some(text => text.toLocaleLowerCase('id').includes(query))
    || (digits.length >= 3 && [(order.contact || '').replace(/\D/g, ''), String(order.invoice_no)].some(text =>
      text.includes(digits) || text.includes(digits.replace(/^0/, '62')) || text.replace(/^62/, '0').includes(digits)));
  const selectedStatus = orderStatus.value;
  const visible = loadedOrders.filter(order => {
    if (!matchesQuery(order)) return false;
    if (orderChip !== 'all') return true;
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
    // Ringkas: varian tanpa kode batch; jadwal, lokasi, invoice, dan WA di satu baris info.
    const items = order.pentol_order_items.map(item => {
      const row = stockById.get(item.stock_id);
      return (row ? products.get(row.sku) : 'Varian') + ' × ' + format.format(item.quantity);
    }).join(', ');
    const dates = weekly ? [displayDate.format(new Date(order.order_date))] : [];
    const tr = tableRow([...dates, '', items, 'Rp' + format.format(ops.total(order)), '']);
    const labels = [...(weekly ? ['Tanggal'] : []), 'Pelanggan', 'Pesanan', 'Tagihan', 'Status'];
    Array.from(tr.cells).forEach((cell, index) => { cell.dataset.label = labels[index]; });
    const offset = weekly ? 1 : 0;
    const who = tr.cells[offset];
    const name = document.createElement('strong');
    name.textContent = order.customer;
    const meta = document.createElement('small');
    meta.className = 'order-meta';
    meta.textContent = ['Invoice ' + ops.invoiceNumber(order), order.contact, order.delivery_location].filter(Boolean).join(' · ');
    who.append(name, meta);
    tr.cells[offset + 1].className = 'order-description';
    const state = tr.cells[offset + 3];
    for (const [label, complete] of [[ops.paymentLabel(order), order.paid], [ops.deliveryLabel(order), order.delivered]]) {
      const chip = document.createElement('span');
      chip.className = 'status-chip ' + (order.cancelled ? 'cancelled' : complete ? 'good' : 'waiting');
      chip.textContent = label;
      state.append(chip);
    }
    if (!order.cancelled && !order.delivered) {
      const when = document.createElement('span');
      when.className = 'order-when';
      when.textContent = order.delivery_on ? 'Antar ' + ops.dayLabel(order.delivery_on) : 'Belum dijadwalkan';
      state.append(when);
    }
    const actions = tr.insertCell();
    actions.dataset.label = 'Aksi';
    ops.orderButtons(order, actions);
    return tr;
  }));
  emptyRow(target, weekly ? 6 : 5, loadedOrders.length
    ? 'Tidak ada pesanan yang cocok dengan pencarian.'
    : orderChip === 'action' ? 'Semua pesanan sudah dibayar dan diantar. 🎉'
    : orderChip === 'unpaid' ? 'Tidak ada pesanan yang belum dibayar.'
    : orderChip === 'pending' ? 'Tidak ada pesanan yang belum diantar.'
    : orderPeriod.value === 'week' ? 'Belum ada pesanan pada minggu ini.' : 'Belum ada pesanan pada tanggal ini.');
  $('orders-summary').textContent = period + visible.length + ' dari ' + loadedOrders.length
    + ' pesanan · ' + format.format(packs) + ' pack';
}

function updateOrderEstimate() {
  const amount = Array.from(orderItems.children).reduce((sum, line) => sum
    + Number(line.querySelector('[name="quantity"]').value) * Number(line.querySelector('[name="unit_price"]').value), 0)
    + Number(orderForm.elements.shipping_charge.value);
  $('order-estimate').textContent = 'Total tagihan Rp' + format.format(amount);
}

async function refreshAfterOrder(message) {
  refreshBadges();
  try {
    await loadRows();
    await loadOrders();
    status(message);
  } catch {
    status('Perubahan tersimpan. Masuk kembali untuk memuat stok terbaru.', true);
  }
}

// Pelanggan langganan: saran nama, lalu isi WhatsApp dan lokasi terakhir bila masih kosong.
let customerBook = null;
const customerKey = name => String(name ?? '').trim().toLocaleLowerCase('id').replace(/\s+/g, ' ');
async function loadCustomers() {
  const token = session;
  const recent = await request('/rest/v1/pentol_orders?select=customer,contact,delivery_location&order=created_at.desc&limit=500');
  if (session !== token) return;
  customerBook = new Map();
  for (const entry of recent) {
    const key = customerKey(entry.customer);
    const known = customerBook.get(key);
    if (!known) customerBook.set(key, { ...entry });
    else {
      known.contact ||= entry.contact;
      known.delivery_location ||= entry.delivery_location;
    }
  }
  $('customer-list').replaceChildren(...Array.from(customerBook.values(), entry => {
    const option = document.createElement('option');
    option.value = entry.customer;
    option.label = [entry.contact, entry.delivery_location].filter(Boolean).join(' · ');
    return option;
  }));
}
function fillKnownCustomer() {
  const known = customerBook?.get(customerKey(orderForm.elements.customer.value));
  if (!known) return;
  const e = orderForm.elements;
  if (!e.contact.value && known.contact) e.contact.value = known.contact;
  if (!e.delivery_location.value && known.delivery_location) e.delivery_location.value = known.delivery_location;
}
orderForm.elements.customer.addEventListener('change', fillKnownCustomer);
orderForm.elements.customer.addEventListener('input', () => {
  if (customerBook?.has(customerKey(orderForm.elements.customer.value))) fillKnownCustomer();
});

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
  // Permintaan katalog membawa jadwal di catatan: "Jadwal: YYYY-MM-DD".
  const inboxDay = inboxEntry?.note?.match(/Jadwal: (\d{4}-\d{2}-\d{2})/)?.[1] || '';
  e.delivery_on.value = order?.delivery_on || inboxDay;
  $('existing-booking-option').hidden = Boolean(order || inboxEntry);
  e.contact.value = order?.contact || inboxEntry?.phone || '';
  e.delivery_location.value = order?.delivery_location || inboxEntry?.area || '';
  e.delivery_note.value = order?.delivery_note || (inboxEntry?.note || '').split(' · ')
    .filter(part => part.trim() && !part.startsWith('Jadwal: ')).join(' · ').trim();
  e.shipping_charge.value = order?.shipping_charge || 0;
  e.shipping_cost.value = order?.shipping_cost || 0;
  if (order) order.pentol_order_items.forEach(addOrderItem);
  else if (inboxEntry) {
    for (const item of inboxEntry.items) allocate(item.sku, item.quantity, prices[item.sku]);
  }
  renderQuickPick();
  if (!customerBook) loadCustomers().catch(() => {});
  orderForm.hidden = false;
  $('order-editor-title').textContent = order ? 'Ubah pesanan · ' + order.customer
    : inboxEntry?.customer ? 'Pesanan dari katalog · ' + inboxEntry.customer : 'Catat pesanan';
  const note = $('order-edit-note');
  const shippedLines = (order?.pentol_order_items || []).filter(i => i.shipped);
  const paidSoFar = order ? (order.pentol_payments || []).reduce((sum, p) => sum + Number(p.amount), 0) : 0;
  note.hidden = !(shippedLines.length || paidSoFar || order?.paid || inboxEntry);
  note.textContent = [
    shippedLines.length && 'Sudah diantar: ' + shippedLines.map(i => (products.get(rows.find(r => r.id === i.stock_id)?.sku) || 'varian') + ' ' + i.shipped + ' pack').join(', ') + ' (tidak bisa dikurangi di bawah itu).',
    paidSoFar ? 'Sudah dibayar Rp' + format.format(paidSoFar) + '; sisa tagihan dihitung ulang setelah disimpan.' : order?.paid ? 'Ditandai lunas.' : ''
  ].filter(Boolean).join(' ') || (inboxEntry ? 'Dari katalog: ubah varian, jumlah, jadwal, atau data pembeli sesuai permintaan terbaru, lalu Simpan pesanan.' : '');
  updateOrderEstimate();
  $('new-order').setAttribute('aria-expanded', 'true');
  $('save-order').textContent = order ? 'Simpan perubahan' : 'Simpan pesanan';
  e.customer.focus();
}
$('new-order').addEventListener('click', () => { if (orderForm.hidden) openOrder(); });
$('add-item').addEventListener('click', () => { if (!busy) { addOrderItem(); renderQuickPick(); } });
$('cancel-order').addEventListener('click', () => {
  if (busy) return;
  resetOrderForm();
  $('new-order').focus();
});
orderSearch.addEventListener('input', renderOrderList);
orderStatus.addEventListener('change', () => {
  if (orderChip !== 'all') { setOrderChip('all'); loadOrders(); } else renderOrderList();
});
$('refresh-orders').addEventListener('click', () => run($('refresh-orders'), async () => {
  await loadOrders();
  await ops.inbox();
}));
orderForm.addEventListener('input', event => {
  updateOrderEstimate();
  if (orderItems.contains(event.target)) renderQuickPick();
});
orderForm.addEventListener('change', event => { if (orderItems.contains(event.target)) renderQuickPick(); });
// Isian wajib di "Detail lain" yang tertutup: buka supaya browser bisa menunjukkan kesalahannya.
orderForm.addEventListener('invalid', event => { if ($('order-more').contains(event.target)) $('order-more').open = true; }, true);
orderDate.addEventListener('change', () => { setOrderChip('all'); loadOrders(); });
orderPeriod.addEventListener('change', () => { setOrderChip('all'); loadOrders(); });
$('previous-week').addEventListener('click', () => moveOrderWeek(-7));
$('next-week').addEventListener('click', () => moveOrderWeek(7));

orderForm.addEventListener('submit', event => {
  event.preventDefault();
  run($('save-order'), async () => {
    const customer = orderForm.elements.customer.value.trim();
    if (!customer) return status('Isi nama pelanggan.', true);
    if (!orderItems.childElementCount) return status('Pilih minimal satu varian.', true);
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
      const payload = {
        date, customer, delivery_on:e.delivery_on.value || null,
        shipping_charge:Number(e.shipping_charge.value), shipping_cost:Number(e.shipping_cost.value),
        contact:e.contact.value.trim(), delivery_location:e.delivery_location.value.trim(),
        delivery_note:e.delivery_note.value.trim(), inbox_id:draftInbox?.id,
        use_existing_booking:e.use_existing_booking.checked, items
      };
      // Sebelum bayar/antar: aturan lama. Sesudahnya: fungsi khusus yang menjaga jumlah antar & pembayaran.
      const locked = draftOrder && (draftOrder.paid || draftOrder.pentol_payments?.length
        || draftOrder.pentol_order_items.some(i => i.shipped));
      if (locked) {
        await request('/rest/v1/rpc/pentol_edit_order', { method:'POST', body:{
          target:draftId, expected_revision:draftOrder.revision, payload, change_reason:'Pembeli mengubah pesanan' } });
      } else {
        await ops.mutate(draftOrder ? 'edit' : 'create', draftId, draftOrder?.revision, payload);
      }
    } catch (error) {
      if (error.status === 404 && draftOrder) {
        return status('Mengubah pesanan yang sudah dibayar/diantar aktif setelah ubah-pesanan-2026-11.sql dijalankan di Supabase.', true);
      }
      return status(error.status === 404 ? 'Database pesanan belum diaktifkan.'
        : ops.errorMessage(error), true);
    }
    resetOrderForm();
    orderDate.value = date;
    customerBook = null;
    await refreshAfterOrder('Pesanan tersimpan dan stok batch diperbarui.');
    ops.inbox();
  });
});

const ops = initOperations({
  $, request, status, products, prices, today, format, tableRow, emptyRow, quantities,
  getRows:() => rows, getSession:() => session, getView:() => currentView, openOrder,
  refresh:refreshAfterOrder, selectView, loadRows
});

// ===== Badge angka di navigasi =====
let badgeTimer;
let badgeTotal = 0;
let lastCounts = '';
async function refreshBadges() {
  if (!session) return;
  const token = session;
  let counts;
  try { counts = await ops.badgeCounts(); } catch { return; }
  if (session !== token) return;
  const marks = { orders:[counts.requests, ' permintaan baru'], today:[counts.late, ' antaran terlambat'] };
  for (const [view, [count, text]] of Object.entries(marks)) {
    for (const button of document.querySelectorAll(`.bottom-nav [data-go="${view}"], #admin-menu [data-view="${view}"]`)) {
      button.querySelector('.nav-badge')?.remove();
      button.removeAttribute('aria-description');
      if (!count) continue;
      const badge = document.createElement('span');
      badge.className = 'nav-badge';
      badge.textContent = count > 99 ? '99+' : String(count);
      badge.setAttribute('aria-hidden', 'true');
      button.append(badge);
      button.setAttribute('aria-description', count + text);
    }
  }
  const total = counts.requests + counts.late;
  badgeTotal = total;
  // Ada perubahan (permintaan baru / antaran jadi terlambat) saat Hari Ini terbuka: muat ulang kartunya.
  const signature = JSON.stringify(counts);
  if (lastCounts && signature !== lastCounts && !$('today').hidden && !document.querySelector('#ops-dialog[open]')) ops.open('today');
  lastCounts = signature;
  document.title = document.title.replace(/^\(\d+\+?\) /, '');
  if (total) document.title = '(' + total + ') ' + document.title;
}
function startBadges() {
  clearInterval(badgeTimer);
  refreshBadges();
  badgeTimer = setInterval(refreshBadges, 120_000);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshBadges(); });

// ===== Pasang sebagai aplikasi di HP =====
let installPrompt = null;
addEventListener('beforeinstallprompt', event => {
  event.preventDefault();
  installPrompt = event;
  $('install-app').hidden = false;
});
$('install-app').addEventListener('click', async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice.catch(() => null);
  installPrompt = null;
  $('install-app').hidden = true;
});
addEventListener('appinstalled', () => { $('install-app').hidden = true; });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

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
    // Gangguan koneksi: sesi tetap tersimpan, jangan tampilkan form masuk.
    session = null;
    status('Belum tersambung ke server. Periksa internet lalu coba lagi.', true,
      { label: 'Coba lagi', undo: () => restoreSession() });
  }
}

restoreSession();

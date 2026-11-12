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
    const error = new Error('Permintaan gagal.');
    error.status = response.status;
    throw error;
  }
  return response.status === 204 ? null : response.json();
}

function resetEditor() {
  editing = null;
  form.reset();
  $('cancel').hidden = true;
  $('save').textContent = 'Tambah varian ke batch';
}

function endSession(message) {
  clearTimeout(expiry);
  session = null;
  rows = [];
  $('dashboard').hidden = true;
  $('logout').hidden = true;
  $('stock-rows').replaceChildren();
  $('analytics-rows').replaceChildren();
  $('metrics').replaceChildren();
  filter.replaceChildren(new Option('Semua batch', ''));
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
  $('cancel').hidden = false;
  $('save').textContent = 'Simpan perubahan';
  form.elements.batch_code.focus();
}

function renderRows() {
  const target = $('stock-rows');
  target.replaceChildren(...rows.map(row => {
    const tr = tableRow([row.batch_code, products.get(row.sku), ...quantities(row)]);
    const button = document.createElement('button');
    button.textContent = 'Edit';
    button.type = 'button';
    button.setAttribute('aria-label', 'Edit ' + row.batch_code + ' ' + products.get(row.sku));
    button.addEventListener('click', () => edit(row));
    tr.insertCell().append(button);
    return tr;
  }));
  emptyRow(target, 8, 'Belum ada data batch.');
  const previous = filter.value;
  filter.replaceChildren(new Option('Semua batch', ''), ...Array.from(new Set(rows.map(row => row.batch_code)), code => new Option(code, code)));
  if (Array.from(filter.options).some(option => option.value === previous)) filter.value = previous;
  renderAnalytics();
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
$('cancel').addEventListener('click', resetEditor);
$('logout').addEventListener('click', () => {
  if (!busy) endSession('Anda sudah keluar.');
});
filter.addEventListener('change', renderAnalytics);
document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => {
  document.querySelectorAll('[data-view]').forEach(tab => {
    const selected = tab === button;
    tab.setAttribute('aria-pressed', String(selected));
    $(tab.dataset.view).hidden = !selected;
  });
}));
if (configured) $('signin').hidden = false;
else status('Login admin menunggu konfigurasi database.');

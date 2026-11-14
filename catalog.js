import { supabaseUrl, supabasePublishableKey } from './admin/config.js';
const products = [{"id": "UR", "name": "Pentol Urat", "size": "9 pcs / pack", "price": 36000, "category": "Pentol", "soldOut": false}, {"id": "PK", "name": "Pentol Kecil", "size": "30 pcs / pack", "price": 39000, "category": "Pentol", "soldOut": true}, {"id": "TP", "name": "Tahu Pentol", "size": "30 pcs / pack", "price": 29000, "category": "Tahu", "soldOut": false}, {"id": "JM", "name": "Pentol Jamur", "size": "9 pcs / pack", "price": 36000, "category": "Pentol", "soldOut": false}, {"id": "MZ", "name": "Pentol Mozzarella", "size": "9 pcs / pack", "price": 36000, "category": "Pentol", "soldOut": true}, {"id": "RJ", "name": "Pentol Ranjau", "size": "9 pcs / pack", "price": 36000, "category": "Pentol", "soldOut": false}, {"id": "TD", "name": "Tahu Pedas", "size": "9 pcs / pack", "price": 35000, "category": "Tahu", "soldOut": false}, {"id": "PG", "name": "Pentol Goreng", "size": "9 pcs / pack", "price": 41000, "category": "Pentol", "soldOut": false}, {"id": "SG", "name": "Sambal Gila Tambahan", "size": "±100 g / pack", "price": 15000, "category": "Sambal", "soldOut": false}];
const cartKey = 'pentol-gilaaa-cart';
const quantities = new Map();
try {
  const saved = JSON.parse(localStorage.getItem(cartKey) || '{}');
  for (const product of products) {
    const count = saved?.[product.id];
    if (Number.isSafeInteger(count) && count > 0 && count <= 100) {
      quantities.set(product.id, count);
    }
  }
} catch {
  // The cart remains usable when browser storage is unavailable.
}
const money = amount => 'Rp' + amount.toLocaleString('id-ID');
const cart = document.querySelector('#cart');
const menu = document.querySelector('#products');
const filters = document.querySelectorAll('[data-filter]');
const whatsapp = document.querySelector('#whatsapp');
const copy = document.querySelector('#copy');
const feedback = document.querySelector('#feedback');
const search = document.querySelector('#menu-search');
const availableOnly = document.querySelector('#available-only');
let activeCategory = 'Semua';
const orderForm = document.querySelector('#order-form');
let orderLines = [];
let submitting = false;
let pendingCheckout;
let checkoutReceipt;
try { checkoutReceipt = JSON.parse(sessionStorage.getItem('pentol-checkout-receipt')); } catch {}

function catalogRpc(name, body) {
  return fetch(supabaseUrl.replace(/\/$/,'') + '/rest/v1/rpc/' + name, {
    signal: AbortSignal.timeout(12000),
    method:'POST', headers:{apikey:supabasePublishableKey,'Content-Type':'application/json'},
    body:JSON.stringify(body)
  });
}

const maxQty = item => item.maxQty ?? 100;
let catalogFresh = false;

// Returns the cart items whose price or stock changed, or null when the catalog could not be loaded.
async function syncCatalog() {
  let catalog;
  try {
    let response = await catalogRpc('pentol_catalog_v2', {});
    // Fall back while the v2 migration has not been run yet.
    if (response.status === 404) response = await catalogRpc('pentol_catalog', {});
    if (!response.ok) throw new Error('catalog ' + response.status);
    catalog = await response.json();
  } catch {
    // Keep the published catalog usable, but tell buyers it may be stale.
    catalogFresh = false;
    document.querySelector('#stock-status').hidden = false;
    return null;
  }
  const changed = [];
  for (const item of products) {
    const fresh = catalog.find(row => row.sku === item.id);
    if (!fresh) continue;
    const before = quantities.get(item.id);
    if (before && fresh.price !== item.price) changed.push(item.name + ' kini ' + money(fresh.price));
    item.price = fresh.price;
    item.soldOut = !fresh.available;
    item.maxQty = Number.isSafeInteger(fresh.max_qty) ? fresh.max_qty : null;
    if (!before) continue;
    if (item.soldOut) { quantities.delete(item.id); changed.push(item.name + ' habis'); }
    else if (before > maxQty(item)) { quantities.set(item.id, maxQty(item)); changed.push(item.name + ' tersisa ' + maxQty(item) + ' pack'); }
  }
  catalogFresh = true;
  document.querySelector('#stock-status').hidden = true;
  renderMenu();
  renderCart();
  return changed;
}
document.querySelector('#stock-retry').addEventListener('click', async event => {
  event.currentTarget.disabled = true;
  const changed = await syncCatalog();
  event.currentTarget.disabled = false;
  if (changed?.length) document.querySelector('#cart-announcement').textContent = 'Keranjang disesuaikan: ' + changed.join(', ') + '.';
});

function renderMenu() {
  const query = search.value.trim().toLocaleLowerCase('id');
  const visible = products.filter(item => (activeCategory === 'Semua' || item.category === activeCategory)
    && (!availableOnly.checked || !item.soldOut)
    && item.name.toLocaleLowerCase('id').includes(query))
    .sort((a, b) => Number(a.soldOut) - Number(b.soldOut));
  document.querySelector('#menu-count').textContent = visible.length + ' varian';
  menu.innerHTML = visible.length ? visible.map(item => `
    <article class="card" data-product="${item.id}">
      <div class="card-top"><span class="category">${item.category}</span>${item.soldOut ? '<span class="sold">SOLD OUT</span>' : ''}</div>
      <h3>${item.name}</h3><p class="detail">${item.size}${!item.soldOut && item.maxQty ? `<span class="stock-left">Sisa ${item.maxQty} pack</span>` : ''}</p>
      <div class="bottom"><div><strong class="price">${money(item.price)}</strong><span class="price-unit">per pack</span></div>
      ${item.soldOut ? '<span class="unavailable">Stok habis</span>' : `
        <div class="add-control">
          <button type="button" class="red" data-add="${item.id}" aria-label="Tambah ${item.name}">+ Tambah</button>
          <div class="qty" data-stepper="${item.id}" hidden>
            <button type="button" data-menu-change="-1" data-id="${item.id}" aria-label="Kurangi ${item.name}">−</button>
            <span aria-label="Jumlah pack ${item.name}">0</span>
            <button type="button" data-menu-change="1" data-id="${item.id}" aria-label="Tambah ${item.name}">+</button>
          </div>
        </div>`}
      </div>
    </article>`).join('') : '<div class="no-results">Varian tidak ditemukan.<br><button type="button" class="ghost" data-reset-filter>Tampilkan semua varian</button></div>';
  syncMenuQuantities();
}

function syncMenuQuantities() {
  menu.querySelectorAll('[data-product]').forEach(card => {
    const id = card.dataset.product;
    const count = quantities.get(id) || 0;
    card.classList.toggle('selected', count > 0);
    const add = card.querySelector('[data-add]');
    const stepper = card.querySelector('[data-stepper]');
    if (!add || !stepper) return;
    add.hidden = count > 0;
    stepper.hidden = count === 0;
    stepper.querySelector('span').textContent = count;
    const item = products.find(product => product.id === id);
    stepper.querySelector('[data-menu-change="1"]').disabled = count >= maxQty(item);
  });
}

function renderCart() {
  try {
    localStorage.setItem(cartKey, JSON.stringify(Object.fromEntries(quantities)));
  } catch {
    // The cart can still be used during this visit.
  }
  syncMenuQuantities();
  const selected = products.filter(item => quantities.has(item.id));
  const count = selected.reduce((sum, item) => sum + quantities.get(item.id), 0);
  const total = selected.reduce((sum, item) => sum + item.price * quantities.get(item.id), 0);
  document.querySelector('#count').textContent = count;
  document.querySelector('#dock').hidden = count === 0;
  document.querySelector('#dock-total').textContent = `${count} pack · ${money(total)}`;
  document.querySelector('#subtotal').textContent = money(total);
  document.querySelector('#final-total').textContent = money(total);
  document.querySelector('#final-count').textContent = count + ' pack';
  document.querySelector('#continue-checkout').disabled = count === 0;
  document.querySelector('#cart-items').innerHTML = selected.length ? selected.map(item =>
    `<div class="cart-row"><div><strong>${item.name}</strong><small>${money(item.price)} / pack</small></div><div class="qty"><button type="button" class="ghost" data-change="-1" data-id="${item.id}" aria-label="Kurangi ${item.name}">−</button><span>${quantities.get(item.id)}</span><button type="button" class="ghost" data-change="1" data-id="${item.id}" aria-label="Tambah ${item.name}"${quantities.get(item.id) >= maxQty(item) ? ' disabled' : ''}>+</button></div></div>`
  ).join('') : '<div class="empty-cart"><strong>Belum ada camilan pilihanmu.</strong>Pilih varian untuk mulai memesan.<br><button type="button" class="gold" data-close-cart>Pilih varian</button></div>';
  orderLines = selected.map(item => `• ${item.name} × ${quantities.get(item.id)} pack`);
  whatsapp.disabled = submitting || count === 0;
  copy.disabled = count === 0;
  feedback.textContent = '';
}

filters.forEach(button => button.addEventListener('click', () => {
  filters.forEach(filter => filter.setAttribute('aria-pressed', String(filter === button)));
  activeCategory = button.dataset.filter;
  renderMenu();
}));
search.addEventListener('input', renderMenu);
availableOnly.addEventListener('change', renderMenu);
menu.addEventListener('click', event => {
  if (event.target.closest('[data-reset-filter]')) {
    search.value = '';
    availableOnly.checked = false;
    filters[0].click();
    search.focus();
    return;
  }
  const button = event.target.closest('[data-add], [data-menu-change]');
  if (!button || submitting) return;
  const id = button.dataset.add || button.dataset.id;
  const item = products.find(product => product.id === id);
  if (!item || item.soldOut) return;
  const change = button.hasAttribute('data-add') ? 1 : Number(button.dataset.menuChange);
  clearReceipt();
  const next = Math.max(0, Math.min(maxQty(item), (quantities.get(id) || 0) + change));
  if (next) quantities.set(id, next);
  else quantities.delete(id);
  renderCart();
  document.querySelector('#cart-announcement').textContent = item.name + ': ' + next + ' pack dalam keranjang.';
  const card = button.closest('[data-product]');
  (next ? card.querySelector('[data-menu-change="' + change + '"]') : card.querySelector('[data-add]')).focus();
});

// Layar setelah pesanan dikirim: tetap tampil (juga setelah halaman dimuat ulang) sampai pembeli menekan Selesai
// atau mulai memilih varian lagi.
function showCheckoutReceipt() {
  const panel = document.querySelector('#checkout-receipt');
  const active = Boolean(checkoutReceipt);
  panel.hidden = !active;
  document.querySelector('.checkout-progress').hidden = active;
  if (active) {
    document.querySelector('#summary-panel').hidden = true;
    document.querySelector('#buyer-panel').hidden = true;
  }
  if (!active) return;
  const { queued, id, message, lines = [], total = '', meta = '', phone = '' } = checkoutReceipt;
  const code = String(id).slice(0, 8);
  document.querySelector('#receipt-icon').textContent = queued ? '✓' : '!';
  panel.dataset.queued = String(Boolean(queued));
  document.querySelector('#receipt-title').textContent = queued ? 'Pesananmu sudah masuk' : 'Pesanan belum sampai ke toko';
  document.querySelector('#receipt-status').textContent = queued
    ? 'Pesanan tercatat dengan kode ' + code + '. Toko akan membalas ke ' + (phone || 'nomormu') + ' untuk konfirmasi stok, ongkir, dan pembayaran.'
    : 'Koneksi bermasalah. Kirim rincian pesanan lewat WhatsApp supaya tetap diproses.';
  document.querySelector('#receipt-items').replaceChildren(...lines.map(line => {
    const li = document.createElement('li');
    li.textContent = line;
    return li;
  }));
  document.querySelector('#receipt-total').textContent = total;
  document.querySelector('#receipt-meta').textContent = meta;
  const wa = document.querySelector('#receipt-whatsapp');
  wa.textContent = queued ? 'Kabari toko lewat WhatsApp ↗' : 'Kirim lewat WhatsApp ↗';
  wa.href = 'https://wa.me/628981718578?text=' + encodeURIComponent(message + '\nKode pesanan: ' + code);
  document.querySelector('#receipt-done').textContent = queued ? 'Selesai' : 'Tutup';
  document.querySelector('#receipt-hint').textContent = queued
    ? 'Tekan Kirim di WhatsApp supaya toko langsung tahu dan pesananmu cepat diproses.'
    : 'Isi keranjang masih tersimpan. Kamu juga bisa mencoba kirim lagi.';
}
function clearReceipt() {
  if (!checkoutReceipt) return;
  checkoutReceipt = null;
  try { sessionStorage.removeItem('pentol-checkout-receipt'); } catch {}
  showCheckoutReceipt();
}
document.querySelector('#receipt-done').addEventListener('click', () => {
  const queued = checkoutReceipt?.queued;
  clearReceipt();
  if (queued) cart.close();
  else setCheckoutStep(true);
});

// Data pembeli langganan disimpan hanya di HP pembeli (localStorage), bila dicentang.
const buyerKey = 'pentol-gilaaa-buyer';
function restoreBuyer() {
  let saved;
  try { saved = JSON.parse(localStorage.getItem(buyerKey)); } catch { return; }
  if (!saved || typeof saved !== 'object') return;
  const fields = orderForm.elements;
  for (const name of ['buyer', 'phone', 'location']) {
    if (!fields[name].value && typeof saved[name] === 'string') fields[name].value = saved[name].slice(0, 200);
  }
  if (saved.method === 'Diantar' || saved.method === 'Ambil sendiri') {
    orderForm.querySelector(`[name="method"][value="${saved.method}"]`).checked = true;
    syncDeliveryFields();
  }
}
function rememberBuyer() {
  const fields = orderForm.elements;
  try {
    if (!fields.remember.checked) return localStorage.removeItem(buyerKey);
    localStorage.setItem(buyerKey, JSON.stringify({ buyer: fields.buyer.value.trim(), phone: fields.phone.value.trim(),
      location: fields.location.value.trim(), method: fields.method.value }));
  } catch {
    // Pemesanan tetap berjalan tanpa penyimpanan.
  }
}

function setCheckoutStep(buyerStep, focus = true) {
  if (buyerStep) restoreBuyer();
  document.querySelector('#summary-panel').hidden = buyerStep;
  document.querySelector('#buyer-panel').hidden = !buyerStep;
  document.querySelector('#step-summary').setAttribute('aria-current', buyerStep ? 'false' : 'step');
  document.querySelector('#step-buyer').setAttribute('aria-current', buyerStep ? 'step' : 'false');
  feedback.textContent = '';
  if (focus) {
    (buyerStep ? orderForm.elements.buyer : document.querySelector('#summary-title')).focus();
  }
}

document.querySelectorAll('[data-cart]').forEach(button => button.addEventListener('click', () => {
  if (checkoutReceipt) showCheckoutReceipt();
  else setCheckoutStep(false, false);
  cart.showModal();
}));
document.querySelector('#continue-checkout').addEventListener('click', () => setCheckoutStep(true));
document.querySelector('#back-to-cart').addEventListener('click', () => setCheckoutStep(false));
cart.addEventListener('click', event => {
  if (event.target.closest('[data-close-cart]')) cart.close();
});
cart.addEventListener('click', event => {
  const button = event.target.closest('[data-change]');
  if (!button || submitting) return;
  const { id, change } = button.dataset;
  const next = quantities.get(id) + Number(change);
  const item = products.find(product => product.id === id);
  if (next > 0) quantities.set(id, Math.min(maxQty(item), next));
  else quantities.delete(id);
  renderCart();
  (cart.querySelector(`[data-id="${id}"][data-change="${change}"]`) || cart.querySelector('form button')).focus();
});
// Tanggal WIB, agar "besok" sama dengan kalender toko.
const jakartaToday = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Jakarta' }).format(new Date());
const addDays = (day, n) => new Date(Date.parse(day + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const dayText = day => new Intl.DateTimeFormat('id-ID', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' })
  .format(new Date(day + 'T00:00:00Z'));
function chosenDay() {
  const fields = orderForm.elements;
  if (fields.when.value === 'tomorrow') return addDays(jakartaToday(), 1);
  if (fields.when.value === 'date') return fields.when_date.value;
  return '';
}
function syncWhenFields() {
  const fields = orderForm.elements;
  const picking = fields.when.value === 'date';
  document.querySelector('#when-date-field').hidden = !picking;
  fields.when_date.required = picking;
  fields.when_date.min = jakartaToday();
}
orderForm.querySelectorAll('[name="when"]').forEach(choice => choice.addEventListener('change', syncWhenFields));
syncWhenFields();

function syncDeliveryFields() {
  const needsAddress = orderForm.elements.method.value === 'Diantar';
  document.querySelector('#when-legend').textContent = needsAddress ? 'Mau diantar kapan?' : 'Mau diambil kapan?';
  orderForm.elements.location.required = needsAddress;
  document.querySelector('#location-label').textContent = needsAddress
    ? 'Lokasi kantor / alamat pengantaran' : 'Lokasi kantor / alamat (opsional)';
}

function checkoutMessage() {
  const fields = orderForm.elements;
  const buyer = fields.buyer.value.trim();
  const phone = fields.phone.value.trim();
  const location = fields.location.value.trim();
  const notes = fields.notes.value.trim();
  const digits = phone.replace(/\D/g, '');
  fields.buyer.setCustomValidity(buyer ? '' : 'Isi nama lengkap.');
  fields.phone.setCustomValidity(/^\+?[\d ()-]+$/.test(phone) && digits.length >= 8 && digits.length <= 15
    ? '' : 'Masukkan nomor WhatsApp yang valid, misalnya 081234567890.');
  fields.location.setCustomValidity(fields.location.required && !location ? 'Isi alamat pengantaran.' : '');
  const day = chosenDay();
  fields.when_date.setCustomValidity(fields.when.value === 'date' && (!day || day < jakartaToday()) ? 'Pilih tanggal mulai hari ini.' : '');
  if (!orderLines.length || !orderForm.reportValidity()) return '';
  const details = [
    'Halo, saya mau pesan Pentol Gilaaa Surabaya.',
    '',
    'Nama: ' + buyer,
    'WhatsApp: ' + phone,
    'Metode terima: ' + fields.method.value
  ];
  details.push('Jadwal: ' + (day ? dayText(day) : 'secepatnya'));
  if (location) details.push('Lokasi/alamat: ' + location);
  if (notes) details.push('Catatan: ' + notes);
  return [...details, '', ...orderLines, '', 'Subtotal produk: ' + document.querySelector('#subtotal').textContent,
    'Mohon konfirmasi stok, jadwal, dan total pembayaran.'].join('\n');
}

orderForm.addEventListener('input', event => {
  if (event.target.matches('input')) event.target.setCustomValidity('');
});
orderForm.querySelectorAll('[name="method"]').forEach(choice => choice.addEventListener('change', () => {
  orderForm.elements.location.setCustomValidity('');
  syncDeliveryFields();
}));
syncDeliveryFields();
orderForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (submitting) return;
  if (!checkoutMessage()) return;
  submitting = true;
  whatsapp.disabled = true;
  feedback.textContent = 'Memeriksa stok terbaru…';
  const changed = await syncCatalog();
  submitting = false;
  whatsapp.disabled = quantities.size === 0;
  if (changed?.length) {
    // Prices or stock moved since the buyer filled the cart: let them review before recording.
    setCheckoutStep(false);
    feedback.textContent = 'Pesanan disesuaikan dengan stok terbaru: ' + changed.join(', ') + '. Periksa lagi sebelum melanjutkan.';
    return;
  }
  const message = checkoutMessage();
  if (!message) return;
  rememberBuyer();
  const fields = orderForm.elements;
  const payload = {
    customer_name:fields.buyer.value.trim(), contact:fields.phone.value.trim(),
    area_name:fields.location.value.trim(),
    customer_note:[fields.method.value, chosenDay() && 'Jadwal: ' + chosenDay(), fields.notes.value.trim()].filter(Boolean).join(' · '),
    cart:[...quantities].map(([sku,quantity]) => ({sku,quantity}))
  };
  const signature = JSON.stringify(payload);
  if (pendingCheckout?.signature !== signature) pendingCheckout = {signature,id:crypto.randomUUID()};
  submitting = true;
  whatsapp.disabled = true;
  copy.disabled = true;
  document.querySelector('#back-to-cart').disabled = true;
  whatsapp.textContent = 'Mengirim pesanan…';
  feedback.textContent = 'Mengirim pesanan ke toko…';
  let queued = false;
  let stockError = '';
  try {
    const response = await catalogRpc('pentol_submit_checkout',{...payload,request_id:pendingCheckout.id});
    queued = response.ok;
    if (!queued) {
      const detail = await response.json().catch(() => null);
      if (detail?.hint === 'stock' && typeof detail.message === 'string') stockError = detail.message;
    }
  } catch {
    // WhatsApp remains available if the queue cannot be reached.
  }
  submitting = false;
  whatsapp.disabled = false;
  copy.disabled = false;
  document.querySelector('#back-to-cart').disabled = false;
  whatsapp.textContent = 'Kirim pesanan →';
  if (stockError) {
    // Someone else took the last packs: refresh limits and let the buyer adjust.
    await syncCatalog();
    const left = Number(stockError.match(/tersisa (\d+) pack/)?.[1]);
    const item = products.find(product => stockError.includes(product.name));
    if (item && Number.isSafeInteger(left)) {
      if (left > 0) { item.maxQty = left; quantities.set(item.id, Math.min(quantities.get(item.id) || 0, left)); }
      else { item.soldOut = true; quantities.delete(item.id); }
      renderMenu();
      renderCart();
    }
    setCheckoutStep(false);
    feedback.textContent = stockError + ' Jumlah di keranjang sudah disesuaikan, periksa lagi sebelum melanjutkan.';
    return;
  }
  const day = chosenDay();
  checkoutReceipt = { queued, id: pendingCheckout.id, message, lines: orderLines.map(line => line.replace(/^• /, '')),
    total: document.querySelector('#subtotal').textContent, phone: fields.phone.value.trim(),
    meta: fields.method.value + ' · ' + (day ? dayText(day) : 'secepatnya') + (fields.location.value.trim() ? ' · ' + fields.location.value.trim() : '') };
  feedback.textContent = '';
  try { sessionStorage.setItem('pentol-checkout-receipt', JSON.stringify(checkoutReceipt)); } catch {}
  if (queued) {
    quantities.clear();
    renderCart();
    pendingCheckout = undefined;
  }
  showCheckoutReceipt();
  document.querySelector('#receipt-title').focus();
});
copy.addEventListener('click', async () => {
  const message = checkoutMessage();
  if (!message) return;
  try {
    await navigator.clipboard.writeText(message);
    feedback.textContent = 'Pesanan disalin.';
  } catch {
    feedback.textContent = 'Penyalinan gagal. Kirim pesanan lalu pakai tombol WhatsApp.';
  }
});
renderMenu();
renderCart();
showCheckoutReceipt();
syncCatalog();

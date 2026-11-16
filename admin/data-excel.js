// Template Excel aplikasi: ekspor data saat ini (lembar PO & Pesanan) dan baca kembali untuk impor.
// Modul ini murni (tanpa jaringan): operations.js yang menyimpan lewat fungsi database yang sudah ada.

export const PO_HEAD = ['Batch', 'Supplier', 'Tanggal pesan', 'Varian', 'Jumlah dipesan', 'Harga beli per pack',
  'Diterima', 'Tanggal diterima', 'Ongkir batch', 'Kemasan batch', 'Biaya lain batch'];
const ORDER_START = ['ID sistem', 'Invoice', 'Tanggal pesan', 'Pelanggan', 'WhatsApp', 'Lokasi', 'Catatan', 'Jadwal antar',
  'Ongkir ditagih', 'Ongkir toko'];
const ORDER_END = ['Sudah diantar', 'Tanggal antar', 'Dibayar', 'Tanggal bayar', 'Status (info)', 'Total (info)'];
export const orderHead = products => [...ORDER_START, ...[...products.values()], ...ORDER_END];

const normalize = value => String(value ?? '').trim().toLocaleLowerCase('id').replace(/\s+/g, ' ');
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const jakartaDay = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Jakarta' });

export const HELP = [
  ['Template data Pentol Gilaaa', ''],
  ['', ''],
  ['Lembar', 'Isi'],
  ['PO', 'Satu baris per varian per batch. Ongkir/kemasan/biaya lain batch cukup diisi di baris pertama batch itu.'],
  ['Pesanan', 'Satu baris per pesanan. Isi jumlah pack di kolom nama varian. Harga memakai harga jual saat ini di aplikasi.'],
  ['', ''],
  ['Aturan impor', ''],
  ['1', 'Impor hanya MENAMBAH data baru. Baris yang sudah ada di aplikasi (batch yang sama, atau ID sistem yang sama) dilewati, jadi aman bila file diimpor dua kali.'],
  ['2', 'Jangan ubah atau hapus kolom "ID sistem". Untuk baris baru, kosongkan saja.'],
  ['3', 'Tanggal: tulis 2026-11-09 atau 9/11/2026. Tidak boleh di masa depan.'],
  ['4', 'Sudah diantar: Ya atau Tidak (Ya = semua pack diantar pada Tanggal antar). Dibayar: nominal rupiah.'],
  ['5', 'Stok diambil dari batch tertua yang masih punya stok. Impor PO dulu (lembar PO) agar stok tersedia.'],
  ['6', 'Untuk mengubah pesanan yang sudah ada, pakai Pesanan → ⋯ → Ubah pesanan di aplikasi, bukan lewat impor.'],
  ['7', 'Kolom bertanda (info) hanya keterangan dan diabaikan saat impor.']
];

// ===== Ekspor =====
export function exportSheets({ purchases, stocks, orders, products, total, paid, invoiceNumber }) {
  const stockOf = (batch, sku) => stocks.find(row => row.batch_code === batch && row.sku === sku);
  const po = [PO_HEAD];
  for (const p of purchases) {
    p.pentol_purchase_items.forEach((item, index) => {
      const row = stockOf(p.batch_code, item.sku);
      po.push([p.batch_code, p.supplier || '', p.ordered_on || '', products.get(item.sku) || item.sku, item.quantity, item.unit_cost,
        row?.received || 0, row?.received_on || '', index ? '' : p.shipping || 0, index ? '' : p.packaging || 0, index ? '' : p.other_cost || 0]);
    });
  }
  const skus = [...products.keys()];
  const skuOfStock = id => stocks.find(row => row.id === id)?.sku;
  const rows = [orderHead(products)];
  for (const o of orders) {
    const qty = new Map();
    for (const item of o.pentol_order_items) {
      const sku = skuOfStock(item.stock_id);
      qty.set(sku, (qty.get(sku) || 0) + item.quantity);
    }
    const shipped = o.pentol_order_items.some(item => item.shipped);
    const payments = [...(o.pentol_payments || [])].sort((a, b) => String(a.paid_on).localeCompare(String(b.paid_on)));
    rows.push([o.id, invoiceNumber(o), o.order_date, o.customer, o.contact || '', o.delivery_location || '', o.delivery_note || '',
      o.delivery_on || '', Number(o.shipping_charge) || 0, Number(o.shipping_cost) || 0, ...skus.map(sku => qty.get(sku) || ''),
      o.delivered ? 'Ya' : shipped ? 'Sebagian' : 'Tidak', o.delivered_at ? jakartaDay.format(new Date(o.delivered_at)) : '',
      paid(o) || '', payments.at(-1)?.paid_on || '', o.cancelled ? 'Batal' : '', total(o)]);
  }
  return [['Petunjuk', HELP], ['PO', po], ['Pesanan', rows]];
}

// ===== Baca file =====
export function parseDate(value) {
  if (value === '' || value == null) return '';
  const text = String(value).trim();
  if (/^\d+(\.\d+)?$/.test(text)) {
    const serial = Number(text);
    if (serial < 30000 || serial > 80000) return null;
    return new Date(Math.round((serial - 25569) * 864e5)).toISOString().slice(0, 10);
  }
  let m = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return valid(m[1], m[2], m[3]);
  m = text.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (m) return valid(m[3], m[2], m[1]);
  return null;
  function valid(y, mo, d) {
    const iso = y + '-' + mo.padStart(2, '0') + '-' + d.padStart(2, '0');
    const date = new Date(iso + 'T00:00:00Z');
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === iso ? iso : null;
  }
}
export function parseNumber(value) {
  if (value === '' || value == null) return 0;
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
  const text = String(value).trim();
  if (/^\d+(\.\d+)?$/.test(text)) return Math.round(Number(text));
  const digits = text.replace(/^rp\.?\s*/i, '').replace(/[.\s]/g, '').replace(/,\d{1,2}$/, '');
  return /^\d+$/.test(digits) ? Number(digits) : null;
}
const yes = value => ['ya', 'y', 'yes', 'sudah', 'true', '1', 'lunas'].includes(normalize(value));

function table(rows, head, sheet, errors) {
  const wanted = head.map(normalize);
  const index = rows.findIndex(row => wanted.slice(0, 3).every(label => (row || []).some(cell => normalize(cell) === label)));
  if (index < 0) { errors.push('Lembar ' + sheet + ': judul kolom tidak ditemukan. Pakai template dari tombol Unduh.'); return []; }
  const columns = rows[index].map(normalize);
  return rows.slice(index + 1).map((row, i) => ({ line: index + i + 2, get: label => {
    const at = columns.indexOf(normalize(label));
    return at < 0 ? '' : (row || [])[at] ?? '';
  }, empty: !(row || []).some(cell => String(cell ?? '').trim()) })).filter(row => !row.empty);
}

function skuOf(value, products) {
  const wanted = normalize(value);
  if (!wanted) return null;
  for (const [sku, name] of products) if (normalize(sku) === wanted || normalize(name) === wanted) return sku;
  return null;
}

// sheets: Map(nama lembar -> baris sel). Hasil: rencana impor + galat per baris (baris bergalat tidak diimpor).
export function parseTemplate(sheets, { products, today, existingBatches, existingOrders }) {
  const errors = [];
  const plan = { purchases: [], orders: [], skippedPurchases: 0, skippedOrders: 0, cancelled: 0 };
  const sheet = name => [...sheets].find(([key]) => normalize(key) === normalize(name))?.[1];
  const poRows = sheet('PO');
  const orderRows = sheet('Pesanan');
  if (!poRows && !orderRows) return { plan, errors: ['File tidak berisi lembar PO atau Pesanan. Pakai template dari tombol Unduh.'] };

  if (poRows) {
    const batches = new Map();
    for (const row of table(poRows, PO_HEAD, 'PO', errors)) {
      const where = 'PO baris ' + row.line;
      const batch = String(row.get('Batch')).trim().toUpperCase();
      const sku = skuOf(row.get('Varian'), products);
      const quantity = parseNumber(row.get('Jumlah dipesan'));
      const unitCost = parseNumber(row.get('Harga beli per pack'));
      const received = parseNumber(row.get('Diterima'));
      const orderedOn = parseDate(row.get('Tanggal pesan'));
      const receivedOn = parseDate(row.get('Tanggal diterima'));
      const costs = ['Ongkir batch', 'Kemasan batch', 'Biaya lain batch'].map(label => parseNumber(row.get(label)));
      const problems = [];
      if (!batch || batch.length > 40) problems.push('isi Batch');
      if (!sku) problems.push('varian "' + row.get('Varian') + '" tidak dikenal');
      if (!quantity || quantity < 1) problems.push('Jumlah dipesan minimal 1');
      if (unitCost === null) problems.push('Harga beli tidak valid');
      if (received === null || received > (quantity || 0)) problems.push('Diterima tidak boleh melebihi jumlah dipesan');
      if (orderedOn === null) problems.push('Tanggal pesan tidak valid');
      if (receivedOn === null || (received > 0 && !receivedOn)) problems.push('isi Tanggal diterima yang valid');
      if (receivedOn && receivedOn > today) problems.push('Tanggal diterima di masa depan');
      if (costs.includes(null)) problems.push('biaya batch tidak valid');
      if (problems.length) { errors.push(where + ': ' + problems.join(', ') + '.'); continue; }
      if (!batches.has(batch)) batches.set(batch, { batch, supplier: String(row.get('Supplier')).trim() || 'Supplier', orderedOn: orderedOn || today,
        shipping: costs[0], packaging: costs[1], other: costs[2], items: new Map(), receipts: new Map(), lines: [] });
      const entry = batches.get(batch);
      entry.lines.push(row.line);
      if (entry.items.has(sku)) { errors.push(where + ': varian ' + products.get(sku) + ' ganda di batch ' + batch + '.'); continue; }
      entry.items.set(sku, { sku, quantity, unit_cost: unitCost });
      if (received > 0) {
        const list = entry.receipts.get(receivedOn) || [];
        list.push({ sku, quantity: received });
        entry.receipts.set(receivedOn, list);
      }
    }
    for (const entry of batches.values()) {
      if (existingBatches.has(entry.batch)) { plan.skippedPurchases++; continue; }
      if (entry.items.size > 9) { errors.push('PO ' + entry.batch + ': maksimal 9 varian per batch.'); continue; }
      plan.purchases.push({ ...entry, items: [...entry.items.values()], receipts: [...entry.receipts] });
    }
  }

  if (orderRows) {
    const occurrences = new Map();
    for (const row of table(orderRows, orderHead(products), 'Pesanan', errors)) {
      const where = 'Pesanan baris ' + row.line;
      const id = String(row.get('ID sistem')).trim();
      if (normalize(row.get('Status (info)')) === 'batal') { plan.cancelled++; continue; }
      if (id && existingOrders.has(id.toLowerCase())) { plan.skippedOrders++; continue; }
      const customer = String(row.get('Pelanggan')).trim().slice(0, 120);
      const date = parseDate(row.get('Tanggal pesan'));
      const deliveryOn = parseDate(row.get('Jadwal antar'));
      const shippingCharge = parseNumber(row.get('Ongkir ditagih'));
      const shippingCost = parseNumber(row.get('Ongkir toko'));
      const items = [];
      const problems = [];
      for (const [sku, name] of products) {
        const quantity = parseNumber(row.get(name));
        if (quantity === null || quantity > 1000) problems.push('jumlah ' + name + ' tidak valid');
        else if (quantity > 0) items.push({ sku, quantity });
      }
      const deliveredText = normalize(row.get('Sudah diantar'));
      const delivered = yes(deliveredText);
      const shipDate = parseDate(row.get('Tanggal antar'));
      const paidAmount = parseNumber(row.get('Dibayar'));
      const payDate = parseDate(row.get('Tanggal bayar'));
      if (!customer) problems.push('isi Pelanggan');
      if (!date) problems.push('isi Tanggal pesan yang valid');
      else if (date > today) problems.push('Tanggal pesan di masa depan');
      if (!items.length) problems.push('isi jumlah pack minimal satu varian');
      if (deliveryOn === null) problems.push('Jadwal antar tidak valid');
      if (shippingCharge === null || shippingCost === null) problems.push('ongkir tidak valid');
      if (deliveredText === 'sebagian') problems.push('Sudah diantar "Sebagian" tidak bisa diimpor; tulis Ya atau Tidak lalu lanjutkan di aplikasi');
      if (shipDate === null || (shipDate && (shipDate > today || (date && shipDate < date)))) problems.push('Tanggal antar tidak valid');
      if (paidAmount === null) problems.push('Dibayar tidak valid');
      if (payDate === null || (payDate && payDate > today)) problems.push('Tanggal bayar tidak valid');
      if (id && !uuidPattern.test(id)) problems.push('ID sistem rusak (kosongkan untuk baris baru)');
      if (problems.length) { errors.push(where + ': ' + problems.join(', ') + '.'); continue; }
      // Kunci baris baru: isi baris + urutan kemunculan, agar impor ulang file yang sama tidak menggandakan pesanan.
      const key = [date, normalize(customer), String(row.get('WhatsApp')).replace(/\D/g, ''), JSON.stringify(items)].join('|');
      const seen = (occurrences.get(key) || 0) + 1;
      occurrences.set(key, seen);
      plan.orders.push({ line: row.line, id: id ? id.toLowerCase() : '', key: key + '|' + seen, date, customer,
        contact: String(row.get('WhatsApp')).trim().slice(0, 24), location: String(row.get('Lokasi')).trim().slice(0, 200),
        note: String(row.get('Catatan')).trim().slice(0, 500), deliveryOn: deliveryOn || null, shippingCharge, shippingCost, items,
        delivered, shipDate: delivered ? (shipDate || date) : '', paid: paidAmount, payDate: payDate || date });
    }
    if (plan.orders.length > 500) { errors.push('Maksimal 500 pesanan per impor.'); plan.orders.length = 500; }
  }
  return { plan, errors };
}

// UUID tetap dari teks (SHA-256): impor ulang baris yang sama menghasilkan ID yang sama, jadi tidak dobel.
export async function stableUuid(text) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))).slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
  return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
}

// Bagi jumlah per varian ke batch: batch tertua dulu. free: Map(stockId -> pack bebas), diperbarui di tempat.
export function allocateStock(items, stocks, free, prices) {
  const lines = [];
  const before = new Map(free);
  for (const { sku, quantity } of items) {
    let left = quantity;
    const batches = stocks.filter(row => row.sku === sku)
      .sort((a, b) => String(a.received_on || '9999').localeCompare(String(b.received_on || '9999')) || a.batch_code.localeCompare(b.batch_code));
    for (const row of batches) {
      const take = Math.min(left, free.get(row.id) || 0);
      if (!take) continue;
      lines.push({ stock_id: row.id, quantity: take, unit_price: prices[sku] });
      free.set(row.id, free.get(row.id) - take);
      left -= take;
      if (!left) break;
    }
    if (left) {
      for (const [id, value] of before) free.set(id, value);
      return { error: { sku, missing: left } };
    }
  }
  return { lines };
}

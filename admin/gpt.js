// Membaca "umpan dari GPT": teks JSON berisi pesanan, pembayaran, dan pengantaran.
// Tidak ada yang disimpan dari sini: hasilnya hanya mengisi form yang tetap dikonfirmasi admin.

const normalize = value => String(value ?? '').trim().toLocaleLowerCase('id').replace(/\s+/g, ' ');

const kinds = new Map([
  ['pesanan', 'order'], ['order', 'order'], ['pesan', 'order'],
  ['bayar', 'pay'], ['pembayaran', 'pay'], ['pay', 'pay'], ['transfer', 'pay'],
  ['antar', 'ship'], ['pengantaran', 'ship'], ['kirim', 'ship'], ['ship', 'ship'], ['diantar', 'ship']
]);

// "100rb", "100.000", "Rp 1,5jt", 100000 -> angka rupiah atau pack.
export function parseAmount(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
  let text = normalize(value).replace(/^rp\.?\s*/, '').replace(/\s/g, '');
  if (!text) return null;
  const unit = text.match(/(rb|ribu|k|jt|juta)$/);
  if (unit) {
    text = text.slice(0, -unit[0].length).replace(',', '.');
    const number = Number(text);
    if (!Number.isFinite(number)) return null;
    return Math.round(number * (/^(jt|juta)$/.test(unit[0]) ? 1_000_000 : 1_000));
  }
  text = text.replace(/[.,](?=\d{3}(\D|$))/g, '');
  return /^\d+$/.test(text) ? Number(text) : null;
}

export function resolveSku(value, products) {
  const raw = String(value ?? '').trim();
  if (products.has(raw.toUpperCase())) return raw.toUpperCase();
  const wanted = normalize(raw);
  if (!wanted) return null;
  const names = [...products].map(([sku, name]) => [sku, normalize(name)]);
  const exact = names.filter(([, name]) => name === wanted || name.replace(/^pentol /, '') === wanted);
  if (exact.length === 1) return exact[0][0];
  const partial = names.filter(([, name]) => name.includes(wanted));
  return partial.length === 1 ? partial[0][0] : null;
}

const isDate = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? '')) && Number.isFinite(Date.parse(value));

function items(list, products, errors, where, required) {
  if (list == null || (Array.isArray(list) && !list.length)) {
    if (required) errors.push(where + ': isi varian dan jumlah.');
    return [];
  }
  if (!Array.isArray(list)) { errors.push(where + ': "item" harus berupa daftar.'); return []; }
  const merged = new Map();
  for (const entry of list) {
    const sku = resolveSku(entry?.varian ?? entry?.sku ?? entry?.produk, products);
    const quantity = parseAmount(entry?.jumlah ?? entry?.qty ?? entry?.pack);
    if (!sku) { errors.push(where + ': varian "' + (entry?.varian ?? entry?.sku ?? '') + '" tidak dikenal.'); continue; }
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 1000) {
      errors.push(where + ': jumlah ' + products.get(sku) + ' tidak valid.'); continue;
    }
    merged.set(sku, (merged.get(sku) || 0) + quantity);
  }
  return [...merged].map(([sku, quantity]) => ({ sku, quantity }));
}

function jsonPart(text) {
  const source = String(text ?? '').replace(/```(?:json)?/gi, '');
  const starts = [source.indexOf('{'), source.indexOf('[')].filter(index => index >= 0);
  if (!starts.length) return null;
  const start = Math.min(...starts);
  const end = Math.max(source.lastIndexOf('}'), source.lastIndexOf(']'));
  if (end <= start) return null;
  try { return JSON.parse(source.slice(start, end + 1)); } catch { return null; }
}

export function parseGptText(text, products, today) {
  const data = jsonPart(text);
  if (!data) return { actions: [], errors: ['Teks tidak berisi format dari GPT. Salin seluruh blok yang dibuat GPT.'] };
  const list = Array.isArray(data) ? data : Array.isArray(data.aksi) ? data.aksi : [data];
  const actions = [];
  const errors = [];
  list.slice(0, 30).forEach((entry, index) => {
    const where = 'Aksi ' + (index + 1);
    const type = kinds.get(normalize(entry?.jenis ?? entry?.aksi ?? entry?.type));
    const customer = String(entry?.pelanggan ?? entry?.nama ?? '').trim().slice(0, 120);
    const invoice = String(entry?.invoice ?? '').trim().slice(0, 40);
    if (!type) { errors.push(where + ': jenis harus pesanan, bayar, atau antar.'); return; }
    if (!customer && !(type !== 'order' && invoice)) { errors.push(where + ': isi nama pelanggan.'); return; }
    const date = isDate(entry?.tanggal) ? entry.tanggal : today;
    const before = errors.length;
    if (type === 'order') {
      const lines = items(entry.item ?? entry.items, products, errors, where, true);
      const shipping = entry?.ongkir == null || entry.ongkir === '' ? 0 : parseAmount(entry.ongkir);
      if (shipping === null) errors.push(where + ': ongkir tidak valid.');
      if (errors.length > before) return;
      actions.push({ type, customer, date, items: lines, shipping,
        contact: String(entry?.kontak ?? entry?.wa ?? '').trim().slice(0, 24),
        location: String(entry?.lokasi ?? entry?.alamat ?? '').trim().slice(0, 200),
        note: String(entry?.catatan ?? '').trim().slice(0, 500),
        deliveryOn: isDate(entry?.jadwal_antar) ? entry.jadwal_antar : '' });
    } else if (type === 'pay') {
      // "lunas" = seluruh sisa tagihan pesanan itu (amount null; form bayar terisi sisa tagihan).
      const full = normalize(entry?.nominal) === 'lunas';
      const amount = full ? null : parseAmount(entry?.nominal ?? entry?.jumlah);
      if (!full && (!Number.isSafeInteger(amount) || amount < 1)) { errors.push(where + ': nominal bayar tidak valid.'); return; }
      actions.push({ type, customer, invoice, date, amount, full });
    } else {
      const lines = items(entry.item ?? entry.items, products, errors, where, false);
      if (errors.length > before) return;
      actions.push({ type, customer, invoice, date, items: lines });
    }
  });
  if (!actions.length && !errors.length) errors.push('Tidak ada aksi yang terbaca.');
  return { actions, errors };
}

export function gptInstructions(products, today) {
  const variants = [...products].map(([sku, name]) => sku + ' = ' + name).join(', ');
  return [
    'Kamu membantu mencatat transaksi toko Pentol Gilaaa. Ubah setiap pesan saya menjadi SATU blok JSON, tanpa penjelasan lain.',
    'Hari ini ' + today + '. Tulis tanggal sebagai YYYY-MM-DD (ubah "besok", "Senin", dan sejenisnya menjadi tanggal).',
    'Kode varian: ' + variants + '.',
    'Format:',
    '{"aksi":[',
    ' {"jenis":"pesanan","pelanggan":"Nama","kontak":"08…","lokasi":"Gedung/alamat","jadwal_antar":"YYYY-MM-DD","ongkir":0,"catatan":"","item":[{"varian":"UR","jumlah":3}]},',
    ' {"jenis":"bayar","pelanggan":"Nama","invoice":"","nominal":100000,"tanggal":"YYYY-MM-DD"},',
    ' {"jenis":"antar","pelanggan":"Nama","invoice":"","tanggal":"YYYY-MM-DD","item":[{"varian":"UR","jumlah":3}]}',
    ']}',
    'Aturan: jumlah dalam pack; nominal dalam rupiah tanpa titik (atau "lunas" untuk melunasi seluruh sisa tagihan); kosongkan kolom yang tidak disebut; untuk "antar" tanpa rincian, item boleh kosong (berarti semua sisa pesanan). Jangan mengarang harga, jumlah, atau nama yang tidak saya sebut. Jika ragu, tulis di "catatan".'
  ].join('\n');
}

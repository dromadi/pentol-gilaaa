const normalize = value => String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
const whole = value => value !== '' && value != null && /^\d+$/.test(String(value)) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
const batchCode = value => /^batch[ -]?0*(\d+)$/i.test(String(value).trim())
  ? Number(String(value).match(/\d+/)[0]) : null;
const isDelivered = value => ['sudah diantar', 'sudah diserahkan'].includes(normalize(value));
const elements = (node, name) => Array.from(node.getElementsByTagNameNS('*', name));
const signature = items => items.map(({ batch, sku, quantity }) => batch + '/' + sku + '/' + quantity).sort().join('|');

async function workbookSheets(file) {
  if (!/\.xlsx$/i.test(file.name) || file.size > 2_000_000) throw new Error('Pilih file .xlsx dengan ukuran maksimal 2 MB.');
  if (!window.JSZip) throw new Error('Pembaca Excel belum termuat. Muat ulang halaman.');
  const zip = await window.JSZip.loadAsync(await file.arrayBuffer());
  async function xml(path) {
    const part = zip.file(path);
    if (!part) throw new Error('Bagian Excel tidak ditemukan.');
    const source = await new Promise((resolve, reject) => {
      const stream = part.internalStream('string');
      let content = '';
      stream.on('data', chunk => {
        content += chunk;
        if (content.length > 4_000_000) {
          stream.pause();
          reject(new Error('Isi Excel melebihi batas.'));
        }
      }).on('error', reject).on('end', () => resolve(content)).resume();
    });
    if (/<!DOCTYPE/i.test(source)) throw new Error('Isi Excel melebihi batas atau tidak didukung.');
    const doc = new DOMParser().parseFromString(source, 'application/xml');
    if (doc.querySelector('parsererror')) throw new Error('Isi Excel tidak bisa dibaca.');
    return doc;
  }
  const workbook = await xml('xl/workbook.xml');
  const relations = await xml('xl/_rels/workbook.xml.rels');
  const paths = new Map(Array.from(elements(relations, 'Relationship'), rel => [rel.getAttribute('Id'), rel.getAttribute('Target')]));
  const text = node => Array.from(elements(node, 't'), t => t.textContent).join('');
  const shared = zip.file('xl/sharedStrings.xml') ? Array.from(elements(await xml('xl/sharedStrings.xml'), 'si'), text) : [];
  const sheets = new Map();
  for (const sheet of elements(workbook, 'sheet')) {
    const name = sheet.getAttribute('name');
    if (!/^(Tutup Hari |Booking dan Invoice B2$|Packing$|Pesanan$)/i.test(name)) continue;
    const target = paths.get(sheet.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id'));
    if (!target) continue;
    const doc = await xml(target.startsWith('/') ? target.slice(1) : 'xl/' + target);
    sheets.set(name, Array.from(elements(doc, 'row'), row => {
      const record = [];
      for (const cell of elements(row, 'c')) {
        const ref = cell.getAttribute('r')?.match(/^[A-Z]+/);
        if (!ref) continue;
        const column = [...ref[0]].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
        if (column > 100) continue;
        const value = elements(cell, 'v')[0]?.textContent ?? '';
        const type = cell.getAttribute('t');
        record[column - 1] = type === 'inlineStr' ? text(cell) : type === 's' ? shared[Number(value)] : type === 'e' ? '' : value;
      }
      return record;
    }));
  }
  return sheets;
}

function records(rows, headers) {
  const wanted = headers.map(normalize);
  const index = rows.findIndex(row => wanted.every(label => row.some(cell => normalize(cell) === label)));
  if (index < 0) throw new Error('Kolom Excel belum sesuai format pembukuan Pentol Gilaaa.');
  const columns = rows[index].map(normalize);
  return rows.slice(index + 1).map(row => Object.fromEntries(columns.flatMap((key, i) => key ? [[key, row[i] ?? '']] : [])));
}

export function readTargets(sheets, products) {
  const skuByName = new Map([...products].map(([sku, name]) => [normalize(name), sku]));
  const stockTabs = [...sheets.keys()].filter(name => /^Tutup Hari /i.test(name));
  if (stockTabs.length > 1) throw new Error('Excel memuat lebih dari satu tab Tutup Hari. Pilih file dengan satu tab Tutup Hari.');
  const stocks = stockTabs.flatMap(name => records(sheets.get(name), ['Varian', 'Siap jual Batch 1', 'Batch 2 menurut aplikasi', 'Booking Batch 2', 'Sisa Batch 2 (proyeksi)']).flatMap(row => {
    const sku = skuByName.get(normalize(row.varian));
    if (!sku) return [];
    const batch1 = whole(row['siap jual batch 1']);
    const batch2 = whole(row['sisa batch 2 (proyeksi)']);
    const received = whole(row['batch 2 menurut aplikasi']);
    const booked = whole(row['booking batch 2']);
    return [
      ...(batch1 === null ? [] : [{ batch:1, sku, free:batch1, received:whole(row['awal batch 1']) }]),
      ...(received > 0 && batch2 !== null ? [{ batch:2, sku, free:batch2, received, projected:true, booked }] : [])
    ];
  }));
  const orders = [];
  if (sheets.has('Pesanan') && sheets.has('Packing')) {
    const lines = records(sheets.get('Pesanan'), ['ID', 'Pelanggan', 'Produk', 'Qty pack', 'Status pesanan']);
    const groups = Map.groupBy(lines.filter(row => row.id && normalize(row['status pesanan']) === 'aktif'), row => row.id);
    const packing = records(sheets.get('Packing'), ['Pelanggan', 'Tagihan', 'Pembayaran diterima', 'Status packing']);
    for (const [reference, group] of groups) {
      const customer = group[0].pelanggan;
      const matches = packing.filter(row => normalize(row.pelanggan) === normalize(customer));
      if (!customer || matches.length !== 1 || group.some(row => normalize(row.pelanggan) !== normalize(customer))) continue;
      const row = matches[0];
      orders.push({ reference, customer, amount:whole(row.tagihan), paid:whole(row['pembayaran diterima']),
        delivered:isDelivered(row['status packing']), items:group.map(line => ({
          batch:1, sku:skuByName.get(normalize(line.produk)), quantity:whole(line['qty pack'])
        })) });
    }
  }
  if (sheets.has('Booking dan Invoice B2')) {
    const rows = records(sheets.get('Booking dan Invoice B2'), ['Nomor invoice', 'Pelanggan', 'Tagihan (Rp)', 'Kas diterima (Rp)', 'Status antar']);
    for (const row of rows) {
      const amount = whole(row['tagihan (rp)']);
      if (!row.pelanggan || amount === null || /^(total|harga aktif per pack)$/i.test(row.pelanggan.trim())) continue;
      const items = Object.entries(row).flatMap(([key, value]) => {
        const match = key.match(/^(.+) b([12])$/);
        const quantity = whole(value);
        return match && quantity > 0 ? [{ batch:Number(match[2]), sku:skuByName.get(match[1]), quantity }] : [];
      });
      orders.push({ reference:row['nomor invoice'], customer:row.pelanggan, amount,
        paid:whole(row['kas diterima (rp)']), delivered:isDelivered(row['status antar']), items });
    }
  }
  if (!stocks.length && !orders.length) throw new Error('Tidak ada baris stok atau pesanan yang dikenali.');
  return { stocks, orders };
}

export function reconciliationRows(targets, stocks, orders, products, total, paid) {
  const byStock = new Map(stocks.map(row => [row.id, row]));
  const byOrder = Map.groupBy(orders, order => normalize(order.customer));
  const stockRows = targets.stocks.map(target => {
    const matches = stocks.filter(row => batchCode(row.batch_code) === target.batch && row.sku === target.sku);
    const live = matches.length === 1 ? matches[0] : null;
    const free = live ? Math.max(0, live.received - live.reserved - live.delivered) : null;
    let action;
    let status = 'Perlu diperiksa';
    const duplicates = targets.stocks.filter(row => row.batch === target.batch && row.sku === target.sku).length > 1;
    if (duplicates) status = 'Baris Excel ganda';
    else if (free === target.free) status = 'Cocok';
    else if (live && free > target.free && live.received === target.received
      && (!target.projected || (target.free === 0 && target.booked === target.received))) {
      const reserved = live.received - live.delivered - target.free;
      action = { type:'stock', live, reserved };
      status = 'Kurangi sisa jual melalui booking';
    } else if (target.projected) status = 'Proyeksi · cek penerimaan dan alokasi';
    return { label:products.get(target.sku) + ' · Batch ' + target.batch, excel:target.free + ' pack',
      app:free === null ? 'Batch/varian belum cocok' : free + ' pack', status, action };
  });
  const invoiceCandidates = [];
  const orderRows = targets.orders.map(target => {
    const ref = normalize(target.reference);
    const candidates = byOrder.get(normalize(target.customer)) || [];
    const invoice = /^\d+$/.test(ref) ? Number(ref) : null;
    const exact = ref ? orders.filter(order => normalize(order.reference_code) === ref
      || (invoice !== null && Number(order.invoice_no) === invoice)) : [];
    const pool = exact.length ? exact : candidates;
    const matches = pool.filter(order => total(order) === target.amount && target.items.length
      && target.items.every(item => item.sku && item.quantity > 0)
      && signature(order.pentol_order_items.map(item => {
        const stock = byStock.get(item.stock_id);
        return { batch:stock && batchCode(stock.batch_code), sku:stock?.sku, quantity:item.quantity };
      })) === signature(target.items));
    const live = matches.length === 1 ? matches[0] : null;
    let status = 'Pesanan belum cocok';
    let action;
    const duplicate = targets.orders.filter(row => normalize(row.customer) === normalize(target.customer)
      && row.amount === target.amount && signature(row.items) === signature(target.items)).length > 1;
    const received = live ? paid(live) : null;
    const label = target.customer + (target.reference ? ' · ' + target.reference : '');
    const rupiah = value => 'Rp' + new Intl.NumberFormat('id-ID').format(value);
    const excel = (target.delivered ? 'Diantar' : 'Antar belum dikonfirmasi') + ' · '
      + (target.paid === null || target.amount === null ? 'Bayar belum dikonfirmasi' : 'Sisa ' + rupiah(target.amount - target.paid));
    const app = live ? (live.delivered ? 'Diantar' : 'Belum selesai diantar') + ' · Sisa ' + rupiah(target.amount - received) : '—';
    if (duplicate || exact.length > 1 || (pool.length > 1 && !live)) status = 'Pencocokan ambigu';
    else if (live) {
      if (ref) invoiceCandidates.push({id:live.id, revision:live.revision, reference:target.reference});
      const ship = target.delivered && !live.delivered;
      const amount = target.paid === null ? 0 : target.paid - received;
      if (target.paid !== null && (amount < 0 || target.paid > target.amount)) status = 'Kas berbeda · periksa riwayat';
      else if (ship || amount > 0) {
        action = { type:ship ? 'ship' : 'pay', live, amount };
        status = ship ? 'Catat pengantaran' : 'Catat pembayaran ' + rupiah(amount);
      } else status = target.delivered && target.paid !== null ? 'Cocok' : 'Data terkonfirmasi cocok';
      if (action && !exact.length) status += ' · cocok dari nama dan rincian';
    }
    return { label, excel, app, status, action };
  });
  const byId = Map.groupBy(invoiceCandidates, match => match.id);
  const byReference = Map.groupBy(invoiceCandidates, match => normalize(match.reference));
  const invoiceMatches = new Map(invoiceCandidates.filter(match => byId.get(match.id).length === 1
    && byReference.get(normalize(match.reference)).length === 1).map(match => [match.id, match]));
  return { stockRows, orderRows, invoiceMatches };
}

export async function openReconciliation({ file, products }) {
  return readTargets(await workbookSheets(file), products);
}

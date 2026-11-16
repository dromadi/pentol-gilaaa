// Uji fungsi murni (tanpa browser).
import { test, equal } from './harness.js';
import { parseAmount, resolveSku, parseGptText } from '../admin/gpt.js';
import { groupBy } from '../admin/reconcile.js';
import { parseDate, parseNumber, parseTemplate, allocateStock, stableUuid, orderHead, PO_HEAD } from '../admin/data-excel.js';

const products = new Map([['UR','Pentol Urat'],['PK','Pentol Kecil'],['TP','Tahu Pentol'],['JM','Pentol Jamur'],
  ['MZ','Pentol Mozzarella'],['RJ','Pentol Ranjau'],['TD','Tahu Pedas'],['PG','Pentol Goreng'],['SG','Sambal Gila Tambahan']]);

export function unitTests() {
  test('template Excel: tanggal & angka dari berbagai bentuk', () => {
    equal([parseDate('2026-11-09'), parseDate('9/11/2026'), parseDate(46335), parseDate(''), parseDate('31/02/2026')],
      ['2026-11-09', '2026-11-09', '2026-11-09', '', null], 'tanggal');
    equal([parseNumber('Rp 36.000'), parseNumber(36000), parseNumber('36000'), parseNumber(''), parseNumber('abc')], [36000, 36000, 36000, 0, null], 'angka');
  });

  test('template Excel: baca PO & Pesanan, lewati yang sudah ada, galat per baris', async () => {
    const head = orderHead(products);
    const row = values => head.map(label => values[label] ?? '');
    const sheets = new Map([
      ['PO', [PO_HEAD,
        ['B1', 'Pusat', '2026-11-01', 'Pentol Urat', 20, 23200, 20, '2026-11-02', 10000, 0, 0],
        ['B1', '', '', 'Tahu Pentol', 10, 18000, 6, '2026-11-02', '', '', ''],
        ['B0', 'Pusat', '2026-10-01', 'UR', 5, 20000, 5, '2026-10-02', 0, 0, 0],
        ['B2', 'Pusat', '2026-11-01', 'Pentol Aneh', 5, 1, 0, '', 0, 0, 0]]],
      ['Pesanan', [head,
        row({ 'Tanggal pesan': '2026-11-09', 'Pelanggan': 'Dias', 'Pentol Urat': 2, 'Tahu Pentol': 1, 'Sudah diantar': 'Ya', 'Tanggal antar': '2026-11-10', 'Dibayar': 'Rp 101.000' }),
        row({ 'ID sistem': '11111111-1111-4111-8111-111111111111', 'Tanggal pesan': '2026-11-09', 'Pelanggan': 'Lama', 'Pentol Urat': 1 }),
        row({ 'Tanggal pesan': '2026-11-09', 'Pelanggan': 'Batal', 'Pentol Urat': 1, 'Status (info)': 'Batal' }),
        row({ 'Tanggal pesan': '2026-12-30', 'Pelanggan': 'Masa depan', 'Pentol Urat': 1 }),
        row({ 'Tanggal pesan': '2026-11-09', 'Pelanggan': 'Dias', 'Pentol Urat': 2, 'Tahu Pentol': 1 })]]]);
    const { plan, errors } = parseTemplate(sheets, { products, today: '2026-11-16',
      existingBatches: new Set(['B0']), existingOrders: new Set(['11111111-1111-4111-8111-111111111111']) });
    equal(plan.purchases.map(p => [p.batch, p.items.length, p.shipping, p.receipts.length]), [['B1', 2, 10000, 1]], 'PO baru B1 dengan 2 varian');
    equal([plan.skippedPurchases, plan.skippedOrders, plan.cancelled], [1, 1, 1], 'yang sudah ada & batal dilewati');
    equal(plan.orders.map(o => [o.customer, o.delivered, o.shipDate, o.paid]), [['Dias', true, '2026-11-10', 101000], ['Dias', false, '', 0]], 'pesanan baru');
    equal(errors.length, 2, 'varian tak dikenal & tanggal masa depan: ' + errors.join(' / '));
    const [a, b] = plan.orders;
    const ids = [await stableUuid('import-order|' + a.key), await stableUuid('import-order|' + a.key), await stableUuid('import-order|' + b.key)];
    equal([ids[0] === ids[1], ids[0] === ids[2], /^[0-9a-f-]{36}$/.test(ids[0])], [true, false, true], 'ID tetap, baris kembar dibedakan');
  });

  test('template Excel: stok dibagi dari batch tertua, gagal = tidak mengurangi', () => {
    const stocks = [{ id: 'n', sku: 'UR', batch_code: 'B2', received_on: '2026-11-10' }, { id: 'o', sku: 'UR', batch_code: 'B1', received_on: '2026-11-01' }];
    const free = new Map([['n', 5], ['o', 2]]);
    equal(allocateStock([{ sku: 'UR', quantity: 3 }], stocks, free, { UR: 36000 }).lines,
      [{ stock_id: 'o', quantity: 2, unit_price: 36000 }, { stock_id: 'n', quantity: 1, unit_price: 36000 }], 'tertua dulu');
    equal(allocateStock([{ sku: 'UR', quantity: 9 }], stocks, free, { UR: 36000 }).error, { sku: 'UR', missing: 5 }, 'kurang');
    equal([free.get('o'), free.get('n')], [0, 4], 'gagal tidak mengubah sisa');
  });

  test('bayar "lunas" = seluruh sisa tagihan', () => {
    const result = parseGptText('{"aksi":[{"jenis":"bayar","pelanggan":"Sari","nominal":"Lunas"}]}', products, '2026-11-14');
    equal([result.errors.length, result.actions[0].full, result.actions[0].amount], [0, true, null], 'lunas diterima tanpa nominal');
  });

  test('nominal: rb, jt, titik ribuan', () => {
    equal(['100rb', 'Rp 1,5jt', '100.000', '1.250.000', 250000, '100k', 'abc'].map(parseAmount),
      [100000, 1500000, 100000, 1250000, 250000, 100000, null], 'parseAmount');
  });
  test('varian: kode, nama, dan nama ambigu ditolak', () => {
    equal(['ur', 'urat', 'jamur', 'tahu', 'tahu pedas', 'sambal'].map(v => resolveSku(v, products)),
      ['UR', 'UR', 'JM', null, 'TD', 'SG'], 'resolveSku');
  });
  test('teks GPT: JSON dalam teks bebas, jumlah varian sama digabung', () => {
    const text = 'Berikut:\n```json\n{"aksi":[{"jenis":"pesanan","pelanggan":"Sari","item":[{"varian":"urat","jumlah":3},{"varian":"UR","jumlah":1}]},'
      + '{"jenis":"bayar","pelanggan":"Sari","nominal":"100rb"},{"jenis":"refund","pelanggan":"X"}]}\n```';
    const result = parseGptText(text, products, '2026-11-14');
    equal(result.actions.map(a => a.type), ['order', 'pay'], 'jenis aksi');
    equal(result.actions[0].items, [{ sku: 'UR', quantity: 4 }], 'item digabung');
    equal(result.actions[1].amount, 100000, 'nominal');
    equal(result.errors.length, 1, 'jenis tak dikenal ditolak');
  });
  test('groupBy pengganti Map.groupBy', () => {
    equal([...groupBy([1, 2, 3, 4], n => n % 2)], [[1, [1, 3]], [0, [2, 4]]], 'groupBy');
  });
}

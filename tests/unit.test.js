// Uji fungsi murni (tanpa browser).
import { test, equal } from './harness.js';
import { parseAmount, resolveSku, parseGptText } from '../admin/gpt.js';
import { groupBy } from '../admin/reconcile.js';

const products = new Map([['UR','Pentol Urat'],['PK','Pentol Kecil'],['TP','Tahu Pentol'],['JM','Pentol Jamur'],
  ['MZ','Pentol Mozzarella'],['RJ','Pentol Ranjau'],['TD','Tahu Pedas'],['PG','Pentol Goreng'],['SG','Sambal Gila Tambahan']]);

export function unitTests() {
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

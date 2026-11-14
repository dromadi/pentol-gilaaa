const dayInJakarta = new Intl.DateTimeFormat('sv-SE', {timeZone:'Asia/Jakarta',year:'numeric',month:'2-digit',day:'2-digit'});

export function closeDaySheets({date, exportedAt, orders, stocks, reconciliation, invoiceNumber, productName, total, paid, deliveryLabel}) {
  const timestamp = exportedAt.toISOString();
  const day = value => value && Number.isFinite(Date.parse(value)) ? dayInJakarta.format(new Date(value)) : '';
  const orderRows = [];
  const cashRows = [];
  const receivables = [];
  for (const order of orders) {
    const reference = [order.id, invoiceNumber(order), order.customer, order.order_date];
    const amount = total(order);
    const received = paid(order);
    const due = Math.max(0, amount - received);
    const deliveryDate = order.delivered ? day(order.delivered_at) : '';
    const packs = order.pentol_order_items.reduce((sum, item) => sum + item.quantity, 0);
    const shipped = order.pentol_order_items.reduce((sum, item) => sum + item.shipped, 0);
    if (order.order_date === date || deliveryDate === date) {
      orderRows.push([...reference, packs, shipped, deliveryDate, deliveryLabel(order), amount]);
    }
    for (const payment of order.pentol_payments) {
      if (payment.paid_on === date) cashRows.push([...reference, payment.id, payment.paid_on, Number(payment.amount)]);
    }
    if (!order.cancelled && due > 0) receivables.push([...reference, deliveryLabel(order), amount, received, due]);
  }
  const stockRows = stocks.map(row => [row.batch_code, productName(row.sku), row.received, row.reserved, row.delivered,
    Math.max(0,row.received-row.reserved-row.delivered)]);
  const differences = reconciliation?.rows ?? [];
  const cash = cashRows.reduce((sum,row)=>sum+row[6],0);
  const due = receivables.reduce((sum,row)=>sum+row[7],0);
  const summary = {orders:orderRows.length, cash, due, stocks:stockRows.length, differences:reconciliation ? differences.length : null};
  const sheets = [
    ['Ringkasan', [['Rekap Tutup Hari','Nilai'],['Tanggal laporan (WIB)',date],['Waktu ekspor (UTC)',timestamp],
      ['Pesanan dibuat atau selesai antar pada tanggal laporan',summary.orders],['Kas diterima pada tanggal laporan',cash],
      ['Sisa tagihan pesanan aktif saat ekspor',due],['Baris stok saat ekspor',summary.stocks],
      ['Waktu perbandingan Excel (UTC)',reconciliation?.at ?? 'Belum dibandingkan di sesi ini'],
      ['File pembanding',reconciliation?.filename ?? ''],['Selisih saat perbandingan',summary.differences ?? 'Belum dibandingkan']]],
    ['Pesanan dan antar', [['Kode pesanan','Nomor invoice','Pelanggan','Tanggal pesan','Pack dipesan','Pack diantar saat ekspor','Tanggal antar selesai (WIB)','Status antar saat ekspor','Tagihan (Rp)'],...orderRows]],
    ['Kas harian', [['Kode pesanan','Nomor invoice','Pelanggan','Tanggal pesan','ID pembayaran','Tanggal bayar','Diterima (Rp)'],...cashRows]],
    ['Piutang saat ekspor', [['Kode pesanan','Nomor invoice','Pelanggan','Tanggal pesan','Status antar','Total (Rp)','Dibayar (Rp)','Sisa (Rp)'],...receivables]],
    ['Stok saat ekspor', [['Batch','Varian','Diterima','Terpesan','Diantar','Sisa jual'],...stockRows]],
    ['Selisih rekonsiliasi', [['Data','Excel','Aplikasi','Hasil'],...differences.map(row=>[row.label,row.excel,row.app,row.status])]]
  ];
  return {summary,sheets};
}

const escapeXml = value => String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g,'')
  .replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[char]));

// 0 -> A, 25 -> Z, 26 -> AA (tabel cadangan bisa lebih dari 26 kolom).
const columnName = index => (index >= 26 ? columnName(Math.floor(index / 26) - 1) : '') + String.fromCharCode(65 + index % 26);

export function closeDayWorkbook(sheets, Zip) {
  const zip = new Zip();
  const packageNs = 'http://schemas.openxmlformats.org/package/2006/';
  const officeNs = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const sheetNs = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const type = 'application/vnd.openxmlformats-officedocument.spreadsheetml.';
  const paths = sheets.map((_, index) => 'worksheets/sheet' + (index + 1) + '.xml');
  zip.file('[Content_Types].xml', '<Types xmlns="' + packageNs + 'content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/xl/workbook.xml" ContentType="' + type + 'sheet.main+xml"/>'
    + paths.map(path => '<Override PartName="/xl/' + path + '" ContentType="' + type + 'worksheet+xml"/>').join('') + '</Types>');
  zip.file('_rels/.rels', '<Relationships xmlns="' + packageNs + 'relationships"><Relationship Id="rId1" Type="'
    + officeNs + '/officeDocument" Target="xl/workbook.xml"/></Relationships>');
  zip.file('xl/workbook.xml', '<workbook xmlns="' + sheetNs + '" xmlns:r="' + officeNs + '"><sheets>'
    + sheets.map(([name], i) => '<sheet name="' + escapeXml(name) + '" sheetId="' + (i+1) + '" r:id="rId' + (i+1) + '"/>').join('')
    + '</sheets></workbook>');
  zip.file('xl/_rels/workbook.xml.rels', '<Relationships xmlns="' + packageNs + 'relationships">'
    + paths.map((path,i) => '<Relationship Id="rId' + (i+1) + '" Type="' + officeNs + '/worksheet" Target="' + path + '"/>').join('')
    + '</Relationships>');
  sheets.forEach(([, rows], index) => {
    const body = rows.map((row, rowIndex) => '<row r="' + (rowIndex+1) + '">' + row.map((value, column) => {
      const ref = ' r="' + columnName(column) + (rowIndex+1) + '"';
      return typeof value === 'number' && Number.isFinite(value)
        ? '<c' + ref + '><v>' + value + '</v></c>'
        : '<c' + ref + ' t="inlineStr"><is><t xml:space="preserve">' + escapeXml(value) + '</t></is></c>';
    }).join('') + '</row>').join('');
    zip.file('xl/' + paths[index], '<worksheet xmlns="' + sheetNs + '"><sheetData>' + body + '</sheetData></worksheet>');
  });
  return zip.generateAsync({type:'uint8array',compression:'DEFLATE'});
}

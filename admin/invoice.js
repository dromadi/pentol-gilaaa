const format = new Intl.NumberFormat('id-ID');
const money = amount => 'Rp' + format.format(amount);
const payment = ['BNI 821080132', 'GoPay 08981718578'];

export function invoiceContent({ number, customer, items, shipping, total, paid }) {
  const balance = Math.max(0, total - paid);
  const lines = [
    'PENTOL GILAAA SURABAYA',
    'Invoice ' + number,
    'Pelanggan: ' + customer, '',
    ...items.flatMap(item => [item.name,
      item.quantity + ' pack × ' + money(item.unitPrice) + ' = ' + money(item.quantity * item.unitPrice)]),
    '', ...(shipping ? ['Ongkir: ' + money(shipping)] : []),
    'Total: ' + money(total),
    'Pembayaran diterima: ' + money(paid),
    'Sisa tagihan: ' + money(balance),
    ...(balance ? ['', 'Pembayaran', ...payment] : ['LUNAS'])
  ];
  const reminder = balance ? [
    'Halo ' + customer + ', izin mengingatkan tagihan Pentol Gilaaa Surabaya untuk invoice ' + number + '.',
    'Sisa tagihan: ' + money(balance) + '.',
    'Pembayaran dapat dilakukan melalui ' + payment.join(' atau ') + '.',
    'Jika sudah transfer, boleh kirim bukti pembayarannya. Terima kasih.'
  ].join('\n') : '';
  return { lines, reminder };
}

// Each rendered page is a JPEG image. Offsets and stream lengths are measured in bytes.
export function invoicePdf(images) {
  const encoder = new TextEncoder();
  const chunks = [];
  const offsets = [0];
  let length = 0;
  function write(value) {
    const bytes = typeof value === 'string' ? encoder.encode(value) : value;
    chunks.push(bytes);
    length += bytes.length;
  }
  function object(id, ...parts) {
    offsets[id] = length;
    write(id + ' 0 obj\n');
    parts.forEach(write);
    write('\nendobj\n');
  }
  write('%PDF-1.4\n');
  object(1, '<< /Type /Catalog /Pages 2 0 R >>');
  object(2, '<< /Type /Pages /Count ' + images.length + ' /Kids ['
    + images.map((_, i) => (3 + i * 3) + ' 0 R').join(' ') + '] >>');
  images.forEach(({width, height, bytes}, index) => {
    const id = 3 + index * 3;
    const scale = Math.min(540 / width, 786 / height);
    const w = (width * scale).toFixed(3);
    const h = (height * scale).toFixed(3);
    const command = 'q ' + w + ' 0 0 ' + h + ' 27 ' + (815 - Number(h)).toFixed(3) + ' cm /Im0 Do Q';
    object(id, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /Im0 '
      + (id + 1) + ' 0 R >> >> /Contents ' + (id + 2) + ' 0 R >>');
    object(id + 1, '<< /Type /XObject /Subtype /Image /Width ' + width + ' /Height ' + height
      + ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + bytes.length + ' >>\nstream\n',
      bytes, '\nendstream');
    object(id + 2, '<< /Length ' + command.length + ' >>\nstream\n' + command + '\nendstream');
  });
  const xref = length;
  write('xref\n0 ' + offsets.length + '\n0000000000 65535 f \n');
  for (const offset of offsets.slice(1)) write(String(offset).padStart(10, '0') + ' 00000 n \n');
  write('trailer\n<< /Size ' + offsets.length + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n');
  return new Blob(chunks, {type:'application/pdf'});
}

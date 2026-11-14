import { closeDaySheets, closeDayWorkbook } from './close-day.js?v=2';
import { invoiceContent, invoicePdf } from './invoice.js?v=1';
import { openReconciliation, reconciliationRows, groupBy } from './reconcile.js?v=5';
import { parseGptText, gptInstructions } from './gpt.js?v=1';

export function initOperations({ $, request, status, products, prices, today, format,
  tableRow, emptyRow, quantities, getRows, getSession, getView, openOrder, refresh, selectView, loadRows }) {
  // Buka form pesanan tanpa pindah dari "Perlu tindakan" ke "Semua pesanan" (atau sebaliknya).
  const toOrders = () => { if (!['actions', 'orders'].includes(getView())) selectView('actions'); };
  const root = '/rest/v1/';
  const ordersSelect = '*,pentol_order_items(*),pentol_payments(*)';
  const dialog = $('ops-dialog');
  const fields = $('ops-fields');
  const dialogForm = $('ops-form');
  let submit;
  let dialogRun = 0;
  let excelInvoices = new Map();
  let lastReconciliation = null;
  const sizes = {UR:'9 pcs',PK:'30 pcs',TP:'30 pcs',JM:'9 pcs',MZ:'9 pcs',RJ:'9 pcs',TD:'9 pcs',PG:'9 pcs',SG:'±100 g'};
  const money = value => 'Rp' + format.format(Math.round(value));
  const total = order => Number(order.shipping_charge) + order.pentol_order_items.reduce((sum, item) => sum + item.quantity * item.unit_price, 0);
  const paid = order => order.paid ? total(order) : order.pentol_payments.reduce((sum, p) => sum + Number(p.amount), 0);
  const balance = order => Math.max(0, total(order) - paid(order));
  const paymentLabel = order => order.cancelled ? 'Batal' : order.paid ? 'Lunas'
    : paid(order) ? 'Sebagian · sisa ' + money(balance(order)) : 'Belum dibayar';
  const deliveryLabel = order => order.cancelled ? 'Batal' : order.delivered ? 'Sudah diantar'
    : order.pentol_order_items.some(item => item.shipped) ? 'Diantar sebagian' : 'Belum diantar';
  const stock = id => getRows().find(row => row.id === id);
  const label = item => {
    const row = stock(item.stock_id);
    return row ? products.get(row.sku) + ' · ' + row.batch_code : 'Varian batch';
  };

  function el(tag, value, className) {
    const node = document.createElement(tag);
    if (value !== undefined) node.textContent = value;
    if (className) node.className = className;
    return node;
  }

  function button(text, action) {
    const node = el('button', text, 'secondary');
    node.type = 'button';
    if (text === 'Batalkan') node.dataset.danger = 'true';
    node.addEventListener('click', action);
    return node;
  }

  function control(text, name, options = {}) {
    const wrap = el('label', text);
    const input = el(options.values ? 'select' : 'input');
    input.name = name;
    if (options.values) {
      for (const [id, caption] of options.values) input.add(new Option(caption, id));
    } else input.type = options.type || 'text';
    Object.assign(input, options.props || {});
    input.value = options.value ?? '';
    input.required = options.required ?? true;
    wrap.append(input);
    return wrap;
  }

  function block(nodes, className = 'fields') {
    const node = el('div', undefined, className);
    node.append(...nodes);
    return node;
  }

  function table(headers, data, empty) {
    const wrap = el('div', undefined, 'table');
    const grid = el('table');
    const header = grid.createTHead().insertRow();
    header.append(...headers.map(text => el('th', text)));
    const body = grid.createTBody();
    body.append(...data.map(values => {
      const row = tableRow(values.map(value => value instanceof HTMLElement ? '' : value));
      values.forEach((value, index) => {
        if (value instanceof HTMLElement) row.cells[index].append(value);
        if (row.cells[index]) row.cells[index].dataset.label = headers[index] ?? '';
      });
      return row;
    }));
    emptyRow(body, headers.length, empty);
    wrap.append(grid);
    return wrap;
  }

  async function list(path, filters = '') {
    const result = [];
    for (let offset = 0; ; offset += 200) {
      const page = await request(root + path + filters + '&limit=200&offset=' + offset);
      result.push(...page);
      if (page.length < 200) return result;
    }
  }

  function errorMessage(error) {
    const known = /^(Booking lama |Pesanan |Isi 1|Periksa varian|Gabungkan varian|Varian batch |Pilih jumlah|Jumlah |Stok fisik|Nominal |Pilih 1|Varian tidak|PO tidak |Penerimaan |Tanggal antar |Nomor invoice |Alasan koreksi |Stok berubah |Teks tidak |Aksi \d|Tidak ada aksi)/;
    return known.test(error.message) ? error.message : 'Perubahan belum terkonfirmasi. Muat ulang daftar sebelum mencoba lagi.';
  }

  function mutate(action, target, version, payload) {
    return request(root + 'rpc/pentol_order_action', {method:'POST', body:{action,target,version:version ?? null,payload}});
  }

  function admin(action, payload) {
    return request(root + 'rpc/pentol_admin_action', {method:'POST', body:{action,payload}});
  }

  function showDialog(title, nodes, onSubmit, { submitLabel = 'Simpan', danger = false } = {}) {
    if (dialog.open) return;
    const save = dialogForm.querySelector('button:not([type])');
    save.textContent = submitLabel;
    save.classList.toggle('danger', danger);
    $('ops-title').textContent = title;
    $('ops-error').textContent = '';
    fields.replaceChildren(...nodes);
    submit = onSubmit;
    dialog.showModal();
  }

  $('ops-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    dialogRun++;
    dialogForm.querySelector('button').disabled = false;
    fields.replaceChildren();
  });
  dialogForm.addEventListener('submit', async event => {
    event.preventDefault();
    const token = ++dialogRun;
    const save = dialogForm.querySelector('button[type=submit], button:not([type])');
    save.disabled = true;
    $('ops-error').textContent = '';
    try {
      const after = await submit(new FormData(dialogForm));
      if (dialogRun === token) dialog.close();
      if (after && getSession()) await after();
    } catch (error) {
      if (dialogRun === token) $('ops-error').textContent = errorMessage(error);
    } finally { save.disabled = false; }
  });

  function orderDialog(action, order, title, nodes, payload, onDone) {
    showDialog(title, nodes, async data => {
      const body = payload(data);
      const shipDay = action === 'ship' ? body.date : null;
      if (action === 'ship') delete body.date;
      if (shipDay && shipDay !== today()) {
        // Antar bertanggal lain (pencatatan terlambat): butuh tanggal-antar-2026-11.sql.
        try {
          await request(root + 'rpc/pentol_ship_order', {method:'POST', body:{
            target:order.id, expected_revision:order.revision, payload:body, ship_date:shipDay}});
        } catch (error) {
          if (error.status === 404) throw new Error('Tanggal antar selain hari ini aktif setelah tanggal-antar-2026-11.sql dijalankan di Supabase. Untuk sekarang pilih hari ini.');
          throw error;
        }
      } else await mutate(action, order.id, order.revision, body);
      onDone?.();
      const mapped = excelInvoices.get(order.id);
      if (mapped?.revision === order.revision && ['pay', 'ship', 'schedule'].includes(action)) mapped.revision++;
      return async () => {
        await refresh('Pesanan diperbarui.');
        if (!$('packing').hidden) open('packing');
        if (!$('delivery').hidden) open('delivery');
        if (!$('finance').hidden) open('finance');
        if (!$('receivables').hidden) await open('receivables');
        if (!$('today').hidden) await open('today');
      };
    });
  }

  function payDialog(order, prefill = {}) {
    const paymentId = crypto.randomUUID();
    const due = balance(order);
    const amount = prefill.amount ? Math.min(prefill.amount, due) : due;
    const notes = prefill.amount && prefill.amount > due
      ? [el('p', 'Dari GPT: ' + money(prefill.amount) + '. Sisa tagihan hanya ' + money(due) + '; periksa kelebihan bayar.')] : [];
    orderDialog('pay', order, 'Catat pembayaran · ' + order.customer + ' · Invoice ' + invoiceNumber(order), [...notes, block([
      control('Tanggal bayar', 'date', {type:'date', value:prefill.date || today(), props:{max:today()}}),
      control('Nominal diterima (Rp)', 'amount', {type:'number', value:amount, props:{min:1,max:due}})
    ]), el('p', 'Total ' + money(total(order)) + ' · sudah dibayar ' + money(paid(order))),
      ...order.pentol_payments.map(p => el('p', p.paid_on + ' · ' + money(p.amount)))],
    data => ({payment_id:paymentId,date:data.get('date'),amount:Number(data.get('amount'))}), prefill.onDone);
  }

  // prefill.items: [{sku, quantity}] dibagi ke baris pesanan varian yang sama; kosong = semua sisa.
  function shipDialog(order, prefill = {}) {
    const pending = order.pentol_order_items.filter(i => i.shipped < i.quantity);
    const wanted = new Map((prefill.items || []).map(item => [item.sku, item.quantity]));
    const notes = [];
    const value = item => {
      const left = item.quantity - item.shipped;
      if (!wanted.size) return left;
      const sku = stock(item.stock_id)?.sku;
      const take = Math.min(left, wanted.get(sku) || 0);
      if (take) wanted.set(sku, wanted.get(sku) - take);
      return take;
    };
    const fields = pending.map(i => control(label(i), i.stock_id, {type:'number',value:value(i),props:{min:0,max:i.quantity-i.shipped}}));
    for (const [sku, rest] of wanted) if (rest > 0) notes.push(el('p', 'Dari GPT: ' + rest + ' pack ' + (products.get(sku) || sku) + ' tidak ada di sisa pesanan ini.'));
    const first = order.order_date > today() ? today() : order.order_date;
    const day = control('Tanggal antar', 'ship_date', {type:'date', value:prefill.date && prefill.date <= today() && prefill.date >= first ? prefill.date : today(),
      props:{max:today(), min:first}});
    orderDialog('ship', order, 'Jumlah yang sudah diantar · ' + order.customer, [...notes, day, block(fields)],
      data => ({date:data.get('ship_date') || today(), items:pending.map(i => ({stock_id:i.stock_id,quantity:Number(data.get(i.stock_id))})).filter(i => i.quantity)}), prefill.onDone);
  }

  // ===== Pesan WhatsApp siap kirim. Ubah teks di sini bila perlu. =====
  const waTemplates = {
    remind: order => 'Halo ' + order.customer + ', terima kasih sudah memesan Pentol Gilaaa 🙏\n'
      + 'Ini pengingat tagihan invoice ' + invoiceNumber(order) + ':\n'
      + '• Total ' + money(total(order)) + '\n• Sudah dibayar ' + money(paid(order)) + '\n• Sisa ' + money(balance(order)) + '\n\n'
      + 'Mohon kabari kami bila sudah transfer. Terima kasih!',
    delivering: order => 'Halo ' + order.customer + ', pesanan Pentol Gilaaa sedang diantar'
      + (order.delivery_location ? ' ke ' + order.delivery_location : '') + ':\n'
      + order.pentol_order_items.filter(i => i.shipped < i.quantity)
        .map(i => '• ' + (products.get(stock(i.stock_id)?.sku) || 'Pesanan') + ' × ' + (i.quantity - i.shipped)).join('\n')
      + '\n\n' + (balance(order) ? 'Sisa tagihan ' + money(balance(order)) + '.' : 'Pesanan sudah lunas.') + ' Terima kasih!'
  };
  // 08xx / +62 / 62 -> 62xxxxxxxx; null bila bukan nomor HP Indonesia yang wajar.
  function waNumber(contact) {
    let digits = String(contact ?? '').replace(/\D/g, '');
    if (digits.startsWith('0')) digits = '62' + digits.slice(1);
    else if (digits.startsWith('8')) digits = '62' + digits;
    return /^62\d{8,13}$/.test(digits) ? digits : null;
  }
  function waAnchor(contact, message, text) {
    const number = waNumber(contact);
    if (!number) return null;
    const link = el('a', text, 'wa-link');
    link.href = 'https://wa.me/' + number + '?text=' + encodeURIComponent(message);
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    return link;
  }
  function waLink(order, kind, text) {
    return waAnchor(order.contact, waTemplates[kind](order), text);
  }
  // Konfirmasi permintaan dari katalog dan pengingat beberapa invoice sekaligus.
  const confirmMessage = entry => 'Halo ' + entry.customer + ', terima kasih sudah pesan di Pentol Gilaaa 🙏\n'
    + 'Pesananmu:\n' + entry.items.map(i => '• ' + (products.get(i.sku) || i.sku) + ' × ' + i.quantity).join('\n')
    + '\n\nKami cek stok dan jadwalnya dulu ya, segera kami kabari total dan ongkirnya.';
  const remindAllMessage = orders => 'Halo ' + orders[0].customer + ', terima kasih sudah langganan Pentol Gilaaa 🙏\n'
    + 'Ini pengingat tagihan yang masih terbuka:\n'
    + orders.map(o => '• Invoice ' + invoiceNumber(o) + ' · sisa ' + money(balance(o))).join('\n')
    + '\nTotal sisa ' + money(orders.reduce((sum, o) => sum + balance(o), 0)) + '\n\nMohon kabari kami bila sudah transfer. Terima kasih!';
  // "2026-11-14" -> "Sab, 14 Nov"
  const dayFormat = new Intl.DateTimeFormat('id-ID', { weekday:'short', day:'numeric', month:'short', timeZone:'UTC' });
  const dayLabel = day => day ? dayFormat.format(new Date(day + 'T00:00:00Z')) : '';
  // Catatan dari katalog: "Diantar · Jadwal: 2026-11-16 · titip resepsionis" -> tampil "Jadwal Sen, 16 Nov".
  const inboxNote = note => String(note || '').replace(/Jadwal: (\d{4}-\d{2}-\d{2})/, (_, day) => 'Jadwal ' + dayLabel(day))
    .replace(/(\s·\s*)+$/, '').trim();

  // Aksi utama tampil langsung (Antar / Bayar / WA); aksi jarang dipakai di menu "⋯".
  // context: 'packing' (daftar antar), 'receivables' (tagihan), atau kosong (daftar pesanan).
  function orderButtons(order, target, context = '') {
    if (order.cancelled) { target.textContent = '—'; return; }
    const main = el('div', undefined, 'ops-actions primary-actions');
    const extra = el('div', undefined, 'ops-actions');
    const owes = !order.paid && balance(order) > 0;
    const shipped = order.pentol_order_items.some(i => i.shipped);
    const shipButton = button('Antar', () => shipDialog(order));
    shipButton.setAttribute('aria-label', 'Catat pengantaran ' + order.customer);
    const payButton = button('Bayar', () => payDialog(order));
    payButton.setAttribute('aria-label', 'Catat bayar ' + order.customer);
    const remind = owes && shipped ? waLink(order, 'remind', 'Ingatkan via WA') : null;
    const notify = !order.delivered ? waLink(order, 'delivering', 'Kabari diantar') : null;
    const primary = [];
    if (context === 'receivables') primary.push(owes && payButton, remind);
    else if (context === 'packing') primary.push(!order.delivered && shipButton, notify, owes && payButton);
    else primary.push(!order.delivered && shipButton, owes && payButton);
    const shown = primary.filter(Boolean);
    shown.find(node => node.tagName === 'BUTTON')?.classList.add('primary-action');
    if (!shown.length) shown.push(button('Invoice', () => showInvoice(order)));
    main.append(...shown);
    const rest = [];
    if (!shown.some(node => node.textContent === 'Invoice')) rest.push(button('Invoice', () => showInvoice(order)));
    if (!order.delivered) rest.push(button('Jadwal antar', () => orderDialog('schedule', order, 'Jadwal antar · ' + order.customer,
      [control('Tanggal antar', 'date', {type:'date', value:order.delivery_on || today(), required:false})],
      data => ({delivery_on:data.get('date') || null}))));
    if (!order.delivered && !shown.includes(shipButton)) rest.push(shipButton);
    if (owes && !shown.includes(payButton)) rest.push(payButton);
    if (remind && !shown.includes(remind)) rest.push(remind);
    if (notify && !shown.includes(notify)) rest.push(notify);
    rest.unshift(button('Ubah pesanan', () => {
      toOrders();
      openOrder(order);
    }));
    if (!order.paid && !paid(order) && !shipped) {
      rest.push(button('Batalkan', () => orderDialog('cancel', order, 'Batalkan pesanan · ' + order.customer,
        [el('p', 'Stok yang dipesan akan dilepas. Riwayat pesanan tetap tampil dengan status Batal.')], () => ({}))));
    }
    if (order.pentol_payments.length || shipped) {
      const fix = button('Koreksi', () => correctionDialog(order));
      fix.hidden = true;
      hasOpsTools().then(ok => { fix.hidden = !ok; });
      rest.push(fix);
    }
    extra.append(...rest);
    const more = el('details', undefined, 'action-menu more-actions');
    const summary = el('summary', '⋯');
    summary.setAttribute('aria-label', 'Aksi lain untuk ' + order.customer);
    more.append(summary, extra);
    const bar = el('div', undefined, 'order-action-bar');
    bar.append(main);
    if (rest.length) bar.append(more);
    target.append(bar);
  }



  function renderImage(lines, width, minHeight) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Ekspor gambar tidak tersedia di browser ini.');
    canvas.width = width;
    const font = '28px system-ui';
    ctx.font = font;
    const wrapped = lines.flatMap(line => {
      if (ctx.measureText(line).width <= width - 100) return [line];
      const chunks = [''];
      for (const char of line) {
        const last = chunks.length - 1;
        if (ctx.measureText(chunks[last] + char).width > width - 100) chunks.push(char);
        else chunks[last] += char;
      }
      return chunks;
    });
    canvas.height = Math.max(minHeight, 120 + wrapped.length * 48);
    ctx.fillStyle = '#fff7e9';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#a62017';
    ctx.fillRect(0, 0, canvas.width, 16);
    ctx.fillStyle = '#321b16';
    wrapped.forEach((line, i) => {
      ctx.font = i === 0 ? 'bold 34px system-ui' : font;
      ctx.fillText(line, 48, 72 + i * 48, width - 96);
    });
    return canvas;
  }

  function download(url, filename) {
    const link = el('a');
    link.href = url;
    link.download = filename;
    link.click();
  }

  function png(lines, filename, width = 900, minHeight = 0) {
    try { download(renderImage(lines, width, minHeight).toDataURL('image/png'), filename + '.png'); }
    catch { status('Gambar belum bisa diunduh.', true); }
  }

  function pdf(lines, filename) {
    const pages = [];
    // Short lines wrap in the same way as PNG. Split long invoices across A4 pages.
    for (let start = 0; start < lines.length; start += 22) {
      const canvas = renderImage(lines.slice(start, start + 22), 900, 0);
      const jpeg = canvas.toDataURL('image/jpeg', .94).split(',')[1];
      pages.push({width:canvas.width,height:canvas.height,bytes:Uint8Array.from(atob(jpeg), char => char.charCodeAt(0))});
    }
    const url = URL.createObjectURL(invoicePdf(pages));
    download(url, filename + '.pdf');
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }

  function invoiceNumber(order) {
    const mapped = excelInvoices.get(order.id);
    const matched = mapped && mapped.revision === order.revision ? mapped.reference : '';
    return order.excel_invoice_no || matched || String(order.invoice_no).padStart(5, '0');
  }

  async function showInvoice(order) {
    const session = getSession();
    try {
      const [fresh] = await orderQuery('&id=eq.' + encodeURIComponent(order.id));
      if (!session || getSession() !== session) return;
      if (!fresh) return status('Pesanan aktif tidak ditemukan. Muat ulang daftar.', true);
      const mapped = excelInvoices.get(fresh.id);
      const matched = mapped && mapped.revision === fresh.revision ? mapped.reference : '';
      const number = invoiceNumber(fresh);
      const filename = 'Invoice-' + number.replace(/[^A-Za-z0-9_-]/g, '-');
      const {lines, reminder} = invoiceContent({
        number, customer:fresh.customer, shipping:fresh.shipping_charge,
        total:total(fresh), paid:paid(fresh),
        items:fresh.pentol_order_items.map(item => ({
          name:products.get(stock(item.stock_id)?.sku) || label(item),
          quantity:item.quantity, unitPrice:item.unit_price
        }))
      });
      const feedback = el('p');
      feedback.setAttribute('role', 'status');
      const actions = [
        button('Unduh PDF', () => {
          try { pdf(lines, filename); }
          catch { feedback.textContent = 'PDF belum bisa diunduh.'; }
        }),
        button('Unduh PNG', () => png(lines, filename))
      ];
      const nodes = [
        el('p', fresh.excel_invoice_no ? 'Nomor Excel tersimpan'
          : matched ? 'Nomor Excel untuk sesi ini'
            : 'Nomor aplikasi · cocokkan Excel lewat Rekonsiliasi Excel.'),
        el('p', lines.join('\n'), 'ops-copy'), block(actions, 'ops-actions'), feedback
      ];
      if (!fresh.excel_invoice_no && /^PG-[0-9]{8}-[0-9]{3,9}$/i.test(matched)) {
        if (Object.prototype.hasOwnProperty.call(fresh, 'excel_invoice_no')) {
          const saveReference = button('Simpan nomor Excel', async () => {
            saveReference.disabled = true;
            try {
              await request(root + 'rpc/pentol_save_excel_invoice', {method:'POST',body:{
                order_id:fresh.id,expected_revision:fresh.revision,invoice_reference:matched
              }});
              if (getSession() !== session) return;
              nodes[0].textContent = 'Nomor Excel tersimpan';
              feedback.textContent = 'Nomor ' + matched + ' tersimpan untuk pesanan ini.';
              saveReference.remove();
              await refresh('Nomor invoice Excel tersimpan.');
              if (!$('packing').hidden) open('packing');
        if (!$('delivery').hidden) open('delivery');
            } catch (error) {
              feedback.textContent = errorMessage(error);
              saveReference.disabled = false;
            }
          });
          nodes.push(saveReference);
        } else {
          nodes.push(el('p', 'Penyimpanan permanen tersedia setelah migrasi nomor invoice di Supabase.'));
        }
      }
      if (reminder && fresh.delivered) {
        const message = el('textarea');
        message.readOnly = true;
        message.value = reminder;
        const field = el('label', 'Pesan tagihan WhatsApp');
        field.append(message);
        nodes.push(field, button('Salin pesan tagihan', async () => {
          try {
            await navigator.clipboard.writeText(message.value);
            feedback.textContent = 'Pesan tagihan disalin.';
          } catch {
            message.select();
            feedback.textContent = 'Salin teks yang dipilih.';
          }
        }));
      }
      if (dialog.open) return;
      showDialog('Invoice', nodes, async () => {});
      const save = dialogForm.querySelector('button:not([type])');
      save.hidden = true;
      dialog.addEventListener('close', () => { save.hidden = false; }, {once:true});
    } catch {
      if (getSession() === session) status('Invoice belum bisa dimuat. Coba lagi.', true);
    }
  }

  // ===== Tempel dari GPT: teks JSON dari ChatGPT -> form yang sudah terisi, dikonfirmasi admin. =====
  const nameKey = value => String(value ?? '').trim().toLocaleLowerCase('id').replace(/\s+/g, ' ');
  function matchOrders(orders, action) {
    if (action.invoice) {
      const ref = nameKey(action.invoice).replace(/^#/, '');
      const byInvoice = orders.filter(order => nameKey(invoiceNumber(order)) === ref
        || nameKey(order.excel_invoice_no) === ref || String(order.invoice_no) === ref.replace(/^0+/, ''));
      if (byInvoice.length) return byInvoice;
    }
    const wanted = nameKey(action.customer);
    if (!wanted) return [];
    const exact = orders.filter(order => nameKey(order.customer) === wanted);
    return exact.length ? exact : orders.filter(order => nameKey(order.customer).includes(wanted) || wanted.includes(nameKey(order.customer)));
  }

  function describeAction(action) {
    const list = items => items.map(item => products.get(item.sku) + ' × ' + item.quantity).join(', ');
    if (action.type === 'order') return 'Pesanan baru · ' + action.customer + ' · ' + list(action.items)
      + (action.deliveryOn ? ' · antar ' + action.deliveryOn : '') + (action.location ? ' · ' + action.location : '');
    if (action.type === 'pay') return 'Bayar · ' + (action.customer || 'Invoice ' + action.invoice) + ' · ' + (action.full ? 'lunas' : money(action.amount)) + ' · ' + action.date;
    return 'Antar · ' + (action.customer || 'Invoice ' + action.invoice) + ' · ' + (action.items.length ? list(action.items) : 'semua sisa pesanan') + ' · ' + action.date;
  }

  async function runGptAction(action, row, mark) {
    if (action.type === 'order') {
      toOrders();
      openOrder(null, {customer:action.customer, phone:action.contact, area:action.location, note:action.note, items:action.items});
      const form = $('order-form').elements;
      form.order_date.value = action.date;
      form.delivery_on.value = action.deliveryOn;
      form.shipping_charge.value = action.shipping;
      form.shipping_charge.dispatchEvent(new Event('input', {bubbles:true}));
      $('order-form').scrollIntoView({block:'start'});
      mark('Form pesanan dibuka · periksa lalu Simpan');
      return;
    }
    mark('Mencari pesanan…');
    const candidates = matchOrders(action.type === 'pay'
      ? (await orderQuery('&paid=eq.false')).filter(order => balance(order) > 0)
      : await orderQuery('&delivered=eq.false'), action);
    const open = order => action.type === 'pay'
      ? payDialog(order, {amount:action.amount, date:action.date, onDone:() => mark('✓ Tersimpan')})
      : shipDialog(order, {items:action.items, date:action.date, onDone:() => mark('✓ Tersimpan')});
    if (!candidates.length) return mark(action.type === 'pay'
      ? 'Tidak ada pesanan belum lunas atas nama ini' : 'Tidak ada pesanan belum diantar atas nama ini', true);
    if (candidates.length === 1) { mark('Periksa lalu Simpan'); return open(candidates[0]); }
    mark('Ada ' + candidates.length + ' pesanan cocok · pilih satu');
    row.append(block(candidates.map(order => button('Invoice ' + invoiceNumber(order) + ' · ' + order.order_date + ' · '
      + (action.type === 'pay' ? 'sisa ' + money(balance(order)) : order.pentol_order_items.map(label).join(', ')),
      () => open(order))), 'ops-actions'));
  }

  function renderGptResults({actions, errors}) {
    const panel = $('gpt-results');
    panel.hidden = false;
    const head = block([el('strong', 'Dari GPT · ' + actions.length + ' aksi'),
      button('Tutup', () => { panel.hidden = true; panel.replaceChildren(); })], 'gpt-head');
    panel.replaceChildren(head, ...errors.map(error => el('p', error, 'gpt-error')));
    for (const action of actions) {
      const row = el('article', undefined, 'gpt-action');
      const state = el('p', '', 'gpt-state');
      const mark = (text, bad = false) => { state.textContent = text; state.dataset.error = String(bad); };
      const go = button(action.type === 'order' ? 'Buka form pesanan' : action.type === 'pay' ? 'Catat bayar' : 'Catat antar',
        () => runGptAction(action, row, mark).catch(() => mark('Data pesanan belum bisa dimuat. Coba lagi.', true)));
      row.append(el('p', describeAction(action)), state, block([go], 'ops-actions'));
      panel.append(row);
    }
    panel.scrollIntoView({block:'start'});
  }

  function gptImport() {
    const date = today();
    const box = el('textarea');
    box.name = 'gpt_text';
    box.rows = 8;
    box.required = true;
    box.placeholder = 'Tempel jawaban ChatGPT di sini (blok JSON)';
    const wrap = el('label', 'Hasil dari ChatGPT');
    wrap.append(box);
    const copy = button('Salin instruksi untuk ChatGPT', async () => {
      try { await navigator.clipboard.writeText(gptInstructions(products, date)); copy.textContent = 'Instruksi disalin ✓'; }
      catch { copy.textContent = 'Salin gagal · pilih teks di bawah'; }
    });
    const howTo = el('details');
    howTo.append(el('summary', 'Cara pakai'), el('p', '1. Salin instruksi lalu kirim ke ChatGPT sekali di awal percakapan. '
      + '2. Tulis pesanan, bayar, atau antar seperti biasa di ChatGPT. 3. Salin blok JSON jawabannya dan tempel di sini. '
      + 'Tidak ada yang tersimpan sebelum Anda menekan Simpan di setiap form.'), el('p', gptInstructions(products, date), 'ops-copy'));
    showDialog('Tempel dari GPT', [block([copy], 'ops-actions'), howTo, wrap], async data => {
      const result = parseGptText(data.get('gpt_text'), products, date);
      if (!result.actions.length) throw new Error(result.errors.join(' '));
      return () => renderGptResults(result);
    });
    const save = dialogForm.querySelector('button:not([type])');
    save.textContent = 'Baca';
    dialog.addEventListener('close', () => { save.textContent = 'Simpan'; }, {once:true});
  }
  $('gpt-import').addEventListener('click', () => { if (getSession()) gptImport(); });

  async function loadPrices() {

    const data = await request(root + 'pentol_products?select=sku,price');
    for (const row of data) prices[row.sku] = row.price;
  }

  async function inbox() {
    const session = getSession();
    const target = $('inbox-list');
    try {
      // Arsip 14 hari terakhir tetap bisa dilihat dan dijadikan pesanan (arsip tidak menghapus data).
      const since = new Date(Date.now() - 14 * 864e5).toISOString();
      const [entries, archived] = await Promise.all([
        list('pentol_inbox?select=*', '&status=eq.pending&order=created_at.desc,id'),
        list('pentol_inbox?select=*', '&status=eq.dismissed&created_at=gte.' + since + '&order=created_at.desc,id&limit=20').catch(() => [])
      ]);
      if (!session || getSession() !== session) return;
      $('inbox-count').textContent = '(' + entries.length + ')';
      $('checkout-inbox').open = entries.length > 0;
      target.replaceChildren(...entries.map(entry => {
        const card = el('article', undefined, 'ops-card');
        const process = button('Proses pesanan', () => openOrder(null, entry));
        process.classList.add('primary-action');
        const remove = button('Hapus', () => showDialog('Hapus pesanan ' + entry.customer + '?', [
          el('p', 'Yakin hapus permintaan ini? ' + entry.items.map(i => products.get(i.sku) + ' × ' + i.quantity).join(', ') + '.'),
          el('p', 'Permintaan hilang dari daftar. Bila keliru, masih bisa dibuat ulang dari bagian "Dihapus" selama 14 hari.')
        ], async () => {
          await admin('dismiss', {id:entry.id});
          return async () => { status('Permintaan ' + entry.customer + ' dihapus.'); await inbox(); };
        }, { submitLabel:'Ya, hapus', danger:true }));
        remove.classList.add('danger-text');
        card.append(el('strong', entry.customer),
          el('p', 'Masuk ' + sinceText(entry.created_at) + ' · Kode ' + entry.id.slice(0, 8)),
          el('p', [entry.phone,entry.area,inboxNote(entry.note)].filter(Boolean).join(' · ')),
          el('p', entry.items.map(i => products.get(i.sku) + ' × ' + i.quantity).join(', ')),
          block([process, button('Ubah', () => openOrder(null, entry)),
            waAnchor(entry.phone, confirmMessage(entry), 'Balas WA') || '', remove], 'ops-actions'));
        return card;
      }));
      if (!entries.length) target.append(el('p', 'Belum ada permintaan baru.'));
      if (archived.length) {
        const box = el('details', undefined, 'inbox-archived');
        box.append(el('summary', 'Dihapus 14 hari terakhir (' + archived.length + ')'),
          ...archived.map(entry => {
            const card = el('article', undefined, 'ops-card');
            // Tanpa id permintaan: pesanan dibuat biasa, arsipnya tetap tercatat.
            card.append(el('strong', entry.customer),
              el('p', 'Masuk ' + sinceText(entry.created_at) + ' · ' + [entry.phone, entry.area].filter(Boolean).join(' · ')),
              el('p', entry.items.map(i => products.get(i.sku) + ' × ' + i.quantity).join(', ')),
              block([button('Buat pesanan', () => openOrder(null, {...entry, id: undefined})),
                waAnchor(entry.phone, confirmMessage(entry), 'Balas WA') || ''], 'ops-actions'));
            return card;
          }));
        target.append(box);
      }
    } catch {
      if (session && getSession() === session) target.replaceChildren(el('p', 'Daftar permintaan belum bisa dimuat.'));
    }
  }

  // Kesiapan packing per pesanan: stok fisik (diterima − diantar) tiap baris batch dibagi ke pesanan
  // yang belum diantar menurut prioritas: jadwal antar paling awal (tanpa jadwal terakhir), lalu tanggal pesan.
  // Hasil: Map 'orderId|stockId' -> pack yang bisa dikemas sekarang.
  function allocatePacking(openOrders) {
    const left = new Map(getRows().map(row => [row.id, Math.max(0, row.received - row.delivered)]));
    const sorted = [...openOrders].sort((a, b) => (a.delivery_on || '9999').localeCompare(b.delivery_on || '9999')
      || a.order_date.localeCompare(b.order_date) || String(a.created_at || '').localeCompare(String(b.created_at || ''))
      || a.id.localeCompare(b.id));
    const ready = new Map();
    for (const order of sorted) {
      for (const item of order.pentol_order_items) {
        const need = item.quantity - item.shipped;
        if (need <= 0) continue;
        const have = left.get(item.stock_id) || 0;
        const take = Math.min(need, have);
        left.set(item.stock_id, have - take);
        ready.set(order.id + '|' + item.stock_id, take);
      }
    }
    return ready;
  }
  function packStatus(order, allocation) {
    const items = order.pentol_order_items.filter(item => item.shipped < item.quantity)
      .map(item => ({ item, need: item.quantity - item.shipped, ready: allocation.get(order.id + '|' + item.stock_id) || 0 }));
    const need = items.reduce((sum, x) => sum + x.need, 0);
    const ready = items.reduce((sum, x) => sum + x.ready, 0);
    return { items, need, ready };
  }

  // Belum lunas setelah ada barang yang diantar, termasuk antar sebagian.
  const unpaidFilter = '&paid=eq.false';
  const isOwed = order => balance(order) > 0 && order.pentol_order_items.some(item => item.shipped > 0);
  const owedQuery = async () => (await orderQuery(unpaidFilter)).filter(isOwed);
  const daysBetween = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / 86400000);
  const orderQuery = filters => list('pentol_orders?select=' + ordersSelect,
    '&cancelled=eq.false&order=order_date,created_at,id' + filters);

  // Pesanan yang perlu diantar menurut Hari Ini: terlambat, jadwal hari ini, lalu belum dijadwalkan.
  const dueRank = (order, date) => !order.delivery_on ? 2 : order.delivery_on < date ? 0 : 1;
  const dueOrders = (open, date) => open.filter(order => !order.delivery_on || order.delivery_on <= date)
    .sort((a, b) => dueRank(a, date) - dueRank(b, date) || (a.delivery_on || '').localeCompare(b.delivery_on || ''));
  const sinceText = timestamp => {
    const minutes = Math.max(0, Math.round((Date.now() - Date.parse(timestamp)) / 60000));
    return minutes < 60 ? minutes + ' menit lalu' : minutes < 1440 ? Math.round(minutes / 60) + ' jam lalu' : Math.round(minutes / 1440) + ' hari lalu';
  };
  const jakartaDate = new Intl.DateTimeFormat('sv-SE', {timeZone:'Asia/Jakarta'});
  const owedDays = order => order.delivered_at ? daysBetween(jakartaDate.format(new Date(order.delivered_at)), today()) : null;

  async function overview(target) {
    const session = getSession();
    const date = today();
    target.textContent = 'Memuat ringkasan…';
    const [entries, pending, owed] = await Promise.all([
      list('pentol_inbox?select=*', '&status=eq.pending&order=created_at.desc,id'),
      orderQuery('&delivered=eq.false'),
      owedQuery()
    ]);
    if (getSession() !== session) return;
    const deliveries = dueOrders(pending, date);
    const late = deliveries.filter(order => dueRank(order, date) === 0).length;
    const unscheduled = deliveries.filter(order => dueRank(order, date) === 2).length;
    const allocation = allocatePacking(pending);
    const ready = deliveries.filter(order => packStatus(order, allocation).ready > 0);
    const fullyReady = ready.filter(order => { const pack = packStatus(order, allocation); return pack.ready === pack.need; }).length;
    // Tagihan: yang paling lama belum dibayar di atas.
    const unpaid = [...owed].sort((a, b) => (owedDays(b) ?? -1) - (owedDays(a) ?? -1));
    const when = order => !order.delivery_on ? 'belum dijadwalkan'
      : order.delivery_on < date ? 'terlambat ' + daysBetween(order.delivery_on, date) + ' hari' : 'hari ini';
    const rowAction = (text, action) => { const node = button(text, action); node.classList.add('row-action'); return node; };
    const sections = [
      ['Permintaan baru', entries, 'permintaan', entry => entry.customer + ' · ' + sinceText(entry.created_at),
        'Buka permintaan', () => {
          selectView('actions');
          const inbox = $('checkout-inbox');
          inbox.open = true;
          inbox.querySelector('summary').focus();
        }, '', entry => [rowAction('Proses', () => { toOrders(); openOrder(null, entry); })]],
      ['Bisa dikemas', ready, 'pesanan', null,
        'Buka yang siap dikemas', () => selectView('packing', 'dueReady'),
        [fullyReady && fullyReady + ' siap penuh', ready.length - fullyReady && (ready.length - fullyReady) + ' sebagian']
          .filter(Boolean).join(' · ') + ' · dari ' + deliveries.length + ' yang perlu diantar'],
      ['Perlu diantar', deliveries, 'pesanan', order => order.customer + ' · ' + when(order),
        'Buka daftar antar', () => selectView('delivery', 'due'),
        [late && late + ' terlambat', unscheduled && unscheduled + ' belum dijadwalkan'].filter(Boolean).join(' · '),
        order => [rowAction('Antar', () => shipDialog(order))]],
      ['Diantar, belum lunas', unpaid, 'pesanan', order => order.customer + ' · ' + money(balance(order))
        + (owedDays(order) ? ' · ' + owedDays(order) + ' hari' : '') + (order.delivered ? '' : ' · antar sebagian'),
        'Buka tagihan', () => selectView('receivables'),
        unpaid.length ? 'Total sisa tagihan ' + money(unpaid.reduce((sum, order) => sum + balance(order), 0)) : '',
        order => [rowAction('Bayar', () => payDialog(order)), waLink(order, 'remind', 'WA')].filter(Boolean)]
    ];
    $('today-date').dateTime = date;
    $('today-date').textContent = new Intl.DateTimeFormat('id-ID', {weekday:'long', day:'numeric', month:'long', timeZone:'UTC'})
      .format(new Date(date + 'T00:00:00Z'));
    const age = backupAge();
    const reminder = age === null || age >= 7 ? (() => {
      const box = el('section', undefined, 'backup-reminder');
      box.append(el('p', '🛟 ' + backupLabel() + ' Unduh cadangan seminggu sekali agar data aman.'),
        button('Unduh cadangan', event => downloadBackup(event.currentTarget)));
      return box;
    })() : null;
    const opnameDays = (await hasOpsTools().catch(() => false)) ? opnameAge() : 0;
    if (getSession() !== session) return;
    const opnameReminder = opnameDays === null || opnameDays >= 7 ? (() => {
      const box = el('section', undefined, 'backup-reminder opname-reminder');
      box.append(el('p', '🧊 ' + (opnameDays === null ? 'Belum pernah hitung stok fisik di perangkat ini.' : 'Hitung stok terakhir ' + opnameDays + ' hari lalu.')
        + ' Cocokkan isi freezer seminggu sekali agar stok tepat.'),
        button('Hitung stok', () => { selectView('stock'); opnameDialog(); }));
      return box;
    })() : null;
    target.replaceChildren(block(sections.map(([title, records, unit, describe, action, navigate, note, actions], index) => {
      const card = el('section', undefined, 'ops-card today-card');
      card.dataset.tone = ['request', 'pack', 'deliver', 'money'][index];
      const isMoney = records === unpaid;
      const big = isMoney ? money(unpaid.reduce((sum, order) => sum + balance(order), 0)) : format.format(records.length);
      const head = el('div', undefined, 'today-card-head');
      head.append(el('h3', title));
      card.append(head, el('strong', big, 'today-number'),
        el('p', isMoney ? format.format(records.length) + ' pesanan masih punya tagihan'
          : records.length ? unit + (note ? ' · ' + note : '') : 'Tidak ada ' + unit + '.', 'today-note'));
      // "Bisa dikemas" tidak mengulang daftar nama dari "Perlu diantar".
      if (records.length && describe) {
        const preview = el('ul', undefined, 'today-list');
        preview.append(...records.slice(0, 3).map(record => {
          const item = el('li');
          item.append(el('span', describe(record), 'today-row-text'));
          if (actions) item.append(block(actions(record), 'today-row-actions'));
          return item;
        }));
        if (records.length > 3) preview.append(el('li', '+' + (records.length - 3) + ' lainnya', 'today-more'));
        card.append(preview);
      }
      const go = button(action + ' →', navigate);
      card.append(go);
      return card;
    }), 'today-grid'), ...[reminder, opnameReminder].filter(Boolean));
  }

  const deliveryDay = new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Jakarta',year:'numeric',month:'2-digit',day:'2-digit'});

  // Satu pembayaran untuk beberapa invoice: dibagi ke invoice paling lama lebih dulu.
  function payTogetherDialog(orders) {
    const due = orders.reduce((sum, o) => sum + balance(o), 0);
    const amount = control('Nominal diterima (Rp)', 'amount', { type:'number', value:due, props:{ min:1, max:due } });
    const date = control('Tanggal bayar', 'date', { type:'date', value:today(), props:{ max:today() } });
    const preview = el('div', undefined, 'pay-split');
    const split = value => {
      let left = Math.max(0, Math.min(due, Math.round(Number(value) || 0)));
      return orders.map(o => { const take = Math.min(left, balance(o)); left -= take; return { order:o, take }; }).filter(x => x.take > 0);
    };
    const show = () => preview.replaceChildren(...split(amount.lastChild.value).map(x =>
      el('p', 'Invoice ' + invoiceNumber(x.order) + ' · ' + money(x.take) + (x.take < balance(x.order) ? ' (sebagian)' : ' (lunas)'))));
    amount.lastChild.addEventListener('input', show);
    showDialog('Bayar sekaligus · ' + orders[0].customer, [el('p', 'Sisa ' + money(due) + ' dari ' + orders.length
      + ' invoice. Nominal dibagi ke invoice yang paling lama lebih dulu.'), block([date, amount]), preview], async data => {
      const parts = split(data.get('amount'));
      let saved = 0;
      for (const { order, take } of parts) {
        try {
          await mutate('pay', order.id, order.revision, { payment_id:crypto.randomUUID(), date:data.get('date'), amount:take });
          saved++;
        } catch (error) {
          throw new Error((saved ? saved + ' dari ' + parts.length + ' invoice sudah tersimpan. ' : '') + errorMessage(error));
        }
      }
      return async () => {
        await refresh('Pembayaran ' + money(parts.reduce((sum, x) => sum + x.take, 0)) + ' dicatat ke ' + parts.length + ' invoice.');
        if (!$('receivables').hidden) await open('receivables');
        if (!$('today').hidden) await open('today');
      };
    });
    show();
  }

  async function receivables(target) {
    const session = getSession();
    target.textContent = 'Memuat piutang…';
    const orders = await owedQuery();
    if (getSession() !== session) return;
    const date = today();
    const age = order => {
      if (!order.delivered_at) return null;
      const timestamp = new Date(order.delivered_at);
      if (!Number.isFinite(timestamp.getTime())) return null;
      const days = (Date.parse(date) - Date.parse(deliveryDay.format(timestamp))) / 86400000;
      return days >= 0 ? days : null;
    };
    const sorted = orders.map(order => ({order,days:age(order)}))
      .sort((a,b) => (b.days ?? -1) - (a.days ?? -1));
    const customers = groupBy(sorted, ({order}) =>
      JSON.stringify([order.customer.trim().replace(/\s+/g,' ').toLocaleLowerCase('id'), (order.contact || '').replace(/\D/g,'')]));
    const summary = el('strong', money(orders.reduce((sum, order) => sum + balance(order), 0)) + ' total sisa tagihan');
    target.replaceChildren(block([summary], 'ops-filters'));
    if (!orders.length) target.append(el('p', 'Belum ada tagihan untuk pesanan yang sudah diantar.'));
    for (const invoices of customers.values()) {
      const customer = el('section', undefined, 'ops-card');
      const subtotal = invoices.reduce((sum, {order}) => sum + balance(order), 0);
      customer.append(el('h3', invoices[0].order.customer),
        el('p', invoices.length + ' invoice terbuka · Sisa ' + money(subtotal)));
      if (invoices.length > 1) {
        const all = invoices.map(x => x.order);
        const together = button('Bayar sekaligus', () => payTogetherDialog(all));
        together.classList.add('primary-action');
        customer.append(block([together, waAnchor(all[0].contact, remindAllMessage(all), 'Ingatkan semua (' + all.length + ')') || ''], 'ops-actions'));
      }
      for (const {order,days} of invoices) {
        const item = el('article', undefined, 'ops-card');
        item.append(el('strong', 'Invoice ' + invoiceNumber(order)),
          el('p', days === null ? 'Tanggal antar belum tercatat'
            : 'Diantar ' + dayLabel(deliveryDay.format(new Date(order.delivered_at))) + ' · ' + days + ' hari'),
          el('p', 'Total ' + money(total(order)) + ' · Dibayar ' + money(paid(order)) + ' · Sisa ' + money(balance(order))));
        orderButtons(order, item, 'receivables');
        customer.append(item);
      }
      target.append(customer);
    }
  }

  // kind 'packing': apa yang bisa dikemas (total per varian). kind 'delivery': siapa yang perlu diantar.
  async function packing(target, initialMode, kind = 'packing') {
    const modes = kind === 'packing'
      ? [['dueReady','Siap dikemas sekarang'],['ready','Siap dikemas per tanggal'],['packing','Semua per tanggal jadwal']]
      : [['due','Perlu diantar'],['unscheduled','Belum dijadwalkan'],['pending','Semua belum diantar'],['date','Per tanggal jadwal']];
    const valid = mode => modes.some(([id]) => id === mode) ? mode : null;
    const old = initialMode ? today() : target.querySelector('[name=pack_date]')?.value || today();
    const oldFilter = valid(initialMode) || valid(target.querySelector('[name=pack_filter]')?.value) || modes[0][0];
    const day = control('Tanggal jadwal antar', 'pack_date', {type:'date', value:old});
    const filter = control('Tampilkan', 'pack_filter', {value:oldFilter, values:modes});
    const output = el('div');
    target.replaceChildren(block([day,filter], 'ops-filters'), output);
    async function render() {
      const date = day.lastChild.value || today();
      const mode = filter.lastChild.value;
      output.textContent = 'Memuat pesanan…';
      // Semua pesanan belum diantar dimuat sekali, untuk membagi stok fisik secara adil.
      const open = await orderQuery('&delivered=eq.false');
      if ((day.lastChild.value || today()) !== date || filter.lastChild.value !== mode) return;
      const allocation = allocatePacking(open);
      const due = mode === 'due' || mode === 'dueReady';
      day.hidden = !['packing', 'ready', 'date'].includes(mode);
      const listed = due ? dueOrders(open, today())
        : mode === 'pending' ? open
        : mode === 'unscheduled' ? open.filter(order => !order.delivery_on)
        : open.filter(order => order.delivery_on === date);
      const orders = mode === 'ready' || mode === 'dueReady' ? listed.filter(order => packStatus(order, allocation).ready > 0) : listed;
      output.replaceChildren();
      const totals = new Map();
      const grouped = mode === 'packing' || mode === 'ready';
      const location = order => order.delivery_location?.trim() || 'Lokasi belum diisi';
      if (grouped) orders.sort((a, b) => location(a).localeCompare(location(b), 'id', {numeric:true}));
      let lastLocation;
      for (const order of orders) {
        if (grouped && location(order) !== lastLocation) {
          lastLocation = location(order);
          output.append(el('h3', lastLocation));
        }
        const card = el('article', undefined, 'ops-card');
        const pack = packStatus(order, allocation);
        card.append(el('strong', order.customer), el('p', pack.items.map(x => label(x.item) + ' × ' + x.need).join(', ')),
          el('p', (order.delivery_on ? 'Antar ' + dayLabel(order.delivery_on) : 'Jadwal belum diisi') + ' · ' + paymentLabel(order)));
        const details = [order.contact,order.delivery_location,order.delivery_note].filter(Boolean);
        if (details.length) card.append(el('p',details.join(' · ')));
        const short = pack.items.filter(x => x.ready < x.need).map(x => label(x.item) + ' kurang ' + (x.need - x.ready));
        const state = el('p', pack.ready === pack.need ? 'Siap dikemas'
          : pack.ready ? 'Siap sebagian · ' + pack.ready + ' dari ' + pack.need + ' pack · ' + short.join(', ')
            : 'Tertahan · stok fisik belum cukup · ' + short.join(', '), 'pack-state');
        state.dataset.state = pack.ready === pack.need ? 'ready' : pack.ready ? 'partial' : 'blocked';
        card.append(state);
        for (const x of pack.items) {
          if (!x.ready) continue;
          const name = label(x.item);
          totals.set(name, (totals.get(name) || 0) + x.ready);
        }
        orderButtons(order, card, 'packing');
        output.append(card);
      }
      if (kind === 'packing' && totals.size) output.prepend(table(['Varian / batch','Pack siap dikemas'],[...totals],''));
      if (!orders.length) output.append(el('p', 'Tidak ada pesanan untuk pilihan ini.'));
    }
    const reload = () => render().catch(() => { output.textContent = 'Daftar packing belum bisa dimuat.'; });
    day.lastChild.addEventListener('change', reload);
    filter.lastChild.addEventListener('change', reload);
    await reload();
  }

  async function purchases() {
    return list('pentol_purchases?select=*,pentol_purchase_items(*)', '&order=batch_code');
  }

  let knownPurchases = [];
  // Kode batch berikutnya: BATCH-NN tertinggi + 1.
  function nextBatchCode() {
    const numbers = [...knownPurchases.map(p => p.batch_code), ...getRows().map(r => r.batch_code)]
      .map(code => /^BATCH-(\d+)$/i.exec(code)?.[1]).filter(Boolean).map(Number);
    return 'BATCH-' + String((numbers.length ? Math.max(...numbers) : 0) + 1).padStart(2, '0');
  }
  // Harga beli terakhir per varian dari PO sebelumnya.
  function lastUnitCost(sku) {
    const sorted = [...knownPurchases].sort((a, b) => String(a.ordered_on || a.batch_code).localeCompare(String(b.ordered_on || b.batch_code)));
    for (let i = sorted.length - 1; i >= 0; i--) {
      const item = sorted[i].pentol_purchase_items.find(x => x.sku === sku);
      if (item?.unit_cost) return item.unit_cost;
    }
    return 0;
  }

  function purchaseDialog(purchase) {
    const p = purchase || {pentol_purchase_items:[]};
    const header = block([
      control('Kode batch','batch_code',{value:p.batch_code || nextBatchCode(),props:{maxLength:40,readOnly:Boolean(purchase)}}),
      control('Tanggal pesan','ordered_on',{type:'date',value:p.ordered_on || (purchase ? '' : today()),required:false}),
      control('Estimasi tiba','expected_on',{type:'date',value:p.expected_on,required:false})
    ]);
    // Varian dengan tombol − / +; harga beli terisi dari PO terakhir.
    const rows = [...products].map(([sku,name]) => {
      const item = p.pentol_purchase_items.find(x => x.sku === sku);
      const row = el('div', undefined, 'restock-row');
      const qty = el('input');
      Object.assign(qty, { type:'number', name:'qty_' + sku, min:0, max:1000000, inputMode:'numeric', value:item?.quantity || 0 });
      qty.setAttribute('aria-label', 'Jumlah ' + name);
      const cost = el('input');
      Object.assign(cost, { type:'number', name:'cost_' + sku, min:0, max:10000000, inputMode:'numeric', value:item?.unit_cost || lastUnitCost(sku) || 0 });
      cost.setAttribute('aria-label', 'Harga beli per pack ' + name);
      const sync = () => row.classList.toggle('selected', Number(qty.value) > 0);
      const step = delta => { qty.value = Math.max(0, Number(qty.value || 0) + delta); sync(); };
      const minus = button('−', () => step(-1));
      const plus = button('+', () => step(1));
      minus.setAttribute('aria-label', 'Kurangi ' + name);
      plus.setAttribute('aria-label', 'Tambah ' + name);
      qty.addEventListener('input', sync);
      const price = el('label', 'Harga beli/pack');
      price.append(cost);
      row.append(el('strong', name), block([minus, qty, plus], 'restock-stepper'), price);
      sync();
      return row;
    });
    const costs = el('details', undefined, 'restock-costs');
    costs.append(el('summary', 'Detail biaya & supplier (ongkir, styrofoam, lain-lain)'), block([
      control('Supplier','supplier',{value:p.supplier || knownPurchases.at?.(-1)?.supplier || 'Pentol Gilaaa Surabaya',props:{maxLength:120}}),
      control('Nomor tagihan / PO','reference',{value:p.reference,required:false,props:{maxLength:80}}),
      ...[['Ongkir (Rp)','shipping'],['Styrofoam (Rp)','packaging'],['Biaya batch lain (Rp)','other_cost']].map(([name,key]) =>
        control(name,key,{type:'number',value:p[key] ?? 0,props:{min:0,max:100000000}}))
    ]));
    showDialog(purchase ? 'Edit restok · ' + p.batch_code : 'Catat restok supplier', [header, el('h4', 'Varian yang dipesan'),
      block(rows, 'restock-list'), costs], async data => {
      const payload = Object.fromEntries(data);
      for (const key of ['ordered_on','expected_on']) payload[key] ||= null;
      payload.items = [...products.keys()].map(sku => ({sku,quantity:Number(data.get('qty_'+sku)),
        unit_cost:Number(data.get('cost_'+sku))})).filter(i => i.quantity);
      if (!payload.items.length) throw new Error('Pilih 1–9 varian restok.');
      await admin('purchase',payload);
      return async () => { await refresh('Restok tersimpan.'); open('purchasing'); };
    });
    // Isian wajib di "Detail biaya" yang tertutup: buka supaya galatnya terlihat.
    costs.addEventListener('invalid', () => { costs.open = true; }, true);
  }

  function receivePurchase(purchase, items) {
    const receiptId = crypto.randomUUID();
    const date = control('Tanggal diterima', 'received_on', {type:'date',value:today(),props:{max:today()}});
    const inputs = items.filter(item => item.remaining > 0).map(item => {
      const name = products.get(item.sku) || item.sku;
      return control(name + ' · sisa PO ' + item.remaining + ' pack', item.sku,
        {type:'number', value:item.remaining, props:{min:0,max:item.remaining,step:1}});
    });
    showDialog('Terima barang · ' + purchase.batch_code, [
      el('p', 'Terisi sisa PO. Kalau ada yang kurang atau belum datang, turunkan angkanya. Booking dan pengantaran tidak diubah.'),
      date, block(inputs)
    ], async data => {
      const receiptItems = items.map(item => ({sku:item.sku,quantity:Number(data.get(item.sku))}))
        .filter(item => item.quantity > 0);
      if (!receiptItems.length) throw new Error('Pilih jumlah barang yang benar-benar diterima.');
      await request(root + 'rpc/pentol_receive_purchase', {method:'POST',body:{
        receipt_id:receiptId,purchase_code:purchase.batch_code,arrival_date:data.get('received_on'),
        receipt_items:receiptItems
      }});
      return async () => {
        await refresh('Penerimaan tersimpan. Stok sudah diperbarui.');
        if (!$('purchasing').hidden) await open('purchasing');
      };
    });
  }

  async function purchasing(target) {
    const session = getSession();
    const [data, receipts] = await Promise.all([
      purchases(),
      list('pentol_purchase_receipts?select=id,batch_code,received_on,items', '&order=received_on.desc,created_at.desc,id')
        .catch(error => {
          if (error.status === 404) return null;
          throw error;
        }),
      loadRows()
    ]);
    if (getSession() !== session) return;
    knownPurchases = data;
    const add = button('+ Catat restok', () => purchaseDialog(null));
    add.classList.add('primary-action');
    target.replaceChildren(block([add], 'ops-actions'));
    const doneBox = el('details', undefined, 'po-done');
    const active = [];
    const done = [];
    if (!receipts) target.append(el('p', 'Terima Barang dari PO tersedia setelah migrasi penerimaan di Supabase dijalankan.'));
    for (const p of data) {
      const card = el('article', undefined, 'ops-card');
      const totalCost = p.shipping+p.packaging+p.other_cost
        + p.pentol_purchase_items.reduce((sum,i) => sum+i.quantity*i.unit_cost,0);
      const items = p.pentol_purchase_items.map(item => {
        const row = getRows().find(stock => stock.batch_code === p.batch_code && stock.sku === item.sku);
        const received = row?.received ?? 0;
        return {...item,received,remaining:Math.max(0, item.quantity-received),row};
      });
      const history = receipts?.filter(receipt => receipt.batch_code === p.batch_code) ?? [];
      const historyPanel = el('details');
      historyPanel.append(el('summary', 'Riwayat penerimaan (' + history.length + ')'));
      historyPanel.append(...history.map(receipt => el('p', dayLabel(receipt.received_on) + ' · ' + receipt.items
        .map(item => (products.get(item.sku) || item.sku) + ' × ' + item.quantity).join(', '))));
      if (!history.length) historyPanel.append(el('p', 'Belum ada penerimaan yang dicatat dari PO.'));
      const receive = button('Terima barang', () => receivePurchase(p, items));
      receive.disabled = !receipts || !items.some(item => item.remaining > 0);
      if (!receive.disabled) receive.classList.add('primary-action');
      card.append(el('strong', p.batch_code + ' · ' + p.supplier),
        el('p', [p.reference, p.ordered_on && 'Dipesan ' + dayLabel(p.ordered_on), p.expected_on && 'Estimasi tiba ' + dayLabel(p.expected_on)].filter(Boolean).join(' · ')),
        el('p','Total biaya batch: ' + money(totalCost)),
        table(['Varian','Dipesan ke supplier','Diterima','Sisa PO','Booking pelanggan','Siap jual'],
          items.map(item => [products.get(item.sku),item.quantity,item.received,item.remaining,
            item.row?.reserved ?? 0,item.row ? quantities(item.row)[3] : 0]), 'Belum ada varian.'),
        historyPanel,
        block([receive, button('Edit restok', () => purchaseDialog(p)),
          button('Salin pesan supplier', async () => {
            const lines = ['Halo Kak, mohon cek restok berikut untuk ' + p.batch_code + ':',
              ...p.pentol_purchase_items.map(i => products.get(i.sku) + ' × ' + i.quantity + ' pack'),
              'Mohon konfirmasi harga, ongkir, styrofoam, dan estimasi tiba. Terima kasih.'];
            try { await navigator.clipboard.writeText(lines.join('\n')); status('Pesan supplier disalin.'); }
            catch { status('Pesan supplier belum bisa disalin.',true); }
          })], 'ops-actions'));
      (items.some(item => item.remaining > 0) ? active : done).push([p, card]);
    }
    // Menunggu kiriman di atas (estimasi tiba terdekat dulu); PO selesai dilipat.
    active.sort(([a], [b]) => String(a.expected_on || '9999').localeCompare(String(b.expected_on || '9999')));
    if (active.length) target.append(el('h3', 'Menunggu kiriman (' + active.length + ')'), ...active.map(([, card]) => card));
    else target.append(el('p', 'Tidak ada PO yang menunggu kiriman.'));
    if (done.length) {
      doneBox.append(el('summary', 'PO selesai (' + done.length + ')'), ...done.reverse().map(([, card]) => card));
      target.append(doneBox);
    }
  }

  function costs(data) {
    const result = new Map();
    for (const p of data) {
      const count = p.pentol_purchase_items.reduce((sum,i) => sum+i.quantity,0);
      if (!count) continue;
      for (const i of p.pentol_purchase_items) {
        result.set(p.batch_code+'|'+i.sku,i.unit_cost+(p.shipping+p.packaging+p.other_cost)/count);
      }
    }
    return result;
  }

  async function finance(target) {
    const first = control('Dari','first',{type:'date',value:target.querySelector('[name=first]')?.value || today().slice(0,8)+'01'});
    const last = control('Sampai','last',{type:'date',value:target.querySelector('[name=last]')?.value || today()});
    const out = el('div');
    const priceList = el('details', undefined, 'report-details');
    priceList.append(el('summary', 'Harga jual default'));
    const backupCard = el('section', undefined, 'report-backup');
    const backupText = el('p', backupLabel());
    backupText.dataset.backupLast = '';
    backupCard.append(el('h3', 'Cadangan data'),
      el('p', 'Semua pesanan, pembayaran, stok, PO, dan riwayat dalam satu file Excel. Simpan di Google Drive.'), backupText,
      button('⬇ Unduh cadangan', event => downloadBackup(event.currentTarget)));
    const periods = el('div', undefined, 'period-chips');
    const periodRanges = () => {
      const t = today();
      const monthStart = t.slice(0, 8) + '01';
      const prevEnd = new Date(monthStart + 'T00:00:00Z');
      prevEnd.setUTCDate(0);
      const prevLast = prevEnd.toISOString().slice(0, 10);
      return [['Hari ini', t, t], ['Minggu ini', weekStart(t), t], ['Bulan ini', monthStart, t], ['Bulan lalu', prevLast.slice(0, 8) + '01', prevLast]];
    };
    function markPeriod() {
      const ranges = periodRanges();
      periods.querySelectorAll('button').forEach((chip, index) => {
        const [, a, b] = ranges[index];
        chip.setAttribute('aria-pressed', String(first.lastChild.value === a && last.lastChild.value === b));
      });
    }
    for (const [text] of periodRanges()) {
      periods.append(button(text, () => {
        const [, a, b] = periodRanges().find(([name]) => name === text);
        first.lastChild.value = a;
        last.lastChild.value = b;
        reload();
      }));
    }
    const filters = block([first,last], 'ops-filters');
    filters.prepend(periods);
    target.replaceChildren(filters, out, priceList, backupCard);
    priceList.append(
      ...[...products].map(([sku,name]) => block([
        el('span',name + ' · ' + money(prices[sku])),
        button('Ubah harga', () => showDialog('Harga jual · ' + name, [
          control('Harga per pack (Rp)','price',{type:'number',value:prices[sku],props:{min:0,max:10000000}})
        ], async data => {
          await admin('price',{sku,price:Number(data.get('price'))});
          return async () => { await loadPrices(); open('finance'); };
        }))
      ], 'ops-actions')));
    // Penjualan diantar per minggu (Senin–Minggu), 4 minggu terakhir, menurut tanggal pesanan.
    function weekStart(day) {
      const date = new Date(day + 'T00:00:00Z');
      date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
      return date.toISOString().slice(0, 10);
    }
    function weeklyChart(entries) {
      const starts = [];
      let cursor = weekStart(today());
      for (let i = 0; i < 4; i++) {
        starts.unshift(cursor);
        const d = new Date(cursor + 'T00:00:00Z');
        d.setUTCDate(d.getUTCDate() - 7);
        cursor = d.toISOString().slice(0, 10);
      }
      const sums = new Map(starts.map(start => [start, 0]));
      for (const entry of entries) {
        const key = weekStart(entry.date);
        if (sums.has(key)) sums.set(key, sums.get(key) + entry.amount);
      }
      const max = Math.max(1, ...sums.values());
      const chart = el('div', undefined, 'week-chart');
      chart.setAttribute('role', 'img');
      chart.setAttribute('aria-label', 'Penjualan diantar 4 minggu terakhir: ' + starts.map(start => money(sums.get(start))).join(', '));
      for (const start of starts) {
        const bar = el('div', undefined, 'week-bar');
        const fill = el('span');
        fill.style.height = Math.max(3, Math.round(sums.get(start) / max * 100)) + '%';
        if (start === starts[3]) bar.dataset.current = 'true';
        const d = new Date(start + 'T00:00:00Z');
        bar.append(el('small', sums.get(start) ? Math.round(sums.get(start) / 1000) + 'rb' : '0'), fill,
          el('small', start === starts[3] ? 'Minggu ini' : d.getUTCDate() + '/' + (d.getUTCMonth() + 1)));
        chart.append(bar);
      }
      return chart;
    }
    let generation = 0;
    async function render() {
      const current = ++generation;
      markPeriod();
      const a = first.lastChild.value;
      const b = last.lastChild.value;
      if (!a || !b || a>b) { out.textContent='Pilih rentang tanggal yang valid.'; return; }
      out.textContent='Memuat laporan…';
      const chartFrom = (() => { const d = new Date(weekStart(today()) + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - 21); return d.toISOString().slice(0, 10); })();
      // Dengan catatan pengiriman (operasional-2026-11.sql): penjualan & HPP menurut tanggal antar.
      // Tanpa itu: cara lama, menurut tanggal pesanan.
      const byShipDate = await hasOpsTools();
      const wib = day => day + 'T00:00:00%2B07:00';
      const nextDay = day => { const d = new Date(day + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };
      const doneIn = (from, to) => list('pentol_orders?select=id,shipping_charge,shipping_cost,delivered_at',
        '&cancelled=eq.false&delivered=eq.true&delivered_at=gte.' + wib(from) + '&delivered_at=lt.' + wib(nextDay(to)) + '&order=id');
      const shipsIn = (from, to) => list('pentol_shipments?select=order_id,stock_id,quantity,unit_price,shipped_on',
        '&shipped_on=gte.' + from + '&shipped_on=lte.' + to + '&order=id');
      const [data,orders,payments,recent,ships,done,recentShips,recentDone] = await Promise.all([
        purchases(),
        list('pentol_orders?select='+ordersSelect,'&cancelled=eq.false&order_date=gte.'+a+'&order_date=lte.'+b+'&order=order_date,id'),
        list('pentol_payments?select=id,amount','&paid_on=gte.'+a+'&paid_on=lte.'+b+'&order=paid_on,id'),
        byShipDate ? [] : list('pentol_orders?select='+ordersSelect,'&cancelled=eq.false&order_date=gte.'+chartFrom+'&order=order_date,id'),
        byShipDate ? shipsIn(a, b) : [],
        byShipDate ? doneIn(a, b) : [],
        byShipDate ? shipsIn(chartFrom, today()) : [],
        byShipDate ? doneIn(chartFrom, today()) : []
      ]);
      if (generation !== current) return;
      const hpp = costs(data);
      const cash = payments.reduce((sum, payment) => sum + payment.amount, 0);
      let unpaid=0, billed=0, revenue=0, cost=0, shipping=0, missing=0, unsold=0, stockUnknown=0;
      const byVariant = new Map();
      const addSold = (stockId, qty, price) => {
        const s = stock(stockId);
        const unit = s ? hpp.get(s.batch_code+'|'+s.sku) : undefined;
        revenue += qty*price;
        if (unit === undefined) missing += qty;
        else cost += qty*unit;
        const v = byVariant.get(s?.sku) || {qty:0, sales:0, cost:0, missing:0};
        v.qty += qty;
        v.sales += qty*price;
        if (unit === undefined) v.missing += qty; else v.cost += qty*unit;
        byVariant.set(s?.sku, v);
      };
      for (const o of orders) {
        billed += total(o);
        unpaid += balance(o);
        for (const i of o.pentol_order_items) {
          if (!byShipDate) addSold(i.stock_id, i.shipped, i.unit_price);
        }
        if (!byShipDate && o.delivered) { revenue += o.shipping_charge; shipping += o.shipping_cost; }
      }
      if (byShipDate) {
        for (const x of ships) addSold(x.stock_id, x.quantity, x.unit_price);
        for (const o of done) { revenue += Number(o.shipping_charge); shipping += Number(o.shipping_cost); }
      }
      const jakartaDay = new Intl.DateTimeFormat('sv-SE', {timeZone:'Asia/Jakarta'});
      const chartEntries = byShipDate
        ? [...recentShips.map(x => ({ date: x.shipped_on, amount: x.quantity * x.unit_price })),
           ...recentDone.map(o => ({ date: jakartaDay.format(new Date(o.delivered_at)), amount: Number(o.shipping_charge) }))]
        : recent.map(o => ({ date: o.order_date, amount: o.pentol_order_items.reduce((sum, i) => sum + i.shipped * i.unit_price, 0)
            + (o.delivered ? Number(o.shipping_charge) : 0) }));
      for (const s of getRows()) {
        const unit = hpp.get(s.batch_code+'|'+s.sku);
        if (unit === undefined) stockUnknown += quantities(s)[3];
        else unsold += quantities(s)[3]*unit;
      }
      const gross = revenue-cost;
      const net = gross-shipping;
      const range = a === b ? dayLabel(a) : dayLabel(a) + ' – ' + dayLabel(b);
      const headline = el('section', undefined, 'report-headline');
      const stat = (name, value, note, key) => {
        const box = el('div', undefined, 'report-stat');
        box.dataset.stat = key;
        box.append(el('span', name), el('strong', value), note ? el('small', note) : '');
        return box;
      };
      const grid = el('div', undefined, 'report-stats');
      grid.append(
        stat('Penjualan', money(revenue), 'barang yang sudah diantar', 'sales'),
        stat('Laba', missing ? 'Belum lengkap' : money(net),
          missing ? 'harga beli ' + missing + ' pack belum ada di restok' : (revenue ? 'margin ' + (net/revenue*100).toFixed(1) + '% · setelah ongkir' : 'setelah ongkir'), 'profit'),
        stat('Uang masuk', money(cash), 'pembayaran tercatat', 'cash'),
        stat('Belum dibayar', money(unpaid), 'dari pesanan periode ini', 'unpaid'));
      headline.append(el('p', range, 'report-label'), grid);
      const variantBox = el('section', undefined, 'report-variants');
      const variantRows = [...byVariant].filter(([, v]) => v.qty).sort((x, y) => (y[1].sales - y[1].cost) - (x[1].sales - x[1].cost));
      variantBox.append(el('h3', 'Laba per varian'), table(['Varian','Diantar','Penjualan','Laba'], variantRows.map(([sku, v]) => [
        products.get(sku) || 'Varian batch', v.qty + ' pack', money(v.sales), v.missing ? 'harga beli belum ada' : money(v.sales - v.cost)
      ]), 'Belum ada barang diantar pada periode ini.'));
      const chartBox = el('section', undefined, 'report-chart');
      chartBox.append(el('h3', 'Penjualan diantar per minggu' + (byShipDate ? '' : ' (menurut tanggal pesanan)')), weeklyChart(chartEntries));
      const detail = el('details', undefined, 'report-details');
      detail.append(el('summary', 'Rincian laporan'));
      out.replaceChildren(headline, variantBox, chartBox, detail);
      detail.append(table(['Metrik','Nilai'],[
        ['Tagihan pesanan',money(billed)],['Kas diterima (tanggal bayar tercatat)',money(cash)],
        ['Penjualan yang sudah diantar',money(revenue)],['HPP pack yang diantar',money(cost)],
        ['Laba bruto',missing ? 'HPP belum lengkap' : money(gross)],
        ['Laba setelah biaya antar',missing ? 'HPP belum lengkap' : money(net)],
        ['Margin setelah biaya antar',!missing && revenue ? (net/revenue*100).toFixed(1)+'%' : '—'],
        ['Nilai stok siap jual (saat ini)',money(unsold)+(stockUnknown ? ' · HPP '+stockUnknown+' pack belum ada' : '')],
        ['Belum dibayar dari pesanan periode ini',money(unpaid)],
      ],''), el('p',(byShipDate ? 'Tagihan mengikuti tanggal pesanan. Penjualan diantar, HPP, dan ongkir mengikuti tanggal antar.'
        : 'Tagihan dan penjualan diantar mengikuti tanggal pesanan.') + ' Kas mengikuti tanggal pembayaran tercatat; status lunas lama tanpa tanggal pembayaran tidak dihitung sebagai kas. HPP mengalokasikan biaya batch merata per pack yang dipesan dari supplier.'),
      table(['Batch','Varian','HPP / pack'],[...hpp].map(([key,value])=>{
        const [batch,sku]=key.split('|');
        return [batch,products.get(sku),money(value)];
      }),'Belum ada data HPP.'));
    }
    const reload = () => render().catch(() => { out.textContent='Laporan belum bisa dimuat.'; });
    first.lastChild.addEventListener('change',reload);
    last.lastChild.addEventListener('change',reload);
    await reload();
  }

  function promotions(target) {
    const sums = new Map();
    for (const row of getRows()) sums.set(row.sku,(sums.get(row.sku)||0)+quantities(row)[3]);
    const formatPicker=control('Format','promo_format',{value:'group',values:[
      ['group','Grup WhatsApp'],['story','Status WhatsApp'],['instagram','Instagram']
    ]});
    const options=[...products].map(([sku,name]) => {
      const wrap=control(name,sku,{type:'checkbox',required:false});
      wrap.lastChild.checked=(sums.get(sku)||0)>0;
      return wrap;
    });
    const preview=el('p',undefined,'ops-copy');
    const buttons=block([], 'ops-actions');
    let lines=[];
    function render() {
      const mode=formatPicker.lastChild.value;
      const selected=options.filter(o=>o.lastChild.checked).map(o=>o.lastChild.name);
      const items=(mode==='story'?selected.slice(0,3):selected).map(sku=>{
        const qty=sums.get(sku)||0;
        return products.get(sku)+' · '+sizes[sku]+' · '+money(prices[sku])+' · '+(qty ? 'sisa '+qty+' pack' : 'SOLD OUT');
      });
      lines=['PENTOL GILAAA SURABAYA','',...items,'','Pesan lewat WhatsApp 0898-1718-578'];
      preview.textContent=lines.join('\n');
    }
    buttons.append(button('Salin caption',async()=>{
      try { await navigator.clipboard.writeText(lines.join('\n')); status('Caption disalin.'); }
      catch { status('Pilih dan salin teks caption secara manual.',true); }
    }),button('Unduh PNG',()=>{
      const mode=formatPicker.lastChild.value;
      png(lines,'Pentol-Gilaaa-'+mode,1080,mode==='story'?1920:mode==='instagram'?1350:0);
    }));
    [formatPicker,...options].forEach(o=>o.lastChild.addEventListener('change',render));
    options.forEach(o=>o.className='promo-chip');
    target.replaceChildren(formatPicker,el('p','Pilih varian untuk brosur. Status WhatsApp memuat tiga pilihan pertama.'),
      block(options,'promo-chips'),preview,buttons);
    render();
  }

  const historyPath = 'pentol_reconciliation_history';
  async function history(target) {
    const session = getSession();
    target.textContent = 'Memuat riwayat…';
    let entries;
    try {
      entries = await request(root + historyPath + '?select=*&order=id.desc&limit=100');
    } catch (error) {
      if (error.status !== 404) throw error;
      if (getSession() === session) target.textContent = 'Riwayat tersedia setelah migrasi rekonsiliasi dijalankan di Supabase.';
      return;
    }
    if (getSession() !== session) return;
    const time = new Intl.DateTimeFormat('id-ID',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Jakarta'});
    const itemText = list => list.map(i => {
      const row = stock(i.stock_id);
      return (row ? products.get(row.sku) : 'Varian') + ' ' + i.pesan + (i.diantar ? ' (diantar ' + i.diantar + ')' : '');
    }).join(', ');
    const describe = value => {
      if (!value) return '—';
      if (Array.isArray(value)) return itemText(value);
      if ('items' in value) return itemText(value.items) + ' · total ' + money(value.total);
      if ('pembayaran_dibatalkan' in value) return 'Dibayar ' + money(value.dibayar) + ' · dibatalkan ' + money(value.pembayaran_dibatalkan);
      if ('pack_diantar' in value && !('antar_selesai' in value)) return value.pack_diantar + ' pack diantar';
      if ('dibayar' in value && !('sisa_tagihan' in value)) return 'Dibayar ' + money(value.dibayar);
      if ('booking' in value) return 'Booking ' + value.booking + ' pack · Sisa jual ' + value.sisa_jual + ' pack';
      if ('pack_diantar' in value) return value.pack_diantar + ' pack diantar · ' + (value.antar_selesai ? 'Selesai' : 'Belum selesai');
      return 'Dibayar ' + money(value.dibayar) + ' · Sisa ' + money(value.sisa_tagihan);
    };
    const actions = {stock:'Stok',ship:'Pengantaran',pay:'Pembayaran',void_pay:'Batal bayar',unship:'Koreksi antar',
      cancel_rest:'Batal sisa',edit:'Ubah pesanan'};
    target.replaceChildren(table(['Waktu WIB','Admin (ID)','Data','Sebelum','Sesudah','Alasan'],
      entries.map(row => [time.format(new Date(row.changed_at)),row.changed_by,
        (actions[row.action] || row.action) + ' · ' + row.label,describe(row.before_value),describe(row.after_value),row.reason]),
      'Belum ada koreksi yang tercatat.'));
  }

  function reconcile(target) {
    const file = el('input');
    file.type = 'file';
    file.accept = '.xlsx';
    const field = el('label', 'File pembukuan terbaru (.xlsx)');
    field.append(file);
    const result = el('div');
    const feedback = el('p');
    feedback.setAttribute('role', 'status');
    let generation = 0;
    let saving = false;

    async function compare(message = '') {
      const id = ++generation;
      const session = getSession();
      result.replaceChildren();
      feedback.textContent = 'Membandingkan Excel dan aplikasi…';
      try {
        const [targets, orders, historyAvailable] = await Promise.all([
          openReconciliation({ file:file.files[0], products }),
          orderQuery(''),
          request(root + historyPath + '?select=id&limit=1').then(() => true).catch(error => {
            if (error.status === 404) return false;
            throw error;
          })
        ]);
        await loadRows();
        if (id !== generation || getSession() !== session || !target.contains(file)) return;
        const {stockRows, orderRows, invoiceMatches} = reconciliationRows(targets, getRows(), orders, products, total, paid);
        excelInvoices = invoiceMatches;
        lastReconciliation = {
          at:new Date().toISOString(), filename:file.files[0].name,
          rows:[...stockRows,...orderRows].filter(row => !['Cocok','Data terkonfirmasi cocok'].includes(row.status))
            .map(({label, excel, app, status}) => ({label, excel, app, status}))
        };
        function section(title, rows) {
          return block([el('h3', title), table(['Data', 'Excel', 'Aplikasi', 'Hasil', 'Tindakan'],
            rows.map(({label, excel, app, status:detail, action}) => {
              const cell = el('span', '—');
              if (action) {
                cell.textContent = '';
                cell.append(button('Terapkan', () => {
                  if (saving || id !== generation) return;
                  const {live, type, amount} = action;
                  const nodes = [el('p', label), el('p', app + ' → ' + excel)];
                  if (type === 'ship') nodes.push(el('p', 'Aplikasi mencatat waktu penyimpanan sebagai waktu pengantaran.'));
                  if (type === 'pay') {
                    nodes.push(el('p', 'Catat penerimaan sebesar ' + money(amount) + '.'));
                    nodes.push(control('Tanggal pembayaran aktual', 'date', {type:'date',props:{max:today()}}));
                  }
                  if (historyAvailable) nodes.push(control('Alasan koreksi', 'reason', {props:{maxLength:500}}));
                  const paymentId = type === 'pay' ? crypto.randomUUID() : null;
                  showDialog(detail, nodes, async data => {
                    if (id !== generation || getSession() !== session) throw new Error('Pesanan berubah. Bandingkan lagi.');
                    saving = true;
                    try {
                      const payload = type === 'pay' ? {payment_id:paymentId,date:data.get('date'),amount}
                          : {items:live.pentol_order_items.filter(item => item.quantity > item.shipped)
                            .map(item => ({stock_id:item.stock_id,quantity:item.quantity-item.shipped}))};
                      if (historyAvailable) {
                        const reason = String(data.get('reason') ?? '').trim();
                        if (!reason) throw new Error('Alasan koreksi wajib diisi.');
                        await request(root + 'rpc/pentol_reconcile_with_history', {method:'POST',body:{
                          change_type:type,target:live.id,expected_revision:live.revision,payload,change_reason:reason
                        }});
                      } else {
                        await mutate(type, live.id, live.revision, payload);
                      }
                    } finally {
                      saving = false;
                    }
                    return () => compare('Koreksi tersimpan. ');
                  });
                }));
              }
              return [label, excel, app, detail, cell];
            }), 'Tidak ada baris pada bagian ini.')], 'reconcile-section');
        }
        result.replaceChildren(section('Stok per batch', stockRows), section('Pengantaran dan tagihan', orderRows));
        feedback.textContent = message + (historyAvailable ? '' : 'Riwayat koreksi belum aktif di Supabase. ') + file.files[0].name + ' · ' + (stockRows.length + orderRows.length) + ' baris dibandingkan.';
      } catch (error) {
        if (id === generation && target.contains(file)) feedback.textContent =
          message + 'Perbandingan gagal. ' + (error.status ? 'Coba muat ulang data admin.' : error.message);
      }
    }
    const check = button('Bandingkan', () => { if (file.files.length && !saving) compare(); });
    check.classList.add('primary-action');
    check.disabled = true;
    file.addEventListener('change', () => {
      generation++;
      result.replaceChildren();
      feedback.textContent = '';
      check.disabled = !file.files.length;
    });
    target.replaceChildren(block([field, check], 'ops-filters'),
      el('p', 'Gunakan tab Tutup Hari, Pesanan, Packing, dan Booking dan Invoice B2 dari pembukuan Pentol Gilaaa. File dibaca di browser. Periksa pratinjau sebelum menerapkan koreksi.'), feedback, result);
  }

  function closeDay(target) {
    const dateField = control('Tanggal', 'close_date', {type:'date',value:today(),props:{max:today()}});
    const dateInput = dateField.lastChild;
    const output = el('div', undefined, 'close-summary');
    const feedback = el('p');
    feedback.setAttribute('role', 'status');
    let preview;
    let generation = 0;
    const exportButton = button('⬇ Excel', async () => {
      const current = preview;
      const session = getSession();
      if (!current || !session) return;
      exportButton.disabled = true;
      try {
        const bytes = await closeDayWorkbook(current.sheets, window.JSZip);
        if (getSession() !== session || preview !== current || !target.contains(output)) return;
        const url = URL.createObjectURL(new Blob([bytes], {type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}));
        download(url, 'Rekap-Tutup-Hari-' + current.date + '.xlsx');
        setTimeout(() => URL.revokeObjectURL(url), 30_000);
        feedback.textContent = 'File Excel diunduh.';
      } catch {
        if (getSession() === session) feedback.textContent = 'File Excel belum bisa dibuat. Coba lagi.';
      } finally {
        if (preview === current) exportButton.disabled = false;
      }
    });
    exportButton.disabled = true;
    const waButton = el('a', 'Kirim ke WA', 'wa-link close-wa');
    waButton.target = '_blank';
    waButton.rel = 'noopener noreferrer';
    waButton.hidden = true;
    const nextDay = day => { const d = new Date(day + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };
    const jakartaDay = new Intl.DateTimeFormat('sv-SE', {timeZone:'Asia/Jakarta'});
    function section(title, lines, empty) {
      const box = el('section', undefined, 'close-section');
      box.append(el('h3', title));
      if (!lines.length) box.append(el('p', empty, 'close-empty'));
      else {
        const ul = el('ul');
        for (const [name, value] of lines) {
          const li = el('li');
          li.append(el('span', name), el('strong', value));
          ul.append(li);
        }
        box.append(ul);
      }
      return box;
    }
    async function load() {
      generation++;
      const id = generation;
      preview = null;
      exportButton.disabled = true;
      waButton.hidden = true;
      if (!dateInput.value || !dateInput.checkValidity()) { output.replaceChildren(); feedback.textContent = 'Pilih tanggal yang valid.'; return; }
      const date = dateInput.value;
      const session = getSession();
      feedback.textContent = 'Memuat rekap…';
      try {
        const byShipDate = await hasOpsTools();
        const [orders, ships] = await Promise.all([
          list('pentol_orders?select=' + ordersSelect, '&order=order_date,created_at,id'),
          byShipDate ? list('pentol_shipments?select=stock_id,quantity', '&shipped_on=eq.' + date + '&order=id') : [],
          loadRows()
        ]);
        if (getSession() !== session || id !== generation || !target.contains(output)) return;
        const {sheets} = closeDaySheets({
          date, exportedAt:new Date(), orders, stocks:getRows(), reconciliation:lastReconciliation,
          invoiceNumber, productName:sku=>products.get(sku) || sku, total, paid, deliveryLabel
        });
        preview = {date,sheets};
        const active = orders.filter(o => !o.cancelled);
        // Uang masuk pada tanggal itu.
        const cashLines = [];
        for (const o of active) for (const p of o.pentol_payments) {
          if (p.paid_on === date) cashLines.push([o.customer, Number(p.amount)]);
        }
        const cash = cashLines.reduce((sum, [, amount]) => sum + amount, 0);
        // Pack keluar per varian.
        const out = new Map();
        const addOut = (stockId, qty) => { const sku = stock(stockId)?.sku; out.set(sku, (out.get(sku) || 0) + qty); };
        if (byShipDate) ships.forEach(x => addOut(x.stock_id, x.quantity));
        else for (const o of active) {
          if (o.delivered_at && jakartaDay.format(new Date(o.delivered_at)) === date) o.pentol_order_items.forEach(i => addOut(i.stock_id, i.shipped));
        }
        const outLines = [...out].filter(([, qty]) => qty).sort((x, y) => y[1] - x[1]);
        const packs = outLines.reduce((sum, [, qty]) => sum + qty, 0);
        // Sisa stok siap jual (saat ini).
        const left = new Map([...products.keys()].map(sku => [sku, 0]));
        for (const row of getRows()) if (left.has(row.sku)) left.set(row.sku, left.get(row.sku) + quantities(row)[3]);
        // Belum dibayar per pelanggan.
        const owed = new Map();
        for (const o of active) { const due = balance(o); if (due > 0) owed.set(o.customer, (owed.get(o.customer) || 0) + due); }
        const owedLines = [...owed].sort((x, y) => y[1] - x[1]);
        const owedTotal = owedLines.reduce((sum, [, due]) => sum + due, 0);
        // Antar besok.
        const tomorrow = nextDay(date);
        const nextLines = active.filter(o => !o.delivered && o.delivery_on === tomorrow).map(o => [o.customer,
          o.pentol_order_items.reduce((sum, i) => sum + i.quantity - i.shipped, 0) + ' pack']);

        const stats = el('div', undefined, 'report-stats');
        const stat = (name, value, note) => {
          const box = el('div', undefined, 'report-stat');
          box.append(el('span', name), el('strong', value), note ? el('small', note) : '');
          return box;
        };
        stats.append(stat('Uang masuk', money(cash), cashLines.length + ' pembayaran'),
          stat('Pack keluar', packs + ' pack', 'diantar ' + dayLabel(date)),
          stat('Belum dibayar', money(owedTotal), owedLines.length + ' pelanggan · saat ini'),
          stat('Antar besok', nextLines.length + ' pesanan', dayLabel(tomorrow)));
        output.replaceChildren(stats,
          section('Uang masuk', cashLines.map(([n, a]) => [n, money(a)]), 'Tidak ada pembayaran tercatat.'),
          section('Pack keluar', outLines.map(([sku, q]) => [products.get(sku) || 'Varian batch', q + ' pack']), 'Tidak ada pengantaran.'),
          section('Sisa stok siap jual', [...[...left].filter(([, q]) => q).map(([sku, q]) => [products.get(sku), q + ' pack']),
            ...([...left].some(([, q]) => !q) ? [['Habis: ' + [...left].filter(([, q]) => !q).map(([sku]) => products.get(sku)).join(', '), '']] : [])], 'Belum ada stok.'),
          section('Belum dibayar', owedLines.map(([n, d]) => [n, money(d)]), 'Semua sudah lunas.'),
          section('Antar besok', nextLines, 'Belum ada jadwal antar besok.'));
        const message = ['*Rekap Pentol Gilaaa · ' + dayLabel(date) + '*', '',
          'Uang masuk: ' + money(cash), ...cashLines.map(([n, a]) => '- ' + n + ' ' + money(a)), '',
          'Pack keluar: ' + packs, ...outLines.map(([sku, q]) => '- ' + (products.get(sku) || 'Varian batch') + ' ' + q), '',
          'Sisa stok: ' + ([...left].filter(([, q]) => q).map(([sku, q]) => products.get(sku).replace(/^Pentol /, '') + ' ' + q).join(', ') || 'habis'), '',
          'Belum dibayar: ' + money(owedTotal) + ' (' + owedLines.length + ' pelanggan)', ...owedLines.map(([n, d]) => '- ' + n + ' ' + money(d)), '',
          'Antar besok: ' + nextLines.length + ' pesanan', ...nextLines.map(([n, q]) => '- ' + n + ' (' + q + ')')].join('\n');
        waButton.href = 'https://wa.me/?text=' + encodeURIComponent(message);
        waButton.hidden = false;
        feedback.textContent = '';
        exportButton.disabled = false;
      } catch {
        if (id === generation && getSession() === session) feedback.textContent = 'Rekap belum bisa dimuat. Coba lagi.';
      }
    }
    dateInput.addEventListener('change', load);
    const actions = el('div', undefined, 'close-actions');
    actions.append(waButton, exportButton);
    target.replaceChildren(block([dateField, actions], 'ops-filters'), feedback, output);
    return load();
  }

  const views={today:overview,packing:(t,m)=>packing(t,m,'packing'),delivery:(t,m)=>packing(t,m,'delivery'),purchasing,finance,promotions,reconcile,history,receivables,closeDay};
  async function open(view, packingMode) {
    if (!views[view]) return;
    const token=getSession();
    if (!token) return;
    const target=$(view+'-body');
    target.setAttribute('aria-busy', 'true');
    try { await views[view](target, packingMode); }
    catch { if (getSession()===token) target.textContent='Data belum bisa dimuat. Buka kembali menu untuk mencoba lagi.'; }
    finally {
      target.setAttribute('aria-busy', 'false');
      if (getSession()!==token) target.replaceChildren();
    }
  }
  function clear() {
    if (dialog.open) dialog.close();
    opsTools = null;
    $('opname-start').hidden = true;
    excelInvoices.clear();
    lastReconciliation = null;
    for (const view of Object.keys(views)) $(view+'-body').replaceChildren();
    $('inbox-list').replaceChildren();
    $('inbox-count').textContent='';
  }

  // ===== Operasional: koreksi transaksi & stok opname (aktif setelah operasional-2026-11.sql). =====
  let opsTools = null;
  // Cek sekali per sesi lewat tabel pentol_shipments (dibuat oleh migrasi yang sama): ada -> 200, belum -> 404.
  function hasOpsTools() {
    if (!opsTools) {
      const session = getSession();
      opsTools = request(root + 'pentol_shipments?select=id&limit=1')
        .then(() => true, error => error.status !== 404)
        .then(result => {
          if (getSession() !== session) opsTools = null;
          $('opname-start').hidden = !result;
          return result;
        });
    }
    return opsTools;
  }
  const correctionKnown = /^(Alasan koreksi|Pesanan sudah berubah|Pesanan aktif|Pembayaran tidak|Item pesanan|Jumlah koreksi|Belum ada yang diantar|Tidak ada sisa|Item .* pernah|Isi hitungan|Jumlah fisik|Baris stok|Stok berubah|Jumlah diterima)/;

  function correctionDialog(order) {
    const shippedItems = order.pentol_order_items.filter(i => i.shipped > 0);
    const kinds = [
      ...(order.pentol_payments.length ? [['void_pay', 'Batalkan pembayaran yang salah']] : []),
      ...(shippedItems.length ? [['unship', 'Kurangi jumlah yang tercatat diantar']] : []),
      ...(shippedItems.length && order.pentol_order_items.some(i => i.shipped < i.quantity) ? [['cancel_rest', 'Batalkan sisa pesanan yang belum diantar']] : [])
    ];
    if (!kinds.length) return status('Belum ada pembayaran atau pengantaran yang bisa dikoreksi.', true);
    const kind = control('Jenis koreksi', 'kind', { value: kinds[0][0], values: kinds });
    const payment = control('Pembayaran', 'payment_id', { required:false, value: order.pentol_payments[0]?.id,
      values: order.pentol_payments.map(p => [p.id, p.paid_on + ' · ' + money(p.amount)]) });
    const item = control('Varian / batch', 'stock_id', { required:false, value: shippedItems[0]?.stock_id,
      values: shippedItems.map(i => [i.stock_id, label(i) + ' · diantar ' + i.shipped]) });
    const qty = control('Kurangi berapa pack', 'quantity', { type:'number', required:false, value:1, props:{ min:1 } });
    const rest = el('p', 'Sisa yang belum diantar dihapus dari pesanan dan booking stoknya dilepas. Bagian yang sudah diantar tetap ditagih.');
    const reason = control('Alasan koreksi', 'reason', { props:{ maxLength:500, placeholder:'Contoh: salah ketik nominal' } });
    const sync = () => {
      const k = kind.lastChild.value;
      payment.hidden = k !== 'void_pay';
      item.hidden = qty.hidden = k !== 'unship';
      rest.hidden = k !== 'cancel_rest';
      const chosen = shippedItems.find(i => i.stock_id === item.lastChild.value);
      qty.lastChild.max = chosen ? chosen.shipped : 1;
    };
    kind.lastChild.addEventListener('change', sync);
    item.lastChild.addEventListener('change', sync);
    showDialog('Koreksi · ' + order.customer + ' · Invoice ' + invoiceNumber(order),
      [el('p', 'Setiap koreksi tercatat di Riwayat Perubahan beserta alasannya.'), kind, payment, item, qty, rest, reason], async data => {
        const k = data.get('kind');
        const payload = k === 'void_pay' ? { payment_id: data.get('payment_id') }
          : k === 'unship' ? { stock_id: data.get('stock_id'), quantity: Number(data.get('quantity')) } : {};
        try {
          await request(root + 'rpc/pentol_correct_order', { method:'POST', body:{ change_type:k, target:order.id,
            expected_revision:order.revision, payload, change_reason:String(data.get('reason') || '').trim() } });
        } catch (error) {
          throw new Error(correctionKnown.test(error.message) ? error.message : 'Koreksi belum terkonfirmasi. Muat ulang daftar lalu coba lagi.');
        }
        return async () => {
          await refresh('Koreksi tersimpan dan tercatat di Riwayat Perubahan.');
          for (const view of ['packing', 'delivery', 'receivables', 'finance']) if (!$(view).hidden) await open(view);
        };
      });
    sync();
  }

  const opnameKey = 'pentol-opname-at';
  function opnameAge() {
    try { const last = localStorage.getItem(opnameKey); return last ? daysBetween(last, today()) : null; } catch { return null; }
  }
  function opnameDialog() {
    const rows = getRows().filter(row => row.received || row.reserved || row.delivered)
      .sort((a, b) => a.sku.localeCompare(b.sku) || a.batch_code.localeCompare(b.batch_code));
    if (!rows.length) return status('Belum ada stok batch untuk dihitung.', true);
    const fields = rows.map(row => {
      const onHand = row.received - row.delivered;
      const field = control(products.get(row.sku) + ' · ' + row.batch_code + ' · tercatat ' + onHand, 'count_' + row.id,
        { type:'number', value:onHand, props:{ min:0, max:1000000, inputMode:'numeric' } });
      field.className = 'opname-row';
      field.lastChild.addEventListener('input', () => { field.dataset.diff = String(Number(field.lastChild.value) !== onHand); });
      return field;
    });
    const day = today();
    const reason = control('Keterangan', 'reason', { value:'Opname ' + day.slice(8) + '/' + day.slice(5, 7), props:{ maxLength:500 } });
    showDialog('Hitung stok (opname)', [el('p', 'Isi jumlah pack yang benar-benar ada di freezer (belum diantar). '
      + 'Baris yang angkanya berubah dicatat sebagai koreksi dengan keterangan di bawah.'), block(fields, 'opname-list'), reason], async data => {
      const counts = rows.map(row => ({ stock_id: row.id, expected_revision: row.revision, physical: Number(data.get('count_' + row.id)) }));
      let changed;
      try {
        changed = await request(root + 'rpc/pentol_stock_opname', { method:'POST', body:{ counts, change_reason:String(data.get('reason') || '').trim() } });
      } catch (error) {
        throw new Error(correctionKnown.test(error.message) ? error.message : 'Hitung stok belum tersimpan. Muat ulang daftar stok lalu coba lagi.');
      }
      try { localStorage.setItem(opnameKey, today()); } catch {}
      return async () => {
        await loadRows();
        status(changed ? changed + ' baris stok dikoreksi sesuai hitungan fisik.' : 'Hitungan cocok dengan aplikasi. Tidak ada koreksi.');
        document.querySelectorAll('.opname-reminder').forEach(node => node.remove());
      };
    });
  }
  $('opname-start').addEventListener('click', () => { if (getSession()) opnameDialog(); });

  // ===== Cadangan data: semua tabel ke satu file Excel, diunduh di perangkat ini. =====
  const backupKey = 'pentol-backup-at';
  const backupTables = [
    ['Pesanan', 'pentol_orders', 'id'], ['Item pesanan', 'pentol_order_items', 'order_id,stock_id'],
    ['Pembayaran', 'pentol_payments', 'id'], ['Stok batch', 'pentol_batch_stock', 'id'],
    ['PO', 'pentol_purchases', 'batch_code'], ['Item PO', 'pentol_purchase_items', 'batch_code,sku'],
    ['Penerimaan PO', 'pentol_purchase_receipts', 'id'], ['Permintaan katalog', 'pentol_inbox', 'id'],
    ['Harga', 'pentol_products', 'sku'], ['Riwayat koreksi', 'pentol_reconciliation_history', 'id']
  ];
  function lastBackup() {
    try { return localStorage.getItem(backupKey) || ''; } catch { return ''; }
  }
  function backupAge() {
    const last = lastBackup();
    return last ? daysBetween(last, today()) : null;
  }
  async function downloadBackup(trigger) {
    const session = getSession();
    if (!session) return;
    if (trigger) trigger.disabled = true;
    status('Menyiapkan cadangan…');
    try {
      const info = [['Cadangan Pentol Gilaaa', ''], ['Tanggal (WIB)', today()], ['Waktu ekspor (UTC)', new Date().toISOString()], ['', ''], ['Lembar', 'Isi']];
      const sheets = [];
      for (const [name, table, order] of backupTables) {
        let rows;
        try { rows = await list(table + '?select=*', '&order=' + order); }
        catch (error) {
          if (error.status === 404) { info.push([name, 'belum aktif di database']); continue; }
          throw error;
        }
        const keys = [...new Set(rows.flatMap(row => Object.keys(row)))];
        sheets.push([name, [keys, ...rows.map(row => keys.map(key => row[key] == null ? ''
          : typeof row[key] === 'object' ? JSON.stringify(row[key]) : row[key]))]]);
        info.push([name, rows.length + ' baris']);
      }
      if (getSession() !== session) return;
      const bytes = await closeDayWorkbook([['Info', info], ...sheets], window.JSZip);
      const url = URL.createObjectURL(new Blob([bytes], {type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}));
      download(url, 'Cadangan-Pentol-Gilaaa-' + today() + '.xlsx');
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      try { localStorage.setItem(backupKey, today()); } catch {}
      status('Cadangan diunduh. Simpan file ini di Google Drive atau tempat aman lain.');
      document.querySelectorAll('.backup-reminder').forEach(node => node.remove());
      document.querySelectorAll('[data-backup-last]').forEach(node => { node.textContent = backupLabel(); });
    } catch {
      status('Cadangan belum bisa dibuat. Periksa koneksi lalu coba lagi.', true);
    } finally {
      if (trigger) trigger.disabled = false;
    }
  }
  function backupLabel() {
    const age = backupAge();
    return age === null ? 'Belum pernah mengunduh cadangan di perangkat ini.'
      : age === 0 ? 'Cadangan terakhir: hari ini.' : 'Cadangan terakhir: ' + age + ' hari lalu.';
  }

  // Angka kecil untuk navigasi: permintaan katalog baru dan antaran yang lewat jadwal.
  async function badgeCounts() {
    const [requests, late] = await Promise.all([
      list('pentol_inbox?select=id', '&status=eq.pending&order=id'),
      list('pentol_orders?select=id', '&cancelled=eq.false&delivered=eq.false&delivery_on=lt.' + today() + '&order=id')
    ]);
    return { requests: requests.length, late: late.length };
  }

  return { badgeCounts, invoiceNumber, dayLabel, nextBatchCode, total, paymentLabel, deliveryLabel, orderButtons, mutate, errorMessage, loadPrices, inbox, open, clear };
}

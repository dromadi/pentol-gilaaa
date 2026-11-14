import { closeDaySheets, closeDayWorkbook } from './close-day.js?v=1';
import { invoiceContent, invoicePdf } from './invoice.js?v=1';
import { openReconciliation, reconciliationRows } from './reconcile.js?v=4';

export function initOperations({ $, request, status, products, prices, today, format,
  tableRow, emptyRow, quantities, getRows, getSession, openOrder, refresh, selectView, loadRows }) {
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
    const known = /^(Booking lama |Pesanan |Isi 1|Periksa varian|Gabungkan varian|Varian batch |Pilih jumlah|Jumlah |Stok fisik|Nominal |Pilih 1|Varian tidak|PO tidak |Penerimaan |Nomor invoice |Alasan koreksi |Stok berubah )/;
    return known.test(error.message) ? error.message : 'Perubahan belum terkonfirmasi. Muat ulang daftar sebelum mencoba lagi.';
  }

  function mutate(action, target, version, payload) {
    return request(root + 'rpc/pentol_order_action', {method:'POST', body:{action,target,version:version ?? null,payload}});
  }

  function admin(action, payload) {
    return request(root + 'rpc/pentol_admin_action', {method:'POST', body:{action,payload}});
  }

  function showDialog(title, nodes, onSubmit) {
    if (dialog.open) return;
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

  function orderDialog(action, order, title, nodes, payload) {
    showDialog(title, nodes, async data => {
      await mutate(action, order.id, order.revision, payload(data));
      const mapped = excelInvoices.get(order.id);
      if (mapped?.revision === order.revision && ['pay', 'ship', 'schedule'].includes(action)) mapped.revision++;
      return async () => {
        await refresh('Pesanan diperbarui.');
        if (!$('packing').hidden) open('packing');
        if (!$('finance').hidden) open('finance');
        if (!$('receivables').hidden) await open('receivables');
      };
    });
  }

  function orderButtons(order, target) {
    if (order.cancelled) { target.textContent = '—'; return; }
    const actions = el('div', undefined, 'ops-actions');
    actions.append(button('Invoice', () => showInvoice(order)));
    if (!order.paid && balance(order)) {
      actions.append(button('Catat bayar', () => {
        const paymentId = crypto.randomUUID();
        orderDialog('pay', order, 'Catat pembayaran · ' + order.customer, [block([
          control('Tanggal bayar', 'date', {type:'date', value:today()}),
          control('Nominal diterima (Rp)', 'amount', {type:'number', value:balance(order), props:{min:1,max:balance(order)}})
        ]), ...order.pentol_payments.map(p => el('p', p.paid_on + ' · ' + money(p.amount)))],
        data => ({payment_id:paymentId,date:data.get('date'),amount:Number(data.get('amount'))}));
      }));
    }
    if (!order.delivered) {
      actions.append(button('Jadwal antar', () => orderDialog('schedule', order, 'Jadwal antar · ' + order.customer,
        [control('Tanggal antar', 'date', {type:'date', value:order.delivery_on || today(), required:false})],
        data => ({delivery_on:data.get('date') || null}))));
      const pending = order.pentol_order_items.filter(i => i.shipped < i.quantity);
      actions.append(button('Catat pengantaran', () => orderDialog('ship', order, 'Jumlah yang sudah diantar · ' + order.customer,
        [block(pending.map(i => control(label(i), i.stock_id,
          {type:'number',value:i.quantity-i.shipped,props:{min:0,max:i.quantity-i.shipped}})))],
        data => ({items:pending.map(i => ({stock_id:i.stock_id,quantity:Number(data.get(i.stock_id))})).filter(i => i.quantity)}))));
    }
    if (!order.paid && !paid(order) && !order.pentol_order_items.some(i => i.shipped)) {
      actions.append(button('Edit', () => {
        $('admin-menu').querySelector('[data-view=orders]').click();
        openOrder(order);
      }));
      actions.append(button('Batalkan', () => orderDialog('cancel', order, 'Batalkan pesanan · ' + order.customer,
        [el('p', 'Stok yang dipesan akan dilepas. Riwayat pesanan tetap tampil dengan status Batal.')], () => ({}))));
    }
    if (target.tagName === 'TD') {
      const menu = el('details', undefined, 'action-menu');
      const summary = el('summary', 'Kelola');
      summary.setAttribute('aria-label', 'Kelola pesanan ' + order.customer);
      menu.append(summary, actions);
      target.append(menu);
    } else target.append(actions);
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
        if (Object.hasOwn(fresh, 'excel_invoice_no')) {
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

  async function loadPrices() {
    const data = await request(root + 'pentol_products?select=sku,price');
    for (const row of data) prices[row.sku] = row.price;
  }

  async function inbox() {
    const session = getSession();
    const target = $('inbox-list');
    try {
      const entries = await list('pentol_inbox?select=*', '&status=eq.pending&order=created_at.desc,id');
      if (!session || getSession() !== session) return;
      $('inbox-count').textContent = '(' + entries.length + ')';
      target.replaceChildren(...entries.map(entry => {
        const card = el('article', undefined, 'ops-card');
        card.append(el('strong', entry.customer),
          el('p', 'Kode permintaan: ' + entry.id),
          el('p', [entry.phone,entry.area,entry.note].filter(Boolean).join(' · ')),
          el('p', entry.items.map(i => products.get(i.sku) + ' × ' + i.quantity).join(', ')),
          block([button('Proses pesanan', () => openOrder(null, entry)), button('Arsipkan', () => {
            showDialog('Arsipkan permintaan · ' + entry.customer, [el('p', 'Permintaan ini akan keluar dari daftar masuk.')],
              async () => { await admin('dismiss',{id:entry.id}); return inbox; });
          })], 'ops-actions'));
        return card;
      }));
      if (!entries.length) target.append(el('p', 'Belum ada permintaan baru.'));
    } catch {
      if (session && getSession() === session) target.replaceChildren(el('p', 'Daftar permintaan belum bisa dimuat.'));
    }
  }

  function packingReady(item) {
    const row = stock(item.stock_id);
    return row && row.received - row.delivered >= row.reserved;
  }

  const canPack = order => order.pentol_order_items.some(item =>
    item.shipped < item.quantity && packingReady(item));

  // Belum lunas setelah ada barang yang diantar, termasuk antar sebagian.
  const unpaidFilter = '&paid=eq.false';
  const isOwed = order => balance(order) > 0 && order.pentol_order_items.some(item => item.shipped > 0);
  const owedQuery = async () => (await orderQuery(unpaidFilter)).filter(isOwed);
  const daysBetween = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / 86400000);
  const scheduledFilter = date => '&delivered=eq.false&delivery_on=eq.' + date;
  const orderQuery = filters => list('pentol_orders?select=' + ordersSelect,
    '&cancelled=eq.false&order=order_date,created_at,id' + filters);

  async function overview(target) {
    const session = getSession();
    const date = today();
    target.textContent = 'Memuat ringkasan…';
    const [entries, pending, unpaid] = await Promise.all([
      list('pentol_inbox?select=id,customer,created_at', '&status=eq.pending&order=created_at.desc,id'),
      orderQuery('&delivered=eq.false'),
      owedQuery()
    ]);
    if (getSession() !== session) return;
    // Perlu diantar: terlambat dulu, lalu jadwal hari ini, lalu yang belum dijadwalkan.
    // Jadwal setelah hari ini tidak ditampilkan di sini.
    const rank = order => !order.delivery_on ? 2 : order.delivery_on < date ? 0 : 1;
    const deliveries = pending.filter(order => !order.delivery_on || order.delivery_on <= date)
      .sort((a, b) => rank(a) - rank(b) || (a.delivery_on || '').localeCompare(b.delivery_on || ''));
    const late = deliveries.filter(order => rank(order) === 0).length;
    const unscheduled = deliveries.filter(order => rank(order) === 2).length;
    const ready = deliveries.filter(canPack);
    const location = order => order.delivery_location || 'Lokasi belum diisi';
    const when = order => !order.delivery_on ? 'belum dijadwalkan'
      : order.delivery_on < date ? 'terlambat ' + daysBetween(order.delivery_on, date) + ' hari' : 'hari ini';
    const sections = [
      ['Permintaan baru', entries, 'permintaan', entry => entry.customer, 'Buka permintaan', () => {
        selectView('orders');
        const inbox = $('checkout-inbox');
        inbox.open = true;
        inbox.querySelector('summary').focus();
      }],
      ['Bisa dikemas', ready, 'pesanan', order => order.customer + ' · ' + location(order) + ' · ' + when(order),
        'Buka daftar packing', () => selectView('packing', 'pending'),
        'stok siap dari ' + deliveries.length + ' yang perlu diantar'],
      ['Perlu diantar', deliveries, 'pesanan', order => order.customer + ' · ' + when(order),
        'Buka daftar antar', () => selectView('packing', 'pending'),
        [late && late + ' terlambat', unscheduled && unscheduled + ' belum dijadwalkan'].filter(Boolean).join(' · ')],
      ['Diantar, belum lunas', unpaid, 'pesanan', order => order.customer + ' · ' + money(balance(order))
        + (order.delivered ? '' : ' · antar sebagian'),
        'Buka tagihan', () => selectView('receivables'),
        unpaid.length ? 'Total sisa tagihan ' + money(unpaid.reduce((sum, order) => sum + balance(order), 0)) : '']
    ];
    $('today-date').dateTime = date;
    $('today-date').textContent = new Intl.DateTimeFormat('id-ID', {weekday:'long', day:'numeric', month:'long', timeZone:'UTC'})
      .format(new Date(date + 'T00:00:00Z'));
    target.replaceChildren(block(sections.map(([title, records, unit, describe, action, navigate, note], index) => {
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
      if (records.length && records !== ready) {
        const preview = el('ul');
        preview.append(...records.slice(0, 3).map(record => el('li', describe(record))));
        if (records.length > 3) preview.append(el('li', '+' + (records.length - 3) + ' lainnya', 'today-more'));
        card.append(preview);
      }
      const go = button(action + ' →', navigate);
      card.append(go);
      return card;
    }), 'today-grid'));
  }

  const deliveryDay = new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Jakarta',year:'numeric',month:'2-digit',day:'2-digit'});

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
    const customers = Map.groupBy(sorted, ({order}) =>
      JSON.stringify([order.customer.trim().replace(/\s+/g,' ').toLocaleLowerCase('id'), (order.contact || '').replace(/\D/g,'')]));
    const summary = el('strong', money(orders.reduce((sum, order) => sum + balance(order), 0)) + ' total sisa tagihan');
    const reload = button('Muat ulang piutang', () => open('receivables'));
    target.replaceChildren(block([summary, reload], 'ops-filters'));
    if (!orders.length) target.append(el('p', 'Belum ada tagihan untuk pesanan yang sudah diantar.'));
    for (const invoices of customers.values()) {
      const customer = el('section', undefined, 'ops-card');
      const subtotal = invoices.reduce((sum, {order}) => sum + balance(order), 0);
      customer.append(el('h3', invoices[0].order.customer),
        el('p', invoices.length + ' invoice terbuka · Sisa ' + money(subtotal)));
      for (const {order,days} of invoices) {
        const item = el('article', undefined, 'ops-card');
        item.append(el('strong', 'Invoice ' + invoiceNumber(order)),
          el('p', days === null ? 'Tanggal antar belum tercatat'
            : 'Antar tercatat ' + deliveryDay.format(new Date(order.delivered_at)) + ' · ' + days + ' hari'),
          el('p', 'Total ' + money(total(order)) + ' · Dibayar ' + money(paid(order)) + ' · Sisa ' + money(balance(order))));
        orderButtons(order, item);
        customer.append(item);
      }
      target.append(customer);
    }
  }

  async function packing(target, initialMode) {
    const old = initialMode ? today() : target.querySelector('[name=pack_date]')?.value || today();
    const oldFilter = initialMode || target.querySelector('[name=pack_filter]')?.value || 'packing';
    const day = control('Tanggal jadwal antar', 'pack_date', {type:'date', value:old});
    const filter = control('Tampilkan', 'pack_filter', {value:oldFilter, values:[
      ['packing','Sesuai tanggal jadwal'],['ready','Siap dikemas sesuai tanggal'],['unscheduled','Belum dijadwalkan'],['pending','Semua belum diantar'],['unpaid','Diantar, belum lunas']
    ]});
    const output = el('div');
    target.replaceChildren(block([day,filter], 'ops-filters'), output);
    async function render() {
      const date = day.lastChild.value || today();
      const mode = filter.lastChild.value;
      output.textContent = 'Memuat pesanan…';
      const listed = mode === 'unpaid' ? await owedQuery() : await orderQuery(mode === 'pending' ? '&delivered=eq.false'
            : mode === 'unscheduled' ? '&delivered=eq.false&delivery_on=is.null'
            : scheduledFilter(date));
      if ((day.lastChild.value || today()) !== date || filter.lastChild.value !== mode) return;
      const orders = mode === 'ready' ? listed.filter(canPack) : listed;
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
        const items = order.pentol_order_items.filter(i => mode === 'unpaid' || i.shipped < i.quantity);
        card.append(el('strong', order.customer), el('p', items.map(i =>
          label(i) + ' × ' + (mode === 'unpaid' ? i.quantity : i.quantity-i.shipped)).join(', ')),
          el('p', (order.delivery_on || 'Jadwal belum diisi') + ' · ' + paymentLabel(order)));
        const details = [order.contact,order.delivery_location,order.delivery_note].filter(Boolean);
        if (details.length) card.append(el('p',details.join(' · ')));
        const readyItems = items.filter(packingReady);
        if (mode !== 'unpaid') {
          card.append(el('p', readyItems.length === items.length ? 'Siap dikemas'
            : (readyItems.length ? 'Siap sebagian' : 'Tertahan')
              + ' · Cek alokasi batch: ' + items.filter(item => !readyItems.includes(item)).map(label).join(', ')));
        }
        for (const item of readyItems) {
          if (mode === 'unpaid') continue;
          const name = label(item);
          totals.set(name,(totals.get(name) || 0) + item.quantity-item.shipped);
        }
        orderButtons(order, card);
        output.append(card);
      }
      if (totals.size) output.prepend(table(['Varian / batch','Pack dikemas'],[...totals],''));
      if (mode === 'unpaid') output.prepend(el('p', 'Sisa tagihan: ' + money(orders.reduce((sum,o) => sum+balance(o),0))));
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

  function purchaseDialog(purchase) {
    const p = purchase || {pentol_purchase_items:[]};
    const header = block([
      control('Kode batch','batch_code',{value:p.batch_code,props:{maxLength:40,readOnly:Boolean(purchase)}}),
      control('Supplier','supplier',{value:p.supplier || 'Pentol Gilaaa Surabaya',props:{maxLength:120}}),
      control('Nomor tagihan / PO','reference',{value:p.reference,required:false,props:{maxLength:80}}),
      control('Tanggal pesan','ordered_on',{type:'date',value:p.ordered_on,required:false}),
      control('Estimasi tiba','expected_on',{type:'date',value:p.expected_on,required:false}),
      ...[['Ongkir (Rp)','shipping'],['Styrofoam (Rp)','packaging'],['Biaya batch lain (Rp)','other_cost']].map(([name,key]) =>
        control(name,key,{type:'number',value:p[key] ?? 0,props:{min:0,max:100000000}}))
    ]);
    const details = [...products].map(([sku,name]) => {
      const item = p.pentol_purchase_items.find(x => x.sku === sku);
      return block([
        control(name + ' (pack)', 'qty_' + sku, {type:'number',value:item?.quantity || 0,props:{min:0,max:1000000}}),
        control('Harga beli / pack (Rp)', 'cost_' + sku, {type:'number',value:item?.unit_cost || 0,props:{min:0,max:10000000}})
      ]);
    });
    showDialog(purchase ? 'Edit restok' : 'Catat restok supplier', [header,...details], async data => {
      const payload = Object.fromEntries(data);
      for (const key of ['ordered_on','expected_on']) payload[key] ||= null;
      payload.items = [...products.keys()].map(sku => ({sku,quantity:Number(data.get('qty_'+sku)),
        unit_cost:Number(data.get('cost_'+sku))})).filter(i => i.quantity);
      await admin('purchase',payload);
      return async () => { await refresh('Restok tersimpan.'); open('purchasing'); };
    });
  }

  function receivePurchase(purchase, items) {
    const receiptId = crypto.randomUUID();
    const date = control('Tanggal diterima', 'received_on', {type:'date',value:today(),props:{max:today()}});
    const inputs = items.filter(item => item.remaining > 0).map(item => {
      const name = products.get(item.sku) || item.sku;
      return control(name + ' · sisa ' + item.remaining + ' pack', item.sku,
        {type:'number', value:0, props:{min:0,max:item.remaining,step:1}});
    });
    showDialog('Terima barang · ' + purchase.batch_code, [
      el('p', 'Isi jumlah fisik yang diterima kali ini. Jumlah booking dan pengantaran tidak diubah.'),
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
    target.replaceChildren(button('+ Catat restok', () => purchaseDialog(null)));
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
      historyPanel.append(...history.map(receipt => el('p', receipt.received_on + ' · ' + receipt.items
        .map(item => (products.get(item.sku) || item.sku) + ' × ' + item.quantity).join(', '))));
      if (!history.length) historyPanel.append(el('p', 'Belum ada penerimaan yang dicatat dari PO.'));
      const receive = button('Terima barang', () => receivePurchase(p, items));
      receive.disabled = !receipts || !items.some(item => item.remaining > 0);
      card.append(el('strong', p.batch_code + ' · ' + p.supplier),
        el('p', [p.reference,p.ordered_on,p.expected_on && 'Estimasi tiba ' + p.expected_on].filter(Boolean).join(' · ')),
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
          }),
          button('Lihat stok batch', () => {
            $('admin-menu').querySelector('[data-view=stock]').click();
            $('stock-batch').value = p.batch_code;
            $('stock-batch').dispatchEvent(new Event('change'));
          })], 'ops-actions'));
      target.append(card);
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
    target.replaceChildren(block([first,last], 'ops-filters'), out,
      el('h3','Harga jual default'),
      ...[...products].map(([sku,name]) => block([
        el('span',name + ' · ' + money(prices[sku])),
        button('Ubah harga', () => showDialog('Harga jual · ' + name, [
          control('Harga per pack (Rp)','price',{type:'number',value:prices[sku],props:{min:0,max:10000000}})
        ], async data => {
          await admin('price',{sku,price:Number(data.get('price'))});
          return async () => { await loadPrices(); open('finance'); };
        }))
      ], 'ops-actions')));
    let generation = 0;
    async function render() {
      const current = ++generation;
      const a = first.lastChild.value;
      const b = last.lastChild.value;
      if (!a || !b || a>b) { out.textContent='Pilih rentang tanggal yang valid.'; return; }
      out.textContent='Memuat laporan…';
      const [data,orders,payments] = await Promise.all([
        purchases(),
        list('pentol_orders?select='+ordersSelect,'&cancelled=eq.false&order_date=gte.'+a+'&order_date=lte.'+b+'&order=order_date,id'),
        list('pentol_payments?select=id,amount','&paid_on=gte.'+a+'&paid_on=lte.'+b+'&order=paid_on,id')
      ]);
      if (generation !== current) return;
      const hpp = costs(data);
      const cash = payments.reduce((sum, payment) => sum + payment.amount, 0);
      let billed=0, revenue=0, cost=0, shipping=0, missing=0, unsold=0, stockUnknown=0;
      const byProduct = new Map();
      for (const o of orders) {
        billed += total(o);
        if (o.delivered) { revenue += o.shipping_charge; shipping += o.shipping_cost; }
        for (const i of o.pentol_order_items) {
          const s = stock(i.stock_id);
          const sku = s?.sku;
          const unit = s ? hpp.get(s.batch_code+'|'+sku) : undefined;
          revenue += i.shipped*i.unit_price;
          if (unit === undefined) missing += i.shipped;
          else cost += i.shipped*unit;
          const metrics = byProduct.get(sku) || [0,0];
          metrics[0] += i.quantity;
          metrics[1] += i.shipped;
          byProduct.set(sku,metrics);
        }
      }
      for (const s of getRows()) {
        const unit = hpp.get(s.batch_code+'|'+s.sku);
        if (unit === undefined) stockUnknown += quantities(s)[3];
        else unsold += quantities(s)[3]*unit;
      }
      const gross = revenue-cost;
      const net = gross-shipping;
      out.replaceChildren(table(['Metrik','Nilai'],[
        ['Tagihan pesanan',money(billed)],['Kas diterima (tanggal bayar tercatat)',money(cash)],
        ['Penjualan yang sudah diantar',money(revenue)],['HPP pack yang diantar',money(cost)],
        ['Laba bruto',missing ? 'HPP belum lengkap' : money(gross)],
        ['Laba setelah biaya antar',missing ? 'HPP belum lengkap' : money(net)],
        ['Margin setelah biaya antar',!missing && revenue ? (net/revenue*100).toFixed(1)+'%' : '—'],
        ['Nilai stok siap jual (saat ini)',money(unsold)+(stockUnknown ? ' · HPP '+stockUnknown+' pack belum ada' : '')]
      ],''), el('p','Tagihan dan penjualan diantar mengikuti tanggal pesanan. Kas mengikuti tanggal pembayaran tercatat; status lunas lama tanpa tanggal pembayaran tidak dihitung sebagai kas. HPP mengalokasikan biaya batch merata per pack yang dipesan dari supplier.'),
      table(['Varian','Terpesan','Diantar'],[...byProduct].sort((a,b)=>b[1][0]-a[1][0])
        .map(([sku,x])=>[products.get(sku)||'Varian batch',...x]),'Belum ada penjualan.'),
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
      wrap.lastChild.checked=true;
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
    options.forEach(o=>o.className='order-paid');
    target.replaceChildren(formatPicker,el('p','Pilih varian untuk brosur. Status WhatsApp memuat tiga pilihan pertama.'),
      block(options),preview,buttons);
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
    const describe = value => {
      if ('booking' in value) return 'Booking ' + value.booking + ' pack · Sisa jual ' + value.sisa_jual + ' pack';
      if ('pack_diantar' in value) return value.pack_diantar + ' pack diantar · ' + (value.antar_selesai ? 'Selesai' : 'Belum selesai');
      return 'Dibayar ' + money(value.dibayar) + ' · Sisa ' + money(value.sisa_tagihan);
    };
    const actions = {stock:'Stok',ship:'Pengantaran',pay:'Pembayaran'};
    target.replaceChildren(table(['Waktu WIB','Admin (ID)','Data','Sebelum','Sesudah','Alasan'],
      entries.map(row => [time.format(new Date(row.changed_at)),row.changed_by,
        actions[row.action] + ' · ' + row.label,describe(row.before_value),describe(row.after_value),row.reason]),
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
                  const {live, type, amount, reserved} = action;
                  const nodes = [el('p', label), el('p', app + ' → ' + excel)];
                  if (type === 'stock') nodes.push(el('p', 'Booking: ' + live.reserved + ' → ' + reserved
                    + ' pack. Terapkan hanya jika booking ini belum tercatat dalam pesanan aplikasi.'));
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
                      const payload = type === 'stock' ? {reserved}
                        : type === 'pay' ? {payment_id:paymentId,date:data.get('date'),amount}
                          : {items:live.pentol_order_items.filter(item => item.quantity > item.shipped)
                            .map(item => ({stock_id:item.stock_id,quantity:item.quantity-item.shipped}))};
                      if (historyAvailable) {
                        const reason = String(data.get('reason') ?? '').trim();
                        if (!reason) throw new Error('Alasan koreksi wajib diisi.');
                        await request(root + 'rpc/pentol_reconcile_with_history', {method:'POST',body:{
                          change_type:type,target:live.id,expected_revision:live.revision,payload,change_reason:reason
                        }});
                      } else if (type === 'stock') {
                        const updated = await request(root + 'pentol_batch_stock?id=eq.' + encodeURIComponent(live.id)
                          + '&revision=eq.' + live.revision, { method:'PATCH',
                          body:{reserved, revision:live.revision + 1}, prefer:'return=representation' });
                        if (updated?.length !== 1) throw new Error('Jumlah stok berubah. Bandingkan lagi.');
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
    const dateField = control('Tanggal laporan', 'close_date', {type:'date',value:today(),props:{max:today()}});
    const dateInput = dateField.lastChild;
    const output = el('div');
    const feedback = el('p');
    feedback.setAttribute('role', 'status');
    let preview;
    let generation = 0;
    const exportButton = button('Unduh Excel', async () => {
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
        feedback.textContent = 'File Excel siap digunakan untuk serah-terima ke Chat 01.';
      } catch {
        if (getSession() === session) feedback.textContent = 'File Excel belum bisa dibuat. Coba lagi.';
      } finally {
        if (preview === current) exportButton.disabled = false;
      }
    });
    exportButton.disabled = true;
    function clearPreview() {
      generation++;
      preview = null;
      exportButton.disabled = true;
      output.replaceChildren();
      feedback.textContent = '';
    }
    dateInput.addEventListener('change', clearPreview);
    const previewButton = button('Lihat pratinjau', async () => {
      if (!dateInput.reportValidity()) return;
      clearPreview();
      const id = generation;
      const date = dateInput.value;
      const session = getSession();
      feedback.textContent = 'Memuat rekap…';
      try {
        const [orders] = await Promise.all([
          list('pentol_orders?select=' + ordersSelect, '&order=order_date,created_at,id'),
          loadRows()
        ]);
        if (getSession() !== session || id !== generation || !target.contains(output)) return;
        const {summary,sheets} = closeDaySheets({
          date, exportedAt:new Date(), orders, stocks:getRows(), reconciliation:lastReconciliation,
          invoiceNumber, productName:sku=>products.get(sku) || sku, total, paid, deliveryLabel
        });
        preview = {date,sheets};
        output.replaceChildren(table(['Ringkasan','Nilai'],[
          ['Pesanan dibuat atau selesai diantar',summary.orders],
          ['Kas masuk pada tanggal pilihan',money(summary.cash)],
          ['Sisa tagihan saat pratinjau',money(summary.due)],
          ['Baris stok saat pratinjau',summary.stocks],
          ['Selisih pada perbandingan Excel terakhir',summary.differences ?? 'Belum dibandingkan di sesi ini']
        ],''));
        feedback.textContent = '';
        exportButton.disabled = false;
      } catch {
        if (id === generation && getSession() === session) feedback.textContent = 'Rekap belum bisa dimuat. Coba lagi.';
      }
    });
    target.replaceChildren(block([dateField,previewButton,exportButton], 'ops-filters'), feedback, output);
  }

  const views={today:overview,packing,purchasing,finance,promotions,reconcile,history,receivables,closeDay};
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
    excelInvoices.clear();
    lastReconciliation = null;
    for (const view of Object.keys(views)) $(view+'-body').replaceChildren();
    $('inbox-list').replaceChildren();
    $('inbox-count').textContent='';
  }

  return { total, paymentLabel, deliveryLabel, orderButtons, mutate, errorMessage, loadPrices, inbox, open, clear };
}

import { q, nextNumber } from '../db.mjs';
import { audit } from '../audit.mjs';
import { bad, conflict, notFound, parseDate, toFen, toQty, toRate } from '../util.mjs';
import { assertCan, can } from '../auth.mjs';

export const PURCHASE_STATUS = {
  draft: 'Черновик',
  pending_approval: 'На согласовании',
  approved: 'Утверждена',
  ordered: 'Заказана',
  partially_paid: 'Частично оплачена',
  paid: 'Оплачена',
  partially_received: 'Частично получена',
  received: 'Получена',
  cancelled: 'Отменена',
};

const TRANSITIONS = {
  draft: ['pending_approval', 'cancelled'],
  pending_approval: ['approved', 'draft', 'cancelled'],
  approved: ['ordered', 'cancelled'],
  ordered: ['partially_paid', 'paid', 'partially_received', 'received', 'cancelled'],
  partially_paid: ['paid', 'partially_received', 'received', 'cancelled'],
  paid: ['partially_received', 'received', 'cancelled'],
  partially_received: ['received'],
  received: [],
  cancelled: [],
};

function lineValueKop(priceFen, qty, rateX10000) {
  return Math.round((priceFen * qty * rateX10000) / 10000);
}

function assertPurchaseAccess(user) {
  assertCan(user, 'purchase.view');
}

export function purchaseRow(id) {
  return q.get(
    `SELECT po.*, s.name AS supplier_name, u.full_name AS author_name
     FROM purchase_orders po
     JOIN suppliers s ON s.id = po.supplier_id
     JOIN users u ON u.id = po.author_id
     WHERE po.id = ?`, id,
  );
}

export function purchaseItems(id) {
  const rows = q.all(
    `SELECT poi.*, v.size, v.color, v.style_name, v.product_id, p.sku, p.name AS product_name
     FROM purchase_order_items poi
     JOIN product_variants v ON v.id = poi.variant_id
     JOIN products p ON p.id = v.product_id
     WHERE poi.purchase_id = ?
     ORDER BY poi.line_no, poi.id`, id,
  );
  const received = q.all(
    `SELECT ri.po_item_id, SUM(ri.qty_received) AS qty_received, SUM(ri.qty_damaged) AS qty_damaged
     FROM receipt_items ri
     JOIN receipts r ON r.id = ri.receipt_id
     WHERE r.purchase_id = ? AND r.status = 'posted'
     GROUP BY ri.po_item_id`, id,
  );
  const receivedMap = new Map(received.map((r) => [r.po_item_id, r]));
  return rows.map((row) => {
    const rec = receivedMap.get(row.id) || { qty_received: 0, qty_damaged: 0 };
    const shortage = Math.max(row.qty - Number(rec.qty_received), 0);
    const surplus = Math.max(Number(rec.qty_received) - row.qty, 0);
    return {
      id: row.id,
      variantId: row.variant_id,
      sku: row.sku,
      productName: row.product_name,
      size: row.size,
      color: row.color,
      styleName: row.style_name,
      qty: row.qty,
      priceCnyFen: row.price_cny_fen,
      valueKop: lineValueKop(row.price_cny_fen, row.qty, 0),
      receivedQty: Number(rec.qty_received),
      damagedQty: Number(rec.qty_damaged),
      shortage,
      surplus,
      inTransit: Math.max(row.qty - Number(rec.qty_received), 0),
    };
  });
}

export function purchaseTotals(po, items) {
  const cnyFen = items.reduce((acc, i) => acc + i.priceCnyFen * i.qty, 0);
  const goodsKop = items.reduce((acc, i) => acc + lineValueKop(i.priceCnyFen, i.qty, po.rate_cny_rub_x10000), 0);
  const receivedValueKop = items.reduce(
    (acc, i) => acc + lineValueKop(i.priceCnyFen, i.receivedQty, po.rate_cny_rub_x10000), 0,
  );
  const payments = q.get('SELECT COALESCE(SUM(amount_kop), 0) AS s, COUNT(*) AS c FROM payments WHERE purchase_id = ?', po.id);
  const expenses = q.get('SELECT COALESCE(SUM(amount_kop), 0) AS s FROM expenses WHERE purchase_id = ? AND is_capitalized = 1', po.id);
  const receivedQty = items.reduce((acc, i) => acc + i.receivedQty, 0);
  const orderedQty = items.reduce((acc, i) => acc + i.qty, 0);
  return {
    cnyFen,
    goodsKop,
    receivedValueKop,
    expensesKop: Number(expenses.s),
    paidKop: Number(payments.s),
    paymentsCount: payments.c,
    orderedQty,
    receivedQty,
    inTransitQty: Math.max(orderedQty - receivedQty, 0),
    unitCostKop: receivedQty > 0 ? Math.round((receivedValueKop + Number(expenses.s)) / receivedQty) : 0,
  };
}

export function listPurchases(user, params = {}) {
  assertPurchaseAccess(user);
  const where = ['1 = 1'];
  const args = [];
  if (params.status) { where.push('po.status = ?'); args.push(params.status); }
  if (params.supplierId) { where.push('po.supplier_id = ?'); args.push(Number(params.supplierId)); }
  if (params.from) { where.push('po.created_at >= ?'); args.push(parseDate(params.from)); }
  if (params.to) { where.push('po.created_at <= ?'); args.push(parseDate(params.to)); }
  if (params.search) {
    where.push('(po.number LIKE ? OR s.name LIKE ?)');
    args.push(`%${params.search}%`, `%${params.search}%`);
  }
  const orders = q.all(
    `SELECT po.*, s.name AS supplier_name, u.full_name AS author_name
     FROM purchase_orders po
     JOIN suppliers s ON s.id = po.supplier_id
     JOIN users u ON u.id = po.author_id
     WHERE ${where.join(' AND ')}
     ORDER BY po.created_at DESC LIMIT 300`, ...args,
  );
  return orders.map((po) => {
    const items = purchaseItems(po.id);
    const totals = purchaseTotals(po, items);
    return {
      id: po.id,
      number: po.number,
      supplierName: po.supplier_name,
      status: po.status,
      statusLabel: PURCHASE_STATUS[po.status],
      currency: po.currency,
      rateX10000: po.rate_cny_rub_x10000,
      createdAt: po.created_at,
      authorName: po.author_name,
      itemsCount: items.length,
      orderedQty: totals.orderedQty,
      receivedQty: totals.receivedQty,
      inTransitQty: totals.inTransitQty,
      cnyFen: totals.cnyFen,
      goodsKop: totals.goodsKop,
      paidKop: totals.paidKop,
      expensesKop: totals.expensesKop,
      comment: po.comment,
    };
  });
}

export function getPurchase(user, id) {
  assertPurchaseAccess(user);
  const po = purchaseRow(id);
  if (!po) throw notFound('Закупка не найдена');
  const items = purchaseItems(id);
  const totals = purchaseTotals(po, items);

  const payments = q.all(
    `SELECT p.*, u.full_name AS author_name FROM payments p JOIN users u ON u.id = p.author_id
     WHERE p.purchase_id = ? ORDER BY p.paid_at DESC`, id,
  ).map((p) => ({
    id: p.id,
    currency: p.currency,
    amountMinor: p.amount_minor,
    rateX10000: p.rate_x10000,
    amountKop: p.amount_kop,
    paidAt: p.paid_at,
    comment: p.comment,
    authorName: p.author_name,
  }));

  const receipts = q.all(
    `SELECT r.*, u.full_name AS author_name FROM receipts r JOIN users u ON u.id = r.author_id
     WHERE r.purchase_id = ? ORDER BY r.created_at`, id,
  ).map((r) => {
    const lines = q.all('SELECT COUNT(*) AS c, COALESCE(SUM(qty_received), 0) AS q FROM receipt_items WHERE receipt_id = ?', r.id);
    return {
      id: r.id,
      number: r.number,
      receiptDate: r.receipt_date,
      status: r.status,
      authorName: r.author_name,
      postedAt: r.posted_at,
      linesCount: lines[0].c,
      qty: lines[0].q,
    };
  });

  const expenses = q.all(
    `SELECT e.*, u.full_name AS author_name FROM expenses e JOIN users u ON u.id = e.author_id
     WHERE e.purchase_id = ? ORDER BY e.created_at`, id,
  ).map((e) => ({
    id: e.id,
    category: e.category,
    amountKop: e.amount_kop,
    currency: e.currency,
    amountMinor: e.amount_minor,
    rateX10000: e.rate_x10000,
    method: e.method,
    comment: e.comment,
    receiptId: e.receipt_id,
    isCapitalized: !!e.is_capitalized,
    appliedAt: e.applied_at,
    createdAt: e.created_at,
    authorName: e.author_name,
  }));

  const history = q.all(
    `SELECT a.*, u.full_name AS user_name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
     WHERE (a.entity = 'purchase' AND a.entity_id = ?) OR (a.entity = 'purchase_number' AND a.entity_id = ?)
     ORDER BY a.at DESC LIMIT 100`, id, id,
  ).map((a) => ({ id: a.id, at: a.at, action: a.action, login: a.user_name || a.login, details: a.details ? JSON.parse(a.details) : null }));

  return {
    id: po.id,
    number: po.number,
    supplierId: po.supplier_id,
    supplierName: po.supplier_name,
    currency: po.currency,
    rateX10000: po.rate_cny_rub_x10000,
    rateDate: po.rate_date,
    rateSource: po.rate_source,
    status: po.status,
    statusLabel: PURCHASE_STATUS[po.status],
    authorId: po.author_id,
    authorName: po.author_name,
    createdAt: po.created_at,
    updatedAt: po.updated_at,
    approvedAt: po.approved_at,
    cancelledAt: po.cancelled_at,
    cancelReason: po.cancel_reason,
    comment: po.comment,
    items,
    totals,
    payments,
    receipts,
    expenses,
    history,
    canApprove: can(user, 'purchase.approve'),
    canEdit: po.status === 'draft' && (po.author_id === user.id || user.role === 'owner'),
  };
}

function validateItems(items) {
  if (!Array.isArray(items) || items.length === 0) throw bad('В закупке должна быть хотя бы одна позиция');
  const seen = new Set();
  return items.map((item, index) => {
    const variantId = Number(item.variantId);
    if (!variantId) throw bad(`Позиция ${index + 1}: не указан вариант товара`);
    const variant = q.get('SELECT v.*, p.name AS product_name FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.id = ?', variantId);
    if (!variant) throw bad(`Позиция ${index + 1}: вариант товара не найден`);
    if (seen.has(variantId)) throw bad(`Позиция ${index + 1}: вариант указан дважды`);
    seen.add(variantId);
    const qty = toQty(item.qty, 'количество');
    const priceFen = toFen(item.priceCny ?? item.price_cny ?? item.priceCnyFen / 100, 'цена в юанях');
    return { variantId, qty, priceFen, lineNo: index + 1 };
  });
}

export function createPurchase(user, data) {
  assertCan(user, 'purchase.create');
  const supplierId = Number(data.supplierId);
  if (!supplierId) throw bad('Не указан поставщик');
  if (!q.get('SELECT id FROM suppliers WHERE id = ?', supplierId)) throw bad('Поставщик не найден');
  const rate = toRate(data.rate ?? data.rateCnyRub, 'курс CNY/RUB');
  const items = validateItems(data.items);
  const now = new Date().toISOString();
  const number = nextNumber('PO', 'purchase');
  const info = q.run(
    `INSERT INTO purchase_orders (number, supplier_id, currency, rate_cny_rub_x10000, rate_date, rate_source,
       status, author_id, comment, created_at, updated_at)
     VALUES (?, ?, 'CNY', ?, ?, ?, 'draft', ?, ?, ?, ?)`,
    number, supplierId, rate, parseDate(data.rateDate), data.rateSource || null, user.id,
    data.comment || null, now, now,
  );
  const purchaseId = Number(info.lastInsertRowid);
  for (const item of items) {
    q.run(
      'INSERT INTO purchase_order_items (purchase_id, variant_id, qty, price_cny_fen, line_no) VALUES (?, ?, ?, ?, ?)',
      purchaseId, item.variantId, item.qty, item.priceFen, item.lineNo,
    );
  }
  audit(user, 'purchase.create', 'purchase', purchaseId, { number, supplierId, rate, items: items.length });
  audit(user, 'purchase_number', 'purchase_number', purchaseId, { number });
  return getPurchase(user, purchaseId);
}

export function updatePurchase(user, id, data) {
  assertCan(user, 'purchase.edit');
  const po = purchaseRow(id);
  if (!po) throw notFound('Закупка не найдена');
  if (po.status !== 'draft') throw conflict('Редактировать можно только черновик закупки');
  if (po.author_id !== user.id && user.role !== 'owner') throw conflict('Редактировать можно только собственную закупку');

  const supplierId = data.supplierId !== undefined ? Number(data.supplierId) : po.supplier_id;
  if (!q.get('SELECT id FROM suppliers WHERE id = ?', supplierId)) throw bad('Поставщик не найден');
  const rate = data.rate !== undefined || data.rateCnyRub !== undefined
    ? toRate(data.rate ?? data.rateCnyRub, 'курс CNY/RUB')
    : po.rate_cny_rub_x10000;
  q.run(
    `UPDATE purchase_orders SET supplier_id = ?, rate_cny_rub_x10000 = ?, rate_date = ?, rate_source = ?, comment = ?, updated_at = ? WHERE id = ?`,
    supplierId, rate,
    data.rateDate !== undefined ? parseDate(data.rateDate) : po.rate_date,
    data.rateSource !== undefined ? data.rateSource : po.rate_source,
    data.comment !== undefined ? data.comment : po.comment,
    new Date().toISOString(), id,
  );
  if (data.items !== undefined) {
    const items = validateItems(data.items);
    q.run('DELETE FROM purchase_order_items WHERE purchase_id = ?', id);
    for (const item of items) {
      q.run(
        'INSERT INTO purchase_order_items (purchase_id, variant_id, qty, price_cny_fen, line_no) VALUES (?, ?, ?, ?, ?)',
        id, item.variantId, item.qty, item.priceFen, item.lineNo,
      );
    }
  }
  audit(user, 'purchase.update', 'purchase', id, { supplierId, rate });
  return getPurchase(user, id);
}

export function setPurchaseStatus(user, id, status, comment) {
  const po = purchaseRow(id);
  if (!po) throw notFound('Закупка не найдена');
  if (!PURCHASE_STATUS[status]) throw bad('Неизвестный статус закупки');
  if (status === 'approved') assertCan(user, 'purchase.approve', 'Утверждать закупки может только владелец');
  else assertCan(user, 'purchase.status');

  const current = po.status;
  if (current === status) return getPurchase(user, id);
  const allowed = TRANSITIONS[current] || [];
  if (!allowed.includes(status)) {
    throw conflict(`Переход из статуса «${PURCHASE_STATUS[current]}» в «${PURCHASE_STATUS[status]}» недопустим`);
  }
  if (status === 'cancelled') {
    const posted = q.get("SELECT COUNT(*) AS c FROM receipts WHERE purchase_id = ? AND status = 'posted'", id);
    if (posted.c > 0) throw conflict('Закупка с проведёнными приёмками не отменяется. Оформите возврат поставщику или корректировку.');
  }
  if (status === 'received') {
    const items = purchaseItems(id);
    if (items.some((i) => i.inTransit > 0)) throw conflict('Не все позиции получены: статус «Получена» недоступен');
  }
  if (current === 'draft' && status === 'pending_approval' && !q.get('SELECT COUNT(*) AS c FROM purchase_order_items WHERE purchase_id = ?', id).c) {
    throw conflict('Нельзя отправить на согласование пустую закупку');
  }

  const now = new Date().toISOString();
  if (status === 'approved') {
    q.run('UPDATE purchase_orders SET status = ?, approved_by = ?, approved_at = ?, updated_at = ? WHERE id = ?', status, user.id, now, now, id);
  } else if (status === 'cancelled') {
    q.run('UPDATE purchase_orders SET status = ?, cancelled_at = ?, cancel_reason = ?, updated_at = ? WHERE id = ?', status, now, comment || null, now, id);
  } else {
    q.run('UPDATE purchase_orders SET status = ?, updated_at = ? WHERE id = ?', status, now, id);
  }
  audit(user, 'purchase.status', 'purchase', id, { from: current, to: status, comment: comment || null });
  return getPurchase(user, id);
}

export function addPayment(user, id, data) {
  assertCan(user, 'purchase.payments');
  const po = purchaseRow(id);
  if (!po) throw notFound('Закупка не найдена');
  if (po.status === 'cancelled') throw conflict('Нельзя оплатить отменённую закупку');
  const currency = String(data.currency || 'CNY').toUpperCase();
  if (!['CNY', 'RUB'].includes(currency)) throw bad('Валюта платежа: CNY или RUB');
  const amountMinor = toFen(data.amount, 'сумма платежа');
  if (amountMinor <= 0) throw bad('Сумма платежа должна быть больше нуля');
  const rate = currency === 'CNY' ? toRate(data.rate ?? po.rate_cny_rub_x10000 / 10000, 'курс платежа') : 10000;
  const amountKop = currency === 'CNY' ? Math.round((amountMinor * rate) / 10000) : amountMinor;
  const paidAt = parseDate(data.paidAt);
  q.run(
    `INSERT INTO payments (purchase_id, currency, amount_minor, rate_x10000, amount_kop, paid_at, comment, author_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, currency, amountMinor, rate, amountKop, paidAt, data.comment || null, user.id, new Date().toISOString(),
  );
  audit(user, 'purchase.payment', 'purchase', id, { currency, amountMinor, rate, amountKop });

  if (['ordered', 'partially_paid', 'paid'].includes(po.status)) {
    const items = purchaseItems(id);
    const totals = purchaseTotals(po, items);
    const newStatus = totals.paidKop >= totals.goodsKop ? 'paid' : 'partially_paid';
    if (newStatus !== po.status && TRANSITIONS[po.status]?.includes(newStatus)) {
      q.run('UPDATE purchase_orders SET status = ?, updated_at = ? WHERE id = ?', newStatus, new Date().toISOString(), id);
      audit(user, 'purchase.status', 'purchase', id, { from: po.status, to: newStatus, auto: 'payment' });
    }
  }
  return getPurchase(user, id);
}

export function assertPurchaseExists(id) {
  const po = purchaseRow(id);
  if (!po) throw notFound('Закупка не найдена');
  return po;
}

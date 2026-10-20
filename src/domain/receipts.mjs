import { q, nextNumber } from '../db.mjs';
import { audit } from '../audit.mjs';
import { bad, conflict, notFound, parseDate } from '../util.mjs';
import { assertCan, can } from '../auth.mjs';
import { postMovement } from './stock.mjs';
import { planExpenseAllocationsForReceipt, expenseAllocationsForReceipt, listExpenses, EXPENSE_CATEGORIES } from './expenses.mjs';

const RECEIVABLE_STATUSES = ['ordered', 'partially_paid', 'paid', 'partially_received'];

function receiptRow(id) {
  return q.get(
    `SELECT r.*, po.number AS purchase_number, po.status AS purchase_status, po.rate_cny_rub_x10000 IS NOT NULL AS has_rate,
            s.name AS supplier_name, u.full_name AS author_name
     FROM receipts r
     JOIN purchase_orders po ON po.id = r.purchase_id
     JOIN suppliers s ON s.id = po.supplier_id
     JOIN users u ON u.id = r.author_id
     WHERE r.id = ?`, id,
  );
}

function receiptItemRows(receiptId) {
  return q.all(
    `SELECT ri.*, poi.id AS po_item_id, poi.qty AS qty_ordered, poi.price_cny_fen,
            po.rate_cny_rub_x10000, v.id AS variant_id, v.size, v.color, p.sku, p.name AS product_name,
            (SELECT COALESCE(SUM(ri2.qty_received), 0) FROM receipt_items ri2
              JOIN receipts r2 ON r2.id = ri2.receipt_id
              WHERE ri2.po_item_id = poi.id AND r2.status = 'posted' AND r2.id <> ri.receipt_id) AS previously_received
     FROM receipt_items ri
     JOIN purchase_order_items poi ON poi.id = ri.po_item_id
     JOIN purchase_orders po ON po.id = poi.purchase_id
     JOIN product_variants v ON v.id = poi.variant_id
     JOIN products p ON p.id = v.product_id
     WHERE ri.receipt_id = ?
     ORDER BY poi.line_no`, receiptId,
  );
}

export function listReceipts(user, params = {}) {
  assertCan(user, 'receipt.view');
  const where = ['1 = 1'];
  const args = [];
  if (params.purchaseId) { where.push('r.purchase_id = ?'); args.push(Number(params.purchaseId)); }
  if (params.status) { where.push('r.status = ?'); args.push(params.status); }
  const rows = q.all(
    `SELECT r.*, po.number AS purchase_number, s.name AS supplier_name, u.full_name AS author_name,
            (SELECT COUNT(*) FROM receipt_items ri WHERE ri.receipt_id = r.id) AS lines,
            (SELECT COALESCE(SUM(ri.qty_received), 0) FROM receipt_items ri WHERE ri.receipt_id = r.id) AS qty
     FROM receipts r
     JOIN purchase_orders po ON po.id = r.purchase_id
     JOIN suppliers s ON s.id = po.supplier_id
     JOIN users u ON u.id = r.author_id
     WHERE ${where.join(' AND ')}
     ORDER BY r.created_at DESC LIMIT 300`, ...args,
  );
  return rows.map((r) => ({
    id: r.id,
    number: r.number,
    purchaseId: r.purchase_id,
    purchaseNumber: r.purchase_number,
    supplierName: r.supplier_name,
    status: r.status,
    statusLabel: r.status === 'posted' ? 'Проведена' : 'Черновик',
    receiptDate: r.receipt_date,
    authorName: r.author_name,
    postedAt: r.posted_at,
    lines: r.lines,
    qty: r.qty,
  }));
}

export function getReceipt(user, id) {
  assertCan(user, 'receipt.view');
  const r = receiptRow(id);
  if (!r) throw notFound('Приёмка не найдена');
  const items = receiptItemRows(id).map((i) => {
    const item = {
      id: i.id,
      poItemId: i.po_item_id,
      variantId: i.variant_id,
      sku: i.sku,
      productName: i.product_name,
      size: i.size,
      color: i.color,
      qtyOrdered: i.qty_ordered,
      previouslyReceived: Number(i.previously_received),
      qtyReceived: i.qty_received,
      qtyDamaged: i.qty_damaged,
      shortage: Math.max(i.qty_ordered - Number(i.previously_received) - i.qty_received, 0),
      comment: i.comment,
    };
    if (can(user, 'cost.view')) {
      item.unitCostX10000 = i.unit_cost_x10000;
      item.costTotalKop = i.cost_total_kop;
    }
    return item;
  });
  const expenses = listExpenses(user, r.purchase_id).filter((e) => e.receiptId === id);
  const allocations = expenseAllocationsForReceipt(id).map((a) => ({
    expenseId: a.expense_id,
    receiptItemId: a.receipt_item_id,
    variantId: a.variant_id,
    amountKop: a.amount_kop,
  }));
  const totals = { qtyReceived: items.reduce((acc, i) => acc + i.qtyReceived, 0) };
  if (can(user, 'cost.view')) {
    totals.costTotalKop = items.reduce((acc, i) => acc + (i.costTotalKop || 0), 0);
  }
  return {
    id: r.id,
    number: r.number,
    purchaseId: r.purchase_id,
    purchaseNumber: r.purchase_number,
    purchaseStatus: r.purchase_status,
    supplierName: r.supplier_name,
    receiptDate: r.receipt_date,
    status: r.status,
    statusLabel: r.status === 'posted' ? 'Проведена' : 'Черновик',
    authorName: r.author_name,
    postedAt: r.posted_at,
    comment: r.comment,
    items,
    expenses,
    allocations,
    totals,
    canEdit: r.status === 'draft',
  };
}

export function createReceipt(user, purchaseId, data = {}) {
  assertCan(user, 'receipt.create');
  const po = q.get('SELECT * FROM purchase_orders WHERE id = ?', purchaseId);
  if (!po) throw notFound('Закупка не найдена');
  if (po.status === 'cancelled') throw conflict('Нельзя принять товар по отменённой закупке');
  if (!RECEIVABLE_STATUSES.includes(po.status)) {
    throw conflict('Приёмка доступна для заказанной закупки. Переведите закупку в статус «Заказана».');
  }
  if (data.clientRef) {
    const existing = q.get('SELECT id FROM receipts WHERE client_ref = ?', String(data.clientRef));
    if (existing) return getReceipt(user, existing.id);
  }

  const items = receiptItemRowsForPurchase(purchaseId);
  if (!items.length) throw bad('В закупке нет позиций');

  const provided = Array.isArray(data.items) ? data.items : null;
  if (provided) {
    for (const p of provided) {
      const item = items.find((i) => i.po_item_id === Number(p.poItemId));
      if (!item) throw bad('Позиция приёмки не относится к этой закупке');
      const qty = Number(p.qtyReceived ?? 0);
      const damaged = Number(p.qtyDamaged ?? 0);
      if (!Number.isInteger(qty) || qty < 0) throw bad('Количество должно быть целым неотрицательным числом');
      if (!Number.isInteger(damaged) || damaged < 0) throw bad('Количество повреждённых должно быть целым неотрицательным числом');
    }
  }

  const now = new Date().toISOString();
  const number = nextNumber('RCP', 'receipt');
  const info = q.run(
    `INSERT INTO receipts (number, purchase_id, receipt_date, status, author_id, comment, created_at, client_ref)
     VALUES (?, ?, ?, 'draft', ?, ?, ?, ?)`,
    number, purchaseId, data.receiptDate ? parseDate(data.receiptDate) : now,
    user.id, data.comment || null, now, data.clientRef ? String(data.clientRef) : null,
  );
  const receiptId = Number(info.lastInsertRowid);
  for (const item of items) {
    const override = provided ? provided.find((p) => Number(p.poItemId) === item.po_item_id) : null;
    const qtyReceived = override ? Number(override.qtyReceived ?? 0) : item.remaining;
    const qtyDamaged = override ? Number(override.qtyDamaged ?? 0) : 0;
    q.run(
      'INSERT INTO receipt_items (receipt_id, po_item_id, qty_received, qty_damaged, comment) VALUES (?, ?, ?, ?, ?)',
      receiptId, item.po_item_id, qtyReceived, qtyDamaged, override?.comment || null,
    );
  }
  audit(user, 'receipt.create', 'receipt', receiptId, { number, purchaseId });
  return getReceipt(user, receiptId);
}

function receiptItemRowsForPurchase(purchaseId) {
  return q.all(
    `SELECT poi.id AS po_item_id, poi.qty, poi.price_cny_fen,
            (SELECT COALESCE(SUM(ri.qty_received), 0) FROM receipt_items ri
              JOIN receipts r ON r.id = ri.receipt_id
              WHERE ri.po_item_id = poi.id AND r.status = 'posted') AS received
     FROM purchase_order_items poi
     WHERE poi.purchase_id = ?
     ORDER BY poi.line_no`, purchaseId,
  ).map((i) => ({ ...i, remaining: Math.max(i.qty - Number(i.received), 0) }));
}

export function updateReceipt(user, id, data) {
  assertCan(user, 'receipt.create');
  const r = q.get('SELECT * FROM receipts WHERE id = ?', id);
  if (!r) throw notFound('Приёмка не найдена');
  if (r.status !== 'draft') throw conflict('Проведённую приёмку нельзя редактировать');
  if (data.comment !== undefined) q.run('UPDATE receipts SET comment = ? WHERE id = ?', data.comment, id);
  if (data.receiptDate) q.run('UPDATE receipts SET receipt_date = ? WHERE id = ?', parseDate(data.receiptDate), id);
  if (Array.isArray(data.items)) {
    for (const item of data.items) {
      const row = q.get('SELECT * FROM receipt_items WHERE id = ? AND receipt_id = ?', Number(item.id), id);
      const byPo = !row && item.poItemId
        ? q.get('SELECT * FROM receipt_items WHERE receipt_id = ? AND po_item_id = ?', id, Number(item.poItemId))
        : null;
      const target = row || byPo;
      if (!target) throw bad('Позиция приёмки не найдена');
      const qty = Number(item.qtyReceived ?? target.qty_received);
      const damaged = Number(item.qtyDamaged ?? target.qty_damaged);
      if (!Number.isInteger(qty) || qty < 0) throw bad('Количество должно быть целым неотрицательным числом');
      if (!Number.isInteger(damaged) || damaged < 0) throw bad('Количество повреждённых должно быть целым неотрицательным числом');
      q.run('UPDATE receipt_items SET qty_received = ?, qty_damaged = ?, comment = ? WHERE id = ?',
        qty, damaged, item.comment !== undefined ? item.comment : target.comment, target.id);
    }
  }
  audit(user, 'receipt.update', 'receipt', id, { number: r.number });
  return getReceipt(user, id);
}

export function postReceipt(user, id) {
  assertCan(user, 'receipt.post');
  const r = receiptRow(id);
  if (!r) throw notFound('Приёмка не найдена');
  if (r.status === 'posted') throw conflict('Приёмка уже проведена');
  if (!RECEIVABLE_STATUSES.includes(r.purchase_status)) {
    throw conflict('Нельзя провести приёмку: закупка должна быть заказана');
  }
  const lines = receiptItemRows(id);
  if (!lines.length) throw bad('В приёмке нет позиций');
  const totalGood = lines.reduce((acc, l) => acc + Number(l.qty_received), 0);
  if (totalGood <= 0) throw bad('Укажите фактически принятое количество хотя бы по одной позиции');

  const pendingPlans = planExpenseAllocationsForReceipt(id);
  const expenseByItem = new Map();
  for (const plan of pendingPlans) {
    for (const a of plan.allocations) {
      expenseByItem.set(a.receiptItemId, (expenseByItem.get(a.receiptItemId) || 0) + a.amountKop);
    }
  }

  for (const line of lines) {
    const qty = Number(line.qty_received);
    const goodsValue = Math.round((Number(line.price_cny_fen) * qty * Number(line.rate_cny_rub_x10000)) / 10000);
    const expensePart = expenseByItem.get(line.id) || 0;
    const costTotal = goodsValue + expensePart;
    const unitCost = qty > 0 ? Math.round((costTotal * 10000) / qty) : 0;
    q.run('UPDATE receipt_items SET unit_cost_x10000 = ?, cost_total_kop = ? WHERE id = ?', unitCost, costTotal, line.id);
    if (qty > 0) {
      postMovement({
        variantId: line.variant_id,
        type: 'receipt',
        qty,
        unitCostX10000: unitCost,
        valueKop: costTotal,
        docType: 'receipt',
        docId: id,
        comment: `Приёмка ${r.number}`,
        user,
        at: r.receipt_date,
      });
    }
  }

  for (const plan of pendingPlans) {
    q.run('DELETE FROM expense_allocations WHERE expense_id = ?', plan.expenseId);
    for (const a of plan.allocations) {
      if (a.amountKop <= 0) continue;
      q.run(
        'INSERT INTO expense_allocations (expense_id, receipt_item_id, variant_id, amount_kop) VALUES (?, ?, ?, ?)',
        plan.expenseId, a.receiptItemId, a.variantId, a.amountKop,
      );
    }
    q.run('UPDATE expenses SET applied_at = ? WHERE id = ?', new Date().toISOString(), plan.expenseId);
  }

  q.run(
    "UPDATE receipts SET status = 'posted', posted_by = ?, posted_at = ? WHERE id = ? AND status = 'draft'",
    user.id, new Date().toISOString(), id,
  );

  const after = q.all(
    `SELECT poi.qty,
       (SELECT COALESCE(SUM(ri.qty_received), 0) FROM receipt_items ri
         JOIN receipts r2 ON r2.id = ri.receipt_id
         WHERE ri.po_item_id = poi.id AND r2.status = 'posted') AS received
     FROM purchase_order_items poi WHERE poi.purchase_id = ?`, r.purchase_id,
  );
  const fullyReceived = after.every((i) => Number(i.received) >= i.qty);
  const newStatus = fullyReceived ? 'received' : 'partially_received';
  if (r.purchase_status !== 'received' && r.purchase_status !== 'cancelled' && r.purchase_status !== newStatus) {
    q.run('UPDATE purchase_orders SET status = ?, updated_at = ? WHERE id = ?',
      newStatus, new Date().toISOString(), r.purchase_id);
    audit(user, 'purchase.status', 'purchase', r.purchase_id, { from: r.purchase_status, to: newStatus, auto: 'receipt' });
  }

  audit(user, 'receipt.post', 'receipt', id, { number: r.number, qty: totalGood });
  return getReceipt(user, id);
}

export function deleteDraftReceipt(user, id) {
  assertCan(user, 'receipt.create');
  const r = q.get('SELECT * FROM receipts WHERE id = ?', id);
  if (!r) throw notFound('Приёмка не найдена');
  if (r.status === 'posted') throw conflict('Проведённую приёмку нельзя удалить. Оформите обратную операцию.');
  q.run('DELETE FROM expense_allocations WHERE expense_id IN (SELECT id FROM expenses WHERE receipt_id = ? AND applied_at IS NULL)', id);
  q.run('DELETE FROM expenses WHERE receipt_id = ? AND applied_at IS NULL', id);
  q.run('DELETE FROM receipt_items WHERE receipt_id = ?', id);
  q.run('DELETE FROM receipts WHERE id = ?', id);
  audit(user, 'receipt.delete', 'receipt', id, { number: r.number });
  return { deleted: true };
}

export { EXPENSE_CATEGORIES };

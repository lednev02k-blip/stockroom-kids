import { q } from '../db.mjs';
import { audit } from '../audit.mjs';
import { bad, conflict, notFound, parseDate, toFen, toKop, toRate, allocateExpense } from '../util.mjs';
import { assertCan } from '../auth.mjs';
import { recalcAvgCost } from './stock.mjs';

export const EXPENSE_CATEGORIES = {
  delivery: 'Доставка',
  agent: 'Услуги посредника',
  packaging: 'Упаковка',
  customs: 'Таможенные расходы',
  other: 'Прочие расходы',
};

export const ALLOCATION_METHODS = {
  value: 'Пропорционально стоимости',
  qty: 'Пропорционально количеству',
  manual: 'Вручную по позициям',
};

export function receiptWeights(receiptId) {
  return q.all(
    `SELECT ri.id AS receipt_item_id, ri.qty_received, ri.unit_cost_x10000, ri.cost_total_kop,
            poi.price_cny_fen, po.rate_cny_rub_x10000, v.id AS variant_id,
            p.sku, p.name, v.size, v.color
     FROM receipt_items ri
     JOIN purchase_order_items poi ON poi.id = ri.po_item_id
     JOIN purchase_orders po ON po.id = poi.purchase_id
     JOIN product_variants v ON v.id = poi.variant_id
     JOIN products p ON p.id = v.product_id
     WHERE ri.receipt_id = ?
     ORDER BY poi.line_no`, receiptId,
  ).map((r) => ({
    receiptItemId: r.receipt_item_id,
    variantId: r.variant_id,
    qty: Number(r.qty_received),
    priceCnyFen: Number(r.price_cny_fen),
    rateX10000: Number(r.rate_cny_rub_x10000),
    valueKop: Math.round((Number(r.price_cny_fen) * Number(r.qty_received) * Number(r.rate_cny_rub_x10000)) / 10000),
    sku: r.sku,
    name: r.name,
    size: r.size,
    color: r.color,
  }));
}

function purchaseWeights(purchaseId) {
  const rows = q.all(
    `SELECT ri.id AS receipt_item_id, ri.qty_received, poi.price_cny_fen, po.rate_cny_rub_x10000,
            v.id AS variant_id, p.sku, p.name, v.size, v.color
     FROM receipt_items ri
     JOIN receipts r ON r.id = ri.receipt_id AND r.status = 'posted'
     JOIN purchase_order_items poi ON poi.id = ri.po_item_id
     JOIN purchase_orders po ON po.id = poi.purchase_id
     JOIN product_variants v ON v.id = poi.variant_id
     JOIN products p ON p.id = v.product_id
     WHERE r.purchase_id = ? AND ri.qty_received > 0
     ORDER BY p.name, v.size`, purchaseId,
  );
  return rows.map((r) => ({
    receiptItemId: r.receipt_item_id,
    variantId: r.variant_id,
    qty: Number(r.qty_received),
    priceCnyFen: Number(r.price_cny_fen),
    rateX10000: Number(r.rate_cny_rub_x10000),
    valueKop: Math.round((Number(r.price_cny_fen) * Number(r.qty_received) * Number(r.rate_cny_rub_x10000)) / 10000),
    sku: r.sku,
    name: r.name,
    size: r.size,
    color: r.color,
  }));
}

function storeAllocations(expenseId, allocations) {
  q.run('DELETE FROM expense_allocations WHERE expense_id = ?', expenseId);
  for (const a of allocations) {
    q.run(
      'INSERT INTO expense_allocations (expense_id, receipt_item_id, variant_id, amount_kop) VALUES (?, ?, ?, ?)',
      expenseId, a.receiptItemId, a.variantId, a.amountKop,
    );
  }
}

export function createExpense(user, purchaseId, data) {
  assertCan(user, 'expenses.manage');
  const po = q.get('SELECT * FROM purchase_orders WHERE id = ?', purchaseId);
  if (!po) throw notFound('Закупка не найдена');
  if (po.status === 'cancelled') throw conflict('Нельзя добавить расход в отменённую закупку');

  const category = String(data.category || 'other');
  if (!EXPENSE_CATEGORIES[category]) throw bad('Неизвестная категория расхода');
  const currency = String(data.currency || 'RUB').toUpperCase();
  if (!['RUB', 'CNY'].includes(currency)) throw bad('Валюта расхода: RUB или CNY');
  const amountMinor = toKop(data.amount, 'сумма расхода');
  if (amountMinor <= 0) throw bad('Сумма расхода должна быть больше нуля');
  const rate = currency === 'CNY' ? toRate(data.rate ?? po.rate_cny_rub_x10000 / 10000, 'курс расхода') : 10000;
  const amountKop = currency === 'CNY' ? Math.round((amountMinor * rate) / 10000) : amountMinor;
  const method = String(data.method || 'value');
  if (!ALLOCATION_METHODS[method]) throw bad('Неизвестный метод распределения');
  const isCapitalized = data.isCapitalized === false ? 0 : 1;

  let receiptId = data.receiptId ? Number(data.receiptId) : null;
  if (receiptId) {
    const receipt = q.get('SELECT * FROM receipts WHERE id = ? AND purchase_id = ?', receiptId, purchaseId);
    if (!receipt) throw bad('Приёмка не найдена в этой закупке');
  }

  const now = new Date().toISOString();
  const info = q.run(
    `INSERT INTO expenses (purchase_id, receipt_id, category, amount_minor, currency, rate_x10000, amount_kop,
       method, comment, is_capitalized, created_at, author_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    purchaseId, receiptId, category, amountMinor, currency, rate, amountKop,
    method, data.comment || null, isCapitalized, now, user.id,
  );
  const expenseId = Number(info.lastInsertRowid);
  audit(user, 'expense.create', 'purchase', purchaseId, { expenseId, category, amountKop, method, receiptId });

  if (!isCapitalized) {
    return { id: expenseId, applied: false, allocated: [] };
  }

  const result = { id: expenseId, applied: false, allocated: [] };

  if (receiptId) {
    const receipt = q.get('SELECT * FROM receipts WHERE id = ?', receiptId);
    if (receipt.status === 'posted') {
      const applied = applyExpenseToPostedReceipt(expenseId, receiptId, method, amountKop, user, data.allocations);
      result.applied = true;
      result.allocated = applied;
    } else if (method === 'manual') {
      const planned = planManualAllocations(receiptId, amountKop, data.allocations);
      storeAllocations(expenseId, planned);
      result.planned = planned;
    }
  } else {
    const posted = q.get("SELECT COUNT(*) AS c FROM receipts WHERE purchase_id = ? AND status = 'posted'", purchaseId);
    if (posted.c === 0) throw bad('Сначала оформите и проведите приёмку либо укажите конкретную приёмку');
    const applied = applyExpenseToPurchase(expenseId, purchaseId, method, amountKop, user, data.allocations);
    result.applied = true;
    result.allocated = applied;
  }
  return result;
}

function planManualAllocations(receiptId, amountKop, allocations) {
  const weights = receiptWeights(receiptId);
  if (!weights.length) throw bad('В приёмке нет позиций');
  if (!Array.isArray(allocations) || !allocations.length) throw bad('Укажите суммы распределения по позициям');
  const result = [];
  let sum = 0;
  for (const a of allocations) {
    const item = weights.find((w) => w.receiptItemId === Number(a.receiptItemId));
    if (!item) throw bad('Позиция распределения не относится к этой приёмке');
    const amount = toKop(a.amount, 'сумма распределения');
    sum += amount;
    result.push({ receiptItemId: item.receiptItemId, variantId: item.variantId, amountKop: amount });
  }
  if (sum !== amountKop) {
    throw bad(`Сумма распределения (${(sum / 100).toFixed(2)} ₽) не равна сумме расхода (${(amountKop / 100).toFixed(2)} ₽)`);
  }
  return result;
}

function applyExpenseToPostedReceipt(expenseId, receiptId, method, amountKop, user, manualAllocations) {
  const weights = receiptWeights(receiptId).filter((w) => w.qty > 0);
  if (!weights.length) throw bad('В приёмке нет принятых позиций для распределения расхода');
  return distribute(expenseId, weights, method, amountKop, manualAllocations, user);
}

function applyExpenseToPurchase(expenseId, purchaseId, method, amountKop, user, manualAllocations) {
  const weights = purchaseWeights(purchaseId);
  if (!weights.length) throw bad('В закупке нет проведённых приёмок');
  return distribute(expenseId, weights, method, amountKop, manualAllocations, user);
}

function distribute(expenseId, weights, method, amountKop, manualAllocations, user) {
  const parts = method === 'manual'
    ? (() => {
      if (!Array.isArray(manualAllocations) || !manualAllocations.length) throw bad('Укажите суммы распределения по позициям');
      const result = weights.map((w) => ({ ...w, amountKop: 0 }));
      let sum = 0;
      for (const a of manualAllocations) {
        const target = result.find((w) => w.receiptItemId === Number(a.receiptItemId));
        if (!target) throw bad('Позиция распределения не относится к этой партии');
        const amount = toKop(a.amount, 'сумма распределения');
        target.amountKop = amount;
        sum += amount;
      }
      if (sum !== amountKop) throw bad(`Сумма распределения (${(sum / 100).toFixed(2)} ₽) не равна сумме расхода (${(amountKop / 100).toFixed(2)} ₽)`);
      return result;
    })()
    : (() => {
      const amounts = allocateExpense(amountKop, weights, method);
      return weights.map((w, i) => ({ ...w, amountKop: amounts[i] }));
    })();

  const allocations = parts
    .filter((p) => p.amountKop > 0)
    .map((p) => ({ receiptItemId: p.receiptItemId, variantId: p.variantId, amountKop: p.amountKop }));
  storeAllocations(expenseId, allocations);

  const byVariant = new Map();
  for (const a of allocations) {
    byVariant.set(a.variantId, (byVariant.get(a.variantId) || 0) + a.amountKop);
  }
  for (const [variantId, delta] of byVariant) {
    recalcAvgCost(variantId, delta, {
      reason: 'Распределение дополнительных расходов',
      docType: 'expense',
      docId: expenseId,
      expenseId,
      user,
    });
  }
  q.run('UPDATE expenses SET applied_at = ? WHERE id = ?', new Date().toISOString(), expenseId);
  return allocations.map((a) => ({
    ...a,
    sku: parts.find((p) => p.receiptItemId === a.receiptItemId)?.sku,
    name: parts.find((p) => p.receiptItemId === a.receiptItemId)?.name,
  }));
}

/**
 * Рассчитывает распределение ещё не применённых расходов приёмки без изменения
 * остатков и себестоимости. Применение происходит при проведении приёмки.
 */
export function planExpenseAllocationsForReceipt(receiptId) {
  const pending = q.all(
    'SELECT * FROM expenses WHERE receipt_id = ? AND applied_at IS NULL AND is_capitalized = 1', receiptId,
  );
  const weights = receiptWeights(receiptId).filter((w) => w.qty > 0);
  const plans = [];
  for (const expense of pending) {
    if (!weights.length) continue;
    let allocations;
    if (expense.method === 'manual') {
      const stored = q.all('SELECT * FROM expense_allocations WHERE expense_id = ?', expense.id);
      if (!stored.length) throw bad(`Расход «${EXPENSE_CATEGORIES[expense.category]}»: не задано ручное распределение`);
      const sum = stored.reduce((acc, s) => acc + s.amount_kop, 0);
      if (sum !== expense.amount_kop) {
        throw bad(`Расход «${EXPENSE_CATEGORIES[expense.category]}»: сумма ручного распределения не равна сумме расхода`);
      }
      allocations = stored.map((s) => ({
        receiptItemId: s.receipt_item_id,
        variantId: s.variant_id,
        amountKop: s.amount_kop,
      }));
    } else {
      const amounts = allocateExpense(expense.amount_kop, weights, expense.method);
      allocations = weights.map((w, i) => ({
        receiptItemId: w.receiptItemId,
        variantId: w.variantId,
        amountKop: amounts[i],
      }));
    }
    plans.push({ expenseId: expense.id, category: expense.category, allocations });
  }
  return plans;
}

export function expenseAllocationsForReceipt(receiptId) {
  return q.all(
    `SELECT ea.* FROM expense_allocations ea
     JOIN receipt_items ri ON ri.id = ea.receipt_item_id
     WHERE ri.receipt_id = ?`, receiptId,
  );
}

export function expenseAllocations(expenseId) {
  return q.all(
    `SELECT ea.*, p.sku, p.name, v.size, v.color
     FROM expense_allocations ea
     JOIN product_variants v ON v.id = ea.variant_id
     JOIN products p ON p.id = v.product_id
     WHERE ea.expense_id = ?`, expenseId,
  );
}

export function listExpenses(user, purchaseId) {
  const rows = q.all(
    `SELECT e.*, u.full_name AS author_name FROM expenses e JOIN users u ON u.id = e.author_id
     WHERE e.purchase_id = ? ORDER BY e.created_at`, purchaseId,
  );
  return rows.map((e) => ({
    id: e.id,
    category: e.category,
    categoryLabel: EXPENSE_CATEGORIES[e.category],
    amountKop: e.amount_kop,
    currency: e.currency,
    amountMinor: e.amount_minor,
    rateX10000: e.rate_x10000,
    method: e.method,
    methodLabel: ALLOCATION_METHODS[e.method],
    comment: e.comment,
    receiptId: e.receipt_id,
    isCapitalized: !!e.is_capitalized,
    appliedAt: e.applied_at,
    createdAt: e.created_at,
    authorName: e.author_name,
  }));
}

export function assertNoPendingExpenses(receiptId) {
  const pending = q.get(
    'SELECT COUNT(*) AS c FROM expenses WHERE receipt_id = ? AND is_capitalized = 1', receiptId,
  );
  return pending.c === 0;
}

export { parseDate };

import { q, nextNumberLong } from '../db.mjs';
import { audit } from '../audit.mjs';
import { bad, conflict, notFound } from '../util.mjs';
import { assertCan, can } from '../auth.mjs';

export const MOVEMENT_TYPES = {
  receipt: 'Приход',
  sale: 'Продажа',
  sale_return: 'Возврат от покупателя',
  supplier_return: 'Возврат поставщику',
  writeoff: 'Списание',
  inventory: 'Инвентаризация',
  adjustment: 'Корректировка',
};

export function stockOf(variantId) {
  return q.get('SELECT * FROM variant_stock WHERE variant_id = ?', variantId) || { qty: 0, avg_cost_x10000: 0 };
}

/**
 * Проводит складское движение и обновляет остаток и среднюю себестоимость.
 * Всегда вызывается внутри транзакции документа.
 */
export function postMovement({
  variantId, type, qty, unitCostX10000 = null, valueKop = null,
  docType, docId = null, comment = null, user = null, at = new Date().toISOString(),
}) {
  if (!MOVEMENT_TYPES[type]) throw bad('Неизвестный тип складского движения');
  if (!Number.isInteger(qty) || qty === 0) throw bad('Количество в движении должно быть целым и не равным нулю');
  const state = stockOf(variantId);
  const oldQty = Number(state.qty);
  const oldAvg = Number(state.avg_cost_x10000);
  const newQty = oldQty + qty;
  if (newQty < 0) {
    throw conflict(`Недостаточно остатка: доступно ${oldQty}, требуется ${Math.abs(qty)}`);
  }

  let cost = unitCostX10000 === null ? oldAvg : Number(unitCostX10000);
  let value = valueKop;
  if (value === null) value = Math.round((cost * qty) / 10000);

  let newAvg = oldAvg;
  if (type === 'receipt') {
    const totalOld = oldQty * oldAvg;
    const totalNew = Math.round(value) * 10000;
    newAvg = newQty > 0 ? Math.round((totalOld + totalNew) / newQty) : oldAvg;
  } else if (type === 'sale_return') {
    const totalOld = oldQty * oldAvg;
    newAvg = newQty > 0 ? Math.round((totalOld + cost * qty) / newQty) : oldAvg;
  }

  q.run(
    `INSERT INTO stock_movements (variant_id, type, qty, unit_cost_x10000, value_kop, doc_type, doc_id, comment, created_at, author_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    variantId, type, qty, cost, value, docType, docId, comment, at, user ? user.id : null,
  );
  q.run('UPDATE variant_stock SET qty = ?, avg_cost_x10000 = ? WHERE variant_id = ?', newQty, newAvg, variantId);
  return { qty: newQty, avgCostX10000: newAvg, unitCostX10000: cost, valueKop: value };
}

export function recalcAvgCost(variantId, deltaValueKop, meta) {
  const state = stockOf(variantId);
  const qty = Number(state.qty);
  const oldAvg = Number(state.avg_cost_x10000);
  let newAvg = oldAvg;
  if (qty > 0) {
    newAvg = Math.round((qty * oldAvg + deltaValueKop * 10000) / qty);
    q.run('UPDATE variant_stock SET avg_cost_x10000 = ? WHERE variant_id = ?', newAvg, variantId);
  }
  q.run(
    `INSERT INTO cost_adjustments (variant_id, delta_value_kop, reason, doc_type, doc_id, expense_id, created_at, author_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    variantId, deltaValueKop, meta.reason, meta.docType, meta.docId ?? null, meta.expenseId ?? null,
    new Date().toISOString(), meta.user ? meta.user.id : null,
  );
  return { qty, oldAvg, newAvg, applied: qty > 0 };
}

export function listStock(user, params = {}) {
  assertCan(user, 'stock.view');
  const search = String(params.search || '').trim().toLowerCase();
  const categoryId = params.categoryId ? Number(params.categoryId) : null;
  const lowOnly = params.low === true || params.low === '1';
  const lowThreshold = Number(params.lowThreshold || 3);

  const rows = q.all(
    `SELECT v.id AS variant_id, v.size, v.color, v.style_name, v.retail_price_kop, v.is_active AS variant_active,
            p.id AS product_id, p.sku, p.name, p.is_active, p.unit, c.name AS category_name,
            COALESCE(s.qty, 0) AS qty, COALESCE(s.avg_cost_x10000, 0) AS avg_cost_x10000
     FROM product_variants v
     JOIN products p ON p.id = v.product_id
     LEFT JOIN categories c ON c.id = p.category_id
     LEFT JOIN variant_stock s ON s.variant_id = v.id
     WHERE 1 = 1 ${categoryId ? 'AND p.category_id = ?' : ''}
     ORDER BY p.name COLLATE NOCASE, v.size, v.color`,
    ...(categoryId ? [categoryId] : []),
  );

  return rows
    .filter((r) => {
      if (search && !`${r.sku} ${r.name} ${r.size} ${r.color}`.toLowerCase().includes(search)) return false;
      if (lowOnly && Number(r.qty) > lowThreshold) return false;
      return true;
    })
    .map((r) => {
      const item = {
        variantId: r.variant_id,
        productId: r.product_id,
        sku: r.sku,
        name: r.name,
        categoryName: r.category_name,
        size: r.size,
        color: r.color,
        styleName: r.style_name,
        unit: r.unit,
        qty: Number(r.qty),
        retailPriceKop: r.retail_price_kop,
        isActive: !!r.is_active && !!r.variant_active,
      };
      if (can(user, 'cost.view')) {
        item.avgCostX10000 = Number(r.avg_cost_x10000);
        item.valueKop = Math.round((Number(r.qty) * Number(r.avg_cost_x10000)) / 10000);
      }
      return item;
    });
}

export function listMovements(user, params = {}) {
  assertCan(user, 'stock.view');
  const where = ['1 = 1'];
  const args = [];
  if (params.variantId) { where.push('m.variant_id = ?'); args.push(Number(params.variantId)); }
  if (params.type) { where.push('m.type = ?'); args.push(params.type); }
  if (params.from) { where.push('m.created_at >= ?'); args.push(new Date(params.from).toISOString()); }
  if (params.to) { where.push('m.created_at <= ?'); args.push(new Date(params.to).toISOString()); }
  const rows = q.all(
    `SELECT m.*, p.sku, p.name, v.size, v.color, u.full_name AS author_name
     FROM stock_movements m
     JOIN product_variants v ON v.id = m.variant_id
     JOIN products p ON p.id = v.product_id
     LEFT JOIN users u ON u.id = m.author_id
     WHERE ${where.join(' AND ')}
     ORDER BY m.created_at DESC, m.id DESC LIMIT 500`, ...args,
  );
  return rows.map((m) => {
    const view = {
      id: m.id,
      variantId: m.variant_id,
      sku: m.sku,
      name: m.name,
      size: m.size,
      color: m.color,
      type: m.type,
      typeLabel: MOVEMENT_TYPES[m.type],
      qty: m.qty,
      docType: m.doc_type,
      docId: m.doc_id,
      comment: m.comment,
      createdAt: m.created_at,
      authorName: m.author_name,
    };
    if (can(user, 'cost.view')) {
      view.unitCostX10000 = m.unit_cost_x10000;
      view.valueKop = m.value_kop;
    }
    return view;
  });
}

export function adjustStock(user, data) {
  assertCan(user, 'stock.adjust');
  const variantId = Number(data.variantId);
  if (!variantId) throw bad('Не указан вариант товара');
  if (!q.get('SELECT id FROM product_variants WHERE id = ?', variantId)) throw notFound('Вариант товара не найден');
  const reason = String(data.reason || '').trim();
  if (!reason) throw bad('Укажите причину корректировки');

  const state = stockOf(variantId);
  let delta = null;
  if (data.qtyDelta !== undefined) {
    delta = Number(data.qtyDelta);
    if (!Number.isInteger(delta) || delta === 0) throw bad('Изменение количества должно быть целым и не равным нулю');
  } else {
    const target = Number(data.qty);
    if (!Number.isInteger(target) || target < 0) throw bad('Некорректное фактическое количество');
    delta = target - Number(state.qty);
  }
  if (delta === 0) return { qty: Number(state.qty), message: 'Остаток не изменился' };
  const type = delta < 0 ? 'writeoff' : 'adjustment';
  const result = postMovement({
    variantId, type, qty: delta, docType: 'adjustment', docId: null,
    comment: reason, user,
  });
  audit(user, 'stock.adjust', 'variant', variantId, { delta, reason, type });
  return { qty: result.qty, avgCostX10000: result.avgCostX10000 };
}

export function listInventory(user) {
  assertCan(user, 'stock.inventory');
  return q.all(
    `SELECT ic.*, u.full_name AS author_name,
       (SELECT COUNT(*) FROM inventory_items ii WHERE ii.count_id = ic.id) AS items_count,
       (SELECT COUNT(*) FROM inventory_items ii WHERE ii.count_id = ic.id AND ii.qty_actual <> ii.qty_expected) AS diff_count
     FROM inventory_counts ic JOIN users u ON u.id = ic.author_id
     ORDER BY ic.created_at DESC LIMIT 100`,
  ).map((r) => ({
    id: r.id,
    number: r.number,
    countedAt: r.counted_at,
    status: r.status,
    statusLabel: r.status === 'posted' ? 'Проведена' : 'Черновик',
    authorName: r.author_name,
    itemsCount: r.items_count,
    diffCount: r.diff_count,
    comment: r.comment,
  }));
}

export function getInventory(user, id) {
  assertCan(user, 'stock.inventory');
  const doc = q.get(
    `SELECT ic.*, u.full_name AS author_name FROM inventory_counts ic JOIN users u ON u.id = ic.author_id WHERE ic.id = ?`, id,
  );
  if (!doc) throw notFound('Инвентаризация не найдена');
  const items = q.all(
    `SELECT ii.*, p.sku, p.name, v.size, v.color FROM inventory_items ii
     JOIN product_variants v ON v.id = ii.variant_id
     JOIN products p ON p.id = v.product_id
     WHERE ii.count_id = ? ORDER BY p.name COLLATE NOCASE, v.size`, id,
  ).map((i) => ({
    id: i.id,
    variantId: i.variant_id,
    sku: i.sku,
    name: i.name,
    size: i.size,
    color: i.color,
    qtyExpected: i.qty_expected,
    qtyActual: i.qty_actual,
    diff: i.qty_actual - i.qty_expected,
    comment: i.comment,
  }));
  return {
    id: doc.id,
    number: doc.number,
    countedAt: doc.counted_at,
    status: doc.status,
    authorName: doc.author_name,
    comment: doc.comment,
    postedAt: doc.posted_at,
    items,
  };
}

export function createInventory(user, data) {
  assertCan(user, 'stock.inventory');
  const rawItems = Array.isArray(data.items) ? data.items : [];
  if (!rawItems.length) throw bad('Добавьте хотя бы одну позицию для инвентаризации');
  const now = new Date().toISOString();
  const number = nextNumberLong('INV', 'inventory');
  const info = q.run(
    'INSERT INTO inventory_counts (number, counted_at, status, comment, author_id, created_at) VALUES (?, ?, \'draft\', ?, ?, ?)',
    number, data.countedAt ? new Date(data.countedAt).toISOString() : now, data.comment || null, user.id, now,
  );
  const countId = Number(info.lastInsertRowid);
  for (const item of rawItems) {
    const variantId = Number(item.variantId);
    const variant = q.get('SELECT id FROM product_variants WHERE id = ?', variantId);
    if (!variant) throw bad('Вариант товара не найден');
    const actual = Number(item.qtyActual);
    if (!Number.isInteger(actual) || actual < 0) throw bad('Фактическое количество должно быть целым неотрицательным числом');
    const expected = Number(stockOf(variantId).qty);
    q.run(
      'INSERT INTO inventory_items (count_id, variant_id, qty_expected, qty_actual, comment) VALUES (?, ?, ?, ?, ?)',
      countId, variantId, expected, actual, item.comment || null,
    );
  }
  audit(user, 'inventory.create', 'inventory', countId, { number, items: rawItems.length });
  return getInventory(user, countId);
}

export function postInventory(user, id) {
  assertCan(user, 'stock.inventory');
  const doc = q.get('SELECT * FROM inventory_counts WHERE id = ?', id);
  if (!doc) throw notFound('Инвентаризация не найдена');
  if (doc.status === 'posted') throw conflict('Инвентаризация уже проведена');
  const items = q.all('SELECT * FROM inventory_items WHERE count_id = ?', id);
  if (!items.length) throw bad('В документе нет позиций');
  for (const item of items) {
    const current = Number(stockOf(item.variant_id).qty);
    const delta = item.qty_actual - current;
    if (delta === 0) continue;
    postMovement({
      variantId: item.variant_id, type: 'inventory', qty: delta, docType: 'inventory', docId: id,
      comment: `Инвентаризация ${doc.number}`, user,
    });
  }
  q.run('UPDATE inventory_counts SET status = \'posted\', posted_by = ?, posted_at = ? WHERE id = ?',
    user.id, new Date().toISOString(), id);
  audit(user, 'inventory.post', 'inventory', id, { number: doc.number });
  return getInventory(user, id);
}

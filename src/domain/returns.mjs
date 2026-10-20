import { q, nextNumber } from '../db.mjs';
import { audit } from '../audit.mjs';
import { bad, conflict, forbidden, notFound, toQty } from '../util.mjs';
import { assertCan, can } from '../auth.mjs';
import { postMovement } from './stock.mjs';

function returnableQty(saleItemId) {
  const sold = q.get('SELECT qty FROM sale_items WHERE id = ?', saleItemId);
  const returned = q.get('SELECT COALESCE(SUM(qty), 0) AS s FROM return_items WHERE sale_item_id = ?', saleItemId);
  return { sold: sold ? sold.qty : 0, returned: Number(returned.s) };
}

export function createReturn(user, data) {
  assertCan(user, 'return.create');
  if (data.clientRef) {
    const existing = q.get('SELECT id FROM returns WHERE client_ref = ?', String(data.clientRef));
    if (existing) return getReturn(user, existing.id);
  }
  const saleId = Number(data.saleId);
  const sale = q.get('SELECT * FROM sales WHERE id = ?', saleId);
  if (!sale) throw notFound('Продажа не найдена');
  if (!can(user, 'sale.view_all') && sale.seller_id !== user.id) {
    throw forbidden('Возврат по чужой продаже доступен только владельцу');
  }
  const reason = String(data.reason || '').trim();
  if (!reason) throw bad('Укажите причину возврата');
  const rawItems = Array.isArray(data.items) ? data.items : [];
  if (!rawItems.length) throw bad('Не выбраны позиции для возврата');

  const items = rawItems.map((item) => {
    const saleItem = q.get(
      `SELECT si.*, p.sku, p.name, v.size, v.color FROM sale_items si
       JOIN product_variants v ON v.id = si.variant_id
       JOIN products p ON p.id = v.product_id
       WHERE si.id = ? AND si.sale_id = ?`, Number(item.saleItemId), saleId,
    );
    if (!saleItem) throw bad('Позиция не относится к указанной продаже');
    const qty = toQty(item.qty, 'количество возврата');
    const condition = String(item.condition || 'sellable');
    if (!['sellable', 'damaged'].includes(condition)) throw bad('Состояние товара: sellable или damaged');
    const { sold, returned } = returnableQty(saleItem.id);
    if (returned + qty > sold) {
      throw conflict(`«${saleItem.name}»: к возврату доступно ${sold - returned}, запрошено ${qty}`);
    }
    return { saleItem, qty, condition };
  });

  const total = items.reduce((acc, i) => acc + i.saleItem.price_kop * i.qty, 0);
  const now = new Date().toISOString();
  const number = nextNumber('RET', 'return');
  const info = q.run(
    `INSERT INTO returns (number, sale_id, reason, total_kop, status, created_at, author_id, client_ref)
     VALUES (?, ?, ?, ?, 'posted', ?, ?, ?)`,
    number, saleId, reason, total, now, user.id, data.clientRef ? String(data.clientRef) : null,
  );
  const returnId = Number(info.lastInsertRowid);

  for (const item of items) {
    q.run(
      `INSERT INTO return_items (return_id, sale_item_id, variant_id, qty, price_kop, condition, cost_unit_x10000)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      returnId, item.saleItem.id, item.saleItem.variant_id, item.qty,
      item.saleItem.price_kop, item.condition, item.saleItem.cost_unit_x10000,
    );
    if (item.condition === 'sellable') {
      postMovement({
        variantId: item.saleItem.variant_id,
        type: 'sale_return',
        qty: item.qty,
        unitCostX10000: item.saleItem.cost_unit_x10000,
        docType: 'return',
        docId: returnId,
        comment: `Возврат ${number}`,
        user,
        at: now,
      });
    }
  }
  audit(user, 'return.create', 'return', returnId, { number, saleId, total, damaged: items.filter((i) => i.condition === 'damaged').length });
  return getReturn(user, returnId);
}

export function getReturn(user, id) {
  const row = q.get(
    `SELECT r.*, u.full_name AS author_name, s.number AS sale_number FROM returns r
     JOIN users u ON u.id = r.author_id JOIN sales s ON s.id = r.sale_id WHERE r.id = ?`, id,
  );
  if (!row) throw notFound('Возврат не найден');
  if (!can(user, 'sale.view_all') && row.author_id !== user.id) throw forbidden('Возврат доступен только автору или владельцу');
  const items = q.all(
    `SELECT ri.*, p.sku, p.name, v.size, v.color FROM return_items ri
     JOIN product_variants v ON v.id = ri.variant_id
     JOIN products p ON p.id = v.product_id
     WHERE ri.return_id = ?`, id,
  ).map((i) => ({
    id: i.id,
    saleItemId: i.sale_item_id,
    variantId: i.variant_id,
    sku: i.sku,
    name: i.name,
    size: i.size,
    color: i.color,
    qty: i.qty,
    priceKop: i.price_kop,
    condition: i.condition,
  }));
  return {
    id: row.id,
    number: row.number,
    saleId: row.sale_id,
    saleNumber: row.sale_number,
    reason: row.reason,
    totalKop: row.total_kop,
    createdAt: row.created_at,
    authorName: row.author_name,
    items,
  };
}

export function listReturns(user, params = {}) {
  const canAll = can(user, 'sale.view_all');
  const where = ['1 = 1'];
  const args = [];
  if (!canAll) { where.push('r.author_id = ?'); args.push(user.id); }
  if (params.saleId) { where.push('r.sale_id = ?'); args.push(Number(params.saleId)); }
  const rows = q.all(
    `SELECT r.*, u.full_name AS author_name, s.number AS sale_number,
       (SELECT COALESCE(SUM(ri.qty), 0) FROM return_items ri WHERE ri.return_id = r.id) AS qty,
       (SELECT COUNT(*) FROM return_items ri WHERE ri.return_id = r.id AND ri.condition = 'damaged') AS damaged_lines
     FROM returns r
     JOIN users u ON u.id = r.author_id
     JOIN sales s ON s.id = r.sale_id
     WHERE ${where.join(' AND ')}
     ORDER BY r.created_at DESC LIMIT 300`, ...args,
  );
  return rows.map((r) => ({
    id: r.id,
    number: r.number,
    saleId: r.sale_id,
    saleNumber: r.sale_number,
    reason: r.reason,
    totalKop: r.total_kop,
    qty: r.qty,
    hasDamaged: r.damaged_lines > 0,
    createdAt: r.created_at,
    authorName: r.author_name,
  }));
}

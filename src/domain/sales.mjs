import { q, nextNumberLong, getSetting } from '../db.mjs';
import { audit } from '../audit.mjs';
import { bad, conflict, forbidden, notFound, parseDate, toKop, toQty } from '../util.mjs';
import { assertCan, can } from '../auth.mjs';
import { postMovement, stockOf } from './stock.mjs';

function saleView(user, id) {
  const sale = q.get(
    `SELECT s.*, u.full_name AS seller_name FROM sales s JOIN users u ON u.id = s.seller_id WHERE s.id = ?`, id,
  );
  if (!sale) throw notFound('Продажа не найдена');
  if (!can(user, 'sale.view_all') && sale.seller_id !== user.id) throw forbidden('Доступна только собственная продажа');

  const items = q.all(
    `SELECT si.*, p.sku, p.name, v.size, v.color,
       (SELECT COALESCE(SUM(ri.qty), 0) FROM return_items ri WHERE ri.sale_item_id = si.id) AS returned_qty
     FROM sale_items si
     JOIN product_variants v ON v.id = si.variant_id
     JOIN products p ON p.id = v.product_id
     WHERE si.sale_id = ?
     ORDER BY si.id`, id,
  ).map((i) => {
    const view = {
      id: i.id,
      variantId: i.variant_id,
      sku: i.sku,
      name: i.name,
      size: i.size,
      color: i.color,
      qty: i.qty,
      priceKop: i.price_kop,
      returnedQty: Number(i.returned_qty),
      returnableQty: Math.max(i.qty - Number(i.returned_qty), 0),
    };
    if (can(user, 'cost.view')) {
      view.costUnitX10000 = i.cost_unit_x10000;
      view.costTotalKop = i.cost_total_kop;
    }
    return view;
  });

  const returns = q.all(
    `SELECT r.*, u.full_name AS author_name FROM returns r JOIN users u ON u.id = r.author_id
     WHERE r.sale_id = ? ORDER BY r.created_at`, id,
  ).map((r) => {
    const items2 = q.all(
      `SELECT ri.*, p.sku, p.name, v.size, v.color FROM return_items ri
       JOIN product_variants v ON v.id = ri.variant_id
       JOIN products p ON p.id = v.product_id
       WHERE ri.return_id = ?`, r.id,
    ).map((ri) => ({
      id: ri.id,
      saleItemId: ri.sale_item_id,
      variantId: ri.variant_id,
      sku: ri.sku,
      name: ri.name,
      size: ri.size,
      color: ri.color,
      qty: ri.qty,
      priceKop: ri.price_kop,
      condition: ri.condition,
    }));
    return {
      id: r.id,
      number: r.number,
      totalKop: r.total_kop,
      reason: r.reason,
      createdAt: r.created_at,
      authorName: r.author_name,
      items: items2,
    };
  });
  const returnedKop = returns.reduce((acc, r) => acc + r.total_kop, 0);

  return {
    id: sale.id,
    number: sale.number,
    soldAt: sale.sold_at,
    sellerId: sale.seller_id,
    sellerName: sale.seller_name,
    subtotalKop: sale.subtotal_kop,
    discountKop: sale.discount_kop,
    totalKop: sale.total_kop,
    costTotalKop: can(user, 'cost.view') ? sale.cost_total_kop : undefined,
    profitKop: can(user, 'reports.profit') ? sale.total_kop - sale.cost_total_kop : undefined,
    comment: sale.comment,
    items,
    returns,
    returnedKop,
    canReturn: items.some((i) => i.returnableQty > 0),
  };
}

export function getSale(user, id) {
  assertCan(user, 'sale.create', 'Нет доступа к продажам');
  return saleView(user, id);
}

export function listSales(user, params = {}) {
  const canAll = can(user, 'sale.view_all');
  const where = ['1 = 1'];
  const args = [];
  if (!canAll) { where.push('s.seller_id = ?'); args.push(user.id); }
  else if (params.sellerId) { where.push('s.seller_id = ?'); args.push(Number(params.sellerId)); }
  if (params.from) { where.push('s.sold_at >= ?'); args.push(parseDate(params.from)); }
  if (params.to) { where.push('s.sold_at <= ?'); args.push(parseDate(params.to, new Date())); }
  if (params.search) {
    where.push('(s.number LIKE ? OR EXISTS (SELECT 1 FROM sale_items si JOIN products p ON p.id = (SELECT product_id FROM product_variants WHERE id = si.variant_id) WHERE si.sale_id = s.id AND (p.sku LIKE ? OR p.name LIKE ?)))');
    args.push(`%${params.search}%`, `%${params.search}%`, `%${params.search}%`);
  }
  const rows = q.all(
    `SELECT s.*, u.full_name AS seller_name,
       (SELECT COALESCE(SUM(si.qty), 0) FROM sale_items si WHERE si.sale_id = s.id) AS qty,
       (SELECT COALESCE(SUM(r.total_kop), 0) FROM returns r WHERE r.sale_id = s.id) AS returned_kop
     FROM sales s JOIN users u ON u.id = s.seller_id
     WHERE ${where.join(' AND ')}
     ORDER BY s.sold_at DESC, s.id DESC LIMIT 300`, ...args,
  );
  return rows.map((s) => ({
    id: s.id,
    number: s.number,
    soldAt: s.sold_at,
    sellerName: s.seller_name,
    qty: s.qty,
    totalKop: s.total_kop,
    returnedKop: s.returned_kop,
    costTotalKop: can(user, 'cost.view') ? s.cost_total_kop : undefined,
    profitKop: can(user, 'reports.profit') ? s.total_kop - s.cost_total_kop : undefined,
    comment: s.comment,
  }));
}

export function createSale(user, data) {
  assertCan(user, 'sale.create');
  if (data.clientRef) {
    const existing = q.get('SELECT id FROM sales WHERE client_ref = ?', String(data.clientRef));
    if (existing) return saleView(user, existing.id);
  }
  const rawItems = Array.isArray(data.items) ? data.items : [];
  if (!rawItems.length) throw bad('Корзина пуста');
  const seen = new Set();
  const items = rawItems.map((item, index) => {
    const variantId = Number(item.variantId);
    if (!variantId) throw bad(`Позиция ${index + 1}: не указан вариант товара`);
    if (seen.has(variantId)) throw bad(`Позиция ${index + 1}: вариант указан дважды`);
    seen.add(variantId);
    const variant = q.get(
      `SELECT v.*, p.name AS product_name, p.sku FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.id = ?`,
      variantId,
    );
    if (!variant) throw bad(`Позиция ${index + 1}: товар не найден`);
    if (!variant.is_active) throw bad(`Позиция ${index + 1}: товар снят с продажи`);
    const qty = toQty(item.qty, 'количество');
    const priceKop = item.priceKop !== undefined
      ? Number(item.priceKop)
      : (item.price !== undefined ? toKop(item.price, 'цена') : variant.retail_price_kop);
    if (!Number.isInteger(priceKop) || priceKop < 0) throw bad('Некорректная цена продажи');
    return { variant, qty, priceKop };
  });

  const maxDiscountPercent = Number(getSetting('max_seller_discount_percent', '10'));
  if (!can(user, 'price.manage')) {
    for (const item of items) {
      const minPrice = Math.round(item.variant.retail_price_kop * (1 - maxDiscountPercent / 100));
      if (item.priceKop < minPrice) {
        throw forbidden(`Цена ниже допустимой скидки ${maxDiscountPercent}% (минимум ${(minPrice / 100).toFixed(2)} ₽)`);
      }
      if (item.priceKop > item.variant.retail_price_kop) {
        throw forbidden('Изменять цену выше розничной может только владелец');
      }
    }
  }

  const subtotal = items.reduce((acc, i) => acc + i.priceKop * i.qty, 0);
  let discount = 0;
  if (data.discountKop !== undefined || (data.discount !== undefined && data.discount !== '')) {
    assertCan(user, 'price.manage', 'Скидка на всю продажу доступна только владельцу');
    discount = data.discountKop !== undefined ? Number(data.discountKop) : toKop(data.discount, 'скидка');
    if (!Number.isInteger(discount) || discount < 0) throw bad('Некорректная скидка');
    if (discount > subtotal) throw bad('Скидка не может превышать сумму продажи');
  }
  if (data.subtotalKop !== undefined && Number(data.subtotalKop) !== subtotal) {
    throw conflict('Сумма корзины изменилась. Обновите её и повторите продажу.');
  }

  const soldAt = parseDate(data.soldAt);
  const now = new Date().toISOString();
  const number = nextNumberLong('SL', 'sale');
  const info = q.run(
    `INSERT INTO sales (number, sold_at, seller_id, subtotal_kop, discount_kop, total_kop, cost_total_kop,
       comment, status, created_at, client_ref)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, 'posted', ?, ?)`,
    number, soldAt, user.id, subtotal, discount, subtotal - discount,
    data.comment || null, now, data.clientRef ? String(data.clientRef) : null,
  );
  const saleId = Number(info.lastInsertRowid);

  let costTotal = 0;
  for (const item of items) {
    const state = stockOf(item.variant.id);
    if (Number(state.qty) < item.qty) {
      throw conflict(`«${item.variant.product_name}» (${item.variant.size}/${item.variant.color}): доступно ${state.qty}, запрошено ${item.qty}`);
    }
    const unitCost = Number(state.avg_cost_x10000);
    const lineCost = Math.round((unitCost * item.qty) / 10000);
    costTotal += lineCost;
    q.run(
      `INSERT INTO sale_items (sale_id, variant_id, qty, price_kop, cost_unit_x10000, cost_total_kop)
       VALUES (?, ?, ?, ?, ?, ?)`,
      saleId, item.variant.id, item.qty, item.priceKop, unitCost, lineCost,
    );
    postMovement({
      variantId: item.variant.id,
      type: 'sale',
      qty: -item.qty,
      unitCostX10000: unitCost,
      docType: 'sale',
      docId: saleId,
      comment: `Продажа ${number}`,
      user,
      at: soldAt,
    });
  }
  q.run('UPDATE sales SET cost_total_kop = ? WHERE id = ?', costTotal, saleId);
  audit(user, 'sale.create', 'sale', saleId, { number, total: subtotal - discount, qty: items.length });
  return saleView(user, saleId);
}

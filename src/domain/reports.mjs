import { q, getSetting } from '../db.mjs';
import { assertCan, can } from '../auth.mjs';
import { parseDate, toCsv } from '../util.mjs';
import { listStock } from './stock.mjs';
import { listPurchases, purchaseItems, purchaseTotals, purchaseRow } from './purchases.mjs';
import { PURCHASE_STATUS } from './purchases.mjs';

function startOfDay(date = new Date()) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function startOfMonth(date = new Date()) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function scopeSeller(user) {
  return can(user, 'sale.view_all') ? null : user.id;
}

export function dashboard(user) {
  const today = startOfDay().toISOString();
  const monthStart = startOfMonth().toISOString();
  const sellerId = scopeSeller(user);
  const sellerFilter = sellerId ? 'AND s.seller_id = ?' : '';
  const sellerArgs = sellerId ? [sellerId] : [];

  const models = q.get('SELECT COUNT(*) AS c FROM products WHERE is_active = 1').c;
  const variants = q.get('SELECT COUNT(*) AS c FROM product_variants v JOIN products p ON p.id = v.product_id WHERE p.is_active = 1').c;

  const salesToday = q.get(`SELECT COALESCE(SUM(s.total_kop), 0) AS sum, COUNT(*) AS c FROM sales s WHERE s.sold_at >= ? ${sellerFilter}`, today, ...sellerArgs);
  const salesMonth = q.get(
    `SELECT COALESCE(SUM(s.total_kop), 0) AS revenue, COALESCE(SUM(s.cost_total_kop), 0) AS cost, COUNT(*) AS c
     FROM sales s WHERE s.sold_at >= ? ${sellerFilter}`, monthStart, ...sellerArgs,
  );
  const returnsMonth = q.get(
    `SELECT COALESCE(SUM(r.total_kop), 0) AS revenue,
            COALESCE(SUM((SELECT SUM(ri.qty * ri.cost_unit_x10000) / 10000.0 FROM return_items ri WHERE ri.return_id = r.id)), 0) AS cost
     FROM returns r WHERE r.created_at >= ? ${sellerId ? 'AND r.author_id = ?' : ''}`,
    monthStart, ...sellerArgs,
  );

  const lowThreshold = Number(getSetting('low_stock_threshold', '3'));
  const lowStock = q.all(
    `SELECT v.id, v.size, v.color, p.sku, p.name, COALESCE(s.qty, 0) AS qty
     FROM product_variants v
     JOIN products p ON p.id = v.product_id
     LEFT JOIN variant_stock s ON s.variant_id = v.id
     WHERE p.is_active = 1 AND COALESCE(s.qty, 0) <= ?
     ORDER BY COALESCE(s.qty, 0), p.name LIMIT 20`, lowThreshold,
  );
  const lowStockCount = q.get(
    `SELECT COUNT(*) AS c FROM product_variants v JOIN products p ON p.id = v.product_id
     LEFT JOIN variant_stock s ON s.variant_id = v.id
     WHERE p.is_active = 1 AND COALESCE(s.qty, 0) <= ?`, lowThreshold,
  ).c;

  const purchases = can(user, 'purchase.view')
    ? q.all(
      `SELECT po.*, (SELECT COALESCE(SUM(poi.qty), 0) FROM purchase_order_items poi WHERE poi.purchase_id = po.id) AS ordered,
              (SELECT COALESCE(SUM(ri.qty_received), 0) FROM receipt_items ri JOIN receipts r ON r.id = ri.receipt_id
                WHERE r.purchase_id = po.id AND r.status = 'posted') AS received
       FROM purchase_orders po
       WHERE po.status NOT IN ('received', 'cancelled')`,
    )
    : [];

  const expectedQty = purchases.reduce((acc, p) => acc + Math.max(p.ordered - p.received, 0), 0);
  const stockValue = can(user, 'cost.view')
    ? q.get('SELECT COALESCE(SUM(ROUND(qty * avg_cost_x10000 / 10000.0)), 0) AS v FROM variant_stock').v
    : null;

  return {
    models,
    variants,
    stockValueKop: stockValue,
    salesTodayKop: salesToday.sum,
    salesTodayCount: salesToday.c,
    monthRevenueKop: can(user, 'reports.profit') ? salesMonth.revenue : null,
    monthProfitKop: can(user, 'reports.profit')
      ? Math.round(salesMonth.revenue - returnsMonth.revenue - (salesMonth.cost - returnsMonth.cost))
      : null,
    lowStockCount,
    lowStock: lowStock.map((r) => ({ variantId: r.id, sku: r.sku, name: r.name, size: r.size, color: r.color, qty: r.qty })),
    purchasesInProgress: purchases.length,
    expectedReceiptsQty: expectedQty,
    lowStockThreshold: lowThreshold,
  };
}

export function salesReport(user, params = {}) {
  assertCan(user, 'sale.create', 'Нет доступа к отчёту продаж');
  const from = params.from ? parseDate(params.from) : startOfMonth().toISOString();
  const to = params.to ? parseDate(params.to, new Date()) : new Date().toISOString();
  const sellerId = params.sellerId ? Number(params.sellerId) : scopeSeller(user);
  const args = [from, to];
  let sellerClause = '';
  if (sellerId) { sellerClause = 'AND s.seller_id = ?'; args.push(sellerId); }
  let productClause = '';
  if (params.search) {
    productClause = `AND EXISTS (SELECT 1 FROM sale_items si2 JOIN product_variants v2 ON v2.id = si2.variant_id JOIN products p2 ON p2.id = v2.product_id
      WHERE si2.sale_id = s.id AND (p2.sku LIKE ? OR p2.name LIKE ?))`;
    args.push(`%${params.search}%`, `%${params.search}%`);
  }

  const sales = q.all(
    `SELECT s.*, u.full_name AS seller_name FROM sales s JOIN users u ON u.id = s.seller_id
     WHERE s.sold_at >= ? AND s.sold_at <= ? ${sellerClause} ${productClause}
     ORDER BY s.sold_at DESC`, ...args,
  );

  const rows = [];
  for (const sale of sales) {
    const items = q.all(
      `SELECT si.qty, si.price_kop, si.cost_total_kop, p.sku, p.name, v.size, v.color
       FROM sale_items si
       JOIN product_variants v ON v.id = si.variant_id
       JOIN products p ON p.id = v.product_id
       WHERE si.sale_id = ?`, sale.id,
    );
    const qty = items.reduce((a, i) => a + i.qty, 0);
    rows.push({
      id: sale.id,
      number: sale.number,
      soldAt: sale.sold_at,
      sellerName: sale.seller_name,
      qty,
      totalKop: sale.total_kop,
      costKop: can(user, 'cost.view') ? sale.cost_total_kop : null,
      profitKop: can(user, 'reports.profit') ? sale.total_kop - sale.cost_total_kop : null,
      items: items.map((i) => ({ sku: i.sku, name: i.name, size: i.size, color: i.color, qty: i.qty, priceKop: i.price_kop })),
    });
  }

  const rets = q.all(
    `SELECT r.*, (SELECT COALESCE(SUM(ri.qty * ri.cost_unit_x10000), 0) / 10000.0 FROM return_items ri WHERE ri.return_id = r.id) AS cost
     FROM returns r WHERE r.created_at >= ? AND r.created_at <= ? ${sellerId ? 'AND r.author_id = ?' : ''}`,
    from, to, ...(sellerId ? [sellerId] : []),
  );

  const revenue = rows.reduce((a, r) => a + r.totalKop, 0);
  const cost = rows.reduce((a, r) => a + (r.costKop || 0), 0);
  const returnsTotal = rets.reduce((a, r) => a + r.total_kop, 0);
  const returnsCost = Math.round(rets.reduce((a, r) => a + Number(r.cost), 0));
  const summary = {
    salesCount: rows.length,
    qty: rows.reduce((a, r) => a + r.qty, 0),
    revenueKop: revenue,
    costKop: can(user, 'cost.view') ? cost : null,
    profitKop: can(user, 'reports.profit') ? revenue - returnsTotal - (cost - returnsCost) : null,
    returnsCount: rets.length,
    returnsKop: returnsTotal,
    returnsCostKop: can(user, 'cost.view') ? returnsCost : null,
    netRevenueKop: revenue - returnsTotal,
  };
  return { from, to, rows, summary };
}

export function stockReport(user, params = {}) {
  assertCan(user, 'stock.view');
  const items = listStock(user, params);
  const totals = {
    variants: items.length,
    qty: items.reduce((a, i) => a + i.qty, 0),
    valueKop: can(user, 'cost.view') ? items.reduce((a, i) => a + (i.valueKop || 0), 0) : null,
  };
  return { items, totals };
}

export function purchasesReport(user, params = {}) {
  assertCan(user, 'reports.purchases');
  const purchases = listPurchases(user, params);
  const summary = {
    count: purchases.length,
    orderedQty: purchases.reduce((a, p) => a + p.orderedQty, 0),
    receivedQty: purchases.reduce((a, p) => a + p.receivedQty, 0),
    inTransitQty: purchases.reduce((a, p) => a + p.inTransitQty, 0),
    cnyFen: purchases.reduce((a, p) => a + p.cnyFen, 0),
    goodsKop: purchases.reduce((a, p) => a + p.goodsKop, 0),
    expensesKop: purchases.reduce((a, p) => a + p.expensesKop, 0),
  };
  return { rows: purchases, summary };
}

export function purchaseDetailReport(user, id) {
  assertCan(user, 'reports.purchases');
  const po = purchaseRow(id);
  const items = purchaseItems(id);
  const totals = purchaseTotals(po, items);
  return { purchase: po, items, totals };
}

export function catalogExport(user) {
  assertCan(user, 'export.catalog');
  const rows = q.all(
    `SELECT p.sku, p.name, c.name AS category, p.season, p.brand, p.unit, p.is_active,
            v.size, v.color, v.style_name, v.retail_price_kop,
            COALESCE(s.qty, 0) AS qty, COALESCE(s.avg_cost_x10000, 0) AS avg_cost
     FROM products p
     LEFT JOIN categories c ON c.id = p.category_id
     LEFT JOIN product_variants v ON v.product_id = p.id
     LEFT JOIN variant_stock s ON s.variant_id = v.id
     ORDER BY p.name COLLATE NOCASE, v.size, v.color`,
  );
  const columns = [
    { title: 'Артикул', key: 'sku' },
    { title: 'Наименование', key: 'name' },
    { title: 'Категория', key: 'category' },
    { title: 'Сезон', key: 'season' },
    { title: 'Бренд', key: 'brand' },
    { title: 'Размер', key: 'size' },
    { title: 'Цвет', key: 'color' },
    { title: 'Исполнение', key: 'style_name' },
    { title: 'Розничная цена, ₽', value: (r) => (r.retail_price_kop / 100).toFixed(2) },
    { title: 'Остаток', key: 'qty' },
  ];
  if (can(user, 'cost.view')) columns.push({ title: 'Себестоимость, ₽', value: (r) => (r.avg_cost / 10000).toFixed(2) });
  return toCsv(columns, rows);
}

export function stockExport(user, params = {}) {
  assertCan(user, 'export.stock');
  const items = listStock(user, params);
  const columns = [
    { title: 'Артикул', key: 'sku' },
    { title: 'Наименование', key: 'name' },
    { title: 'Категория', key: 'categoryName' },
    { title: 'Размер', key: 'size' },
    { title: 'Цвет', key: 'color' },
    { title: 'Остаток', key: 'qty' },
    { title: 'Розничная цена, ₽', value: (r) => (r.retailPriceKop / 100).toFixed(2) },
  ];
  if (can(user, 'cost.view')) {
    columns.push({ title: 'Себестоимость, ₽', value: (r) => ((r.avgCostX10000 || 0) / 10000).toFixed(2) });
    columns.push({ title: 'Стоимость запаса, ₽', value: (r) => ((r.valueKop || 0) / 100).toFixed(2) });
  }
  return toCsv(columns, items);
}

export function salesExport(user, params = {}) {
  assertCan(user, 'sale.create');
  const report = salesReport(user, params);
  const columns = [
    { title: 'Номер', key: 'number' },
    { title: 'Дата', value: (r) => new Date(r.soldAt).toLocaleString('ru-RU') },
    { title: 'Продавец', key: 'sellerName' },
    { title: 'Позиций, шт', key: 'qty' },
    { title: 'Сумма, ₽', value: (r) => (r.totalKop / 100).toFixed(2) },
  ];
  if (can(user, 'cost.view')) {
    columns.push({ title: 'Себестоимость, ₽', value: (r) => ((r.costKop || 0) / 100).toFixed(2) });
    columns.push({ title: 'Валовая прибыль, ₽', value: (r) => ((r.profitKop || 0) / 100).toFixed(2) });
  }
  return toCsv(columns, report.rows);
}

export function purchasesExport(user, params = {}) {
  assertCan(user, 'export.purchases');
  const report = purchasesReport(user, params);
  const columns = [
    { title: 'Номер', key: 'number' },
    { title: 'Поставщик', key: 'supplierName' },
    { title: 'Статус', key: 'statusLabel' },
    { title: 'Заказано, шт', key: 'orderedQty' },
    { title: 'Получено, шт', key: 'receivedQty' },
    { title: 'В пути, шт', key: 'inTransitQty' },
    { title: 'Сумма, CNY', value: (r) => (r.cnyFen / 100).toFixed(2) },
    { title: 'Товар, ₽', value: (r) => (r.goodsKop / 100).toFixed(2) },
    { title: 'Расходы, ₽', value: (r) => (r.expensesKop / 100).toFixed(2) },
    { title: 'Оплачено, ₽', value: (r) => (r.paidKop / 100).toFixed(2) },
  ];
  return toCsv(columns, report.rows);
}

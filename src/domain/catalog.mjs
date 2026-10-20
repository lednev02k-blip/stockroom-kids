import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { q } from '../db.mjs';
import { audit } from '../audit.mjs';
import { bad, conflict, notFound, toKop } from '../util.mjs';
import { assertCan, can } from '../auth.mjs';

const UPLOAD_DIR = process.env.SRK_UPLOAD_DIR
  ? path.resolve(process.env.SRK_UPLOAD_DIR)
  : path.join(path.resolve(import.meta.dirname, '..', '..'), 'storage', 'uploads');

function normalizeSku(value) {
  const sku = String(value || '').trim().toUpperCase();
  if (!sku) throw bad('Не указан артикул');
  if (!/^[A-ZА-Я0-9._\-/]{1,40}$/u.test(sku)) throw bad('Артикул может содержать буквы, цифры, точку, дефис, слэш и подчёркивание');
  return sku;
}

function priceFromPayload(data, fallback = 0) {
  if (data.retail_price_kop !== undefined && data.retail_price_kop !== null) {
    const v = Number(data.retail_price_kop);
    if (!Number.isInteger(v) || v < 0) throw bad('Некорректная розничная цена');
    return v;
  }
  if (data.retail_price !== undefined && data.retail_price !== null && data.retail_price !== '') {
    return toKop(data.retail_price, 'розничная цена');
  }
  return fallback;
}

export function variantView(row, user) {
  const view = {
    id: row.id,
    productId: row.product_id,
    size: row.size,
    color: row.color,
    styleName: row.style_name,
    extra: row.extra,
    retailPriceKop: row.retail_price_kop,
    qty: Number(row.qty || 0),
    isActive: !!row.is_active,
  };
  if (can(user, 'cost.view')) view.avgCostX10000 = Number(row.avg_cost_x10000 || 0);
  return view;
}

export function listCategories(user) {
  return q.all('SELECT id, name, sort, is_active AS isActive FROM categories ORDER BY sort, name');
}

export function createCategory(user, data) {
  assertCan(user, 'catalog.manage');
  const name = String(data.name || '').trim();
  if (!name) throw bad('Не указано название категории');
  const exists = q.get('SELECT id FROM categories WHERE lower(name) = lower(?)', name);
  if (exists) throw conflict('Категория с таким названием уже существует');
  const info = q.run('INSERT INTO categories (name, sort) VALUES (?, ?)', name, Number(data.sort) || 100);
  audit(user, 'category.create', 'category', info.lastInsertRowid, { name });
  return { id: Number(info.lastInsertRowid), name };
}

export function updateCategory(user, id, data) {
  assertCan(user, 'catalog.manage');
  const category = q.get('SELECT * FROM categories WHERE id = ?', id);
  if (!category) throw notFound('Категория не найдена');
  const name = data.name !== undefined ? String(data.name).trim() : category.name;
  if (!name) throw bad('Не указано название категории');
  const sort = data.sort !== undefined ? Number(data.sort) : category.sort;
  const isActive = data.isActive !== undefined ? (data.isActive ? 1 : 0) : category.is_active;
  q.run('UPDATE categories SET name = ?, sort = ?, is_active = ? WHERE id = ?', name, sort, isActive, id);
  audit(user, 'category.update', 'category', id, { name, sort, isActive });
  return { id, name, sort, isActive: !!isActive };
}

function variantRowsForProducts(productIds) {
  if (!productIds.length) return [];
  const placeholders = productIds.map(() => '?').join(',');
  return q.all(
    `SELECT v.*, COALESCE(s.qty, 0) AS qty, COALESCE(s.avg_cost_x10000, 0) AS avg_cost_x10000
     FROM product_variants v
     LEFT JOIN variant_stock s ON s.variant_id = v.id
     WHERE v.product_id IN (${placeholders})
     ORDER BY v.size, v.color, v.id`,
    ...productIds,
  );
}

export function listProducts(user, params = {}) {
  const search = String(params.search || '').trim().toLowerCase();
  const categoryId = params.categoryId ? Number(params.categoryId) : null;
  const supplierId = params.supplierId ? Number(params.supplierId) : null;
  const season = params.season ? String(params.season) : null;
  const size = params.size ? String(params.size).toLowerCase() : null;
  const color = params.color ? String(params.color).toLowerCase() : null;
  const inStock = params.inStock === true || params.inStock === '1';
  const includeArchived = params.includeArchived === true || params.includeArchived === '1';

  const where = ['1 = 1'];
  const args = [];
  if (categoryId) { where.push('p.category_id = ?'); args.push(categoryId); }
  if (supplierId) { where.push('p.default_supplier_id = ?'); args.push(supplierId); }
  if (season) { where.push('p.season = ?'); args.push(season); }
  if (!includeArchived || user.role === 'seller') where.push('p.is_active = 1');

  const products = q.all(
    `SELECT p.*, c.name AS category_name, sup.name AS supplier_name
     FROM products p
     LEFT JOIN categories c ON c.id = p.category_id
     LEFT JOIN suppliers sup ON sup.id = p.default_supplier_id
     WHERE ${where.join(' AND ')}
     ORDER BY p.name COLLATE NOCASE`,
    ...args,
  );

  const variants = variantRowsForProducts(products.map((p) => p.id));
  const byProduct = new Map();
  for (const v of variants) {
    if (!byProduct.has(v.product_id)) byProduct.set(v.product_id, []);
    byProduct.get(v.product_id).push(v);
  }

  const result = [];
  for (const p of products) {
    let vars = byProduct.get(p.id) || [];
    if (size) vars = vars.filter((v) => String(v.size).toLowerCase().includes(size));
    if (color) vars = vars.filter((v) => String(v.color).toLowerCase().includes(color));
    if (inStock) vars = vars.filter((v) => Number(v.qty) > 0);
    if (search) {
      const hay = `${p.sku} ${p.name} ${p.brand || ''}`.toLowerCase();
      const variantHit = vars.some((v) => `${v.size} ${v.color} ${v.style_name}`.toLowerCase().includes(search));
      if (!hay.includes(search) && !variantHit) continue;
    }
    if ((size || color || inStock) && vars.length === 0) continue;

    const totalQty = vars.reduce((acc, v) => acc + Number(v.qty || 0), 0);
    result.push({
      id: p.id,
      sku: p.sku,
      name: p.name,
      categoryId: p.category_id,
      categoryName: p.category_name,
      supplierName: p.supplier_name,
      season: p.season,
      brand: p.brand,
      unit: p.unit,
      photo: p.photo_path ? `/api/media/${p.photo_path}` : null,
      isActive: !!p.is_active,
      updatedAt: p.updated_at,
      variants: vars.map((v) => variantView(v, user)),
      totalQty,
      prices: vars.map((v) => v.retail_price_kop),
    });
  }

  const sort = params.sort || 'name';
  result.sort((a, b) => {
    if (sort === 'stock') return b.totalQty - a.totalQty;
    if (sort === 'updated') return String(b.updatedAt).localeCompare(String(a.updatedAt));
    if (sort === 'price') return Math.min(...b.prices, Infinity) - Math.min(...a.prices, Infinity);
    return a.name.localeCompare(b.name, 'ru');
  });
  return result;
}

export function getProduct(user, id) {
  const p = q.get(
    `SELECT p.*, c.name AS category_name, sup.name AS supplier_name
     FROM products p
     LEFT JOIN categories c ON c.id = p.category_id
     LEFT JOIN suppliers sup ON sup.id = p.default_supplier_id
     WHERE p.id = ?`, id,
  );
  if (!p) throw notFound('Товар не найден');
  const variants = variantRowsForProducts([p.id]).map((v) => variantView(v, user));

  const history = can(user, 'cost.view') || can(user, 'price.manage')
    ? q.all(
      `SELECT ph.*, u.full_name AS changed_by_name FROM price_history ph
       LEFT JOIN users u ON u.id = ph.changed_by
       WHERE ph.variant_id IN (SELECT id FROM product_variants WHERE product_id = ?)
       ORDER BY ph.changed_at DESC LIMIT 100`, p.id,
    ).map((h) => ({
      id: h.id,
      variantId: h.variant_id,
      oldPriceKop: h.old_price_kop,
      newPriceKop: h.new_price_kop,
      changedAt: h.changed_at,
      changedByName: h.changed_by_name,
      comment: h.comment,
    }))
    : [];

  const movements = variablesMovementsForProduct(p.id);

  return {
    id: p.id,
    sku: p.sku,
    name: p.name,
    categoryId: p.category_id,
    categoryName: p.category_name,
    unit: p.unit,
    season: p.season,
    ageGroup: p.age_group,
    brand: p.brand,
    defaultSupplierId: p.default_supplier_id,
    supplierName: p.supplier_name,
    description: p.description,
    notes: p.notes,
    photo: p.photo_path ? `/api/media/${p.photo_path}` : null,
    isActive: !!p.is_active,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
    variants,
    priceHistory: history,
    movements,
  };
}

function variablesMovementsForProduct(productId) {
  return q.all(
    `SELECT m.id, m.variant_id, m.type, m.qty, m.unit_cost_x10000, m.value_kop,
            m.doc_type, m.doc_id, m.comment, m.created_at, u.full_name AS author_name,
            v.size, v.color
     FROM stock_movements m
     JOIN product_variants v ON v.id = m.variant_id
     LEFT JOIN users u ON u.id = m.author_id
     WHERE v.product_id = ?
     ORDER BY m.created_at DESC, m.id DESC
     LIMIT 100`, productId,
  ).map((m) => ({
    id: m.id,
    variantId: m.variant_id,
    size: m.size,
    color: m.color,
    type: m.type,
    qty: m.qty,
    unitCostX10000: m.unit_cost_x10000,
    valueKop: m.value_kop,
    docType: m.doc_type,
    docId: m.doc_id,
    comment: m.comment,
    createdAt: m.created_at,
    authorName: m.author_name,
  }));
}

export function createProduct(user, data) {
  assertCan(user, 'catalog.manage');
  const sku = normalizeSku(data.sku);
  const name = String(data.name || '').trim();
  if (!name) throw bad('Не указано наименование товара');
  if (q.get('SELECT id FROM products WHERE sku = ?', sku)) throw conflict(`Артикул ${sku} уже используется`);

  const categoryId = data.categoryId ? Number(data.categoryId) : null;
  if (categoryId && !q.get('SELECT id FROM categories WHERE id = ?', categoryId)) throw bad('Категория не найдена');
  const supplierId = data.defaultSupplierId ? Number(data.defaultSupplierId) : null;
  if (supplierId && !q.get('SELECT id FROM suppliers WHERE id = ?', supplierId)) throw bad('Поставщик не найден');

  const now = new Date().toISOString();
  const info = q.run(
    `INSERT INTO products (sku, name, category_id, unit, season, age_group, brand,
       default_supplier_id, description, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    sku, name, categoryId, String(data.unit || 'шт').trim() || 'шт',
    data.season || null, data.ageGroup || null, data.brand || null,
    supplierId, data.description || null, data.notes || null, now, now,
  );
  const productId = Number(info.lastInsertRowid);

  const variants = Array.isArray(data.variants) && data.variants.length ? data.variants : [{}];
  const created = [];
  for (const variant of variants) {
    created.push(insertVariant(user, productId, variant, false));
  }
  audit(user, 'product.create', 'product', productId, { sku, name, variants: created.length });
  return getProduct(user, productId);
}

function insertVariant(user, productId, data, withAudit = true) {
  const size = String(data.size || '').trim();
  const color = String(data.color || '').trim();
  const styleName = String(data.styleName || data.style_name || '').trim();
  const extra = String(data.extra || '').trim();
  const price = priceFromPayload(data);
  const dup = q.get(
    `SELECT id FROM product_variants WHERE product_id = ? AND size = ? AND color = ? AND style_name = ? AND extra = ?`,
    productId, size, color, styleName, extra,
  );
  if (dup) throw conflict('Такой вариант (размер/цвет) уже существует у товара');
  const now = new Date().toISOString();
  const info = q.run(
    `INSERT INTO product_variants (product_id, size, color, style_name, extra, retail_price_kop, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    productId, size, color, styleName, extra, price, now,
  );
  const variantId = Number(info.lastInsertRowid);
  q.run('INSERT INTO variant_stock (variant_id, qty, avg_cost_x10000) VALUES (?, 0, 0)', variantId);
  if (withAudit) audit(user, 'variant.create', 'variant', variantId, { productId, size, color, price });
  return { id: variantId, size, color, styleName, extra, retailPriceKop: price };
}

export function addVariant(user, productId, data) {
  assertCan(user, 'catalog.manage');
  if (!q.get('SELECT id FROM products WHERE id = ?', productId)) throw notFound('Товар не найден');
  const created = insertVariant(user, productId, data);
  q.run('UPDATE products SET updated_at = ? WHERE id = ?', new Date().toISOString(), productId);
  return created;
}

export function updateVariant(user, id, data) {
  assertCan(user, 'catalog.manage');
  const variant = q.get('SELECT * FROM product_variants WHERE id = ?', id);
  if (!variant) throw notFound('Вариант не найден');

  const priceChanging = data.retail_price_kop !== undefined || (data.retail_price !== undefined && data.retail_price !== '');
  const newPrice = priceChanging ? priceFromPayload(data, variant.retail_price_kop) : variant.retail_price_kop;
  if (newPrice !== variant.retail_price_kop) assertCan(user, 'price.manage', 'Изменение розничной цены запрещено вашей ролью');

  const size = data.size !== undefined ? String(data.size).trim() : variant.size;
  const color = data.color !== undefined ? String(data.color).trim() : variant.color;
  const styleName = data.styleName !== undefined ? String(data.styleName).trim() : variant.style_name;
  const extra = data.extra !== undefined ? String(data.extra).trim() : variant.extra;
  const isActive = data.isActive !== undefined ? (data.isActive ? 1 : 0) : variant.is_active;

  const dup = q.get(
    `SELECT id FROM product_variants WHERE product_id = ? AND size = ? AND color = ? AND style_name = ? AND extra = ? AND id <> ?`,
    variant.product_id, size, color, styleName, extra, id,
  );
  if (dup) throw conflict('Такой вариант уже существует у товара');

  q.run(
    `UPDATE product_variants SET size = ?, color = ?, style_name = ?, extra = ?, retail_price_kop = ?, is_active = ? WHERE id = ?`,
    size, color, styleName, extra, newPrice, isActive, id,
  );
  if (newPrice !== variant.retail_price_kop) {
    q.run(
      'INSERT INTO price_history (variant_id, old_price_kop, new_price_kop, changed_by, changed_at, comment) VALUES (?, ?, ?, ?, ?, ?)',
      id, variant.retail_price_kop, newPrice, user.id, new Date().toISOString(), data.comment || null,
    );
    audit(user, 'variant.price_change', 'variant', id, { oldPrice: variant.retail_price_kop, newPrice });
  }
  q.run('UPDATE products SET updated_at = ? WHERE id = ?', new Date().toISOString(), variant.product_id);
  audit(user, 'variant.update', 'variant', id, { size, color, styleName, extra, isActive });
  const fresh = q.get(
    `SELECT v.*, COALESCE(s.qty, 0) AS qty, COALESCE(s.avg_cost_x10000, 0) AS avg_cost_x10000
     FROM product_variants v LEFT JOIN variant_stock s ON s.variant_id = v.id WHERE v.id = ?`, id,
  );
  return variantView(fresh, user);
}

export function updateProduct(user, id, data) {
  assertCan(user, 'catalog.manage');
  const p = q.get('SELECT * FROM products WHERE id = ?', id);
  if (!p) throw notFound('Товар не найден');
  const sku = data.sku !== undefined ? normalizeSku(data.sku) : p.sku;
  if (sku !== p.sku && q.get('SELECT id FROM products WHERE sku = ? AND id <> ?', sku, id)) {
    throw conflict(`Артикул ${sku} уже используется`);
  }
  const name = data.name !== undefined ? String(data.name).trim() : p.name;
  if (!name) throw bad('Не указано наименование товара');
  const categoryId = data.categoryId !== undefined ? (data.categoryId ? Number(data.categoryId) : null) : p.category_id;
  const supplierId = data.defaultSupplierId !== undefined ? (data.defaultSupplierId ? Number(data.defaultSupplierId) : null) : p.default_supplier_id;
  const isActive = data.isActive !== undefined ? (data.isActive ? 1 : 0) : p.is_active;
  q.run(
    `UPDATE products SET sku = ?, name = ?, category_id = ?, unit = ?, season = ?, age_group = ?, brand = ?,
       default_supplier_id = ?, description = ?, notes = ?, is_active = ?, updated_at = ? WHERE id = ?`,
    sku, name, categoryId,
    data.unit !== undefined ? String(data.unit).trim() : p.unit,
    data.season !== undefined ? data.season : p.season,
    data.ageGroup !== undefined ? data.ageGroup : p.age_group,
    data.brand !== undefined ? data.brand : p.brand,
    supplierId,
    data.description !== undefined ? data.description : p.description,
    data.notes !== undefined ? data.notes : p.notes,
    isActive, new Date().toISOString(), id,
  );
  audit(user, 'product.update', 'product', id, { sku, name, isActive });
  return getProduct(user, id);
}

export function setProductPhoto(user, id, dataUrl) {
  assertCan(user, 'catalog.manage');
  const p = q.get('SELECT * FROM products WHERE id = ?', id);
  if (!p) throw notFound('Товар не найден');
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!match) throw bad('Ожидается изображение JPEG, PNG или WebP');
  const mime = match[1];
  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length > 4 * 1024 * 1024) throw bad('Файл больше 4 МБ');
  const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
  const fileName = `${crypto.randomUUID()}.${ext}`;
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  fs.writeFileSync(path.join(UPLOAD_DIR, fileName), buffer);

  if (p.photo_path) {
    try { fs.unlinkSync(path.join(UPLOAD_DIR, p.photo_path)); } catch { /* файла могло не быть */ }
  }
  q.run('UPDATE products SET photo_path = ?, updated_at = ? WHERE id = ?', fileName, new Date().toISOString(), id);
  audit(user, 'product.photo', 'product', id, { fileName });
  return { photo: `/api/media/${fileName}` };
}

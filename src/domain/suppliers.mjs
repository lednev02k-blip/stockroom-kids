import { q } from '../db.mjs';
import { audit } from '../audit.mjs';
import { bad, conflict, notFound } from '../util.mjs';
import { assertCan } from '../auth.mjs';

export function listSuppliers(user) {
  assertCan(user, 'suppliers.view');
  return q.all(
    `SELECT s.*, (SELECT COUNT(*) FROM purchase_orders p WHERE p.supplier_id = s.id) AS purchases_count
     FROM suppliers s ORDER BY s.name COLLATE NOCASE`,
  ).map((s) => ({
    id: s.id,
    name: s.name,
    code: s.code,
    country: s.country,
    contact: s.contact,
    notes: s.notes,
    isActive: !!s.is_active,
    purchasesCount: s.purchases_count,
    createdAt: s.created_at,
  }));
}

export function createSupplier(user, data) {
  assertCan(user, 'suppliers.manage');
  const name = String(data.name || '').trim();
  if (!name) throw bad('Не указано название поставщика');
  if (q.get('SELECT id FROM suppliers WHERE lower(name) = lower(?)', name)) throw conflict('Поставщик с таким названием уже существует');
  const info = q.run(
    'INSERT INTO suppliers (name, code, country, contact, notes, is_active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)',
    name, data.code || null, data.country || null, data.contact || null, data.notes || null, new Date().toISOString(),
  );
  audit(user, 'supplier.create', 'supplier', info.lastInsertRowid, { name });
  return { id: Number(info.lastInsertRowid), name };
}

export function updateSupplier(user, id, data) {
  assertCan(user, 'suppliers.manage');
  const s = q.get('SELECT * FROM suppliers WHERE id = ?', id);
  if (!s) throw notFound('Поставщик не найден');
  const name = data.name !== undefined ? String(data.name).trim() : s.name;
  if (!name) throw bad('Не указано название поставщика');
  const isActive = data.isActive !== undefined ? (data.isActive ? 1 : 0) : s.is_active;
  q.run(
    'UPDATE suppliers SET name = ?, code = ?, country = ?, contact = ?, notes = ?, is_active = ? WHERE id = ?',
    name,
    data.code !== undefined ? data.code : s.code,
    data.country !== undefined ? data.country : s.country,
    data.contact !== undefined ? data.contact : s.contact,
    data.notes !== undefined ? data.notes : s.notes,
    isActive, id,
  );
  audit(user, 'supplier.update', 'supplier', id, { name, isActive });
  return { id, name, isActive: !!isActive };
}

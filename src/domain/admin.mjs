import { q, getSetting, setSetting } from '../db.mjs';
import os from 'node:os';
import { audit } from '../audit.mjs';
import { bad, conflict, forbidden, notFound } from '../util.mjs';
import { assertCan, hashPassword, ROLES, verifyPassword } from '../auth.mjs';

const LOGIN_RE = /^[a-zA-Z0-9._-]{3,32}$/;

export function listUsers(user) {
  assertCan(user, 'users.manage');
  return q.all(
    `SELECT u.id, u.login, u.full_name, u.role, u.is_active, u.created_at, u.last_login_at,
       (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > ?) AS sessions_count
     FROM users u ORDER BY u.role, u.login`,
    new Date().toISOString(),
  ).map((u) => ({
    id: u.id,
    login: u.login,
    fullName: u.full_name,
    role: u.role,
    roleLabel: ROLES[u.role] || u.role,
    isActive: !!u.is_active,
    createdAt: u.created_at,
    lastLoginAt: u.last_login_at,
    sessionsCount: u.sessions_count,
  }));
}

export function createUser(user, data) {
  assertCan(user, 'users.manage');
  const login = String(data.login || '').trim().toLowerCase();
  if (!LOGIN_RE.test(login)) throw bad('Логин: 3–32 символа, латинские буквы, цифры, точка, дефис или подчёркивание');
  const fullName = String(data.fullName || '').trim();
  if (!fullName) throw bad('Укажите имя сотрудника');
  const role = String(data.role || 'seller');
  if (!ROLES[role]) throw bad('Неизвестная роль');
  const password = String(data.password || '');
  if (password.length < 8) throw bad('Пароль должен содержать не менее 8 символов');
  if (q.get('SELECT id FROM users WHERE login = ?', login)) throw conflict('Пользователь с таким логином уже существует');
  const { hash, salt } = hashPassword(password);
  const info = q.run(
    'INSERT INTO users (login, full_name, role, password_hash, password_salt, is_active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)',
    login, fullName, role, hash, salt, new Date().toISOString(),
  );
  audit(user, 'user.create', 'user', info.lastInsertRowid, { login, role });
  return { id: Number(info.lastInsertRowid), login, fullName, role };
}

export function updateUser(user, id, data) {
  assertCan(user, 'users.manage');
  const target = q.get('SELECT * FROM users WHERE id = ?', id);
  if (!target) throw notFound('Пользователь не найден');
  if (data.role !== undefined && !ROLES[data.role]) throw bad('Неизвестная роль');

  const isActive = data.isActive !== undefined ? (data.isActive ? 1 : 0) : target.is_active;
  const role = data.role !== undefined ? data.role : target.role;
  if (target.id === user.id && !isActive) throw forbidden('Нельзя деактивировать собственную учётную запись');
  if (target.role === 'owner' && (role !== 'owner' || !isActive)) {
    const owners = q.get("SELECT COUNT(*) AS c FROM users WHERE role = 'owner' AND is_active = 1 AND id <> ?", id).c;
    if (owners === 0) throw conflict('В системе должен остаться хотя бы один активный владелец');
  }
  const fullName = data.fullName !== undefined ? String(data.fullName).trim() : target.full_name;
  if (!fullName) throw bad('Укажите имя сотрудника');

  q.run('UPDATE users SET full_name = ?, role = ?, is_active = ? WHERE id = ?', fullName, role, isActive, id);
  if (!isActive) q.run('DELETE FROM sessions WHERE user_id = ?', id);
  if (data.password) {
    if (String(data.password).length < 8) throw bad('Пароль должен содержать не менее 8 символов');
    const { hash, salt } = hashPassword(String(data.password));
    q.run('UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?', hash, salt, id);
    q.run('DELETE FROM sessions WHERE user_id = ?', id);
    audit(user, 'user.password_reset', 'user', id, { byOwner: true });
  }
  audit(user, 'user.update', 'user', id, { role, isActive, fullName });
  return { id, login: target.login, fullName, role, isActive: !!isActive };
}

export function changeOwnPassword(user, data) {
  const row = q.get('SELECT * FROM users WHERE id = ?', user.id);
  if (!row) throw notFound('Пользователь не найден');
  const oldPassword = String(data.oldPassword || '');
  const newPassword = String(data.newPassword || '');
  if (!verifyPassword(oldPassword, row.password_salt, row.password_hash)) throw bad('Текущий пароль указан неверно');
  if (newPassword.length < 8) throw bad('Новый пароль должен содержать не менее 8 символов');
  const { hash, salt } = hashPassword(newPassword);
  q.run('UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?', hash, salt, user.id);
  q.run('DELETE FROM sessions WHERE user_id = ?', user.id);
  audit(user, 'user.password_change', 'user', user.id, null);
  return { changed: true };
}

export function listAudit(user, params = {}) {
  assertCan(user, 'audit.view');
  const where = ['1 = 1'];
  const args = [];
  if (params.entity) { where.push('a.entity = ?'); args.push(params.entity); }
  if (params.action) { where.push('a.action LIKE ?'); args.push(`%${params.action}%`); }
  if (params.from) { where.push('a.at >= ?'); args.push(new Date(params.from).toISOString()); }
  if (params.to) { where.push('a.at <= ?'); args.push(new Date(params.to).toISOString()); }
  const limit = Math.min(Number(params.limit) || 200, 1000);
  return q.all(
    `SELECT a.* FROM audit_log a WHERE ${where.join(' AND ')} ORDER BY a.at DESC, a.id DESC LIMIT ${limit}`, ...args,
  ).map((a) => ({
    id: a.id,
    at: a.at,
    login: a.login,
    userId: a.user_id,
    action: a.action,
    entity: a.entity,
    entityId: a.entity_id,
    details: a.details ? JSON.parse(a.details) : null,
  }));
}

const SETTING_KEYS = ['company_name', 'low_stock_threshold', 'max_seller_discount_percent', 'currency', 'purchase_note'];

export function getSettings(user) {
  assertCan(user, 'settings.manage');
  const values = {};
  for (const key of SETTING_KEYS) values[key] = getSetting(key);
  return values;
}

export function updateSettings(user, data) {
  assertCan(user, 'settings.manage');
  const applied = {};
  if (data.company_name !== undefined) {
    const name = String(data.company_name).trim();
    if (!name) throw bad('Название магазина не может быть пустым');
    setSetting('company_name', name);
    applied.company_name = name;
  }
  if (data.low_stock_threshold !== undefined) {
    const n = Number(data.low_stock_threshold);
    if (!Number.isInteger(n) || n < 0) throw bad('Порог низкого остатка должен быть целым неотрицательным числом');
    setSetting('low_stock_threshold', n);
    applied.low_stock_threshold = n;
  }
  if (data.max_seller_discount_percent !== undefined) {
    const n = Number(data.max_seller_discount_percent);
    if (!Number.isFinite(n) || n < 0 || n > 100) throw bad('Максимальная скидка продавца должна быть от 0 до 100%');
    setSetting('max_seller_discount_percent', n);
    applied.max_seller_discount_percent = n;
  }
  if (data.purchase_note !== undefined) {
    setSetting('purchase_note', String(data.purchase_note));
    applied.purchase_note = String(data.purchase_note);
  }
  audit(user, 'settings.update', 'settings', null, applied);
  return getSettings(user);
}

export function systemInfo(user) {
  assertCan(user, 'settings.manage');
  const counts = {
    products: q.get('SELECT COUNT(*) AS c FROM products').c,
    variants: q.get('SELECT COUNT(*) AS c FROM product_variants').c,
    purchases: q.get('SELECT COUNT(*) AS c FROM purchase_orders').c,
    receipts: q.get('SELECT COUNT(*) AS c FROM receipts').c,
    sales: q.get('SELECT COUNT(*) AS c FROM sales').c,
    returns: q.get('SELECT COUNT(*) AS c FROM returns').c,
    movements: q.get('SELECT COUNT(*) AS c FROM stock_movements').c,
  };
  const addresses = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const item of list || []) {
      if (item.family === 'IPv4' && !item.internal) addresses.push({ name, address: item.address });
    }
  }

  return {
    counts,
    currency: getSetting('currency', 'RUB'),
    version: '1.0.0',
    port: Number(process.env.PORT || 3000),
    addresses,
    backupHint: 'Резервная копия: npm run backup (создаёт файл в папке backups).',
  };
}

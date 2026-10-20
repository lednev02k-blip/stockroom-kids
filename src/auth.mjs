import crypto from 'node:crypto';
import { q } from './db.mjs';
import { AppError, forbidden } from './util.mjs';

const SESSION_TTL_HOURS = 12;
const MAX_FAILED_ATTEMPTS = 8;
const ATTEMPT_WINDOW_MINUTES = 15;

export const ROLES = {
  owner: 'Владелец',
  buyer: 'Закупщик',
  admin: 'Администратор',
  seller: 'Продавец',
};

const PERMISSIONS = {
  owner: ['*'],
  buyer: [
    'catalog.view', 'catalog.manage',
    'suppliers.view', 'suppliers.manage',
    'purchase.view', 'purchase.create', 'purchase.edit', 'purchase.status', 'purchase.payments',
    'receipt.view', 'cost.view', 'stock.view', 'reports.purchases',
    'export.catalog', 'export.stock', 'export.purchases',
  ],
  admin: [
    'catalog.view', 'suppliers.view', 'purchase.view', 'receipt.view', 'stock.view',
    'reports.purchases', 'export.stock', 'export.purchases',
  ],
  seller: [
    'catalog.view',
    'stock.view',
    'sale.create', 'sale.view_own',
    'return.create',
    'reports.sales_own',
  ],
};

export function can(user, permission) {
  if (!user) return false;
  const perms = PERMISSIONS[user.role] || [];
  return perms.includes('*') || perms.includes(permission);
}

export function assertCan(user, permission, message) {
  if (!can(user, permission)) throw forbidden(message);
}

export function permissionsOf(user) {
  const perms = PERMISSIONS[user.role] || [];
  return perms.includes('*') ? ['*'] : [...perms];
}

export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { hash, salt };
}

export function verifyPassword(password, salt, expectedHash) {
  const actual = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHash, 'hex');
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function createSession(userId, ip) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_TTL_HOURS * 3600 * 1000);
  q.run(
    'INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at, ip) VALUES (?, ?, ?, ?, ?, ?)',
    hashToken(token), userId, now.toISOString(), expires.toISOString(), now.toISOString(), ip || null,
  );
  return { token, expiresAt: expires.toISOString() };
}

export function destroySession(token) {
  if (!token) return;
  q.run('DELETE FROM sessions WHERE id = ?', hashToken(token));
}

export function userFromToken(token) {
  if (!token) return null;
  const row = q.get(
    `SELECT u.*, s.expires_at FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.id = ?`,
    hashToken(token),
  );
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    q.run('DELETE FROM sessions WHERE id = ?', hashToken(token));
    return null;
  }
  if (!row.is_active) return null;
  q.run('UPDATE sessions SET last_seen_at = ? WHERE id = ?', new Date().toISOString(), hashToken(token));
  return {
    id: row.id,
    login: row.login,
    fullName: row.full_name,
    role: row.role,
    isActive: !!row.is_active,
  };
}

export function checkLoginRate(login, ip) {
  const since = new Date(Date.now() - ATTEMPT_WINDOW_MINUTES * 60 * 1000).toISOString();
  const row = q.get(
    'SELECT COUNT(*) AS c FROM login_attempts WHERE login = ? AND ip IS ? AND at >= ? AND success = 0',
    login, ip || null, since,
  );
  if (row.c >= MAX_FAILED_ATTEMPTS) {
    throw new AppError(429, 'Слишком много неудачных попыток входа. Повторите через 15 минут.');
  }
}

export function recordLoginAttempt(login, ip, success) {
  q.run('INSERT INTO login_attempts (login, ip, at, success) VALUES (?, ?, ?, ?)',
    login, ip || null, new Date().toISOString(), success ? 1 : 0);
  if (success) {
    q.run('DELETE FROM login_attempts WHERE login = ? AND success = 0', login);
  }
}

export function cleanupSessions() {
  q.run('DELETE FROM sessions WHERE expires_at < ?', new Date().toISOString());
}

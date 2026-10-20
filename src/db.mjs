import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

const DEFAULT_DIR = path.join(ROOT, 'data');
const DB_DIR = process.env.SRK_DATA_DIR ? path.resolve(process.env.SRK_DATA_DIR) : DEFAULT_DIR;
export const DB_FILE = path.join(DB_DIR, 'stockroom.db');

fs.mkdirSync(DB_DIR, { recursive: true });

const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA foreign_keys = ON;');
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA busy_timeout = 10000;');

export function migrate() {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);
  const dir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const applied = new Set(db.prepare('SELECT name FROM schema_migrations').all().map((r) => r.name));
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(file, new Date().toISOString());
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`Миграция ${file} не применена: ${err.message}`);
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
  }
}

export function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  }
}

export const q = {
  all(sql, ...params) { return db.prepare(sql).all(...params); },
  get(sql, ...params) { return db.prepare(sql).get(...params); },
  run(sql, ...params) { return db.prepare(sql).run(...params); },
};

export function nextNumber(prefix, name) {
  const key = name || prefix;
  const row = q.get('SELECT value FROM counters WHERE name = ?', key);
  if (row) {
    q.run('UPDATE counters SET value = value + 1 WHERE name = ?', key);
    return `${prefix}-${String(row.value + 1).padStart(5, '0')}`;
  }
  q.run('INSERT INTO counters (name, value) VALUES (?, 1)', key);
  return `${prefix}-00001`;
}

export function nextNumberLong(prefix, name) {
  const key = name || prefix;
  const now = new Date();
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
  const row = q.get('SELECT value FROM counters WHERE name = ?', key);
  if (row) {
    q.run('UPDATE counters SET value = value + 1 WHERE name = ?', key);
    return `${prefix}-${stamp}-${String(row.value + 1).padStart(4, '0')}`;
  }
  q.run('INSERT INTO counters (name, value) VALUES (?, 1)', key);
  return `${prefix}-${stamp}-0001`;
}

export function getSetting(key, fallback = null) {
  const row = q.get("SELECT value FROM settings WHERE key = ?", key);
  return row ? row.value : fallback;
}

export function setSetting(key, value) {
  q.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, String(value));
}

export { db };

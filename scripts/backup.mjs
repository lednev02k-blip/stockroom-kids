import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { db, DB_FILE, ROOT } from '../src/db.mjs';

const dir = process.env.SRK_BACKUP_DIR ? path.resolve(process.env.SRK_BACKUP_DIR) : path.join(ROOT, 'backups');
fs.mkdirSync(dir, { recursive: true });

const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
const target = path.join(dir, `stockroom-${stamp}.db`);

db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);

const copy = new DatabaseSync(target, { readOnly: true });
const check = copy.prepare('PRAGMA integrity_check').get();
copy.close();

if (!check || check.integrity_check !== 'ok') {
  console.error('Резервная копия повреждена:', JSON.stringify(check));
  process.exit(1);
}

const size = fs.statSync(target).size;
console.log(`Резервная копия создана: ${target} (${(size / 1024).toFixed(1)} КБ)`);
console.log(`Источник: ${DB_FILE}`);

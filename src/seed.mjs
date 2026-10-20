import { q, migrate, setSetting } from './db.mjs';
import { hashPassword } from './auth.mjs';

migrate();

const USERS = [
  { login: 'owner', fullName: 'Владелец магазина', role: 'owner', password: 'Owner#2026' },
  { login: 'buyer', fullName: 'Закупщик в Китае', role: 'buyer', password: 'Buyer#2026' },
  { login: 'admin', fullName: 'Администратор', role: 'admin', password: 'Admin#2026' },
  { login: 'seller', fullName: 'Продавец магазина', role: 'seller', password: 'Seller#2026' },
];

const CATEGORIES = ['Детская одежда', 'Нижнее белье', 'Детская обувь', 'Канцтовары', 'Украшения и аксессуары', 'Детская косметика'];

const created = [];
for (const user of USERS) {
  const existing = q.get('SELECT id FROM users WHERE login = ?', user.login);
  if (existing) continue;
  const { hash, salt } = hashPassword(user.password);
  q.run(
    'INSERT INTO users (login, full_name, role, password_hash, password_salt, is_active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)',
    user.login, user.fullName, user.role, hash, salt, new Date().toISOString(),
  );
  created.push(user);
}

for (const name of CATEGORIES) {
  if (!q.get('SELECT id FROM categories WHERE name = ?', name)) {
    q.run('INSERT INTO categories (name, sort) VALUES (?, 100)', name);
  }
}

const SETTINGS = {
  company_name: 'Stockroom Kids',
  currency: 'RUB',
  low_stock_threshold: '3',
  max_seller_discount_percent: '10',
  purchase_note: '',
};
for (const [key, value] of Object.entries(SETTINGS)) {
  if (q.get('SELECT key FROM settings WHERE key = ?', key) === undefined) setSetting(key, value);
}

if (created.length) {
  console.log('Созданы учётные записи:');
  for (const u of created) console.log(`  ${u.login} / ${u.password} — ${u.fullName}`);
  console.log('Смените пароли после первого входа (Настройки → Пароль).');
} else {
  console.log('Пользователи уже существуют, изменений нет.');
}

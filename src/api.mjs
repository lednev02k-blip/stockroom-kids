import fs from 'node:fs';
import path from 'node:path';
import { q, tx, getSetting } from './db.mjs';
import { AppError, bad, notFound } from './util.mjs';
import { can, createSession, destroySession, permissionsOf, ROLES, recordLoginAttempt, checkLoginRate, verifyPassword } from './auth.mjs';
import { audit } from './audit.mjs';
import {
  addVariant, createCategory, createProduct, getProduct, listCategories, listProducts,
  setProductPhoto, updateCategory, updateProduct, updateVariant,
} from './domain/catalog.mjs';
import { createSupplier, listSuppliers, updateSupplier } from './domain/suppliers.mjs';
import {
  addPayment, createPurchase, getPurchase, listPurchases, setPurchaseStatus, updatePurchase,
} from './domain/purchases.mjs';
import { createReceipt, deleteDraftReceipt, getReceipt, listReceipts, postReceipt, updateReceipt } from './domain/receipts.mjs';
import { createExpense, EXPENSE_CATEGORIES, ALLOCATION_METHODS } from './domain/expenses.mjs';
import {
  adjustStock, createInventory, getInventory, listInventory, listMovements, listStock, postInventory,
} from './domain/stock.mjs';
import { createSale, getSale, listSales } from './domain/sales.mjs';
import { createReturn, getReturn, listReturns } from './domain/returns.mjs';
import {
  catalogExport, dashboard, purchasesExport, purchasesReport, purchaseDetailReport,
  salesExport, salesReport, stockExport, stockReport,
} from './domain/reports.mjs';
import {
  changeOwnPassword, createUser, getSettings, listAudit, listUsers, systemInfo, updateSettings, updateUser,
} from './domain/admin.mjs';

const UPLOAD_DIR = path.join(path.resolve(import.meta.dirname, '..'), 'storage', 'uploads');

const routes = [];

function route(method, pattern, handler, options = {}) {
  const segments = pattern.split('/').filter(Boolean);
  routes.push({ method, segments, handler, options });
}

function match(routeSegments, pathSegments) {
  if (routeSegments.length !== pathSegments.length) return null;
  const params = {};
  for (let i = 0; i < routeSegments.length; i += 1) {
    const rs = routeSegments[i];
    if (rs.startsWith(':')) params[rs.slice(1)] = decodeURIComponent(pathSegments[i]);
    else if (rs !== pathSegments[i]) return null;
  }
  return params;
}

function num(value, field) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw bad(`Некорректное значение: ${field}`);
  return n;
}

function bool(value) {
  return value === true || value === 'true' || value === '1';
}

function queryObject(url) {
  const out = {};
  for (const [key, value] of url.searchParams.entries()) {
    if (value === '') continue;
    out[key] = value;
  }
  return out;
}

function userView(user) {
  return {
    id: user.id,
    login: user.login,
    fullName: user.fullName || user.full_name,
    role: user.role,
    roleLabel: ROLES[user.role] || user.role,
    permissions: permissionsOf(user),
  };
}

function requireAuth(ctx) {
  if (!ctx.user) throw new AppError(401, 'Требуется авторизация');
  return ctx.user;
}

function publicSettings() {
  return {
    companyName: getSetting('company_name', 'Stockroom Kids'),
    currency: getSetting('currency', 'RUB'),
    lowStockThreshold: Number(getSetting('low_stock_threshold', '3')),
    maxSellerDiscountPercent: Number(getSetting('max_seller_discount_percent', '10')),
    purchaseNote: getSetting('purchase_note', ''),
  };
}

function login(ctx) {
  const body = ctx.body || {};
  const loginValue = String(body.login || '').trim().toLowerCase();
  const password = String(body.password || '');
  const ip = ctx.ip || ctx.req.socket.remoteAddress || '';
  if (!loginValue || !password) throw bad('Укажите логин и пароль');
  checkLoginRate(loginValue, ip);
  const user = q.get('SELECT * FROM users WHERE login = ?', loginValue);
  if (!user || !verifyPassword(password, user.password_salt, user.password_hash)) {
    recordLoginAttempt(loginValue, ip, false);
    throw new AppError(401, 'Неверный логин или пароль');
  }
  if (!user.is_active) {
    recordLoginAttempt(loginValue, ip, false);
    throw new AppError(403, 'Учётная запись деактивирована');
  }
  recordLoginAttempt(loginValue, ip, true);
  const session = createSession(user.id, ip);
  ctx.setSessionCookie(session.token, session.expiresAt);
  q.run('UPDATE users SET last_login_at = ? WHERE id = ?', new Date().toISOString(), user.id);
  audit({ id: user.id, login: user.login }, 'auth.login', 'user', user.id, { ip });
  return {
    user: userView({ ...user, isActive: true }),
    expiresAt: session.expiresAt,
  };
}

route('POST', '/api/auth/login', login, { public: true });

route('POST', '/api/auth/logout', (ctx) => {
  requireAuth(ctx);
  destroySession(ctx.token);
  ctx.clearSessionCookie();
  audit(ctx.user, 'auth.logout', 'user', ctx.user.id, null);
  return { ok: true };
});

route('GET', '/api/auth/me', (ctx) => {
  requireAuth(ctx);
  return { user: userView(ctx.user) };
});

route('GET', '/api/bootstrap', (ctx) => {
  requireAuth(ctx);
  const user = ctx.user;
  const categories = can(user, 'catalog.view') ? listCategories(user) : [];
  const suppliers = can(user, 'suppliers.view') ? listSuppliers(user) : [];
  return {
    user: userView(user),
    settings: publicSettings(),
    categories,
    suppliers,
    roles: ROLES,
    expenseCategories: EXPENSE_CATEGORIES,
    allocationMethods: ALLOCATION_METHODS,
    sellerDiscountLimit: Number(getSetting('max_seller_discount_percent', '10')),
  };
});

route('GET', '/api/dashboard', (ctx) => {
  requireAuth(ctx);
  return dashboard(ctx.user);
});

route('GET', '/api/categories', (ctx) => {
  requireAuth(ctx);
  return listCategories(ctx.user);
});
route('POST', '/api/categories', (ctx) => createCategory(ctx.user, ctx.body));
route('PATCH', '/api/categories/:id', (ctx) => updateCategory(ctx.user, Number(ctx.params.id), ctx.body));

route('GET', '/api/suppliers', (ctx) => listSuppliers(ctx.user));
route('POST', '/api/suppliers', (ctx) => createSupplier(ctx.user, ctx.body));
route('PATCH', '/api/suppliers/:id', (ctx) => updateSupplier(ctx.user, Number(ctx.params.id), ctx.body));

route('GET', '/api/products', (ctx) => {
  requireAuth(ctx);
  return listProducts(ctx.user, {
    ...queryObject(ctx.url),
    inStock: bool(ctx.url.searchParams.get('inStock')),
    includeArchived: bool(ctx.url.searchParams.get('includeArchived')),
  });
});
route('POST', '/api/products', (ctx) => createProduct(ctx.user, ctx.body));
route('GET', '/api/products/:id', (ctx) => getProduct(ctx.user, Number(ctx.params.id)));
route('PATCH', '/api/products/:id', (ctx) => updateProduct(ctx.user, Number(ctx.params.id), ctx.body));
route('POST', '/api/products/:id/variants', (ctx) => addVariant(ctx.user, Number(ctx.params.id), ctx.body));
route('POST', '/api/products/:id/photo', (ctx) => setProductPhoto(ctx.user, Number(ctx.params.id), ctx.body.dataUrl));
route('PATCH', '/api/variants/:id', (ctx) => updateVariant(ctx.user, Number(ctx.params.id), ctx.body));

route('GET', '/api/media/:file', (ctx) => {
  requireAuth(ctx);
  const file = String(ctx.params.file);
  if (!/^[a-zA-Z0-9._-]+\.(jpg|jpeg|png|webp)$/.test(file)) throw notFound('Файл не найден');
  const filePath = path.join(UPLOAD_DIR, file);
  if (!fs.existsSync(filePath)) throw notFound('Файл не найден');
  const ext = path.extname(file).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  ctx.sendFile(filePath, mime);
  return undefined;
});

route('GET', '/api/purchases', (ctx) => listPurchases(ctx.user, queryObject(ctx.url)));
route('POST', '/api/purchases', (ctx) => createPurchase(ctx.user, ctx.body));
route('GET', '/api/purchases/:id', (ctx) => getPurchase(ctx.user, Number(ctx.params.id)));
route('PATCH', '/api/purchases/:id', (ctx) => updatePurchase(ctx.user, Number(ctx.params.id), ctx.body));
route('POST', '/api/purchases/:id/status', (ctx) => setPurchaseStatus(ctx.user, Number(ctx.params.id), ctx.body.status, ctx.body.comment));
route('POST', '/api/purchases/:id/payments', (ctx) => addPayment(ctx.user, Number(ctx.params.id), ctx.body));
route('POST', '/api/purchases/:id/expenses', (ctx) => createExpense(ctx.user, Number(ctx.params.id), ctx.body));
route('POST', '/api/purchases/:id/receipts', (ctx) => createReceipt(ctx.user, Number(ctx.params.id), ctx.body));

route('GET', '/api/receipts', (ctx) => listReceipts(ctx.user, queryObject(ctx.url)));
route('GET', '/api/receipts/:id', (ctx) => getReceipt(ctx.user, Number(ctx.params.id)));
route('PATCH', '/api/receipts/:id', (ctx) => updateReceipt(ctx.user, Number(ctx.params.id), ctx.body));
route('POST', '/api/receipts/:id/post', (ctx) => postReceipt(ctx.user, Number(ctx.params.id)));
route('DELETE', '/api/receipts/:id', (ctx) => deleteDraftReceipt(ctx.user, Number(ctx.params.id)));

route('GET', '/api/stock', (ctx) => listStock(ctx.user, {
  ...queryObject(ctx.url),
  low: bool(ctx.url.searchParams.get('low')),
}));
route('GET', '/api/stock/movements', (ctx) => listMovements(ctx.user, queryObject(ctx.url)));
route('POST', '/api/stock/adjustments', (ctx) => adjustStock(ctx.user, ctx.body));
route('POST', '/api/stock/writeoffs', (ctx) => {
  const qty = Math.abs(num(ctx.body.qty, 'количество'));
  return adjustStock(ctx.user, { variantId: ctx.body.variantId, qtyDelta: -qty, reason: ctx.body.reason });
});
route('GET', '/api/inventory', (ctx) => listInventory(ctx.user));
route('POST', '/api/inventory', (ctx) => createInventory(ctx.user, ctx.body));
route('GET', '/api/inventory/:id', (ctx) => getInventory(ctx.user, Number(ctx.params.id)));
route('POST', '/api/inventory/:id/post', (ctx) => postInventory(ctx.user, Number(ctx.params.id)));

route('GET', '/api/sales', (ctx) => listSales(ctx.user, queryObject(ctx.url)));
route('POST', '/api/sales', (ctx) => createSale(ctx.user, ctx.body));
route('GET', '/api/sales/:id', (ctx) => getSale(ctx.user, Number(ctx.params.id)));

route('GET', '/api/returns', (ctx) => listReturns(ctx.user, queryObject(ctx.url)));
route('POST', '/api/returns', (ctx) => createReturn(ctx.user, ctx.body));
route('GET', '/api/returns/:id', (ctx) => getReturn(ctx.user, Number(ctx.params.id)));

route('GET', '/api/reports/stock', (ctx) => stockReport(ctx.user, queryObject(ctx.url)));
route('GET', '/api/reports/sales', (ctx) => salesReport(ctx.user, queryObject(ctx.url)));
route('GET', '/api/reports/purchases', (ctx) => purchasesReport(ctx.user, queryObject(ctx.url)));
route('GET', '/api/reports/purchase/:id', (ctx) => purchaseDetailReport(ctx.user, Number(ctx.params.id)));

route('GET', '/api/export/catalog.csv', (ctx) => {
  ctx.sendCsv(`catalog-${new Date().toISOString().slice(0, 10)}.csv`, catalogExport(ctx.user));
  return undefined;
});
route('GET', '/api/export/stock.csv', (ctx) => {
  ctx.sendCsv(`stock-${new Date().toISOString().slice(0, 10)}.csv`, stockExport(ctx.user, queryObject(ctx.url)));
  return undefined;
});
route('GET', '/api/export/sales.csv', (ctx) => {
  ctx.sendCsv(`sales-${new Date().toISOString().slice(0, 10)}.csv`, salesExport(ctx.user, queryObject(ctx.url)));
  return undefined;
});
route('GET', '/api/export/purchases.csv', (ctx) => {
  ctx.sendCsv(`purchases-${new Date().toISOString().slice(0, 10)}.csv`, purchasesExport(ctx.user, queryObject(ctx.url)));
  return undefined;
});

route('GET', '/api/users', (ctx) => listUsers(ctx.user));
route('POST', '/api/users', (ctx) => createUser(ctx.user, ctx.body));
route('PATCH', '/api/users/:id', (ctx) => updateUser(ctx.user, Number(ctx.params.id), ctx.body));
route('POST', '/api/users/me/password', (ctx) => changeOwnPassword(ctx.user, ctx.body));

route('GET', '/api/audit', (ctx) => listAudit(ctx.user, queryObject(ctx.url)));
route('GET', '/api/settings', (ctx) => getSettings(ctx.user));
route('PATCH', '/api/settings', (ctx) => updateSettings(ctx.user, ctx.body));
route('GET', '/api/system', (ctx) => systemInfo(ctx.user));

route('GET', '/api/health', () => ({ ok: true, time: new Date().toISOString() }), { public: true });

export async function handleApi(ctx) {
  const pathSegments = ctx.url.pathname.split('/').filter(Boolean);
  for (const r of routes) {
    if (r.method !== ctx.req.method) continue;
    const params = match(r.segments, pathSegments);
    if (!params) continue;
    if (!r.options.public) requireAuth(ctx);
    const exec = () => r.handler({ ...ctx, params });
    const mutating = ctx.req.method !== 'GET' && ctx.req.method !== 'HEAD';
    const result = mutating ? tx(exec) : exec();
    return result;
  }
  throw notFound(`Метод ${ctx.req.method} ${ctx.url.pathname} не найден`);
}

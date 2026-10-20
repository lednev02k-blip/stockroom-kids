import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3200 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'srk-accept-'));

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, details = '') {
  if (condition) {
    passed += 1;
    console.log(`  OK   ${name}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  FAIL ${name}${details ? ` :: ${details}` : ''}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

function runNode(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      env: { ...process.env, SRK_DATA_DIR: DATA_DIR, PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(`${args.join(' ')} завершился с кодом ${code}: ${out}`))));
  });
}

function client() {
  let cookie = '';
  return async function call(method, route, body) {
    const res = await fetch(BASE + route, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(cookie ? { cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { status: res.status, data };
  };
}

async function login(loginValue, password) {
  const c = client();
  const res = await c('POST', '/api/auth/login', { login: loginValue, password });
  if (res.status !== 200) throw new Error(`Не удалось войти как ${loginValue}: ${res.data && res.data.error}`);
  return c;
}

function money(kop) {
  return `${(Number(kop) / 100).toFixed(2)} ₽`;
}

await runNode(['src/seed.mjs']);

const server = spawn(process.execPath, ['src/server.mjs'], {
  cwd: ROOT,
  env: { ...process.env, SRK_DATA_DIR: DATA_DIR, PORT: String(PORT), HOST: '127.0.0.1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });

async function waitForServer() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch { /* сервер ещё поднимается */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Сервер не запустился: ${serverLog}`);
}
await waitForServer();

async function shutdown() {
  const exited = new Promise((resolve) => server.once('exit', resolve));
  server.kill();
  await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
  try {
    fs.rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  } catch { /* временная папка может остаться заблокированной процессом ОС */ }
}

try {
  const owner = await login('owner', 'Owner#2026');
  const buyer = await login('buyer', 'Buyer#2026');
  const seller = await login('seller', 'Seller#2026');

  section('Каталог');
  const supplier = await owner('POST', '/api/suppliers', { name: 'Тест Поставщик', country: 'Китай' });
  check('создан поставщик', supplier.status === 200, JSON.stringify(supplier.data));

  const product = await owner('POST', '/api/products', {
    sku: 'JK-025',
    name: 'Куртка детская',
    categoryId: 1,
    unit: 'шт',
    variants: [
      { size: '98', color: 'черный', retail_price: '1500' },
      { size: '104', color: 'черный', retail_price: '1500' },
      { size: '98', color: 'бежевый', retail_price: '1550' },
    ],
  });
  check('товар создан с тремя вариантами', product.status === 200 && product.data.variants.length === 3, JSON.stringify(product.data).slice(0, 200));
  const productId = product.data.id;
  const [v98black, v104black, v98beige] = product.data.variants;

  const duplicate = await owner('POST', '/api/products', { sku: 'JK-025', name: 'Дубль' });
  check('дублирующийся артикул отклонён', duplicate.status === 409 && /артикул/i.test(duplicate.data.error), JSON.stringify(duplicate.data));

  const search = await owner('GET', '/api/products?search=JK-025');
  check('поиск по артикулу находит товар', search.status === 200 && search.data.length === 1 && search.data[0].variants.length === 3);

  const variantSearch = await owner('GET', '/api/products?search=beige');
  check('поиск по несуществующему запросу не ломает выборку', variantSearch.status === 200 && variantSearch.data.length === 0);

  section('Закупка');
  const purchase = await owner('POST', '/api/purchases', {
    supplierId: supplier.data.id,
    rate: '12',
    rateDate: new Date().toISOString(),
    items: [{ variantId: v98black.id, qty: 50, priceCny: '25' }],
  });
  check('закупка создана в статусе черновик', purchase.status === 200 && purchase.data.status === 'draft');
  check('рублёвый эквивалент рассчитан по курсу', purchase.data.totals.goodsKop === 1500000, money(purchase.data.totals.goodsKop));
  const purchaseId = purchase.data.id;

  for (const status of ['pending_approval', 'approved', 'ordered']) {
    const res = await owner('POST', `/api/purchases/${purchaseId}/status`, { status });
    check(`статус закупки → ${status}`, res.status === 200 && res.data.status === status, JSON.stringify(res.data).slice(0, 160));
  }

  const stockBeforeReceipt = await owner('GET', '/api/stock');
  const before = stockBeforeReceipt.data.find((s) => s.variantId === v98black.id);
  check('заказанное количество не увеличивает остаток', before.qty === 0, `остаток ${before.qty}`);

  section('Приёмка');
  const receipt = await owner('POST', `/api/purchases/${purchaseId}/receipts`, { clientRef: 'acc-receipt-1' });
  check('приёмка создана как черновик', receipt.status === 200 && receipt.data.status === 'draft');
  const receiptId = receipt.data.id;

  const patched = await owner('PATCH', `/api/receipts/${receiptId}`, {
    items: [{ id: receipt.data.items[0].id, qtyReceived: 47, qtyDamaged: 0 }],
  });
  check('фактическое количество сохранено', patched.status === 200 && patched.data.items[0].qtyReceived === 47);

  const posted = await owner('POST', `/api/receipts/${receiptId}/post`, {});
  check('приёмка проведена', posted.status === 200 && posted.data.status === 'posted');

  const stockAfterReceipt = await owner('GET', '/api/stock');
  const afterReceipt = stockAfterReceipt.data.find((s) => s.variantId === v98black.id);
  check('на склад поступило ровно 47 единиц', afterReceipt.qty === 47, `остаток ${afterReceipt.qty}`);

  const repost = await owner('POST', `/api/receipts/${receiptId}/post`, {});
  check('повторное проведение приёмки отклонено', repost.status === 409);
  const stockAfterRepost = await owner('GET', '/api/stock');
  check('повторное проведение не удвоило приход', stockAfterRepost.data.find((s) => s.variantId === v98black.id).qty === 47);

  const purchaseAfter = await owner('GET', `/api/purchases/${purchaseId}`);
  check('недопоставка видна в закупке', purchaseAfter.data.items[0].shortage === 3 && purchaseAfter.data.totals.inTransitQty === 3);
  check('статус закупки — частично получена', purchaseAfter.data.status === 'partially_received');

  section('Себестоимость');
  const expense = await owner('POST', `/api/purchases/${purchaseId}/expenses`, {
    category: 'delivery',
    amount: '5000',
    currency: 'RUB',
    method: 'value',
    receiptId,
    comment: 'Доставка партии',
  });
  check('расход добавлен и распределён', expense.status === 200 && expense.data.applied === true, JSON.stringify(expense.data).slice(0, 200));

  const stockAfterExpense = await owner('GET', '/api/stock');
  const withCost = stockAfterExpense.data.find((s) => s.variantId === v98black.id);
  const expectedValue = 1410000 + 500000;
  const expectedUnit = Math.round((expectedValue * 10000) / 47);
  check('стоимость запаса = товар + расходы', withCost.valueKop === expectedValue, `${withCost.valueKop} vs ${expectedValue}`);
  check('себестоимость единицы пересчитана', withCost.avgCostX10000 === expectedUnit, `${withCost.avgCostX10000} vs ${expectedUnit}`);

  const duplicateExpense = await owner('POST', `/api/purchases/${purchaseId}/expenses`, {
    category: 'other',
    amount: '100',
    currency: 'RUB',
    method: 'manual',
    receiptId,
    allocations: [{ receiptItemId: receipt.data.items[0].id, amount: '90' }],
  });
  check('ручное распределение с неверной суммой отклонено', duplicateExpense.status === 400, JSON.stringify(duplicateExpense.data));

  const rateUnchanged = await owner('GET', `/api/purchases/${purchaseId}`);
  check('исторический курс закупки не изменился', rateUnchanged.data.rateX10000 === 120000, String(rateUnchanged.data.rateX10000));

  section('Продажи');
  const sale1 = await seller('POST', '/api/sales', {
    clientRef: 'acc-sale-1',
    items: [{ variantId: v98black.id, qty: 2, priceKop: 150000 }],
  });
  check('продажа проведена', sale1.status === 200 && sale1.data.totalKop === 300000, JSON.stringify(sale1.data).slice(0, 160));
  const saleId = sale1.data.id;

  const stockAfterSale = await seller('GET', '/api/stock');
  check('продажа уменьшила остаток', stockAfterSale.data.find((s) => s.variantId === v98black.id).qty === 45);

  const oversell = await seller('POST', '/api/sales', { items: [{ variantId: v98black.id, qty: 1000 }] });
  check('продажа сверх остатка отклонена', oversell.status === 409, JSON.stringify(oversell.data));

  const repeatSale = await seller('POST', '/api/sales', {
    clientRef: 'acc-sale-1',
    items: [{ variantId: v98black.id, qty: 2, priceKop: 150000 }],
  });
  check('повторная отправка запроса не создаёт дубль', repeatSale.status === 200 && repeatSale.data.id === saleId);
  const stockAfterRepeat = await seller('GET', '/api/stock');
  check('повторный запрос не списал товар ещё раз', stockAfterRepeat.data.find((s) => s.variantId === v98black.id).qty === 45);

  const saleDetail = await owner('GET', `/api/sales/${saleId}`);
  check('себестоимость продажи зафиксирована', saleDetail.data.costTotalKop > 0 && saleDetail.data.profitKop > 0, JSON.stringify({ cost: saleDetail.data.costTotalKop, profit: saleDetail.data.profitKop }));

  const lastUnits = await owner('POST', '/api/stock/adjustments', {
    variantId: v104black.id, qty: 1, reason: 'Подготовка теста параллельных продаж',
  });
  check('корректировка остатка выполнена', lastUnits.status === 200 && lastUnits.data.qty === 1);

  const [race1, race2] = await Promise.all([
    seller('POST', '/api/sales', { clientRef: 'race-1', items: [{ variantId: v104black.id, qty: 1 }] }),
    owner('POST', '/api/sales', { clientRef: 'race-2', items: [{ variantId: v104black.id, qty: 1 }] }),
  ]);
  const raceStatuses = [race1.status, race2.status].sort();
  check('две одновременные продажи последней единицы: одна успешна', raceStatuses[0] === 200 && raceStatuses[1] === 409, raceStatuses.join(','));
  const stockRace = await owner('GET', '/api/stock');
  check('отрицательного остатка не возникло', stockRace.data.find((s) => s.variantId === v104black.id).qty === 0);

  section('Возвраты');
  const saleForReturn = await seller('GET', `/api/sales/${saleId}`);
  const saleItem = saleForReturn.data.items[0];
  const ret = await seller('POST', '/api/returns', {
    clientRef: 'acc-ret-1',
    saleId,
    reason: 'Не подошёл размер',
    items: [{ saleItemId: saleItem.id, qty: 1, condition: 'sellable' }],
  });
  check('возврат оформлен и связан с продажей', ret.status === 200 && ret.data.saleId === saleId, JSON.stringify(ret.data).slice(0, 160));

  const stockAfterReturn = await seller('GET', '/api/stock');
  check('возврат пригодного товара увеличил остаток', stockAfterReturn.data.find((s) => s.variantId === v98black.id).qty === 46);

  const repeatReturn = await seller('POST', '/api/returns', {
    saleId,
    reason: 'Повтор',
    items: [{ saleItemId: saleItem.id, qty: 2, condition: 'sellable' }],
  });
  check('повторный возврат сверх проданного отклонён', repeatReturn.status === 409, JSON.stringify(repeatReturn.data));

  const damaged = await seller('POST', '/api/returns', {
    saleId,
    reason: 'Брак',
    items: [{ saleItemId: saleItem.id, qty: 1, condition: 'damaged' }],
  });
  check('возврат повреждённого товара принят', damaged.status === 200);
  const stockAfterDamaged = await seller('GET', '/api/stock');
  check('повреждённый товар не увеличил остаток', stockAfterDamaged.data.find((s) => s.variantId === v98black.id).qty === 46);

  section('Права доступа');
  const sellerStock = await seller('GET', '/api/stock');
  check('продавец не видит себестоимость', sellerStock.data.every((s) => s.avgCostX10000 === undefined && s.valueKop === undefined));

  const sellerSale = await seller('GET', `/api/sales/${saleId}`);
  check('продавец не видит себестоимость продажи', sellerSale.data.costTotalKop === undefined && sellerSale.data.profitKop === undefined);

  const sellerDashboard = await seller('GET', '/api/dashboard');
  check('продавец не видит прибыль магазина', sellerDashboard.data.monthProfitKop === null && sellerDashboard.data.stockValueKop === null);

  const buyerPatchPrice = await buyer('PATCH', `/api/variants/${v98black.id}`, { retail_price: '2000' });
  check('закупщик не может менять розничную цену', buyerPatchPrice.status === 403, JSON.stringify(buyerPatchPrice.data));

  const buyerPatchCatalog = await buyer('PATCH', `/api/variants/${v98black.id}`, { color: 'черный' });
  check('закупщик может править вариант без цены', buyerPatchCatalog.status === 200);

  const sellerAdjust = await seller('POST', '/api/stock/adjustments', { variantId: v98black.id, qty: 10, reason: 'Попытка' });
  check('продавец не может корректировать склад', sellerAdjust.status === 403, JSON.stringify(sellerAdjust.data));

  const buyerProfitReport = await buyer('GET', '/api/reports/sales?from=2026-01-01T00:00:00&to=2030-01-01T00:00:00');
  check('закупщику закрыт отчёт по прибыли', buyerProfitReport.status === 403, JSON.stringify(buyerProfitReport.data));

  const sellerPurchases = await seller('GET', '/api/purchases');
  check('продавцу закрыты закупки', sellerPurchases.status === 403);

  const anonymous = client();
  const noAuth = await anonymous('GET', '/api/stock');
  check('без авторизации API недоступно', noAuth.status === 401);

  section('Отчёты и журнал');
  const stockReport = await owner('GET', '/api/reports/stock');
  const stockTotal = stockReport.data.items.reduce((acc, i) => acc + i.qty, 0);
  check('отчёт по остаткам строится по фактическим данным', stockReport.data.totals.qty === stockTotal && stockTotal === 46, `${stockTotal}`);

  const salesReport = await owner('GET', '/api/reports/sales?from=2026-01-01T00:00:00&to=2030-01-01T00:00:00');
  check('отчёт по продажам содержит реальные суммы', salesReport.data.summary.revenueKop > 0 && salesReport.data.rows.length > 0);

  const purchasesReport = await owner('GET', '/api/reports/purchases?from=2026-01-01T00:00:00&to=2030-01-01T00:00:00');
  check('отчёт по закупкам отражает полученное количество', purchasesReport.data.summary.receivedQty === 47, `${purchasesReport.data.summary.receivedQty}`);

  const audit = await owner('GET', '/api/audit?limit=200');
  const actions = audit.data.map((a) => a.action);
  check('журнал содержит проведение приёмки и продаж', actions.includes('receipt.post') && actions.includes('sale.create'), actions.slice(0, 5).join(','));
  check('журнал содержит изменения статусов закупки', actions.includes('purchase.status'));

  const salesBeforeFailure = await owner('GET', '/api/sales?from=2026-01-01T00:00:00&to=2030-01-01T00:00:00');
  await owner('POST', '/api/sales', { items: [{ variantId: v98beige.id, qty: 5 }] });
  const salesAfterFailure = await owner('GET', '/api/sales?from=2026-01-01T00:00:00&to=2030-01-01T00:00:00');
  check('неудачная продажа не оставила документ', salesBeforeFailure.data.length === salesAfterFailure.data.length);

  section('Сохранность данных');
  const ownerAgain = await login('owner', 'Owner#2026');
  const afterRelogin = await ownerAgain('GET', '/api/products');
  check('данные доступны после повторного входа', afterRelogin.status === 200 && afterRelogin.data.some((p) => p.sku === 'JK-025'));

  const dbFile = path.join(DATA_DIR, 'stockroom.db');
  check('файл базы данных создан', fs.existsSync(dbFile) && fs.statSync(dbFile).size > 0);

  const exportCatalog = await owner('GET', '/api/export/catalog.csv');
  check('экспорт каталога доступен владельцу', exportCatalog.status === 200);
  const buyerExport = await buyer('GET', '/api/export/purchases.csv');
  check('экспорт закупок доступен закупщику', buyerExport.status === 200);
  const sellerExport = await seller('GET', '/api/export/catalog.csv');
  check('экспорт каталога закрыт продавцу', sellerExport.status === 403);

  section('Настройки и уведомления');
  const settingsUpdate = await owner('PATCH', '/api/settings', { low_stock_threshold: 5 });
  check('настройки сохраняются', settingsUpdate.status === 200 && Number(settingsUpdate.data.low_stock_threshold) === 5);
  const settingsDenied = await seller('PATCH', '/api/settings', { low_stock_threshold: 1 });
  check('продавцу закрыты настройки', settingsDenied.status === 403);
} catch (err) {
  failed += 1;
  failures.push('исключение');
  console.error('\nТест прерван:', err.message);
  if (serverLog) console.error(serverLog.slice(-800));
} finally {
  await shutdown();
}

console.log(`\nПройдено: ${passed}, провалено: ${failed}`);
if (failed) {
  console.log('Проваленные проверки:');
  for (const f of failures) console.log(` - ${f}`);
  process.exit(1);
}
console.log('Все приёмочные проверки пройдены.');

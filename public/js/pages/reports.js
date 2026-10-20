import {
  api, can, dateOnly, dt, el, emptyState, esc, money, monthStartInput, num, options, pageHeader,
  state, stockChip, todayInput,
} from '../core.js';

const stateTabs = { tab: 'stock', from: monthStartInput(), to: todayInput(), search: '', low: false };

function rangeParams(extra = {}) {
  const params = new URLSearchParams({
    from: `${stateTabs.from}T00:00:00`,
    to: `${stateTabs.to}T23:59:59`,
    ...extra,
  });
  return params;
}

export async function renderReports(rest, ctx) {
  const available = [
    can('stock.view') ? { id: 'stock', name: 'Остатки' } : null,
    can('sale.create') ? { id: 'sales', name: 'Продажи' } : null,
    can('reports.purchases') ? { id: 'purchases', name: 'Закупки' } : null,
  ].filter(Boolean);
  if (!available.length) {
    return el('<div class="card"><div class="empty">Отчёты недоступны для вашей роли</div></div>');
  }
  if (!available.some((t) => t.id === stateTabs.tab)) stateTabs.tab = available[0].id;

  const root = el(`<div>
    ${pageHeader({ title: 'Отчёты', subtitle: 'Запасы, продажи и закупки по фактическим данным' })}
    <div class="tabs">
      ${available.map((t) => `<button class="tab" data-tab="${t.id}">${esc(t.name)}</button>`).join('')}
    </div>
    <div data-body></div>
  </div>`);

  const body = root.querySelector('[data-body]');
  root.querySelectorAll('[data-tab]').forEach((t) => {
    t.classList.toggle('active', t.dataset.tab === stateTabs.tab);
    t.addEventListener('click', () => {
      stateTabs.tab = t.dataset.tab;
      root.querySelectorAll('[data-tab]').forEach((x) => x.classList.toggle('active', x === t));
      load();
    });
  });

  async function load() {
    body.innerHTML = '<div class="card"><div class="skeleton"></div><div class="skeleton"></div></div>';
    if (stateTabs.tab === 'sales') return loadSales();
    if (stateTabs.tab === 'purchases') return loadPurchases();
    return loadStock();
  }

  async function loadStock() {
    const params = new URLSearchParams();
    if (stateTabs.search) params.set('search', stateTabs.search);
    if (stateTabs.low) params.set('low', '1');
    params.set('lowThreshold', String(state.settings.lowStockThreshold || 3));
    try {
      const data = await api(`/api/reports/stock?${params.toString()}`);
      body.innerHTML = `
        <div class="card">
          <div class="inline-form">
            <input class="input" style="flex:1 1 220px" type="search" data-search placeholder="Артикул или название" value="${esc(stateTabs.search)}">
            <label class="row tight small"><input type="checkbox" data-low ${stateTabs.low ? 'checked' : ''}> Только низкий остаток</label>
            ${can('export.stock') ? '<a class="btn btn-sm" href="/api/export/stock.csv">Экспорт CSV</a>' : ''}
          </div>
          <div class="detail-grid section-gap">
            <div class="detail-item"><div class="k">Вариантов</div><div class="v">${num(data.totals.variants)}</div></div>
            <div class="detail-item"><div class="k">Единиц на складе</div><div class="v">${num(data.totals.qty)}</div></div>
            ${data.totals.valueKop !== null ? `<div class="detail-item"><div class="k">Стоимость запасов</div><div class="v">${money(data.totals.valueKop)}</div></div>` : ''}
          </div>
        </div>
        <div class="section-gap">
          ${data.items.length ? `
            <div class="card">
              <div class="table-wrap">
                <table class="table">
                  <thead><tr>
                    <th>Артикул</th><th>Наименование</th><th>Размер</th><th>Цвет</th>
                    <th class="num">Остаток</th><th class="num">Розничная</th>
                    ${can('cost.view') ? '<th class="num">Себестоимость</th><th class="num">Стоимость запаса</th>' : ''}
                  </tr></thead>
                  <tbody>
                    ${data.items.map((r) => `
                      <tr>
                        <td class="mono">${esc(r.sku)}</td>
                        <td>${esc(r.name)}</td>
                        <td>${esc(r.size || '—')}</td>
                        <td>${esc(r.color || '—')}</td>
                        <td class="num">${stockChip(r.qty, state.settings.lowStockThreshold || 3)}</td>
                        <td class="num">${money(r.retailPriceKop)}</td>
                        ${can('cost.view') ? `<td class="num">${money(Math.round((r.avgCostX10000 || 0) / 10000 * 100))}</td><td class="num">${money(r.valueKop)}</td>` : ''}
                      </tr>`).join('')}
                  </tbody>
                </table>
              </div>
            </div>` : `<div class="card">${emptyState('Нет данных по выбранным условиям')}</div>`}
        </div>`;
      let timer = null;
      body.querySelector('[data-search]').addEventListener('input', (e) => {
        stateTabs.search = e.target.value.trim();
        clearTimeout(timer);
        timer = setTimeout(loadStock, 220);
      });
      body.querySelector('[data-low]').addEventListener('change', (e) => {
        stateTabs.low = e.target.checked;
        loadStock();
      });
    } catch (err) {
      body.innerHTML = `<div class="card"><div class="error-box">${esc(err.message)}</div></div>`;
    }
  }

  async function loadSales() {
    const params = rangeParams(stateTabs.search ? { search: stateTabs.search } : {});
    try {
      const data = await api(`/api/reports/sales?${params.toString()}`);
      const s = data.summary;
      body.innerHTML = `
        <div class="card">
          <div class="inline-form">
            <input class="input" type="date" style="flex:0 0 160px" data-from value="${stateTabs.from}" aria-label="С даты">
            <input class="input" type="date" style="flex:0 0 160px" data-to value="${stateTabs.to}" aria-label="По дату">
            <input class="input" style="flex:1 1 200px" type="search" data-search placeholder="Артикул или название" value="${esc(stateTabs.search)}">
            <a class="btn btn-sm" data-export-sales href="#">Экспорт CSV</a>
          </div>
        </div>
        <div class="grid cols-4 section-gap">
          <div class="card kpi"><div class="kpi-label">Продаж</div><div class="kpi-value">${num(s.salesCount)}</div><div class="kpi-note">${num(s.qty)} шт</div></div>
          <div class="card kpi"><div class="kpi-label">Выручка</div><div class="kpi-value">${money(s.revenueKop)}</div></div>
          <div class="card kpi"><div class="kpi-label">Возвраты</div><div class="kpi-value">${money(s.returnsKop)}</div><div class="kpi-note">${num(s.returnsCount)} док.</div></div>
          ${s.profitKop !== null ? `<div class="card kpi"><div class="kpi-label">Валовая прибыль</div><div class="kpi-value">${money(s.profitKop)}</div><div class="kpi-note">чистая выручка ${money(s.netRevenueKop)}</div></div>` : ''}
        </div>
        <div class="section-gap">
          ${data.rows.length ? `
            <div class="card">
              <div class="table-wrap">
                <table class="table">
                  <thead><tr>
                    <th>Номер</th><th>Дата</th><th>Продавец</th><th>Позиции</th>
                    <th class="num">Количество</th><th class="num">Выручка</th>
                    ${s.costKop !== null ? '<th class="num">Себестоимость</th>' : ''}
                    ${s.profitKop !== null ? '<th class="num">Прибыль</th>' : ''}
                  </tr></thead>
                  <tbody>
                    ${data.rows.map((r) => `
                      <tr>
                        <td class="mono"><a href="#/sales/${r.id}">${esc(r.number)}</a></td>
                        <td class="small nowrap">${dt(r.soldAt)}</td>
                        <td>${esc(r.sellerName)}</td>
                        <td class="small muted">${r.items.map((i) => `${esc(i.name)} (${i.qty})`).join(', ')}</td>
                        <td class="num">${num(r.qty)}</td>
                        <td class="num">${money(r.totalKop)}</td>
                        ${s.costKop !== null ? `<td class="num">${money(r.costKop)}</td>` : ''}
                        ${s.profitKop !== null ? `<td class="num">${money(r.profitKop)}</td>` : ''}
                      </tr>`).join('')}
                  </tbody>
                </table>
              </div>
            </div>` : `<div class="card">${emptyState('Продаж за период нет')}</div>`}
        </div>`;
      const exportSales = body.querySelector('[data-export-sales]');
      if (exportSales) exportSales.href = `/api/export/sales.csv?${params.toString()}`;
      body.querySelector('[data-from]').addEventListener('change', (e) => { stateTabs.from = e.target.value; loadSales(); });
      body.querySelector('[data-to]').addEventListener('change', (e) => { stateTabs.to = e.target.value; loadSales(); });
      let timer = null;
      body.querySelector('[data-search]').addEventListener('input', (e) => {
        stateTabs.search = e.target.value.trim();
        clearTimeout(timer);
        timer = setTimeout(loadSales, 240);
      });
    } catch (err) {
      body.innerHTML = `<div class="card"><div class="error-box">${esc(err.message)}</div></div>`;
    }
  }

  async function loadPurchases() {
    const params = rangeParams();
    try {
      const data = await api(`/api/reports/purchases?${params.toString()}`);
      const s = data.summary;
      body.innerHTML = `
        <div class="card">
          <div class="inline-form">
            <input class="input" type="date" style="flex:0 0 160px" data-from value="${stateTabs.from}" aria-label="С даты">
            <input class="input" type="date" style="flex:0 0 160px" data-to value="${stateTabs.to}" aria-label="По дату">
            <a class="btn btn-sm" data-export-purchases href="#">Экспорт CSV</a>
          </div>
        </div>
        <div class="grid cols-4 section-gap">
          <div class="card kpi"><div class="kpi-label">Закупок</div><div class="kpi-value">${num(s.count)}</div></div>
          <div class="card kpi"><div class="kpi-label">Заказано</div><div class="kpi-value">${num(s.orderedQty)}</div><div class="kpi-note">получено ${num(s.receivedQty)}, в пути ${num(s.inTransitQty)}</div></div>
          <div class="card kpi"><div class="kpi-label">Сумма в юанях</div><div class="kpi-value">¥${(s.cnyFen / 100).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div></div>
          <div class="card kpi"><div class="kpi-label">Товар в рублях</div><div class="kpi-value">${money(s.goodsKop)}</div><div class="kpi-note">расходы ${money(s.expensesKop)}</div></div>
        </div>
        <div class="section-gap">
          ${data.rows.length ? `
            <div class="card">
              <div class="table-wrap">
                <table class="table">
                  <thead><tr>
                    <th>Номер</th><th>Поставщик</th><th>Статус</th><th>Дата</th>
                    <th class="num">Заказано</th><th class="num">Получено</th><th class="num">В пути</th>
                    <th class="num">CNY</th><th class="num">Товар, ₽</th><th class="num">Расходы</th>
                  </tr></thead>
                  <tbody>
                    ${data.rows.map((r) => `
                      <tr>
                        <td class="mono"><a href="#/purchases/${r.id}">${esc(r.number)}</a></td>
                        <td>${esc(r.supplierName)}</td>
                        <td><span class="badge">${esc(r.statusLabel)}</span></td>
                        <td class="small nowrap">${dateOnly(r.createdAt)}</td>
                        <td class="num">${num(r.orderedQty)}</td>
                        <td class="num">${num(r.receivedQty)}</td>
                        <td class="num">${num(r.inTransitQty)}</td>
                        <td class="num">${(r.cnyFen / 100).toFixed(2)}</td>
                        <td class="num">${money(r.goodsKop)}</td>
                        <td class="num">${money(r.expensesKop)}</td>
                      </tr>`).join('')}
                  </tbody>
                </table>
              </div>
            </div>` : `<div class="card">${emptyState('Закупок за период нет')}</div>`}
        </div>`;
      const exportPurchases = body.querySelector('[data-export-purchases]');
      if (exportPurchases) exportPurchases.href = `/api/export/purchases.csv?${params.toString()}`;
      body.querySelector('[data-from]').addEventListener('change', (e) => { stateTabs.from = e.target.value; loadPurchases(); });
      body.querySelector('[data-to]').addEventListener('change', (e) => { stateTabs.to = e.target.value; loadPurchases(); });
    } catch (err) {
      body.innerHTML = `<div class="card"><div class="error-box">${esc(err.message)}</div></div>`;
    }
  }

  await load();
  return root;
}

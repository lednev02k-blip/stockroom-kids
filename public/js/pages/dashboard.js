import { api, can, esc, el, money, num, state, stockChip } from '../core.js';

function kpi(label, value, note) {
  return `
    <div class="card kpi">
      <div class="kpi-label">${esc(label)}</div>
      <div class="kpi-value">${value}</div>
      ${note ? `<div class="kpi-note">${esc(note)}</div>` : ''}
    </div>`;
}

export async function renderDashboard(rest, ctx) {
  const data = await api('/api/dashboard');
  const root = el('<div></div>');

  const cards = [];
  cards.push(kpi('Активных моделей', num(data.models), `Вариантов: ${num(data.variants)}`));
  if (data.stockValueKop !== null && data.stockValueKop !== undefined) {
    cards.push(kpi('Стоимость запасов', money(data.stockValueKop)));
  }
  cards.push(kpi('Продажи за сегодня', money(data.salesTodayKop), `Чеков: ${num(data.salesTodayCount)}`));
  if (data.monthRevenueKop !== null && data.monthRevenueKop !== undefined) {
    cards.push(kpi('Выручка за месяц', money(data.monthRevenueKop)));
  }
  if (data.monthProfitKop !== null && data.monthProfitKop !== undefined) {
    cards.push(kpi('Валовая прибыль за месяц', money(data.monthProfitKop)));
  }
  cards.push(kpi('Низкий остаток', num(data.lowStockCount), `Порог: ${num(data.lowStockThreshold)} шт`));
  if (can('purchase.view')) {
    cards.push(kpi('Закупки в процессе', num(data.purchasesInProgress), `Ожидается: ${num(data.expectedReceiptsQty)} шт`));
  }

  const actions = [];
  if (can('sale.create')) actions.push('<a class="btn btn-primary" href="#/sales/new">Новая продажа</a>');
  if (can('purchase.create')) actions.push('<a class="btn" href="#/purchases">Закупки</a>');
  if (can('catalog.manage')) actions.push('<a class="btn" href="#/products">Каталог</a>');

  root.innerHTML = `
    ${actions.length ? `<div class="row" data-actions>${actions.join('')}</div>` : ''}
    <div class="grid cols-4 section-gap">${cards.join('')}</div>
    <div class="card section-gap">
      <div class="card-head">
        <h2>Товары с низким остатком</h2>
        <div class="spacer"></div>
        <a class="btn btn-sm" href="#/stock">Склад</a>
      </div>
      ${data.lowStock.length ? `
        <div class="table-wrap desktop-table">
          <table class="table">
            <thead><tr><th>Артикул</th><th>Товар</th><th>Размер</th><th>Цвет</th><th class="num">Остаток</th></tr></thead>
            <tbody>
              ${data.lowStock.map((r) => `
                <tr>
                  <td class="mono">${esc(r.sku)}</td>
                  <td>${esc(r.name)}</td>
                  <td>${esc(r.size || '—')}</td>
                  <td>${esc(r.color || '—')}</td>
                  <td class="num">${stockChip(r.qty, data.lowStockThreshold)}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
        <div class="mobile-cards">
          ${data.lowStock.map((r) => `
            <div class="mcard">
              <div class="mcard-top">
                <div class="mcard-title">${esc(r.name)}</div>
                ${stockChip(r.qty, data.lowStockThreshold)}
              </div>
              <div class="mcard-meta">
                <span>${esc(r.sku)}</span><span>${esc(r.size || '—')}</span><span>${esc(r.color || '—')}</span>
              </div>
            </div>`).join('')}
        </div>` : '<div class="empty">Все остатки выше порога</div>'}
    </div>`;

  return root;
}

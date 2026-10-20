import {
  api, can, dt, dateOnly, el, emptyState, esc, kopToInput, money, monthStartInput, num,
  pageHeader, parseMoney, state, toast, todayInput,
} from '../core.js';
import { openReturnModal } from './returns.js';

export async function renderSales(rest, ctx) {
  if (rest[0] === 'new') return renderNewSale(ctx);
  if (rest[0]) return renderSale(rest[0], ctx);
  return renderSalesList(ctx);
}

const filters = { from: monthStartInput(), to: todayInput(), search: '' };

function rangeParams() {
  const params = new URLSearchParams();
  params.set('from', `${filters.from}T00:00:00`);
  params.set('to', `${filters.to}T23:59:59`);
  if (filters.search) params.set('search', filters.search);
  return params;
}

async function renderSalesList(ctx) {
  const root = el(`<div>
    ${pageHeader({
      title: 'Продажи',
      subtitle: 'Оформление продаж, скидки и возвраты',
      actions: `${can('sale.create') ? '<a class="btn btn-primary" href="#/sales/new">Новая продажа</a>' : ''}
        ${can('sale.create') ? `<a class="btn" data-export href="#">Экспорт CSV</a>` : ''}`,
    })}
    <div data-body><div class="card"><div class="skeleton"></div><div class="skeleton"></div></div></div>
  </div>`);
  const body = root.querySelector('[data-body]');

  async function load() {
    const params = rangeParams();
    body.innerHTML = '<div class="card"><div class="skeleton"></div></div>';
    try {
      const rows = await api(`/api/sales?${params.toString()}`);
      const total = rows.reduce((acc, r) => acc + r.totalKop, 0);
      body.innerHTML = `
        <div class="card">
          <div class="inline-form">
            <input class="input" type="date" style="flex:0 0 160px" data-from value="${filters.from}" aria-label="С даты">
            <input class="input" type="date" style="flex:0 0 160px" data-to value="${filters.to}" aria-label="По дату">
            <input class="input" style="flex:1 1 200px" type="search" data-search placeholder="Номер, артикул или название" value="${esc(filters.search)}">
          </div>
        </div>
        <div class="section-gap">
          ${rows.length ? `
            <div class="card">
              <div class="table-wrap desktop-table">
                <table class="table">
                  <thead><tr>
                    <th>Номер</th><th>Дата</th><th>Продавец</th><th class="num">Позиций</th>
                    <th class="num">Сумма</th><th class="num">Возвраты</th>
                    ${can('reports.profit') ? '<th class="num">Прибыль</th>' : ''}
                  </tr></thead>
                  <tbody>
                    ${rows.map((r) => `
                      <tr class="clickable" data-open="${r.id}">
                        <td class="mono"><strong>${esc(r.number)}</strong></td>
                        <td class="small nowrap">${dt(r.soldAt)}</td>
                        <td>${esc(r.sellerName)}</td>
                        <td class="num">${num(r.qty)}</td>
                        <td class="num">${money(r.totalKop)}</td>
                        <td class="num">${r.returnedKop ? money(r.returnedKop) : '—'}</td>
                        ${can('reports.profit') ? `<td class="num">${money(r.profitKop)}</td>` : ''}
                      </tr>`).join('')}
                  </tbody>
                  <tfoot><tr>
                    <td colspan="4">Итого за период</td>
                    <td class="num">${money(total)}</td><td colspan="${can('reports.profit') ? 2 : 1}"></td>
                  </tr></tfoot>
                </table>
              </div>
              <div class="mobile-cards">
                ${rows.map((r) => `
                  <div class="mcard" data-open="${r.id}">
                    <div class="mcard-top"><div class="mcard-title">${esc(r.number)}</div><strong>${money(r.totalKop)}</strong></div>
                    <div class="mcard-meta"><span>${dt(r.soldAt)}</span><span>${esc(r.sellerName)}</span><span>${num(r.qty)} шт</span></div>
                  </div>`).join('')}
              </div>
            </div>` : `<div class="card">${emptyState('За период продаж нет')}</div>`}
        </div>`;

      body.querySelectorAll('[data-open]').forEach((node) => {
        node.addEventListener('click', () => ctx.navigate(`#/sales/${node.dataset.open}`));
      });
      body.querySelector('[data-from]').addEventListener('change', (e) => { filters.from = e.target.value; load(); });
      body.querySelector('[data-to]').addEventListener('change', (e) => { filters.to = e.target.value; load(); });
      let timer = null;
      body.querySelector('[data-search]').addEventListener('input', (e) => {
        filters.search = e.target.value.trim();
        clearTimeout(timer);
        timer = setTimeout(load, 240);
      });
    } catch (err) {
      body.innerHTML = `<div class="card"><div class="error-box">${esc(err.message)}</div></div>`;
    }
  }

  const exportLink = root.querySelector('[data-export]');
  if (exportLink) {
    exportLink.addEventListener('click', (e) => {
      e.preventDefault();
      window.location.href = `/api/export/sales.csv?${rangeParams().toString()}`;
    });
  }

  await load();
  return root;
}

async function renderNewSale(ctx) {
  const cart = [];
  const root = el(`<div>
    <div class="card-head">
      <div>
        <a class="small muted" href="#/sales">← Продажи</a>
        <h1>Новая продажа</h1>
      </div>
    </div>
    <div class="grid cols-2">
      <div class="card">
        <h2>Товары</h2>
        <input class="input section-gap" type="search" data-search placeholder="Артикул или название" autofocus>
        <div class="search-results" data-results><div class="search-item muted">Начните вводить артикул или название</div></div>
        <p class="field-hint">Добавляйте только доступные к продаже варианты. Остаток проверяется сервером при проведении.</p>
      </div>
      <div class="card">
        <div class="card-head"><h2>Корзина</h2><div class="spacer"></div><span class="small muted" data-count></span></div>
        <div class="stack" data-cart></div>
        <div class="stack section-gap" data-totals></div>
        ${can('price.manage') ? `
          <label class="field section-gap"><span class="field-label">Скидка на продажу, ₽</span>
            <input class="input num" data-discount value="0" inputmode="decimal"></label>` : ''}
        <label class="field section-gap"><span class="field-label">Комментарий</span>
          <input class="input" data-comment></label>
        <button class="btn btn-primary btn-block section-gap" data-submit>Провести продажу</button>
      </div>
    </div>
  </div>`);

  const results = root.querySelector('[data-results]');
  const cartBox = root.querySelector('[data-cart]');
  const totalsBox = root.querySelector('[data-totals]');
  const searchInput = root.querySelector('[data-search]');
  const discountInput = root.querySelector('[data-discount]');

  function subtotal() {
    return cart.reduce((acc, i) => acc + i.priceKop * i.qty, 0);
  }

  function discountValue() {
    if (!discountInput) return 0;
    const value = parseMoney(discountInput.value);
    return value && value > 0 ? value : 0;
  }

  function renderCart() {
    root.querySelector('[data-count]').textContent = `${cart.length} поз. · ${num(cart.reduce((a, i) => a + i.qty, 0))} шт`;
    if (!cart.length) {
      cartBox.innerHTML = '<div class="empty">Корзина пуста</div>';
    } else {
      cartBox.innerHTML = cart.map((item, index) => `
        <div class="cart-line" data-line="${index}">
          <div class="stack">
            <strong>${esc(item.name)}</strong>
            <span class="small muted">${esc(item.sku)} · ${esc([item.size, item.color].filter(Boolean).join(' · ') || '—')} · остаток ${num(item.maxQty)}</span>
          </div>
          <input class="input sm num" data-qty value="${num(item.qty)}" inputmode="numeric" aria-label="Количество">
          <input class="input sm num" data-price value="${kopToInput(item.priceKop)}" inputmode="decimal" aria-label="Цена">
          <span class="line-sum num small">${money(item.priceKop * item.qty)}</span>
          <button type="button" class="btn btn-sm btn-ghost" data-remove aria-label="Удалить">✕</button>
        </div>`).join('');

      cartBox.querySelectorAll('[data-line]').forEach((row) => {
        const index = Number(row.dataset.line);
        row.querySelector('[data-qty]').addEventListener('change', (e) => {
          const value = Math.max(1, Math.round(Number(e.target.value.replace(',', '.')) || 1));
          if (value > cart[index].maxQty) {
            toast(`Доступно только ${cart[index].maxQty} шт`, 'error');
            e.target.value = String(cart[index].maxQty);
            cart[index].qty = cart[index].maxQty;
          } else {
            cart[index].qty = value;
          }
          renderCart();
        });
        row.querySelector('[data-price]').addEventListener('change', (e) => {
          const kop = parseMoney(e.target.value);
          if (kop === null || kop < 0) { toast('Некорректная цена', 'error'); return; }
          cart[index].priceKop = kop;
          renderCart();
        });
        row.querySelector('[data-remove]').addEventListener('click', () => {
          cart.splice(index, 1);
          renderCart();
        });
      });
    }

    const sub = subtotal();
    const disc = discountValue();
    const total = Math.max(sub - disc, 0);
    totalsBox.innerHTML = `
      <div class="row"><span class="muted">Подытог</span><span class="spacer"></span><strong>${money(sub)}</strong></div>
      ${disc ? `<div class="row"><span class="muted">Скидка</span><span class="spacer"></span><strong>−${money(disc)}</strong></div>` : ''}
      <div class="row"><span class="muted">К оплате</span><span class="spacer"></span><strong>${money(total)}</strong></div>`;
  }

  let timer = null;
  async function runSearch() {
    const term = searchInput.value.trim();
    if (!term) {
      results.innerHTML = '<div class="search-item muted">Начните вводить артикул или название</div>';
      return;
    }
    results.innerHTML = '<div class="search-item muted">Поиск…</div>';
    try {
      const products = await api(`/api/products?inStock=1&search=${encodeURIComponent(term)}`);
      const rows = [];
      for (const p of products) {
        for (const v of p.variants) {
          if (v.qty > 0 && !cart.some((c) => c.variantId === v.id)) rows.push({ p, v });
        }
      }
      if (!rows.length) {
        results.innerHTML = '<div class="search-item muted">Нет доступных товаров по запросу</div>';
        return;
      }
      results.innerHTML = rows.slice(0, 40).map((r, i) => `
        <div class="search-item" data-index="${i}">
          <div class="stack">
            <strong>${esc(r.p.name)}</strong>
            <span class="small muted">${esc(r.p.sku)} · ${esc([r.v.size, r.v.color].filter(Boolean).join(' · ') || '—')} · остаток ${num(r.v.qty)}</span>
          </div>
          <span class="nowrap small">${money(r.v.retailPriceKop)}</span>
        </div>`).join('');
      results.querySelectorAll('[data-index]').forEach((node) => {
        node.addEventListener('click', () => {
          const { p, v } = rows[Number(node.dataset.index)];
          cart.push({
            variantId: v.id,
            sku: p.sku,
            name: p.name,
            size: v.size,
            color: v.color,
            qty: 1,
            maxQty: v.qty,
            priceKop: v.retailPriceKop,
          });
          searchInput.value = '';
          results.innerHTML = '<div class="search-item muted">Товар добавлен в корзину</div>';
          renderCart();
          searchInput.focus();
        });
      });
    } catch (err) {
      results.innerHTML = `<div class="search-item"><span class="error-box">${esc(err.message)}</span></div>`;
    }
  }

  searchInput.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(runSearch, 220);
  });
  if (discountInput) discountInput.addEventListener('input', renderCart);

  const submit = root.querySelector('[data-submit]');
  submit.addEventListener('click', async () => {
    submit.disabled = true;
    try {
      if (!cart.length) throw new Error('Корзина пуста');
      const sub = subtotal();
      const disc = discountValue();
      if (disc > sub) throw new Error('Скидка не может превышать сумму продажи');
      const payload = {
        clientRef: crypto.randomUUID(),
        items: cart.map((i) => ({ variantId: i.variantId, qty: i.qty, priceKop: i.priceKop })),
        subtotalKop: sub,
        comment: root.querySelector('[data-comment]').value.trim() || undefined,
      };
      if (disc) payload.discountKop = disc;
      const sale = await api('/api/sales', { method: 'POST', body: payload });
      toast(`Продажа ${sale.number} проведена`);
      ctx.navigate(`#/sales/${sale.id}`);
    } catch (err) {
      toast(err.message, 'error');
      submit.disabled = false;
    }
  });

  renderCart();
  return root;
}

async function renderSale(id, ctx) {
  const sale = await api(`/api/sales/${id}`);
  const root = el(`<div>
    <div class="card-head">
      <div>
        <a class="small muted" href="#/sales">← Продажи</a>
        <h1>${esc(sale.number)}</h1>
        <p class="muted small">${dt(sale.soldAt)} · продавец ${esc(sale.sellerName)}</p>
      </div>
      <div class="spacer"></div>
      <div class="row">
        ${sale.canReturn ? '<button class="btn btn-sm" data-return>Оформить возврат</button>' : '<span class="badge">Возвраты оформлены</span>'}
      </div>
    </div>

    <div class="card">
      <div class="table-wrap">
        <table class="table">
          <thead><tr>
            <th>Товар</th><th>Артикул</th><th>Размер / цвет</th><th class="num">Количество</th>
            <th class="num">Цена</th><th class="num">Сумма</th>
            ${sale.costTotalKop !== undefined ? '<th class="num">Себестоимость</th>' : ''}
            <th class="num">Возвращено</th>
          </tr></thead>
          <tbody>
            ${sale.items.map((i) => `
              <tr>
                <td>${esc(i.name)}</td>
                <td class="mono">${esc(i.sku)}</td>
                <td>${esc([i.size, i.color].filter(Boolean).join(' · ') || '—')}</td>
                <td class="num">${num(i.qty)}</td>
                <td class="num">${money(i.priceKop)}</td>
                <td class="num">${money(i.priceKop * i.qty)}</td>
                ${sale.costTotalKop !== undefined ? `<td class="num">${money(i.costTotalKop)}</td>` : ''}
                <td class="num">${num(i.returnedQty)}</td>
              </tr>`).join('')}
          </tbody>
          <tfoot>
            <tr>
              <td colspan="5">Подытог</td>
              <td class="num">${money(sale.subtotalKop)}</td>
              <td colspan="${sale.costTotalKop !== undefined ? 2 : 1}"></td>
            </tr>
            ${sale.discountKop ? `<tr><td colspan="5">Скидка</td><td class="num">−${money(sale.discountKop)}</td><td colspan="${sale.costTotalKop !== undefined ? 2 : 1}"></td></tr>` : ''}
            <tr>
              <td colspan="5">Итого</td>
              <td class="num"><strong>${money(sale.totalKop)}</strong></td>
              <td colspan="${sale.costTotalKop !== undefined ? 2 : 1}"></td>
            </tr>
            ${sale.profitKop !== undefined ? `<tr><td colspan="5">Валовая прибыль</td><td class="num" colspan="${sale.costTotalKop !== undefined ? 2 : 1}"><strong>${money(sale.profitKop)}</strong></td><td></td></tr>` : ''}
          </tfoot>
        </table>
      </div>
      ${sale.comment ? `<p class="small muted section-gap">${esc(sale.comment)}</p>` : ''}
      ${sale.returnedKop ? `<div class="info-box section-gap">Возвращено на сумму ${money(sale.returnedKop)}</div>` : ''}
    </div>

    ${sale.returns.length ? `
      <div class="card">
        <h2>Возвраты по продаже</h2>
        <div class="timeline section-gap">
          ${sale.returns.map((r) => `
            <div class="timeline-item">
              <span class="when">${dt(r.createdAt)}</span>
              <span><a href="#/returns/${r.id}">${esc(r.number)}</a> · ${money(r.totalKop)} · ${esc(r.reason)}
                <div class="small muted">${r.items.map((i) => `${esc(i.name)} ${i.qty} шт${i.condition === 'damaged' ? ' (повреждён)' : ''}`).join(', ')}</div>
              </span>
            </div>`).join('')}
        </div>
      </div>` : ''}
  </div>`);

  const returnBtn = root.querySelector('[data-return]');
  if (returnBtn) {
    returnBtn.addEventListener('click', () => openReturnModal(sale, ctx));
  }
  return root;
}

import {
  api, can, confirmDialog, cny, dateOnly, dt, el, emptyState, esc, kopToInput, modal, money,
  num, options, pageHeader, parseMoney, promptDialog, rateText, state, statusBadge, toast, todayInput, variantPicker,
} from '../core.js';

const STATUS_TRANSITIONS = {
  draft: [{ to: 'pending_approval', label: 'На согласование' }, { to: 'cancelled', label: 'Отменить', danger: true }],
  pending_approval: [
    { to: 'approved', label: 'Утвердить', perm: 'purchase.approve' },
    { to: 'draft', label: 'Вернуть в черновик' },
    { to: 'cancelled', label: 'Отменить', danger: true },
  ],
  approved: [{ to: 'ordered', label: 'Отметить заказанной' }, { to: 'cancelled', label: 'Отменить', danger: true }],
  ordered: [{ to: 'cancelled', label: 'Отменить', danger: true }],
  partially_paid: [{ to: 'cancelled', label: 'Отменить', danger: true }],
  paid: [{ to: 'cancelled', label: 'Отменить', danger: true }],
  partially_received: [],
  received: [],
  cancelled: [],
};

const RECEIVABLE = ['ordered', 'partially_paid', 'paid', 'partially_received'];

const listState = { tab: 'orders', status: '', search: '' };

export async function renderPurchases(rest, ctx) {
  if (rest[0] === 'new') {
    const node = await renderPurchaseList(ctx);
    openCreatePurchase(ctx);
    return node;
  }
  if (rest[0]) return renderPurchase(rest[0], ctx);
  return renderPurchaseList(ctx);
}

async function renderPurchaseList(ctx) {
  const root = el(`<div>
    ${pageHeader({
      title: 'Закупки',
      subtitle: 'Заказы в Китае, цены в юанях, оплаты и расходы',
      actions: can('purchase.create') ? '<button class="btn btn-primary" data-new>Новая закупка</button>' : '',
    })}
    <div class="tabs">
      <button class="tab${listState.tab === 'orders' ? ' active' : ''}" data-tab="orders">Заказы</button>
      <button class="tab${listState.tab === 'suppliers' ? ' active' : ''}" data-tab="suppliers">Поставщики</button>
    </div>
    <div data-body></div>
  </div>`);

  const body = root.querySelector('[data-body]');

  root.querySelectorAll('[data-tab]').forEach((tab) => {
    tab.addEventListener('click', () => {
      listState.tab = tab.dataset.tab;
      root.querySelectorAll('[data-tab]').forEach((t) => t.classList.toggle('active', t === tab));
      load();
    });
  });

  const newBtn = root.querySelector('[data-new]');
  if (newBtn) newBtn.addEventListener('click', () => openCreatePurchase(ctx));

  async function load() {
    body.innerHTML = '<div class="card"><div class="skeleton"></div><div class="skeleton"></div></div>';
    if (listState.tab === 'suppliers') return loadSuppliers();
    return loadOrders();
  }

  async function loadOrders() {
    const params = new URLSearchParams();
    if (listState.status) params.set('status', listState.status);
    if (listState.search) params.set('search', listState.search);
    try {
      const rows = await api(`/api/purchases?${params.toString()}`);
      body.innerHTML = `
        <div class="card">
          <div class="inline-form">
            <input class="input" style="flex:1 1 200px" type="search" data-search placeholder="Номер или поставщик" value="${esc(listState.search)}">
            <select class="select" style="flex:0 0 220px" data-status>
              ${options([
                { id: '', name: 'Все статусы' },
                { id: 'draft', name: 'Черновик' },
                { id: 'pending_approval', name: 'На согласовании' },
                { id: 'approved', name: 'Утверждена' },
                { id: 'ordered', name: 'Заказана' },
                { id: 'partially_paid', name: 'Частично оплачена' },
                { id: 'paid', name: 'Оплачена' },
                { id: 'partially_received', name: 'Частично получена' },
                { id: 'received', name: 'Получена' },
                { id: 'cancelled', name: 'Отменена' },
              ], listState.status)}
            </select>
          </div>
        </div>
        <div class="section-gap">
          ${rows.length ? `
            <div class="card">
              <div class="table-wrap desktop-table">
                <table class="table">
                  <thead><tr>
                    <th>Номер</th><th>Поставщик</th><th>Статус</th><th>Дата</th>
                    <th class="num">Заказано</th><th class="num">Получено</th>
                    <th class="num">В пути</th><th class="num">Сумма CNY</th><th class="num">Товар, ₽</th>
                  </tr></thead>
                  <tbody>
                    ${rows.map((r) => `
                      <tr class="clickable" data-open="${r.id}">
                        <td class="mono"><strong>${esc(r.number)}</strong></td>
                        <td>${esc(r.supplierName)}</td>
                        <td>${statusBadge(r.status, r.statusLabel)}</td>
                        <td class="small muted nowrap">${dateOnly(r.createdAt)}</td>
                        <td class="num">${num(r.orderedQty)}</td>
                        <td class="num">${num(r.receivedQty)}</td>
                        <td class="num">${num(r.inTransitQty)}</td>
                        <td class="num">${cny(r.cnyFen)}</td>
                        <td class="num">${money(r.goodsKop)}</td>
                      </tr>`).join('')}
                  </tbody>
                </table>
              </div>
              <div class="mobile-cards">
                ${rows.map((r) => `
                  <div class="mcard" data-open="${r.id}">
                    <div class="mcard-top">
                      <div class="mcard-title">${esc(r.number)}</div>
                      ${statusBadge(r.status, r.statusLabel)}
                    </div>
                    <div class="mcard-meta">
                      <span>${esc(r.supplierName)}</span><span>${dateOnly(r.createdAt)}</span>
                    </div>
                    <div class="mcard-meta">
                      <span>Заказано ${num(r.orderedQty)}</span>
                      <span>Получено ${num(r.receivedQty)}</span>
                      <span>${cny(r.cnyFen)}</span>
                    </div>
                  </div>`).join('')}
              </div>
            </div>` : `<div class="card">${emptyState('Закупок нет')}</div>`}
        </div>`;
      body.querySelectorAll('[data-open]').forEach((node) => {
        node.addEventListener('click', () => ctx.navigate(`#/purchases/${node.dataset.open}`));
      });
      const search = body.querySelector('[data-search]');
      let timer = null;
      search.addEventListener('input', () => {
        listState.search = search.value.trim();
        clearTimeout(timer);
        timer = setTimeout(load, 220);
      });
      body.querySelector('[data-status]').addEventListener('change', (e) => {
        listState.status = e.target.value;
        load();
      });
    } catch (err) {
      body.innerHTML = `<div class="card"><div class="error-box">${esc(err.message)}</div></div>`;
    }
  }

  async function loadSuppliers() {
    try {
      const rows = await api('/api/suppliers');
      state.suppliers = rows;
      body.innerHTML = `
        <div class="card">
          <div class="card-head">
            <h2>Поставщики</h2>
            <div class="spacer"></div>
            ${can('suppliers.manage') ? '<button class="btn btn-sm btn-primary" data-add-supplier>Добавить поставщика</button>' : ''}
          </div>
          ${rows.length ? `
            <div class="table-wrap">
              <table class="table">
                <thead><tr><th>Название</th><th>Код</th><th>Страна</th><th>Контакты</th><th class="num">Закупок</th><th>Статус</th><th></th></tr></thead>
                <tbody>
                  ${rows.map((s) => `
                    <tr>
                      <td><strong>${esc(s.name)}</strong>${s.notes ? `<div class="small muted">${esc(s.notes)}</div>` : ''}</td>
                      <td>${esc(s.code || '—')}</td>
                      <td>${esc(s.country || '—')}</td>
                      <td class="small">${esc(s.contact || '—')}</td>
                      <td class="num">${num(s.purchasesCount)}</td>
                      <td>${s.isActive ? '<span class="badge ok">Активен</span>' : '<span class="badge">Неактивен</span>'}</td>
                      <td class="actions">${can('suppliers.manage') ? `<button class="btn btn-sm btn-ghost" data-edit-supplier="${s.id}">Изменить</button>` : ''}</td>
                    </tr>`).join('')}
                </tbody>
              </table>
            </div>` : emptyState('Поставщиков пока нет')}
        </div>`;
      const add = body.querySelector('[data-add-supplier]');
      if (add) add.addEventListener('click', () => openSupplier(null, load));
      body.querySelectorAll('[data-edit-supplier]').forEach((btn) => {
        btn.addEventListener('click', () => {
          openSupplier(rows.find((s) => String(s.id) === btn.dataset.editSupplier), load);
        });
      });
    } catch (err) {
      body.innerHTML = `<div class="card"><div class="error-box">${esc(err.message)}</div></div>`;
    }
  }

  await load();
  return root;
}

function openSupplier(supplier, reload) {
  const s = supplier || {};
  const form = el(`<form>
    <div class="form-grid">
      <label class="field"><span class="field-label">Название *</span>
        <input class="input" name="name" required value="${esc(s.name || '')}"></label>
      <label class="field"><span class="field-label">Код поставщика</span>
        <input class="input" name="code" value="${esc(s.code || '')}"></label>
      <label class="field"><span class="field-label">Страна</span>
        <input class="input" name="country" value="${esc(s.country || 'Китай')}"></label>
      <label class="field"><span class="field-label">Контакты</span>
        <input class="input" name="contact" value="${esc(s.contact || '')}" placeholder="телефон, WeChat"></label>
      <label class="field full"><span class="field-label">Примечания</span>
        <textarea class="textarea" name="notes">${esc(s.notes || '')}</textarea></label>
      <label class="field full row tight"><input type="checkbox" name="isActive" ${s.isActive === false ? '' : 'checked'}> Активен</label>
    </div>
  </form>`);
  const footer = el('<div class="row"><button type="button" class="btn" data-close>Отмена</button><button type="button" class="btn btn-primary" data-save>Сохранить</button></div>');
  const m = modal({ title: supplier ? 'Поставщик' : 'Новый поставщик', body: form, footer });
  footer.querySelector('[data-save]').addEventListener('click', async (ev) => {
    const submitBtn = ev.currentTarget;
    submitBtn.disabled = true;
    try {
      const payload = {
        name: form.elements.name.value.trim(),
        code: form.elements.code.value.trim() || null,
        country: form.elements.country.value.trim() || null,
        contact: form.elements.contact.value.trim() || null,
        notes: form.elements.notes.value.trim() || null,
        isActive: form.elements.isActive.checked,
      };
      if (!payload.name) throw new Error('Укажите название поставщика');
      if (supplier) await api(`/api/suppliers/${supplier.id}`, { method: 'PATCH', body: payload });
      else await api('/api/suppliers', { method: 'POST', body: payload });
      const fresh = await api('/api/suppliers');
      state.suppliers = fresh;
      m.close();
      toast('Поставщик сохранён');
      reload();
    } catch (err) {
      toast(err.message, 'error');
    } finally { submitBtn.disabled = false; }
  });
}

export function openCreatePurchase(ctx) {
  const items = [];
  const activeSuppliers = state.suppliers.filter((s) => s.isActive);
  const preselectedSupplier = activeSuppliers.length === 1 ? activeSuppliers[0].id : '';
  const body = el(`<form>
    <div class="form-grid">
      <label class="field"><span class="field-label">Поставщик *</span>
        <select class="select" name="supplierId">
          ${options(activeSuppliers, preselectedSupplier, { placeholder: 'Выберите поставщика' })}
        </select>
      </label>
      <label class="field"><span class="field-label">Курс CNY → RUB *</span>
        <input class="input num" name="rate" inputmode="decimal" placeholder="12,0000">
        <span class="field-hint">Вводится вручную и сохраняется в документе</span>
      </label>
      <label class="field"><span class="field-label">Дата курса</span>
        <input class="input" type="date" name="rateDate" value="${todayInput()}"></label>
      <label class="field"><span class="field-label">Источник курса</span>
        <input class="input" name="rateSource" placeholder="банк, обменник"></label>
      <label class="field full"><span class="field-label">Комментарий</span>
        <input class="input" name="comment"></label>
    </div>
    <div class="card-head section-gap">
      <h3>Позиции</h3>
      <div class="spacer"></div>
      <button type="button" class="btn btn-sm" data-add-line>Добавить товар</button>
    </div>
    <div class="stack" data-lines></div>
    <div class="detail-grid section-gap" data-totals></div>
  </form>`);

  const linesBox = body.querySelector('[data-lines]');
  const totalsBox = body.querySelector('[data-totals]');

  function rateX() {
    const value = parseMoney(body.elements.rate.value);
    return value === null ? 0 : Math.round((Number(body.elements.rate.value.replace(/\s/g, '').replace(',', '.')) || 0) * 10000);
  }

  function totals() {
    let cnyFen = 0;
    let goodsKop = 0;
    for (const item of items) {
      cnyFen += item.priceCnyFen * item.qty;
      goodsKop += Math.round((item.priceCnyFen * item.qty * rateX()) / 10000);
    }
    totalsBox.innerHTML = `
      <div class="detail-item"><div class="k">Сумма в юанях</div><div class="v">${cny(cnyFen)}</div></div>
      <div class="detail-item"><div class="k">Эквивалент в рублях</div><div class="v">${money(goodsKop)}</div></div>
      <div class="detail-item"><div class="k">Позиций</div><div class="v">${num(items.length)}</div></div>`;
  }

  function renderLines() {
    if (!items.length) {
      linesBox.innerHTML = '<div class="empty">Добавьте хотя бы одну позицию</div>';
      totals();
      return;
    }
    linesBox.innerHTML = items.map((item, index) => `
      <div class="cart-line" data-line="${index}">
        <div class="stack">
          <strong>${esc(item.name)}</strong>
          <span class="small muted">${esc(item.sku)} · ${esc(item.size || '—')} · ${esc(item.color || '—')}</span>
        </div>
        <input class="input sm num" data-qty value="${num(item.qty)}" inputmode="numeric" aria-label="Количество">
        <input class="input sm num" data-price value="${kopToInput(item.priceCnyFen)}" inputmode="decimal" aria-label="Цена CNY">
        <span class="num line-sum small">${money(Math.round((item.priceCnyFen * item.qty * rateX()) / 10000))}</span>
        <button type="button" class="btn btn-sm btn-ghost" data-remove aria-label="Удалить">✕</button>
      </div>`).join('');

    linesBox.querySelectorAll('[data-line]').forEach((row) => {
      const index = Number(row.dataset.line);
      row.querySelector('[data-qty]').addEventListener('change', (e) => {
        const value = Math.max(1, Math.round(Number(e.target.value.replace(',', '.')) || 1));
        items[index].qty = value;
        renderLines();
      });
      row.querySelector('[data-price]').addEventListener('change', (e) => {
        const fen = parseMoney(e.target.value);
        if (fen === null || fen <= 0) { toast('Некорректная цена', 'error'); return; }
        items[index].priceCnyFen = fen;
        renderLines();
      });
      row.querySelector('[data-remove]').addEventListener('click', () => {
        items.splice(index, 1);
        renderLines();
      });
    });
    totals();
  }

  body.querySelector('[data-add-line]').addEventListener('click', () => {
    variantPicker({
      title: 'Товар для закупки',
      inStock: false,
      onPick: (row) => {
        if (items.some((i) => i.variantId === row.variantId)) { toast('Этот вариант уже добавлен', 'error'); return; }
        items.push({
          variantId: row.variantId,
          sku: row.sku,
          name: row.productName,
          size: row.size,
          color: row.color,
          qty: 1,
          priceCnyFen: 0,
        });
        renderLines();
      },
    });
  });

  body.elements.rate.addEventListener('input', renderLines);
  renderLines();

  const footer = el(`<div class="row">
    <button type="button" class="btn" data-close>Отмена</button>
    <button type="button" class="btn btn-primary" data-save>Создать черновик</button>
  </div>`);
  const m = modal({ title: 'Новая закупка', body, footer, wide: true });

  footer.querySelector('[data-save]').addEventListener('click', async (e) => {
    const submitBtn = e.currentTarget;
    submitBtn.disabled = true;
    try {
      if (!items.length) throw new Error('Добавьте хотя бы одну позицию');
      if (!body.elements.supplierId.value) throw new Error('Выберите поставщика');
      const rateValue = body.elements.rate.value.trim();
      if (!rateValue) throw new Error('Укажите курс CNY/RUB');
      const payload = {
        supplierId: Number(body.elements.supplierId.value),
        rate: rateValue,
        rateDate: body.elements.rateDate.value || undefined,
        rateSource: body.elements.rateSource.value.trim() || undefined,
        comment: body.elements.comment.value.trim() || undefined,
        items: items.map((i) => ({ variantId: i.variantId, qty: i.qty, priceCny: kopToInput(i.priceCnyFen) })),
      };
      const created = await api('/api/purchases', { method: 'POST', body: payload });
      m.close();
      toast('Закупка создана');
      if (ctx && ctx.navigate) ctx.navigate(`#/purchases/${created.id}`);
      else location.hash = `#/purchases/${created.id}`;
    } catch (err) {
      toast(err.message, 'error');
    } finally { submitBtn.disabled = false; }
  });
}

async function renderPurchase(id, ctx) {
  const p = await api(`/api/purchases/${id}`);
  const root = el(`<div>
    <div class="card-head">
      <div>
        <a class="small muted" href="#/purchases">← Закупки</a>
        <h1>${esc(p.number)}</h1>
        <p class="muted small">${esc(p.supplierName)} · ${dt(p.createdAt)} · автор ${esc(p.authorName)}</p>
      </div>
      <div class="spacer"></div>
      <div class="row">
        ${statusBadge(p.status, p.statusLabel)}
        ${RECEIVABLE.includes(p.status) && can('receipt.create') ? '<button class="btn btn-sm btn-primary" data-receive>Оформить приёмку</button>' : ''}
      </div>
    </div>

    <div class="card">
      <div class="detail-grid">
        <div class="detail-item"><div class="k">Курс CNY/RUB</div><div class="v">${rateText(p.rateX10000)}</div></div>
        <div class="detail-item"><div class="k">Дата курса</div><div class="v">${dateOnly(p.rateDate)}</div></div>
        <div class="detail-item"><div class="k">Сумма в юанях</div><div class="v">${cny(p.totals.cnyFen)}</div></div>
        <div class="detail-item"><div class="k">Товар в рублях</div><div class="v">${money(p.totals.goodsKop)}</div></div>
        ${can('cost.view') ? `<div class="detail-item"><div class="k">Доп. расходы</div><div class="v">${money(p.totals.expensesKop)}</div></div>
        <div class="detail-item"><div class="k">Себестоимость единицы</div><div class="v">${money(p.totals.unitCostKop)}</div></div>` : ''}
        <div class="detail-item"><div class="k">Оплачено</div><div class="v">${money(p.totals.paidKop)}</div></div>
        <div class="detail-item"><div class="k">Заказано / получено</div><div class="v">${num(p.totals.orderedQty)} / ${num(p.totals.receivedQty)}</div></div>
        <div class="detail-item"><div class="k">В пути</div><div class="v">${num(p.totals.inTransitQty)}</div></div>
      </div>
      ${p.comment ? `<p class="small section-gap">${esc(p.comment)}</p>` : ''}
      <div class="row section-gap" data-actions></div>
    </div>

    <div class="card">
      <h2>Позиции</h2>
      <div class="table-wrap section-gap">
        <table class="table">
          <thead><tr>
            <th>Товар</th><th>Артикул</th><th>Размер / цвет</th>
            <th class="num">Заказано</th><th class="num">Цена CNY</th><th class="num">Сумма, ₽</th>
            <th class="num">Получено</th><th class="num">Недостача</th><th class="num">В пути</th>
          </tr></thead>
          <tbody>
            ${p.items.map((i) => `
              <tr>
                <td>${esc(i.productName)}</td>
                <td class="mono">${esc(i.sku)}</td>
                <td>${esc([i.size, i.color].filter(Boolean).join(' · ') || '—')}</td>
                <td class="num">${num(i.qty)}</td>
                <td class="num">${cny(i.priceCnyFen)}</td>
                <td class="num">${money(Math.round((i.priceCnyFen * i.qty * p.rateX10000) / 10000))}</td>
                <td class="num">${num(i.receivedQty)}</td>
                <td class="num">${i.shortage > 0 ? `<span class="badge warn">${num(i.shortage)}</span>` : '0'}</td>
                <td class="num">${num(i.inTransit)}</td>
              </tr>`).join('')}
          </tbody>
          <tfoot>
            <tr>
              <td colspan="3">Итого</td>
              <td class="num">${num(p.totals.orderedQty)}</td>
              <td class="num">${cny(p.totals.cnyFen)}</td>
              <td class="num">${money(p.totals.goodsKop)}</td>
              <td class="num">${num(p.totals.receivedQty)}</td>
              <td class="num">${num(p.totals.orderedQty - p.totals.receivedQty)}</td>
              <td class="num">${num(p.totals.inTransitQty)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>

    <div class="grid cols-2">
      <div class="card">
        <div class="card-head">
          <h2>Приёмки</h2>
          <div class="spacer"></div>
        </div>
        ${p.receipts.length ? `
          <div class="timeline">
            ${p.receipts.map((r) => `
              <div class="timeline-item">
                <span class="when">${dt(r.receiptDate)}</span>
                <span>
                  <a href="#/receipts/${r.id}">${esc(r.number)}</a>
                  ${r.status === 'posted' ? '<span class="badge ok">Проведена</span>' : '<span class="badge">Черновик</span>'}
                  <span class="small muted">${num(r.qty)} шт · ${esc(r.authorName)}</span>
                </span>
              </div>`).join('')}
          </div>` : emptyState('Приёмок ещё не было')}
      </div>

      <div class="card">
        <div class="card-head">
          <h2>Оплаты</h2>
          <div class="spacer"></div>
          ${can('purchase.payments') && p.status !== 'cancelled' ? '<button class="btn btn-sm" data-add-payment>Добавить оплату</button>' : ''}
        </div>
        ${p.payments.length ? `
          <div class="timeline">
            ${p.payments.map((pay) => `
              <div class="timeline-item">
                <span class="when">${dt(pay.paidAt)}</span>
                <span>${pay.currency === 'CNY' ? cny(pay.amountMinor) : money(pay.amountMinor)} → <strong>${money(pay.amountKop)}</strong>
                  ${pay.currency === 'CNY' ? `<span class="small muted">по курсу ${rateText(pay.rateX10000)}</span>` : ''}
                  ${pay.comment ? `<div class="small muted">${esc(pay.comment)}</div>` : ''}
                </span>
              </div>`).join('')}
          </div>` : emptyState('Оплаты не зарегистрированы')}
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <h2>Дополнительные расходы</h2>
        <div class="spacer"></div>
        ${can('expenses.manage') && p.status !== 'cancelled' ? '<button class="btn btn-sm" data-add-expense>Добавить расход</button>' : ''}
      </div>
      ${p.expenses.length ? `
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>Категория</th><th class="num">Сумма</th><th>Метод</th><th>Приёмка</th><th>Статус</th><th>Автор</th></tr></thead>
            <tbody>
              ${p.expenses.map((e) => `
                <tr>
                  <td>${esc(state.expenseCategories[e.category] || e.category)}</td>
                  <td class="num">${money(e.amountKop)}</td>
                  <td>${esc(state.allocationMethods[e.method] || e.method)}</td>
                  <td>${e.receiptId ? `<a href="#/receipts/${e.receiptId}">приёмка</a>` : '—'}</td>
                  <td>${e.isCapitalized ? (e.appliedAt ? '<span class="badge ok">Распределён</span>' : '<span class="badge warn">Ожидает</span>') : '<span class="badge">Не относится на товар</span>'}</td>
                  <td class="small">${esc(e.authorName)}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>` : emptyState('Дополнительных расходов нет')}
    </div>

    <div class="card">
      <h2>История документа</h2>
      ${p.history.length ? `
        <div class="timeline section-gap">
          ${p.history.map((h) => `
            <div class="timeline-item">
              <span class="when">${dt(h.at)}</span>
              <span>${esc(h.action)} · ${esc(h.login || '')}
                ${h.details ? `<div class="small muted">${esc(JSON.stringify(h.details))}</div>` : ''}</span>
            </div>`).join('')}
        </div>` : emptyState('Записей нет')}
    </div>
  </div>`);

  const actionsBox = root.querySelector('[data-actions]');
  const transitions = STATUS_TRANSITIONS[p.status] || [];
  for (const tr of transitions) {
    if (tr.perm && !can(tr.perm)) continue;
    const btn = el(`<button class="btn btn-sm ${tr.danger ? 'btn-danger' : 'btn-primary'}">${esc(tr.label)}</button>`);
    btn.addEventListener('click', async () => {
      let comment = null;
      if (tr.to === 'cancelled') {
        comment = await promptDialog({ title: 'Причина отмены', label: 'Укажите причину отмены', confirmText: 'Отменить закупку' });
        if (comment === null) return;
        if (!comment.trim()) { toast('Укажите причину отмены', 'error'); return; }
      }
      const ok = await confirmDialog(`Изменить статус на «${tr.label}»?`, { confirmText: tr.label });
      if (!ok) return;
      try {
        await api(`/api/purchases/${p.id}/status`, { method: 'POST', body: { status: tr.to, comment } });
        toast('Статус обновлён');
        ctx.refresh();
      } catch (err) { toast(err.message, 'error'); }
    });
    actionsBox.appendChild(btn);
  }
  if (p.status === 'ordered' && p.totals.inTransitQty === 0) {
    const btn = el('<button class="btn btn-sm">Отметить полученной</button>');
    btn.addEventListener('click', async () => {
      try {
        await api(`/api/purchases/${p.id}/status`, { method: 'POST', body: { status: 'received' } });
        toast('Закупка получена');
        ctx.refresh();
      } catch (err) { toast(err.message, 'error'); }
    });
    actionsBox.appendChild(btn);
  }
  if (!actionsBox.children.length) actionsBox.innerHTML = '<span class="small muted">Действия по статусу недоступны</span>';

  const receiveBtn = root.querySelector('[data-receive]');
  if (receiveBtn) {
    receiveBtn.addEventListener('click', async () => {
      try {
        const receipt = await api(`/api/purchases/${p.id}/receipts`, { method: 'POST', body: { clientRef: crypto.randomUUID() } });
        ctx.navigate(`#/receipts/${receipt.id}`);
      } catch (err) { toast(err.message, 'error'); }
    });
  }

  const payBtn = root.querySelector('[data-add-payment]');
  if (payBtn) payBtn.addEventListener('click', () => openPayment(p, ctx));

  const expBtn = root.querySelector('[data-add-expense]');
  if (expBtn) expBtn.addEventListener('click', () => openExpense(p, ctx));

  return root;
}

function openPayment(p, ctx) {
  const body = el(`<form>
    <div class="form-grid">
      <label class="field"><span class="field-label">Сумма *</span>
        <input class="input num" name="amount" inputmode="decimal" required></label>
      <label class="field"><span class="field-label">Валюта</span>
        <select class="select" name="currency"><option value="CNY">CNY</option><option value="RUB">RUB</option></select></label>
      <label class="field"><span class="field-label">Курс (для CNY)</span>
        <input class="input num" name="rate" value="${rateText(p.rateX10000)}"></label>
      <label class="field"><span class="field-label">Дата</span>
        <input class="input" type="date" name="paidAt" value="${todayInput()}"></label>
      <label class="field full"><span class="field-label">Комментарий</span>
        <input class="input" name="comment"></label>
    </div>
    <p class="field-hint">Оплата фиксируется отдельно от себестоимости поступившего товара.</p>
  </form>`);
  const footer = el('<div class="row"><button type="button" class="btn" data-close>Отмена</button><button type="button" class="btn btn-primary" data-save>Зарегистрировать</button></div>');
  const m = modal({ title: 'Оплата закупки', body, footer });
  footer.querySelector('[data-save]').addEventListener('click', async (e) => {
    const submitBtn = e.currentTarget;
    submitBtn.disabled = true;
    try {
      await api(`/api/purchases/${p.id}/payments`, {
        method: 'POST',
        body: {
          amount: body.elements.amount.value.trim(),
          currency: body.elements.currency.value,
          rate: body.elements.currency.value === 'CNY' ? body.elements.rate.value.trim() : undefined,
          paidAt: body.elements.paidAt.value || undefined,
          comment: body.elements.comment.value.trim() || undefined,
        },
      });
      m.close();
      toast('Оплата зарегистрирована');
      ctx.refresh();
    } catch (err) { toast(err.message, 'error'); } finally { submitBtn.disabled = false; }
  });
}

function openExpense(p, ctx) {
  const body = el(`<form>
    <div class="form-grid">
      <label class="field"><span class="field-label">Категория</span>
        <select class="select" name="category">
          ${Object.entries(state.expenseCategories).map(([k, v]) => `<option value="${esc(k)}">${esc(v)}</option>`).join('')}
        </select></label>
      <label class="field"><span class="field-label">Сумма *</span>
        <input class="input num" name="amount" inputmode="decimal" required></label>
      <label class="field"><span class="field-label">Валюта</span>
        <select class="select" name="currency"><option value="RUB">RUB</option><option value="CNY">CNY</option></select></label>
      <label class="field"><span class="field-label">Курс (для CNY)</span>
        <input class="input num" name="rate" value="${rateText(p.rateX10000)}"></label>
      <label class="field"><span class="field-label">Метод распределения</span>
        <select class="select" name="method">
          ${Object.entries(state.allocationMethods).map(([k, v]) => `<option value="${esc(k)}">${esc(v)}</option>`).join('')}
        </select></label>
      <label class="field"><span class="field-label">Отнести на приёмку</span>
        <select class="select" name="receiptId">
          <option value="">Вся закупка (проведённые приёмки)</option>
          ${p.receipts.map((r) => `<option value="${r.id}">${esc(r.number)}</option>`).join('')}
        </select></label>
      <label class="field full"><span class="field-label">Комментарий</span>
        <input class="input" name="comment"></label>
      <label class="field full row tight"><input type="checkbox" name="isCapitalized" checked> Включать в себестоимость товара</label>
    </div>
  </form>`);
  const footer = el('<div class="row"><button type="button" class="btn" data-close>Отмена</button><button type="button" class="btn btn-primary" data-save>Добавить расход</button></div>');
  const m = modal({ title: 'Дополнительный расход', body, footer, wide: true });
  footer.querySelector('[data-save]').addEventListener('click', async (e) => {
    const submitBtn = e.currentTarget;
    submitBtn.disabled = true;
    try {
      await api(`/api/purchases/${p.id}/expenses`, {
        method: 'POST',
        body: {
          category: body.elements.category.value,
          amount: body.elements.amount.value.trim(),
          currency: body.elements.currency.value,
          rate: body.elements.currency.value === 'CNY' ? body.elements.rate.value.trim() : undefined,
          method: body.elements.method.value,
          receiptId: body.elements.receiptId.value || undefined,
          comment: body.elements.comment.value.trim() || undefined,
          isCapitalized: body.elements.isCapitalized.checked,
        },
      });
      m.close();
      toast('Расход добавлен');
      ctx.refresh();
    } catch (err) { toast(err.message, 'error'); } finally { submitBtn.disabled = false; }
  });
}

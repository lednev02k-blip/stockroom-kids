import {
  api, can, confirmDialog, dt, el, emptyState, esc, modal, money, num, options, pageHeader,
  state, stockChip, toast, variantPicker,
} from '../core.js';

const tabState = { tab: 'stock', search: '', low: false, type: '' };

export async function renderStock(rest, ctx) {
  const root = el(`<div>
    ${pageHeader({
      title: 'Склад',
      subtitle: 'Остатки, движения, списания и инвентаризация',
      actions: can('export.stock') ? '<a class="btn btn-sm" href="/api/export/stock.csv">Экспорт CSV</a>' : '',
    })}
    <div class="tabs">
      <button class="tab" data-tab="stock">Остатки</button>
      <button class="tab" data-tab="movements">Движения</button>
      <button class="tab" data-tab="inventory">Инвентаризация</button>
    </div>
    <div data-body></div>
  </div>`);

  const body = root.querySelector('[data-body]');

  function setTab(tab) {
    tabState.tab = tab;
    root.querySelectorAll('[data-tab]').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
    load();
  }
  root.querySelectorAll('[data-tab]').forEach((t) => t.addEventListener('click', () => setTab(t.dataset.tab)));

  async function load() {
    body.innerHTML = '<div class="card"><div class="skeleton"></div><div class="skeleton"></div></div>';
    if (tabState.tab === 'movements') return loadMovements();
    if (tabState.tab === 'inventory') return loadInventory();
    return loadStock();
  }

  async function loadStock() {
    const params = new URLSearchParams();
    if (tabState.search) params.set('search', tabState.search);
    if (tabState.low) params.set('low', '1');
    params.set('lowThreshold', String(state.settings.lowStockThreshold || 3));
    try {
      const rows = await api(`/api/stock?${params.toString()}`);
      body.innerHTML = `
        <div class="card">
          <div class="inline-form">
            <input class="input" style="flex:1 1 220px" type="search" data-search placeholder="Артикул, название, размер" value="${esc(tabState.search)}">
            <label class="row tight small"><input type="checkbox" data-low ${tabState.low ? 'checked' : ''}> Только низкий остаток</label>
            ${can('stock.adjust') ? '<button class="btn btn-sm" data-adjust>Корректировка</button>' : ''}
          </div>
        </div>
        <div class="section-gap">
          ${rows.length ? `
            <div class="card">
              <div class="table-wrap desktop-table">
                <table class="table">
                  <thead><tr>
                    <th>Товар</th><th>Артикул</th><th>Категория</th><th>Размер / цвет</th>
                    <th class="num">Остаток</th><th class="num">Розничная</th>
                    ${can('cost.view') ? '<th class="num">Себестоимость</th><th class="num">Стоимость запаса</th>' : ''}
                    ${can('stock.adjust') ? '<th></th>' : ''}
                  </tr></thead>
                  <tbody>
                    ${rows.map((r) => `
                      <tr>
                        <td><a href="#/products/${r.productId}">${esc(r.name)}</a></td>
                        <td class="mono">${esc(r.sku)}</td>
                        <td>${esc(r.categoryName || '—')}</td>
                        <td>${esc([r.size, r.color].filter(Boolean).join(' · ') || '—')}</td>
                        <td class="num">${stockChip(r.qty, state.settings.lowStockThreshold || 3)}</td>
                        <td class="num">${money(r.retailPriceKop)}</td>
                        ${can('cost.view') ? `<td class="num">${money(Math.round((r.avgCostX10000 || 0) / 10000 * 100))}</td><td class="num">${money(r.valueKop)}</td>` : ''}
                        ${can('stock.adjust') ? `<td class="actions"><button class="btn btn-sm btn-ghost" data-adjust-row="${r.variantId}" data-max="${r.qty}" data-name="${esc(r.name)} ${esc([r.size, r.color].filter(Boolean).join(' '))}">Изменить</button></td>` : ''}
                      </tr>`).join('')}
                  </tbody>
                </table>
              </div>
              <div class="mobile-cards">
                ${rows.map((r) => `
                  <div class="mcard">
                    <div class="mcard-top">
                      <div class="mcard-title">${esc(r.name)}</div>
                      ${stockChip(r.qty, state.settings.lowStockThreshold || 3)}
                    </div>
                    <div class="mcard-meta">
                      <span>${esc(r.sku)}</span><span>${esc([r.size, r.color].filter(Boolean).join(' · ') || '—')}</span>
                      <span>${money(r.retailPriceKop)}</span>
                    </div>
                  </div>`).join('')}
              </div>
            </div>` : `<div class="card">${emptyState('Позиции не найдены')}</div>`}
        </div>`;

      let timer = null;
      const search = body.querySelector('[data-search]');
      search.addEventListener('input', () => {
        tabState.search = search.value.trim();
        clearTimeout(timer);
        timer = setTimeout(loadStock, 220);
      });
      body.querySelector('[data-low]').addEventListener('change', (e) => {
        tabState.low = e.target.checked;
        loadStock();
      });
      const adjust = body.querySelector('[data-adjust]');
      if (adjust) adjust.addEventListener('click', () => openAdjust(null, ctx));
      body.querySelectorAll('[data-adjust-row]').forEach((btn) => {
        btn.addEventListener('click', () => openAdjust({
          variantId: Number(btn.dataset.adjustRow),
          name: btn.dataset.name,
        }, ctx));
      });
    } catch (err) {
      body.innerHTML = `<div class="card"><div class="error-box">${esc(err.message)}</div></div>`;
    }
  }

  async function loadMovements() {
    const params = new URLSearchParams();
    if (tabState.type) params.set('type', tabState.type);
    try {
      const rows = await api(`/api/stock/movements?${params.toString()}`);
      body.innerHTML = `
        <div class="card">
          <div class="inline-form">
            <select class="select" style="flex:0 0 240px" data-type>
              ${options([
                { id: '', name: 'Все операции' },
                { id: 'receipt', name: 'Приход' },
                { id: 'sale', name: 'Продажа' },
                { id: 'sale_return', name: 'Возврат от покупателя' },
                { id: 'writeoff', name: 'Списание' },
                { id: 'inventory', name: 'Инвентаризация' },
                { id: 'adjustment', name: 'Корректировка' },
              ], tabState.type)}
            </select>
          </div>
        </div>
        <div class="section-gap">
          ${rows.length ? `
            <div class="card">
              <div class="table-wrap">
                <table class="table">
                  <thead><tr>
                    <th>Дата</th><th>Операция</th><th>Товар</th><th>Размер / цвет</th>
                    <th class="num">Количество</th>${can('cost.view') ? '<th class="num">Сумма</th>' : ''}
                    <th>Документ</th><th>Сотрудник</th>
                  </tr></thead>
                  <tbody>
                    ${rows.map((m) => `
                      <tr>
                        <td class="small nowrap">${dt(m.createdAt)}</td>
                        <td>${esc(m.typeLabel || m.type)}</td>
                        <td>${esc(m.name)}<div class="small muted mono">${esc(m.sku)}</div></td>
                        <td>${esc([m.size, m.color].filter(Boolean).join(' · ') || '—')}</td>
                        <td class="num">${m.qty > 0 ? '+' : ''}${num(m.qty)}</td>
                        ${can('cost.view') ? `<td class="num">${money(m.valueKop)}</td>` : ''}
                        <td class="small">${esc(m.comment || '—')}</td>
                        <td class="small">${esc(m.authorName || '—')}</td>
                      </tr>`).join('')}
                  </tbody>
                </table>
              </div>
            </div>` : `<div class="card">${emptyState('Движений нет')}</div>`}
        </div>`;
      body.querySelector('[data-type]').addEventListener('change', (e) => {
        tabState.type = e.target.value;
        loadMovements();
      });
    } catch (err) {
      body.innerHTML = `<div class="card"><div class="error-box">${esc(err.message)}</div></div>`;
    }
  }

  async function loadInventory() {
    if (!can('stock.inventory')) {
      body.innerHTML = `<div class="card">${emptyState('Инвентаризация доступна владельцу')}</div>`;
      return;
    }
    try {
      const rows = await api('/api/inventory');
      body.innerHTML = `
        <div class="card">
          <div class="card-head">
            <h2>Документы инвентаризации</h2>
            <div class="spacer"></div>
            <button class="btn btn-sm btn-primary" data-new-inventory>Новая инвентаризация</button>
          </div>
          ${rows.length ? `
            <div class="table-wrap">
              <table class="table">
                <thead><tr><th>Номер</th><th>Дата</th><th>Статус</th><th class="num">Позиций</th><th class="num">Расхождений</th><th>Автор</th><th></th></tr></thead>
                <tbody>
                  ${rows.map((r) => `
                    <tr>
                      <td class="mono">${esc(r.number)}</td>
                      <td class="small">${dt(r.countedAt)}</td>
                      <td>${r.status === 'posted' ? '<span class="badge ok">Проведена</span>' : '<span class="badge">Черновик</span>'}</td>
                      <td class="num">${num(r.itemsCount)}</td>
                      <td class="num">${num(r.diffCount)}</td>
                      <td class="small">${esc(r.authorName)}</td>
                      <td class="actions"><button class="btn btn-sm btn-ghost" data-open-inventory="${r.id}">Открыть</button></td>
                    </tr>`).join('')}
                </tbody>
              </table>
            </div>` : emptyState('Инвентаризаций ещё не было')}
        </div>`;
      body.querySelector('[data-new-inventory]').addEventListener('click', () => openInventoryCreate(ctx));
      body.querySelectorAll('[data-open-inventory]').forEach((btn) => {
        btn.addEventListener('click', () => openInventory(Number(btn.dataset.openInventory), ctx));
      });
    } catch (err) {
      body.innerHTML = `<div class="card"><div class="error-box">${esc(err.message)}</div></div>`;
    }
  }

  setTab(tabState.tab);
  return root;
}

function openAdjust(row, ctx) {
  const items = [];
  const body = el(`<form>
    <div class="form-grid">
      <label class="field full"><span class="field-label">Товар *</span>
        <div class="row">
          <input class="input" name="label" readonly value="${esc(row ? row.name : '')}" placeholder="Выберите товар">
          <button type="button" class="btn btn-sm" data-pick>Выбрать</button>
        </div>
      </label>
      <label class="field"><span class="field-label">Фактическое количество</span>
        <input class="input num" name="qty" inputmode="numeric" placeholder="0"></label>
      <label class="field"><span class="field-label">Причина *</span>
        <input class="input" name="reason" placeholder="пересорт, порча, ошибка учёта"></label>
    </div>
    <p class="field-hint">Остаток изменится на разницу между фактическим и текущим количеством. Операция попадёт в журнал.</p>
  </form>`);

  let selected = row ? { variantId: row.variantId, name: row.name } : null;

  body.querySelector('[data-pick]').addEventListener('click', () => {
    variantPicker({
      title: 'Товар для корректировки',
      inStock: false,
      onPick: (picked) => {
        selected = { variantId: picked.variantId, name: `${picked.productName} ${[picked.size, picked.color].filter(Boolean).join(' ')}`.trim() };
        body.elements.label.value = selected.name;
        body.elements.qty.value = String(picked.qty);
      },
    });
  });
  if (row) body.elements.qty.value = String(row.qty || 0);

  const footer = el('<div class="row"><button type="button" class="btn" data-close>Отмена</button><button type="button" class="btn btn-primary" data-save>Применить</button></div>');
  const m = modal({ title: 'Корректировка остатка', body, footer });
  footer.querySelector('[data-save]').addEventListener('click', async (e) => {
    const submitBtn = e.currentTarget;
    submitBtn.disabled = true;
    try {
      if (!selected) throw new Error('Выберите товар');
      const qty = Number(body.elements.qty.value.replace(',', '.'));
      if (!Number.isInteger(qty) || qty < 0) throw new Error('Укажите фактическое количество целым числом');
      const reason = body.elements.reason.value.trim();
      if (!reason) throw new Error('Укажите причину корректировки');
      await api('/api/stock/adjustments', { method: 'POST', body: { variantId: selected.variantId, qty, reason } });
      m.close();
      toast('Остаток скорректирован');
      ctx.refresh();
    } catch (err) {
      toast(err.message, 'error');
    } finally { submitBtn.disabled = false; }
  });
}

function openInventoryCreate(ctx) {
  const items = [];
  const body = el(`<form>
    <div class="row">
      <button type="button" class="btn btn-sm" data-add>Добавить позицию</button>
      <span class="small muted">Фактическое количество фиксируется на дату документа</span>
    </div>
    <div class="stack section-gap" data-lines></div>
    <label class="field section-gap"><span class="field-label">Комментарий</span>
      <input class="input" name="comment"></label>
  </form>`);
  const lines = body.querySelector('[data-lines]');

  function render() {
    if (!items.length) { lines.innerHTML = '<div class="empty">Добавьте позиции для пересчёта</div>'; return; }
    lines.innerHTML = items.map((item, index) => `
      <div class="cart-line" data-line="${index}">
        <div class="stack">
          <strong>${esc(item.name)}</strong>
          <span class="small muted">${esc(item.sku)} · учётное количество ${num(item.expected)}</span>
        </div>
        <input class="input sm num" data-actual value="${item.actual}" inputmode="numeric" aria-label="Фактическое количество">
        <span></span><span></span>
        <button type="button" class="btn btn-sm btn-ghost" data-remove aria-label="Удалить">✕</button>
      </div>`).join('');
    lines.querySelectorAll('[data-line]').forEach((row) => {
      const index = Number(row.dataset.line);
      row.querySelector('[data-actual]').addEventListener('change', (e) => {
        items[index].actual = Math.max(0, Math.round(Number(e.target.value.replace(',', '.')) || 0));
      });
      row.querySelector('[data-remove]').addEventListener('click', () => { items.splice(index, 1); render(); });
    });
  }

  body.querySelector('[data-add]').addEventListener('click', () => {
    variantPicker({
      title: 'Позиция инвентаризации',
      inStock: false,
      onPick: (picked) => {
        if (items.some((i) => i.variantId === picked.variantId)) { toast('Позиция уже добавлена', 'error'); return; }
        items.push({
          variantId: picked.variantId,
          name: picked.productName,
          sku: picked.sku,
          expected: picked.qty,
          actual: picked.qty,
        });
        render();
      },
    });
  });
  render();

  const footer = el('<div class="row"><button type="button" class="btn" data-close>Отмена</button><button type="button" class="btn btn-primary" data-save>Создать документ</button></div>');
  const m = modal({ title: 'Новая инвентаризация', body, footer, wide: true });
  footer.querySelector('[data-save]').addEventListener('click', async (e) => {
    const submitBtn = e.currentTarget;
    submitBtn.disabled = true;
    try {
      if (!items.length) throw new Error('Добавьте хотя бы одну позицию');
      const doc = await api('/api/inventory', {
        method: 'POST',
        body: {
          comment: body.elements.comment.value.trim() || undefined,
          items: items.map((i) => ({ variantId: i.variantId, qtyActual: i.actual })),
        },
      });
      m.close();
      toast('Документ создан');
      openInventory(doc.id, ctx);
    } catch (err) {
      toast(err.message, 'error');
    } finally { submitBtn.disabled = false; }
  });
}

async function openInventory(id, ctx) {
  try {
    const doc = await api(`/api/inventory/${id}`);
    const rows = doc.items.map((i) => `
      <tr>
        <td>${esc(i.name)}<div class="small muted mono">${esc(i.sku)}</div></td>
        <td>${esc([i.size, i.color].filter(Boolean).join(' · ') || '—')}</td>
        <td class="num">${num(i.qtyExpected)}</td>
        <td class="num">${num(i.qtyActual)}</td>
        <td class="num">${i.diff === 0 ? '0' : `<span class="badge ${i.diff > 0 ? 'info' : 'warn'}">${i.diff > 0 ? '+' : ''}${num(i.diff)}</span>`}</td>
      </tr>`).join('');

    const body = el(`<div>
      <div class="detail-grid">
        <div class="detail-item"><div class="k">Номер</div><div class="v">${esc(doc.number)}</div></div>
        <div class="detail-item"><div class="k">Дата</div><div class="v">${dt(doc.countedAt)}</div></div>
        <div class="detail-item"><div class="k">Статус</div><div class="v">${doc.status === 'posted' ? 'Проведена' : 'Черновик'}</div></div>
        <div class="detail-item"><div class="k">Автор</div><div class="v">${esc(doc.authorName)}</div></div>
      </div>
      <div class="table-wrap section-gap">
        <table class="table">
          <thead><tr><th>Товар</th><th>Вариант</th><th class="num">Учёт</th><th class="num">Факт</th><th class="num">Разница</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`);
    const footer = el('<div class="row"></div>');
    if (doc.status === 'draft') {
      const post = el('<button type="button" class="btn btn-primary">Провести инвентаризацию</button>');
      post.addEventListener('click', async () => {
        const ok = await confirmDialog('Расхождения будут проведены по складу. Отменить документ после проведения нельзя.', { confirmText: 'Провести' });
        if (!ok) return;
        post.disabled = true;
        try {
          await api(`/api/inventory/${doc.id}/post`, { method: 'POST', body: {} });
          m.close();
          toast('Инвентаризация проведена');
          ctx.refresh();
        } catch (err) { toast(err.message, 'error'); post.disabled = false; }
      });
      footer.appendChild(post);
    } else {
      footer.innerHTML = '<span class="small muted">Документ проведён, изменения отражены на складе</span>';
    }
    const close = el('<button type="button" class="btn" data-close>Закрыть</button>');
    footer.prepend(close);
    const m = modal({ title: `Инвентаризация ${doc.number}`, body, footer, wide: true });
  } catch (err) {
    toast(err.message, 'error');
  }
}

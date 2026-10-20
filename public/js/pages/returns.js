import {
  api, dateOnly, dt, el, emptyState, esc, modal, money, num, pageHeader, toast,
} from '../core.js';

export async function renderReturns(rest, ctx) {
  if (rest[0]) return renderReturnList(ctx, Number(rest[0]));
  return renderReturnList(ctx);
}

async function renderReturnList(ctx, focusId) {
  const root = el(`<div>
    ${pageHeader({ title: 'Возвраты', subtitle: 'Возврат товара покупателем и его влияние на остаток' })}
    <div data-body><div class="card"><div class="skeleton"></div><div class="skeleton"></div></div></div>
  </div>`);
  const body = root.querySelector('[data-body]');
  try {
    const rows = await api('/api/returns');
    body.innerHTML = rows.length ? `
      <div class="card">
        <div class="table-wrap desktop-table">
          <table class="table">
            <thead><tr>
              <th>Номер</th><th>Продажа</th><th>Причина</th><th class="num">Количество</th>
              <th class="num">Сумма</th><th>Состояние</th><th>Дата</th><th>Сотрудник</th>
            </tr></thead>
            <tbody>
              ${rows.map((r) => `
                <tr class="clickable" data-open="${r.id}">
                  <td class="mono"><strong>${esc(r.number)}</strong></td>
                  <td class="mono">${esc(r.saleNumber)}</td>
                  <td class="small">${esc(r.reason)}</td>
                  <td class="num">${num(r.qty)}</td>
                  <td class="num">${money(r.totalKop)}</td>
                  <td>${r.hasDamaged ? '<span class="badge warn">есть повреждённый</span>' : '<span class="badge ok">в продажу</span>'}</td>
                  <td class="small nowrap">${dt(r.createdAt)}</td>
                  <td class="small">${esc(r.authorName)}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
        <div class="mobile-cards">
          ${rows.map((r) => `
            <div class="mcard" data-open="${r.id}">
              <div class="mcard-top"><div class="mcard-title">${esc(r.number)}</div><strong>${money(r.totalKop)}</strong></div>
              <div class="mcard-meta"><span>${esc(r.saleNumber)}</span><span>${num(r.qty)} шт</span><span>${dateOnly(r.createdAt)}</span></div>
              <div class="small muted">${esc(r.reason)}</div>
            </div>`).join('')}
        </div>
      </div>` : `<div class="card">${emptyState('Возвратов нет')}</div>`;

    body.querySelectorAll('[data-open]').forEach((node) => {
      node.addEventListener('click', () => openReturnDetail(Number(node.dataset.open)));
    });
    if (focusId) openReturnDetail(focusId);
  } catch (err) {
    body.innerHTML = `<div class="card"><div class="error-box">${esc(err.message)}</div></div>`;
  }
  return root;
}

async function openReturnDetail(id) {
  try {
    const r = await api(`/api/returns/${id}`);
    const body = el(`<div>
      <div class="detail-grid">
        <div class="detail-item"><div class="k">Номер</div><div class="v">${esc(r.number)}</div></div>
        <div class="detail-item"><div class="k">Продажа</div><div class="v"><a href="#/sales/${r.saleId}">${esc(r.saleNumber)}</a></div></div>
        <div class="detail-item"><div class="k">Дата</div><div class="v">${dt(r.createdAt)}</div></div>
        <div class="detail-item"><div class="k">Сотрудник</div><div class="v">${esc(r.authorName)}</div></div>
        <div class="detail-item"><div class="k">Сумма возврата</div><div class="v">${money(r.totalKop)}</div></div>
        <div class="detail-item"><div class="k">Причина</div><div class="v">${esc(r.reason)}</div></div>
      </div>
      <div class="table-wrap section-gap">
        <table class="table">
          <thead><tr><th>Товар</th><th>Артикул</th><th>Размер / цвет</th><th class="num">Количество</th><th class="num">Цена</th><th>Состояние</th></tr></thead>
          <tbody>
            ${r.items.map((i) => `
              <tr>
                <td>${esc(i.name)}</td>
                <td class="mono">${esc(i.sku)}</td>
                <td>${esc([i.size, i.color].filter(Boolean).join(' · ') || '—')}</td>
                <td class="num">${num(i.qty)}</td>
                <td class="num">${money(i.priceKop)}</td>
                <td>${i.condition === 'damaged' ? '<span class="badge warn">повреждён</span>' : '<span class="badge ok">в продажу</span>'}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>`);
    const footer = el('<div class="row"><button type="button" class="btn" data-close>Закрыть</button></div>');
    modal({ title: `Возврат ${r.number}`, body, footer, wide: true });
  } catch (err) {
    toast(err.message, 'error');
  }
}

export function openReturnModal(sale, ctx) {
  const rows = sale.items.filter((i) => i.returnableQty > 0);
  if (!rows.length) { toast('Все позиции этой продажи уже возвращены', 'error'); return; }

  const body = el(`<form>
    <label class="field"><span class="field-label">Причина возврата *</span>
      <input class="input" name="reason" required placeholder="не подошёл размер, брак"></label>
    <div class="stack section-gap">
      ${rows.map((i) => `
        <div class="cart-line" data-line="${i.id}">
          <div class="stack">
            <strong>${esc(i.name)}</strong>
            <span class="small muted">${esc(i.sku)} · ${esc([i.size, i.color].filter(Boolean).join(' · ') || '—')} · к возврату ${num(i.returnableQty)}</span>
          </div>
          <input class="input sm num" data-qty value="0" inputmode="numeric" aria-label="Количество">
          <select class="select sm" data-condition aria-label="Состояние">
            <option value="sellable">В продажу</option>
            <option value="damaged">Повреждён</option>
          </select>
          <span class="line-sum num small">${money(i.priceKop)}</span>
          <span></span>
        </div>`).join('')}
    </div>
    <div class="info-box section-gap">Возврат пригодного товара увеличивает доступный остаток. Повреждённый товар в продажу не возвращается. Повторный возврат того же количества запрещён.</div>
  </form>`);

  const footer = el('<div class="row"><button type="button" class="btn" data-close>Отмена</button><button type="button" class="btn btn-primary" data-save>Оформить возврат</button></div>');
  const m = modal({ title: `Возврат по продаже ${sale.number}`, body, footer, wide: true });

  footer.querySelector('[data-save]').addEventListener('click', async (e) => {
    const submitBtn = e.currentTarget;
    submitBtn.disabled = true;
    try {
      const reason = body.elements.reason.value.trim();
      if (!reason) throw new Error('Укажите причину возврата');
      const items = [];
      body.querySelectorAll('[data-line]').forEach((row) => {
        const qty = Math.round(Number(row.querySelector('[data-qty]').value.replace(',', '.')) || 0);
        const source = rows.find((r) => String(r.id) === row.dataset.line);
        if (qty <= 0) return;
        if (qty > source.returnableQty) throw new Error(`«${source.name}»: к возврату доступно ${source.returnableQty}`);
        items.push({ saleItemId: source.id, qty, condition: row.querySelector('[data-condition]').value });
      });
      if (!items.length) throw new Error('Укажите количество для возврата');
      const created = await api('/api/returns', {
        method: 'POST',
        body: { saleId: sale.id, reason, items, clientRef: crypto.randomUUID() },
      });
      m.close();
      toast(`Возврат ${created.number} оформлен`);
      ctx.refresh();
    } catch (err) {
      toast(err.message, 'error');
    } finally { submitBtn.disabled = false; }
  });
}

import {
  api, can, confirmDialog, dateOnly, dt, el, emptyState, esc, modal, money, num, pageHeader,
  state, statusBadge, toast, todayInput,
} from '../core.js';

export async function renderReceipts(rest, ctx) {
  if (rest[0]) return renderReceipt(rest[0], ctx);
  return renderReceiptList(ctx);
}

async function renderReceiptList(ctx) {
  const root = el(`<div>
    ${pageHeader({ title: 'Приёмка', subtitle: 'Фактическое поступление товара и недостачи' })}
    <div data-body><div class="card"><div class="skeleton"></div><div class="skeleton"></div></div></div>
  </div>`);
  const body = root.querySelector('[data-body]');
  try {
    const rows = await api('/api/receipts');
    body.innerHTML = rows.length ? `
      <div class="card">
        <div class="table-wrap desktop-table">
          <table class="table">
            <thead><tr><th>Номер</th><th>Закупка</th><th>Поставщик</th><th>Дата</th><th>Статус</th><th class="num">Позиций</th><th class="num">Принято</th><th>Сотрудник</th></tr></thead>
            <tbody>
              ${rows.map((r) => `
                <tr class="clickable" data-open="${r.id}">
                  <td class="mono"><strong>${esc(r.number)}</strong></td>
                  <td class="mono">${esc(r.purchaseNumber)}</td>
                  <td>${esc(r.supplierName)}</td>
                  <td class="small muted nowrap">${dateOnly(r.receiptDate)}</td>
                  <td>${statusBadge(r.status, r.statusLabel)}</td>
                  <td class="num">${num(r.lines)}</td>
                  <td class="num">${num(r.qty)}</td>
                  <td class="small">${esc(r.authorName)}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
        <div class="mobile-cards">
          ${rows.map((r) => `
            <div class="mcard" data-open="${r.id}">
              <div class="mcard-top"><div class="mcard-title">${esc(r.number)}</div>${statusBadge(r.status, r.statusLabel)}</div>
              <div class="mcard-meta"><span>${esc(r.purchaseNumber)}</span><span>${esc(r.supplierName)}</span></div>
              <div class="mcard-meta"><span>${dateOnly(r.receiptDate)}</span><span>${num(r.qty)} шт</span></div>
            </div>`).join('')}
        </div>
      </div>` : `<div class="card">${emptyState('Приёмок нет. Создайте приёмку из закупки в статусе «Заказана».')}</div>`;
    body.querySelectorAll('[data-open]').forEach((node) => {
      node.addEventListener('click', () => ctx.navigate(`#/receipts/${node.dataset.open}`));
    });
  } catch (err) {
    body.innerHTML = `<div class="card"><div class="error-box">${esc(err.message)}</div></div>`;
  }
  return root;
}

async function renderReceipt(id, ctx) {
  const r = await api(`/api/receipts/${id}`);
  const draft = r.status === 'draft';
  const root = el(`<div>
    <div class="card-head">
      <div>
        <a class="small muted" href="#/receipts">← Приёмка</a>
        <h1>${esc(r.number)}</h1>
        <p class="muted small">Закупка <a href="#/purchases/${r.purchaseId}">${esc(r.purchaseNumber)}</a> · ${esc(r.supplierName)}</p>
      </div>
      <div class="spacer"></div>
      <div class="row">
        ${statusBadge(r.status, r.statusLabel)}
        ${draft && can('receipt.post') ? '<button class="btn btn-sm btn-primary" data-post>Провести приёмку</button>' : ''}
        ${draft && can('receipt.create') ? '<button class="btn btn-sm btn-danger" data-delete>Удалить черновик</button>' : ''}
      </div>
    </div>

    <div class="card">
      <div class="detail-grid">
        <div class="detail-item"><div class="k">Дата приёмки</div><div class="v">${dateOnly(r.receiptDate)}</div></div>
        <div class="detail-item"><div class="k">Сотрудник</div><div class="v">${esc(r.authorName)}</div></div>
        <div class="detail-item"><div class="k">Принято всего</div><div class="v">${num(r.totals.qtyReceived)} шт</div></div>
        ${can('cost.view') && r.totals.costTotalKop !== undefined ? `<div class="detail-item"><div class="k">Себестоимость приёмки</div><div class="v">${money(r.totals.costTotalKop)}</div></div>` : ''}
      </div>
      ${r.comment ? `<p class="small section-gap">${esc(r.comment)}</p>` : ''}
      ${draft ? '<p class="info-box section-gap">Черновик не изменяет склад. Укажите фактически принятое количество и проведите приёмку.</p>' : ''}
    </div>

    <div class="card">
      <h2>Позиции</h2>
      <div class="table-wrap section-gap">
        <table class="table">
          <thead><tr>
            <th>Товар</th><th>Артикул</th><th>Размер / цвет</th>
            <th class="num">Заказано</th><th class="num">Принято ранее</th>
            <th class="num">Принято сейчас</th><th class="num">Повреждено</th><th class="num">Недостача</th>
            ${can('cost.view') ? '<th class="num">Себестоимость</th>' : ''}
          </tr></thead>
          <tbody data-items>
            ${r.items.map((i) => `
              <tr data-item="${i.id}">
                <td>${esc(i.productName)}</td>
                <td class="mono">${esc(i.sku)}</td>
                <td>${esc([i.size, i.color].filter(Boolean).join(' · ') || '—')}</td>
                <td class="num">${num(i.qtyOrdered)}</td>
                <td class="num">${num(i.previouslyReceived)}</td>
                <td class="num">${draft
    ? `<input class="input sm num" style="max-width:90px;margin-left:auto" data-qty value="${i.qtyReceived}" inputmode="numeric">`
    : num(i.qtyReceived)}</td>
                <td class="num">${draft
    ? `<input class="input sm num" style="max-width:90px;margin-left:auto" data-damaged value="${i.qtyDamaged}" inputmode="numeric">`
    : num(i.qtyDamaged)}</td>
                <td class="num">${num(Math.max(i.qtyOrdered - i.previouslyReceived - i.qtyReceived, 0))}</td>
                ${can('cost.view') ? `<td class="num">${i.costTotalKop === undefined ? '—' : money(i.costTotalKop)}</td>` : ''}
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
      ${draft ? '<div class="row section-gap"><button class="btn btn-sm" data-save>Сохранить количества</button><span class="small muted">Изменения не влияют на склад до проведения.</span></div>' : ''}
    </div>

    ${r.expenses.length ? `
      <div class="card">
        <h2>Расходы, отнесённые на приёмку</h2>
        <div class="table-wrap section-gap">
          <table class="table">
            <thead><tr><th>Категория</th><th class="num">Сумма</th><th>Метод</th><th>Статус</th></tr></thead>
            <tbody>
              ${r.expenses.map((e) => `
                <tr>
                  <td>${esc(state.expenseCategories[e.category] || e.category)}</td>
                  <td class="num">${money(e.amountKop)}</td>
                  <td>${esc(state.allocationMethods[e.method] || e.method)}</td>
                  <td>${e.appliedAt ? '<span class="badge ok">Распределён</span>' : '<span class="badge warn">Будет распределён при проведении</span>'}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>` : ''}
  </div>`);

  const saveBtn = root.querySelector('[data-save]');
  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      try {
        const items = [...root.querySelectorAll('[data-item]')].map((row) => ({
          id: Number(row.dataset.item),
          qtyReceived: Math.max(0, Math.round(Number(row.querySelector('[data-qty]').value.replace(',', '.')) || 0)),
          qtyDamaged: Math.max(0, Math.round(Number(row.querySelector('[data-damaged]').value.replace(',', '.')) || 0)),
        }));
        await api(`/api/receipts/${r.id}`, { method: 'PATCH', body: { items } });
        toast('Количества сохранены');
        ctx.refresh();
      } catch (err) { toast(err.message, 'error'); } finally { saveBtn.disabled = false; }
    });
  }

  const postBtn = root.querySelector('[data-post]');
  if (postBtn) {
    postBtn.addEventListener('click', async () => {
      const ok = await confirmDialog('После проведения приёмки склад и себестоимость изменятся. Отменить проведение нельзя — только обратной операцией.', { confirmText: 'Провести' });
      if (!ok) return;
      try {
        await api(`/api/receipts/${r.id}/post`, { method: 'POST', body: {} });
        toast('Приёмка проведена');
        ctx.refresh();
      } catch (err) { toast(err.message, 'error'); }
    });
  }

  const deleteBtn = root.querySelector('[data-delete]');
  if (deleteBtn) {
    deleteBtn.addEventListener('click', async () => {
      const ok = await confirmDialog('Черновик приёмки будет удалён вместе с ещё не применёнными расходами.', { confirmText: 'Удалить', danger: true });
      if (!ok) return;
      try {
        await api(`/api/receipts/${r.id}`, { method: 'DELETE' });
        toast('Черновик удалён');
        ctx.navigate(`#/purchases/${r.purchaseId}`);
      } catch (err) { toast(err.message, 'error'); }
    });
  }

  return root;
}

export function openReceiptCreate(purchase, ctx) {
  const body = el(`<form>
    <div class="form-grid">
      <label class="field"><span class="field-label">Дата приёмки</span>
        <input class="input" type="date" name="receiptDate" value="${todayInput()}"></label>
      <label class="field"><span class="field-label">Комментарий</span>
        <input class="input" name="comment"></label>
    </div>
    <p class="field-hint section-gap">Количества по умолчанию — остаток к получению. Их можно изменить в документе приёмки.</p>
  </form>`);
  const footer = el('<div class="row"><button type="button" class="btn" data-close>Отмена</button><button type="button" class="btn btn-primary" data-save>Создать приёмку</button></div>');
  const m = modal({ title: 'Приёмка товара', body, footer });
  footer.querySelector('[data-save]').addEventListener('click', async (e) => {
    const submitBtn = e.currentTarget;
    submitBtn.disabled = true;
    try {
      const receipt = await api(`/api/purchases/${purchase.id}/receipts`, {
        method: 'POST',
        body: {
          clientRef: crypto.randomUUID(),
          receiptDate: body.elements.receiptDate.value || undefined,
          comment: body.elements.comment.value.trim() || undefined,
        },
      });
      m.close();
      ctx.navigate(`#/receipts/${receipt.id}`);
    } catch (err) { toast(err.message, 'error'); } finally { submitBtn.disabled = false; }
  });
}

import {
  api, dt, el, emptyState, esc, num, pageHeader, state, toast,
} from '../core.js';

export async function renderSettings(rest, ctx) {
  const root = el(`<div>
    ${pageHeader({ title: 'Настройки', subtitle: 'Параметры магазина, безопасность и журнал действий' })}
    <div class="grid cols-2">
      <div class="card" data-settings>
        <h2>Параметры магазина</h2>
        <div class="skeleton section-gap"></div>
      </div>
      <div class="card">
        <h2>Смена пароля</h2>
        <form data-password class="section-gap">
          <label class="field"><span class="field-label">Текущий пароль</span>
            <input class="input" type="password" name="oldPassword" autocomplete="current-password" required></label>
          <label class="field section-gap"><span class="field-label">Новый пароль</span>
            <input class="input" type="password" name="newPassword" minlength="8" autocomplete="new-password" required></label>
          <button class="btn btn-primary section-gap" type="submit">Изменить пароль</button>
          <p class="field-hint">После смены пароля потребуется войти заново.</p>
        </form>
      </div>
    </div>
    <div class="card" data-system>
      <h2>Состояние системы</h2>
      <div class="skeleton section-gap"></div>
    </div>
    <div class="card">
      <div class="card-head">
        <h2>Журнал действий</h2>
        <div class="spacer"></div>
        <input class="input sm" style="max-width:220px" type="search" data-audit-filter placeholder="Фильтр по действию">
      </div>
      <div data-audit><div class="skeleton"></div></div>
    </div>
  </div>`);

  const settingsCard = root.querySelector('[data-settings]');
  try {
    const s = await api('/api/settings');
    settingsCard.innerHTML = `
      <div class="card-head"><h2>Параметры магазина</h2></div>
      <form data-settings-form>
        <label class="field"><span class="field-label">Название магазина</span>
          <input class="input" name="company_name" value="${esc(s.company_name || '')}"></label>
        <label class="field section-gap"><span class="field-label">Порог низкого остатка, шт</span>
          <input class="input num" name="low_stock_threshold" inputmode="numeric" value="${esc(s.low_stock_threshold || 0)}"></label>
        <label class="field section-gap"><span class="field-label">Максимальная скидка продавца, %</span>
          <input class="input num" name="max_seller_discount_percent" inputmode="decimal" value="${esc(s.max_seller_discount_percent || 0)}"></label>
        <label class="field section-gap"><span class="field-label">Примечание для закупок</span>
          <textarea class="textarea" name="purchase_note">${esc(s.purchase_note || '')}</textarea></label>
        <button class="btn btn-primary section-gap" type="submit">Сохранить параметры</button>
      </form>`;
    settingsCard.querySelector('[data-settings-form]').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.currentTarget;
      const btn = form.querySelector('button[type="submit"]');
      btn.disabled = true;
      try {
        const updated = await api('/api/settings', {
          method: 'PATCH',
          body: {
            company_name: form.elements.company_name.value.trim(),
            low_stock_threshold: form.elements.low_stock_threshold.value.trim(),
            max_seller_discount_percent: form.elements.max_seller_discount_percent.value.trim(),
            purchase_note: form.elements.purchase_note.value,
          },
        });
        state.settings.lowStockThreshold = Number(updated.low_stock_threshold);
        state.settings.companyName = updated.company_name;
        toast('Параметры сохранены');
      } catch (err) {
        toast(err.message, 'error');
      } finally { btn.disabled = false; }
    });
  } catch (err) {
    settingsCard.innerHTML = `<h2>Параметры магазина</h2><div class="error-box section-gap">${esc(err.message)}</div>`;
  }

  root.querySelector('[data-password]').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      await api('/api/users/me/password', {
        method: 'POST',
        body: {
          oldPassword: form.elements.oldPassword.value,
          newPassword: form.elements.newPassword.value,
        },
      });
      form.reset();
      toast('Пароль изменён, войдите заново');
      setTimeout(() => { location.reload(); }, 800);
    } catch (err) {
      toast(err.message, 'error');
    } finally { btn.disabled = false; }
  });

  const systemCard = root.querySelector('[data-system]');
  try {
    const info = await api('/api/system');
    const c = info.counts;
    systemCard.innerHTML = `
      <h2>Состояние системы</h2>
      <div class="detail-grid section-gap">
        <div class="detail-item"><div class="k">Версия</div><div class="v">${esc(info.version)}</div></div>
        <div class="detail-item"><div class="k">Валюта учёта</div><div class="v">${esc(info.currency)}</div></div>
        <div class="detail-item"><div class="k">Моделей / вариантов</div><div class="v">${num(c.products)} / ${num(c.variants)}</div></div>
        <div class="detail-item"><div class="k">Закупок</div><div class="v">${num(c.purchases)}</div></div>
        <div class="detail-item"><div class="k">Приёмок</div><div class="v">${num(c.receipts)}</div></div>
        <div class="detail-item"><div class="k">Продаж / возвратов</div><div class="v">${num(c.sales)} / ${num(c.returns)}</div></div>
        <div class="detail-item"><div class="k">Складских движений</div><div class="v">${num(c.movements)}</div></div>
      </div>
      ${info.addresses && info.addresses.length ? `<div class="info-box section-gap"><strong>Адрес для телефона:</strong> ${info.addresses.map((a) => `<code>http://${esc(a.address)}:${esc(String(info.port || 3000))}</code>`).join(', ')}<div class="small">Телефон и компьютер должны быть в одной сети Wi-Fi.</div></div>` : ''}
      <p class="info-box section-gap">${esc(info.backupHint)}</p>`;
  } catch (err) {
    systemCard.innerHTML = `<h2>Состояние системы</h2><div class="error-box section-gap">${esc(err.message)}</div>`;
  }

  const auditBox = root.querySelector('[data-audit]');
  let auditTimer = null;

  async function loadAudit(action) {
    auditBox.innerHTML = '<div class="skeleton"></div>';
    try {
      const params = new URLSearchParams({ limit: '100' });
      if (action) params.set('action', action);
      const rows = await api(`/api/audit?${params.toString()}`);
      auditBox.innerHTML = rows.length ? `
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>Дата</th><th>Сотрудник</th><th>Действие</th><th>Объект</th><th>Детали</th></tr></thead>
            <tbody>
              ${rows.map((r) => `
                <tr>
                  <td class="small nowrap">${dt(r.at)}</td>
                  <td class="small">${esc(r.login || '—')}</td>
                  <td class="mono small">${esc(r.action)}</td>
                  <td class="small">${esc(r.entity || '—')}${r.entityId ? ` #${esc(r.entityId)}` : ''}</td>
                  <td class="small muted">${esc(r.details ? JSON.stringify(r.details) : '')}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>` : emptyState('Записей журнала нет');
    } catch (err) {
      auditBox.innerHTML = `<div class="error-box">${esc(err.message)}</div>`;
    }
  }

  root.querySelector('[data-audit-filter]').addEventListener('input', (e) => {
    clearTimeout(auditTimer);
    const value = e.target.value.trim();
    auditTimer = setTimeout(() => loadAudit(value), 240);
  });
  await loadAudit('');
  return root;
}

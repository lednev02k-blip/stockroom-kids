export const state = {
  user: null,
  settings: {},
  categories: [],
  suppliers: [],
  roles: {},
  expenseCategories: {},
  allocationMethods: {},
  sellerDiscountLimit: 10,
};

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    this.name = 'HttpError';
  }
}

export function can(permission) {
  const perms = (state.user && state.user.permissions) || [];
  return perms.includes('*') || perms.includes(permission);
}

export async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new HttpError(0, 'Нет связи с сервером. Проверьте подключение и повторите действие.');
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (res.status === 401 && state.user) {
    state.user = null;
    document.dispatchEvent(new CustomEvent('auth:expired'));
  }
  if (!res.ok) throw new HttpError(res.status, (data && data.error) || `Ошибка ${res.status}`);
  return data;
}

export function esc(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const moneyFmt = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const intFmt = new Intl.NumberFormat('ru-RU');

export function money(kop) {
  if (kop === null || kop === undefined) return '—';
  return `${moneyFmt.format(Number(kop) / 100)} ₽`;
}

export function moneyPlain(kop) {
  return moneyFmt.format(Number(kop || 0) / 100);
}

export function cny(fen) {
  if (fen === null || fen === undefined) return '—';
  return `¥${moneyFmt.format(Number(fen) / 100)}`;
}

export function rateText(rateX10000) {
  if (rateX10000 === null || rateX10000 === undefined) return '—';
  return (Number(rateX10000) / 10000).toFixed(4);
}

export function num(value) {
  return intFmt.format(Number(value || 0));
}

export function parseMoney(value) {
  const n = typeof value === 'string' ? Number(value.replace(/\s/g, '').replace(',', '.')) : Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

export function kopToInput(kop) {
  return (Number(kop || 0) / 100).toFixed(2);
}

export function dt(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function dateOnly(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('ru-RU');
}

export function todayInput() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function monthStartInput() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-01`;
}

export function toast(message, type = 'ok') {
  const root = document.getElementById('toast-root');
  if (!root) return;
  const node = document.createElement('div');
  node.className = `toast ${type === 'error' ? 'error' : type === 'info' ? '' : 'ok'}`;
  node.textContent = message;
  root.appendChild(node);
  setTimeout(() => {
    node.style.opacity = '0';
    node.style.transition = 'opacity .2s';
    setTimeout(() => node.remove(), 220);
  }, type === 'error' ? 6000 : 3500);
}

export function el(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html.trim();
  return tpl.content.firstElementChild;
}

const modalStack = [];

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const top = modalStack[modalStack.length - 1];
  if (top) top();
});

export function modal({ title, body, footer, wide = false, onMount }) {
  const backdrop = el(`
    <div class="modal-backdrop">
      <div class="modal${wide ? ' wide' : ''}" role="dialog" aria-modal="true">
        <div class="modal-head">
          <h3>${esc(title)}</h3>
          <button type="button" class="btn btn-ghost btn-icon" data-close aria-label="Закрыть">✕</button>
        </div>
        <div class="modal-body"></div>
        ${footer === undefined ? '' : '<div class="modal-footer"></div>'}
      </div>
    </div>`);
  const bodyNode = backdrop.querySelector('.modal-body');
  if (typeof body === 'string') bodyNode.innerHTML = body;
  else if (body) bodyNode.appendChild(body);
  if (footer !== undefined) {
    const footNode = backdrop.querySelector('.modal-footer');
    if (typeof footer === 'string') footNode.innerHTML = footer;
    else if (footer) footNode.appendChild(footer);
  }
  document.body.appendChild(backdrop);
  const close = () => {
    if (!backdrop.isConnected) return;
    backdrop.remove();
    const index = modalStack.indexOf(close);
    if (index >= 0) modalStack.splice(index, 1);
  };
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop || e.target.closest('[data-close]')) close();
  });
  modalStack.push(close);
  if (onMount) onMount(backdrop);
  const firstInput = backdrop.querySelector('input, select, textarea');
  if (firstInput) firstInput.focus();
  return { root: backdrop, body: bodyNode, close };
}

export function closeModal() {
  const top = modalStack[modalStack.length - 1];
  if (top) top();
}

export function closeAllModals() {
  while (modalStack.length) {
    const close = modalStack.pop();
    close();
  }
}

export function promptDialog({ title = 'Введите значение', label = 'Значение', value = '', required = true, confirmText = 'Сохранить' } = {}) {
  return new Promise((resolve) => {
    const body = el(`<label class="field"><span class="field-label">${esc(label)}</span>
      <input class="input" name="value" value="${esc(value)}"></label>`);
    const footer = el(`<div class="row">
      <button type="button" class="btn" data-close>Отмена</button>
      <button type="button" class="btn btn-primary" data-ok>${esc(confirmText)}</button>
    </div>`);
    let settled = false;
    const m = modal({
      title,
      body,
      footer,
      onMount(root) {
        root.addEventListener('remove', () => { if (!settled) { settled = true; resolve(null); } });
      },
    });
    footer.querySelector('[data-close]').addEventListener('click', () => { settled = true; resolve(null); });
    const ok = () => {
      const text = body.querySelector('[name="value"]').value.trim();
      if (required && !text) return;
      settled = true;
      m.close();
      resolve(text);
    };
    footer.querySelector('[data-ok]').addEventListener('click', ok);
    body.querySelector('[name="value"]').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); ok(); }
    });
  });
}

export function confirmDialog(message, { title = 'Подтвердите действие', confirmText = 'Подтвердить', danger = false } = {}) {
  return new Promise((resolve) => {
    const footer = el('<div class="row"></div>');
    const cancel = el('<button type="button" class="btn">Отмена</button>');
    const ok = el(`<button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'}">${esc(confirmText)}</button>`);
    footer.append(cancel, ok);
    const m = modal({ title, body: `<p>${esc(message)}</p>`, footer });
    cancel.addEventListener('click', () => { m.close(); resolve(false); });
    ok.addEventListener('click', () => { m.close(); resolve(true); });
  });
}

export function statusBadge(status, label) {
  const map = {
    draft: '', pending_approval: 'info', approved: 'info', ordered: 'info',
    partially_paid: 'warn', paid: 'ok', partially_received: 'warn', received: 'ok', cancelled: 'danger',
    posted: 'ok',
  };
  return `<span class="badge ${map[status] || ''}">${esc(label || status)}</span>`;
}

export function stockChip(qty, threshold = 3) {
  if (Number(qty) <= 0) return '<span class="chip out">нет</span>';
  if (Number(qty) <= Number(threshold)) return `<span class="chip low">${num(qty)}</span>`;
  return `<span class="chip">${num(qty)}</span>`;
}

export function emptyState(text) {
  return `<div class="empty">${esc(text)}</div>`;
}

export function skeleton(lines = 4) {
  return `<div class="card">${Array.from({ length: lines }, () => '<div class="skeleton" data-skel></div>').join('')}</div>`;
}

export function errorBox(message, retry) {
  const node = el(`<div class="card"><div class="error-box">${esc(message)}</div></div>`);
  if (retry) {
    const btn = el('<button type="button" class="btn btn-sm section-gap">Повторить</button>');
    btn.addEventListener('click', retry);
    node.appendChild(btn);
  }
  return node;
}

export function options(list, selected, { valueKey = 'id', labelKey = 'name', placeholder = null } = {}) {
  const parts = [];
  if (placeholder !== null) parts.push(`<option value="">${esc(placeholder)}</option>`);
  for (const item of list || []) {
    const value = typeof item === 'object' ? item[valueKey] : item;
    const label = typeof item === 'object' ? item[labelKey] : item;
    parts.push(`<option value="${esc(value)}"${String(value) === String(selected) ? ' selected' : ''}>${esc(label)}</option>`);
  }
  return parts.join('');
}

export async function loadProductVariants(search, { limit = 30 } = {}) {
  const params = new URLSearchParams({ inStock: '1', sort: 'name' });
  if (search) params.set('search', search);
  const products = await api(`/api/products?${params.toString()}`);
  const rows = [];
  for (const p of products) {
    for (const v of p.variants) {
      rows.push({
        productId: p.id,
        productName: p.name,
        sku: p.sku,
        variantId: v.id,
        size: v.size,
        color: v.color,
        styleName: v.styleName,
        qty: v.qty,
        priceKop: v.retailPriceKop,
        photo: p.photo,
      });
      if (rows.length >= limit) return rows;
    }
  }
  return rows;
}

export function variantLabel(row) {
  const bits = [row.name || row.productName, row.size, row.color].filter(Boolean);
  return bits.join(' · ');
}

export function variantPicker({ onPick, inStock = true, title = 'Выбор товара' }) {
  const body = el(`
    <div>
      <input class="input" type="search" placeholder="Артикул или название" data-search>
      <div class="search-results" data-results></div>
    </div>`);
  const input = body.querySelector('[data-search]');
  const results = body.querySelector('[data-results]');
  const m = modal({ title, body, wide: true });
  let timer = null;

  async function run() {
    results.innerHTML = '<div class="search-item muted">Поиск…</div>';
    try {
      const rows = await loadProductVariants(input.value.trim(), { limit: 40 });
      const filtered = inStock ? rows.filter((r) => Number(r.qty) > 0) : rows;
      if (!filtered.length) {
        results.innerHTML = '<div class="search-item muted">Ничего не найдено</div>';
        return;
      }
      results.innerHTML = filtered.map((r, i) => `
        <div class="search-item" data-index="${i}">
          <div class="stack">
            <strong>${esc(r.productName)}</strong>
            <span class="small muted">${esc(r.sku)} · размер ${esc(r.size || '—')} · ${esc(r.color || '—')} · остаток ${num(r.qty)}</span>
          </div>
          <span class="nowrap small">${money(r.priceKop)}</span>
        </div>`).join('');
      results.querySelectorAll('[data-index]').forEach((node) => {
        node.addEventListener('click', () => {
          const row = filtered[Number(node.dataset.index)];
          m.close();
          onPick(row);
        });
      });
    } catch (err) {
      results.innerHTML = `<div class="search-item"><span class="error-box">${esc(err.message)}</span></div>`;
    }
  }

  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(run, 220);
  });
  run();
  return m;
}

export function pageHeader({ title, subtitle, actions }) {
  return `
    <div class="card-head">
      <div>
        <h1>${esc(title)}</h1>
        ${subtitle ? `<p class="muted small">${esc(subtitle)}</p>` : ''}
      </div>
      <div class="spacer"></div>
      <div class="row">${actions || ''}</div>
    </div>`;
}

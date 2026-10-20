import { api, state, can, esc, toast, skeleton, errorBox, closeAllModals } from './core.js';
import { renderDashboard } from './pages/dashboard.js';
import { renderProducts } from './pages/products.js';
import { renderPurchases } from './pages/purchases.js';
import { renderReceipts } from './pages/receipts.js';
import { renderStock } from './pages/stock.js';
import { renderSales } from './pages/sales.js';
import { renderReturns } from './pages/returns.js';
import { renderReports } from './pages/reports.js';
import { renderUsers } from './pages/users.js';
import { renderSettings } from './pages/settings.js';

const NAV = [
  { key: 'dashboard', label: 'Главная', icon: '▦', allow: () => true, render: renderDashboard },
  { key: 'products', label: 'Товары', icon: '▤', allow: () => can('catalog.view'), render: renderProducts },
  { key: 'purchases', label: 'Закупки', icon: '✈', allow: () => can('purchase.view'), render: renderPurchases },
  { key: 'receipts', label: 'Приёмка', icon: '⇩', allow: () => can('receipt.view'), render: renderReceipts },
  { key: 'stock', label: 'Склад', icon: '▥', allow: () => can('stock.view'), render: renderStock },
  { key: 'sales', label: 'Продажи', icon: '₽', allow: () => can('sale.create'), render: renderSales },
  { key: 'returns', label: 'Возвраты', icon: '↩', allow: () => can('return.create'), render: renderReturns },
  {
    key: 'reports',
    label: 'Отчёты',
    icon: '◔',
    allow: () => can('sale.create') || can('reports.purchases') || can('cost.view'),
    render: renderReports,
  },
  { key: 'users', label: 'Сотрудники', icon: '☺', allow: () => can('users.manage'), render: renderUsers },
  { key: 'settings', label: 'Настройки', icon: '⚙', allow: () => can('settings.manage'), render: renderSettings },
];

const shell = document.getElementById('shell');
const content = document.getElementById('content');
const sidebar = document.getElementById('sidebar');
const pageTitle = document.getElementById('page-title');

function navigate(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

function renderNav() {
  const links = NAV.filter((item) => item.allow()).map((item) => `
      <a class="nav-link" href="#/${item.key}" data-nav="${item.key}">
        <span class="nav-ico">${item.icon}</span>
        <span>${esc(item.label)}</span>
      </a>`).join('');
  document.getElementById('nav-links').innerHTML = links;
  document.getElementById('user-box').innerHTML = `
    <div class="user-name">${esc(state.user.fullName || state.user.login)}</div>
    <div class="user-role">${esc(state.user.roleLabel || state.user.role)}</div>`;
}

function setActive(key) {
  sidebar.querySelectorAll('[data-nav]').forEach((link) => {
    link.classList.toggle('active', link.dataset.nav === key);
  });
}

async function route() {
  closeAllModals();
  const raw = location.hash.replace(/^#\/?/, '');
  const parts = raw.split('/').filter(Boolean);
  const key = parts[0] || 'dashboard';
  const rest = parts.slice(1);
  const item = NAV.find((n) => n.key === key);
  if (!item || !item.allow()) {
    pageTitle.textContent = 'Доступ ограничен';
    content.replaceChildren(errorBox('Раздел недоступен для вашей роли.'));
    return;
  }
  setActive(key);
  sidebar.classList.remove('open');
  pageTitle.textContent = item.label;
  content.innerHTML = skeleton(5);
  const ctx = {
    key,
    rest,
    refresh: () => route(),
    navigate,
    title: (text) => { pageTitle.textContent = text; },
  };
  try {
    const node = await item.render(rest, ctx);
    if (node) {
      content.replaceChildren(node);
    }
  } catch (err) {
    if (err && err.status === 401) return;
    content.replaceChildren(errorBox(err.message || 'Не удалось загрузить раздел', () => route()));
  }
}

const loginScreen = document.getElementById('login-screen');
const loginForm = document.getElementById('login-form');
const loginError = document.getElementById('login-error');

async function start() {
  try {
    const data = await api('/api/bootstrap');
    await enter(data);
  } catch (err) {
    if (err.status !== 401) {
      loginError.textContent = err.message;
      loginError.hidden = false;
    }
    showLogin();
  }
}

function showLogin() {
  shell.hidden = true;
  loginScreen.hidden = false;
  const loginInput = loginForm.querySelector('[name="login"]');
  if (loginInput) loginInput.focus();
}

async function enter(data) {
  Object.assign(state, {
    user: data.user,
    settings: data.settings,
    categories: data.categories,
    suppliers: data.suppliers,
    roles: data.roles,
    expenseCategories: data.expenseCategories,
    allocationMethods: data.allocationMethods,
    sellerDiscountLimit: data.sellerDiscountLimit,
  });
  document.documentElement.dataset.theme = 'light';
  loginScreen.hidden = true;
  shell.hidden = false;
  renderNav();
  if (!location.hash) location.hash = '#/dashboard';
  await route();
}

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  loginError.hidden = true;
  const submit = loginForm.querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    await api('/api/auth/login', {
      method: 'POST',
      body: {
        login: loginForm.elements.login.value.trim(),
        password: loginForm.elements.password.value,
      },
    });
    loginForm.reset();
    const data = await api('/api/bootstrap');
    await enter(data);
    toast('Вход выполнен');
  } catch (err) {
    loginError.textContent = err.message;
    loginError.hidden = false;
  } finally {
    submit.disabled = false;
  }
});

document.getElementById('logout-btn').addEventListener('click', async () => {
  try {
    await api('/api/auth/logout', { method: 'POST', body: {} });
  } catch { /* сессия уже могла быть закрыта */ }
  state.user = null;
  showLogin();
});

document.getElementById('hamburger').addEventListener('click', () => {
  sidebar.classList.toggle('open');
});

window.addEventListener('hashchange', route);

document.addEventListener('auth:expired', () => {
  toast('Сессия истекла, войдите снова', 'error');
  showLogin();
});

start();

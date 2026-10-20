import {
  api, dt, el, emptyState, esc, modal, num, options, pageHeader, state, toast,
} from '../core.js';

export async function renderUsers(rest, ctx) {
  const root = el(`<div>
    ${pageHeader({
      title: 'Сотрудники',
      subtitle: 'Учётные записи, роли и доступ',
      actions: '<button class="btn btn-primary" data-new>Новый сотрудник</button>',
    })}
    <div data-body><div class="card"><div class="skeleton"></div><div class="skeleton"></div></div></div>
  </div>`);
  const body = root.querySelector('[data-body]');

  async function load() {
    body.innerHTML = '<div class="card"><div class="skeleton"></div></div>';
    try {
      const rows = await api('/api/users');
      body.innerHTML = `
        <div class="card">
          <div class="table-wrap desktop-table">
            <table class="table">
              <thead><tr><th>Логин</th><th>Сотрудник</th><th>Роль</th><th>Статус</th><th>Последний вход</th><th class="num">Сессий</th><th></th></tr></thead>
              <tbody>
                ${rows.map((u) => `
                  <tr>
                    <td class="mono">${esc(u.login)}</td>
                    <td>${esc(u.fullName)}</td>
                    <td>${esc(u.roleLabel)}</td>
                    <td>${u.isActive ? '<span class="badge ok">Активен</span>' : '<span class="badge danger">Отключён</span>'}</td>
                    <td class="small">${u.lastLoginAt ? dt(u.lastLoginAt) : '—'}</td>
                    <td class="num">${num(u.sessionsCount)}</td>
                    <td class="actions"><button class="btn btn-sm btn-ghost" data-edit="${u.id}">Изменить</button></td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>
          <div class="mobile-cards">
            ${rows.map((u) => `
              <div class="mcard" data-edit="${u.id}">
                <div class="mcard-top"><div class="mcard-title">${esc(u.fullName)}</div>${u.isActive ? '<span class="badge ok">Активен</span>' : '<span class="badge danger">Отключён</span>'}</div>
                <div class="mcard-meta"><span>${esc(u.login)}</span><span>${esc(u.roleLabel)}</span></div>
              </div>`).join('')}
          </div>
        </div>`;
      root.querySelector('[data-new]').addEventListener('click', () => openCreate(load));
      body.querySelectorAll('[data-edit]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const user = rows.find((u) => String(u.id) === btn.dataset.edit);
          if (user) openEdit(user, load);
        });
      });
    } catch (err) {
      body.innerHTML = `<div class="card"><div class="error-box">${esc(err.message)}</div></div>`;
    }
  }

  await load();
  return root;
}

function openCreate(reload) {
  const form = el(`<form>
    <div class="form-grid">
      <label class="field"><span class="field-label">Логин *</span>
        <input class="input" name="login" required placeholder="ivanov" autocomplete="off"></label>
      <label class="field"><span class="field-label">Имя сотрудника *</span>
        <input class="input" name="fullName" required></label>
      <label class="field"><span class="field-label">Роль</span>
        <select class="select" name="role">
          ${Object.entries(state.roles).map(([k, v]) => `<option value="${esc(k)}">${esc(v)}</option>`).join('')}
        </select></label>
      <label class="field"><span class="field-label">Пароль *</span>
        <input class="input" name="password" type="password" minlength="8" required autocomplete="new-password">
        <span class="field-hint">Не менее 8 символов</span></label>
    </div>
  </form>`);
  const footer = el('<div class="row"><button type="button" class="btn" data-close>Отмена</button><button type="button" class="btn btn-primary" data-save>Создать</button></div>');
  const m = modal({ title: 'Новый сотрудник', body: form, footer });
  footer.querySelector('[data-save]').addEventListener('click', async (e) => {
    const submitBtn = e.currentTarget;
    submitBtn.disabled = true;
    try {
      await api('/api/users', {
        method: 'POST',
        body: {
          login: form.elements.login.value.trim(),
          fullName: form.elements.fullName.value.trim(),
          role: form.elements.role.value,
          password: form.elements.password.value,
        },
      });
      m.close();
      toast('Сотрудник создан');
      reload();
    } catch (err) {
      toast(err.message, 'error');
    } finally { submitBtn.disabled = false; }
  });
}

function openEdit(user, reload) {
  const form = el(`<form>
    <div class="form-grid">
      <label class="field"><span class="field-label">Логин</span>
        <input class="input" value="${esc(user.login)}" readonly></label>
      <label class="field"><span class="field-label">Имя сотрудника</span>
        <input class="input" name="fullName" value="${esc(user.fullName)}"></label>
      <label class="field"><span class="field-label">Роль</span>
        <select class="select" name="role">
          ${Object.entries(state.roles).map(([k, v]) => `<option value="${esc(k)}"${k === user.role ? ' selected' : ''}>${esc(v)}</option>`).join('')}
        </select></label>
      <label class="field"><span class="field-label">Новый пароль</span>
        <input class="input" type="password" name="password" minlength="8" autocomplete="new-password" placeholder="оставьте пустым">
        <span class="field-hint">Смена пароля завершит активные сессии сотрудника</span></label>
      <label class="field full row tight"><input type="checkbox" name="isActive" ${user.isActive ? 'checked' : ''}> Учётная запись активна</label>
    </div>
  </form>`);
  const footer = el('<div class="row"><button type="button" class="btn" data-close>Отмена</button><button type="button" class="btn btn-primary" data-save>Сохранить</button></div>');
  const m = modal({ title: `Сотрудник ${user.login}`, body: form, footer });
  footer.querySelector('[data-save]').addEventListener('click', async (e) => {
    const submitBtn = e.currentTarget;
    submitBtn.disabled = true;
    try {
      const payload = {
        fullName: form.elements.fullName.value.trim(),
        role: form.elements.role.value,
        isActive: form.elements.isActive.checked,
      };
      const password = form.elements.password.value;
      if (password) payload.password = password;
      await api(`/api/users/${user.id}`, { method: 'PATCH', body: payload });
      m.close();
      toast('Данные сотрудника обновлены');
      reload();
    } catch (err) {
      toast(err.message, 'error');
    } finally { submitBtn.disabled = false; }
  });
}

import {
  api, can, confirmDialog, dt, el, emptyState, esc, kopToInput, modal, money, num,
  options, pageHeader, parseMoney, state, stockChip, toast,
} from '../core.js';

const listState = {
  search: '',
  categoryId: '',
  inStock: false,
  includeArchived: false,
  sort: 'name',
};

function priceRange(prices) {
  const values = (prices || []).filter((p) => Number.isFinite(Number(p)));
  if (!values.length) return '—';
  const min = Math.min(...values);
  const max = Math.max(...values);
  return min === max ? money(min) : `${money(min)} – ${money(max)}`;
}

function variantText(v) {
  return [v.size, v.color, v.styleName].filter(Boolean).map(esc).join(' · ') || '—';
}

function variantFields(variant = {}) {
  return `
    <div class="form-grid">
      <label class="field"><span class="field-label">Размер</span>
        <input class="input" name="size" value="${esc(variant.size || '')}" placeholder="98 / 104 / нет"></label>
      <label class="field"><span class="field-label">Цвет</span>
        <input class="input" name="color" value="${esc(variant.color || '')}" placeholder="чёрный"></label>
      <label class="field"><span class="field-label">Исполнение</span>
        <input class="input" name="styleName" value="${esc(variant.styleName || '')}" placeholder="необязательно"></label>
      <label class="field"><span class="field-label">Розничная цена, ₽</span>
        <input class="input num" name="retail_price" inputmode="decimal" value="${kopToInput(variant.retailPriceKop || 0)}"></label>
      <label class="field full"><span class="field-label">Доп. характеристика</span>
        <input class="input" name="extra" value="${esc(variant.extra || '')}" placeholder="необязательно"></label>
    </div>`;
}

function readVariant(form) {
  return {
    size: form.elements.size.value.trim(),
    color: form.elements.color.value.trim(),
    styleName: form.elements.styleName.value.trim(),
    extra: form.elements.extra.value.trim(),
    retail_price: form.elements.retail_price.value.trim() || '0',
  };
}

async function fileToDataUrl(file) {
  const bitmap = await createImageBitmap(file);
  const maxSide = 1200;
  const ratio = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * ratio);
  canvas.height = Math.round(bitmap.height * ratio);
  const ctx2d = canvas.getContext('2d');
  ctx2d.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.85);
}

export async function renderProducts(rest, ctx) {
  if (rest[0] === 'new') {
    const node = await renderList(ctx);
    openCreate(ctx);
    return node;
  }
  if (rest[0]) return renderProduct(rest[0], ctx);
  return renderList(ctx);
}

function productFilters() {
  return `
    <div class="card">
      <div class="inline-form">
        <input class="input" style="flex:1 1 220px" type="search" name="search" placeholder="Артикул или название" value="${esc(listState.search)}">
        <select class="select" name="categoryId" style="flex:0 0 200px">
          ${options(state.categories, listState.categoryId, { placeholder: 'Все категории' })}
        </select>
        <select class="select" name="sort" style="flex:0 0 190px">
          ${options([
            { id: 'name', name: 'По названию' },
            { id: 'stock', name: 'По остатку' },
            { id: 'price', name: 'По цене' },
            { id: 'updated', name: 'По изменению' },
          ], listState.sort)}
        </select>
        <label class="row tight small"><input type="checkbox" name="inStock" ${listState.inStock ? 'checked' : ''}> В наличии</label>
        ${can('catalog.manage') ? `<label class="row tight small"><input type="checkbox" name="includeArchived" ${listState.includeArchived ? 'checked' : ''}> С архивом</label>` : ''}
      </div>
    </div>`;
}

async function renderList(ctx) {
  const root = el(`<div>
    ${pageHeader({
      title: 'Товары',
      subtitle: 'Модели, варианты размеров и цветов, розничные цены',
      actions: can('catalog.manage') ? '<a class="btn btn-primary" href="#/products/new">Новый товар</a>' : '',
    })}
    ${productFilters()}
    <div class="section-gap" data-list></div>
  </div>`);

  const listBox = root.querySelector('[data-list]');
  const filtersBox = root.querySelector('.card');

  async function load() {
    listBox.innerHTML = '<div class="card"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div>';
    const params = new URLSearchParams();
    if (listState.search) params.set('search', listState.search);
    if (listState.categoryId) params.set('categoryId', listState.categoryId);
    if (listState.inStock) params.set('inStock', '1');
    if (listState.includeArchived) params.set('includeArchived', '1');
    params.set('sort', listState.sort);
    try {
      const products = await api(`/api/products?${params.toString()}`);
      if (!products.length) {
        listBox.innerHTML = `<div class="card">${emptyState('Товаров не найдено. Измените фильтры или создайте первый товар.')}</div>`;
        return;
      }
      const threshold = state.settings.lowStockThreshold || 3;
      listBox.innerHTML = `
        <div class="card">
          <div class="table-wrap desktop-table">
            <table class="table">
              <thead>
                <tr>
                  <th>Товар</th><th>Артикул</th><th>Категория</th>
                  <th class="num">Варианты</th><th class="num">Остаток</th><th class="num">Цена</th><th>Изменён</th>
                </tr>
              </thead>
              <tbody>
                ${products.map((p) => `
                  <tr class="clickable" data-open="${p.id}">
                    <td>
                      <div class="row">
                        ${p.photo ? `<img class="photo-thumb" src="${esc(p.photo)}" alt="">` : '<div class="photo-thumb photo-placeholder">▤</div>'}
                        <div class="stack">
                          <strong>${esc(p.name)}</strong>
                          <span class="small muted">${esc([p.brand, p.season].filter(Boolean).join(' · ') || 'без бренда')}</span>
                        </div>
                      </div>
                    </td>
                    <td class="mono">${esc(p.sku)}</td>
                    <td>${esc(p.categoryName || '—')}</td>
                    <td class="num">${num(p.variants.length)}</td>
                    <td class="num">${stockChip(p.totalQty, threshold)}</td>
                    <td class="num">${priceRange(p.prices)}</td>
                    <td class="small muted nowrap">${dt(p.updatedAt)}</td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>
          <div class="mobile-cards">
            ${products.map((p) => `
              <div class="mcard" data-open="${p.id}">
                <div class="mcard-top">
                  <div class="row">
                    ${p.photo ? `<img class="photo-thumb" src="${esc(p.photo)}" alt="">` : '<div class="photo-thumb photo-placeholder">▤</div>'}
                    <div class="stack">
                      <div class="mcard-title">${esc(p.name)}</div>
                      <span class="small muted">${esc(p.sku)}</span>
                    </div>
                  </div>
                  ${stockChip(p.totalQty, threshold)}
                </div>
                <div class="mcard-meta">
                  <span>${esc(p.categoryName || '—')}</span>
                  <span>${num(p.variants.length)} вар.</span>
                  <span>${priceRange(p.prices)}</span>
                </div>
              </div>`).join('')}
          </div>
        </div>`;
      listBox.querySelectorAll('[data-open]').forEach((node) => {
        node.addEventListener('click', () => ctx.navigate(`#/products/${node.dataset.open}`));
      });
    } catch (err) {
      listBox.innerHTML = `<div class="card"><div class="error-box">${esc(err.message)}</div></div>`;
    }
  }

  let timer = null;
  filtersBox.querySelector('[name="search"]').addEventListener('input', (e) => {
    listState.search = e.target.value.trim();
    clearTimeout(timer);
    timer = setTimeout(load, 220);
  });
  filtersBox.querySelector('[name="categoryId"]').addEventListener('change', (e) => {
    listState.categoryId = e.target.value;
    load();
  });
  filtersBox.querySelector('[name="sort"]').addEventListener('change', (e) => {
    listState.sort = e.target.value;
    load();
  });
  filtersBox.querySelector('[name="inStock"]').addEventListener('change', (e) => {
    listState.inStock = e.target.checked;
    load();
  });
  const archived = filtersBox.querySelector('[name="includeArchived"]');
  if (archived) archived.addEventListener('change', (e) => { listState.includeArchived = e.target.checked; load(); });

  await load();
  return root;
}

function openCreate(ctx) {
  const body = el(`<form>
    <div class="form-grid">
      <label class="field"><span class="field-label">Артикул *</span>
        <input class="input" name="sku" required placeholder="JK-025"></label>
      <label class="field"><span class="field-label">Наименование *</span>
        <input class="input" name="name" required placeholder="Куртка детская"></label>
      <label class="field"><span class="field-label">Категория</span>
        <select class="select" name="categoryId">${options(state.categories, '', { placeholder: 'Без категории' })}</select></label>
      <label class="field"><span class="field-label">Поставщик по умолчанию</span>
        <select class="select" name="defaultSupplierId">${options(state.suppliers, '', { placeholder: 'Не указан' })}</select></label>
      <label class="field"><span class="field-label">Единица измерения</span>
        <input class="input" name="unit" value="шт"></label>
      <label class="field"><span class="field-label">Сезон</span>
        <input class="input" name="season" placeholder="осень-зима"></label>
      <label class="field"><span class="field-label">Возрастная группа</span>
        <input class="input" name="ageGroup" placeholder="3–7 лет"></label>
      <label class="field"><span class="field-label">Бренд</span>
        <input class="input" name="brand"></label>
      <label class="field full"><span class="field-label">Описание</span>
        <textarea class="textarea" name="description"></textarea></label>
    </div>
    <h3 class="section-gap">Варианты</h3>
    <div class="stack section-gap" data-variants></div>
    <button type="button" class="btn btn-sm section-gap" data-add-variant>Добавить вариант</button>
  </form>`);

  const variantsBox = body.querySelector('[data-variants]');
  function addVariant(variant) {
    const row = el(`<div class="card" data-variant>${variantFields(variant)}</div>`);
    const remove = el('<button type="button" class="btn btn-sm btn-ghost">Удалить вариант</button>');
    remove.addEventListener('click', () => row.remove());
    row.appendChild(remove);
    variantsBox.appendChild(row);
  }
  addVariant({});
  body.querySelector('[data-add-variant]').addEventListener('click', () => addVariant({}));

  const footer = el(`<div class="row">
    <button type="button" class="btn" data-close>Отмена</button>
    <button type="button" class="btn btn-primary" data-save>Создать товар</button>
  </div>`);

  const m = modal({ title: 'Новый товар', body, footer, wide: true });

  footer.querySelector('[data-save]').addEventListener('click', async (e) => {
    e.preventDefault();
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const variants = [...body.querySelectorAll('[data-variant]')].map((row) => readVariant(row));
      const payload = {
        sku: body.elements.sku.value.trim(),
        name: body.elements.name.value.trim(),
        categoryId: body.elements.categoryId.value || null,
        defaultSupplierId: body.elements.defaultSupplierId.value || null,
        unit: body.elements.unit.value.trim() || 'шт',
        season: body.elements.season.value.trim() || null,
        ageGroup: body.elements.ageGroup.value.trim() || null,
        brand: body.elements.brand.value.trim() || null,
        description: body.elements.description.value.trim() || null,
        variants,
      };
      if (!payload.sku || !payload.name) throw new Error('Укажите артикул и наименование');
      const created = await api('/api/products', { method: 'POST', body: payload });
      m.close();
      toast('Товар создан');
      ctx.navigate(`#/products/${created.id}`);
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });
}

async function renderProduct(id, ctx) {
  const p = await api(`/api/products/${id}`);
  const threshold = state.settings.lowStockThreshold || 3;
  const root = el(`
    <div>
      <div class="card-head">
        <div>
          <a class="small muted" href="#/products">← Товары</a>
          <h1>${esc(p.name)}</h1>
          <p class="muted small">Артикул ${esc(p.sku)}${p.categoryName ? ` · ${esc(p.categoryName)}` : ''}</p>
        </div>
        <div class="spacer"></div>
        <div class="row">
          ${p.isActive ? '<span class="badge ok">Активен</span>' : '<span class="badge danger">В архиве</span>'}
          ${can('catalog.manage') ? '<button class="btn btn-sm" data-edit>Редактировать</button>' : ''}
          ${can('catalog.manage') ? `<button class="btn btn-sm" data-toggle-active>${p.isActive ? 'В архив' : 'Вернуть в продажу'}</button>` : ''}
        </div>
      </div>

      <div class="card">
        <div class="row">
          ${p.photo ? `<img class="photo-lg" src="${esc(p.photo)}" alt="">` : '<div class="photo-lg photo-placeholder">▤</div>'}
          <div class="stack grow">
            <div class="detail-grid">
              <div class="detail-item"><div class="k">Категория</div><div class="v">${esc(p.categoryName || '—')}</div></div>
              <div class="detail-item"><div class="k">Бренд</div><div class="v">${esc(p.brand || '—')}</div></div>
              <div class="detail-item"><div class="k">Сезон</div><div class="v">${esc(p.season || '—')}</div></div>
              <div class="detail-item"><div class="k">Возраст</div><div class="v">${esc(p.ageGroup || '—')}</div></div>
              <div class="detail-item"><div class="k">Поставщик</div><div class="v">${esc(p.supplierName || '—')}</div></div>
              <div class="detail-item"><div class="k">Единица</div><div class="v">${esc(p.unit || 'шт')}</div></div>
            </div>
            ${p.description ? `<p class="small muted section-gap">${esc(p.description)}</p>` : ''}
          </div>
          ${can('catalog.manage') ? `
            <div class="stack">
              <label class="btn btn-sm">Загрузить фото<input type="file" accept="image/*" hidden data-photo></label>
              <span class="small muted">JPEG/PNG до 4 МБ</span>
            </div>` : ''}
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <h2>Варианты</h2>
          <div class="spacer"></div>
          ${can('catalog.manage') ? '<button class="btn btn-sm" data-add-variant>Добавить вариант</button>' : ''}
        </div>
        ${p.variants.length ? `
          <div class="table-wrap">
            <table class="table">
              <thead><tr>
                <th>Размер</th><th>Цвет</th><th>Исполнение</th>
                <th class="num">Остаток</th>
                ${can('cost.view') ? '<th class="num">Себестоимость</th>' : ''}
                <th class="num">Розничная цена</th>
                ${can('catalog.manage') ? '<th class="actions"></th>' : ''}
              </tr></thead>
              <tbody>
                ${p.variants.map((v) => `
                  <tr>
                    <td>${esc(v.size || '—')}</td>
                    <td>${esc(v.color || '—')}</td>
                    <td>${esc(v.styleName || '—')}</td>
                    <td class="num">${stockChip(v.qty, threshold)}</td>
                    ${can('cost.view') ? `<td class="num">${money(Math.round((v.avgCostX10000 || 0) / 100))}</td>` : ''}
                    <td class="num">
                      ${can('price.manage')
    ? `<input class="input sm num" style="max-width:110px;margin-left:auto" data-price="${v.id}" value="${kopToInput(v.retailPriceKop)}">`
    : money(v.retailPriceKop)}
                    </td>
                    ${can('catalog.manage') ? `<td class="actions"><button class="btn btn-sm btn-ghost" data-variant="${v.id}">Изменить</button></td>` : ''}
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>` : emptyState('У товара пока нет вариантов')}
      </div>

      ${p.priceHistory.length ? `
        <div class="card">
          <h2>История розничных цен</h2>
          <div class="table-wrap section-gap">
            <table class="table">
              <thead><tr><th>Дата</th><th>Вариант</th><th class="num">Было</th><th class="num">Стало</th><th>Сотрудник</th></tr></thead>
              <tbody>
                ${p.priceHistory.map((h) => `
                  <tr>
                    <td class="nowrap">${dt(h.changedAt)}</td>
                    <td>${esc((p.variants.find((v) => v.id === h.variantId) || {}).size || '—')}</td>
                    <td class="num">${money(h.oldPriceKop)}</td>
                    <td class="num">${money(h.newPriceKop)}</td>
                    <td>${esc(h.changedByName || '—')}</td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>
        </div>` : ''}

      <div class="card">
        <h2>Движения по товару</h2>
        ${p.movements.length ? `
          <div class="table-wrap section-gap">
            <table class="table">
              <thead><tr><th>Дата</th><th>Операция</th><th>Вариант</th><th class="num">Количество</th><th>Комментарий</th><th>Сотрудник</th></tr></thead>
              <tbody>
                ${p.movements.map((mv) => `
                  <tr>
                    <td class="nowrap">${dt(mv.createdAt)}</td>
                    <td>${esc(mv.type)}</td>
                    <td>${esc([mv.size, mv.color].filter(Boolean).join(' · ') || '—')}</td>
                    <td class="num">${mv.qty > 0 ? '+' : ''}${num(mv.qty)}</td>
                    <td class="small">${esc(mv.comment || '—')}</td>
                    <td class="small">${esc(mv.authorName || '—')}</td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>` : emptyState('Движений пока нет')}
      </div>
    </div>`);

  const editBtn = root.querySelector('[data-edit]');
  if (editBtn) {
    editBtn.addEventListener('click', () => openEditProduct(p, ctx));
  }
  const toggle = root.querySelector('[data-toggle-active]');
  if (toggle) {
    toggle.addEventListener('click', async () => {
      const ok = await confirmDialog(p.isActive
        ? 'Товар будет скрыт из продаж и каталога. История операций сохранится.'
        : 'Товар снова станет доступен для продаж и закупок.', { confirmText: p.isActive ? 'В архив' : 'Вернуть' });
      if (!ok) return;
      try {
        await api(`/api/products/${p.id}`, { method: 'PATCH', body: { isActive: !p.isActive } });
        toast(p.isActive ? 'Товар в архиве' : 'Товар активен');
        ctx.refresh();
      } catch (err) { toast(err.message, 'error'); }
    });
  }

  const photoInput = root.querySelector('[data-photo]');
  if (photoInput) {
    photoInput.addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      try {
        const dataUrl = await fileToDataUrl(file);
        await api(`/api/products/${p.id}/photo`, { method: 'POST', body: { dataUrl } });
        toast('Фотография обновлена');
        ctx.refresh();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  }

  const addVariantBtn = root.querySelector('[data-add-variant]');
  if (addVariantBtn) {
    addVariantBtn.addEventListener('click', () => {
      const form = el(`<form>${variantFields({})}</form>`);
      const footer = el('<div class="row"><button type="button" class="btn" data-close>Отмена</button><button type="button" class="btn btn-primary" data-save>Добавить</button></div>');
      const m = modal({ title: 'Новый вариант', body: form, footer });
      footer.querySelector('[data-save]').addEventListener('click', async (ev) => {
        const submitBtn = ev.currentTarget;
        submitBtn.disabled = true;
        try {
          await api(`/api/products/${p.id}/variants`, { method: 'POST', body: readVariant(form) });
          m.close();
          toast('Вариант добавлен');
          ctx.refresh();
        } catch (err) {
          toast(err.message, 'error');
        } finally { submitBtn.disabled = false; }
      });
    });
  }

  root.querySelectorAll('[data-variant]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const variant = p.variants.find((v) => String(v.id) === String(btn.dataset.variant));
      if (!variant) return;
      const form = el(`<form>${variantFields(variant)}
        <label class="field section-gap"><span class="row tight"><input type="checkbox" name="isActive" ${variant.isActive ? 'checked' : ''}> Вариант активен</span></label>
      </form>`);
      const footer = el('<div class="row"><button type="button" class="btn" data-close>Отмена</button><button type="button" class="btn btn-primary" data-save>Сохранить</button></div>');
      const m = modal({ title: 'Вариант товара', body: form, footer });
      footer.querySelector('[data-save]').addEventListener('click', async (ev) => {
        const submitBtn = ev.currentTarget;
        submitBtn.disabled = true;
        try {
          const payload = readVariant(form);
          payload.isActive = form.elements.isActive.checked;
          await api(`/api/variants/${variant.id}`, { method: 'PATCH', body: payload });
          m.close();
          toast('Вариант обновлён');
          ctx.refresh();
        } catch (err) {
          toast(err.message, 'error');
        } finally { submitBtn.disabled = false; }
      });
    });
  });

  root.querySelectorAll('[data-price]').forEach((input) => {
    input.addEventListener('change', async () => {
      const variantId = input.dataset.price;
      const kop = parseMoney(input.value);
      if (kop === null || kop < 0) { toast('Некорректная цена', 'error'); return; }
      try {
        await api(`/api/variants/${variantId}`, { method: 'PATCH', body: { retail_price: input.value } });
        toast('Цена обновлена');
      } catch (err) {
        toast(err.message, 'error');
        ctx.refresh();
        return;
      }
      ctx.refresh();
    });
  });

  return root;
}

function openEditProduct(p, ctx) {
  const form = el(`<form>
    <div class="form-grid">
      <label class="field"><span class="field-label">Артикул *</span>
        <input class="input" name="sku" required value="${esc(p.sku)}"></label>
      <label class="field"><span class="field-label">Наименование *</span>
        <input class="input" name="name" required value="${esc(p.name)}"></label>
      <label class="field"><span class="field-label">Категория</span>
        <select class="select" name="categoryId">${options(state.categories, p.categoryId, { placeholder: 'Без категории' })}</select></label>
      <label class="field"><span class="field-label">Поставщик по умолчанию</span>
        <select class="select" name="defaultSupplierId">${options(state.suppliers, p.defaultSupplierId, { placeholder: 'Не указан' })}</select></label>
      <label class="field"><span class="field-label">Единица измерения</span>
        <input class="input" name="unit" value="${esc(p.unit || 'шт')}"></label>
      <label class="field"><span class="field-label">Сезон</span>
        <input class="input" name="season" value="${esc(p.season || '')}"></label>
      <label class="field"><span class="field-label">Возрастная группа</span>
        <input class="input" name="ageGroup" value="${esc(p.ageGroup || '')}"></label>
      <label class="field"><span class="field-label">Бренд</span>
        <input class="input" name="brand" value="${esc(p.brand || '')}"></label>
      <label class="field full"><span class="field-label">Описание</span>
        <textarea class="textarea" name="description">${esc(p.description || '')}</textarea></label>
      <label class="field full"><span class="field-label">Примечания</span>
        <textarea class="textarea" name="notes">${esc(p.notes || '')}</textarea></label>
    </div>
  </form>`);
  const footer = el('<div class="row"><button type="button" class="btn" data-close>Отмена</button><button type="button" class="btn btn-primary" data-save>Сохранить</button></div>');
  const m = modal({ title: 'Редактирование товара', body: form, footer, wide: true });
  footer.querySelector('[data-save]').addEventListener('click', async (ev) => {
    const submitBtn = ev.currentTarget;
    submitBtn.disabled = true;
    try {
      await api(`/api/products/${p.id}`, {
        method: 'PATCH',
        body: {
          sku: form.elements.sku.value.trim(),
          name: form.elements.name.value.trim(),
          categoryId: form.elements.categoryId.value || null,
          defaultSupplierId: form.elements.defaultSupplierId.value || null,
          unit: form.elements.unit.value.trim() || 'шт',
          season: form.elements.season.value.trim() || null,
          ageGroup: form.elements.ageGroup.value.trim() || null,
          brand: form.elements.brand.value.trim() || null,
          description: form.elements.description.value.trim() || null,
          notes: form.elements.notes.value.trim() || null,
        },
      });
      m.close();
      toast('Товар сохранён');
      ctx.refresh();
    } catch (err) {
      toast(err.message, 'error');
    } finally { submitBtn.disabled = false; }
  });
}

# API

Базовый адрес: `http://127.0.0.1:3000`. Все ответы — JSON, кроме эндпоинтов экспорта и файлов изображений.

## Аутентификация

Сессия хранится в HttpOnly cookie `srk_session` (`SameSite=Strict`, срок 12 часов). Логин и пароль передаются только на `POST /api/auth/login`.

| Метод | Путь | Назначение |
| --- | --- | --- |
| POST | `/api/auth/login` | Вход: `{ login, password }` |
| POST | `/api/auth/logout` | Выход, удаление сессии |
| GET | `/api/auth/me` | Текущий пользователь и его права |
| GET | `/api/health` | Проверка доступности сервера (без авторизации) |

Формат ошибки: `{ "error": "текст", "details": null }`. Коды: `400` — некорректные данные, `401` — нет сессии, `403` — нет прав, `404` — не найдено, `409` — конфликт состояния, `429` — слишком много попыток входа.

Все изменяющие запросы требуют `Content-Type: application/json` и совпадения `Origin` с хостом запроса.

## Справочники и каталог

| Метод | Путь | Право |
| --- | --- | --- |
| GET | `/api/bootstrap` | любой вход |
| GET/POST | `/api/categories` | `catalog.view` / `catalog.manage` |
| PATCH | `/api/categories/:id` | `catalog.manage` |
| GET | `/api/suppliers` | `suppliers.view` |
| POST/PATCH | `/api/suppliers`, `/api/suppliers/:id` | `suppliers.manage` |
| GET | `/api/products` | `catalog.view` |
| POST | `/api/products` | `catalog.manage` |
| GET/PATCH | `/api/products/:id` | `catalog.view` / `catalog.manage` |
| POST | `/api/products/:id/variants` | `catalog.manage` |
| POST | `/api/products/:id/photo` | `catalog.manage` |
| PATCH | `/api/variants/:id` | `catalog.manage`, смена цены — `price.manage` |
| GET | `/api/media/:file` | любой вход |

Параметры `GET /api/products`: `search`, `categoryId`, `supplierId`, `season`, `size`, `color`, `inStock=1`, `includeArchived=1`, `sort=name|stock|price|updated`.

`POST /api/products` принимает модель и массив вариантов:

```json
{
  "sku": "JK-025",
  "name": "Куртка детская",
  "categoryId": 1,
  "unit": "шт",
  "variants": [{ "size": "98", "color": "черный", "retail_price": "1500" }]
}
```

Фотография передаётся как `data:image/jpeg;base64,...` (до 4 МБ), файл сохраняется в `storage/uploads`.

## Закупки

| Метод | Путь | Право |
| --- | --- | --- |
| GET | `/api/purchases` | `purchase.view` |
| POST | `/api/purchases` | `purchase.create` |
| GET | `/api/purchases/:id` | `purchase.view` |
| PATCH | `/api/purchases/:id` | `purchase.edit` (только черновик) |
| POST | `/api/purchases/:id/status` | `purchase.status`, утверждение — `purchase.approve` |
| POST | `/api/purchases/:id/payments` | `purchase.payments` |
| POST | `/api/purchases/:id/expenses` | `expenses.manage` |
| POST | `/api/purchases/:id/receipts` | `receipt.create` |

Создание закупки:

```json
{
  "supplierId": 2,
  "rate": "12",
  "rateDate": "2026-10-17",
  "comment": "Осенняя партия",
  "items": [{ "variantId": 12, "qty": 50, "priceCny": "25" }]
}
```

Курс обязателен и сохраняется в документе. Статусы: `draft`, `pending_approval`, `approved`, `ordered`, `partially_paid`, `paid`, `partially_received`, `received`, `cancelled`. Переходы проверяются сервером; отмена закупки с проведёнными приёмками запрещена.

Оплата: `{ amount, currency: "CNY"|"RUB", rate?, paidAt?, comment? }`. Оплата не меняет себестоимость.

Расход: `{ category: "delivery"|"agent"|"packaging"|"customs"|"other", amount, currency: "RUB"|"CNY", rate?, method: "value"|"qty"|"manual", receiptId?, allocations?, comment?, isCapitalized? }`. Для `manual` передаётся `allocations: [{ receiptItemId, amount }]`, сумма должна совпадать с суммой расхода.

## Приёмка

| Метод | Путь | Право |
| --- | --- | --- |
| GET | `/api/receipts` | `receipt.view` |
| GET | `/api/receipts/:id` | `receipt.view` |
| PATCH | `/api/receipts/:id` | `receipt.create` (только черновик) |
| POST | `/api/receipts/:id/post` | `receipt.post` |
| DELETE | `/api/receipts/:id` | `receipt.create` (только черновик) |

Создание: `POST /api/purchases/:id/receipts` с `{ clientRef?, receiptDate?, comment?, items? }`. Повторный вызов с тем же `clientRef` возвращает существующий документ.

Правка количеств: `{ items: [{ id, qtyReceived, qtyDamaged, comment? }] }`. Проведение создаёт движения прихода, фиксирует себестоимость и распределяет ожидающие расходы. Повторное проведение отклоняется.

## Склад

| Метод | Путь | Право |
| --- | --- | --- |
| GET | `/api/stock` | `stock.view` |
| GET | `/api/stock/movements` | `stock.view` |
| POST | `/api/stock/adjustments` | `stock.adjust` |
| POST | `/api/stock/writeoffs` | `stock.adjust` |
| GET/POST | `/api/inventory` | `stock.inventory` |
| GET | `/api/inventory/:id` | `stock.inventory` |
| POST | `/api/inventory/:id/post` | `stock.inventory` |

Корректировка: `{ variantId, qty?, qtyDelta?, reason }`. `qty` — фактическое количество, `qtyDelta` — изменение. Списание: `{ variantId, qty, reason }`.

Инвентаризация: `{ comment?, countedAt?, items: [{ variantId, qtyActual, comment? }] }`.

## Продажи и возвраты

| Метод | Путь | Право |
| --- | --- | --- |
| GET | `/api/sales` | `sale.create` (продавец видит только свои) |
| POST | `/api/sales` | `sale.create` |
| GET | `/api/sales/:id` | `sale.create`, продавец — только свои |
| GET | `/api/returns` | `return.create` |
| POST | `/api/returns` | `return.create` |
| GET | `/api/returns/:id` | `return.create` |

Продажа:

```json
{
  "clientRef": "uuid",
  "items": [{ "variantId": 12, "qty": 2, "priceKop": 150000 }],
  "discountKop": 0,
  "subtotalKop": 300000,
  "comment": ""
}
```

`clientRef` защищает от дублей. `subtotalKop` — контрольная сумма корзины: если она разошлась с расчётом сервера, продажа отклоняется. Цена ниже допустимой скидки (`max_seller_discount_percent`) или выше розничной для роли без `price.manage` отклоняется. При недостатке остатка — `409`.

Возврат:

```json
{
  "clientRef": "uuid",
  "saleId": 5,
  "reason": "Не подошёл размер",
  "items": [{ "saleItemId": 9, "qty": 1, "condition": "sellable" }]
}
```

`condition`: `sellable` увеличивает доступный остаток, `damaged` — нет. Повторный возврат сверх проданного количества отклоняется.

## Отчёты и экспорт

| Метод | Путь | Право |
| --- | --- | --- |
| GET | `/api/dashboard` | любой вход |
| GET | `/api/reports/stock` | `stock.view` |
| GET | `/api/reports/sales` | `sale.create` |
| GET | `/api/reports/purchases` | `reports.purchases` |
| GET | `/api/reports/purchase/:id` | `reports.purchases` |
| GET | `/api/export/catalog.csv` | `export.catalog` |
| GET | `/api/export/stock.csv` | `export.stock` |
| GET | `/api/export/sales.csv` | `sale.create` |
| GET | `/api/export/purchases.csv` | `export.purchases` |

Отчёты принимают `from` и `to` (ISO 8601). Для включения документов за целый день передавайте конец периода как `T23:59:59`.

## Администрирование

| Метод | Путь | Право |
| --- | --- | --- |
| GET/POST | `/api/users` | `users.manage` |
| PATCH | `/api/users/:id` | `users.manage` |
| POST | `/api/users/me/password` | любой вход |
| GET | `/api/audit` | `audit.view` |
| GET/PATCH | `/api/settings` | `settings.manage` |
| GET | `/api/system` | `settings.manage` |

Деактивация пользователя не удаляет его документы: учётная запись отключается, активные сессии закрываются. В системе обязан остаться хотя бы один активный владелец.

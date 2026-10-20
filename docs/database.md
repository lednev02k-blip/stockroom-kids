# Схема базы данных

СУБД: SQLite (`node:sqlite`), файл `data/stockroom.db`, режим WAL. Миграции — `src/migrations/*.sql`, применяются по имени файла и фиксируются в `schema_migrations`. Повторный запуск сервера применяет только новые миграции.

## Денежные и количественные единицы

| Значение | Хранение | Пример |
| --- | --- | --- |
| Рубли | целые копейки (`*_kop`) | 1 500,00 ₽ → `150000` |
| Юани | целые фэни (`*_fen`) | ¥25,00 → `2500` |
| Курс CNY/RUB | целое ×10000 (`rate_*_x10000`) | 12,0000 → `120000` |
| Себестоимость единицы | целое ×10000 (`unit_cost_x10000`) | 406,382979 ₽ → `4063829` |
| Количество | целое | штуки |

Дробные количества в MVP не используются: одежда, обувь и сопутствующие товары учитываются целыми единицами. Все суммы считаются в целых числах, поэтому ошибок двоичной плавающей точки нет.

## Таблицы

### Доступ и администрирование

| Таблица | Назначение и ключевые поля |
| --- | --- |
| `users` | сотрудник: `login` (уникальный), `full_name`, `role`, `password_hash`, `password_salt`, `is_active` |
| `sessions` | серверные сессии: хеш токена, `user_id`, `expires_at`, `ip` |
| `login_attempts` | попытки входа для ограничения перебора: `login`, `ip`, `success`, `at` |
| `audit_log` | журнал действий: `at`, `user_id`, `login`, `action`, `entity`, `entity_id`, `details` (JSON) |
| `settings` | параметры: `company_name`, `currency`, `low_stock_threshold`, `max_seller_discount_percent`, `purchase_note` |
| `counters` | нумерация документов: `PO-00001`, `RCP-00001`, `SL-202610-0001`, `RET-00001`, `INV-…` |

### Каталог

| Таблица | Назначение и ключевые поля |
| --- | --- |
| `categories` | категории: `name` (уникальное без учёта регистра), `sort`, `is_active` |
| `suppliers` | поставщики: `name`, `code`, `country`, `contact`, `notes`, `is_active` |
| `products` | модель: `sku` (уникальный), `name`, `category_id`, `unit`, `season`, `age_group`, `brand`, `default_supplier_id`, `description`, `photo_path`, `is_active` |
| `product_variants` | вариант: `product_id`, `size`, `color`, `style_name`, `extra`, `retail_price_kop`, `is_active`; уникальность набора характеристик внутри модели |
| `price_history` | история розничных цен: `variant_id`, `old_price_kop`, `new_price_kop`, `changed_by`, `changed_at` |

### Закупки и приёмка

| Таблица | Назначение и ключевые поля |
| --- | --- |
| `purchase_orders` | закупка: `number`, `supplier_id`, `currency`, `rate_cny_rub_x10000`, `rate_date`, `rate_source`, `status`, `author_id`, `approved_by`, `approved_at`, `cancelled_at`, `cancel_reason` |
| `purchase_order_items` | позиция: `purchase_id`, `variant_id`, `qty`, `price_cny_fen`, `line_no` |
| `payments` | оплата: `purchase_id`, `currency`, `amount_minor`, `rate_x10000`, `amount_kop`, `paid_at` |
| `receipts` | приёмка: `number`, `purchase_id`, `receipt_date`, `status` (`draft`/`posted`), `posted_by`, `posted_at`, `client_ref` |
| `receipt_items` | принятое количество: `receipt_id`, `po_item_id`, `qty_received`, `qty_damaged`, `unit_cost_x10000`, `cost_total_kop` |
| `expenses` | дополнительный расход: `purchase_id`, `receipt_id`, `category`, `amount_minor`, `currency`, `rate_x10000`, `amount_kop`, `method`, `is_capitalized`, `applied_at` |
| `expense_allocations` | распределение расхода: `expense_id`, `receipt_item_id`, `variant_id`, `amount_kop` |

### Склад и себестоимость

| Таблица | Назначение и ключевые поля |
| --- | --- |
| `stock_movements` | движение: `variant_id`, `type` (`receipt`, `sale`, `sale_return`, `supplier_return`, `writeoff`, `inventory`, `adjustment`), `qty` (±), `unit_cost_x10000`, `value_kop`, `doc_type`, `doc_id`, `comment`, `author_id`, `created_at` |
| `variant_stock` | текущее состояние варианта: `qty`, `avg_cost_x10000`; пересчитывается только проведёнными движениями |
| `cost_adjustments` | история корректировок себестоимости: `variant_id`, `delta_value_kop`, `reason`, `doc_type`, `doc_id`, `expense_id` |
| `inventory_counts` | инвентаризация: `number`, `counted_at`, `status`, `author_id`, `posted_at` |
| `inventory_items` | строка пересчёта: `count_id`, `variant_id`, `qty_expected`, `qty_actual`, `comment` |

### Продажи и возвраты

| Таблица | Назначение и ключевые поля |
| --- | --- |
| `sales` | продажа: `number`, `sold_at`, `seller_id`, `subtotal_kop`, `discount_kop`, `total_kop`, `cost_total_kop`, `status`, `client_ref` |
| `sale_items` | позиция: `sale_id`, `variant_id`, `qty`, `price_kop`, `cost_unit_x10000`, `cost_total_kop` |
| `returns` | возврат: `number`, `sale_id`, `reason`, `total_kop`, `status`, `author_id`, `client_ref` |
| `return_items` | позиция возврата: `return_id`, `sale_item_id`, `variant_id`, `qty`, `price_kop`, `condition` (`sellable`/`damaged`), `cost_unit_x10000` |

## Инварианты

1. `variant_stock` не редактируется вручную: изменение возможно только через `postMovement` в транзакции документа.
2. Остаток не может стать отрицательным: проверка выполняется под `BEGIN IMMEDIATE` перед записью движения.
3. Проведённая приёмка (`receipts.status = 'posted'`) не редактируется и не удаляется; повторное проведение отклоняется.
4. Сумма `expense_allocations` по расходу равна `expenses.amount_kop` (распределение методом наибольших остатков).
5. `receipt_items.unit_cost_x10000` и `cost_total_kop` фиксируются в момент проведения приёмки и далее не переписываются.
6. Записи `sales`, `receipts`, `returns` уникальны по `client_ref` — повторная отправка возвращает существующий документ.
7. Удаление пользователя не выполняется; используется `users.is_active = 0`, документы сохраняются.
8. Внешние ключи включены (`PRAGMA foreign_keys = ON`).

## Прослеживаемость

- Продажа → `sale_items` → вариант → `stock_movements` с `doc_type = 'sale'` и `doc_id` продажи.
- Движение прихода → `receipts` → `purchase_orders` → `expense_allocations` → `expenses`.
- Изменение себестоимости → `cost_adjustments` с указанием расхода и документа.
- Любое административное и финансовое действие → `audit_log`.

## Резервное копирование схемы

Файл базы самодостаточен; копия снимается командой `VACUUM INTO` (см. `docs/backup.md`). Для перехода на PostgreSQL структура переносится один в один: целочисленные денежные поля, те же внешние ключи и уникальные индексы.

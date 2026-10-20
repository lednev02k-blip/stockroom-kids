PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  login          TEXT NOT NULL UNIQUE,
  full_name      TEXT NOT NULL,
  role           TEXT NOT NULL CHECK (role IN ('owner','buyer','seller')),
  password_hash  TEXT NOT NULL,
  password_salt  TEXT NOT NULL,
  is_active      INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL,
  last_login_at  TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  ip            TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS login_attempts (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  login    TEXT NOT NULL,
  ip       TEXT,
  at       TEXT NOT NULL,
  success  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_attempts ON login_attempts(login, at);

CREATE TABLE IF NOT EXISTS suppliers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  code        TEXT,
  country     TEXT,
  contact     TEXT,
  notes       TEXT,
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS categories (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  sort       INTEGER NOT NULL DEFAULT 100,
  is_active  INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS products (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  sku                 TEXT NOT NULL UNIQUE,
  name                TEXT NOT NULL,
  category_id         INTEGER REFERENCES categories(id),
  unit                TEXT NOT NULL DEFAULT 'шт',
  season              TEXT,
  age_group           TEXT,
  brand               TEXT,
  default_supplier_id INTEGER REFERENCES suppliers(id),
  description         TEXT,
  notes               TEXT,
  photo_path          TEXT,
  is_active           INTEGER NOT NULL DEFAULT 1,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS product_variants (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id         INTEGER NOT NULL REFERENCES products(id),
  size               TEXT NOT NULL DEFAULT '',
  color              TEXT NOT NULL DEFAULT '',
  style_name         TEXT NOT NULL DEFAULT '',
  extra              TEXT NOT NULL DEFAULT '',
  retail_price_kop   INTEGER NOT NULL DEFAULT 0,
  is_active          INTEGER NOT NULL DEFAULT 1,
  created_at         TEXT NOT NULL,
  UNIQUE (product_id, size, color, style_name, extra)
);
CREATE INDEX IF NOT EXISTS idx_variants_product ON product_variants(product_id);

CREATE TABLE IF NOT EXISTS price_history (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  variant_id      INTEGER NOT NULL REFERENCES product_variants(id),
  old_price_kop   INTEGER NOT NULL,
  new_price_kop   INTEGER NOT NULL,
  changed_by      INTEGER REFERENCES users(id),
  changed_at      TEXT NOT NULL,
  comment         TEXT
);
CREATE INDEX IF NOT EXISTS idx_price_history ON price_history(variant_id, changed_at);

CREATE TABLE IF NOT EXISTS purchase_orders (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  number            TEXT NOT NULL UNIQUE,
  supplier_id       INTEGER NOT NULL REFERENCES suppliers(id),
  currency          TEXT NOT NULL DEFAULT 'CNY',
  rate_cny_rub_x10000 INTEGER NOT NULL,
  rate_date         TEXT NOT NULL,
  rate_source       TEXT,
  status            TEXT NOT NULL DEFAULT 'draft',
  author_id         INTEGER NOT NULL REFERENCES users(id),
  comment           TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  approved_by       INTEGER REFERENCES users(id),
  approved_at       TEXT,
  cancelled_at      TEXT,
  cancel_reason     TEXT
);
CREATE INDEX IF NOT EXISTS idx_po_status ON purchase_orders(status);

CREATE TABLE IF NOT EXISTS purchase_order_items (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_id     INTEGER NOT NULL REFERENCES purchase_orders(id),
  variant_id      INTEGER NOT NULL REFERENCES product_variants(id),
  qty             INTEGER NOT NULL CHECK (qty > 0),
  price_cny_fen   INTEGER NOT NULL CHECK (price_cny_fen >= 0),
  line_no         INTEGER NOT NULL DEFAULT 1,
  UNIQUE (purchase_id, variant_id)
);

CREATE TABLE IF NOT EXISTS payments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_id   INTEGER NOT NULL REFERENCES purchase_orders(id),
  currency      TEXT NOT NULL DEFAULT 'CNY',
  amount_minor  INTEGER NOT NULL,
  rate_x10000   INTEGER NOT NULL,
  amount_kop    INTEGER NOT NULL,
  paid_at       TEXT NOT NULL,
  comment       TEXT,
  author_id     INTEGER NOT NULL REFERENCES users(id),
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payments_po ON payments(purchase_id);

CREATE TABLE IF NOT EXISTS receipts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  number        TEXT NOT NULL UNIQUE,
  purchase_id   INTEGER NOT NULL REFERENCES purchase_orders(id),
  receipt_date  TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','posted')),
  author_id     INTEGER NOT NULL REFERENCES users(id),
  posted_by     INTEGER REFERENCES users(id),
  posted_at     TEXT,
  comment       TEXT,
  created_at    TEXT NOT NULL,
  client_ref    TEXT UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_receipts_po ON receipts(purchase_id);

CREATE TABLE IF NOT EXISTS receipt_items (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_id        INTEGER NOT NULL REFERENCES receipts(id),
  po_item_id        INTEGER NOT NULL REFERENCES purchase_order_items(id),
  qty_received      INTEGER NOT NULL DEFAULT 0 CHECK (qty_received >= 0),
  qty_damaged       INTEGER NOT NULL DEFAULT 0 CHECK (qty_damaged >= 0),
  unit_cost_x10000  INTEGER NOT NULL DEFAULT 0,
  cost_total_kop    INTEGER NOT NULL DEFAULT 0,
  comment           TEXT
);
CREATE INDEX IF NOT EXISTS idx_receipt_items_receipt ON receipt_items(receipt_id);

CREATE TABLE IF NOT EXISTS expenses (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_id     INTEGER NOT NULL REFERENCES purchase_orders(id),
  receipt_id      INTEGER REFERENCES receipts(id),
  category        TEXT NOT NULL,
  amount_minor    INTEGER NOT NULL,
  currency        TEXT NOT NULL DEFAULT 'RUB',
  rate_x10000     INTEGER NOT NULL DEFAULT 10000,
  amount_kop      INTEGER NOT NULL,
  method          TEXT NOT NULL DEFAULT 'value' CHECK (method IN ('value','qty','manual')),
  comment         TEXT,
  is_capitalized  INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL,
  author_id       INTEGER NOT NULL REFERENCES users(id),
  applied_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_expenses_po ON expenses(purchase_id);

CREATE TABLE IF NOT EXISTS expense_allocations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  expense_id      INTEGER NOT NULL REFERENCES expenses(id),
  receipt_item_id INTEGER REFERENCES receipt_items(id),
  variant_id      INTEGER NOT NULL REFERENCES product_variants(id),
  amount_kop      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_exp_alloc ON expense_allocations(expense_id);

CREATE TABLE IF NOT EXISTS stock_movements (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  variant_id       INTEGER NOT NULL REFERENCES product_variants(id),
  type             TEXT NOT NULL CHECK (type IN (
                     'receipt','sale','sale_return','supplier_return',
                     'writeoff','inventory','adjustment')),
  qty              INTEGER NOT NULL,
  unit_cost_x10000 INTEGER NOT NULL DEFAULT 0,
  value_kop        INTEGER NOT NULL DEFAULT 0,
  doc_type         TEXT NOT NULL,
  doc_id           INTEGER,
  comment          TEXT,
  created_at       TEXT NOT NULL,
  author_id        INTEGER REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_movements_variant ON stock_movements(variant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_movements_doc ON stock_movements(doc_type, doc_id);

CREATE TABLE IF NOT EXISTS variant_stock (
  variant_id       INTEGER PRIMARY KEY REFERENCES product_variants(id),
  qty              INTEGER NOT NULL DEFAULT 0 CHECK (qty >= 0),
  avg_cost_x10000  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS cost_adjustments (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  variant_id      INTEGER NOT NULL REFERENCES product_variants(id),
  delta_value_kop INTEGER NOT NULL,
  reason          TEXT NOT NULL,
  doc_type        TEXT NOT NULL,
  doc_id          INTEGER,
  expense_id      INTEGER REFERENCES expenses(id),
  created_at      TEXT NOT NULL,
  author_id       INTEGER REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS sales (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  number         TEXT NOT NULL UNIQUE,
  sold_at        TEXT NOT NULL,
  seller_id      INTEGER NOT NULL REFERENCES users(id),
  subtotal_kop   INTEGER NOT NULL,
  discount_kop   INTEGER NOT NULL DEFAULT 0,
  total_kop      INTEGER NOT NULL,
  cost_total_kop INTEGER NOT NULL DEFAULT 0,
  comment        TEXT,
  status         TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted')),
  created_at     TEXT NOT NULL,
  client_ref     TEXT UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_sales_date ON sales(sold_at);

CREATE TABLE IF NOT EXISTS sale_items (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id         INTEGER NOT NULL REFERENCES sales(id),
  variant_id      INTEGER NOT NULL REFERENCES product_variants(id),
  qty             INTEGER NOT NULL CHECK (qty > 0),
  price_kop       INTEGER NOT NULL,
  cost_unit_x10000 INTEGER NOT NULL,
  cost_total_kop  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items(sale_id);
CREATE INDEX IF NOT EXISTS idx_sale_items_variant ON sale_items(variant_id);

CREATE TABLE IF NOT EXISTS returns (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  number      TEXT NOT NULL UNIQUE,
  sale_id     INTEGER NOT NULL REFERENCES sales(id),
  reason      TEXT,
  total_kop   INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'posted',
  created_at  TEXT NOT NULL,
  author_id   INTEGER NOT NULL REFERENCES users(id),
  client_ref  TEXT UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_returns_sale ON returns(sale_id);

CREATE TABLE IF NOT EXISTS return_items (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  return_id       INTEGER NOT NULL REFERENCES returns(id),
  sale_item_id    INTEGER NOT NULL REFERENCES sale_items(id),
  variant_id      INTEGER NOT NULL REFERENCES product_variants(id),
  qty             INTEGER NOT NULL CHECK (qty > 0),
  price_kop       INTEGER NOT NULL,
  condition       TEXT NOT NULL CHECK (condition IN ('sellable','damaged')),
  cost_unit_x10000 INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS inventory_counts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  number       TEXT NOT NULL UNIQUE,
  counted_at   TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','posted')),
  comment      TEXT,
  author_id    INTEGER NOT NULL REFERENCES users(id),
  posted_by    INTEGER REFERENCES users(id),
  posted_at    TEXT,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS inventory_items (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  count_id       INTEGER NOT NULL REFERENCES inventory_counts(id),
  variant_id     INTEGER NOT NULL REFERENCES product_variants(id),
  qty_expected   INTEGER NOT NULL,
  qty_actual     INTEGER NOT NULL,
  comment        TEXT
);
CREATE INDEX IF NOT EXISTS idx_inv_items ON inventory_items(count_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         TEXT NOT NULL,
  user_id    INTEGER,
  login      TEXT,
  action     TEXT NOT NULL,
  entity     TEXT,
  entity_id  INTEGER,
  details    TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at);

CREATE TABLE IF NOT EXISTS settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS counters (
  name   TEXT PRIMARY KEY,
  value  INTEGER NOT NULL
);

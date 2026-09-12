-- 27beauty core schema. All money is stored as integer pence (GBP).

CREATE TABLE IF NOT EXISTS categories (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  slug          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  description   TEXT,
  emoji         TEXT,
  image_url     TEXT,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS products (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  slug              TEXT NOT NULL UNIQUE,
  title             TEXT NOT NULL,
  description       TEXT,
  category_id       INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  brand             TEXT,
  sku               TEXT,
  price_pence       INTEGER NOT NULL DEFAULT 0,
  compare_at_pence  INTEGER,
  cost_pence        INTEGER,
  stock             INTEGER NOT NULL DEFAULT 0,
  image_url         TEXT,
  images_json       TEXT NOT NULL DEFAULT '[]',
  status            TEXT NOT NULL DEFAULT 'active',   -- active | draft | archived
  featured          INTEGER NOT NULL DEFAULT 0,
  source            TEXT NOT NULL DEFAULT 'manual',   -- manual | ebay | csv
  ebay_item_id      TEXT,
  ebay_account      TEXT,
  ebay_url          TEXT,
  ebay_synced_at    TEXT,
  -- When 1, the eBay sync will not overwrite locally edited fields.
  price_locked      INTEGER NOT NULL DEFAULT 0,
  stock_locked      INTEGER NOT NULL DEFAULT 0,
  content_locked    INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_products_ebay_item ON products(ebay_item_id) WHERE ebay_item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
CREATE INDEX IF NOT EXISTS idx_products_status ON products(status);
CREATE INDEX IF NOT EXISTS idx_products_featured ON products(featured);

CREATE TABLE IF NOT EXISTS coupons (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  code              TEXT NOT NULL UNIQUE,
  kind              TEXT NOT NULL DEFAULT 'percent',  -- percent | fixed
  value             INTEGER NOT NULL,                 -- percent: 1-100, fixed: pence
  description       TEXT,
  min_spend_pence   INTEGER NOT NULL DEFAULT 0,
  max_redemptions   INTEGER,                          -- NULL = unlimited
  times_used        INTEGER NOT NULL DEFAULT 0,
  per_customer_limit INTEGER,                         -- NULL = unlimited per email
  free_shipping     INTEGER NOT NULL DEFAULT 0,
  starts_at         TEXT,
  expires_at        TEXT,
  active            INTEGER NOT NULL DEFAULT 1,
  batch             TEXT,                             -- groups QR codes printed together
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_coupons_batch ON coupons(batch);

CREATE TABLE IF NOT EXISTS orders (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  order_number        TEXT NOT NULL UNIQUE,
  status              TEXT NOT NULL DEFAULT 'pending', -- pending | paid | fulfilled | cancelled | refunded
  email               TEXT,
  customer_name       TEXT,
  phone               TEXT,
  subtotal_pence      INTEGER NOT NULL DEFAULT 0,
  discount_pence      INTEGER NOT NULL DEFAULT 0,
  shipping_pence      INTEGER NOT NULL DEFAULT 0,
  total_pence         INTEGER NOT NULL DEFAULT 0,
  coupon_code         TEXT,
  currency            TEXT NOT NULL DEFAULT 'GBP',
  stripe_session_id   TEXT,
  stripe_payment_intent TEXT,
  shipping_json       TEXT,
  tracking_number     TEXT,
  carrier             TEXT,
  notes               TEXT,
  stock_applied       INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_stripe_session ON orders(stripe_session_id) WHERE stripe_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);

CREATE TABLE IF NOT EXISTS order_items (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id          INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id        INTEGER REFERENCES products(id) ON DELETE SET NULL,
  title             TEXT NOT NULL,
  sku               TEXT,
  image_url         TEXT,
  unit_price_pence  INTEGER NOT NULL,
  quantity          INTEGER NOT NULL,
  line_total_pence  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);

CREATE TABLE IF NOT EXISTS coupon_redemptions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  coupon_id   INTEGER NOT NULL REFERENCES coupons(id) ON DELETE CASCADE,
  order_id    INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  email       TEXT,
  amount_pence INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_redemption_order ON coupon_redemptions(coupon_id, order_id);

CREATE TABLE IF NOT EXISTS admin_users (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  email           TEXT NOT NULL UNIQUE,
  password_hash   TEXT NOT NULL,   -- PBKDF2-SHA256, format: iterations:saltB64:hashB64
  name            TEXT,
  role            TEXT NOT NULL DEFAULT 'owner',
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at   TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ebay_accounts (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  label                 TEXT NOT NULL,
  seller_username       TEXT,
  mode                  TEXT NOT NULL DEFAULT 'browse',  -- browse | sell
  refresh_token_var     TEXT,      -- name of the Worker secret holding the refresh token
  markup_percent        REAL NOT NULL DEFAULT 0,
  default_category_id   INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  auto_publish          INTEGER NOT NULL DEFAULT 1,
  active                INTEGER NOT NULL DEFAULT 1,
  last_sync_at          TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ebay_category_map (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  match_type    TEXT NOT NULL DEFAULT 'keyword',  -- keyword | ebay_category
  match_value   TEXT NOT NULL,
  category_id   INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  priority      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sync_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source        TEXT NOT NULL,
  trigger       TEXT NOT NULL DEFAULT 'cron',   -- cron | manual | api
  status        TEXT NOT NULL DEFAULT 'running',-- running | ok | error
  created_count INTEGER NOT NULL DEFAULT 0,
  updated_count INTEGER NOT NULL DEFAULT 0,
  ended_count   INTEGER NOT NULL DEFAULT 0,
  message       TEXT,
  started_at    TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_sync_runs_started ON sync_runs(started_at);

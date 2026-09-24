-- Centralised stock: products.stock is the one master count; every marketplace
-- listing is linked to a product and kept in step with it (src/lib/stock.ts,
-- src/lib/channels.ts).

-- One row per marketplace listing (an eBay item in either shop, an Amazon SKU).
CREATE TABLE IF NOT EXISTS channel_listings (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id            INTEGER REFERENCES products(id) ON DELETE SET NULL,
  channel               TEXT NOT NULL,             -- ebay | amazon
  account               TEXT NOT NULL,             -- eBay seller username / Amazon seller id
  external_id           TEXT NOT NULL,             -- eBay ItemID (numeric) / Amazon seller SKU
  sku                   TEXT,
  asin                  TEXT,
  title                 TEXT NOT NULL,
  fulfilment            TEXT NOT NULL DEFAULT 'merchant',  -- merchant | amazon (FBA: never pushed or counted)
  status                TEXT NOT NULL DEFAULT 'review',    -- linked | review | ignored
  match_score           REAL,
  suggested_product_id  INTEGER REFERENCES products(id) ON DELETE SET NULL,
  channel_qty           INTEGER,                   -- quantity the channel last reported
  pushed_qty            INTEGER,                   -- quantity we last set on the channel
  pushed_at             TEXT,
  last_error            TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_listings_ext ON channel_listings(channel, account, external_id);
CREATE INDEX IF NOT EXISTS idx_channel_listings_product ON channel_listings(product_id);
CREATE INDEX IF NOT EXISTS idx_channel_listings_status ON channel_listings(status);

-- Every change to products.stock, and why. UNIQUE(reason, ref) is what makes
-- importing marketplace orders idempotent: the same order line can only ever
-- be counted once, however many times it is read.
CREATE TABLE IF NOT EXISTS stock_movements (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id   INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  delta        INTEGER NOT NULL,
  stock_after  INTEGER,
  reason       TEXT NOT NULL,   -- website_sale | ebay_sale | amazon_sale | cancel | admin | start | merge
  ref          TEXT NOT NULL,
  note         TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_movements_ref ON stock_movements(reason, ref);
CREATE INDEX IF NOT EXISTS idx_stock_movements_product ON stock_movements(product_id, created_at);

-- Where each channel's order polling got up to.
CREATE TABLE IF NOT EXISTS channel_cursors (
  channel     TEXT NOT NULL,
  account     TEXT NOT NULL,
  cursor      TEXT NOT NULL,   -- ISO timestamp: orders modified after this are still to be read
  last_run_at TEXT,
  last_error  TEXT,
  PRIMARY KEY (channel, account)
);

-- eBay seller consent obtained through the admin "Connect" button.
-- AES-GCM ciphertext (key derived from SESSION_SECRET), never plain text.
ALTER TABLE ebay_accounts ADD COLUMN refresh_token_enc TEXT;
ALTER TABLE ebay_accounts ADD COLUMN connected_at TEXT;

-- A product folded into another (same item listed in both eBay shops). The
-- eBay sync still recognises its listing but never revives or edits it.
ALTER TABLE products ADD COLUMN merged_into INTEGER REFERENCES products(id) ON DELETE SET NULL;

-- Every existing eBay product becomes a linked listing. Browse mode stored
-- item ids as "v1|<listingId>|0"; the channel row keeps the bare listing id.
INSERT OR IGNORE INTO channel_listings (product_id, channel, account, external_id, sku, title, status, match_score, channel_qty)
SELECT id, 'ebay', ebay_account,
       CASE WHEN ebay_item_id LIKE 'v1|%|%'
            THEN substr(ebay_item_id, 4, instr(substr(ebay_item_id, 4), '|') - 1)
            ELSE ebay_item_id END,
       COALESCE(ebay_sku, sku), title, 'linked', 1, ebay_stock
  FROM products
 WHERE source = 'ebay' AND ebay_item_id IS NOT NULL AND ebay_account IS NOT NULL;

-- First-party, cookieless shop analytics (src/lib/analytics.ts).
--
-- One row per storefront page view, basket add or checkout start. Nothing
-- here identifies a person: `visitor` is a hash of IP + browser with a random
-- salt that changes every day and is then thrown away, so the same shopper on
-- two different days cannot be linked, and the IP itself is never stored.
-- Rows older than 180 days are deleted by the daily cron.
CREATE TABLE IF NOT EXISTS analytics_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ts              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
  visitor         TEXT NOT NULL,
  type            TEXT NOT NULL,      -- view | add | checkout
  view_key        TEXT,               -- random id the leave-beacon reports back against
  path            TEXT,
  page_type       TEXT,               -- home | shop | category | product | search | basket | qr | info | trade | order-complete | other
  product_id      INTEGER,
  quantity        INTEGER,
  search_term     TEXT,
  search_results  INTEGER,
  order_id        INTEGER,
  source          TEXT,               -- qr | ebay | search | social | email | campaign | other-site | direct | internal
  referrer_host   TEXT,
  campaign        TEXT,               -- utm_campaign, or the QR code on QR landing pages
  device          TEXT,               -- mobile | tablet | desktop
  country         TEXT,
  duration_ms     INTEGER,            -- time the page was visible, from the leave-beacon
  scroll_pct      INTEGER             -- how far down the page they got, 0-100
);

CREATE INDEX IF NOT EXISTS idx_analytics_ts ON analytics_events(ts);
CREATE INDEX IF NOT EXISTS idx_analytics_visitor_ts ON analytics_events(visitor, ts);
CREATE UNIQUE INDEX IF NOT EXISTS idx_analytics_view_key ON analytics_events(view_key) WHERE view_key IS NOT NULL;

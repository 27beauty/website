-- Browse-mode search coverage is approximate (see browse.ts) — a product not
-- turning up in one run's search terms doesn't mean it was actually delisted
-- on eBay. Track consecutive misses so we only archive after a sustained
-- absence, not a single incomplete search.
ALTER TABLE products ADD COLUMN ebay_miss_count INTEGER NOT NULL DEFAULT 0;

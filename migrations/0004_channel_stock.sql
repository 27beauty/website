-- Multi-channel stock. `stock` is what the website sells from — the owner's
-- master figure. `ebay_stock` records what the last sync saw on eBay, kept
-- even when `stock_locked` stops the sync overwriting the website figure, so
-- the admin panel can show the two side by side and flag a mismatch.
ALTER TABLE products ADD COLUMN ebay_stock INTEGER;

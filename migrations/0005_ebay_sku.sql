-- Sell mode's write-back (pushing our stock down to eBay when we sell here)
-- needs the seller's own SKU, which the Inventory API keys writes on —
-- eBay's itemId/listingId can't be used to update quantity.
ALTER TABLE products ADD COLUMN ebay_sku TEXT;

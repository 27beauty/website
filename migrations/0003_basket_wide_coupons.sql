-- Admin-generated QR cards now discount the WHOLE basket, not just the product
-- they were made for. A card offering 10% off everything encourages a bigger
-- order than one tied to a single item.
--
-- `product_id` keeps its other job: it is the product the QR landing page
-- features, so a card slipped into a parcel can still say "here's 10% off,
-- starting with the thing you just bought".
ALTER TABLE coupons ADD COLUMN product_only INTEGER NOT NULL DEFAULT 0;

-- Any codes created before this change were item-scoped; make them basket-wide
-- so every card already printed behaves the way the owner now expects.
UPDATE coupons SET product_only = 0;

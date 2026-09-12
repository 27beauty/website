-- Coupons can now be tied to a single product, so the owner can print a QR
-- card offering 10% off one specific item rather than the whole basket.
ALTER TABLE coupons ADD COLUMN product_id INTEGER REFERENCES products(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_coupons_product ON coupons(product_id);

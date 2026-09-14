-- Parcel2Go shipping integration: tracks the order pushed to Parcel2Go so the
-- owner can jump straight to paying for/booking the label there.
ALTER TABLE orders ADD COLUMN parcel2go_order_id TEXT;
ALTER TABLE orders ADD COLUMN parcel2go_payment_url TEXT;
ALTER TABLE orders ADD COLUMN parcel2go_status TEXT; -- pushed | error
ALTER TABLE orders ADD COLUMN parcel2go_error TEXT;

-- Parcel2Go booking from the admin: quote → book → pay from PrePay → label.
--
-- Optional per-product parcel size. NULL means "use the default parcel size
-- from Settings" (parcel2go.default_*). The eBay sync never writes these.
ALTER TABLE products ADD COLUMN weight_g INTEGER;
ALTER TABLE products ADD COLUMN length_cm REAL;
ALTER TABLE products ADD COLUMN width_cm REAL;
ALTER TABLE products ADD COLUMN height_cm REAL;

-- What was booked. parcel2go_hash authorises follow-up calls (pay, labels)
-- for a client-credentials API client that doesn't "own" the order.
-- parcel2go_status: pushed (legacy unpaid draft) | booking | booked | error
ALTER TABLE orders ADD COLUMN parcel2go_hash TEXT;
ALTER TABLE orders ADD COLUMN parcel2go_service TEXT;
ALTER TABLE orders ADD COLUMN parcel2go_courier TEXT;
ALTER TABLE orders ADD COLUMN parcel2go_price_pence INTEGER;
ALTER TABLE orders ADD COLUMN parcel2go_booked_at TEXT;

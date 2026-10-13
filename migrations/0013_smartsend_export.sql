-- When an order was last downloaded in the Parcel2Go Smart Send CSV, so the
-- next download can include only orders that haven't been sent over yet.
ALTER TABLE orders ADD COLUMN smartsend_exported_at TEXT;

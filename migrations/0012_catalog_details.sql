-- When a listing's catalogue page (description, bullet points) was read from
-- Amazon's Catalog Items API by ASIN; the listing itself only carries what the
-- seller submitted, which for a resold product is usually no description.
ALTER TABLE channel_listings ADD COLUMN catalog_checked_at TEXT;

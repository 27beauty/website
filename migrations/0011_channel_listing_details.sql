-- Details read from each Amazon listing (price, main photo, description), so a
-- product added from Amazon can be filled in, and matching has more than a
-- title to go on. details_checked_at stops a listing being fetched again.
ALTER TABLE channel_listings ADD COLUMN price_pence INTEGER;
ALTER TABLE channel_listings ADD COLUMN image_url TEXT;
ALTER TABLE channel_listings ADD COLUMN description TEXT;
ALTER TABLE channel_listings ADD COLUMN details_checked_at TEXT;

-- Reference data for 27beauty. Safe to run more than once.

INSERT INTO categories (slug, name, description, emoji, sort_order) VALUES
  ('make-up',          'Make up',             'Lipstick, mascara, foundation, brows and nails.',            '💄', 10),
  ('personal-care',    'Personal care',       'Hair care, skincare, body wash and everyday grooming.',      '🧴', 20),
  ('health-wellbeing', 'Health & Wellbeing',  'Vitamins, first aid, pregnancy tests and everyday care.',    '🩺', 30),
  ('food-drink',       'Food & Drink',        'Coffee and tea, snacks, cereal bars and catering sachets.',  '☕', 40),
  ('home',             'Home',                'Appliances, kitchen, garden and office.',                    '🏠', 50),
  ('toys-games',       'Toys & Games',        'Toys, board games and puzzles.',                             '🎲', 60),
  ('pet-supplies',     'Pet Supplies',        'Food, treats and everyday bits for cats and dogs.',          '🐾', 70)
ON CONFLICT(slug) DO UPDATE SET
  name = excluded.name,
  description = excluded.description,
  emoji = excluded.emoji,
  sort_order = excluded.sort_order;

-- Store settings (JSON-encoded values).
INSERT INTO settings (key, value) VALUES
  ('store.name',              '"27beauty"'),
  ('store.tagline',           '"Everyday brands, everyday prices — delivered across the UK."'),
  ('store.email',             '"27beautyltd@gmail.com"'),
  ('store.phone',             '""'),
  ('store.address',           '""'),
  ('shipping.flat_pence',     '0'),
  ('shipping.free_threshold_pence', '0'),
  ('checkout.enabled',        'true'),
  ('ebay.sync_enabled',       'false'),
  ('ebay.markup_percent',     '0'),
  ('ebay.auto_publish',       'true'),
  ('ebay.import_out_of_stock','false'),
  ('coupon.default_percent',  '10')
ON CONFLICT(key) DO NOTHING;

-- The QR coupon handed to marketplace customers.
INSERT INTO coupons (code, kind, value, description, min_spend_pence, active, batch)
VALUES ('QR10', 'percent', 10, '10% off — QR card included with marketplace orders', 0, 1, 'qr-cards')
ON CONFLICT(code) DO NOTHING;

-- eBay category rules live in db/ebay-category-rules.sql — they are tuned to the
-- real catalogue (brands as well as product nouns) and are replaced wholesale
-- rather than appended, so they are kept out of this file:
--   npx wrangler d1 execute DB --remote --file=./db/ebay-category-rules.sql

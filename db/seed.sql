-- Reference data for 27beauty. Safe to run more than once.

INSERT INTO categories (slug, name, description, emoji, sort_order) VALUES
  ('pet-food-treats',    'Pet Food & Treats',        'Dog and cat food, snacks and chews.',                  '🐾', 10),
  ('toys-games',         'Toys & Games',             'Toys, board games and puzzles for all ages.',          '🎲', 20),
  ('coffee-tea',         'Coffee & Tea',             'Ground coffee, pods, tea bags and infusions.',          '☕', 30),
  ('hair-beauty',        'Hair, Beauty & Grooming',  'Hair care, skincare, grooming and cosmetics.',          '💄', 40),
  ('snacks-sweets',      'Crisps, Chocolate & Sweets','Crisps, chocolate, sweets and sharing bags.',          '🍫', 50),
  ('diy-tools',          'DIY & Tools',              'Tools, fixings, decorating and hardware.',             '🔧', 60),
  ('breakfast-bars',     'Breakfast & Cereal Bars',  'Cereals, porridge, breakfast and cereal bars.',         '🥣', 70),
  ('household-appliances','Household Appliances',    'Small appliances and household essentials.',            '🔌', 80),
  ('home-living',        'Home & Living',            'Bedding, candles, air care and everyday home bits.',    '🕯️', 85),
  ('garden',             'Garden',                   'Garden tools, growing, outdoor living.',               '🪴', 90),
  ('electronics',        'Electronics & Tech',       'Computing, printing and gadget essentials.',            '💻', 95)
ON CONFLICT(slug) DO UPDATE SET
  name = excluded.name,
  description = excluded.description,
  emoji = excluded.emoji,
  sort_order = excluded.sort_order;

-- Store settings (JSON-encoded values).
INSERT INTO settings (key, value) VALUES
  ('store.name',              '"27beauty"'),
  ('store.tagline',           '"Everyday brands, everyday prices — delivered across the UK."'),
  ('store.email',             '"hello@27beauty.co.uk"'),
  ('store.phone',             '""'),
  ('store.address',           '""'),
  ('shipping.flat_pence',     '349'),
  ('shipping.free_threshold_pence', '3000'),
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

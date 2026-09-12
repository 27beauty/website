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
  ('garden',             'Garden',                   'Garden tools, growing, outdoor living.',               '🪴', 90)
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

-- Keyword rules used to file incoming eBay listings into categories.
DELETE FROM ebay_category_map WHERE match_type = 'keyword';
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', k.word, c.id, k.priority
FROM (
  SELECT 'dog' AS word, 'pet-food-treats' AS cat, 100 AS priority UNION ALL
  SELECT 'cat food', 'pet-food-treats', 100 UNION ALL
  SELECT 'kitten', 'pet-food-treats', 90 UNION ALL
  SELECT 'puppy', 'pet-food-treats', 90 UNION ALL
  SELECT 'pet', 'pet-food-treats', 60 UNION ALL
  SELECT 'board game', 'toys-games', 100 UNION ALL
  SELECT 'jigsaw', 'toys-games', 90 UNION ALL
  SELECT 'puzzle', 'toys-games', 80 UNION ALL
  SELECT 'lego', 'toys-games', 90 UNION ALL
  SELECT 'toy', 'toys-games', 60 UNION ALL
  SELECT 'coffee', 'coffee-tea', 100 UNION ALL
  SELECT 'tea bags', 'coffee-tea', 100 UNION ALL
  SELECT 'espresso', 'coffee-tea', 90 UNION ALL
  SELECT 'shampoo', 'hair-beauty', 100 UNION ALL
  SELECT 'conditioner', 'hair-beauty', 90 UNION ALL
  SELECT 'razor', 'hair-beauty', 90 UNION ALL
  SELECT 'moisturiser', 'hair-beauty', 90 UNION ALL
  SELECT 'shower gel', 'hair-beauty', 90 UNION ALL
  SELECT 'perfume', 'hair-beauty', 80 UNION ALL
  SELECT 'crisps', 'snacks-sweets', 100 UNION ALL
  SELECT 'chocolate', 'snacks-sweets', 100 UNION ALL
  SELECT 'sweets', 'snacks-sweets', 100 UNION ALL
  SELECT 'haribo', 'snacks-sweets', 90 UNION ALL
  SELECT 'drill', 'diy-tools', 100 UNION ALL
  SELECT 'screwdriver', 'diy-tools', 90 UNION ALL
  SELECT 'tool', 'diy-tools', 60 UNION ALL
  SELECT 'paint', 'diy-tools', 70 UNION ALL
  SELECT 'cereal bar', 'breakfast-bars', 100 UNION ALL
  SELECT 'porridge', 'breakfast-bars', 90 UNION ALL
  SELECT 'cereal', 'breakfast-bars', 80 UNION ALL
  SELECT 'granola', 'breakfast-bars', 90 UNION ALL
  SELECT 'kettle', 'household-appliances', 100 UNION ALL
  SELECT 'toaster', 'household-appliances', 100 UNION ALL
  SELECT 'air fryer', 'household-appliances', 100 UNION ALL
  SELECT 'vacuum', 'household-appliances', 90 UNION ALL
  SELECT 'garden', 'garden', 100 UNION ALL
  SELECT 'plant', 'garden', 80 UNION ALL
  SELECT 'seeds', 'garden', 90 UNION ALL
  SELECT 'hose', 'garden', 80
) AS k
JOIN categories c ON c.slug = k.cat;

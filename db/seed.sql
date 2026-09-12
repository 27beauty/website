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
WITH rules(word, cat, priority) AS (
  VALUES
    ('dog', 'pet-food-treats', 100),
    ('cat food', 'pet-food-treats', 100),
    ('kitten', 'pet-food-treats', 90),
    ('puppy', 'pet-food-treats', 90),
    ('pet', 'pet-food-treats', 60),
    ('board game', 'toys-games', 100),
    ('jigsaw', 'toys-games', 90),
    ('puzzle', 'toys-games', 80),
    ('lego', 'toys-games', 90),
    ('toy', 'toys-games', 60),
    ('coffee', 'coffee-tea', 100),
    ('tea bags', 'coffee-tea', 100),
    ('espresso', 'coffee-tea', 90),
    ('shampoo', 'hair-beauty', 100),
    ('conditioner', 'hair-beauty', 90),
    ('razor', 'hair-beauty', 90),
    ('moisturiser', 'hair-beauty', 90),
    ('shower gel', 'hair-beauty', 90),
    ('perfume', 'hair-beauty', 80),
    ('crisps', 'snacks-sweets', 100),
    ('chocolate', 'snacks-sweets', 100),
    ('sweets', 'snacks-sweets', 100),
    ('haribo', 'snacks-sweets', 90),
    ('drill', 'diy-tools', 100),
    ('screwdriver', 'diy-tools', 90),
    ('tool', 'diy-tools', 60),
    ('paint', 'diy-tools', 70),
    ('cereal bar', 'breakfast-bars', 100),
    ('porridge', 'breakfast-bars', 90),
    ('cereal', 'breakfast-bars', 80),
    ('granola', 'breakfast-bars', 90),
    ('kettle', 'household-appliances', 100),
    ('toaster', 'household-appliances', 100),
    ('air fryer', 'household-appliances', 100),
    ('vacuum', 'household-appliances', 90),
    ('garden', 'garden', 100),
    ('plant', 'garden', 80),
    ('seeds', 'garden', 90),
    ('hose', 'garden', 80)
)
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', rules.word, c.id, rules.priority
FROM rules
JOIN categories c ON c.slug = rules.cat;

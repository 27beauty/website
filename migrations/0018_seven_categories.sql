-- Seven categories, as the shop owner asked for:
--   Make up, Personal care, Health & Wellbeing, Food & Drink, Home,
--   Toys & Games, Pet Supplies.
--
-- Two pairs merge: Hair Care + Skin & Body Care become Personal care, and
-- Home & Kitchen + DIY, Garden & Office become Home.
--
-- The surviving category ids are reused, so every product, eBay filing rule
-- and account default keeps pointing at a real row. Order matters below: the
-- two retiring categories must give up their products and rules BEFORE they
-- are deleted, because ebay_category_map.category_id cascades on delete and
-- products.category_id is set to NULL.
--
-- Slugs are brought in line with the names. They had drifted badly as the shop
-- was reshaped — 'coffee-tea' was Food & Drink, 'diy-tools' was DIY, Garden &
-- Office, 'hair-beauty' was Hair Care — which made the public URLs misleading.
-- The storefront 301s every retired slug to its new home, so existing links,
-- search results and printed QR cards still land on the right page.
--
-- On a fresh database these ids do not exist yet and every statement here is a
-- harmless no-op; db/seed.sql then creates the seven directly.

-- 1. The retiring categories hand over their products.
UPDATE products SET category_id = 4  WHERE category_id = 22;  -- Skin & Body Care -> Personal care
UPDATE products SET category_id = 10 WHERE category_id = 6;   -- DIY, Garden & Office -> Home

-- 2. ...and their eBay filing rules, before the delete would cascade them away.
UPDATE ebay_category_map SET category_id = 4  WHERE category_id = 22;
UPDATE ebay_category_map SET category_id = 10 WHERE category_id = 6;

-- 3. ...and any eBay account that defaulted to one of them.
UPDATE ebay_accounts SET default_category_id = 4  WHERE default_category_id = 22;
UPDATE ebay_accounts SET default_category_id = 10 WHERE default_category_id = 6;

-- 4. Merging can leave the same keyword rule twice over, once from each side
--    of a merge ('vacuum' under both DIY and Home, say). Keep the first.
DELETE FROM ebay_category_map
 WHERE id NOT IN (SELECT MIN(id) FROM ebay_category_map GROUP BY match_type, match_value, category_id);

-- 5. Now they hold nothing and can go.
DELETE FROM categories WHERE id IN (6, 22);

-- 6. Name, slug, order and blurb for the seven that remain. Make up leads:
--    it is the shop's biggest category and what the brand is built around.
UPDATE categories SET slug = 'make-up', name = 'Make up', emoji = '💄', sort_order = 10,
       description = 'Lipstick, mascara, foundation, brows and nails.'
 WHERE id = 23;

UPDATE categories SET slug = 'personal-care', name = 'Personal care', emoji = '🧴', sort_order = 20,
       description = 'Hair care, skincare, body wash and everyday grooming.'
 WHERE id = 4;

UPDATE categories SET slug = 'health-wellbeing', name = 'Health & Wellbeing', emoji = '🩺', sort_order = 30,
       description = 'Vitamins, first aid, pregnancy tests and everyday care.'
 WHERE id = 21;

UPDATE categories SET slug = 'food-drink', name = 'Food & Drink', emoji = '☕', sort_order = 40,
       description = 'Coffee and tea, snacks, cereal bars and catering sachets.'
 WHERE id = 3;

UPDATE categories SET slug = 'home', name = 'Home', emoji = '🏠', sort_order = 50,
       description = 'Appliances, kitchen, garden and office.'
 WHERE id = 10;

UPDATE categories SET slug = 'toys-games', name = 'Toys & Games', emoji = '🎲', sort_order = 60,
       description = 'Toys, board games and puzzles.'
 WHERE id = 2;

UPDATE categories SET slug = 'pet-supplies', name = 'Pet Supplies', emoji = '🐾', sort_order = 70,
       description = 'Food, treats and everyday bits for cats and dogs.'
 WHERE id = 1;

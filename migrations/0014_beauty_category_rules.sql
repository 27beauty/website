-- Beauty is now Hair Care (slug hair-beauty), Skin & Body Care and Makeup &
-- Fragrance. Re-point the eBay sync's keyword rules so new listings land in
-- the right one. Each statement only runs where those categories exist.

UPDATE ebay_category_map
   SET category_id = (SELECT id FROM categories WHERE slug = 'skin-and-body-care')
 WHERE match_type = 'keyword'
   AND match_value IN ('scottish fine soaps', 'sottish fine soaps', 'nuxe', 'vaseline', 'scholl', 'lip balm',
                       'hand wash', 'body wash', 'hand and nail', 'body lotion', 'shower gel', 'foot file')
   AND EXISTS (SELECT 1 FROM categories WHERE slug = 'skin-and-body-care');

UPDATE ebay_category_map
   SET category_id = (SELECT id FROM categories WHERE slug = 'makeup-and-fragrance')
 WHERE match_type = 'keyword'
   AND match_value IN ('maybelline', 'mascara', 'lip serum', 'eau de parfum', 'perfume')
   AND EXISTS (SELECT 1 FROM categories WHERE slug = 'makeup-and-fragrance');

UPDATE ebay_category_map
   SET category_id = (SELECT id FROM categories WHERE slug = 'health-and-welfare')
 WHERE match_type = 'keyword' AND match_value = 'compeed'
   AND EXISTS (SELECT 1 FROM categories WHERE slug = 'health-and-welfare');

-- A Scottish Fine Soaps shampoo is still hair care: the product word beats the brand.
UPDATE ebay_category_map SET priority = 125
 WHERE match_type = 'keyword' AND match_value IN ('shampoo', 'conditioner')
   AND category_id = (SELECT id FROM categories WHERE slug = 'hair-beauty');

-- One statement per new word: D1 limits how many parts a compound SELECT may have.
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'lipstick', c.id, 110 FROM categories c
 WHERE c.slug = 'makeup-and-fragrance'
   AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'lipstick');
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'eyeliner', c.id, 110 FROM categories c
 WHERE c.slug = 'makeup-and-fragrance'
   AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'eyeliner');
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'nyx', c.id, 115 FROM categories c
 WHERE c.slug = 'makeup-and-fragrance'
   AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'nyx');
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'brow', c.id, 105 FROM categories c
 WHERE c.slug = 'makeup-and-fragrance'
   AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'brow');
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'eyeshadow', c.id, 110 FROM categories c
 WHERE c.slug = 'makeup-and-fragrance'
   AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'eyeshadow');
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'foundation', c.id, 100 FROM categories c
 WHERE c.slug = 'makeup-and-fragrance'
   AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'foundation');

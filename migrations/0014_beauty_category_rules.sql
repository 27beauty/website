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

INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', w.word, c.id, w.priority
  FROM (SELECT 'lipstick' AS word, 110 AS priority UNION ALL SELECT 'eyeliner', 110 UNION ALL SELECT 'nyx', 115
        UNION ALL SELECT 'brow', 105 UNION ALL SELECT 'eyeshadow', 110 UNION ALL SELECT 'foundation', 100) w
  JOIN categories c ON c.slug = 'makeup-and-fragrance'
 WHERE NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = w.word);

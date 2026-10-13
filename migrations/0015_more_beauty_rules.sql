-- Beauty words that beat the coffee rule: "L'Oreal ... Lip Stain 485 Nude Espresso"
-- matched 'espresso' (priority 100) and landed in Food & Drink.
-- One statement per word: D1 limits how many parts a compound SELECT may have.
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'lip stain', c.id, 115 FROM categories c
 WHERE c.slug = 'makeup-and-fragrance'
   AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'lip stain');
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'lip gloss', c.id, 115 FROM categories c
 WHERE c.slug = 'makeup-and-fragrance'
   AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'lip gloss');
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'highlighter', c.id, 110 FROM categories c
 WHERE c.slug = 'makeup-and-fragrance'
   AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'highlighter');
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'hair removal', c.id, 110 FROM categories c
 WHERE c.slug = 'skin-and-body-care'
   AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'hair removal');
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'ipl', c.id, 110 FROM categories c
 WHERE c.slug = 'skin-and-body-care'
   AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'ipl');

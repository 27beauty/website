-- Two gaps the restore of archived products exposed.
--
-- Make up had no rule for mascara, concealer, powders or the brands the shop
-- actually sells, so "Maybelline Fit Me Matte & Poreless Powder" filed
-- nowhere.
--
-- And skincare sat below the health rules: "Olay Vitamin C Brighten & Glow
-- SPF50+ Moisturiser" matched 'vitamin' (Health & Wellbeing, 95) before
-- 'moisturiser' (Personal care, 90), so a face cream was filed as a
-- supplement. The skincare words move to 98, the same band as 'serum', which
-- was raised for exactly this reason: above the health rules, below make-up.


-- make-up @ 115
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'mascara', c.id, 115 FROM categories c WHERE c.slug = 'make-up'
  AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'mascara');
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'concealer', c.id, 115 FROM categories c WHERE c.slug = 'make-up'
  AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'concealer');
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'blusher', c.id, 115 FROM categories c WHERE c.slug = 'make-up'
  AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'blusher');
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'bronzer', c.id, 115 FROM categories c WHERE c.slug = 'make-up'
  AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'bronzer');
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'setting powder', c.id, 115 FROM categories c WHERE c.slug = 'make-up'
  AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'setting powder');
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'lip liner', c.id, 115 FROM categories c WHERE c.slug = 'make-up'
  AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'lip liner');
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'nail polish', c.id, 115 FROM categories c WHERE c.slug = 'make-up'
  AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'nail polish');
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'nail varnish', c.id, 115 FROM categories c WHERE c.slug = 'make-up'
  AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'nail varnish');
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'maybelline', c.id, 115 FROM categories c WHERE c.slug = 'make-up'
  AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'maybelline');
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'max factor', c.id, 115 FROM categories c WHERE c.slug = 'make-up'
  AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'max factor');
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'rimmel', c.id, 115 FROM categories c WHERE c.slug = 'make-up'
  AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'rimmel');
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'eyeshadow palette', c.id, 115 FROM categories c WHERE c.slug = 'make-up'
  AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'eyeshadow palette');
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'fit me', c.id, 115 FROM categories c WHERE c.slug = 'make-up'
  AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'fit me');

-- Skincare must outrank 'vitamin'.
UPDATE ebay_category_map SET priority = 98
 WHERE match_type = 'keyword' AND priority = 90
   AND match_value IN ('moisturiser', 'shower gel', 'razor')
   AND category_id = (SELECT id FROM categories WHERE slug = 'personal-care');

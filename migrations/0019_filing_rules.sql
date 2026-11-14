-- Filing rules for the categories that had none, so the eBay sync files new
-- listings by itself instead of leaving them with no category at all.
--
-- Health & Wellbeing had ZERO rules: nothing could ever land there
-- automatically, which is why vitamins and supplements were among the 29 live
-- products sitting in no category, invisible to anyone browsing the shop.
-- Oral care and grooming were missing from Personal care, candles and air care
-- from Home.
--
-- One INSERT per rule on purpose. A single multi-row VALUES list is a compound
-- SELECT to SQLite and D1 rejects more than a handful of terms — the same limit
-- that broke db/ebay-category-rules.sql.
--
-- Each is skipped if that keyword is already mapped, so the curated set already
-- in production, and anything the owner adds, always wins. Safe to re-apply.
--
-- PRIORITIES ARE DELICATE. Highest match wins, so the bands read:
--   125  shampoo / conditioner
--   120  oral care and grooming brands (added here)
--   115  make-up specifics, and the home/food/toys brands added here
--   100  make-up generics ('foundation'), food, home, pet, toys
--    98  'serum' (added here)
--    95  health and supplements (added here)
-- 'serum' has to sit below make-up and above health: a lip stain serum is
-- make-up, a Vitamin C serum is skincare, and a fish oil is health. Putting
-- 'serum' at the top instead quietly moved L'Oreal's Lip Stain Serum out of
-- Make up, which test/filing-rules.test.ts now guards against.
--
-- Rules only ever fill a category that is empty (sync.ts uses COALESCE), so
-- nothing the owner has already filed by hand is touched.


-- health-wellbeing @ 95
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'vitamin', c.id, 95 FROM categories c WHERE c.slug = 'health-wellbeing'
  AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'vitamin');
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'vitamins', c.id, 95 FROM categories c WHERE c.slug = 'health-wellbeing'
  AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'vitamins');
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'vitabiotics', c.id, 95 FROM categories c WHERE c.slug = 'health-wellbeing'
  AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'vitabiotics');
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'berocca', c.id, 95 FROM categories c WHERE c.slug = 'health-wellbeing'
  AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'berocca');
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'multivitamin', c.id, 95 FROM categories c WHERE c.slug = 'health-wellbeing'
  AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'multivitamin');
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'omega', c.id, 95 FROM categories c WHERE c.slug = 'health-wellbeing'
  AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'omega');
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'fish oil', c.id, 95 FROM categories c WHERE c.slug = 'health-wellbeing'
  AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'fish oil');
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'cod liver', c.id, 95 FROM categories c WHERE c.slug = 'health-wellbeing'
  AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'cod liver');
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'seven seas', c.id, 95 FROM categories c WHERE c.slug = 'health-wellbeing'
  AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'seven seas');
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'lindens', c.id, 95 FROM categories c WHERE c.slug = 'health-wellbeing'
  AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'lindens');
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'supplement', c.id, 95 FROM categories c WHERE c.slug = 'health-wellbeing'
  AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'supplement');
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'supplements', c.id, 95 FROM categories c WHERE c.slug = 'health-wellbeing'
  AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'supplements');
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'probiotic', c.id, 95 FROM categories c WHERE c.slug = 'health-wellbeing'
  AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'probiotic');
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'probiotics', c.id, 95 FROM categories c WHERE c.slug = 'health-wellbeing'
  AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'probiotics');
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'collagen', c.id, 95 FROM categories c WHERE c.slug = 'health-wellbeing'
  AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'collagen');
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'jointcare', c.id, 95 FROM categories c WHERE c.slug = 'health-wellbeing'
  AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'jointcare');
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'selenium', c.id, 95 FROM categories c WHERE c.slug = 'health-wellbeing'
  AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'selenium');
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'glucosamine', c.id, 95 FROM categories c WHERE c.slug = 'health-wellbeing'
  AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'glucosamine');
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'lions mane', c.id, 95 FROM categories c WHERE c.slug = 'health-wellbeing'
  AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'lions mane');
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'ashwagandha', c.id, 95 FROM categories c WHERE c.slug = 'health-wellbeing'
  AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'ashwagandha');
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'energy gel', c.id, 95 FROM categories c WHERE c.slug = 'health-wellbeing'
  AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'energy gel');
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'energy gels', c.id, 95 FROM categories c WHERE c.slug = 'health-wellbeing'
  AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'energy gels');
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'science in sport', c.id, 95 FROM categories c WHERE c.slug = 'health-wellbeing'
  AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'science in sport');
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'electrolyte', c.id, 95 FROM categories c WHERE c.slug = 'health-wellbeing'
  AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'electrolyte');
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'pregnancy test', c.id, 95 FROM categories c WHERE c.slug = 'health-wellbeing'
  AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'pregnancy test');
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'first aid', c.id, 95 FROM categories c WHERE c.slug = 'health-wellbeing'
  AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'first aid');
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'e45', c.id, 95 FROM categories c WHERE c.slug = 'health-wellbeing'
  AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'e45');
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'incontinence', c.id, 95 FROM categories c WHERE c.slug = 'health-wellbeing'
  AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'incontinence');
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'tena', c.id, 95 FROM categories c WHERE c.slug = 'health-wellbeing'
  AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'tena');
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'paracetamol', c.id, 95 FROM categories c WHERE c.slug = 'health-wellbeing'
  AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'paracetamol');
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'ibuprofen', c.id, 95 FROM categories c WHERE c.slug = 'health-wellbeing'
  AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'ibuprofen');

-- personal-care @ 98
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'serum', c.id, 98 FROM categories c WHERE c.slug = 'personal-care'
  AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'serum');

-- personal-care @ 120
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'toothpaste', c.id, 120 FROM categories c WHERE c.slug = 'personal-care'
  AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'toothpaste');
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'toothbrush', c.id, 120 FROM categories c WHERE c.slug = 'personal-care'
  AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'toothbrush');
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'sensodyne', c.id, 120 FROM categories c WHERE c.slug = 'personal-care'
  AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'sensodyne');
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'colgate', c.id, 120 FROM categories c WHERE c.slug = 'personal-care'
  AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'colgate');
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'oral-b', c.id, 120 FROM categories c WHERE c.slug = 'personal-care'
  AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'oral-b');
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'sonicare', c.id, 120 FROM categories c WHERE c.slug = 'personal-care'
  AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'sonicare');
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'mouthwash', c.id, 120 FROM categories c WHERE c.slug = 'personal-care'
  AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'mouthwash');
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'dental floss', c.id, 120 FROM categories c WHERE c.slug = 'personal-care'
  AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'dental floss');
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'teeth whitening', c.id, 120 FROM categories c WHERE c.slug = 'personal-care'
  AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'teeth whitening');
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'wilkinson sword', c.id, 120 FROM categories c WHERE c.slug = 'personal-care'
  AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'wilkinson sword');
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'oneblade', c.id, 120 FROM categories c WHERE c.slug = 'personal-care'
  AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'oneblade');
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'gillette', c.id, 120 FROM categories c WHERE c.slug = 'personal-care'
  AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'gillette');
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'grooming', c.id, 120 FROM categories c WHERE c.slug = 'personal-care'
  AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'grooming');
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'hand wash', c.id, 120 FROM categories c WHERE c.slug = 'personal-care'
  AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'hand wash');
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'body wash', c.id, 120 FROM categories c WHERE c.slug = 'personal-care'
  AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'body wash');
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'hair dryer', c.id, 120 FROM categories c WHERE c.slug = 'personal-care'
  AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'hair dryer');
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'tresemme', c.id, 120 FROM categories c WHERE c.slug = 'personal-care'
  AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'tresemme');
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'remington', c.id, 120 FROM categories c WHERE c.slug = 'personal-care'
  AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'remington');
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'sanctuary spa', c.id, 120 FROM categories c WHERE c.slug = 'personal-care'
  AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'sanctuary spa');
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'deodorant', c.id, 120 FROM categories c WHERE c.slug = 'personal-care'
  AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'deodorant');

-- home @ 115
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'yankee candle', c.id, 115 FROM categories c WHERE c.slug = 'home'
  AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'yankee candle');
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'candle', c.id, 115 FROM categories c WHERE c.slug = 'home'
  AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'candle');
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'reed diffuser', c.id, 115 FROM categories c WHERE c.slug = 'home'
  AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'reed diffuser');
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'diffuser', c.id, 115 FROM categories c WHERE c.slug = 'home'
  AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'diffuser');
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'air freshener', c.id, 115 FROM categories c WHERE c.slug = 'home'
  AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'air freshener');
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'glade', c.id, 115 FROM categories c WHERE c.slug = 'home'
  AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'glade');
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'printer', c.id, 115 FROM categories c WHERE c.slug = 'home'
  AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'printer');
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'canon', c.id, 115 FROM categories c WHERE c.slug = 'home'
  AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'canon');
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'ink cartridge', c.id, 115 FROM categories c WHERE c.slug = 'home'
  AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'ink cartridge');
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'keyboard', c.id, 115 FROM categories c WHERE c.slug = 'home'
  AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'keyboard');
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'makita', c.id, 115 FROM categories c WHERE c.slug = 'home'
  AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'makita');
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'diamond blade', c.id, 115 FROM categories c WHERE c.slug = 'home'
  AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'diamond blade');

-- food-drink @ 115
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'dolce gusto', c.id, 115 FROM categories c WHERE c.slug = 'food-drink'
  AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'dolce gusto');
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'gravy', c.id, 115 FROM categories c WHERE c.slug = 'food-drink'
  AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'gravy');
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'bisto', c.id, 115 FROM categories c WHERE c.slug = 'food-drink'
  AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'bisto');
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'nescafe', c.id, 115 FROM categories c WHERE c.slug = 'food-drink'
  AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'nescafe');

-- toys-games @ 115
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'mattel', c.id, 115 FROM categories c WHERE c.slug = 'toys-games'
  AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'mattel');
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'jurassic world', c.id, 115 FROM categories c WHERE c.slug = 'toys-games'
  AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'jurassic world');
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'marvel', c.id, 115 FROM categories c WHERE c.slug = 'toys-games'
  AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'marvel');
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'spidey', c.id, 115 FROM categories c WHERE c.slug = 'toys-games'
  AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'spidey');
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'action figure', c.id, 115 FROM categories c WHERE c.slug = 'toys-games'
  AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'action figure');
INSERT INTO ebay_category_map (match_type, match_value, category_id, priority)
SELECT 'keyword', 'dinosaur', c.id, 115 FROM categories c WHERE c.slug = 'toys-games'
  AND NOT EXISTS (SELECT 1 FROM ebay_category_map m WHERE m.match_type = 'keyword' AND m.match_value = 'dinosaur');

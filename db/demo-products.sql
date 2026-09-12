-- Optional sample catalogue for local development, and for eyeballing the shop
-- before the eBay sync brings in the real listings. Safe to skip in production.
--   npx wrangler d1 execute DB --local --file=./db/demo-products.sql

WITH demo(slug, title, description, cat, brand, sku, price_pence, compare_at_pence, stock, featured) AS (
  VALUES
    ('dreamies-cat-treats-60g', 'Dreamies Cat Treats Mix 60g', 'Crunchy outside, soft centre. A cat-favourite treat in a resealable pouch.', 'pet-food-treats', 'Dreamies', 'PET-001', 129, 179, 40, 1),
    ('pedigree-dentastix-large-7pk', 'Pedigree Dentastix Large 7 Pack', 'Daily dental chews for large dogs, clinically proven to reduce plaque build-up.', 'pet-food-treats', 'Pedigree', 'PET-002', 299, NULL, 25, 0),
    ('monopoly-classic-board-game', 'Monopoly Classic Board Game', 'The property trading game for 2-6 players. Complete with tokens, cards and money.', 'toys-games', 'Hasbro', 'TOY-001', 1499, 1999, 12, 1),
    ('rubiks-cube-3x3', 'Rubiks Cube 3x3', 'The original 3x3 puzzle cube. Over 43 quintillion combinations, one solution.', 'toys-games', 'Rubiks', 'TOY-002', 899, 1199, 20, 0),
    ('yorkshire-tea-240-bags', 'Yorkshire Tea 240 Bags', 'Proper brew. 240 bags of Yorkshire Tea, blended for British water.', 'coffee-tea', 'Taylors of Harrogate', 'COF-001', 899, 1099, 30, 1),
    ('nescafe-gold-blend-200g', 'Nescafe Gold Blend 200g', 'Smooth, rich instant coffee in a 200g jar.', 'coffee-tea', 'Nescafe', 'COF-002', 749, NULL, 18, 0),
    ('head-shoulders-classic-500ml', 'Head & Shoulders Classic Clean 500ml', 'Anti-dandruff shampoo for everyday use. Up to 100% flake-free hair.', 'hair-beauty', 'Head & Shoulders', 'BEA-001', 499, 699, 22, 1),
    ('gillette-fusion5-blades-4pk', 'Gillette Fusion5 Razor Blades 4 Pack', 'Five anti-friction blades for a shave you barely feel.', 'hair-beauty', 'Gillette', 'BEA-002', 1299, 1599, 9, 0),
    ('walkers-crisps-variety-24pk', 'Walkers Crisps Variety 24 Pack', 'Ready Salted, Cheese & Onion and Salt & Vinegar. Perfect for lunchboxes.', 'snacks-sweets', 'Walkers', 'SNK-001', 549, 699, 35, 1),
    ('cadbury-dairy-milk-850g', 'Cadbury Dairy Milk Sharing Bar 850g', 'A glass and a half in every half pound. The big one.', 'snacks-sweets', 'Cadbury', 'SNK-002', 799, 999, 14, 0),
    ('stanley-screwdriver-set-6pc', 'Stanley Screwdriver Set 6 Piece', 'Three flathead, three Phillips. Hardened tips and cushioned grips.', 'diy-tools', 'Stanley', 'DIY-001', 1199, NULL, 8, 0),
    ('nature-valley-crunchy-bars-10pk', 'Nature Valley Crunchy Oat Bars 10 Pack', 'Whole grain oat bars with honey. Two bars per pack.', 'breakfast-bars', 'Nature Valley', 'BRK-001', 399, 499, 26, 0),
    ('weetabix-48-pack', 'Weetabix 48 Pack', 'Whole grain wheat biscuits. The breakfast that keeps going.', 'breakfast-bars', 'Weetabix', 'BRK-002', 549, NULL, 21, 0),
    ('russell-hobbs-kettle-17l', 'Russell Hobbs Textures Kettle 1.7L', 'Rapid boil zone, removable limescale filter, 3000W.', 'household-appliances', 'Russell Hobbs', 'APP-001', 2499, 2999, 5, 1),
    ('hozelock-garden-hose-25m', 'Hozelock Garden Hose 25m', 'Kink-resistant 12.5mm hose with a 15-year guarantee.', 'garden', 'Hozelock', 'GRD-001', 1999, 2499, 0, 0),
    ('peat-free-compost-50l', 'Peat-Free Multi-Purpose Compost 50L', 'Sustainable multi-purpose compost for beds, borders and containers.', 'garden', 'Westland', 'GRD-002', 899, NULL, 16, 0)
)
INSERT OR IGNORE INTO products
  (slug, title, description, category_id, brand, sku, price_pence, compare_at_pence, stock, status, featured, source)
SELECT d.slug, d.title, d.description, c.id, d.brand, d.sku, d.price_pence, d.compare_at_pence,
       d.stock, 'active', d.featured, 'manual'
FROM demo d
JOIN categories c ON c.slug = d.cat;

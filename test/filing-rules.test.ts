/**
 * The eBay sync files a new listing by matching keywords in its title. Health
 * & Wellbeing had no rules at all, so nothing could ever land there, which is
 * how 29 live products ended up in no category and invisible to anyone
 * browsing the shop.
 *
 * These are the real titles of those 29, taken from production, checked against
 * the rules as the sync loads them. If a rule is retuned and one of these
 * stops filing correctly, that is a product disappearing from the shop.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Env } from '../src/types';
import { loadCategoryRules, mapCategory } from '../src/lib/ebay/mapping';
import { createTestD1 } from './helpers/d1';

let env: Env;
let sql: ReturnType<typeof createTestD1>;
const ids: Record<string, number> = {
  'make-up': 23,
  'personal-care': 4,
  'health-wellbeing': 21,
  'food-drink': 3,
  home: 10,
  'toys-games': 2,
  'pet-supplies': 1,
};

/**
 * The 50 keyword rules production actually has, on the category ids they sit
 * on after the seven-category restructure. Migrations 0014/0015 cannot be
 * replayed here: they join categories on the pre-restructure slugs, so they
 * would silently insert nothing and the test would prove nothing.
 */
const PRODUCTION_RULES = `INSERT INTO ebay_category_map (match_type, match_value, category_id, priority) VALUES
      ('keyword', 'shampoo', ${ids['personal-care']}, 125),
      ('keyword', 'conditioner', ${ids['personal-care']}, 125),
      ('keyword', 'nyx', ${ids['make-up']}, 115),
      ('keyword', 'lip stain', ${ids['make-up']}, 115),
      ('keyword', 'lip gloss', ${ids['make-up']}, 115),
      ('keyword', 'lipstick', ${ids['make-up']}, 110),
      ('keyword', 'eyeliner', ${ids['make-up']}, 110),
      ('keyword', 'eyeshadow', ${ids['make-up']}, 110),
      ('keyword', 'highlighter', ${ids['make-up']}, 110),
      ('keyword', 'hair removal', ${ids['personal-care']}, 110),
      ('keyword', 'ipl', ${ids['personal-care']}, 110),
      ('keyword', 'brow', ${ids['make-up']}, 105),
      ('keyword', 'coffee', ${ids['food-drink']}, 100),
      ('keyword', 'tea bags', ${ids['food-drink']}, 100),
      ('keyword', 'crisps', ${ids['food-drink']}, 100),
      ('keyword', 'chocolate', ${ids['food-drink']}, 100),
      ('keyword', 'sweets', ${ids['food-drink']}, 100),
      ('keyword', 'cereal bar', ${ids['food-drink']}, 100),
      ('keyword', 'drill', ${ids['home']}, 100),
      ('keyword', 'kettle', ${ids['home']}, 100),
      ('keyword', 'toaster', ${ids['home']}, 100),
      ('keyword', 'air fryer', ${ids['home']}, 100),
      ('keyword', 'garden', ${ids['home']}, 100),
      ('keyword', 'foundation', ${ids['make-up']}, 100),
      ('keyword', 'dog', ${ids['pet-supplies']}, 100),
      ('keyword', 'cat food', ${ids['pet-supplies']}, 100),
      ('keyword', 'board game', ${ids['toys-games']}, 100),
      ('keyword', 'espresso', ${ids['food-drink']}, 90),
      ('keyword', 'haribo', ${ids['food-drink']}, 90),
      ('keyword', 'porridge', ${ids['food-drink']}, 90),
      ('keyword', 'granola', ${ids['food-drink']}, 90),
      ('keyword', 'screwdriver', ${ids['home']}, 90),
      ('keyword', 'vacuum', ${ids['home']}, 90),
      ('keyword', 'seeds', ${ids['home']}, 90),
      ('keyword', 'razor', ${ids['personal-care']}, 90),
      ('keyword', 'moisturiser', ${ids['personal-care']}, 90),
      ('keyword', 'shower gel', ${ids['personal-care']}, 90),
      ('keyword', 'kitten', ${ids['pet-supplies']}, 90),
      ('keyword', 'puppy', ${ids['pet-supplies']}, 90),
      ('keyword', 'jigsaw', ${ids['toys-games']}, 90),
      ('keyword', 'lego', ${ids['toys-games']}, 90),
      ('keyword', 'cereal', ${ids['food-drink']}, 80),
      ('keyword', 'plant', ${ids['home']}, 80),
      ('keyword', 'hose', ${ids['home']}, 80),
      ('keyword', 'perfume', ${ids['make-up']}, 80),
      ('keyword', 'puzzle', ${ids['toys-games']}, 80),
      ('keyword', 'paint', ${ids['home']}, 70),
      ('keyword', 'tool', ${ids['home']}, 60),
      ('keyword', 'pet', ${ids['pet-supplies']}, 60),
      ('keyword', 'toy', ${ids['toys-games']}, 60);`;

/** The titles of the 29, and where each belongs. */
const CATALOGUE: Array<[string, keyof typeof ids]> = [
  ['Scottish Fine Soaps Silver Buckthorn Hand Wash 5L Refill', 'personal-care'],
  ['Colgate 360 Sonic Max White Battery Powered Toothbrush Head Refills, 4-Pack', 'personal-care'],
  ['Sonicare 7100 Electric Toothbrush, Sonic Toothbrush with App, 4 Brushing Modes', 'personal-care'],
  ['Remington Hygiene Travel Kit NE3890 – 13 Piece Grooming Set – Brand New & SEAL', 'personal-care'],
  ['WILKINSON SWORD - Intuition Perfect Finish For Women | 4-in-1', 'personal-care'],
  ['Sensodyne Repair & Protect Whitening Bundle, Toothbrush + 3 x 75 ml Toothpaste', 'personal-care'],
  ['Philips OneBlade 2x Intimate SkinProtect Blade Heads Compatible with All OneBa', 'personal-care'],
  ['TRESemme 2-in-1 Hair Dryer Brush - Airstyler with Oval Volumizing Brush & Vent', 'personal-care'],
  ['Colgate Max White LED JUMBO Teeth Whitening Kit with 2 Overnight Wands Ultimat', 'personal-care'],
  ['Sanctuary Spa Petite Retreat Gift Set Vegan Gift For Women', 'personal-care'],
  ['Janina Ultra White 75ml White Luxe Maxi White Toothpaste Natural Fruit Enzyme', 'personal-care'],

  ['Seven Seas Omega-3 Fish Oil, Max Strength with Omega 3 Vitamin D for Brain² 30', 'health-wellbeing'],
  ['Berocca Immuno Multivitamin Gummies - Immune 1 count (Pack of 60), Orange', 'health-wellbeing'],
  ['Love Mushrooms Lions Mane Liquid Drops 4000mg - 1 x 30ml Bottle in Box', 'health-wellbeing'],
  ['Seven Seas Omega-3 Fish Oil High Strength Plus Cod Liver Oil, 120 Capsules', 'health-wellbeing'],
  ['Science in Sport GO Isotonic Energy Gels Mixed Flavours 20 x 60ml BBE: 04/2026', 'health-wellbeing'],
  ['Lindens Selenium 100 mcg with Zinc 100 Tablets Trace Element Supplement UK Mad', 'health-wellbeing'],
  ['Seven Seas JointCare Plus Collagen, with Omega-3, 30 Day Pack, Red', 'health-wellbeing'],
  ['Vitabiotics Ultra Garlic Super Strength 400mg 60 Tablets', 'health-wellbeing'],

  ['Glade Electric Plug In Oil Refill Air Freshener Vanilla Blossom 20ml  x 6', 'home'],
  ['Makita D-80086 125mm Universal Dry/Wet Segmented Diamond Blade', 'home'],
  ['SteelSeries Apex 3 TKL - Gaming Keyboard - Tenkeyless Lavender, Lavender', 'home'],
  ['Canon PIXMA TS4150i Wireless All-in-one Inkjet With Cartridges Bundle', 'home'],
  ['Yankee Candle 250ml Reed Diffuser Refill Sage & Citrus', 'home'],
  ['Yankee Candle Scented Candle Magical Bright Lights Large Jar Christmas', 'home'],

  ['Bisto Gluten Free Vegan Gravy Granules 1.8kg 30/11/2026', 'food-drink'],
  ['Starbucks Pumpkin Spice Latte Dolce Gusto 72 Capsules - BB 31/08/26 - Brand Ne', 'food-drink'],

  ['Brand New Mattel Jurassic World Mussaurus Dinosaur Figure Hammond Collection', 'toys-games'],
  ['MARVEL Spidey and His Amazing Friends Spidey Team Split Racer 8.5-Inch, 3 in o', 'toys-games'],
];

beforeEach(() => {
  sql = createTestD1();
  env = { DB: sql.db } as unknown as Env;
  for (const [slug, id] of Object.entries(ids)) {
    sql.exec(`INSERT INTO categories (id, slug, name, sort_order) VALUES (${id}, '${slug}', '${slug}', ${id})`);
  }
  // The rules production already had, then the ones this change adds.
  sql.exec(PRODUCTION_RULES);
  sql.exec(readFileSync(join(__dirname, '..', 'migrations', '0019_filing_rules.sql'), 'utf8'));
});

describe('filing rules: the 29 that had no category', () => {
  it('files every one of them, and none is left unfiled', async () => {
    const rules = await loadCategoryRules(env);
    const wrong: string[] = [];
    for (const [title, slug] of CATALOGUE) {
      const got = mapCategory({ title }, rules, null);
      if (got !== ids[slug]) {
        const name = Object.entries(ids).find(([, id]) => id === got)?.[0] ?? 'nothing';
        wrong.push(`"${title.slice(0, 48)}" -> ${name}, expected ${slug}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('covers all 29', () => {
    expect(CATALOGUE).toHaveLength(29);
  });
});

describe('filing rules: what they must not break', () => {
  it('keeps a Vitamin C serum in skincare rather than Health & Wellbeing', async () => {
    const rules = await loadCategoryRules(env);
    // 'vitamin' files supplements, so skincare has to outrank it.
    expect(mapCategory({ title: 'Vitamin C Serum 30ml Brightening Face Serum' }, rules, null)).toBe(ids['personal-care']);
  });

  it('still files makeup, coffee and pet food where they were', async () => {
    const rules = await loadCategoryRules(env);
    expect(mapCategory({ title: "L'Oreal Hyaluron Tint Lip Stain Serum 485 Nude Espresso 5ml" }, rules, null)).toBe(
      ids['make-up'],
    );
    expect(mapCategory({ title: 'Lavazza Espresso Beans 1kg' }, rules, null)).toBe(ids['food-drink']);
  });

  it('leaves a title it knows nothing about unfiled rather than guessing', async () => {
    const rules = await loadCategoryRules(env);
    expect(mapCategory({ title: 'Assorted Widget 400' }, rules, null)).toBeNull();
  });

  it('can be applied twice without duplicating a rule', () => {
    const before = sql.all(`SELECT COUNT(*) AS n FROM ebay_category_map`);
    sql.exec(readFileSync(join(__dirname, '..', 'migrations', '0019_filing_rules.sql'), 'utf8'));
    expect(sql.all(`SELECT COUNT(*) AS n FROM ebay_category_map`)).toEqual(before);
  });
});

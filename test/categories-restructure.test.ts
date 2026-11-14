/**
 * Migration 0018 reshapes the shop into the seven categories the owner asked
 * for. It runs against a live catalogue, so it is tested against the real
 * production state it will meet: the nine categories as they stood, with
 * products, eBay filing rules and an account default hanging off the two that
 * retire. Nothing may be lost or left pointing at a category that is gone.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RETIRED_CATEGORY_SLUGS } from '../src/lib/db';
import { createTestD1 } from './helpers/d1';

let sql: ReturnType<typeof createTestD1>;

const MIGRATION = readFileSync(join(__dirname, '..', 'migrations', '0018_seven_categories.sql'), 'utf8');

beforeEach(() => {
  sql = createTestD1();
  // The nine categories exactly as production had them, ids included.
  sql.exec(`
    INSERT INTO categories (id, slug, name, sort_order) VALUES
      (4,  'hair-beauty',          'Hair Care',             10),
      (22, 'skin-and-body-care',   'Skin & Body Care',      20),
      (23, 'makeup-and-fragrance', 'Makeup & Fragrance',    30),
      (21, 'health-and-welfare',   'Health & Wellbeing',    40),
      (3,  'coffee-tea',           'Food & Drink',          50),
      (10, 'home-living',          'Home & Kitchen',        60),
      (6,  'diy-tools',            'DIY, Garden & Office',  70),
      (2,  'toys-games',           'Toys & Games',          80),
      (1,  'pet-food-treats',      'Pet Supplies',          90);
    INSERT INTO products (id, slug, title, price_pence, stock, category_id) VALUES
      (1, 'serum',  'Face Serum',     500, 1, 22),
      (2, 'lotion',  'Body Lotion',   500, 1, 22),
      (3, 'drill',   'Cordless Drill',500, 1, 6),
      (4, 'kettle',  'Kettle',        500, 1, 10),
      (5, 'mascara', 'Mascara',       500, 1, 23);
    INSERT INTO ebay_category_map (match_type, match_value, category_id, priority) VALUES
      ('keyword', 'serum',  22, 10),
      ('keyword', 'drill',   6, 10),
      ('keyword', 'vacuum',  6, 10),
      ('keyword', 'vacuum', 10, 10),
      ('keyword', 'kettle', 10, 10);
    INSERT INTO ebay_accounts (id, label, default_category_id) VALUES (1, 'Shop 1', 6);
  `);
});

const cats = () => sql.all('SELECT id, slug, name FROM categories ORDER BY sort_order') as Array<Record<string, unknown>>;

describe('migration 0018: seven categories', () => {
  it('leaves exactly the seven, in the order the owner asked for', () => {
    sql.exec(MIGRATION);
    expect(cats()).toEqual([
      { id: 23, slug: 'make-up', name: 'Make up' },
      { id: 4, slug: 'personal-care', name: 'Personal care' },
      { id: 21, slug: 'health-wellbeing', name: 'Health & Wellbeing' },
      { id: 3, slug: 'food-drink', name: 'Food & Drink' },
      { id: 10, slug: 'home', name: 'Home' },
      { id: 2, slug: 'toys-games', name: 'Toys & Games' },
      { id: 1, slug: 'pet-supplies', name: 'Pet Supplies' },
    ]);
  });

  it('carries every product over, and none is orphaned', () => {
    sql.exec(MIGRATION);
    expect(sql.all(`SELECT title, category_id FROM products ORDER BY id`)).toEqual([
      { title: 'Face Serum', category_id: 4 }, // Skin & Body Care -> Personal care
      { title: 'Body Lotion', category_id: 4 },
      { title: 'Cordless Drill', category_id: 10 }, // DIY, Garden & Office -> Home
      { title: 'Kettle', category_id: 10 },
      { title: 'Mascara', category_id: 23 },
    ]);
    // ON DELETE SET NULL on products.category_id is the trap this guards.
    expect(sql.all(`SELECT COUNT(*) AS n FROM products WHERE category_id IS NULL`)).toEqual([{ n: 0 }]);
  });

  it('keeps the eBay filing rules working and drops the duplicate the merge makes', () => {
    sql.exec(MIGRATION);
    // 'vacuum' existed under both DIY and Home; after the merge it is one rule.
    expect(sql.all(`SELECT match_value, category_id FROM ebay_category_map ORDER BY match_value`)).toEqual([
      { match_value: 'drill', category_id: 10 },
      { match_value: 'kettle', category_id: 10 },
      { match_value: 'serum', category_id: 4 },
      { match_value: 'vacuum', category_id: 10 },
    ]);
    // ebay_category_map cascades on delete, so a rule left on a retired
    // category would be silently destroyed and new imports would stop filing.
    expect(
      sql.all(`SELECT COUNT(*) AS n FROM ebay_category_map m
                WHERE NOT EXISTS (SELECT 1 FROM categories c WHERE c.id = m.category_id)`),
    ).toEqual([{ n: 0 }]);
  });

  it('moves an account default off a category that no longer exists', () => {
    sql.exec(MIGRATION);
    expect(sql.all(`SELECT default_category_id FROM ebay_accounts WHERE id = 1`)).toEqual([
      { default_category_id: 10 },
    ]);
  });

  it('can be applied twice without changing the result', () => {
    sql.exec(MIGRATION);
    const once = cats();
    sql.exec(MIGRATION);
    expect(cats()).toEqual(once);
  });

  it('every retired slug points at one of the seven', () => {
    sql.exec(MIGRATION);
    const live = new Set((cats() as Array<{ slug: string }>).map((c) => c.slug));
    for (const [old, now] of Object.entries(RETIRED_CATEGORY_SLUGS)) {
      expect(live.has(now), `${old} redirects to ${now}, which is not a live category`).toBe(true);
      expect(live.has(old), `${old} is retired but still a live category`).toBe(false);
    }
  });
});

describe('a fresh database', () => {
  it('is untouched by the migration, so the seed can create the seven itself', () => {
    const fresh = createTestD1();
    fresh.exec(MIGRATION);
    expect(fresh.all('SELECT COUNT(*) AS n FROM categories')).toEqual([{ n: 0 }]);
  });
});

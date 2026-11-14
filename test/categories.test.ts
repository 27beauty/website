/**
 * Deleting a category on a real SQLite database: its products, the eBay
 * sync's rules and account defaults all move to the chosen category, so the
 * next sync doesn't put the products back somewhere that no longer exists.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../src/types';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BEAUTY_CATEGORY_SLUGS, deleteCategory, queryProducts } from '../src/lib/db';
import { loadCategoryRules, mapCategory } from '../src/lib/ebay/mapping';
import { queryAdminProducts } from '../src/routes/admin/products';
import { createTestD1 } from './helpers/d1';

let env: Env;
let sql: ReturnType<typeof createTestD1>;

const count = (q: string, ...args: unknown[]) => (sql.all(q, ...args)[0] as { n: number }).n;

beforeEach(() => {
  sql = createTestD1();
  env = { DB: sql.db } as unknown as Env;
  sql.exec(`
    INSERT INTO categories (id, slug, name, sort_order) VALUES
      (1, 'make-up', 'Make up', 10),
      (2, 'coffee-tea', 'Coffee & Tea', 20),
      (3, 'snacks-sweets', 'Snacks', 30),
      (4, 'empty', 'Empty', 40);
    INSERT INTO products (id, slug, title, price_pence, stock, category_id) VALUES
      (1, 'coffee', 'Coffee', 500, 1, 2),
      (2, 'tea', 'Tea', 300, 1, 2),
      (3, 'crisps', 'Crisps', 100, 1, 3);
    INSERT INTO ebay_category_map (match_type, match_value, category_id, priority) VALUES
      ('keyword', 'coffee', 2, 10),
      ('keyword', 'tea', 2, 10),
      ('keyword', 'crisps', 3, 10);
    INSERT INTO ebay_accounts (id, label, default_category_id) VALUES (1, 'Shop 1', 2);
  `);
});

describe('deleteCategory', () => {
  it('moves products, eBay rules and account defaults into the chosen category', async () => {
    const r = await deleteCategory(env, 2, 3);
    expect(r).toEqual({ ok: true, products: 2, rules: 2 });
    expect(count('SELECT COUNT(*) AS n FROM categories WHERE id = 2')).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM products WHERE category_id = 3')).toBe(3);
    expect(count('SELECT COUNT(*) AS n FROM ebay_category_map WHERE category_id = 3')).toBe(3);
    expect(count('SELECT default_category_id AS n FROM ebay_accounts WHERE id = 1')).toBe(3);
  });

  it('refuses to delete a category with products unless told where they go', async () => {
    const r = await deleteCategory(env, 2, null);
    expect(r.ok).toBe(false);
    expect(count('SELECT COUNT(*) AS n FROM products WHERE category_id = 2')).toBe(2);
  });

  it('deletes an empty category without a target', async () => {
    expect(await deleteCategory(env, 4, null)).toEqual({ ok: true, products: 0, rules: 0 });
    expect(count('SELECT COUNT(*) AS n FROM categories WHERE id = 4')).toBe(0);
  });

  it('refuses to move into itself or into a missing category', async () => {
    expect((await deleteCategory(env, 2, 2)).ok).toBe(false);
    expect((await deleteCategory(env, 2, 99)).ok).toBe(false);
    expect(count('SELECT COUNT(*) AS n FROM products WHERE category_id = 2')).toBe(2);
  });

  it("won't delete the homepage beauty category", async () => {
    expect((await deleteCategory(env, 1, 2)).ok).toBe(false);
    expect(count('SELECT COUNT(*) AS n FROM categories WHERE id = 1')).toBe(1);
  });
});

describe('beauty across several categories', () => {
  it('lists products from any of the beauty categories', async () => {
    // Beauty spans the two lead categories of the seven: Make up (1 here) and
    // Personal care. A product outside them must not be swept in.
    sql.exec(`
      INSERT INTO categories (id, slug, name, sort_order) VALUES (5, 'personal-care', 'Personal care', 20);
      INSERT INTO products (id, slug, title, price_pence, stock, category_id) VALUES
        (10, 'shampoo', 'Shampoo', 500, 1, 5), (11, 'lotion', 'Lotion', 500, 1, 5), (12, 'mascara', 'Mascara', 500, 1, 1),
        (13, 'crisps-2', 'Sharing Crisps', 500, 1, 3);
    `);
    const { items } = await queryProducts(env, { categorySlugs: BEAUTY_CATEGORY_SLUGS, sort: 'title' });
    expect(items.map((p) => p.title)).toEqual(['Lotion', 'Mascara', 'Shampoo']);
  });
});

describe('beauty keyword rules', () => {
  it("files a lip stain called \"Espresso\" under makeup, not coffee", async () => {
    // Deliberately the pre-0018 slugs: migration 0015 was written against them
    // and joins categories on slug. At runtime rules carry a category_id, so
    // the seven-category rename did not disturb any rule already stored.
    sql.exec(`
      INSERT INTO categories (id, slug, name, sort_order) VALUES (5, 'skin-and-body-care', 'Skin & Body Care', 50), (6, 'makeup-and-fragrance', 'Makeup & Fragrance', 60);
      INSERT INTO ebay_category_map (match_type, match_value, category_id, priority) VALUES ('keyword', 'espresso', 2, 100);
    `);
    sql.exec(readFileSync(join(__dirname, '..', 'migrations', '0015_more_beauty_rules.sql'), 'utf8'));
    const rules = await loadCategoryRules(env);
    expect(mapCategory({ title: "L'Oreal Hyaluron Tint Lip Stain Serum 485 Nude Espresso 5ml" }, rules, null)).toBe(6);
    expect(mapCategory({ title: 'Philips Lumea 9900 Series, IPL Hair Removal Device' }, rules, null)).toBe(5);
    expect(mapCategory({ title: 'Lavazza Espresso Beans 1kg' }, rules, null)).toBe(2);
    expect(mapCategory({ title: 'Triple Pack Multiple Hooks' }, rules, null)).toBeNull(); // "ipl" is a word, not a substring
  });
});

describe('Admin → Products, filtering and sorting by category', () => {
  beforeEach(() => {
    // Shop order, not id order, so "sorted by category" can be told apart
    // from "sorted by id".
    sql.exec(`
      UPDATE categories SET sort_order = 10 WHERE id = 1;  -- make-up
      UPDATE categories SET sort_order = 20 WHERE id = 2;  -- coffee-tea
      UPDATE categories SET sort_order = 30 WHERE id = 3;  -- snacks
      INSERT INTO products (id, slug, title, price_pence, stock, category_id) VALUES
        (20, 'unfiled-a', 'Unfiled A', 100, 1, NULL),
        (21, 'filed-snack', 'Filed Snack', 100, 1, 3),
        (22, 'unfiled-b', 'Unfiled B', 100, 1, NULL);
    `);
  });

  it('shows only the chosen category', async () => {
    const { items, total } = await queryAdminProducts(env, { categoryId: 2, page: 1 });
    expect(items.map((p) => p.title).sort()).toEqual(['Coffee', 'Tea']);
    expect(total).toBe(2);
  });

  it('shows the products filed nowhere, which show nowhere on the shop', async () => {
    const { items, total } = await queryAdminProducts(env, { uncategorised: true, page: 1 });
    expect(items.map((p) => p.title).sort()).toEqual(['Unfiled A', 'Unfiled B']);
    expect(total).toBe(2);
  });

  it('counts every product when no category is chosen', async () => {
    const { total } = await queryAdminProducts(env, { page: 1 });
    expect(total).toBe(6);
  });

  it('groups by category in the order the shop shows them, unfiled last', async () => {
    const { items } = await queryAdminProducts(env, { sort: 'category', page: 1 });
    // SQLite sorts NULL first by default, so the unfiled ones would lead the
    // list without the explicit "(category_id IS NULL) ASC" first key.
    expect(items.map((p) => p.category_name ?? '—')).toEqual([
      'Coffee & Tea',
      'Coffee & Tea',
      'Snacks',
      'Snacks',
      '—',
      '—',
    ]);
  });

  it('keeps the category filter and the sort working together', async () => {
    const { items } = await queryAdminProducts(env, { categoryId: 3, sort: 'category', page: 1 });
    expect(items.map((p) => p.title).sort()).toEqual(['Crisps', 'Filed Snack']);
  });
});

/**
 * Deleting a category on a real SQLite database: its products, the eBay
 * sync's rules and account defaults all move to the chosen category, so the
 * next sync doesn't put the products back somewhere that no longer exists.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../src/types';
import { deleteCategory } from '../src/lib/db';
import { createTestD1 } from './helpers/d1';

let env: Env;
let sql: ReturnType<typeof createTestD1>;

const count = (q: string, ...args: unknown[]) => (sql.all(q, ...args)[0] as { n: number }).n;

beforeEach(() => {
  sql = createTestD1();
  env = { DB: sql.db } as unknown as Env;
  sql.exec(`
    INSERT INTO categories (id, slug, name, sort_order) VALUES
      (1, 'hair-beauty', 'Beauty & Personal Care', 10),
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

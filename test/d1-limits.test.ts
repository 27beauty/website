/**
 * D1 refuses a query with more than 100 bound parameters (the test database
 * enforces that too). These paths take one id per product, so they must work
 * for a catalogue bigger than 100 — the starting count failed on ~120.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../src/types';
import { dirtyListings, takeStartingStock } from '../src/lib/channels';
import { setStock } from '../src/lib/stock';
import { getProductsByIds } from '../src/lib/db';
import { createTestD1, createTestKV } from './helpers/d1';

const N = 150;
let env: Env;
let sql: ReturnType<typeof createTestD1>;

beforeEach(() => {
  sql = createTestD1();
  env = { DB: sql.db, KV: createTestKV() } as unknown as Env;
  const products = Array.from({ length: N }, (_, i) => `(${i + 1}, 'p-${i + 1}', 'Product ${i + 1}', 500, 10)`).join(',');
  const listings = Array.from(
    { length: N },
    (_, i) => `(${i + 1}, 'ebay', 'shop1', '${1000 + i}', 'Product ${i + 1}', 'linked', ${i % 7}, ${i % 7})`,
  ).join(',');
  sql.exec(`
    INSERT INTO products (id, slug, title, price_pence, stock) VALUES ${products};
    INSERT INTO channel_listings (product_id, channel, account, external_id, title, status, channel_qty, pushed_qty) VALUES ${listings};
  `);
});

const stockOf = (id: number) => (sql.all('SELECT stock FROM products WHERE id = ?', id)[0] as { stock: number }).stock;

describe('catalogues bigger than D1’s 100-parameter limit', () => {
  it('takes the starting count for every product', async () => {
    expect(await takeStartingStock(env)).toBe(N);
    expect(stockOf(1)).toBe(0);
    expect(stockOf(N)).toBe((N - 1) % 7);
    expect((sql.all(`SELECT COUNT(*) AS n FROM stock_movements WHERE reason = 'start'`)[0] as { n: number }).n).toBeGreaterThan(100);
  });

  it('sets stock for 150 products at once (bulk edit, CSV import)', async () => {
    const moved = await setStock(env, Array.from({ length: N }, (_, i) => ({ productId: i + 1, quantity: 3 })), 'admin');
    expect(moved).toHaveLength(N);
    expect(stockOf(N)).toBe(3);
  });

  it('finds listings to update for 150 changed products', async () => {
    const dirty = await dirtyListings(env, Array.from({ length: N }, (_, i) => i + 1));
    expect(dirty.length).toBeGreaterThan(100);
  });

  it('loads 150 products by id, in order', async () => {
    const ids = Array.from({ length: N }, (_, i) => N - i);
    const products = await getProductsByIds(env, ids);
    expect(products.map((p) => p.id)).toEqual(ids);
  });
});

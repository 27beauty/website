/**
 * Ended and relisted eBay listings, through the real sync on a real SQLite
 * database. eBay's Browse API is faked at fetch(): `live` is what the
 * keyword search returns, `exists` is what a per-item lookup can still find.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';
import { runEbaySync } from '../src/lib/ebay/sync';
import { createTestD1, createTestKV } from './helpers/d1';

interface Listing {
  itemId: string;
  title: string;
}

let env: Env;
let sql: ReturnType<typeof createTestD1>;
let live: Listing[];
let exists: Set<string>;

const summary = (l: Listing) => ({
  itemId: l.itemId,
  title: l.title,
  price: { value: '5.00', currency: 'GBP' },
  estimatedAvailabilities: [{ estimatedAvailabilityStatus: 'IN_STOCK' }],
  itemWebUrl: `https://www.ebay.co.uk/itm/${l.itemId}`,
});

function installFakeEbay() {
  vi.stubGlobal('fetch', async (input: string) => {
    const url = new URL(input);
    if (url.pathname === '/identity/v1/oauth2/token') return Response.json({ access_token: 'app', expires_in: 7200 });
    if (url.pathname === '/buy/browse/v1/item_summary/search') {
      return Response.json({ itemSummaries: url.searchParams.get('offset') === '0' ? live.map(summary) : [] });
    }
    if (url.pathname.startsWith('/buy/browse/v1/item/')) {
      const id = decodeURIComponent(url.pathname.slice('/buy/browse/v1/item/'.length));
      if (!exists.has(id)) return Response.json({ errors: [{ errorId: 11001 }] }, { status: 404 });
      return Response.json({ itemId: id, description: 'desc' });
    }
    return new Response('unexpected', { status: 500 });
  });
}

const products = () =>
  sql.all('SELECT id, title, status, ebay_item_id, merged_into, category_id FROM products ORDER BY id') as Array<{
    id: number;
    title: string;
    status: string;
    ebay_item_id: string | null;
    merged_into: number | null;
    category_id: number | null;
  }>;

beforeEach(() => {
  sql = createTestD1();
  env = { DB: sql.db, KV: createTestKV(), EBAY_CLIENT_ID: 'app', EBAY_CLIENT_SECRET: 'cert' } as unknown as Env;
  sql.exec(`
    INSERT INTO settings (key, value) VALUES ('ebay.sync_enabled', 'true');
    INSERT INTO categories (id, slug, name) VALUES (7, 'health', 'Health & Wellbeing');
    INSERT INTO ebay_accounts (id, label, seller_username, mode) VALUES (1, 'Shop 1', 'shop1', 'browse');
  `);
  live = [];
  exists = new Set();
  installFakeEbay();
});

afterEach(() => vi.unstubAllGlobals());

async function importOne(itemId: string, title: string): Promise<void> {
  live = [{ itemId, title }];
  exists = new Set([itemId]);
  await runEbaySync(env, 'manual');
}

describe('eBay sync: ended listings', () => {
  it('takes a product off the shop once eBay confirms its listing has ended', async () => {
    await importOne('v1|100|0', 'Vitamin D 1000iu 90 Tablets');
    live = [];
    exists = new Set();
    const r = await runEbaySync(env, 'manual');
    expect(r.ended).toBe(1);
    expect(products()[0].status).toBe('archived');
  });

  it('leaves a product alone when the search missed it but the listing is still live', async () => {
    await importOne('v1|100|0', 'Vitamin D 1000iu 90 Tablets');
    live = [];
    const r = await runEbaySync(env, 'manual');
    expect(r.ended).toBe(0);
    expect(products()[0].status).toBe('active');
  });

  it('moves a relisted item onto the same product instead of creating a duplicate', async () => {
    await importOne('v1|100|0', 'Vitamin D 1000iu 90 Tablets');
    sql.exec(`UPDATE products SET category_id = 7`); // the owner's own choice
    live = [{ itemId: 'v1|200|0', title: 'Vitamin D 1000iu 90 Tablets' }];
    exists = new Set(['v1|200|0']);
    await runEbaySync(env, 'manual');

    const rows = products();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'active', ebay_item_id: 'v1|200|0', category_id: 7 });
  });

  it('folds a duplicate made by an earlier relist back into the original product', async () => {
    await importOne('v1|100|0', 'Vitamin D 1000iu 90 Tablets');
    // The old behaviour: the relist became a second product and the ended one stayed up.
    sql.exec(`
      INSERT INTO products (id, slug, title, price_pence, stock, source, ebay_item_id, ebay_account)
      VALUES (2, 'vitamin-d-2', 'Vitamin D 1000iu 90 Tablets', 500, 3, 'ebay', 'v1|200|0', 'shop1');
      INSERT INTO coupons (code, value, product_id) VALUES ('VITD', 10, 2);
    `);
    live = [{ itemId: 'v1|200|0', title: 'Vitamin D 1000iu 90 Tablets' }];
    exists = new Set(['v1|200|0']);
    await runEbaySync(env, 'manual');

    const [original, duplicate] = products();
    expect(original).toMatchObject({ id: 1, status: 'active', ebay_item_id: 'v1|200|0' });
    expect(duplicate).toMatchObject({ id: 2, status: 'archived', ebay_item_id: null, merged_into: 1 });
    expect(sql.all(`SELECT product_id FROM coupons WHERE code = 'VITD'`)[0]).toEqual({ product_id: 1 });
  });

  it('keeps an item that was merged with its relist on the shop (instead of archiving both)', async () => {
    await importOne('v1|100|0', 'Vitamin D 1000iu 90 Tablets');
    // Centralised stock merged the relist into the original, which still points at the ended listing.
    sql.exec(`
      INSERT INTO products (id, slug, title, price_pence, stock, source, ebay_item_id, ebay_account, status, merged_into)
      VALUES (2, 'vitamin-d-2', 'Vitamin D 1000iu 90 Tablets', 500, 3, 'ebay', 'v1|200|0', 'shop1', 'archived', 1);
    `);
    live = [{ itemId: 'v1|200|0', title: 'Vitamin D 1000iu 90 Tablets' }];
    exists = new Set(['v1|200|0']);
    await runEbaySync(env, 'manual');

    expect(products()[0]).toMatchObject({ id: 1, status: 'active', ebay_item_id: 'v1|200|0' });
  });

  it('brings an archived product back when the item is listed again later', async () => {
    await importOne('v1|100|0', 'Vitamin D 1000iu 90 Tablets');
    live = [];
    exists = new Set();
    await runEbaySync(env, 'manual');
    expect(products()[0].status).toBe('archived');

    live = [{ itemId: 'v1|300|0', title: 'Vitamin D 1000iu 90 Tablets' }];
    exists = new Set(['v1|300|0']);
    await runEbaySync(env, 'manual');
    const rows = products();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'active', ebay_item_id: 'v1|300|0' });
  });

  it('does not treat a different size as a relist', async () => {
    await importOne('v1|100|0', 'Vitamin D 1000iu 90 Tablets');
    live = [{ itemId: 'v1|200|0', title: 'Vitamin D 1000iu 180 Tablets' }];
    exists = new Set(['v1|200|0']);
    await runEbaySync(env, 'manual');
    const rows = products();
    expect(rows).toHaveLength(2);
    expect(rows[0].status).toBe('archived');
    expect(rows[1]).toMatchObject({ status: 'active', ebay_item_id: 'v1|200|0' });
  });
});

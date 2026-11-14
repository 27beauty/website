/**
 * The sync must not rewrite listings that have not changed. eBay re-reports
 * every live listing on every run; before this, each run rewrote all of them,
 * which cost thousands of pointless D1 writes a day and left
 * products.updated_at always reading as "changed moments ago".
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

const stamps = () =>
  sql.all('SELECT id, updated_at, ebay_synced_at FROM products ORDER BY id') as Array<{
    id: number;
    updated_at: string;
    ebay_synced_at: string;
  }>;

describe('eBay sync: unchanged listings', () => {
  beforeEach(() => {
    live = [{ itemId: '111', title: 'Vitamin C Serum 30ml' }];
    exists = new Set(['111']);
  });

  it('does not rewrite a product when eBay reports the same listing again', async () => {
    const first = await runEbaySync(env, 'manual');
    expect(first.created).toBe(1);

    const before = stamps();
    // Push updated_at back so any rewrite this run makes is visible.
    sql.exec(`UPDATE products SET updated_at = '2020-01-01 00:00:00', ebay_synced_at = '2020-01-01 00:00:00'`);

    const second = await runEbaySync(env, 'manual');
    expect(second.updated).toBe(0);
    expect(second.created).toBe(0);
    // Content untouched...
    expect(stamps()[0].updated_at).toBe('2020-01-01 00:00:00');
    // ...but "last confirmed" is refreshed, since it was over an hour old and
    // it orders the ended-listing checks.
    expect(stamps()[0].ebay_synced_at).not.toBe('2020-01-01 00:00:00');
    expect(before[0].id).toBe(stamps()[0].id);
  });

  it('leaves the confirmation stamp alone when it was refreshed within the hour', async () => {
    await runEbaySync(env, 'manual');
    const after = stamps()[0];
    const second = await runEbaySync(env, 'manual');
    expect(second.updated).toBe(0);
    // Nothing at all was written for this product on the second run.
    expect(stamps()[0]).toEqual(after);
  });

  it('still writes the product when something about the listing really changed', async () => {
    await runEbaySync(env, 'manual');
    sql.exec(`UPDATE products SET updated_at = '2020-01-01 00:00:00'`);

    live = [{ itemId: '111', title: 'Vitamin C Serum 30ml — new formula' }];
    const second = await runEbaySync(env, 'manual');
    expect(second.updated).toBe(1);
    expect(sql.all(`SELECT title FROM products`)).toEqual([{ title: 'Vitamin C Serum 30ml — new formula' }]);
    expect(stamps()[0].updated_at).not.toBe('2020-01-01 00:00:00');
  });
});

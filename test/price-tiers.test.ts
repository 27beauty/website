/**
 * Price bands for eBay items: a set amount off the eBay price by band, and
 * the owner's own price on a product page always winning.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';
import { normalisePriceTiers, tierDiscountPence, websitePriceFromEbay, type PriceTier } from '../src/lib/money';
import { runEbaySync } from '../src/lib/ebay/sync';
import { priceLockAfterEdit } from '../src/routes/admin/products';
import { createTestD1, createTestKV } from './helpers/d1';

const TIERS: PriceTier[] = [
  { underPence: 1000, offPence: 70 },
  { underPence: 600, offPence: 40 },
  { underPence: null, offPence: 100 },
];

describe('price bands', () => {
  const tiers = normalisePriceTiers(TIERS);

  it('sorts bands by threshold with the catch-all last', () => {
    expect(tiers.map((t) => t.underPence)).toEqual([600, 1000, null]);
  });

  it('takes off the amount for the first band the eBay price is under', () => {
    expect(tierDiscountPence(599, tiers)).toBe(40);
    expect(tierDiscountPence(600, tiers)).toBe(70); // "under £6" means below £6.00
    expect(tierDiscountPence(999, tiers)).toBe(70);
    expect(tierDiscountPence(1000, tiers)).toBe(100);
  });

  it('charges the eBay price when there is no catch-all above the last band', () => {
    const noCatchAll = normalisePriceTiers(TIERS.slice(0, 2));
    expect(websitePriceFromEbay(2500, 0, noCatchAll)).toBe(2500);
  });

  it('works out the website price, never below 1p', () => {
    expect(websitePriceFromEbay(599, 0, tiers)).toBe(559);
    expect(websitePriceFromEbay(899, 0, tiers)).toBe(829);
    expect(websitePriceFromEbay(30, 0, tiers)).toBe(1);
  });

  it('ignores junk read back from settings', () => {
    expect(normalisePriceTiers('nope')).toEqual([]);
    expect(normalisePriceTiers([{ underPence: 600, offPence: 0 }, null, { underPence: -5, offPence: 10 }])).toEqual([]);
  });
});

describe('priceLockAfterEdit', () => {
  it('locks the price when the owner changes it', () => {
    expect(priceLockAfterEdit({ price_locked: 0, price_pence: 599 }, false, 549)).toBe(true);
  });
  it('leaves it to the sync when the price is unchanged and the box is unticked', () => {
    expect(priceLockAfterEdit({ price_locked: 0, price_pence: 599 }, false, 599)).toBe(false);
  });
  it('unlocks when the owner unticks an existing lock', () => {
    expect(priceLockAfterEdit({ price_locked: 1, price_pence: 599 }, false, 549)).toBe(false);
  });
});

describe('eBay sync with price bands', () => {
  let env: Env;
  let sql: ReturnType<typeof createTestD1>;
  let listings: { itemId: string; title: string; price: string }[];

  beforeEach(() => {
    sql = createTestD1();
    env = { DB: sql.db, KV: createTestKV(), EBAY_CLIENT_ID: 'app', EBAY_CLIENT_SECRET: 'cert' } as unknown as Env;
    sql.exec(`
      INSERT INTO settings (key, value) VALUES
        ('ebay.sync_enabled', 'true'),
        ('ebay.price_tiers', '${JSON.stringify(TIERS)}');
      INSERT INTO ebay_accounts (id, label, seller_username, mode) VALUES (1, 'Shop 1', 'shop1', 'browse');
    `);
    listings = [
      { itemId: 'v1|1|0', title: 'Hand Cream 50ml', price: '5.99' },
      { itemId: 'v1|2|0', title: 'Shampoo 400ml', price: '8.99' },
    ];
    vi.stubGlobal('fetch', async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/identity/v1/oauth2/token') return Response.json({ access_token: 'app', expires_in: 7200 });
      if (url.pathname === '/buy/browse/v1/item_summary/search') {
        const page = url.searchParams.get('offset') === '0' ? listings : [];
        return Response.json({
          itemSummaries: page.map((l) => ({
            itemId: l.itemId,
            title: l.title,
            price: { value: l.price, currency: 'GBP' },
            estimatedAvailabilities: [{ estimatedAvailabilityStatus: 'IN_STOCK' }],
          })),
        });
      }
      if (url.pathname.startsWith('/buy/browse/v1/item/')) return Response.json({ description: 'desc' });
      return new Response('unexpected', { status: 500 });
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  const prices = () => sql.all('SELECT title, price_pence FROM products ORDER BY id').map((r) => r.price_pence);

  it('prices new and existing eBay items by band, but leaves a locked price alone', async () => {
    await runEbaySync(env, 'manual');
    expect(prices()).toEqual([559, 829]);

    sql.exec(`UPDATE products SET price_pence = 500, price_locked = 1 WHERE ebay_item_id = 'v1|1|0'`);
    listings[1].price = '9.49';
    await runEbaySync(env, 'manual');
    expect(prices()).toEqual([500, 879]);
  });
});

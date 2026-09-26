/**
 * The eBay sync uses Workers Free's whole outbound-request allowance, and no
 * more: descriptions arrive for every product over a few runs, existing ones
 * are never wiped, and eBay's HTML becomes readable text.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';
import { runEbaySync } from '../src/lib/ebay/sync';
import { htmlToText } from '../src/lib/util';
import { createTestD1, createTestKV } from './helpers/d1';

/** Workers Free allows 50 outbound requests per invocation. */
const WORKERS_FREE_SUBREQUESTS = 50;

let env: Env;
let sql: ReturnType<typeof createTestD1>;
let live: { itemId: string; title: string }[];
let requests: number;
let detailCalls: string[];

beforeEach(() => {
  sql = createTestD1();
  env = { DB: sql.db, KV: createTestKV(), EBAY_CLIENT_ID: 'app', EBAY_CLIENT_SECRET: 'cert' } as unknown as Env;
  sql.exec(`
    INSERT INTO settings (key, value) VALUES ('ebay.sync_enabled', 'true');
    INSERT INTO ebay_accounts (id, label, seller_username, mode) VALUES
      (1, 'Shop 1', 'shop1', 'browse'),
      (2, 'Shop 2', 'shop2', 'browse');
  `);
  live = [];
  requests = 0;
  detailCalls = [];
  vi.stubGlobal('fetch', async (input: string) => {
    requests++;
    const url = new URL(input);
    if (url.pathname === '/identity/v1/oauth2/token') return Response.json({ access_token: 'app', expires_in: 7200 });
    if (url.pathname === '/buy/browse/v1/item_summary/search') {
      const seller = /sellers:\{([^}]+)\}/.exec(url.searchParams.get('filter') ?? '')?.[1];
      const mine = live.filter((l) => l.itemId.startsWith(seller === 'shop1' ? 'v1|1' : 'v1|2'));
      return Response.json({
        itemSummaries: (url.searchParams.get('offset') === '0' ? mine : []).map((l) => ({
          itemId: l.itemId,
          title: l.title,
          price: { value: '5.00', currency: 'GBP' },
          estimatedAvailabilities: [{ estimatedAvailabilityStatus: 'IN_STOCK' }],
        })),
      });
    }
    if (url.pathname.startsWith('/buy/browse/v1/item/')) {
      const id = decodeURIComponent(url.pathname.slice('/buy/browse/v1/item/'.length));
      detailCalls.push(id);
      return Response.json({ itemId: id, description: `<div><style>.x{}</style><p>About ${id}</p><ul><li>Point</li></ul></div>` });
    }
    return new Response('unexpected', { status: 500 });
  });
});

afterEach(() => vi.unstubAllGlobals());

const listing = (shop: 1 | 2, n: number) => ({ itemId: `v1|${shop}${String(n).padStart(3, '0')}|0`, title: `Shop ${shop} item number ${n}` });
const described = () =>
  (sql.all(`SELECT COUNT(*) AS n FROM products WHERE description IS NOT NULL AND description != ''`)[0] as { n: number }).n;

describe('eBay sync request budget', () => {
  it('stays inside Workers Free, and gives every product a description over later runs', async () => {
    live = [...Array.from({ length: 40 }, (_, i) => listing(1, i)), ...Array.from({ length: 40 }, (_, i) => listing(2, i))];

    await runEbaySync(env, 'manual');
    expect(requests).toBeLessThanOrEqual(WORKERS_FREE_SUBREQUESTS);
    const afterFirst = described();
    expect(afterFirst).toBeGreaterThan(20); // more than the old 10-per-shop cap
    // Both shops got a share.
    expect(detailCalls.some((id) => id.startsWith('v1|1'))).toBe(true);
    expect(detailCalls.some((id) => id.startsWith('v1|2'))).toBe(true);

    for (let run = 0; run < 5 && described() < 80; run++) {
      requests = 0;
      await runEbaySync(env, 'manual');
      expect(requests).toBeLessThanOrEqual(WORKERS_FREE_SUBREQUESTS);
    }
    expect(described()).toBe(80);
  });

  it("never wipes a description when a run doesn't fetch the item's details", async () => {
    live = [listing(1, 1)];
    await runEbaySync(env, 'manual');
    const before = sql.all(`SELECT description FROM products`)[0] as { description: string };
    expect(before.description).toContain('About v1|1001|0');

    detailCalls = [];
    await runEbaySync(env, 'manual');
    expect(detailCalls).toEqual([]); // already has one, so no request spent on it
    expect((sql.all(`SELECT description FROM products`)[0] as { description: string }).description).toBe(before.description);
  });
});

describe('htmlToText', () => {
  it('turns an eBay HTML description into readable text', () => {
    const html =
      '<html><head><title>x</title><style>p{color:red}</style></head><body><h2>Hair oil</h2><p>Smooth &amp; shiny&nbsp;finish.</p>' +
      '<ul><li>70ml</li><li>Made in Japan</li></ul><script>alert(1)</script><p>Price &pound;5 &#8211; ships fast</p></body></html>';
    expect(htmlToText(html)).toBe('Hair oil\nSmooth & shiny finish.\n\n• 70ml\n• Made in Japan\n\nPrice £5 – ships fast');
  });

  it('handles empty input', () => {
    expect(htmlToText(null)).toBe('');
    expect(htmlToText('<div> </div>')).toBe('');
  });
});

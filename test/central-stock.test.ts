/**
 * End-to-end check of centralised stock on a real SQLite database with every
 * migration applied. eBay and Amazon are faked at the fetch() boundary, so
 * this runs the real SQL and the real orchestration in src/lib/channels.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EbayAccount, Env } from '../src/types';
import { encryptSecret } from '../src/lib/crypto';
import { adjustStock, setStock } from '../src/lib/stock';
import {
  Budget,
  dirtyListings,
  enableCentralStock,
  ensureEbayListingRows,
  importAmazonListings,
  importEbayListings,
  mergeDuplicateProducts,
  pushDirty,
  readiness,
  resolveListing,
  runStockJob,
  takeStartingStock,
} from '../src/lib/channels';
import { createTestD1, createTestKV } from './helpers/d1';

const SECRET = 'test-session-secret-0123456789abcdef';
const SELLER = 'A2SELLERTEST';

// ---------------------------------------------------------------------------
// Fake marketplaces
// ---------------------------------------------------------------------------

interface EbayListingFixture {
  itemId: string;
  title: string;
  qty: number;
}

interface FakeWorld {
  ebayListings: Record<string, EbayListingFixture[]>; // by seller
  ebayOrders: Record<string, unknown[]>; // by seller
  amazonListings: unknown[];
  amazonOrders: unknown[];
  amazonItems: Record<string, unknown[]>;
  revised: { seller: string; itemId: string; quantity: number }[];
  amazonPatched: { sku: string; quantity: number }[];
}

const TOKEN_TO_SELLER: Record<string, string> = { 'at-aisha': 'aisha-4515', 'at-adinath': 'adinath0' };

function activeListXml(listings: EbayListingFixture[]): string {
  const items = listings
    .map((l) => `<Item><ItemID>${l.itemId}</ItemID><Title>${l.title.replace(/&/g, '&amp;')}</Title><Quantity>${l.qty + 1}</Quantity><QuantityAvailable>${l.qty}</QuantityAvailable><SellingStatus><QuantitySold>1</QuantitySold></SellingStatus></Item>`)
    .join('');
  return `<?xml version="1.0"?><GetMyeBaySellingResponse><Ack>Success</Ack><ActiveList><ItemArray>${items}</ItemArray><PaginationResult><TotalNumberOfPages>1</TotalNumberOfPages></PaginationResult></ActiveList></GetMyeBaySellingResponse>`;
}

function installFakeFetch(world: FakeWorld) {
  vi.stubGlobal('fetch', async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    const headers = new Headers(init.headers);
    const body = typeof init.body === 'string' ? init.body : '';

    if (url.href === 'https://api.ebay.com/identity/v1/oauth2/token') {
      const rt = new URLSearchParams(body).get('refresh_token');
      return Response.json({ access_token: rt === 'rt-aisha' ? 'at-aisha' : 'at-adinath', expires_in: 7200 });
    }
    if (url.href === 'https://api.ebay.com/ws/api.dll') {
      const seller = TOKEN_TO_SELLER[headers.get('X-EBAY-API-IAF-TOKEN') ?? ''];
      const call = headers.get('X-EBAY-API-CALL-NAME');
      if (call === 'GetMyeBaySelling') return new Response(activeListXml(world.ebayListings[seller] ?? []));
      if (call === 'ReviseInventoryStatus') {
        const echoed = [...body.matchAll(/<InventoryStatus><ItemID>(\d+)<\/ItemID><Quantity>(\d+)<\/Quantity><\/InventoryStatus>/g)];
        for (const m of echoed) world.revised.push({ seller, itemId: m[1], quantity: Number(m[2]) });
        return new Response(
          `<ReviseInventoryStatusResponse><Ack>Success</Ack>${echoed.map((m) => `<InventoryStatus><ItemID>${m[1]}</ItemID><Quantity>${m[2]}</Quantity></InventoryStatus>`).join('')}</ReviseInventoryStatusResponse>`,
        );
      }
    }
    if (url.origin + url.pathname === 'https://api.ebay.com/sell/fulfillment/v1/order') {
      const seller = TOKEN_TO_SELLER[(headers.get('Authorization') ?? '').replace('Bearer ', '')];
      return Response.json({ orders: world.ebayOrders[seller] ?? [] });
    }
    if (url.href === 'https://api.amazon.com/auth/o2/token') return Response.json({ access_token: 'amz-at', expires_in: 3600 });
    if (url.host === 'sellingpartnerapi-eu.amazon.com') {
      if (url.pathname === `/listings/2021-08-01/items/${SELLER}` && (init.method ?? 'GET') === 'GET') {
        return Response.json({ items: world.amazonListings });
      }
      if (url.pathname.startsWith(`/listings/2021-08-01/items/${SELLER}/`) && init.method === 'PATCH') {
        const sku = decodeURIComponent(url.pathname.split('/').pop() as string);
        const qty = JSON.parse(body).patches[0].value[0].quantity as number;
        world.amazonPatched.push({ sku, quantity: qty });
        return Response.json({ sku, status: 'ACCEPTED', issues: [] });
      }
      if (url.pathname === '/orders/v0/orders') return Response.json({ payload: { Orders: world.amazonOrders } });
      const items = /^\/orders\/v0\/orders\/([^/]+)\/orderItems$/.exec(url.pathname);
      if (items) return Response.json({ payload: { OrderItems: world.amazonItems[items[1]] ?? [] } });
    }
    return new Response(`unexpected ${init.method ?? 'GET'} ${url.href}`, { status: 500 });
  });
}

// ---------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------

let env: Env;
let sql: ReturnType<typeof createTestD1>;
let world: FakeWorld;

const stockOf = (id: number) => (sql.all('SELECT stock FROM products WHERE id = ?', id)[0] as { stock: number }).stock;
const accounts = () => sql.all('SELECT * FROM ebay_accounts ORDER BY id') as unknown as EbayAccount[];

beforeEach(async () => {
  sql = createTestD1();
  env = {
    DB: sql.db,
    KV: createTestKV(),
    SESSION_SECRET: SECRET,
    SITE_NAME: '27beauty',
    EBAY_CLIENT_ID: 'app',
    EBAY_CLIENT_SECRET: 'cert',
    AMAZON_LWA_CLIENT_ID: 'amzn1.application-oa2-client.x',
    AMAZON_LWA_CLIENT_SECRET: 's',
    AMAZON_REFRESH_TOKEN: 'r',
    AMAZON_SELLER_ID: SELLER,
  } as unknown as Env;

  const encAisha = await encryptSecret('rt-aisha', SECRET);
  const encAdinath = await encryptSecret('rt-adinath', SECRET);
  sql.exec(`
    INSERT INTO ebay_accounts (id, label, seller_username, mode, refresh_token_enc) VALUES
      (1, 'Shop 1 (aisha-4515)', 'aisha-4515', 'browse', '${encAisha}'),
      (2, 'Shop 2 (adinath0)', 'adinath0', 'browse', '${encAdinath}');
    INSERT INTO products (id, slug, title, price_pence, stock, source, ebay_item_id, ebay_account) VALUES
      (1, 'tuna', 'Dreamies Catisfactions Tuna 6 x 200g 1.2kg Total', 1299, 10, 'ebay', 'v1|111|0', 'adinath0'),
      (2, 'tuna-2', 'Dreamies Catisfactions Tuna 6 x 200g 1.2kg Total', 1299, 10, 'ebay', 'v1|222|0', 'adinath0'),
      (3, 'tsubaki', '(TSUBAKI) Premium Moist & Repair Conditioner 450mL', 899, 10, 'ebay', 'v1|333|0', 'aisha-4515'),
      (4, 'pukka', 'Pukka Peace Organic Herbal Tea 20 Tea Bags Sachets', 499, 10, 'ebay', 'v1|444|0', 'aisha-4515');
  `);

  world = {
    ebayListings: {
      adinath0: [
        { itemId: '111', title: 'Dreamies Catisfactions Tuna 6 x 200g 1.2kg Total', qty: 5 },
        { itemId: '222', title: 'Dreamies Catisfactions Tuna 6 x 200g 1.2kg Total', qty: 5 },
      ],
      'aisha-4515': [
        { itemId: '333', title: '(TSUBAKI) Premium Moist & Repair Conditioner 450mL', qty: 3 },
        { itemId: '444', title: 'Pukka Peace Organic Herbal Tea 20 Tea Bags Sachets', qty: 7 },
      ],
    },
    ebayOrders: {},
    amazonListings: [
      {
        sku: 'AMZ-TSU',
        summaries: [{ marketplaceId: 'A1F83G8C2ARO7P', asin: 'B01', itemName: 'TSUBAKI Premium Moist and Repair Conditioner 450 ml' }],
        fulfillmentAvailability: [{ fulfillmentChannelCode: 'DEFAULT', quantity: 2 }],
      },
      {
        sku: 'AMZ-PUK4',
        summaries: [{ marketplaceId: 'A1F83G8C2ARO7P', asin: 'B02', itemName: 'Pukka Peace Organic Herbal Tea 4 x 20 Tea Bags' }],
        fulfillmentAvailability: [{ fulfillmentChannelCode: 'DEFAULT', quantity: 4 }],
      },
      {
        sku: 'AMZ-FBA',
        summaries: [{ marketplaceId: 'A1F83G8C2ARO7P', asin: 'B03', itemName: 'Dreamies Catisfactions Tuna 6 x 200g 1.2kg Total' }],
        fulfillmentAvailability: [{ fulfillmentChannelCode: 'AMAZON_EU', quantity: 40 }],
      },
    ],
    amazonOrders: [],
    amazonItems: {},
    revised: [],
    amazonPatched: [],
  };
  installFakeFetch(world);
});

afterEach(() => vi.unstubAllGlobals());

/** Connect both shops + Amazon, clear the review list, take the count, switch on. */
async function goLive() {
  await ensureEbayListingRows(env);
  await mergeDuplicateProducts(env);
  for (const a of accounts()) await importEbayListings(env, a, new Budget(40));
  await importAmazonListings(env, new Budget(40));
  for (const r of sql.all(`SELECT id FROM channel_listings WHERE status = 'review'`) as { id: number }[]) {
    await resolveListing(env, r.id, { type: 'ignore' });
  }
  await takeStartingStock(env);
  await enableCentralStock(env);
}

// ---------------------------------------------------------------------------

describe('setting up', () => {
  it('merges the same item listed twice into one product, keeping both listings', async () => {
    await ensureEbayListingRows(env);
    expect(await mergeDuplicateProducts(env)).toBe(1);
    expect(sql.all('SELECT merged_into, status FROM products WHERE id = 2')[0]).toEqual({ merged_into: 1, status: 'archived' });
    expect(sql.all(`SELECT external_id FROM channel_listings WHERE product_id = 1 ORDER BY external_id`)).toEqual([
      { external_id: '111' },
      { external_id: '222' },
    ]);
  });

  it('links confident Amazon matches, holds back pack-size lookalikes, and marks FBA', async () => {
    await ensureEbayListingRows(env);
    await mergeDuplicateProducts(env);
    await importAmazonListings(env, new Budget(40));
    const rows = sql.all(`SELECT external_id, product_id, status, fulfilment FROM channel_listings WHERE channel = 'amazon' ORDER BY external_id`);
    expect(rows).toEqual([
      { external_id: 'AMZ-FBA', product_id: 1, status: 'linked', fulfilment: 'amazon' },
      { external_id: 'AMZ-PUK4', product_id: null, status: 'review', fulfilment: 'merchant' },
      { external_id: 'AMZ-TSU', product_id: 3, status: 'linked', fulfilment: 'merchant' },
    ]);
  });

  it("won't switch on until every listing is reviewed and the starting count is taken", async () => {
    await ensureEbayListingRows(env);
    for (const a of accounts()) await importEbayListings(env, a, new Budget(40));
    await importAmazonListings(env, new Budget(40));
    await expect(enableCentralStock(env)).rejects.toThrow();
    expect((await readiness(env)).toReview).toBe(1);
  });

  it('takes the starting count from the live listings — the higher one when listed twice', async () => {
    await goLive();
    expect(stockOf(1)).toBe(5); // 111 and 222 both show 5: one shelf, not ten
    expect(stockOf(3)).toBe(3); // eBay 3 vs Amazon FBM 2 → 3
    expect(stockOf(4)).toBe(7);
    // Every listing already shows its number except Amazon's Tsubaki (2 ≠ 3).
    expect((await dirtyListings(env)).map((d) => d.external_id)).toEqual(['AMZ-TSU']);
  });
});

describe('once switched on', () => {
  beforeEach(goLive);

  it('an eBay sale comes off once, however often the order is read, and every other listing follows', async () => {
    world.ebayOrders.adinath0 = [
      {
        orderId: '12-111',
        lastModifiedDate: '2099-01-01T00:00:00.000Z',
        orderPaymentStatus: 'PAID',
        cancelStatus: { cancelState: 'NONE_REQUESTED' },
        lineItems: [{ lineItemId: 'L1', legacyItemId: '111', quantity: 2, title: 'Dreamies' }],
      },
    ];
    const now = new Date('2099-01-01T00:30:00Z');
    await runStockJob(env, now);
    await runStockJob(env, now);
    expect(stockOf(1)).toBe(3);
    expect(sql.all(`SELECT COUNT(*) AS n FROM stock_movements WHERE reason = 'ebay_sale'`)).toEqual([{ n: 1 }]);
    // eBay already dropped listing 111 when it sold, so only the item's other
    // listing needs setting to 3. FBA is never touched.
    expect(world.revised.filter((r) => ['111', '222'].includes(r.itemId))).toEqual([
      { seller: 'adinath0', itemId: '222', quantity: 3 },
    ]);
    expect(sql.all(`SELECT external_id, pushed_qty FROM channel_listings WHERE product_id = 1 AND channel = 'ebay' ORDER BY external_id`)).toEqual([
      { external_id: '111', pushed_qty: 3 },
      { external_id: '222', pushed_qty: 3 },
    ]);
    expect(world.amazonPatched.find((p) => p.sku === 'AMZ-FBA')).toBeUndefined();
  });

  it('a cancelled eBay order puts the stock back exactly once', async () => {
    const order = (state: string) => ({
      orderId: '12-222',
      lastModifiedDate: '2099-01-01T00:00:00.000Z',
      orderPaymentStatus: 'PAID',
      cancelStatus: { cancelState: state },
      lineItems: [{ lineItemId: 'L9', legacyItemId: '444', quantity: 1, title: 'Pukka' }],
    });
    world.ebayOrders['aisha-4515'] = [order('NONE_REQUESTED')];
    await runStockJob(env, new Date('2099-01-01T00:30:00Z'));
    expect(stockOf(4)).toBe(6);
    world.ebayOrders['aisha-4515'] = [order('CANCELED')];
    await runStockJob(env, new Date('2099-01-01T00:35:00Z'));
    await runStockJob(env, new Date('2099-01-01T00:40:00Z'));
    expect(stockOf(4)).toBe(7);
  });

  it('an Amazon FBM sale comes off and updates eBay; FBA orders are ignored', async () => {
    world.amazonOrders = [
      { AmazonOrderId: '202-1', OrderStatus: 'Unshipped', FulfillmentChannel: 'MFN', LastUpdateDate: '2099-01-01T00:00:00Z' },
      { AmazonOrderId: '202-2', OrderStatus: 'Shipped', FulfillmentChannel: 'AFN', LastUpdateDate: '2099-01-01T00:00:00Z' },
    ];
    world.amazonItems['202-1'] = [{ OrderItemId: 'OI1', SellerSKU: 'AMZ-TSU', QuantityOrdered: 1 }];
    world.amazonItems['202-2'] = [{ OrderItemId: 'OI2', SellerSKU: 'AMZ-FBA', QuantityOrdered: 5 }];
    await runStockJob(env, new Date('2099-01-01T00:30:00Z'));
    expect(stockOf(3)).toBe(2);
    expect(stockOf(1)).toBe(5);
    expect(world.revised).toContainEqual({ seller: 'aisha-4515', itemId: '333', quantity: 2 });
    expect(world.amazonPatched).toContainEqual({ sku: 'AMZ-TSU', quantity: 2 });
  });

  it('a website sale and an admin edit are sent to every linked listing', async () => {
    const moved = await adjustStock(env, [{ productId: 4, delta: -1, reason: 'website_sale', ref: 'order:9:1' }]);
    await pushDirty(env, new Budget(10), moved);
    expect(world.revised).toContainEqual({ seller: 'aisha-4515', itemId: '444', quantity: 6 });

    await pushDirty(env, new Budget(10), await setStock(env, [{ productId: 1, quantity: 0 }], 'admin'));
    expect(world.revised).toContainEqual({ seller: 'adinath0', itemId: '111', quantity: 0 });
    expect(world.revised).toContainEqual({ seller: 'adinath0', itemId: '222', quantity: 0 });
  });

  it('never pushes to a listing whose real quantity has never been read', async () => {
    sql.exec(`INSERT INTO channel_listings (product_id, channel, account, external_id, title, status, pushed_qty) VALUES (4, 'ebay', 'aisha-4515', '999', 'Pukka', 'linked', NULL)`);
    await setStock(env, [{ productId: 4, quantity: 1 }], 'admin');
    expect((await dirtyListings(env, [4])).map((d) => d.external_id)).toEqual(['444']);
  });

  it('stops at the request budget and finishes on the next run', async () => {
    await setStock(env, [{ productId: 1, quantity: 9 }, { productId: 3, quantity: 9 }, { productId: 4, quantity: 9 }], 'admin');
    const first = await pushDirty(env, new Budget(1));
    expect(first.left).toBeGreaterThan(0);
    await pushDirty(env, new Budget(20));
    expect(await dirtyListings(env)).toEqual([]);
  });
});

describe('before setup starts', () => {
  it('changes nothing on the shop until an eBay shop is connected', async () => {
    sql.exec('UPDATE ebay_accounts SET refresh_token_enc = NULL');
    await runStockJob(env, new Date('2099-01-01T00:00:00Z'));
    expect(sql.all('SELECT COUNT(*) AS n FROM products WHERE merged_into IS NOT NULL')).toEqual([{ n: 0 }]);
    expect(world.revised).toEqual([]);
  });
});

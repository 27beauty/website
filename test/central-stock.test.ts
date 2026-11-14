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
  adoptChannelCounts,
  Budget,
  fillAmazonDimensions,
  dirtyListings,
  enableCentralStock,
  ensureEbayListingRows,
  LINK_REVIEWED_EBAY_LISTINGS,
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
  /** getListingsItem (summaries, offers, attributes) per Amazon SKU. */
  amazonDetails?: Record<string, unknown>;
  /** ListingStatus that GetItem reports per eBay item (default Active). */
  itemStatus?: Record<string, string>;
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
      if (call === 'GetItem') {
        const itemId = /<ItemID>(\d+)<\/ItemID>/.exec(body)?.[1] ?? '';
        const status = world.itemStatus?.[itemId] ?? 'Active';
        return new Response(
          `<GetItemResponse><Ack>Success</Ack><Item><ItemID>${itemId}</ItemID><Quantity>3</Quantity><SellingStatus><QuantitySold>3</QuantitySold><ListingStatus>${status}</ListingStatus></SellingStatus></Item></GetItemResponse>`,
        );
      }
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
      if (url.pathname.startsWith(`/listings/2021-08-01/items/${SELLER}/`) && (init.method ?? 'GET') === 'GET') {
        const sku = decodeURIComponent(url.pathname.split('/').pop() as string);
        return Response.json(world.amazonDetails?.[sku] ?? {});
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

  it('an order placed before switching on is not taken again when it is dispatched later', async () => {
    world.ebayOrders['aisha-4515'] = [
      {
        orderId: '12-OLD',
        creationDate: '2000-01-01T00:00:00.000Z', // already out of the starting count
        lastModifiedDate: '2099-01-01T00:00:00.000Z', // dispatched after switching on
        orderPaymentStatus: 'PAID',
        cancelStatus: { cancelState: 'NONE_REQUESTED' },
        lineItems: [{ lineItemId: 'L1', legacyItemId: '444', quantity: 1, title: 'Pukka' }],
      },
    ];
    await runStockJob(env, new Date('2099-01-01T00:30:00Z'));
    expect(stockOf(4)).toBe(7);
    expect(sql.all(`SELECT COUNT(*) AS n FROM stock_movements WHERE reason = 'ebay_sale'`)).toEqual([{ n: 0 }]);
  });

  it('puts back, once, a sale that the old check counted twice — and a later cancellation adds nothing more', async () => {
    const old = (state: string) => ({
      orderId: '12-333',
      creationDate: '2000-01-01T00:00:00.000Z',
      lastModifiedDate: '2099-01-01T00:00:00.000Z',
      orderPaymentStatus: 'PAID',
      cancelStatus: { cancelState: state },
      lineItems: [{ lineItemId: 'L3', legacyItemId: '444', quantity: 1, title: 'Pukka' }],
    });
    // What the old check did: took the pre-start order off again.
    await adjustStock(env, [
      { productId: 4, delta: -1, reason: 'ebay_sale', ref: 'ebay:12-333:L3', listing: { channel: 'ebay', account: 'aisha-4515', externalId: '444' } },
    ]);
    expect(stockOf(4)).toBe(6);

    world.ebayOrders['aisha-4515'] = [old('NONE_REQUESTED')];
    const first = await runStockJob(env, new Date('2099-01-01T00:30:00Z'));
    expect(first.corrected).toBe(1);
    expect(stockOf(4)).toBe(7);
    await runStockJob(env, new Date('2099-01-01T00:35:00Z'));
    expect(stockOf(4)).toBe(7);

    world.ebayOrders['aisha-4515'] = [old('CANCELED')];
    await runStockJob(env, new Date('2099-01-01T00:40:00Z'));
    expect(stockOf(4)).toBe(7);
    expect(sql.all(`SELECT reason, delta FROM stock_movements WHERE ref = 'ebay:12-333:L3' ORDER BY id`)).toEqual([
      { reason: 'ebay_sale', delta: -1 },
      { reason: 'correction', delta: 1 },
    ]);
  });

  it('keeps reading a sale whose listing is not linked yet, and counts it once it is', async () => {
    const modified = new Date(Date.now() - 60_000).toISOString();
    world.ebayOrders['aisha-4515'] = [
      {
        orderId: '12-NEW',
        creationDate: '2099-01-01T00:00:00.000Z',
        lastModifiedDate: modified,
        orderPaymentStatus: 'PAID',
        cancelStatus: { cancelState: 'NONE_REQUESTED' },
        lineItems: [{ lineItemId: 'L5', legacyItemId: '555', quantity: 1, title: 'Pukka relisted' }],
      },
    ];
    await runStockJob(env, new Date('2099-01-01T00:30:00Z'));
    expect(stockOf(4)).toBe(7);
    // The cursor waits at the unlinked sale instead of moving past it.
    expect(sql.all(`SELECT cursor FROM channel_cursors WHERE channel = 'ebay' AND account = 'aisha-4515'`)).toEqual([{ cursor: modified }]);

    sql.exec(`INSERT INTO channel_listings (product_id, channel, account, external_id, title, status, channel_qty, pushed_qty)
              VALUES (4, 'ebay', 'aisha-4515', '555', 'Pukka relisted', 'linked', 7, 7)`);
    await runStockJob(env, new Date('2099-01-01T00:35:00Z'));
    expect(stockOf(4)).toBe(6);
  });

  it('re-links a sold-out listing that was wrongly set aside as ended, and leaves a truly ended one alone', async () => {
    // What the old ended-check did to a listing that had only sold out.
    sql.exec(`UPDATE products SET status = 'archived' WHERE id IN (3, 4)`);
    sql.exec(`UPDATE channel_listings SET status = 'ignored' WHERE channel = 'ebay' AND external_id IN ('333', '444')`);
    world.itemStatus = { '333': 'Completed' }; // 444 is still Active at 0

    const r = await runStockJob(env, new Date('2099-01-01T00:30:00Z'));
    expect(r.revived).toBe(1);
    expect(sql.all(`SELECT status, last_error FROM channel_listings WHERE external_id = '444'`)).toEqual([
      { status: 'linked', last_error: null },
    ]);
    // Its website count wasn't kept while set aside, so it takes eBay's real
    // quantity (sold out: 0) instead of pushing the stale 7 out.
    expect(stockOf(4)).toBe(0);
    expect(world.revised.find((x) => x.itemId === '444')).toBeUndefined();
    expect(sql.all(`SELECT status FROM products WHERE id = 4`)).toEqual([{ status: 'active' }]);
    // Ended for real: stays set aside, and is marked so it isn't checked again.
    expect(sql.all(`SELECT status, last_error FROM channel_listings WHERE external_id = '333' AND channel = 'ebay'`)).toEqual([
      { status: 'ignored', last_error: 'Ended on eBay' },
    ]);
    const again = await runStockJob(env, new Date('2099-01-01T00:35:00Z'));
    expect(again.revived ?? 0).toBe(0);
  });

  it("fills an Amazon draft with Amazon's price less the bands, photo, description and category — once, keeping what's set", async () => {
    sql.exec(`
      INSERT INTO settings (key, value) VALUES ('ebay.price_tiers', '[{"underPence":1000,"offPence":70}]');
      INSERT INTO categories (id, slug, name) VALUES (50, 'coffee-tea', 'Coffee & Tea');
      INSERT INTO ebay_category_map (match_type, match_value, category_id, priority) VALUES ('keyword', 'tea', 50, 10);
      INSERT INTO products (id, slug, title, price_pence, stock, status, source) VALUES (60, 'pukka-4', 'Pukka Peace Organic Herbal Tea 4 x 20', 0, 4, 'draft', 'manual');
    `);
    sql.exec(`UPDATE channel_listings SET product_id = 60, status = 'linked' WHERE external_id = 'AMZ-PUK4'`);
    world.amazonDetails = {
      'AMZ-PUK4': {
        summaries: [{ marketplaceId: 'A1F83G8C2ARO7P', mainImage: { link: 'https://m.media-amazon.com/images/I/pukka.jpg' } }],
        offers: [{ marketplaceId: 'A1F83G8C2ARO7P', offerType: 'B2C', price: { currencyCode: 'GBP', amount: '8.99' } }],
        attributes: {
          product_description: [{ value: '<p>Calming chamomile &amp; spearmint.</p>', marketplace_id: 'A1F83G8C2ARO7P' }],
          bullet_point: [{ value: '80 tea bags', marketplace_id: 'A1F83G8C2ARO7P' }],
        },
      },
    };
    const r = await runStockJob(env, new Date('2099-01-01T00:30:00Z'));
    expect(r.filled).toBe(1);
    expect(sql.all(`SELECT price_pence, image_url, description, category_id, status FROM products WHERE id = 60`)).toEqual([
      {
        price_pence: 829, // £8.99 on Amazon, less 70p for "under £10"
        image_url: 'https://m.media-amazon.com/images/I/pukka.jpg',
        description: 'Calming chamomile & spearmint.\n\n• 80 tea bags',
        category_id: 50,
        status: 'draft', // still the owner's call to publish
      },
    ]);
    // Read once: a price the owner then sets isn't overwritten.
    sql.exec(`UPDATE products SET price_pence = 750 WHERE id = 60`);
    await runStockJob(env, new Date('2099-01-01T00:35:00Z'));
    expect(sql.all(`SELECT price_pence FROM products WHERE id = 60`)).toEqual([{ price_pence: 750 }]);
  });

  it('links a listing parked in review once the eBay sync creates its product, taking the real quantity', async () => {
    // Read from eBay first (no product yet) → parked in review.
    sql.exec(`INSERT INTO channel_listings (channel, account, external_id, title, status, channel_qty, pushed_qty)
              VALUES ('ebay', 'adinath0', '777', 'SodaStream 7UP Zero 6 x 440ml', 'review', 20, 20)`);
    // Then the eBay sync creates the product, with its rough "in stock" figure.
    sql.exec(`INSERT INTO products (id, slug, title, price_pence, stock, source, ebay_item_id, ebay_account, ebay_stock)
              VALUES (70, '7up', 'SodaStream 7UP Zero 6 x 440ml', 3499, 10, 'ebay', 'v1|777|0', 'adinath0', 10)`);
    await runStockJob(env, new Date('2099-01-01T00:30:00Z'));
    expect(sql.all(`SELECT product_id, status FROM channel_listings WHERE external_id = '777'`)).toEqual([{ product_id: 70, status: 'linked' }]);
    expect(stockOf(70)).toBe(20);
    expect(world.revised.find((r) => r.itemId === '777')).toBeUndefined(); // nothing wrong pushed out
  });

  it('does not re-run housekeeping while the eBay products are unchanged', async () => {
    // First run takes the watermark of the current products.
    await runStockJob(env, new Date('2099-01-01T00:30:00Z'));
    // A listing read from eBay for a product that already exists is linked by
    // importEbayListings inline, so the cron copy has nothing to do here. It
    // must stay parked: proof the five-minute job skipped the scan entirely
    // rather than doing the work again.
    sql.exec(`INSERT INTO channel_listings (channel, account, external_id, title, status, channel_qty, pushed_qty)
              VALUES ('ebay', 'adinath0', '888', 'Parked', 'review', 5, 5)`);
    await runStockJob(env, new Date('2099-01-01T00:35:00Z'));
    expect(sql.all(`SELECT status FROM channel_listings WHERE external_id = '888'`)).toEqual([{ status: 'review' }]);

    // ...and it resumes the moment a product actually changes.
    sql.exec(`INSERT INTO products (id, slug, title, price_pence, stock, source, ebay_item_id, ebay_account, ebay_stock)
              VALUES (88, 'parked', 'Parked', 999, 4, 'ebay', 'v1|888|0', 'adinath0', 4)`);
    await runStockJob(env, new Date('2099-01-01T00:40:00Z'));
    expect(sql.all(`SELECT product_id, status FROM channel_listings WHERE external_id = '888'`)).toEqual([
      { product_id: 88, status: 'linked' },
    ]);
  });

  it('links reviewed listings without scanning products once per listing', () => {
    // Guards the shape of the query, not just its result. The version this
    // replaced matched with `ebay_item_id LIKE 'v1|' || external_id || '|%'`,
    // a pattern built from the row being matched, which no index can serve:
    // SQLite scanned all of products for every listing in review, twice over
    // (once for SET, once for EXISTS). On the five-minute cron that cost
    // millions of D1 rows_read a day against a 5,000,000 cap. Keep products
    // read once, however this query is rewritten.
    const plan = sql
      .all(`EXPLAIN QUERY PLAN ${LINK_REVIEWED_EBAY_LISTINGS}`)
      .map((r) => String((r as { detail: string }).detail));
    expect(plan.join('\n')).not.toMatch(/CORRELATED/);
    expect(plan.filter((d) => /\bSCAN\b/.test(d) && /\bp\b/.test(d))).toEqual([]);
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

describe('a count the owner changed on the marketplace', () => {
  /** A linked listing: `sent` is what we last pushed, `shows` what it reports now. */
  const listing = (o: { product: number; channel?: string; account?: string; ext: string; sent: number | null; shows: number | null }) =>
    sql.exec(`INSERT INTO channel_listings (product_id, channel, account, external_id, title, status, fulfilment, channel_qty, pushed_qty)
              VALUES (${o.product}, '${o.channel ?? 'ebay'}', '${o.account ?? 'adinath0'}', '${o.ext}', 'A listing', 'linked', 'merchant',
                      ${o.shows ?? 'NULL'}, ${o.sent ?? 'NULL'})`);

  it('takes a restock entered on eBay as the new master', async () => {
    // Exactly the production case: the website pushed 0 out, the owner then
    // put 95 back on eBay, and the site sat at "out of stock".
    sql.exec(`UPDATE products SET stock = 0 WHERE id = 1`);
    listing({ product: 1, ext: '111', sent: 0, shows: 95 });
    expect(await adoptChannelCounts(env)).toBe(1);
    expect(stockOf(1)).toBe(95);
  });

  it('takes a count the owner lowered on eBay too', async () => {
    listing({ product: 1, ext: '111', sent: 10, shows: 3 });
    await adoptChannelCounts(env);
    expect(stockOf(1)).toBe(3);
  });

  it('does not undo a website sale whose push has not landed yet', async () => {
    // The master dropped to 9; eBay still shows the 10 we last sent, because
    // the push is still queued. The channel has not changed — adopting here
    // would put the sold unit back and oversell it.
    sql.exec(`UPDATE products SET stock = 9 WHERE id = 1`);
    listing({ product: 1, ext: '111', sent: 10, shows: 10 });
    expect(await adoptChannelCounts(env)).toBe(0);
    expect(stockOf(1)).toBe(9);
    // ...and the listing is still due a push, so it gets corrected instead.
    expect((await dirtyListings(env, [1])).map((d) => d.external_id)).toEqual(['111']);
  });

  it('changes nothing when the channel is only carrying the number we gave it', async () => {
    listing({ product: 1, ext: '111', sent: 10, shows: 10 });
    expect(await adoptChannelCounts(env)).toBe(0);
    expect(stockOf(1)).toBe(10);
  });

  it('carries a restock entered on eBay over to the same product on Amazon', async () => {
    sql.exec(`UPDATE products SET stock = 0 WHERE id = 3`);
    listing({ product: 3, ext: '333', sent: 0, shows: 12 });
    listing({ product: 3, channel: 'amazon', account: 'A2SELLERTEST', ext: 'AMZ-TSU', sent: 0, shows: 0 });
    await adoptChannelCounts(env);
    expect(stockOf(3)).toBe(12);
    // The eBay listing already shows 12, so only Amazon is left to update.
    expect((await dirtyListings(env, [3])).map((d) => d.external_id)).toEqual(['AMZ-TSU']);
  });

  it('believes eBay over Amazon when both have changed', async () => {
    listing({ product: 1, ext: '111', sent: 10, shows: 4 });
    listing({ product: 1, channel: 'amazon', account: 'A2SELLERTEST', ext: 'AMZ-1', sent: 10, shows: 30 });
    await adoptChannelCounts(env);
    expect(stockOf(1)).toBe(4);
  });

  it('leaves a product whose stock the owner locked on the website', async () => {
    sql.exec(`UPDATE products SET stock = 2, stock_locked = 1 WHERE id = 1`);
    listing({ product: 1, ext: '111', sent: 2, shows: 50 });
    expect(await adoptChannelCounts(env)).toBe(0);
    expect(stockOf(1)).toBe(2);
  });

  it('leaves an archived product alone', async () => {
    sql.exec(`UPDATE products SET stock = 0, status = 'archived' WHERE id = 1`);
    listing({ product: 1, ext: '111', sent: 0, shows: 20 });
    expect(await adoptChannelCounts(env)).toBe(0);
    expect(stockOf(1)).toBe(0);
  });

  it('ignores an FBA listing, which Amazon ships and we never count', async () => {
    sql.exec(`UPDATE products SET stock = 0 WHERE id = 1`);
    sql.exec(`INSERT INTO channel_listings (product_id, channel, account, external_id, title, status, fulfilment, channel_qty, pushed_qty)
              VALUES (1, 'amazon', 'A2SELLERTEST', 'AMZ-FBA', 'A listing', 'linked', 'amazon', 40, 0)`);
    expect(await adoptChannelCounts(env)).toBe(0);
    expect(stockOf(1)).toBe(0);
  });

  it('writes it to the stock history, so the owner can see where the number came from', async () => {
    sql.exec(`UPDATE products SET stock = 0 WHERE id = 1`);
    listing({ product: 1, ext: '111', sent: 0, shows: 95 });
    await adoptChannelCounts(env);
    expect(sql.all(`SELECT delta, reason, note FROM stock_movements WHERE product_id = 1`)).toEqual([
      { delta: 95, reason: 'correction', note: 'Count taken from eBay' },
    ]);
  });

  it('the five-minute job actually does this — not just the function on its own', async () => {
    await goLive();
    // The owner restocks on eBay: the shop sold out and pushed 0, then 60 went
    // back on the listing by hand.
    sql.exec(`UPDATE products SET stock = 0 WHERE id = 1`);
    sql.exec(`UPDATE channel_listings SET pushed_qty = 0, channel_qty = 60 WHERE external_id = '111'`);
    await runStockJob(env, new Date('2099-01-01T00:30:00Z'));
    expect(stockOf(1)).toBe(60);
  });

  it('does not adopt the same change twice', async () => {
    sql.exec(`UPDATE products SET stock = 0 WHERE id = 1`);
    listing({ product: 1, ext: '111', sent: 0, shows: 95 });
    expect(await adoptChannelCounts(env)).toBe(1);
    expect(await adoptChannelCounts(env)).toBe(0);
    expect(stockOf(1)).toBe(95);
  });
});

describe('parcel size and weight for Parcel2Go', () => {
  const sizeOf = (id: number) =>
    sql.all('SELECT weight_g, length_cm, width_cm, height_cm, dimensions_checked_at IS NOT NULL AS checked FROM products WHERE id = ?', id)[0];
  const amazonSays = (sku: string, dims: Record<string, unknown>) => {
    world.amazonDetails = { ...(world.amazonDetails ?? {}), [sku]: { attributes: dims } };
  };

  it('takes the parcel from the Amazon listing when the product has none', async () => {
    await goLive();
    amazonSays('AMZ-TSU', {
      item_package_dimensions: [{ length: { value: 22, unit: 'centimeters' }, width: { value: 9, unit: 'centimeters' }, height: { value: 7, unit: 'centimeters' } }],
      item_package_weight: [{ value: 480, unit: 'grams' }],
    });
    const r = await fillAmazonDimensions(env, new Budget(20));
    expect(r.filled).toBeGreaterThan(0);
    expect(sizeOf(3)).toEqual({ weight_g: 480, length_cm: 22, width_cm: 9, height_cm: 7, checked: 1 });
  });

  it('never overwrites a figure the owner set themselves', async () => {
    await goLive();
    // The owner weighed it: Amazon's number must not replace theirs.
    sql.exec(`UPDATE products SET weight_g = 1200 WHERE id = 3`);
    amazonSays('AMZ-TSU', {
      item_package_dimensions: [{ length: { value: 22, unit: 'cm' }, width: { value: 9, unit: 'cm' }, height: { value: 7, unit: 'cm' } }],
      item_package_weight: [{ value: 480, unit: 'grams' }],
    });
    await fillAmazonDimensions(env, new Budget(20));
    const got = sizeOf(3) as { weight_g: number; length_cm: number };
    expect(got.weight_g).toBe(1200);
    // ...while still filling the parts that were blank.
    expect(got.length_cm).toBe(22);
  });

  it('marks a product Amazon knows nothing about, so it is not asked again', async () => {
    await goLive();
    amazonSays('AMZ-TSU', {});
    const first = await fillAmazonDimensions(env, new Budget(20));
    expect(first.read).toBeGreaterThan(0);
    expect(first.filled).toBe(0);
    expect((sizeOf(3) as { checked: number }).checked).toBe(1);
    // Nothing left to ask about: a second run reads nothing at all.
    expect((await fillAmazonDimensions(env, new Budget(20))).read).toBe(0);
  });

  it('spends no Amazon requests once every product has been checked', async () => {
    await goLive();
    amazonSays('AMZ-TSU', { item_package_weight: [{ value: 100, unit: 'g' }] });
    await fillAmazonDimensions(env, new Budget(20));
    const budget = new Budget(20);
    await fillAmazonDimensions(env, budget);
    expect(budget.remaining).toBe(20);
  });

  it('leaves a product with no Amazon listing alone — Amazon cannot say anything about it', async () => {
    await goLive();
    sql.exec(`INSERT INTO products (id, slug, title, price_pence, stock, source) VALUES (90, 'web-only', 'Website Only Thing', 500, 3, 'manual')`);
    await fillAmazonDimensions(env, new Budget(20));
    expect(sizeOf(90)).toEqual({ weight_g: null, length_cm: null, width_cm: null, height_cm: null, checked: 0 });
  });

  it('still takes the parcel from an FBA listing, unlike the stock count', async () => {
    // FBA is excluded everywhere else, because Amazon ships those and the
    // quantity is not ours to manage. The box is the same box, though, and the
    // product can still be sold on the website and posted by hand.
    await goLive();
    const fba = sql.all(`SELECT product_id FROM channel_listings WHERE external_id = 'AMZ-FBA' AND product_id IS NOT NULL`) as {
      product_id: number;
    }[];
    expect(fba.length).toBe(1);
    amazonSays('AMZ-FBA', { item_package_weight: [{ value: 1.2, unit: 'kg' }] });
    await fillAmazonDimensions(env, new Budget(20));
    expect((sizeOf(fba[0].product_id) as { weight_g: number }).weight_g).toBe(1200);
  });
});

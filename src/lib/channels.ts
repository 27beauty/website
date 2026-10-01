/**
 * Centralised stock across sales channels. products.stock is the master
 * count; this module keeps every linked marketplace listing in step with it:
 *
 *   importEbayListings / importAmazonListings  read listings + exact quantities,
 *                                               link each to a product (src/lib/matching.ts)
 *   mergeDuplicateProducts                      one product per item, however many listings
 *   pollEbaySales / pollAmazonSales             marketplace sales → adjustStock (src/lib/stock.ts)
 *   pushDirty                                   master count → every linked FBM listing
 *   runStockJob                                 the 5-minute cron that does all of the above
 *
 * Workers Free allows 50 outbound requests per invocation, so every function
 * that calls out takes a Budget and stops cleanly when it runs out; anything
 * left over is still "dirty" and goes out on the next run.
 */

import type { ChannelListing, EbayAccount, Env } from '../types';
import { getSetting, setSetting } from './settings';
import { D1_IN_CHUNK, uniqueSlug } from './util';
import { adjustStock, centralStockEnabled, setStock, type StockChange } from './stock';
import { MatchIndex, exactDuplicateGroups, matchListing, type MatchCandidate } from './matching';
import { getUserAccessToken, sellerConnected } from './ebay/oauth';
import { getActiveListingsPage, getItemDetails, getItemStatus, reviseQuantities, REVISE_BATCH, type QuantityUpdate } from './ebay/trading';
import { fetchModifiedOrders, newestModified, saleLines } from './ebay/orders';
import {
  amazonConfigured,
  classifyOrders,
  fetchOrderLines,
  fetchUpdatedOrders,
  newestUpdate,
  AmazonThrottledError,
  getCatalogDescription,
  getListingDetails,
  searchListingsPage,
  setMerchantQuantity,
  type CallCounter,
} from './amazon/spapi';
import { normalisePriceTiers, websitePriceFromEbay } from './money';
import { loadCategoryRules, mapCategory } from './ebay/mapping';

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

import { Budget } from './ebay/http';
export { Budget };

/** Requests per cron run: Workers Free's 50, less 6 for token refreshes and retries. */
const CRON_BUDGET = 44;
/** Requests for an immediate push after a sale or an admin edit. */
export const QUICK_PUSH_BUDGET = 12;
/** Don't retry a listing that failed within this window — stops one bad listing eating every run. */
const FAILED_RETRY_MINUTES = 60;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

export async function listEbayAccounts(env: Env): Promise<EbayAccount[]> {
  const { results } = await env.DB.prepare('SELECT * FROM ebay_accounts WHERE active = 1 ORDER BY id').all<EbayAccount>();
  return results ?? [];
}

function accountKey(account: EbayAccount): string {
  return account.seller_username || `account:${account.id}`;
}

async function connectedEbayAccounts(env: Env): Promise<EbayAccount[]> {
  return (await listEbayAccounts(env)).filter(sellerConnected);
}

// ---------------------------------------------------------------------------
// Listings → products
// ---------------------------------------------------------------------------

/** Every eBay product the sync created gets a linked listing row (cheap, DB only). */
export async function ensureEbayListingRows(env: Env): Promise<void> {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO channel_listings (product_id, channel, account, external_id, sku, title, status, match_score, channel_qty)
     SELECT id, 'ebay', ebay_account,
            CASE WHEN ebay_item_id LIKE 'v1|%|%'
                 THEN substr(ebay_item_id, 4, instr(substr(ebay_item_id, 4), '|') - 1)
                 ELSE ebay_item_id END,
            COALESCE(ebay_sku, sku), title, 'linked', 1, ebay_stock
       FROM products
      WHERE source = 'ebay' AND ebay_item_id IS NOT NULL AND ebay_account IS NOT NULL`,
  ).run();
}

async function matchCandidates(env: Env): Promise<MatchCandidate[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, title, COALESCE(sku, ebay_sku) AS sku FROM products WHERE merged_into IS NULL AND status != 'archived'`,
  ).all<MatchCandidate>();
  return results ?? [];
}

interface IncomingListing {
  externalId: string;
  title: string;
  sku: string | null;
  asin?: string | null;
  fulfilment: 'merchant' | 'amazon';
  quantity: number | null;
  /** A product this listing is already known to belong to (e.g. the sync imported it). */
  knownProductId?: number | null;
}

/**
 * Upserts listings for one channel account. New ones are matched: confident
 * matches link straight away, the rest wait on the review screen. Existing
 * rows keep their link (a person may have set it) and just get fresh data.
 */
export async function upsertListings(
  env: Env,
  channel: 'ebay' | 'amazon',
  account: string,
  incoming: IncomingListing[],
): Promise<{ added: number; linked: number; review: number }> {
  if (!incoming.length) return { added: 0, linked: 0, review: 0 };
  const { results } = await env.DB.prepare(
    `SELECT external_id FROM channel_listings WHERE channel = ? AND account = ?`,
  )
    .bind(channel, account)
    .all<{ external_id: string }>();
  const known = new Set((results ?? []).map((r) => r.external_id));
  const index = new MatchIndex(incoming.some((l) => !known.has(l.externalId)) ? await matchCandidates(env) : []);

  const statements: D1PreparedStatement[] = [];
  let added = 0;
  let linked = 0;
  let review = 0;
  for (const l of incoming) {
    if (known.has(l.externalId)) {
      statements.push(
        env.DB.prepare(
          // pushed_qty gets its baseline the first time a real quantity is read:
          // until then we don't know what the listing shows, so it's never pushed.
          `UPDATE channel_listings
              SET title = ?, sku = ?, asin = COALESCE(?, asin), fulfilment = ?, channel_qty = ?,
                  pushed_qty = COALESCE(pushed_qty, ?), updated_at = datetime('now')
            WHERE channel = ? AND account = ? AND external_id = ?`,
        ).bind(l.title, l.sku, l.asin ?? null, l.fulfilment, l.quantity, l.quantity, channel, account, l.externalId),
      );
      continue;
    }
    added++;
    let productId: number | null = l.knownProductId ?? null;
    let status: ChannelListing['status'] = productId ? 'linked' : 'review';
    let score: number | null = productId ? 1 : null;
    let suggested: number | null = null;
    if (!productId) {
      const m = matchListing({ title: l.title, sku: l.sku }, index);
      score = m.best?.score ?? null;
      suggested = m.best?.id ?? null;
      if (m.autoLinkId) {
        productId = m.autoLinkId;
        status = 'linked';
      }
    }
    if (status === 'linked') linked++;
    else review++;
    statements.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO channel_listings
           (product_id, channel, account, external_id, sku, asin, title, fulfilment, status, match_score, suggested_product_id, channel_qty, pushed_qty)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(productId, channel, account, l.externalId, l.sku, l.asin ?? null, l.title, l.fulfilment, status, score, suggested, l.quantity, l.quantity),
    );
  }
  for (let i = 0; i < statements.length; i += 50) await env.DB.batch(statements.slice(i, i + 50));
  return { added, linked, review };
}

/** Reads every active listing in a connected eBay shop with its exact quantity. */
export async function importEbayListings(
  env: Env,
  account: EbayAccount,
  budget: Budget,
): Promise<{ listings: number; added: number; review: number; complete: boolean }> {
  const token = await getUserAccessToken(env, account);
  if (!token) throw new Error(`eBay shop "${account.label}" isn't connected`);
  const key = accountKey(account);

  // Products the sync already imported are recognised by item id, not title.
  const { results: known } = await env.DB.prepare(
    `SELECT id, ebay_item_id FROM products WHERE source = 'ebay' AND ebay_account = ? AND ebay_item_id IS NOT NULL`,
  )
    .bind(key)
    .all<{ id: number; ebay_item_id: string }>();
  const byItemId = new Map<string, number>();
  for (const k of known ?? []) {
    const m = /^v1\|(\d+)\|/.exec(k.ebay_item_id);
    byItemId.set(m ? m[1] : k.ebay_item_id, k.id);
  }

  const all: IncomingListing[] = [];
  let page = 1;
  let totalPages = 1;
  let complete = true;
  do {
    if (!budget.take()) {
      complete = false;
      break;
    }
    const res = await getActiveListingsPage(token, page);
    totalPages = res.totalPages;
    for (const l of res.listings) {
      all.push({
        externalId: l.itemId,
        title: l.title,
        sku: l.sku,
        fulfilment: 'merchant',
        quantity: l.quantityAvailable,
        knownProductId: byItemId.get(l.itemId) ?? null,
      });
    }
    page++;
  } while (page <= totalPages);

  const r = await upsertListings(env, 'ebay', key, all);
  await startNewProducts(env, 'ebay', key);
  // Exact duplicates (same item listed twice) merge straight away; only
  // near-matches are left for a person to check.
  await ensureEbayListingRows(env);
  await mergeDuplicateProducts(env);
  await flagNearDuplicates(env);
  return { listings: all.length, added: r.added, review: r.review, complete };
}

/**
 * After go-live, a product that first appears through a listing (listed on
 * eBay, say, after the switch-over) takes its first count from that
 * listing's real quantity — never from browse mode's estimate.
 */
async function startNewProducts(env: Env, channel: 'ebay' | 'amazon', account: string): Promise<void> {
  if (!(await centralStockEnabled(env))) return; // before go-live takeStartingStock does this for everything
  const { results } = await env.DB.prepare(
    `SELECT l.product_id AS productId, MAX(l.channel_qty) AS quantity
       FROM channel_listings l
      WHERE l.channel = ? AND l.account = ? AND l.status = 'linked' AND l.fulfilment = 'merchant'
        AND l.product_id IS NOT NULL AND l.channel_qty IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM stock_movements m WHERE m.product_id = l.product_id)
      GROUP BY l.product_id`,
  )
    .bind(channel, account)
    .all<{ productId: number; quantity: number }>();
  if (results?.length) await setStock(env, results, 'start', `First count from ${channel} listing`);
}

/** Reads every Amazon listing (FBM and FBA) with quantities where Amazon gives them. */
export async function importAmazonListings(
  env: Env,
  budget: Budget,
  maxPages = 30,
): Promise<{ listings: number; added: number; review: number; complete: boolean }> {
  const counter: CallCounter = { calls: 0 };
  const all: IncomingListing[] = [];
  let token: string | null = null;
  let complete = true;
  for (let i = 0; i < maxPages; i++) {
    if (!budget.take()) {
      complete = false;
      break;
    }
    const page = await searchListingsPage(env, counter, token);
    for (const l of page.listings) {
      all.push({ externalId: l.sku, title: l.title, sku: l.sku, asin: l.asin, fulfilment: l.fulfilment, quantity: l.quantity });
    }
    token = page.nextToken;
    if (!token) break;
  }
  if (token) complete = false;
  const r = await upsertListings(env, 'amazon', env.AMAZON_SELLER_ID as string, all);
  await startNewProducts(env, 'amazon', env.AMAZON_SELLER_ID as string);
  return { listings: all.length, added: r.added, review: r.review, complete };
}

/**
 * Folds products that are the same item listed more than once (same title,
 * either shop) into the lowest-numbered one. The spare is archived — never
 * deleted — so past orders keep their link; its listings, QR coupons and
 * stock (the higher of the two counts) move to the one that's kept.
 */
export async function mergeDuplicateProducts(env: Env): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT id, title FROM products WHERE source = 'ebay' AND merged_into IS NULL AND status != 'archived'`,
  ).all<MatchCandidate>();
  const groups = exactDuplicateGroups(results ?? []);
  let merged = 0;
  for (const [keep, ...drops] of groups) {
    await mergeProducts(env, keep, drops);
    merged += drops.length;
  }
  return merged;
}

export async function mergeProducts(env: Env, keep: number, drops: number[]): Promise<void> {
  if (!drops.length) return;
  const ph = drops.map(() => '?').join(',');
  const { results } = await env.DB.prepare(
    `SELECT MAX(stock) AS top FROM products WHERE id IN (?, ${ph})`,
  )
    .bind(keep, ...drops)
    .all<{ top: number }>();
  const top = results?.[0]?.top ?? 0;
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE channel_listings SET product_id = ?, status = 'linked', updated_at = datetime('now') WHERE product_id IN (${ph})`,
    ).bind(keep, ...drops),
    env.DB.prepare(`UPDATE coupons SET product_id = ? WHERE product_id IN (${ph})`).bind(keep, ...drops),
    env.DB.prepare(
      `UPDATE products SET merged_into = ?, status = 'archived', updated_at = datetime('now') WHERE id IN (${ph})`,
    ).bind(keep, ...drops),
  ]);
  await setStock(env, [{ productId: keep, quantity: top }], 'merge', `Merged duplicate product(s) #${drops.join(', #')}`);
}

// ---------------------------------------------------------------------------
// Sales in
// ---------------------------------------------------------------------------

async function getCursor(env: Env, channel: string, account: string, fallback: string): Promise<string> {
  const row = await env.DB.prepare(`SELECT cursor FROM channel_cursors WHERE channel = ? AND account = ?`)
    .bind(channel, account)
    .first<{ cursor: string }>();
  return row?.cursor ?? fallback;
}

async function saveCursor(env: Env, channel: string, account: string, cursor: string, error: string | null): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO channel_cursors (channel, account, cursor, last_run_at, last_error) VALUES (?, ?, ?, datetime('now'), ?)
     ON CONFLICT(channel, account) DO UPDATE SET cursor = excluded.cursor, last_run_at = excluded.last_run_at, last_error = excluded.last_error`,
  )
    .bind(channel, account, cursor, error)
    .run();
}

async function listingProductMap(env: Env, channel: 'ebay' | 'amazon', account: string, externalIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const ids = [...new Set(externalIds)];
  for (let i = 0; i < ids.length; i += 90) {
    const slice = ids.slice(i, i + 90);
    const { results } = await env.DB.prepare(
      `SELECT external_id, product_id FROM channel_listings
        WHERE channel = ? AND account = ? AND status = 'linked' AND fulfilment = 'merchant' AND product_id IS NOT NULL
          AND external_id IN (${slice.map(() => '?').join(',')})`,
    )
      .bind(channel, account, ...slice)
      .all<{ external_id: string; product_id: number }>();
    for (const r of results ?? []) out.set(r.external_id, r.product_id);
  }
  return out;
}

/** Movements already recorded for these refs (sales), so a cancellation only puts back what was taken. */
async function recordedSales(env: Env, reason: 'ebay_sale' | 'amazon_sale', refs: string[]): Promise<Map<string, { productId: number; delta: number }>> {
  const out = new Map<string, { productId: number; delta: number }>();
  for (let i = 0; i < refs.length; i += 90) {
    const slice = refs.slice(i, i + 90);
    const { results } = await env.DB.prepare(
      `SELECT ref, product_id, delta FROM stock_movements WHERE reason = ? AND ref IN (${slice.map(() => '?').join(',')})`,
    )
      .bind(reason, ...slice)
      .all<{ ref: string; product_id: number; delta: number }>();
    for (const r of results ?? []) out.set(r.ref, { productId: r.product_id, delta: r.delta });
  }
  return out;
}

/** Sales that have already been put back, by a cancellation or a correction — never put back twice. */
async function putBackRefs(env: Env, refs: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (let i = 0; i < refs.length; i += 90) {
    const slice = refs.slice(i, i + 90);
    const { results } = await env.DB.prepare(
      `SELECT ref FROM stock_movements WHERE reason IN ('cancel', 'correction') AND ref IN (${slice.map(() => '?').join(',')})`,
    )
      .bind(...slice)
      .all<{ ref: string }>();
    for (const r of results ?? []) out.add(r.ref);
  }
  return out;
}

/** How long a sale whose listing isn't linked yet is retried before it's reported and left. */
const UNMATCHED_RETRY_MS = 24 * 60 * 60 * 1000;

export interface PollResult {
  sales: number;
  cancellations: number;
  unmatched: string[];
  moved: number[];
}

export async function pollEbaySales(env: Env, account: EbayAccount, budget: Budget, since: string): Promise<PollResult> {
  const key = accountKey(account);
  const cursor = await getCursor(env, 'ebay', key, since);
  const token = await getUserAccessToken(env, account);
  if (!token) throw new Error(`eBay shop "${account.label}" isn't connected`);
  const pages = Math.min(2, budget.remaining);
  if (pages < 1) return { sales: 0, cancellations: 0, unmatched: [], moved: [] };
  const fetched = await fetchModifiedOrders(token, cursor, pages);
  budget.take(fetched.calls);

  const lines = saleLines(fetched.orders, since);
  const products = await listingProductMap(env, 'ebay', key, lines.map((l) => l.itemId));
  const refOf = (l: (typeof lines)[number]) => `ebay:${l.orderId}:${l.lineItemId}`;
  const cancelledRefs = lines.filter((l) => l.cancelled).map(refOf);
  const already = await recordedSales(env, 'ebay_sale', cancelledRefs);
  const alreadyBack = await putBackRefs(env, cancelledRefs);
  // A sale whose listing isn't linked yet (e.g. a relist the site hasn't
  // picked up) is read again on later runs, so it's counted once it's linked.
  let holdCursorAt: string | null = null;

  const changes: StockChange[] = [];
  const unmatched: string[] = [];
  let sales = 0;
  let cancellations = 0;
  for (const l of lines) {
    const ref = refOf(l);
    if (l.cancelled) {
      const taken = already.get(ref);
      if (taken && !alreadyBack.has(ref)) {
        changes.push({
          productId: taken.productId,
          delta: -taken.delta,
          reason: 'cancel',
          ref,
          note: `eBay order ${l.orderId} cancelled`,
          listing: { channel: 'ebay', account: key, externalId: l.itemId },
        });
        cancellations++;
      }
      continue;
    }
    const productId = products.get(l.itemId);
    if (!productId) {
      unmatched.push(`eBay item ${l.itemId} (${l.title.slice(0, 40)})`);
      const modified = l.lastModified ? Date.parse(l.lastModified) : NaN;
      if (l.lastModified && Number.isFinite(modified) && Date.now() - modified < UNMATCHED_RETRY_MS) {
        if (!holdCursorAt || l.lastModified < holdCursorAt) holdCursorAt = l.lastModified;
      }
      continue;
    }
    changes.push({
      productId,
      delta: -l.quantity,
      reason: 'ebay_sale',
      ref,
      note: `eBay order ${l.orderId} · ${account.label}`,
      listing: { channel: 'ebay', account: key, externalId: l.itemId },
    });
    sales++;
  }
  const moved = await adjustStock(env, changes);
  const newest = fetched.complete ? newestModified(fetched.orders, cursor) : cursor;
  const next = holdCursorAt && holdCursorAt < newest ? holdCursorAt : newest;
  await saveCursor(env, 'ebay', key, next, unmatched.length ? `Sold but not linked: ${unmatched.join('; ')}`.slice(0, 1000) : null);
  return { sales, cancellations, unmatched, moved };
}

/**
 * When Amazon orders start counting: when centralised stock was switched on,
 * or when Amazon was connected (its first listing read) if that was later —
 * Amazon's quantities at that moment already include earlier orders.
 */
export async function amazonCountingFrom(env: Env, since: string): Promise<string> {
  const row = await env.DB.prepare(`SELECT MIN(created_at) AS t FROM channel_listings WHERE channel = 'amazon'`).first<{ t: string | null }>();
  const connected = row?.t ? new Date(`${row.t.replace(' ', 'T')}Z`).toISOString() : null;
  return connected && connected > since ? connected : since;
}

export async function pollAmazonSales(env: Env, budget: Budget, since: string): Promise<PollResult> {
  const account = env.AMAZON_SELLER_ID as string;
  const countFrom = await amazonCountingFrom(env, since);
  const cursor = await getCursor(env, 'amazon', account, countFrom);
  const counter: CallCounter = { calls: 0 };
  if (!budget.take()) return { sales: 0, cancellations: 0, unmatched: [], moved: [] };
  const { orders, complete } = await fetchUpdatedOrders(env, counter, cursor);
  const { sold, cancelled } = classifyOrders(orders, countFrom);

  // Orders already counted in full need no item lookup (saves Amazon's tight rate limit).
  const { results: seen } = await env.DB.prepare(
    `SELECT DISTINCT substr(ref, 8, instr(substr(ref, 8), ':') - 1) AS order_id FROM stock_movements
      WHERE reason = 'amazon_sale' AND ref LIKE 'amazon:%' AND created_at > datetime('now', '-60 days')`,
  ).all<{ order_id: string }>();
  const counted = new Set((seen ?? []).map((r) => r.order_id));

  const changes: StockChange[] = [];
  const unmatched: string[] = [];
  let sales = 0;
  let cancellations = 0;
  let allFetched = true;
  for (const orderId of sold.filter((id) => !counted.has(id))) {
    if (!budget.take()) {
      allFetched = false;
      break;
    }
    const lines = await fetchOrderLines(env, counter, orderId);
    const products = await listingProductMap(env, 'amazon', account, lines.map((l) => l.sku));
    for (const l of lines) {
      const productId = products.get(l.sku);
      if (!productId) {
        unmatched.push(`Amazon SKU ${l.sku}`);
        continue;
      }
      changes.push({
        productId,
        delta: -l.quantity,
        reason: 'amazon_sale',
        ref: `amazon:${orderId}:${l.orderItemId}`,
        note: `Amazon order ${orderId} · SKU ${l.sku}`,
        listing: { channel: 'amazon', account, externalId: l.sku },
      });
      sales++;
    }
  }

  // Put back anything taken for orders that have since been cancelled.
  for (const orderId of cancelled) {
    const { results } = await env.DB.prepare(
      `SELECT ref, product_id, delta, note FROM stock_movements WHERE reason = 'amazon_sale' AND ref LIKE ?`,
    )
      .bind(`amazon:${orderId}:%`)
      .all<{ ref: string; product_id: number; delta: number; note: string | null }>();
    const back = await putBackRefs(env, (results ?? []).map((r) => r.ref));
    for (const r of (results ?? []).filter((x) => !back.has(x.ref))) {
      const sku = /SKU (.+)$/.exec(r.note ?? '')?.[1];
      changes.push({
        productId: r.product_id,
        delta: -r.delta,
        reason: 'cancel',
        ref: r.ref,
        note: `Amazon order ${orderId} cancelled`,
        listing: sku ? { channel: 'amazon', account, externalId: sku } : undefined,
      });
      cancellations++;
    }
  }

  const moved = await adjustStock(env, changes);
  await saveCursor(
    env,
    'amazon',
    account,
    complete && allFetched ? newestUpdate(orders, cursor) : cursor,
    unmatched.length ? `Sold but not linked: ${unmatched.join('; ')}`.slice(0, 1000) : null,
  );
  return { sales, cancellations, unmatched, moved };
}

// ---------------------------------------------------------------------------
// Stock out
// ---------------------------------------------------------------------------

interface DirtyListing {
  id: number;
  channel: 'ebay' | 'amazon';
  account: string;
  external_id: string;
  stock: number;
}

/**
 * Linked, own-shipped listings whose channel doesn't show the master count
 * yet. A listing whose real quantity has never been read (pushed_qty NULL)
 * is left alone — pushing blind could overwrite a real count. Zeros go first — an item that has sold out must stop selling before
 * anything else is tidied up.
 */
export async function dirtyListings(env: Env, productIds?: number[]): Promise<DirtyListing[]> {
  // More ids than one D1 query can bind: check every listing instead. Only
  // listings that differ come back either way, so the answer is the same.
  const ids = productIds && productIds.length <= D1_IN_CHUNK ? productIds : undefined;
  const filter = ids?.length ? `AND l.product_id IN (${ids.map(() => '?').join(',')})` : '';
  const { results } = await env.DB.prepare(
    `SELECT l.id, l.channel, l.account, l.external_id, p.stock
       FROM channel_listings l JOIN products p ON p.id = l.product_id
      WHERE l.status = 'linked' AND l.fulfilment = 'merchant' AND p.merged_into IS NULL
        AND l.pushed_qty IS NOT NULL AND l.pushed_qty != p.stock
        AND NOT (l.last_error IS NOT NULL AND l.pushed_at > datetime('now', '-${FAILED_RETRY_MINUTES} minutes'))
        ${filter}
      ORDER BY (p.stock = 0) DESC, l.updated_at ASC
      LIMIT 400`,
  )
    .bind(...(ids ?? []))
    .all<DirtyListing>();
  return results ?? [];
}

/** Splits eBay listings into ReviseInventoryStatus-sized batches per shop. */
export function planEbayBatches(listings: DirtyListing[]): Map<string, DirtyListing[][]> {
  const byAccount = new Map<string, DirtyListing[][]>();
  for (const l of listings.filter((x) => x.channel === 'ebay')) {
    const batches = byAccount.get(l.account) ?? [];
    const last = batches[batches.length - 1];
    if (last && last.length < REVISE_BATCH) last.push(l);
    else batches.push([l]);
    byAccount.set(l.account, batches);
  }
  return byAccount;
}

async function markPushed(env: Env, results: { id: number; quantity: number | null; error: string | null }[]): Promise<void> {
  if (!results.length) return;
  await env.DB.batch(
    results.map((r) =>
      r.error
        ? env.DB.prepare(`UPDATE channel_listings SET last_error = ?, pushed_at = datetime('now') WHERE id = ?`).bind(r.error.slice(0, 500), r.id)
        : env.DB.prepare(
            `UPDATE channel_listings SET pushed_qty = ?, channel_qty = ?, last_error = NULL, pushed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
          ).bind(r.quantity, r.quantity, r.id),
    ),
  );
}

export async function pushDirty(env: Env, budget: Budget, productIds?: number[]): Promise<{ pushed: number; failed: number; left: number }> {
  if (!(await centralStockEnabled(env))) return { pushed: 0, failed: 0, left: 0 };
  const dirty = await dirtyListings(env, productIds);
  if (!dirty.length) return { pushed: 0, failed: 0, left: 0 };
  let pushed = 0;
  let failed = 0;
  const done = new Set<number>();

  // eBay: 4 listings per request, per connected shop.
  const accounts = new Map((await connectedEbayAccounts(env)).map((a) => [accountKey(a), a]));
  for (const [key, batches] of planEbayBatches(dirty)) {
    const account = accounts.get(key);
    if (!account) continue; // shop not connected: nothing we can write to
    let token: string | null;
    try {
      token = await getUserAccessToken(env, account);
    } catch (err) {
      await markPushed(env, batches.flat().map((l) => ({ id: l.id, quantity: null, error: errorText(err) })));
      failed += batches.flat().length;
      continue;
    }
    if (!token) continue;
    for (const batch of batches) {
      if (!budget.take()) break;
      const updates: QuantityUpdate[] = batch.map((l) => ({ itemId: l.external_id, quantity: l.stock }));
      try {
        const res = await reviseQuantities(token, updates);
        await markPushed(
          env,
          batch.map((l) => ({ id: l.id, quantity: res.failed.has(l.external_id) ? null : l.stock, error: res.failed.get(l.external_id) ?? null })),
        );
        pushed += res.ok.size;
        failed += res.failed.size;
      } catch (err) {
        await markPushed(env, batch.map((l) => ({ id: l.id, quantity: null, error: errorText(err) })));
        failed += batch.length;
      }
      batch.forEach((l) => done.add(l.id));
    }
  }

  // Amazon: one request per SKU.
  if (amazonConfigured(env)) {
    const counter: CallCounter = { calls: 0 };
    for (const l of dirty.filter((x) => x.channel === 'amazon')) {
      if (!budget.take()) break;
      try {
        await setMerchantQuantity(env, counter, l.external_id, l.stock);
        await markPushed(env, [{ id: l.id, quantity: l.stock, error: null }]);
        pushed++;
      } catch (err) {
        await markPushed(env, [{ id: l.id, quantity: null, error: errorText(err) }]);
        failed++;
      }
      done.add(l.id);
    }
  }
  return { pushed, failed, left: dirty.length - done.size };
}

/**
 * For request handlers: push these products' new count straight away,
 * inside the request's own budget. The cron picks up anything left.
 */
export function pushSoon(env: Env, ctx: { waitUntil(p: Promise<unknown>): void } | undefined, productIds: number[]): void {
  if (!productIds.length) return;
  const work = pushDirty(env, new Budget(QUICK_PUSH_BUDGET), productIds).catch((err) =>
    console.error('stock push failed', errorText(err)),
  );
  try {
    ctx?.waitUntil(work);
  } catch {
    // no execution context (tests)
  }
}

// ---------------------------------------------------------------------------
// Go-live
// ---------------------------------------------------------------------------

export interface ChannelReadiness {
  ebayShops: { account: EbayAccount; connected: boolean; listings: number }[];
  amazonConfigured: boolean;
  amazonListings: number;
  toReview: number;
  startTakenAt: string | null;
  enabled: boolean;
  canTakeStart: boolean;
  canEnable: boolean;
}

export async function readiness(env: Env): Promise<ChannelReadiness> {
  const [accounts, counts, toReview, startTakenAt, enabled] = await Promise.all([
    listEbayAccounts(env),
    env.DB.prepare(`SELECT channel, account, COUNT(*) AS n FROM channel_listings GROUP BY channel, account`).all<{ channel: string; account: string; n: number }>(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM channel_listings WHERE status = 'review'`).first<{ n: number }>(),
    getSetting<string | null>(env, 'stock.start_taken_at', null),
    centralStockEnabled(env),
  ]);
  const count = (channel: string, account: string) =>
    (counts.results ?? []).find((c) => c.channel === channel && c.account === account)?.n ?? 0;
  const ebayShops = accounts.map((a) => ({ account: a, connected: sellerConnected(a), listings: count('ebay', accountKey(a)) }));
  const allShopsConnected = ebayShops.length > 0 && ebayShops.every((s) => s.connected);
  const review = toReview?.n ?? 0;
  return {
    ebayShops,
    amazonConfigured: amazonConfigured(env),
    amazonListings: env.AMAZON_SELLER_ID ? count('amazon', env.AMAZON_SELLER_ID) : 0,
    toReview: review,
    startTakenAt,
    enabled,
    canTakeStart: allShopsConnected && !enabled,
    canEnable: allShopsConnected && review === 0 && Boolean(startTakenAt) && !enabled,
  };
}

/**
 * Sets every linked product's master count from what its own-shipped listings
 * show right now (the highest, when an item is listed more than once), and
 * records that each of those listings already shows its number.
 */
export async function takeStartingStock(env: Env): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT l.product_id AS productId, MAX(l.channel_qty) AS quantity
       FROM channel_listings l JOIN products p ON p.id = l.product_id
      WHERE l.status = 'linked' AND l.fulfilment = 'merchant' AND l.channel_qty IS NOT NULL AND p.merged_into IS NULL
      GROUP BY l.product_id`,
  ).all<{ productId: number; quantity: number }>();
  const updates = (results ?? []).filter((r) => Number.isInteger(r.quantity) && r.quantity >= 0);
  await setStock(env, updates, 'start', 'Starting count from eBay/Amazon listings');
  await env.DB.prepare(`UPDATE channel_listings SET pushed_qty = channel_qty WHERE channel_qty IS NOT NULL`).run();
  await setSetting(env, 'stock.start_taken_at', new Date().toISOString());
  return updates.length;
}

export async function enableCentralStock(env: Env): Promise<void> {
  const r = await readiness(env);
  if (!r.canEnable) throw new Error('Connect every eBay shop, clear the review list and take the starting count first.');
  // Sales from the moment the starting count was read onwards come off.
  await setSetting(env, 'stock.central_enabled', true);
  await setSetting(env, 'stock.enabled_at', r.startTakenAt);
}

export async function disableCentralStock(env: Env): Promise<void> {
  await setSetting(env, 'stock.central_enabled', false);
}

// ---------------------------------------------------------------------------
// The cron job
// ---------------------------------------------------------------------------

/**
 * One-off repair. Until orders were filtered by when they were placed, an
 * order placed before counting started came back when it was dispatched and
 * was taken off a second time (its quantity was already out of the starting
 * count). This re-reads orders changed since counting started, puts back each
 * such sale (a 'correction' in the stock history, once per sale), and rewinds
 * the order cursors so any sale that was skipped because its listing wasn't
 * linked yet is picked up by the normal check.
 */
export async function reconcileCountedSales(
  env: Env,
  budget: Budget,
  since: string,
): Promise<{ corrected: number; complete: boolean; moved: number[]; errors: string[] }> {
  const changes: StockChange[] = [];
  const errors: string[] = [];
  let complete = true;

  for (const account of await connectedEbayAccounts(env)) {
    const key = accountKey(account);
    try {
      const token = await getUserAccessToken(env, account);
      if (!token) continue;
      const pages = Math.min(5, budget.remaining);
      if (pages < 1) {
        complete = false;
        break;
      }
      const fetched = await fetchModifiedOrders(token, since, pages);
      budget.take(fetched.calls);
      if (!fetched.complete) complete = false;
      const cutoff = Date.parse(since);
      const before = fetched.orders.filter(
        (o) => o.creationDate && Date.parse(o.creationDate) < cutoff && o.cancelStatus?.cancelState !== 'CANCELED',
      );
      const refs = saleLines(before).map((l) => `ebay:${l.orderId}:${l.lineItemId}`);
      const taken = await recordedSales(env, 'ebay_sale', refs);
      const back = await putBackRefs(env, refs);
      for (const [ref, t] of taken) {
        if (back.has(ref)) continue;
        changes.push({
          productId: t.productId,
          delta: -t.delta,
          reason: 'correction',
          ref,
          note: `eBay order ${ref.split(':')[1]} was placed before centralised stock started, so it was already in the starting count`,
        });
      }
      if (fetched.complete) await saveCursor(env, 'ebay', key, since, null);
    } catch (err) {
      complete = false;
      errors.push(`eBay ${account.label}: ${errorText(err)}`);
    }
  }

  if (amazonConfigured(env)) {
    try {
      const account = env.AMAZON_SELLER_ID as string;
      const countFrom = await amazonCountingFrom(env, since);
      if (budget.take()) {
        const counter: CallCounter = { calls: 0 };
        const { orders, complete: done } = await fetchUpdatedOrders(env, counter, since);
        if (!done) complete = false;
        const { placedBefore } = classifyOrders(orders, countFrom);
        for (const orderId of placedBefore) {
          const { results } = await env.DB.prepare(
            `SELECT ref, product_id, delta FROM stock_movements WHERE reason = 'amazon_sale' AND ref LIKE ?`,
          )
            .bind(`amazon:${orderId}:%`)
            .all<{ ref: string; product_id: number; delta: number }>();
          const back = await putBackRefs(env, (results ?? []).map((r) => r.ref));
          for (const r of (results ?? []).filter((x) => !back.has(x.ref))) {
            changes.push({
              productId: r.product_id,
              delta: -r.delta,
              reason: 'correction',
              ref: r.ref,
              note: `Amazon order ${orderId} was placed before Amazon was connected, so it was already in its starting count`,
            });
          }
        }
        if (done) await saveCursor(env, 'amazon', account, countFrom, null);
      } else {
        complete = false;
      }
    } catch (err) {
      complete = false;
      errors.push(`Amazon: ${errorText(err)}`);
    }
  }

  const moved = await adjustStock(env, changes);
  return { corrected: changes.length, complete, moved, errors };
}

/**
 * Repair for eBay listings wrongly treated as ended: the sync used to ask the
 * public Browse API, which says "not found" for a listing that sold out and
 * was only hidden by Out-of-stock control. Those products were archived and
 * their listings set aside. Each is checked with eBay as the seller; a live
 * one is linked again and its product restored. Its website count wasn't kept
 * while it was set aside, so it takes eBay's real quantity (a 'correction' in
 * the history) rather than pushing a stale number out. A genuinely ended one
 * is marked so it isn't checked again.
 */
export async function reviveSoldOutListings(env: Env, budget: Budget): Promise<{ revived: number; errors: string[] }> {
  const { results } = await env.DB.prepare(
    `SELECT l.id, l.account, l.external_id, p.id AS product_id
       FROM channel_listings l JOIN products p ON p.id = l.product_id
      WHERE l.channel = 'ebay' AND l.status = 'ignored' AND p.status = 'archived' AND p.merged_into IS NULL
        AND p.source = 'ebay' AND COALESCE(l.last_error, '') != ?
      ORDER BY l.id LIMIT 40`,
  )
    .bind(ENDED_ON_EBAY)
    .all<{ id: number; account: string; external_id: string; product_id: number }>();
  const rows = results ?? [];
  if (!rows.length) return { revived: 0, errors: [] };
  const accounts = new Map((await connectedEbayAccounts(env)).map((a) => [accountKey(a), a]));
  const tokens = new Map<string, string | null>();
  const statements: D1PreparedStatement[] = [];
  const counts: { productId: number; quantity: number }[] = [];
  const errors: string[] = [];
  let revived = 0;
  for (const r of rows) {
    const account = accounts.get(r.account);
    if (!account) continue;
    if (!tokens.has(r.account)) tokens.set(r.account, await getUserAccessToken(env, account));
    const token = tokens.get(r.account);
    if (!token || !budget.take()) break;
    try {
      const s = await getItemStatus(token, r.external_id);
      if (s.state === 'live') {
        revived++;
        if (s.quantityAvailable !== null) counts.push({ productId: r.product_id, quantity: s.quantityAvailable });
        statements.push(
          env.DB.prepare(
            `UPDATE channel_listings SET status = 'linked', channel_qty = ?, pushed_qty = ?, last_error = NULL, updated_at = datetime('now') WHERE id = ?`,
          ).bind(s.quantityAvailable, s.quantityAvailable, r.id),
          env.DB.prepare(
            `UPDATE products SET status = CASE WHEN price_pence > 0 THEN 'active' ELSE 'draft' END, updated_at = datetime('now') WHERE id = ?`,
          ).bind(r.product_id),
        );
      } else if (s.state === 'ended') {
        statements.push(env.DB.prepare(`UPDATE channel_listings SET last_error = ? WHERE id = ?`).bind(ENDED_ON_EBAY, r.id));
      }
    } catch (err) {
      errors.push(`Checking eBay item ${r.external_id}: ${errorText(err)}`);
    }
  }
  if (statements.length) await env.DB.batch(statements);
  if (counts.length) {
    await setStock(env, counts, 'correction', "Re-linked eBay listing: set to eBay's quantity (it had been set aside by mistake)");
  }
  return { revived, errors };
}

/**
 * Reads each Amazon listing's price, main photo and description (one request
 * each, a few per run) for the listings that need them: ones waiting in
 * Review matches, so matching has more than a title, and ones behind a draft
 * product, which the details then fill in — price less the owner's price
 * bands, photo, description and a category from the sync's keyword rules.
 * Anything the owner already set is kept. Each listing is read once.
 */
export async function fillAmazonDetails(env: Env, budget: Budget, max = 20): Promise<{ read: number; filled: number; errors: string[] }> {
  const { results } = await env.DB.prepare(
    `SELECT l.id, l.external_id, l.title, l.product_id, p.status AS product_status
       FROM channel_listings l LEFT JOIN products p ON p.id = l.product_id
      WHERE l.channel = 'amazon' AND l.details_checked_at IS NULL
        AND (l.status = 'review' OR (l.status = 'linked' AND p.status = 'draft' AND p.merged_into IS NULL))
      ORDER BY (l.status = 'linked') DESC, l.id
      LIMIT ?`,
  )
    .bind(max)
    .all<{ id: number; external_id: string; title: string; product_id: number | null; product_status: string | null }>();
  const rows = results ?? [];
  if (!rows.length) return { read: 0, filled: 0, errors: [] };
  const [tiers, rules] = await Promise.all([
    getSetting<unknown>(env, 'ebay.price_tiers', []).then(normalisePriceTiers),
    loadCategoryRules(env),
  ]);
  const counter: CallCounter = { calls: 0 };
  const statements: D1PreparedStatement[] = [];
  const errors: string[] = [];
  let read = 0;
  let filled = 0;
  for (const r of rows) {
    if (!budget.take()) break;
    let d: { pricePence: number | null; imageUrl: string | null; description: string | null };
    try {
      d = await getListingDetails(env, counter, r.external_id);
    } catch (err) {
      if (err instanceof AmazonThrottledError) break; // Amazon's rate limit: the rest next run
      errors.push(`Amazon ${r.external_id}: ${errorText(err)}`);
      d = { pricePence: null, imageUrl: null, description: null };
    }
    read++;
    statements.push(
      env.DB.prepare(
        `UPDATE channel_listings SET price_pence = ?, image_url = ?, description = ?, details_checked_at = datetime('now') WHERE id = ?`,
      ).bind(d.pricePence, d.imageUrl, d.description, r.id),
    );
    if (r.product_id && r.product_status === 'draft') {
      filled++;
      const price = d.pricePence ? websitePriceFromEbay(d.pricePence, 0, tiers) : null;
      statements.push(
        env.DB.prepare(
          `UPDATE products SET
             price_pence = CASE WHEN price_pence <= 0 AND ? IS NOT NULL THEN ? ELSE price_pence END,
             image_url = COALESCE(image_url, ?),
             images_json = CASE WHEN (images_json IS NULL OR images_json IN ('', '[]')) AND ? IS NOT NULL THEN ? ELSE images_json END,
             description = COALESCE(NULLIF(trim(description), ''), ?),
             category_id = COALESCE(category_id, ?),
             updated_at = datetime('now')
           WHERE id = ?`,
        ).bind(
          price,
          price,
          d.imageUrl,
          d.imageUrl,
          d.imageUrl ? JSON.stringify([d.imageUrl]) : null,
          d.description,
          mapCategory({ title: r.title }, rules, null),
          r.product_id,
        ),
      );
    }
  }
  for (let i = 0; i < statements.length; i += 50) await env.DB.batch(statements.slice(i, i + 50));
  return { read, filled, errors };
}

/**
 * The same for products added from an eBay listing on the review screen: the
 * eBay sync only fills in products it imported itself, so these started as
 * £0 drafts. Reads each listing as the seller (price, photos, description)
 * and fills the draft — price less the owner's bands — keeping anything set.
 */
export async function fillEbayDrafts(env: Env, budget: Budget, max = 10): Promise<{ filled: number; errors: string[] }> {
  const { results } = await env.DB.prepare(
    `SELECT l.id, l.account, l.external_id, l.title, l.product_id
       FROM channel_listings l JOIN products p ON p.id = l.product_id
      WHERE l.channel = 'ebay' AND l.status = 'linked' AND l.details_checked_at IS NULL
        AND p.status = 'draft' AND p.merged_into IS NULL AND (p.price_pence <= 0 OR p.image_url IS NULL)
      ORDER BY l.id LIMIT ?`,
  )
    .bind(max)
    .all<{ id: number; account: string; external_id: string; title: string; product_id: number }>();
  const rows = results ?? [];
  if (!rows.length) return { filled: 0, errors: [] };
  const accounts = new Map((await connectedEbayAccounts(env)).map((a) => [accountKey(a), a]));
  const [tiers, rules] = await Promise.all([
    getSetting<unknown>(env, 'ebay.price_tiers', []).then(normalisePriceTiers),
    loadCategoryRules(env),
  ]);
  const tokens = new Map<string, string | null>();
  const statements: D1PreparedStatement[] = [];
  const errors: string[] = [];
  let filled = 0;
  for (const r of rows) {
    const account = accounts.get(r.account);
    if (!account) continue;
    if (!tokens.has(r.account)) tokens.set(r.account, await getUserAccessToken(env, account));
    const token = tokens.get(r.account);
    if (!token || !budget.take()) break;
    try {
      const d = await getItemDetails(token, r.external_id);
      const price = d.pricePence ? websitePriceFromEbay(d.pricePence, account.markup_percent, tiers) : null;
      filled++;
      statements.push(
        env.DB.prepare(
          `UPDATE channel_listings SET price_pence = ?, image_url = ?, description = ?, details_checked_at = datetime('now') WHERE id = ?`,
        ).bind(d.pricePence, d.images[0] ?? null, d.description, r.id),
        env.DB.prepare(
          `UPDATE products SET
             price_pence = CASE WHEN price_pence <= 0 AND ? IS NOT NULL THEN ? ELSE price_pence END,
             image_url = COALESCE(image_url, ?),
             images_json = CASE WHEN (images_json IS NULL OR images_json IN ('', '[]')) AND ? IS NOT NULL THEN ? ELSE images_json END,
             description = COALESCE(NULLIF(trim(description), ''), ?),
             category_id = COALESCE(category_id, ?),
             updated_at = datetime('now')
           WHERE id = ?`,
        ).bind(
          price,
          price,
          d.images[0] ?? null,
          d.images[0] ?? null,
          d.images.length ? JSON.stringify(d.images) : null,
          d.description,
          mapCategory({ title: r.title }, rules, null),
          r.product_id,
        ),
      );
    } catch (err) {
      errors.push(`eBay item ${r.external_id}: ${errorText(err)}`);
    }
  }
  if (statements.length) await env.DB.batch(statements);
  return { filled, errors };
}

/**
 * Descriptions for Amazon listings that came back without one: read from the
 * catalogue page by ASIN, once per listing, and given to the draft product
 * behind it if that has no description yet.
 */
export async function fillAmazonDescriptions(env: Env, budget: Budget, max = 15): Promise<{ filled: number; errors: string[] }> {
  const { results } = await env.DB.prepare(
    `SELECT l.id, l.asin, l.product_id, p.status AS product_status
       FROM channel_listings l LEFT JOIN products p ON p.id = l.product_id
      WHERE l.channel = 'amazon' AND l.asin IS NOT NULL AND l.details_checked_at IS NOT NULL
        AND l.catalog_checked_at IS NULL AND (l.description IS NULL OR trim(l.description) = '')
        AND (l.status = 'review' OR (l.status = 'linked' AND p.status = 'draft' AND p.merged_into IS NULL))
      ORDER BY (l.status = 'linked') DESC, l.id
      LIMIT ?`,
  )
    .bind(max)
    .all<{ id: number; asin: string; product_id: number | null; product_status: string | null }>();
  const rows = results ?? [];
  const counter: CallCounter = { calls: 0 };
  const statements: D1PreparedStatement[] = [];
  const errors: string[] = [];
  let filled = 0;
  for (const r of rows) {
    if (!budget.take()) break;
    let description: string | null = null;
    try {
      description = await getCatalogDescription(env, counter, r.asin);
    } catch (err) {
      if (err instanceof AmazonThrottledError) break;
      errors.push(`Amazon catalogue ${r.asin}: ${errorText(err)}`);
    }
    statements.push(
      env.DB.prepare(`UPDATE channel_listings SET description = COALESCE(?, description), catalog_checked_at = datetime('now') WHERE id = ?`).bind(
        description,
        r.id,
      ),
    );
    if (description && r.product_id && r.product_status === 'draft') {
      filled++;
      statements.push(
        env.DB.prepare(
          `UPDATE products SET description = COALESCE(NULLIF(trim(description), ''), ?), updated_at = datetime('now') WHERE id = ?`,
        ).bind(description, r.product_id),
      );
    }
  }
  for (let i = 0; i < statements.length; i += 50) await env.DB.batch(statements.slice(i, i + 50));
  return { filled, errors };
}

/** Marks a set-aside listing that eBay confirmed has ended, so it's never re-checked. */
const ENDED_ON_EBAY = 'Ended on eBay';

export interface StockJobSummary {
  at: string;
  /** Amazon drafts filled in from their listing's details this run. */
  filled?: number;
  /** eBay listings found live after being wrongly set aside as ended (see reviveSoldOutListings). */
  revived?: number;
  /** Sales put back by the one-off reconciliation (see reconcileCountedSales). */
  corrected?: number;
  merged: number;
  sales: number;
  cancellations: number;
  pushed: number;
  failed: number;
  left: number;
  errors: string[];
}

/** Runs every 5 minutes (wrangler.toml). */
export async function runStockJob(env: Env, now = new Date()): Promise<StockJobSummary> {
  const budget = new Budget(CRON_BUDGET);
  const summary: StockJobSummary = { at: now.toISOString(), merged: 0, sales: 0, cancellations: 0, pushed: 0, failed: 0, left: 0, errors: [] };

  // Nothing changes on the shop until the owner has started setting this up
  // (connected a shop): merging archives the spare copy of a duplicate.
  const connected = await connectedEbayAccounts(env);
  if (connected.length) {
    try {
      await ensureEbayListingRows(env);
      summary.merged = await mergeDuplicateProducts(env);
    } catch (err) {
      summary.errors.push(`Housekeeping: ${errorText(err)}`);
    }
  }

  const enabled = await centralStockEnabled(env);
  if (enabled) {
    const since = (await getSetting<string | null>(env, 'stock.enabled_at', null)) ?? now.toISOString();
    try {
      const r = await reviveSoldOutListings(env, budget);
      if (r.revived) summary.revived = r.revived;
      summary.errors.push(...r.errors);
    } catch (err) {
      summary.errors.push(`Revive: ${errorText(err)}`);
    }
    if (!(await getSetting<boolean>(env, 'stock.reconciled_v1', false))) {
      try {
        const r = await reconcileCountedSales(env, budget, since);
        summary.corrected = r.corrected;
        summary.errors.push(...r.errors);
        if (r.complete) await setSetting(env, 'stock.reconciled_v1', true);
      } catch (err) {
        summary.errors.push(`Reconcile: ${errorText(err)}`);
      }
    }
    for (const account of connected) {
      try {
        const r = await pollEbaySales(env, account, budget, since);
        summary.sales += r.sales;
        summary.cancellations += r.cancellations;
      } catch (err) {
        summary.errors.push(`eBay ${account.label}: ${errorText(err)}`);
      }
    }
    if (amazonConfigured(env)) {
      try {
        const r = await pollAmazonSales(env, budget, since);
        summary.sales += r.sales;
        summary.cancellations += r.cancellations;
      } catch (err) {
        summary.errors.push(`Amazon: ${errorText(err)}`);
      }
    }
    try {
      const p = await pushDirty(env, budget);
      summary.pushed = p.pushed;
      summary.failed = p.failed;
      summary.left = p.left;
    } catch (err) {
      summary.errors.push(`Push: ${errorText(err)}`);
    }
  }

  if (connected.length && budget.remaining >= 3) {
    try {
      const r = await fillEbayDrafts(env, budget, Math.min(10, budget.remaining - 1));
      if (r.filled) summary.filled = (summary.filled ?? 0) + r.filled;
      summary.errors.push(...r.errors.slice(0, 3));
    } catch (err) {
      summary.errors.push(`eBay draft details: ${errorText(err)}`);
    }
  }
  if (amazonConfigured(env) && budget.remaining >= 3) {
    try {
      const r = await fillAmazonDetails(env, budget, Math.min(20, budget.remaining - 1));
      if (r.filled) summary.filled = (summary.filled ?? 0) + r.filled;
      summary.errors.push(...r.errors.slice(0, 3));
    } catch (err) {
      summary.errors.push(`Amazon details: ${errorText(err)}`);
    }
    if (budget.remaining >= 3) {
      try {
        const r = await fillAmazonDescriptions(env, budget, Math.min(15, budget.remaining - 1));
        if (r.filled) summary.filled = (summary.filled ?? 0) + r.filled;
        summary.errors.push(...r.errors.slice(0, 3));
      } catch (err) {
        summary.errors.push(`Amazon descriptions: ${errorText(err)}`);
      }
    }
  }

  // Once an hour, with whatever budget is left: refresh listings so new ones
  // get matched and the Stock screen shows what each channel really says.
  if (now.getUTCMinutes() < 5 && connected.length) {
    try {
      await flagNearDuplicates(env);
    } catch (err) {
      summary.errors.push(`Duplicate check: ${errorText(err)}`);
    }
    for (const account of connected) {
      if (budget.remaining < 3) break;
      try {
        await importEbayListings(env, account, budget);
      } catch (err) {
        summary.errors.push(`eBay ${account.label} listings: ${errorText(err)}`);
      }
    }
    if (amazonConfigured(env) && budget.remaining >= 3) {
      try {
        await importAmazonListings(env, budget, budget.remaining - 1);
      } catch (err) {
        summary.errors.push(`Amazon listings: ${errorText(err)}`);
      }
    }
  }

  await setSetting(env, 'stock.last_run', summary);
  return summary;
}

// ---------------------------------------------------------------------------
// Admin views
// ---------------------------------------------------------------------------

export async function listingsForProducts(env: Env, productIds: number[]): Promise<Map<number, ChannelListing[]>> {
  const out = new Map<number, ChannelListing[]>();
  for (let i = 0; i < productIds.length; i += 90) {
    const slice = productIds.slice(i, i + 90);
    if (!slice.length) continue;
    const { results } = await env.DB.prepare(
      `SELECT * FROM channel_listings WHERE status = 'linked' AND product_id IN (${slice.map(() => '?').join(',')})
        ORDER BY channel, account`,
    )
      .bind(...slice)
      .all<ChannelListing>();
    for (const l of results ?? []) {
      const list = out.get(l.product_id as number) ?? [];
      list.push(l);
      out.set(l.product_id as number, list);
    }
  }
  return out;
}

/** Linked listings whose last stock update failed (shown on the Stock screen with the reason). */
export async function countFailedListings(env: Env): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM channel_listings WHERE status = 'linked' AND last_error IS NOT NULL`,
  ).first<{ n: number }>();
  return row?.n ?? 0;
}

/** How many listings are waiting on the owner in Review matches. */
export async function countListingsToReview(env: Env): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM channel_listings WHERE status = 'review'`).first<{ n: number }>();
  return row?.n ?? 0;
}

/** One marketplace listing, for describing a decision after it's made. */
export async function getChannelListing(env: Env, id: number): Promise<ChannelListing | null> {
  return env.DB.prepare('SELECT * FROM channel_listings WHERE id = ?').bind(id).first<ChannelListing>();
}

export async function listingsToReview(env: Env, limit = 100): Promise<(ChannelListing & { suggested_title: string | null })[]> {
  const { results } = await env.DB.prepare(
    `SELECT l.*, p.title AS suggested_title
       FROM channel_listings l LEFT JOIN products p ON p.id = l.suggested_product_id
      WHERE l.status = 'review'
      ORDER BY l.match_score DESC NULLS LAST, l.title
      LIMIT ?`,
  )
    .bind(limit)
    .all<ChannelListing & { suggested_title: string | null }>();
  return results ?? [];
}

/** Up to three product suggestions for a listing on the review screen. */
export async function suggestionsFor(env: Env, listing: ChannelListing): Promise<{ id: number; title: string; score: number }[]> {
  const candidates = await matchCandidates(env);
  const titles = new Map(candidates.map((c) => [c.id, c.title]));
  return matchListing({ title: listing.title, sku: listing.sku }, candidates)
    .suggestions.filter((s) => s.id !== listing.product_id)
    .map((s) => ({ id: s.id, title: titles.get(s.id) ?? '', score: s.score }));
}

/**
 * Resolves a listing on the review screen.
 * - link: it's this product. For an eBay listing that already has its own
 *   product (a near-duplicate), that product is merged into the chosen one.
 * - keep: a near-duplicate eBay listing that is really a different item.
 * - ignore: not tracked (it won't be counted or pushed).
 * - new: an Amazon-only item — becomes a draft product using the listing's count.
 */
export async function resolveListing(
  env: Env,
  listingId: number,
  action: { type: 'link'; productId: number } | { type: 'keep' } | { type: 'ignore' } | { type: 'new' },
): Promise<number[]> {
  const listing = await env.DB.prepare('SELECT * FROM channel_listings WHERE id = ?').bind(listingId).first<ChannelListing>();
  if (!listing) throw new Error('That listing no longer exists');

  if (action.type === 'keep') {
    // "Not the same item": stays linked to its own product and is never asked about again.
    if (!listing.product_id) throw new Error('This listing has no product of its own to keep');
    await env.DB.prepare(
      `UPDATE channel_listings SET status = 'linked', suggested_product_id = NULL, match_score = NULL, updated_at = datetime('now') WHERE id = ?`,
    )
      .bind(listingId)
      .run();
    return [];
  }

  if (action.type === 'ignore') {
    await env.DB.prepare(`UPDATE channel_listings SET status = 'ignored', updated_at = datetime('now') WHERE id = ?`).bind(listingId).run();
    return [];
  }

  if (action.type === 'new') {
    const slug = await uniqueSlug(env.DB, 'products', listing.title);
    const res = await env.DB.prepare(
      `INSERT INTO products (slug, title, sku, price_pence, stock, status, source) VALUES (?, ?, ?, 0, 0, 'draft', 'manual')`,
    )
      .bind(slug, listing.title, listing.sku)
      .run();
    const productId = res.meta.last_row_id as number;
    await linkListing(env, listing, productId);
    await setStock(env, [{ productId, quantity: listing.channel_qty ?? 0 }], 'start', `New product from ${listing.channel} listing`);
    return [productId];
  }

  const target = action.productId;
  const exists = await env.DB.prepare('SELECT id FROM products WHERE id = ? AND merged_into IS NULL').bind(target).first();
  if (!exists) throw new Error('That product no longer exists');
  if (listing.product_id && listing.product_id !== target) {
    // A near-duplicate eBay product: fold it into the chosen one.
    await mergeProducts(env, target, [listing.product_id]);
  }
  await linkListing(env, listing, target);
  return [target];
}

async function linkListing(env: Env, listing: ChannelListing, productId: number): Promise<void> {
  // The listing's real quantity is the baseline: if it differs from the
  // master count, the next push corrects it.
  await env.DB.prepare(
    `UPDATE channel_listings
        SET product_id = ?, status = 'linked', match_score = NULL, suggested_product_id = NULL,
            pushed_qty = COALESCE(pushed_qty, channel_qty), updated_at = datetime('now')
      WHERE id = ?`,
  )
    .bind(productId, listing.id)
    .run();
}

/** eBay near-duplicate products (different listings, similar titles) for the review list. */
export async function flagNearDuplicates(env: Env): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT l.id AS listingId, l.product_id AS productId, l.title
       FROM channel_listings l JOIN products p ON p.id = l.product_id
      WHERE l.channel = 'ebay' AND l.status = 'linked' AND p.merged_into IS NULL AND p.status != 'archived'
        AND l.match_score = 1 AND l.suggested_product_id IS NULL`,
  ).all<{ listingId: number; productId: number; title: string }>();
  const rows = results ?? [];
  const index = new MatchIndex(rows.map((r) => ({ id: r.productId, title: r.title })));
  let flagged = 0;
  const statements: D1PreparedStatement[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const best = matchListing({ title: r.title }, index).suggestions.find((s) => s.id !== r.productId);
    if (!best || best.score < 0.7) continue;
    const pair = [Math.min(r.productId, best.id), Math.max(r.productId, best.id)].join(':');
    if (seen.has(pair)) continue;
    seen.add(pair);
    // Ask about the newer product only; the older one stays linked either way.
    if (r.productId < best.id) continue;
    statements.push(
      env.DB.prepare(
        `UPDATE channel_listings SET status = 'review', suggested_product_id = ?, match_score = ?, updated_at = datetime('now') WHERE id = ?`,
      ).bind(best.id, best.score, r.listingId),
    );
    flagged++;
  }
  for (let i = 0; i < statements.length; i += 50) await env.DB.batch(statements.slice(i, i + 50));
  return flagged;
}

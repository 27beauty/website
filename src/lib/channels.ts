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
import { uniqueSlug } from './util';
import { adjustStock, centralStockEnabled, setStock, type StockChange } from './stock';
import { MatchIndex, exactDuplicateGroups, matchListing, type MatchCandidate } from './matching';
import { getUserAccessToken, sellerConnected } from './ebay/oauth';
import { getActiveListingsPage, reviseQuantities, REVISE_BATCH, type QuantityUpdate } from './ebay/trading';
import { fetchModifiedOrders, newestModified, saleLines } from './ebay/orders';
import {
  amazonConfigured,
  classifyOrders,
  fetchOrderLines,
  fetchUpdatedOrders,
  newestUpdate,
  searchListingsPage,
  setMerchantQuantity,
  type CallCounter,
} from './amazon/spapi';

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

export class Budget {
  constructor(public remaining: number) {}
  /** Reserves `n` requests; false (and nothing reserved) if there aren't enough. */
  take(n = 1): boolean {
    if (this.remaining < n) return false;
    this.remaining -= n;
    return true;
  }
}

/** Requests per cron run, leaving headroom under Workers Free's 50 for retries and tokens. */
const CRON_BUDGET = 40;
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

  const lines = saleLines(fetched.orders);
  const products = await listingProductMap(env, 'ebay', key, lines.map((l) => l.itemId));
  const refOf = (l: (typeof lines)[number]) => `ebay:${l.orderId}:${l.lineItemId}`;
  const already = await recordedSales(env, 'ebay_sale', lines.filter((l) => l.cancelled).map(refOf));

  const changes: StockChange[] = [];
  const unmatched: string[] = [];
  let sales = 0;
  let cancellations = 0;
  for (const l of lines) {
    const ref = refOf(l);
    if (l.cancelled) {
      const taken = already.get(ref);
      if (taken) {
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
  await saveCursor(env, 'ebay', key, fetched.complete ? newestModified(fetched.orders, cursor) : cursor, unmatched.length ? `Sold but not linked: ${unmatched.join('; ')}`.slice(0, 1000) : null);
  return { sales, cancellations, unmatched, moved };
}

export async function pollAmazonSales(env: Env, budget: Budget, since: string): Promise<PollResult> {
  const account = env.AMAZON_SELLER_ID as string;
  const cursor = await getCursor(env, 'amazon', account, since);
  const counter: CallCounter = { calls: 0 };
  if (!budget.take()) return { sales: 0, cancellations: 0, unmatched: [], moved: [] };
  const { orders, complete } = await fetchUpdatedOrders(env, counter, cursor);
  const { sold, cancelled } = classifyOrders(orders);

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
    for (const r of results ?? []) {
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
  const filter = productIds?.length ? `AND l.product_id IN (${productIds.map(() => '?').join(',')})` : '';
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
    .bind(...(productIds ?? []))
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

export interface StockJobSummary {
  at: string;
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

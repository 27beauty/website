import type { EbayAccount, Env } from '../../types';
import { normalisePriceTiers, websitePriceFromEbay, type PriceTier } from '../money';
import { getSetting } from '../settings';
import { centralStockEnabled } from '../stock';
import { uniqueSlug } from '../util';
import { normaliseTitle } from '../matching';
import { fetchBrowseListings, listingState } from './browse';
import { diffListings, locksFromRow, resolveUpdateFields, type ExistingProductRow, type ListingDiff } from './diff';
import { Budget, EbayRateLimitError } from './http';
import { fetchSellListings } from './inventory';
import { loadCategoryRules, mapCategory } from './mapping';
import type { CategoryRule, NormalisedListing } from './types';

export interface SyncResult {
  created: number;
  updated: number;
  ended: number;
  errors: string[];
  runId?: number;
}

/** Total listings fetched across the whole run, so a cron invocation stays inside Workers CPU/subrequest limits. */
const MAX_LISTINGS_PER_RUN = 1000;
/**
 * Outbound requests one sync run may make: Workers Free allows 50 per
 * invocation, less 6 for token refreshes and one retry. Searches, item
 * details and ended-listing checks all come out of it, split evenly between
 * the shops, so the whole allowance is used every run.
 */
const RUN_REQUEST_BUDGET = 44;
/** Of each shop's share, requests kept back for checking whether missing listings have ended. */
const END_CHECK_RESERVE = 4;
/** Consecutive missed runs before a product is archived — see the note at diff.toEnd below. */
const MISS_THRESHOLD = 144;
/** D1 batch() calls are chunked to this many statements to stay well under request-size limits. */
const BATCH_CHUNK_SIZE = 25;

/** Pulls listings from every active eBay account into the catalogue. */
export async function runEbaySync(env: Env, trigger: 'cron' | 'manual' | 'api'): Promise<SyncResult> {
  const syncEnabled = await getSetting<boolean>(env, 'ebay.sync_enabled', false);
  if (!syncEnabled && trigger === 'cron') {
    return { created: 0, updated: 0, ended: 0, errors: ['ebay.sync_enabled is off — cron sync skipped'] };
  }

  const result: SyncResult = { created: 0, updated: 0, ended: 0, errors: [] };
  let runId: number | undefined;

  try {
    const started = await env.DB.prepare(
      `INSERT INTO sync_runs (source, trigger, status) VALUES ('ebay', ?, 'running')`,
    )
      .bind(trigger)
      .run();
    runId = Number(started.meta.last_row_id);
    result.runId = runId;
  } catch (err) {
    result.errors.push(`Could not open a sync_runs row: ${errorMessage(err)}`);
    return result;
  }

  try {
    const importOutOfStock = await getSetting<boolean>(env, 'ebay.import_out_of_stock', false);
    // Once the website is the master stock count, the sync still imports new
    // listings and content but never writes a quantity (src/lib/stock.ts).
    const centralStock = await centralStockEnabled(env);
    const accounts = await listActiveAccounts(env);
    const rules = await loadCategoryRules(env);
    const priceTiers = normalisePriceTiers(await getSetting<unknown>(env, 'ebay.price_tiers', []));

    let remainingBudget = MAX_LISTINGS_PER_RUN;
    const requests = new Budget(RUN_REQUEST_BUDGET);

    for (const [i, account] of accounts.entries()) {
      if (remainingBudget <= 0) {
        result.errors.push(
          `Per-run cap of ${MAX_LISTINGS_PER_RUN} listings reached — "${account.label}" and any accounts after it were skipped this run`,
        );
        break;
      }
      // An even share of what's left, so a later shop still gets its turn.
      const share = new Budget(Math.floor(requests.remaining / (accounts.length - i)));
      const shareSize = share.remaining;
      try {
        const outcome = await syncAccount(env, account, {
          rules,
          importOutOfStock,
          centralStock,
          priceTiers,
          maxListings: remainingBudget,
          budget: share,
        });
        result.created += outcome.created;
        result.updated += outcome.updated;
        result.ended += outcome.ended;
        result.errors.push(...outcome.errors);
        remainingBudget -= outcome.fetched;
      } catch (err) {
        // One bad account must never abort the whole run.
        result.errors.push(`Account "${account.label}": ${errorMessage(err)}`);
      }
      requests.take(shareSize - share.remaining);
    }
  } catch (err) {
    result.errors.push(`Sync run failed: ${errorMessage(err)}`);
  } finally {
    await closeSyncRun(env, runId, result);
  }

  return result;
}

async function closeSyncRun(env: Env, runId: number | undefined, result: SyncResult): Promise<void> {
  if (runId === undefined) return;
  const status = result.errors.length ? 'error' : 'ok';
  const message = result.errors.length ? result.errors.join('; ').slice(0, 4000) : null;
  try {
    await env.DB.prepare(
      `UPDATE sync_runs
       SET status = ?, created_count = ?, updated_count = ?, ended_count = ?, message = ?, finished_at = datetime('now')
       WHERE id = ?`,
    )
      .bind(status, result.created, result.updated, result.ended, message, runId)
      .run();
  } catch {
    // Best-effort: if even closing the log row fails there is nothing more we can do here.
  }
}

interface AccountSyncOutcome {
  created: number;
  updated: number;
  ended: number;
  /** How many listings were actually fetched, so the caller can debit the shared per-run budget. */
  fetched: number;
  errors: string[];
}

async function syncAccount(
  env: Env,
  account: EbayAccount,
  opts: {
    rules: CategoryRule[];
    importOutOfStock: boolean;
    centralStock: boolean;
    priceTiers: PriceTier[];
    maxListings: number;
    budget: Budget;
  },
): Promise<AccountSyncOutcome> {
  const errors: string[] = [];
  // Products are matched to an account by this key, stored in ebay_account.
  // Uses seller_username (the account's stable eBay identity) rather than
  // account.label (an editable display name) — renaming an account's label
  // must not orphan its already-imported products.
  const accountKey = account.seller_username || `account:${account.id}`;
  const existingRows = await listAccountProducts(env, accountKey);
  const existingItemIds = new Set(
    existingRows.map((r) => r.ebay_item_id).filter((id): id is string => Boolean(id)),
  );
  const needsDescription = new Set(
    existingRows
      .filter((r) => r.ebay_item_id && !r.has_description && !r.content_locked && !r.merged_into)
      .map((r) => r.ebay_item_id as string),
  );
  const browseOptions = {
    maxListings: opts.maxListings,
    existingItemIds,
    needsDescription,
    budget: opts.budget,
    reserve: END_CHECK_RESERVE,
  };

  let listings: NormalisedListing[];
  let rateLimited = false;

  if (account.mode === 'sell') {
    const sell = await fetchSellListings(env, account, { maxListings: opts.maxListings });
    if (sell.notConfigured) {
      // No refresh token configured for a "sell" account — fall back to browse mode cleanly.
      const browse = await fetchBrowseListings(env, account, browseOptions);
      listings = browse.listings;
      rateLimited = browse.rateLimited;
      errors.push(`Account "${account.label}" is set to sell mode but has no refresh token — used browse mode instead`);
    } else {
      listings = sell.listings;
      rateLimited = sell.rateLimited;
    }
  } else {
    const browse = await fetchBrowseListings(env, account, browseOptions);
    listings = browse.listings;
    rateLimited = browse.rateLimited;
  }

  if (rateLimited) {
    errors.push(`Account "${account.label}": eBay rate limit (429) — stopped early for this run`);
  }

  const diff = diffListings(existingRows, listings);
  const endings = await reconcileEndedListings(env, account, accountKey, diff, opts.budget);
  errors.push(...endings.errors);
  // First, so a relist's item id is freed from its duplicate before anything else writes it.
  const statements: D1PreparedStatement[] = [...endings.statements];

  let created = 0;
  for (const listing of diff.toCreate) {
    if (listing.pricePence === null) {
      errors.push(`Skipped "${listing.title}" (${listing.itemId}): non-GBP or unreadable price`);
      continue;
    }
    if (!opts.importOutOfStock && listing.stock <= 0) {
      continue; // ebay.import_out_of_stock is off — don't create a listing that has nothing to sell
    }
    const slug = await uniqueSlug(env.DB, 'products', listing.title);
    const categoryId = mapCategory(listing, opts.rules, account.default_category_id);
    const pricePence = websitePriceFromEbay(listing.pricePence, account.markup_percent, opts.priceTiers);
    const status = account.auto_publish ? 'active' : 'draft';
    statements.push(
      env.DB.prepare(
        `INSERT INTO products
           (slug, title, description, category_id, price_pence, stock, image_url, images_json,
            status, source, ebay_item_id, ebay_sku, ebay_account, ebay_url, ebay_synced_at, ebay_stock)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ebay', ?, ?, ?, ?, datetime('now'), ?)`,
      ).bind(
        slug,
        listing.title,
        listing.description,
        categoryId,
        pricePence,
        listing.stock,
        listing.imageUrl,
        JSON.stringify(listing.images),
        status,
        listing.itemId,
        listing.sku,
        accountKey,
        listing.itemWebUrl,
        listing.stock,
      ),
    );
    created++;
  }

  let updated = 0;
  for (const { product, listing } of diff.toUpdate) {
    if (product.merged_into) continue;
    const locks = locksFromRow(product);
    if (opts.centralStock) locks.stockLocked = true;
    const categoryId = mapCategory(listing, opts.rules, account.default_category_id);
    const fields = resolveUpdateFields(locks, {
      pricePence:
        listing.pricePence === null
          ? null
          : websitePriceFromEbay(listing.pricePence, account.markup_percent, opts.priceTiers),
      stock: listing.stock,
      title: listing.title,
      description: listing.description,
      imageUrl: listing.imageUrl,
      imagesJson: JSON.stringify(listing.images),
    });
    if (listing.pricePence === null && !locks.priceLocked) {
      errors.push(`"${listing.title}" (${listing.itemId}): non-GBP or unreadable price — kept previous price`);
    }
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [key, value] of Object.entries(fields)) {
      sets.push(`${key} = ?`);
      values.push(value);
    }
    // Confirmed present in this run: un-archive it if a previous run wrongly
    // archived it (see the miss-count note below) or it was archived after
    // genuinely selling out and has now been relisted, and clear its miss
    // streak. What eBay reports is always recorded in ebay_stock, even when
    // stock_locked stops it overwriting the owner's own figure — the admin
    // stock screen shows the two side by side so a mismatch is visible.
    sets.push(
      `status = CASE WHEN status = 'archived' THEN 'active' ELSE status END`,
      `ebay_miss_count = 0`,
      // Rules only categorise products that have no category yet; one the
      // owner chose (or a category merge moved it to) stays put.
      `category_id = COALESCE(category_id, ?)`,
      `ebay_sku = ?`,
      `ebay_url = ?`,
      `ebay_stock = ?`,
      `ebay_synced_at = datetime('now')`,
      `updated_at = datetime('now')`,
    );
    values.push(categoryId, listing.sku, listing.itemWebUrl, listing.stock);
    values.push(product.id);
    statements.push(
      env.DB.prepare(`UPDATE products SET ${sets.join(', ')} WHERE id = ?`).bind(...values),
    );
    updated++;
  }

  // Browse mode's search is a keyword approximation, not a full inventory
  // listing (see browse.ts) — it samples the same fixed set of query terms
  // every run, so some real listings are *never* found by any run, not just
  // occasionally missed. A miss-count grace period only delays a false
  // archive, it can't prevent one, as seen in production: ~30 genuinely
  // in-stock products got auto-archived exactly MISS_THRESHOLD runs after
  // this was first "fixed" with a grace period alone. So: never auto-archive
  // for browse-mode accounts at all — only sell mode's fetch is a complete,
  // authoritative listing where "not present" reliably means "delisted".
  // Browse-mode delisting has to be manual (or wait for sell mode).
  // reconcileEndedListings() above is what ends listings in either mode: it
  // asks eBay about each missing listing individually rather than guessing.
  let ended = endings.ended;
  if (account.mode === 'sell') {
    for (const row of diff.toEnd) {
      if (row.merged_into) continue;
      const missCount = row.ebay_miss_count + 1;
      if (missCount >= MISS_THRESHOLD) {
        ended++;
        statements.push(
          env.DB.prepare(
            `UPDATE products
             SET ${opts.centralStock ? '' : 'stock = 0, '}ebay_stock = 0, status = 'archived', ebay_miss_count = ?, ebay_synced_at = datetime('now'), updated_at = datetime('now')
             WHERE id = ?`,
          ).bind(missCount, row.id),
        );
      } else {
        statements.push(
          env.DB.prepare(`UPDATE products SET ebay_miss_count = ? WHERE id = ?`).bind(missCount, row.id),
        );
      }
    }
  }

  for (const chunk of chunkStatements(statements, BATCH_CHUNK_SIZE)) {
    await env.DB.batch(chunk);
  }

  await env.DB.prepare(`UPDATE ebay_accounts SET last_sync_at = datetime('now') WHERE id = ?`)
    .bind(account.id)
    .run();

  return { created, updated, ended, fetched: listings.length, errors };
}

/**
 * Products whose listing wasn't in this run's results. The keyword search
 * misses some live listings, so each is checked with eBay (as many per run
 * as the request budget allows)
 * before anything happens to it. A listing that has ended:
 *
 * - was relisted (a live listing in the same shop with the same title): the
 *   existing product takes over the new listing, so it keeps its page,
 *   category, locks and coupons. A duplicate the relist already created is
 *   folded into it and archived.
 * - wasn't relisted: the product is archived, which takes it off the shop.
 *
 * Mutates `diff` so the rest of the sync sees the result: adopted listings
 * move from toCreate to toUpdate, and handled rows leave toEnd.
 */
async function reconcileEndedListings(
  env: Env,
  account: EbayAccount,
  accountKey: string,
  diff: ListingDiff,
  budget: Budget,
): Promise<{ statements: D1PreparedStatement[]; ended: number; errors: string[] }> {
  const statements: D1PreparedStatement[] = [];
  const errors: string[] = [];
  const keyOf = (title: string | undefined) => normaliseTitle(title ?? '').join(' ');
  const liveKeys = new Set([...diff.toCreate.map((l) => keyOf(l.title)), ...diff.toUpdate.map((u) => keyOf(u.listing.title))]);
  liveKeys.delete('');
  const looksRelisted = (row: ExistingProductRow) => liveKeys.has(keyOf(row.title));

  const missing = diff.toEnd.filter((r) => !r.merged_into && r.status !== 'archived');
  missing.sort(
    (a, b) =>
      Number(looksRelisted(b)) - Number(looksRelisted(a)) || (a.ebay_synced_at ?? '').localeCompare(b.ebay_synced_at ?? ''),
  );

  const ended: ExistingProductRow[] = [];
  for (const row of missing) {
    if (!budget.take()) break; // the rest are checked on later runs, least recently confirmed first
    let state;
    try {
      state = await listingState(env, account, row.ebay_item_id as string);
    } catch (err) {
      if (err instanceof EbayRateLimitError) break;
      errors.push(`Account "${account.label}": could not check whether "${row.title}" has ended: ${errorMessage(err)}`);
      continue;
    }
    if (state === 'ended') ended.push(row);
    else if (state === 'live') {
      // Still on eBay, just not found by the search: check the others first next time.
      statements.push(env.DB.prepare(`UPDATE products SET ebay_synced_at = datetime('now') WHERE id = ?`).bind(row.id));
    }
  }
  // Archived earlier (ended, or sold out) and now listed again: take the new listing over too.
  const archived = diff.toEnd.filter((r) => !r.merged_into && r.status === 'archived' && looksRelisted(r));

  const handled = new Set<number>();
  let endedCount = 0;
  for (const row of [...ended, ...archived]) {
    const key = keyOf(row.title);
    const confirmedThisRun = row.status !== 'archived';
    const twinAt = confirmedThisRun
      ? diff.toUpdate.findIndex(
          (u) =>
            keyOf(u.listing.title) === key &&
            !handled.has(u.product.id) &&
            (!u.product.merged_into || u.product.merged_into === row.id),
        )
      : -1;
    const newAt = twinAt < 0 && key ? diff.toCreate.findIndex((l) => keyOf(l.title) === key) : -1;

    if (key && twinAt >= 0) {
      const { product: twin, listing } = diff.toUpdate[twinAt];
      statements.push(
        env.DB.prepare(
          `UPDATE products SET ebay_item_id = NULL, merged_into = ?, status = 'archived', updated_at = datetime('now') WHERE id = ?`,
        ).bind(row.id, twin.id),
        env.DB.prepare(`UPDATE coupons SET product_id = ? WHERE product_id = ?`).bind(row.id, twin.id),
        env.DB.prepare(`UPDATE channel_listings SET product_id = ?, updated_at = datetime('now') WHERE product_id = ?`).bind(
          row.id,
          twin.id,
        ),
        env.DB.prepare(`UPDATE products SET ebay_item_id = ? WHERE id = ?`).bind(listing.itemId, row.id),
      );
      diff.toUpdate[twinAt] = { product: { ...row, merged_into: null }, listing };
      handled.add(twin.id);
    } else if (newAt >= 0) {
      const [listing] = diff.toCreate.splice(newAt, 1);
      statements.push(env.DB.prepare(`UPDATE products SET ebay_item_id = ? WHERE id = ?`).bind(listing.itemId, row.id));
      diff.toUpdate.push({ product: row, listing });
    } else if (confirmedThisRun) {
      endedCount++;
      statements.push(
        env.DB.prepare(
          `UPDATE products SET status = 'archived', ebay_stock = 0, ebay_synced_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
        ).bind(row.id),
      );
    } else {
      continue;
    }
    handled.add(row.id);
    // Never send stock to a listing that has ended.
    statements.push(
      env.DB.prepare(
        `UPDATE channel_listings SET status = 'ignored', updated_at = datetime('now')
         WHERE channel = 'ebay' AND account = ? AND external_id = ?`,
      ).bind(accountKey, bareItemId(row.ebay_item_id as string)),
    );
  }

  diff.toEnd = diff.toEnd.filter((r) => !handled.has(r.id));
  return { statements, ended: endedCount, errors };
}

/** Browse mode stores "v1|<item number>|0"; channel_listings keeps the bare item number. */
function bareItemId(itemId: string): string {
  const m = /^v1\|([^|]+)\|/.exec(itemId);
  return m ? m[1] : itemId;
}

async function listActiveAccounts(env: Env): Promise<EbayAccount[]> {
  const { results } = await env.DB.prepare('SELECT * FROM ebay_accounts WHERE active = 1').all<EbayAccount>();
  return results ?? [];
}

async function listAccountProducts(env: Env, accountLabel: string): Promise<ExistingProductRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, ebay_item_id, price_locked, stock_locked, content_locked, ebay_miss_count, merged_into,
            title, status, ebay_synced_at, (description IS NOT NULL AND trim(description) != '') AS has_description
     FROM products WHERE source = 'ebay' AND ebay_account = ?`,
  )
    .bind(accountLabel)
    .all<ExistingProductRow>();
  return results ?? [];
}

function chunkStatements(statements: D1PreparedStatement[], size: number): D1PreparedStatement[][] {
  if (!statements.length) return [];
  const chunks: D1PreparedStatement[][] = [];
  for (let i = 0; i < statements.length; i += size) chunks.push(statements.slice(i, i + size));
  return chunks;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

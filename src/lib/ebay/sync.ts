import type { EbayAccount, Env } from '../../types';
import { applyMarkup } from '../money';
import { getSetting } from '../settings';
import { centralStockEnabled } from '../stock';
import { uniqueSlug } from '../util';
import { fetchBrowseListings } from './browse';
import { diffListings, locksFromRow, resolveUpdateFields, type ExistingProductRow } from './diff';
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
 * Per-account cap on the extra GET /item/{id} enrichment call (Browse mode),
 * only spent on newly-created products. Kept modest because Browse mode's
 * search itself now costs several subrequests per account (see browse.ts's
 * QUERY_TERMS) and a run processes every active account in one invocation,
 * sharing one Workers subrequest budget (50 on the Free plan).
 */
const MAX_ENRICH_CALLS_PER_ACCOUNT = 10;
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

    let remainingBudget = MAX_LISTINGS_PER_RUN;

    for (const account of accounts) {
      if (remainingBudget <= 0) {
        result.errors.push(
          `Per-run cap of ${MAX_LISTINGS_PER_RUN} listings reached — "${account.label}" and any accounts after it were skipped this run`,
        );
        break;
      }
      try {
        const outcome = await syncAccount(env, account, {
          rules,
          importOutOfStock,
          centralStock,
          maxListings: remainingBudget,
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
  opts: { rules: CategoryRule[]; importOutOfStock: boolean; centralStock: boolean; maxListings: number },
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

  let listings: NormalisedListing[];
  let rateLimited = false;

  if (account.mode === 'sell') {
    const sell = await fetchSellListings(env, account, { maxListings: opts.maxListings });
    if (sell.notConfigured) {
      // No refresh token configured for a "sell" account — fall back to browse mode cleanly.
      const browse = await fetchBrowseListings(env, account, {
        maxListings: opts.maxListings,
        existingItemIds,
        maxEnrichCalls: MAX_ENRICH_CALLS_PER_ACCOUNT,
      });
      listings = browse.listings;
      rateLimited = browse.rateLimited;
      errors.push(`Account "${account.label}" is set to sell mode but has no refresh token — used browse mode instead`);
    } else {
      listings = sell.listings;
      rateLimited = sell.rateLimited;
    }
  } else {
    const browse = await fetchBrowseListings(env, account, {
      maxListings: opts.maxListings,
      existingItemIds,
      maxEnrichCalls: MAX_ENRICH_CALLS_PER_ACCOUNT,
    });
    listings = browse.listings;
    rateLimited = browse.rateLimited;
  }

  if (rateLimited) {
    errors.push(`Account "${account.label}": eBay rate limit (429) — stopped early for this run`);
  }

  const diff = diffListings(existingRows, listings);
  const statements: D1PreparedStatement[] = [];

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
    const pricePence = applyMarkup(listing.pricePence, account.markup_percent);
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
      pricePence: listing.pricePence === null ? null : applyMarkup(listing.pricePence, account.markup_percent),
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
  let ended = 0;
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

async function listActiveAccounts(env: Env): Promise<EbayAccount[]> {
  const { results } = await env.DB.prepare('SELECT * FROM ebay_accounts WHERE active = 1').all<EbayAccount>();
  return results ?? [];
}

async function listAccountProducts(env: Env, accountLabel: string): Promise<ExistingProductRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, ebay_item_id, price_locked, stock_locked, content_locked, ebay_miss_count, merged_into
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

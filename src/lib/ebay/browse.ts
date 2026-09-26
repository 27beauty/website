/**
 * Browse-mode client: application access token + Browse API paging.
 *
 * KNOWN LIMITATION: the Browse API's item_summary/search is a keyword search
 * surface, not a seller-inventory listing — it rejects a request that has
 * only a `sellers` filter and no `q`/`category_ids`/`epid`/`gtin` (HTTP 400
 * errorId 12001), and even with a `q` it only returns items whose title
 * matches that term. There is no "all items from this seller" call available
 * without seller OAuth consent (sell mode). To approximate full coverage we
 * run the seller filter across a fixed set of common English words/numbers
 * (QUERY_TERMS below) and merge the results by itemId — this finds most of a
 * typical catalogue but is not guaranteed exhaustive. It also exposes stock
 * as a coarse availability bucket rather than an exact quantity (see
 * pricing.ts availabilityToStock), and item detail (description, extra
 * images) costs a second call per item — so it is only fetched for
 * newly-created products, bounded by `maxEnrichCalls`. For exact stock and
 * complete catalogue coverage, use sell mode instead.
 */

import type { Env, EbayAccount } from '../../types';
import type { BrowseItemDetail, BrowseItemSummary, BrowseSearchResponse, NormalisedListing } from './types';
import { getAppAccessToken } from './oauth';
import { EbayRateLimitError, fetchWithRetry } from './http';
import { amountToPence, availabilityToStock } from './pricing';

const BROWSE_SEARCH_URL = 'https://api.ebay.com/buy/browse/v1/item_summary/search';
const BROWSE_ITEM_URL = 'https://api.ebay.com/buy/browse/v1/item';
const PAGE_SIZE = 200;
const MARKETPLACE_ID = 'EBAY_GB';

// Common words/numbers run one at a time against the seller filter and
// merged by itemId, to approximate "all of this seller's listings" (see the
// KNOWN LIMITATION note above — Browse API has no true seller-listing call).
// Kept short and ordered by measured marginal coverage (tested against real
// seller accounts) because each term costs a Workers subrequest, and a sync
// run processes every active account in one invocation, sharing one
// subrequest budget (50 on the Workers Free plan).
const QUERY_TERMS = ['new', 'and', 'for', 'with', 'the', 'pack', '1', '2', '3'];
/** Stop trying further terms for an account once this many in a row add nothing new. */
const PLATEAU_TERM_LIMIT = 2;

export interface BrowseFetchOptions {
  /** Overall cap on listings pulled for this account this run. */
  maxListings: number;
  /** ebay_item_id values that already have a product row — anything else is "new" and eligible for enrichment. */
  existingItemIds: Set<string>;
  /** Cap on enrichment (GET /item/{id}) calls for this account this run. */
  maxEnrichCalls: number;
}

export interface BrowseFetchResult {
  listings: NormalisedListing[];
  /** Set when the account hit HTTP 429 partway through paging or enrichment. */
  rateLimited: boolean;
}

export async function fetchBrowseListings(
  env: Env,
  account: EbayAccount,
  options: BrowseFetchOptions,
): Promise<BrowseFetchResult> {
  if (!account.seller_username) return { listings: [], rateLimited: false };

  const token = await getAppAccessToken(env, account);
  const searchHeaders = {
    Authorization: `Bearer ${token}`,
    'X-EBAY-C-MARKETPLACE-ID': MARKETPLACE_ID,
  };

  const summariesById = new Map<string, BrowseItemSummary>();
  let rateLimited = false;
  const filter = encodeURIComponent(`sellers:{${account.seller_username}}`);

  let plateauStreak = 0;
  termLoop: for (const term of QUERY_TERMS) {
    if (summariesById.size >= options.maxListings) break;
    const sizeBeforeTerm = summariesById.size;
    let offset = 0;
    while (summariesById.size < options.maxListings) {
      const limit = Math.min(PAGE_SIZE, options.maxListings - summariesById.size);
      const url = `${BROWSE_SEARCH_URL}?q=${encodeURIComponent(term)}&filter=${filter}&limit=${limit}&offset=${offset}`;
      let res: Response;
      try {
        res = await fetchWithRetry(url, { headers: searchHeaders });
      } catch (err) {
        if (err instanceof EbayRateLimitError) {
          rateLimited = true;
          break termLoop;
        }
        throw err;
      }
      if (!res.ok) throw new Error(`eBay Browse search failed: HTTP ${res.status}`);
      const json = (await res.json()) as BrowseSearchResponse;
      const page = json.itemSummaries ?? [];
      for (const item of page) summariesById.set(item.itemId, item);
      if (page.length < limit) break; // reached the last page for this term
      offset += page.length;
    }
    if (summariesById.size === sizeBeforeTerm && sizeBeforeTerm > 0) {
      plateauStreak++;
      if (plateauStreak >= PLATEAU_TERM_LIMIT) break;
    } else {
      plateauStreak = 0;
    }
  }
  const summaries = [...summariesById.values()];

  const listings: NormalisedListing[] = [];
  let enrichCalls = 0;
  for (const summary of summaries) {
    let detail: BrowseItemDetail | null = null;
    const isNew = !options.existingItemIds.has(summary.itemId);
    if (!rateLimited && isNew && enrichCalls < options.maxEnrichCalls) {
      enrichCalls++;
      try {
        detail = await fetchItemDetail(token, summary.itemId);
      } catch (err) {
        if (err instanceof EbayRateLimitError) rateLimited = true;
        detail = null; // enrichment is best-effort; fall back to the summary
      }
    }
    listings.push(normaliseBrowseItem(summary, detail));
  }

  return { listings, rateLimited };
}

export type ListingState = 'live' | 'ended' | 'unknown';

/**
 * Whether one listing still exists on eBay. The keyword search above can
 * miss live listings, so "not in the search" never means "ended" on its own;
 * this asks eBay about the one item. eBay answers 404 (errorId 11001) for a
 * listing that has ended or been removed. Anything else unexpected is
 * 'unknown', and the caller leaves the product alone.
 */
export async function listingState(env: Env, account: EbayAccount, itemId: string): Promise<ListingState> {
  const token = await getAppAccessToken(env, account);
  // Browse mode stores RESTful ids ("v1|123|0"); sell mode stores eBay's plain item number.
  const url = /^\d+$/.test(itemId)
    ? `${BROWSE_ITEM_URL}/get_item_by_legacy_id?legacy_item_id=${itemId}`
    : `${BROWSE_ITEM_URL}/${encodeURIComponent(itemId)}`;
  const res = await fetchWithRetry(url, {
    headers: { Authorization: `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': MARKETPLACE_ID },
  });
  if (res.status === 404 || res.status === 410) return 'ended';
  if (!res.ok) return 'unknown';
  const item = (await res.json()) as { itemEndDate?: string };
  if (item.itemEndDate && Date.parse(item.itemEndDate) <= Date.now()) return 'ended';
  return 'live';
}

async function fetchItemDetail(token: string, itemId: string): Promise<BrowseItemDetail | null> {
  const res = await fetchWithRetry(`${BROWSE_ITEM_URL}/${encodeURIComponent(itemId)}`, {
    headers: { Authorization: `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': MARKETPLACE_ID },
  });
  if (!res.ok) return null;
  return (await res.json()) as BrowseItemDetail;
}

export function normaliseBrowseItem(
  summary: BrowseItemSummary,
  detail: BrowseItemDetail | null,
): NormalisedListing {
  const bucket = summary.estimatedAvailabilities?.[0]?.estimatedAvailabilityStatus ?? null;
  const images = [summary.image?.imageUrl, ...(summary.additionalImages ?? []).map((i) => i.imageUrl)].filter(
    (u): u is string => Boolean(u),
  );
  const category = summary.categories?.[0];
  return {
    itemId: summary.itemId,
    title: summary.title,
    description: detail?.description ?? detail?.shortDescription ?? null,
    pricePence: amountToPence(summary.price ?? null),
    currency: summary.price?.currency ?? 'GBP',
    stock: availabilityToStock(bucket),
    stockIsEstimate: true,
    imageUrl: images[0] ?? null,
    images,
    itemWebUrl: summary.itemWebUrl ?? summary.itemAffiliateWebUrl ?? null,
    ebayCategoryId: category?.categoryId ?? null,
    ebayCategoryName: category?.categoryName ?? null,
    sku: null,
  };
}

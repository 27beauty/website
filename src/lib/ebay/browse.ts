/**
 * Browse-mode client: application access token + Browse API paging.
 *
 * KNOWN LIMITATION: the Browse API is a public search surface, not a seller
 * inventory feed. It only returns items eBay's search indexes as belonging to
 * `sellers:{username}`, exposes stock as a coarse availability bucket rather
 * than an exact quantity (see pricing.ts availabilityToStock), and item
 * detail (description, extra images) costs a second call per item — so it is
 * only fetched for newly-created products, bounded by `maxEnrichCalls`.
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

export interface BrowseFetchOptions {
  /** Overall cap on listings pulled for this account this run. */
  maxListings: number;
  /** Item ids with no existing product yet — only these get the enrichment call. */
  newItemIds: Set<string>;
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

  const summaries: BrowseItemSummary[] = [];
  let offset = 0;
  let rateLimited = false;

  while (summaries.length < options.maxListings) {
    const limit = Math.min(PAGE_SIZE, options.maxListings - summaries.length);
    const filter = encodeURIComponent(`sellers:${account.seller_username}`);
    const url = `${BROWSE_SEARCH_URL}?filter=${filter}&limit=${limit}&offset=${offset}`;
    let res: Response;
    try {
      res = await fetchWithRetry(url, { headers: searchHeaders });
    } catch (err) {
      if (err instanceof EbayRateLimitError) {
        rateLimited = true;
        break;
      }
      throw err;
    }
    if (!res.ok) throw new Error(`eBay Browse search failed: HTTP ${res.status}`);
    const json = (await res.json()) as BrowseSearchResponse;
    const page = json.itemSummaries ?? [];
    summaries.push(...page);
    if (page.length < limit) break; // reached the last page
    offset += page.length;
  }

  const listings: NormalisedListing[] = [];
  let enrichCalls = 0;
  for (const summary of summaries) {
    let detail: BrowseItemDetail | null = null;
    if (!rateLimited && options.newItemIds.has(summary.itemId) && enrichCalls < options.maxEnrichCalls) {
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
  };
}

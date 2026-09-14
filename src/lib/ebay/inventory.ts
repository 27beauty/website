/**
 * Sell-mode client: user access token (refresh token grant) + Sell Inventory
 * API paging. Gives an exact stock quantity and the seller's own price,
 * unlike Browse mode's availability bucket — always preferred when a
 * refresh token is configured for the account.
 */

import type { Env, EbayAccount } from '../../types';
import type {
  NormalisedListing,
  SellInventoryItem,
  SellInventoryResponse,
  SellOffer,
  SellOfferResponse,
} from './types';
import { getUserAccessToken } from './oauth';
import { EbayRateLimitError, fetchWithRetry } from './http';
import { amountToPence } from './pricing';

const INVENTORY_URL = 'https://api.ebay.com/sell/inventory/v1/inventory_item';
const OFFER_URL = 'https://api.ebay.com/sell/inventory/v1/offer';
const BULK_UPDATE_URL = 'https://api.ebay.com/sell/inventory/v1/bulk_update_price_quantity';
const PAGE_SIZE = 100;
/** eBay accepts at most 25 SKUs per bulk_update_price_quantity call. */
const BULK_UPDATE_CHUNK_SIZE = 25;

export interface SellFetchOptions {
  maxListings: number;
}

export interface SellFetchResult {
  listings: NormalisedListing[];
  rateLimited: boolean;
  /** True when the account has no usable refresh token — caller should fall back to browse mode. */
  notConfigured: boolean;
}

export async function fetchSellListings(
  env: Env,
  account: EbayAccount,
  options: SellFetchOptions,
): Promise<SellFetchResult> {
  const token = await getUserAccessToken(env, account);
  if (!token) return { listings: [], rateLimited: false, notConfigured: true };

  const headers = { Authorization: `Bearer ${token}` };
  const items: SellInventoryItem[] = [];
  let offset = 0;
  let rateLimited = false;

  while (items.length < options.maxListings) {
    const limit = Math.min(PAGE_SIZE, options.maxListings - items.length);
    const url = `${INVENTORY_URL}?limit=${limit}&offset=${offset}`;
    let res: Response;
    try {
      res = await fetchWithRetry(url, { headers });
    } catch (err) {
      if (err instanceof EbayRateLimitError) {
        rateLimited = true;
        break;
      }
      throw err;
    }
    if (!res.ok) throw new Error(`eBay Sell inventory_item failed: HTTP ${res.status}`);
    const json = (await res.json()) as SellInventoryResponse;
    const page = json.inventoryItems ?? [];
    items.push(...page);
    if (page.length < limit) break;
    offset += page.length;
  }

  const listings: NormalisedListing[] = [];
  for (const item of items) {
    if (rateLimited) break;
    let offer: SellOffer | null = null;
    try {
      offer = await fetchOfferForSku(token, item.sku);
    } catch (err) {
      if (err instanceof EbayRateLimitError) rateLimited = true;
    }
    listings.push(normaliseSellItem(item, offer));
  }

  return { listings, rateLimited, notConfigured: false };
}

export interface StockUpdate {
  sku: string;
  /** Absolute new quantity (not a delta) — the site's current known stock for that product. */
  quantity: number;
}

/**
 * Pushes our current stock number to eBay for a sell-mode account, so a sale
 * on our own site (or anywhere else we know about) is reflected there too —
 * the "centralised quantity" half of the sync that reading exact stock alone
 * doesn't provide. Best-effort: throws on total failure, but a per-SKU
 * failure inside a batch doesn't stop the others (see the error collection
 * below).
 */
export async function updateEbayStock(
  env: Env,
  account: EbayAccount,
  updates: StockUpdate[],
): Promise<{ errors: string[] }> {
  if (updates.length === 0) return { errors: [] };
  const token = await getUserAccessToken(env, account);
  if (!token) return { errors: ['No refresh token configured for this account'] };

  const errors: string[] = [];
  for (let i = 0; i < updates.length; i += BULK_UPDATE_CHUNK_SIZE) {
    const chunk = updates.slice(i, i + BULK_UPDATE_CHUNK_SIZE);
    const res = await fetchWithRetry(BULK_UPDATE_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: chunk.map((u) => ({
          sku: u.sku,
          shipToLocationAvailability: { quantity: Math.max(0, u.quantity) },
        })),
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      errors.push(`bulk_update_price_quantity: HTTP ${res.status} ${text.slice(0, 300)}`);
      continue;
    }
    const json = (await res.json()) as { responses?: Array<{ sku: string; statusCode: number; errors?: Array<{ message: string }> }> };
    for (const r of json.responses ?? []) {
      if (r.statusCode >= 400) {
        errors.push(`SKU ${r.sku}: ${r.errors?.[0]?.message ?? `HTTP ${r.statusCode}`}`);
      }
    }
  }
  return { errors };
}

async function fetchOfferForSku(token: string, sku: string): Promise<SellOffer | null> {
  const url = `${OFFER_URL}?sku=${encodeURIComponent(sku)}`;
  const res = await fetchWithRetry(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return null;
  const json = (await res.json()) as SellOfferResponse;
  return json.offers?.[0] ?? null;
}

export function normaliseSellItem(item: SellInventoryItem, offer: SellOffer | null): NormalisedListing {
  const listingId = offer?.listing?.listingId ?? null;
  const images = item.product?.imageUrls ?? [];
  return {
    // Browse mode stores itemId as "v1|<listingId>|0" (the Browse API's own
    // itemId format). Sell mode's listingId is the same underlying numeric
    // eBay listing ID, so it must be wrapped the same way — otherwise a
    // product synced under one mode is invisible to the other, and switching
    // an account's mode duplicate-imports every listing (see the
    // account-label matching bug fixed earlier for the same root cause).
    itemId: listingId ? `v1|${listingId}|0` : item.sku,
    title: item.product?.title ?? item.sku,
    description: offer?.listingDescription ?? item.product?.description ?? null,
    pricePence: offer?.pricingSummary?.price ? amountToPence(offer.pricingSummary.price) : null,
    currency: offer?.pricingSummary?.price?.currency ?? 'GBP',
    stock: offer?.availableQuantity ?? item.availability?.shipToLocationAvailability?.quantity ?? 0,
    stockIsEstimate: false,
    imageUrl: images[0] ?? null,
    images,
    itemWebUrl: listingId ? `https://www.ebay.co.uk/itm/${listingId}` : null,
    ebayCategoryId: offer?.categoryId ?? null,
    ebayCategoryName: null,
    sku: item.sku,
  };
}

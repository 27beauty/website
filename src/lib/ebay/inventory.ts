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
const PAGE_SIZE = 100;

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

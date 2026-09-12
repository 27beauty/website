/**
 * eBay API shapes and internal sync types.
 * Kept separate from src/types.ts (owned by another module) so this whole
 * directory can be developed independently.
 */

import type { EbayAccount } from '../../types';

/** eBay's `Amount` shape, e.g. { "value": "12.99", "currency": "GBP" }. */
export interface EbayAmount {
  value: string;
  currency: string;
}

export type EbayAvailabilityBucket = 'IN_STOCK' | 'LIMITED_STOCK' | 'OUT_OF_STOCK' | string;

/** A normalised listing, produced by either the Browse or Sell client, that
 * the sync engine diffs against the catalogue. Keeping this shape identical
 * for both modes lets upsertListing() stay agnostic of where the data came from. */
export interface NormalisedListing {
  itemId: string;
  title: string;
  description: string | null;
  /** Price in integer pence, already GBP. Null when the source price could not be trusted (e.g. non-GBP). */
  pricePence: number | null;
  currency: string;
  /** Exact quantity when known (sell mode), otherwise a bucket-derived estimate (browse mode). */
  stock: number;
  /** True when stock is an estimate derived from an availability bucket rather than an exact count. */
  stockIsEstimate: boolean;
  imageUrl: string | null;
  images: string[];
  itemWebUrl: string | null;
  /** eBay's own leaf category name/id, when available, for mapCategory(). */
  ebayCategoryId: string | null;
  ebayCategoryName: string | null;
}

/** Minimal shape of a Browse API item_summary entry (search results page). */
export interface BrowseItemSummary {
  itemId: string;
  title: string;
  price?: EbayAmount;
  image?: { imageUrl?: string };
  additionalImages?: Array<{ imageUrl?: string }>;
  itemWebUrl?: string;
  itemAffiliateWebUrl?: string;
  categories?: Array<{ categoryId?: string; categoryName?: string }>;
  estimatedAvailabilities?: Array<{ estimatedAvailabilityStatus?: EbayAvailabilityBucket }>;
  condition?: string;
}

export interface BrowseSearchResponse {
  total?: number;
  itemSummaries?: BrowseItemSummary[];
  warnings?: unknown[];
}

/** Shape of the single-item enrichment call, GET /buy/browse/v1/item/{itemId}. */
export interface BrowseItemDetail extends BrowseItemSummary {
  description?: string;
  shortDescription?: string;
}

/** Minimal shape of a Sell Inventory API inventory_item entry. */
export interface SellInventoryItem {
  sku: string;
  product?: {
    title?: string;
    description?: string;
    imageUrls?: string[];
  };
  availability?: {
    shipToLocationAvailability?: { quantity?: number };
  };
  condition?: string;
}

export interface SellInventoryResponse {
  total?: number;
  inventoryItems?: SellInventoryItem[];
  href?: string;
  next?: string;
}

/** Minimal shape of a Sell Inventory API offer entry, matched to an item by SKU. */
export interface SellOffer {
  offerId: string;
  sku: string;
  marketplaceId?: string;
  categoryId?: string;
  listing?: { listingId?: string };
  listingDescription?: string;
  pricingSummary?: { price?: EbayAmount };
  availableQuantity?: number;
  status?: string; // e.g. PUBLISHED
}

export interface SellOfferResponse {
  offers?: SellOffer[];
}

export interface EbayTokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
  refresh_token?: string;
}

/** A live listing paired with its account, as produced by the account fetchers,
 * ready for diffing against the products table for that account. */
export interface FetchedListing {
  account: EbayAccount;
  listing: NormalisedListing;
}

export interface CategoryRule {
  matchType: 'keyword' | 'ebay_category';
  matchValue: string;
  categoryId: number;
  priority: number;
}

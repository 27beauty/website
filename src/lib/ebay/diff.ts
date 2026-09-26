/**
 * Pure diffing + lock-rule logic for the eBay sync. Takes plain data in,
 * returns plain data out, so it can be unit-tested without D1.
 */

import type { NormalisedListing } from './types';

/** The subset of a `products` row the diff/lock logic needs to know about. */
export interface ExistingProductRow {
  id: number;
  ebay_item_id: string | null;
  price_locked: number;
  stock_locked: number;
  content_locked: number;
  ebay_miss_count: number;
  /** Folded into another product (same item listed twice) — the sync leaves it alone. */
  merged_into?: number | null;
  title?: string;
  status?: string;
  /** When eBay last confirmed this listing — the least recently confirmed are checked for having ended first. */
  ebay_synced_at?: string | null;
}

export interface ListingDiff {
  /** Listings with no matching product for this account — need INSERT. */
  toCreate: NormalisedListing[];
  /** Existing products whose eBay listing is still live — need UPDATE. */
  toUpdate: Array<{ product: ExistingProductRow; listing: NormalisedListing }>;
  /** Existing products for this account no longer present in the feed — mark ended. */
  toEnd: ExistingProductRow[];
}

/**
 * Diffs the listings just fetched for one account against that account's
 * existing `source='ebay'` products (keyed by ebay_item_id).
 */
export function diffListings(
  existing: ExistingProductRow[],
  fetched: NormalisedListing[],
): ListingDiff {
  const existingByItemId = new Map<string, ExistingProductRow>();
  for (const row of existing) {
    if (row.ebay_item_id) existingByItemId.set(row.ebay_item_id, row);
  }

  const seen = new Set<string>();
  const toCreate: NormalisedListing[] = [];
  const toUpdate: Array<{ product: ExistingProductRow; listing: NormalisedListing }> = [];

  for (const listing of fetched) {
    seen.add(listing.itemId);
    const match = existingByItemId.get(listing.itemId);
    if (match) {
      toUpdate.push({ product: match, listing });
    } else {
      toCreate.push(listing);
    }
  }

  const toEnd = existing.filter((row) => row.ebay_item_id && !seen.has(row.ebay_item_id));

  return { toCreate, toUpdate, toEnd };
}

export interface FieldLocks {
  priceLocked: boolean;
  stockLocked: boolean;
  contentLocked: boolean;
}

export function locksFromRow(row: { price_locked: number; stock_locked: number; content_locked: number }): FieldLocks {
  return {
    priceLocked: Boolean(row.price_locked),
    stockLocked: Boolean(row.stock_locked),
    contentLocked: Boolean(row.content_locked),
  };
}

/** Fields an UPDATE is allowed to write, honouring the owner's lock flags. */
export interface UpdatableFields {
  price_pence?: number;
  stock?: number;
  title?: string;
  description?: string | null;
  image_url?: string | null;
  images_json?: string;
}

/**
 * Given a locked/unlocked state and the fully-computed candidate values,
 * returns only the fields that are allowed to change. `ebay_synced_at`
 * is always refreshed by the caller regardless of what this returns.
 */
export function resolveUpdateFields(
  locks: FieldLocks,
  candidate: {
    pricePence: number | null;
    stock: number;
    title: string;
    description: string | null;
    imageUrl: string | null;
    imagesJson: string;
  },
): UpdatableFields {
  const out: UpdatableFields = {};
  if (!locks.priceLocked && candidate.pricePence !== null) out.price_pence = candidate.pricePence;
  if (!locks.stockLocked) out.stock = candidate.stock;
  if (!locks.contentLocked) {
    out.title = candidate.title;
    out.description = candidate.description;
    out.image_url = candidate.imageUrl;
    out.images_json = candidate.imagesJson;
  }
  // Category is not written here: the sync only fills it in when a product
  // has none (sync.ts), so a category the owner picked is never overwritten.
  return out;
}

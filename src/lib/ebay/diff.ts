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
  /** 1 when the product already has a description; the sync fetches one for products that don't. */
  has_description?: number;
  // Current values, so a run can tell a listing that actually changed from one
  // that eBay simply reported again. See productNeedsWrite.
  price_pence?: number | null;
  stock?: number;
  image_url?: string | null;
  images_json?: string | null;
  ebay_sku?: string | null;
  ebay_url?: string | null;
  ebay_stock?: number | null;
  category_id?: number | null;
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
    // Search results carry no description (only the item details call does),
    // so a run without one must not wipe the one the product already has.
    if (candidate.description) out.description = candidate.description;
    out.image_url = candidate.imageUrl;
    out.images_json = candidate.imagesJson;
  }
  // Category is not written here: the sync only fills it in when a product
  // has none (sync.ts), so a category the owner picked is never overwritten.
  return out;
}

/** The values the sync writes on every confirmed listing besides {@link UpdatableFields}. */
export interface SyncStamp {
  categoryId: number | null;
  sku: string | null;
  url: string | null;
  ebayStock: number | null;
}

/**
 * True when a listing eBay has just confirmed differs from what the product
 * already holds, i.e. the row is worth rewriting.
 *
 * Without this the sync rewrote every live listing on every run — in
 * production 79 products every ten minutes, around 11,400 D1 row writes a day
 * that changed nothing. It also meant `products.updated_at` always read as
 * "changed moments ago", so nothing downstream could use it to tell whether
 * the catalogue had really moved.
 *
 * `description` is only ever a candidate for products that have none (sync.ts
 * fetches item details just for those), so its presence here always means new
 * content and never needs comparing against the stored text.
 */
export function productNeedsWrite(
  product: ExistingProductRow,
  fields: UpdatableFields,
  stamp: SyncStamp,
): boolean {
  // Confirmed live again, so an earlier wrong archive or miss streak is undone.
  if (product.status === 'archived') return true;
  if (product.ebay_miss_count !== 0) return true;
  // The rules only fill a category in when the product has none.
  if (product.category_id == null && stamp.categoryId != null) return true;

  if (fields.description !== undefined) return true;
  if (fields.price_pence !== undefined && fields.price_pence !== product.price_pence) return true;
  if (fields.stock !== undefined && fields.stock !== product.stock) return true;
  if (fields.title !== undefined && fields.title !== product.title) return true;
  if (fields.image_url !== undefined && (fields.image_url ?? null) !== (product.image_url ?? null)) return true;
  if (fields.images_json !== undefined && fields.images_json !== (product.images_json ?? null)) return true;

  if ((stamp.sku ?? null) !== (product.ebay_sku ?? null)) return true;
  if ((stamp.url ?? null) !== (product.ebay_url ?? null)) return true;
  if ((stamp.ebayStock ?? null) !== (product.ebay_stock ?? null)) return true;
  return false;
}

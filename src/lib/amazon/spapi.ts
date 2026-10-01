/**
 * Amazon Selling Partner API (UK marketplace) for centralised stock:
 *   searchListingsItems  every listing, with whether Amazon (FBA) or you (FBM) ship it
 *   getOrders/Items      your own-shipped (MFN) orders, to take stock off
 *   patchListingsItem    set the quantity on an FBM listing
 *
 * Auth is Login with Amazon: the seller's self-authorised refresh token is
 * exchanged for a 1-hour access token (cached in KV) sent as
 * x-amz-access-token. SP-API no longer needs AWS request signing.
 * FBA listings are only ever read — their stock is Amazon's warehouse, not
 * the shared shelf.
 */

import type { Env } from '../../types';

const LWA_TOKEN_URL = 'https://api.amazon.com/auth/o2/token';
import { htmlToText } from '../util';

const SP_API = 'https://sellingpartnerapi-eu.amazon.com';
export const UK_MARKETPLACE = 'A1F83G8C2ARO7P';
const TOKEN_KV_KEY = 'amazon:lwa-token';

export class AmazonThrottledError extends Error {
  constructor() {
    super('Amazon rate limit (HTTP 429) — will retry next run');
    this.name = 'AmazonThrottledError';
  }
}

export function amazonConfigured(env: Env): boolean {
  return Boolean(env.AMAZON_LWA_CLIENT_ID && env.AMAZON_LWA_CLIENT_SECRET && env.AMAZON_REFRESH_TOKEN && env.AMAZON_SELLER_ID);
}

async function accessToken(env: Env): Promise<string> {
  if (!amazonConfigured(env)) throw new Error('Amazon credentials are not configured');
  const cached = await env.KV.get(TOKEN_KV_KEY);
  if (cached) return cached;
  const res = await fetch(LWA_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: env.AMAZON_REFRESH_TOKEN as string,
      client_id: env.AMAZON_LWA_CLIENT_ID as string,
      client_secret: env.AMAZON_LWA_CLIENT_SECRET as string,
    }).toString(),
  });
  // Never include the body: a bad grant can echo parameters back.
  if (!res.ok) throw new Error(`Amazon login (LWA) failed: HTTP ${res.status}`);
  const json = (await res.json()) as { access_token: string; expires_in?: number };
  await env.KV.put(TOKEN_KV_KEY, json.access_token, { expirationTtl: Math.max(60, (json.expires_in ?? 3600) - 120) });
  return json.access_token;
}

/** Counts every outbound request so a cron run can stay inside its budget. */
export interface CallCounter {
  calls: number;
}

async function sp<T>(env: Env, counter: CallCounter, path: string, init: RequestInit = {}): Promise<T> {
  const token = await accessToken(env);
  counter.calls++;
  const res = await fetch(`${SP_API}${path}`, {
    ...init,
    headers: {
      'x-amz-access-token': token,
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  if (res.status === 429) throw new AmazonThrottledError();
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let detail = '';
    try {
      const j = JSON.parse(text) as { errors?: { message?: string; details?: string }[] };
      detail = (j.errors ?? []).map((e) => e.message ?? e.details).filter(Boolean).join('; ');
    } catch {
      detail = text.slice(0, 200);
    }
    throw new Error(`Amazon ${path.split('?')[0]}: HTTP ${res.status}${detail ? ` — ${detail}` : ''}`);
  }
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Listings
// ---------------------------------------------------------------------------

export interface AmazonListing {
  sku: string;
  asin: string | null;
  title: string;
  fulfilment: 'merchant' | 'amazon';
  quantity: number | null;
}

interface RawListingItem {
  sku?: string;
  summaries?: { marketplaceId?: string; asin?: string; itemName?: string }[];
  fulfillmentAvailability?: { fulfillmentChannelCode?: string; quantity?: number }[];
}

/** FBM listings report fulfillmentChannelCode "DEFAULT"; anything else (AMAZON_EU…) is FBA. */
export function mapListing(item: RawListingItem): AmazonListing | null {
  if (!item.sku) return null;
  const summary = item.summaries?.find((s) => s.marketplaceId === UK_MARKETPLACE) ?? item.summaries?.[0];
  const merchant = item.fulfillmentAvailability?.find((f) => f.fulfillmentChannelCode === 'DEFAULT');
  const anyFba = item.fulfillmentAvailability?.some((f) => f.fulfillmentChannelCode && f.fulfillmentChannelCode !== 'DEFAULT');
  return {
    sku: item.sku,
    asin: summary?.asin ?? null,
    title: summary?.itemName ?? item.sku,
    fulfilment: merchant || !anyFba ? 'merchant' : 'amazon',
    quantity: merchant?.quantity ?? null,
  };
}

export async function searchListingsPage(
  env: Env,
  counter: CallCounter,
  pageToken: string | null,
): Promise<{ listings: AmazonListing[]; nextToken: string | null }> {
  const params = new URLSearchParams({
    marketplaceIds: UK_MARKETPLACE,
    includedData: 'summaries,fulfillmentAvailability',
    pageSize: '20',
  });
  if (pageToken) params.set('pageToken', pageToken);
  const json = await sp<{ items?: RawListingItem[]; pagination?: { nextToken?: string } }>(
    env,
    counter,
    `/listings/2021-08-01/items/${encodeURIComponent(env.AMAZON_SELLER_ID as string)}?${params.toString()}`,
  );
  return {
    listings: (json.items ?? []).map(mapListing).filter((l): l is AmazonListing => l !== null),
    nextToken: json.pagination?.nextToken ?? null,
  };
}

export interface AmazonListingDetails {
  pricePence: number | null;
  imageUrl: string | null;
  description: string | null;
}

interface RawListingDetails {
  summaries?: { marketplaceId?: string; mainImage?: { link?: string } }[];
  offers?: { marketplaceId?: string; offerType?: string; price?: { amount?: string | number; currency?: string; currencyCode?: string } }[];
  attributes?: {
    product_description?: { value?: string; marketplace_id?: string }[];
    bullet_point?: { value?: string; marketplace_id?: string }[];
  };
}

/** Price, main photo and description from one listing's details. Pure, for testing. */
export function mapListingDetails(raw: RawListingDetails): AmazonListingDetails {
  const uk = <T extends { marketplaceId?: string; marketplace_id?: string }>(list: T[] | undefined) =>
    (list ?? []).filter((x) => !(x.marketplaceId ?? x.marketplace_id) || (x.marketplaceId ?? x.marketplace_id) === UK_MARKETPLACE);
  const offer = uk(raw.offers).find((o) => !o.offerType || o.offerType === 'B2C');
  const currency = offer?.price?.currencyCode ?? offer?.price?.currency;
  const amount = Number(offer?.price?.amount);
  const pricePence = (!currency || currency === 'GBP') && Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) : null;
  const imageUrl = uk(raw.summaries).find((s) => s.mainImage?.link)?.mainImage?.link ?? null;
  const text = uk(raw.attributes?.product_description)
    .map((d) => htmlToText(d.value))
    .find(Boolean);
  const bullets = uk(raw.attributes?.bullet_point)
    .map((b) => htmlToText(b.value))
    .filter(Boolean)
    .map((b) => `• ${b}`);
  const description = [text, bullets.join('\n')].filter(Boolean).join('\n\n') || null;
  return { pricePence, imageUrl, description };
}

/** One listing's price, main photo and description (one request). */
export async function getListingDetails(env: Env, counter: CallCounter, sku: string): Promise<AmazonListingDetails> {
  const params = new URLSearchParams({ marketplaceIds: UK_MARKETPLACE, includedData: 'summaries,offers,attributes' });
  const raw = await sp<RawListingDetails>(
    env,
    counter,
    `/listings/2021-08-01/items/${encodeURIComponent(env.AMAZON_SELLER_ID as string)}/${encodeURIComponent(sku)}?${params.toString()}`,
  );
  return mapListingDetails(raw);
}

interface RawCatalogItem {
  attributes?: {
    product_description?: { value?: string; marketplace_id?: string }[];
    bullet_point?: { value?: string; marketplace_id?: string }[];
  };
}

/**
 * The description and bullet points from Amazon's catalogue page for an ASIN.
 * A seller's own listing only carries what that seller submitted, so for a
 * product they resell this is where the words are.
 */
export function mapCatalogDescription(raw: RawCatalogItem): string | null {
  return mapListingDetails({ attributes: raw.attributes }).description;
}

export async function getCatalogDescription(env: Env, counter: CallCounter, asin: string): Promise<string | null> {
  const params = new URLSearchParams({ marketplaceIds: UK_MARKETPLACE, includedData: 'attributes' });
  const raw = await sp<RawCatalogItem>(env, counter, `/catalog/2022-04-01/items/${encodeURIComponent(asin)}?${params.toString()}`);
  return mapCatalogDescription(raw);
}

export async function setMerchantQuantity(env: Env, counter: CallCounter, sku: string, quantity: number): Promise<void> {
  const json = await sp<{ status?: string; issues?: { message?: string; severity?: string }[] }>(
    env,
    counter,
    `/listings/2021-08-01/items/${encodeURIComponent(env.AMAZON_SELLER_ID as string)}/${encodeURIComponent(sku)}?marketplaceIds=${UK_MARKETPLACE}`,
    {
      method: 'PATCH',
      body: JSON.stringify({
        productType: 'PRODUCT',
        patches: [
          {
            op: 'replace',
            path: '/attributes/fulfillment_availability',
            value: [{ fulfillment_channel_code: 'DEFAULT', quantity: Math.max(0, Math.trunc(quantity)) }],
          },
        ],
      }),
    },
  );
  if (json.status !== 'ACCEPTED') {
    const issues = (json.issues ?? []).filter((i) => i.severity === 'ERROR').map((i) => i.message).join('; ');
    throw new Error(`Amazon rejected the quantity for ${sku}: ${issues || json.status || 'unknown reason'}`);
  }
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

export interface RawAmazonOrder {
  AmazonOrderId?: string;
  OrderStatus?: string;
  FulfillmentChannel?: string;
  /** When the buyer placed it. */
  PurchaseDate?: string;
  LastUpdateDate?: string;
}

/**
 * Own-shipped orders that should take stock. Amazon reserves stock from
 * Pending onwards, so everything but Canceled counts; Canceled is returned
 * separately so a sale already counted can be put back.
 */
export function classifyOrders(orders: RawAmazonOrder[], placedAfter?: string): { sold: string[]; cancelled: string[]; placedBefore: string[] } {
  const sold: string[] = [];
  const cancelled: string[] = [];
  // Orders come back when they're *updated* (e.g. dispatched). One placed
  // before counting started is already in the count it started from.
  const placedBefore: string[] = [];
  const cutoff = placedAfter ? Date.parse(placedAfter) : NaN;
  for (const o of orders) {
    if (!o.AmazonOrderId || o.FulfillmentChannel === 'AFN') continue;
    const placed = o.PurchaseDate ? Date.parse(o.PurchaseDate) : NaN;
    if (o.OrderStatus === 'Canceled') cancelled.push(o.AmazonOrderId);
    else if (Number.isFinite(cutoff) && Number.isFinite(placed) && placed < cutoff) placedBefore.push(o.AmazonOrderId);
    else if (o.OrderStatus !== 'Unfulfillable') sold.push(o.AmazonOrderId);
  }
  return { sold, cancelled, placedBefore };
}

export async function fetchUpdatedOrders(
  env: Env,
  counter: CallCounter,
  since: string,
): Promise<{ orders: RawAmazonOrder[]; complete: boolean }> {
  // Amazon rejects LastUpdatedAfter within the last two minutes.
  const latest = new Date(Date.now() - 3 * 60_000).toISOString();
  const after = since < latest ? since : latest;
  const params = new URLSearchParams({
    MarketplaceIds: UK_MARKETPLACE,
    LastUpdatedAfter: after,
    FulfillmentChannels: 'MFN',
    MaxResultsPerPage: '100',
  });
  const json = await sp<{ payload?: { Orders?: RawAmazonOrder[]; NextToken?: string } }>(
    env,
    counter,
    `/orders/v0/orders?${params.toString()}`,
  );
  // One page per run keeps within getOrders' tight rate limit; the ledger
  // makes re-reading next run safe, and the cursor only moves on a full page set.
  return { orders: json.payload?.Orders ?? [], complete: !json.payload?.NextToken };
}

export interface AmazonOrderLine {
  orderItemId: string;
  sku: string;
  quantity: number;
}

export async function fetchOrderLines(env: Env, counter: CallCounter, orderId: string): Promise<AmazonOrderLine[]> {
  const json = await sp<{ payload?: { OrderItems?: { OrderItemId?: string; SellerSKU?: string; QuantityOrdered?: number }[] } }>(
    env,
    counter,
    `/orders/v0/orders/${encodeURIComponent(orderId)}/orderItems`,
  );
  return (json.payload?.OrderItems ?? [])
    .filter((i) => i.OrderItemId && i.SellerSKU && (i.QuantityOrdered ?? 0) > 0)
    .map((i) => ({ orderItemId: i.OrderItemId as string, sku: i.SellerSKU as string, quantity: i.QuantityOrdered as number }));
}

export function newestUpdate(orders: RawAmazonOrder[], fallback: string): string {
  let newest = fallback;
  for (const o of orders) if (o.LastUpdateDate && o.LastUpdateDate > newest) newest = o.LastUpdateDate;
  return newest;
}

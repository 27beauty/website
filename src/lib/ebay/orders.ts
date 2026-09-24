/**
 * eBay orders → stock movements. Reads the Sell Fulfillment API for orders
 * modified since the last check, and turns each line into a sale (or, if the
 * order has since been cancelled, a put-back). The stock ledger's
 * UNIQUE(reason, ref) makes re-reading an order harmless.
 */

import { fetchWithRetry } from './http';

const ORDERS_URL = 'https://api.ebay.com/sell/fulfillment/v1/order';
const PAGE_SIZE = 200;

interface RawLineItem {
  lineItemId?: string;
  legacyItemId?: string;
  sku?: string;
  title?: string;
  quantity?: number;
}

export interface RawEbayOrder {
  orderId?: string;
  lastModifiedDate?: string;
  orderPaymentStatus?: string;
  cancelStatus?: { cancelState?: string };
  lineItems?: RawLineItem[];
}

export interface EbaySaleLine {
  orderId: string;
  lineItemId: string;
  itemId: string;
  quantity: number;
  title: string;
  cancelled: boolean;
}

/**
 * Flattens orders to lines. A payment that failed never took stock on eBay,
 * so it's skipped; a cancelled order is returned with `cancelled: true` so a
 * sale already counted can be put back.
 */
export function saleLines(orders: RawEbayOrder[]): EbaySaleLine[] {
  const out: EbaySaleLine[] = [];
  for (const o of orders) {
    if (!o.orderId || o.orderPaymentStatus === 'FAILED') continue;
    const cancelled = o.cancelStatus?.cancelState === 'CANCELED';
    for (const li of o.lineItems ?? []) {
      if (!li.lineItemId || !li.legacyItemId || !li.quantity || li.quantity < 1) continue;
      out.push({
        orderId: o.orderId,
        lineItemId: li.lineItemId,
        itemId: li.legacyItemId,
        quantity: li.quantity,
        title: li.title ?? '',
        cancelled,
      });
    }
  }
  return out;
}

/** eBay's filter wants ISO-8601 with milliseconds and a Z. */
export function ebayFilterTime(iso: string): string {
  return new Date(iso).toISOString();
}

/**
 * Orders modified after `since`. Returns at most `maxPages` pages so a busy
 * day can't blow the run's request budget; `complete` says whether the
 * cursor may advance to `newestModified`.
 */
export async function fetchModifiedOrders(
  token: string,
  since: string,
  maxPages: number,
): Promise<{ orders: RawEbayOrder[]; complete: boolean; calls: number }> {
  const orders: RawEbayOrder[] = [];
  let offset = 0;
  let calls = 0;
  const filter = `lastmodifieddate:[${ebayFilterTime(since)}..]`;
  while (calls < maxPages) {
    const url = `${ORDERS_URL}?filter=${encodeURIComponent(filter)}&limit=${PAGE_SIZE}&offset=${offset}`;
    const res = await fetchWithRetry(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
    calls++;
    if (!res.ok) throw new Error(`eBay getOrders: HTTP ${res.status}`);
    const json = (await res.json()) as { orders?: RawEbayOrder[]; total?: number; next?: string };
    orders.push(...(json.orders ?? []));
    if (!json.next || !(json.orders ?? []).length) return { orders, complete: true, calls };
    offset += PAGE_SIZE;
  }
  return { orders, complete: false, calls };
}

/** The newest lastModifiedDate seen, to move the cursor to. */
export function newestModified(orders: RawEbayOrder[], fallback: string): string {
  let newest = fallback;
  for (const o of orders) if (o.lastModifiedDate && o.lastModifiedDate > newest) newest = o.lastModifiedDate;
  return newest;
}

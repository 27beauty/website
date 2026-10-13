/**
 * Parcel2Go Smart Send CSV: paid website orders in the spreadsheet format
 * Smart Send imports (Help Centre → "How do I upload a spreadsheet?"). One row
 * per order, as one parcel: the items are summarised in Item Name, the weight
 * and size come from the products' parcel sizes (or the Settings default),
 * the value is what the customer paid for the goods. Weight in kg, sizes in
 * cm, value with no currency symbol, country as a two-letter code.
 *
 * Downloading only marks orders as downloaded. They count as sent once the
 * owner confirms the file went into Smart Send, so an upload that failed or
 * never happened leaves them waiting rather than lost.
 */

import type { Env, Order, OrderItem, ShippingAddress } from '../types';
import { getParcelDefaults, parcelForOrder, parcelLinesForOrder, splitAddressLine, type Parcel } from './parcel2go';
import { inChunks } from './util';

export const SMART_SEND_COLUMNS = [
  'Reference',
  'Item Name',
  'Quantity',
  'Value',
  'Weight',
  'Length',
  'Width',
  'Height',
  'Name',
  'Property',
  'Street',
  'Locality',
  'Town',
  'County',
  'Postcode',
  'Country',
  'Telephone',
  'Email',
] as const;

type OrderForExport = Order & { items: OrderItem[] };

/** "GB" for a UK address however it was written; Smart Send wants two-letter codes. */
export function toIso2Country(country: string | null | undefined): string {
  const c = (country ?? '').trim().toUpperCase();
  if (!c || c === 'UK' || c === 'GBR' || c === 'GB') return 'GB';
  return c.length === 2 ? c : 'GB';
}

/** One order as one Smart Send row, in SMART_SEND_COLUMNS order. */
export function smartSendRow(order: OrderForExport, parcel: Parcel): string[] {
  const shipping: ShippingAddress = order.shipping_json ? safeJson(order.shipping_json) : {};
  const line = splitAddressLine(shipping.line1);
  const goods = Math.max(0, order.subtotal_pence - order.discount_pence);
  return [
    order.order_number,
    itemSummary(order.items, order.order_number),
    '1',
    (goods / 100).toFixed(2),
    String(Math.round(parcel.weightKg * 1000) / 1000),
    String(parcel.lengthCm),
    String(parcel.widthCm),
    String(parcel.heightCm),
    order.customer_name ?? '',
    line.property,
    [line.street === line.property ? '' : line.street, shipping.line2].filter(Boolean).join(', '),
    '',
    shipping.city ?? '',
    '',
    shipping.postcode ?? '',
    toIso2Country(shipping.country),
    order.phone ?? '',
    order.email ?? '',
  ];
}

/** Longest Item Name we send; long names are cut short in Smart Send's screens and labels. */
export const ITEM_NAME_MAX = 200;
const MIN_TITLE = 12;

/**
 * Every line of the order, as "3 x Hand Cream 50ml; 1 x Lip Oil". When that's
 * too long, long titles are shortened (short ones are kept whole) so every
 * line still appears with its quantity. Only an order with so many lines that
 * even short titles can't fit ends with "+N more, see <order number>", so a
 * missing line is never silent.
 */
export function itemSummary(items: Pick<OrderItem, 'quantity' | 'title'>[], orderNumber: string, max = ITEM_NAME_MAX): string {
  const lines = items.map((i) => ({ prefix: `${i.quantity} x `, title: i.title.replace(/\s+/g, ' ').trim() }));
  const full = lines.map((l) => l.prefix + l.title).join('; ');
  if (full.length <= max) return full;

  for (let k = lines.length; k >= 1; k--) {
    const shown = lines.slice(0, k);
    const more = k < lines.length ? `; +${lines.length - k} more, see ${orderNumber}` : '';
    const fixed = shown.reduce((n, l) => n + l.prefix.length, 0) + 2 * (k - 1) + more.length;
    let budget = max - fixed;
    if (budget < MIN_TITLE * k) continue;
    // Share the room out: short titles keep their full length, long ones split what's left.
    const widths = new Map<number, number>();
    const order = shown.map((l, i) => i).sort((a, b) => shown[a].title.length - shown[b].title.length);
    order.forEach((i, n) => {
      const width = Math.min(shown[i].title.length, Math.floor(budget / (order.length - n)));
      widths.set(i, width);
      budget -= width;
    });
    return shown.map((l, i) => l.prefix + l.title.slice(0, widths.get(i)).trimEnd()).join('; ') + more;
  }
  return `${lines.length} lines, see ${orderNumber}`.slice(0, max);
}

function safeJson(text: string): ShippingAddress {
  try {
    return JSON.parse(text) as ShippingAddress;
  } catch {
    return {};
  }
}

/** RFC 4180: quote every field, double any quote, CRLF line ends. */
export function toCsv(rows: string[][]): string {
  return rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n') + '\r\n';
}

export type SmartSendScope = 'new' | 'unconfirmed' | 'all';

const SCOPE_SQL: Record<SmartSendScope, string> = {
  new: 'AND smartsend_downloaded_at IS NULL AND smartsend_exported_at IS NULL',
  unconfirmed: 'AND smartsend_downloaded_at IS NOT NULL AND smartsend_exported_at IS NULL',
  all: '',
};

/**
 * Paid orders waiting to be sent: `new` were never downloaded, `unconfirmed`
 * were downloaded but not confirmed as uploaded, `all` is every one.
 */
export async function ordersForSmartSend(env: Env, scope: SmartSendScope): Promise<OrderForExport[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM orders WHERE status = 'paid' ${SCOPE_SQL[scope]} ORDER BY created_at ASC, id ASC`,
  ).all<Order>();
  const orders = results ?? [];
  const items = new Map<number, OrderItem[]>();
  for (const slice of inChunks(orders.map((o) => o.id))) {
    const { results: rows } = await env.DB.prepare(
      `SELECT * FROM order_items WHERE order_id IN (${slice.map(() => '?').join(',')}) ORDER BY id`,
    )
      .bind(...slice)
      .all<OrderItem>();
    for (const r of rows ?? []) items.set(r.order_id, [...(items.get(r.order_id) ?? []), r]);
  }
  return orders.map((o) => ({ ...o, items: items.get(o.id) ?? [] }));
}

/** The Smart Send CSV for these orders (header row first). */
export async function smartSendCsv(env: Env, orders: OrderForExport[]): Promise<string> {
  const defaults = await getParcelDefaults(env);
  const rows: string[][] = [[...SMART_SEND_COLUMNS]];
  for (const o of orders) {
    const parcel = parcelForOrder(await parcelLinesForOrder(env, o.items), defaults);
    rows.push(smartSendRow(o, parcel));
  }
  return toCsv(rows);
}

/** Paid orders never downloaded for Smart Send. */
export async function countNewForSmartSend(env: Env): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM orders WHERE status = 'paid' ${SCOPE_SQL.new}`).first<{ n: number }>();
  return row?.n ?? 0;
}

/** Downloaded but not yet confirmed as uploaded, oldest first. */
export async function listUnconfirmedForSmartSend(
  env: Env,
): Promise<{ id: number; order_number: string; smartsend_downloaded_at: string }[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, order_number, smartsend_downloaded_at FROM orders
      WHERE status = 'paid' ${SCOPE_SQL.unconfirmed} ORDER BY created_at ASC, id ASC`,
  ).all<{ id: number; order_number: string; smartsend_downloaded_at: string }>();
  return results ?? [];
}

export async function markDownloadedForSmartSend(env: Env, orderIds: number[]): Promise<void> {
  for (const slice of inChunks(orderIds)) {
    await env.DB.prepare(
      `UPDATE orders SET smartsend_downloaded_at = datetime('now') WHERE id IN (${slice.map(() => '?').join(',')})`,
    )
      .bind(...slice)
      .run();
  }
}

/** The owner says the file is in Smart Send. Only downloaded orders can be confirmed; returns how many were. */
export async function confirmSentToSmartSend(env: Env, orderIds: number[]): Promise<number> {
  let n = 0;
  for (const slice of inChunks(orderIds)) {
    const res = await env.DB.prepare(
      `UPDATE orders SET smartsend_exported_at = datetime('now')
        WHERE id IN (${slice.map(() => '?').join(',')}) AND smartsend_downloaded_at IS NOT NULL AND smartsend_exported_at IS NULL`,
    )
      .bind(...slice)
      .run();
    n += res.meta.changes ?? 0;
  }
  return n;
}

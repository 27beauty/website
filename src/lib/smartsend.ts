/**
 * Parcel2Go Smart Send CSV: paid website orders in the spreadsheet format
 * Smart Send imports (Help Centre → "How do I upload a spreadsheet?"). One row
 * per order, as one parcel: the items are summarised in Item Name, the weight
 * and size come from the products' parcel sizes (or the Settings default),
 * the value is what the customer paid for the goods. Weight in kg, sizes in
 * cm, value with no currency symbol, country as a two-letter code.
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
  const items = order.items.map((i) => `${i.quantity} x ${i.title}`).join('; ');
  const goods = Math.max(0, order.subtotal_pence - order.discount_pence);
  return [
    order.order_number,
    items.length > 200 ? `${items.slice(0, 197)}...` : items,
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

/** Paid orders waiting to be sent; with `onlyNew`, just those not downloaded for Smart Send before. */
export async function ordersForSmartSend(env: Env, onlyNew: boolean): Promise<OrderForExport[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM orders WHERE status = 'paid' ${onlyNew ? 'AND smartsend_exported_at IS NULL' : ''} ORDER BY created_at ASC`,
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

/** Paid orders not yet downloaded for Smart Send. */
export async function countNewForSmartSend(env: Env): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM orders WHERE status = 'paid' AND smartsend_exported_at IS NULL`).first<{ n: number }>();
  return row?.n ?? 0;
}

export async function markSentToSmartSend(env: Env, orderIds: number[]): Promise<void> {
  for (const slice of inChunks(orderIds)) {
    await env.DB.prepare(
      `UPDATE orders SET smartsend_exported_at = datetime('now') WHERE id IN (${slice.map(() => '?').join(',')})`,
    )
      .bind(...slice)
      .run();
  }
}

/**
 * Parcel2Go integration: quote, book, pay and print a label for a paid order
 * without leaving the admin panel.
 *
 * Flow (all triggered by the owner clicking, never automatically):
 *   1. getQuotes()      POST /quotes — every service for this parcel, with the
 *                       distance to the nearest drop-off shop.
 *   2. bookShipment()   POST /orders for the chosen service, then
 *                       POST /orders/{id}/paywithprepay — paid from the
 *                       owner's Parcel2Go PrePay balance.
 *   3. getLabelPdf()    GET /labels/{id} — fetched fresh each time it's
 *                       printed, never stored (keeps R2 writes at zero).
 *
 * Uses Parcel2Go's API at www.parcel2go.com/api with an OAuth2
 * client-credentials token. Such a client doesn't "own" the orders it creates,
 * so every follow-up call on an order passes the `Hash` returned when it was
 * created. The newer api.p2g.com/checkout surface 500s on a bare
 * client-credentials token, so this deliberately targets the older one.
 */

import type { Env, Order, OrderItem, ShippingAddress } from '../types';
import { getSetting } from './settings';
import {
  claimParcel2GoBooking,
  markParcel2GoBooked,
  markParcel2GoError,
  recordParcel2GoOrder,
  recordParcel2GoTracking,
} from './orders';

const AUTH_URL = 'https://www.parcel2go.com/auth/connect/token';
const API_ROOT = 'https://www.parcel2go.com/api';
const TOKEN_KV_KEY = 'parcel2go:token';
const SAFETY_MARGIN_SECONDS = 60;

/**
 * How far a created order's price may exceed the quote the owner clicked
 * before we refuse to pay it. Quotes and orders are priced separately, so a
 * few pence of drift is normal; anything more means the owner should see it.
 */
const PRICE_DRIFT_TOLERANCE_PENCE = 50;

interface Parcel2GoTokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

export function parcel2goConfigured(env: Env): boolean {
  return Boolean(env.PARCEL2GO_CLIENT_ID && env.PARCEL2GO_CLIENT_SECRET);
}

async function getAccessToken(env: Env): Promise<string> {
  if (!env.PARCEL2GO_CLIENT_ID || !env.PARCEL2GO_CLIENT_SECRET) {
    throw new Error('PARCEL2GO_CLIENT_ID / PARCEL2GO_CLIENT_SECRET are not configured');
  }
  const cached = await env.KV.get(TOKEN_KV_KEY);
  if (cached) return cached;

  const res = await fetch(AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: env.PARCEL2GO_CLIENT_ID,
      client_secret: env.PARCEL2GO_CLIENT_SECRET,
      scope: 'public-api payment',
    }).toString(),
  });
  if (!res.ok) {
    // Never log the response body: on a bad grant it can echo request params.
    throw new Error(`Parcel2Go OAuth token request failed: HTTP ${res.status}`);
  }
  const token = (await res.json()) as Parcel2GoTokenResponse;
  const ttl = Math.max(60, (token.expires_in || 7200) - SAFETY_MARGIN_SECONDS);
  await env.KV.put(TOKEN_KV_KEY, token.access_token, { expirationTtl: ttl });
  return token.access_token;
}

/**
 * Pulls a readable message out of a Parcel2Go error body. It comes in a few
 * shapes: `{ Errors: [{ Description }] }`, `{ Message }`, or plain text.
 */
export function parcel2goErrorMessage(status: number, bodyText: string): string {
  let detail = bodyText.trim();
  try {
    const json = JSON.parse(bodyText) as {
      Errors?: { Name?: string; Description?: string; Message?: string }[];
      Message?: string;
      message?: string;
    };
    const fromList = (json.Errors ?? [])
      .map((e) => e.Description || e.Message || e.Name)
      .filter(Boolean)
      .join('; ');
    detail = fromList || json.Message || json.message || detail;
  } catch {
    // not JSON — keep the raw text
  }
  return `HTTP ${status}${detail ? ` — ${detail.slice(0, 300)}` : ''}`;
}

async function p2gFetch<T>(env: Env, path: string, init: RequestInit = {}): Promise<T> {
  const token = await getAccessToken(env);
  const res = await fetch(`${API_ROOT}${path}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      Authorization: `Bearer ${token}`,
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Parcel2Go ${path.split('?')[0]}: ${parcel2goErrorMessage(res.status, text)}`);
  }
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

/** Splits a free-text address line into Parcel2Go's separate Property/Street fields. */
export function splitAddressLine(line1: string | null | undefined): { property: string; street: string } {
  const trimmed = (line1 ?? '').trim();
  if (!trimmed) return { property: '', street: '' };
  const firstSpace = trimmed.indexOf(' ');
  if (firstSpace === -1) return { property: trimmed, street: trimmed };
  return { property: trimmed.slice(0, firstSpace), street: trimmed.slice(firstSpace + 1) };
}

/** Best-effort GBR country code — Parcel2Go's legacy API only takes ISO3. */
export function toIso3Country(country: string | null | undefined): string {
  if (!country) return 'GBR';
  const c = country.trim().toUpperCase();
  if (c === 'GB' || c === 'UK' || c === 'GBR') return 'GBR';
  return c.length === 3 ? c : 'GBR';
}

interface Parcel2GoAddress {
  CountryIsoCode: string;
  Property: string;
  Street: string;
  Postcode: string;
  Town: string;
  ContactName: string;
  Email?: string | null;
  Phone?: string | null;
  County?: string | null;
}

/** The quote endpoint takes a slimmer address shape than orders do. */
function toQuoteAddress(a: Parcel2GoAddress) {
  return { Country: a.CountryIsoCode, Property: a.Property, Postcode: a.Postcode, Town: a.Town };
}

interface StoreContact {
  address: Parcel2GoAddress;
  name: string;
  email: string;
}

/** The owner's collection address, from the "Store address" setting ("4 Some Road, Town, POSTCODE"). */
async function storeContact(env: Env): Promise<StoreContact> {
  const [storeAddress, storeName, storeEmail, storePhone] = await Promise.all([
    getSetting<string>(env, 'store.address', ''),
    getSetting<string>(env, 'store.name', env.SITE_NAME),
    getSetting<string>(env, 'store.email', env.SUPPORT_EMAIL),
    getSetting<string>(env, 'store.phone', ''),
  ]);
  const parts = storeAddress.split(',').map((p) => p.trim());
  const line = splitAddressLine(parts[0]);
  const postcode = parts.length > 1 ? parts[parts.length - 1] : '';
  if (!line.property || !postcode) {
    throw new Error('Set the store address in Settings (e.g. "4 Leamington Close, Blackburn, BB2 6AL") before booking');
  }
  return {
    name: storeName,
    email: storeEmail,
    address: {
      CountryIsoCode: 'GBR',
      Property: line.property,
      Street: line.street,
      Postcode: postcode,
      Town: parts.slice(1, -1).join(', ') || postcode,
      ContactName: storeName,
      Email: storeEmail,
      Phone: storePhone || null,
      County: null,
    },
  };
}

function deliveryAddress(order: Order): Parcel2GoAddress {
  const shipping: ShippingAddress = order.shipping_json ? JSON.parse(order.shipping_json) : {};
  if (!shipping.line1 || !shipping.postcode) {
    throw new Error('This order has no delivery address yet');
  }
  const line = splitAddressLine(shipping.line1);
  return {
    CountryIsoCode: toIso3Country(shipping.country),
    Property: line.property,
    Street: [line.street, shipping.line2].filter(Boolean).join(', '),
    Postcode: shipping.postcode,
    Town: shipping.city || '',
    ContactName: order.customer_name || 'Customer',
    Email: order.email,
    Phone: order.phone,
    County: null,
  };
}

// ---------------------------------------------------------------------------
// Parcel size
// ---------------------------------------------------------------------------

export interface Parcel {
  weightKg: number;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
}

export async function getParcelDefaults(env: Env): Promise<Parcel> {
  const [weightKg, lengthCm, widthCm, heightCm] = await Promise.all([
    getSetting<number>(env, 'parcel2go.default_weight_kg', 1),
    getSetting<number>(env, 'parcel2go.default_length_cm', 30),
    getSetting<number>(env, 'parcel2go.default_width_cm', 20),
    getSetting<number>(env, 'parcel2go.default_height_cm', 5),
  ]);
  return { weightKg, lengthCm, widthCm, heightCm };
}

export interface ParcelLine {
  quantity: number;
  weight_g: number | null;
  length_cm: number | null;
  width_cm: number | null;
  height_cm: number | null;
}

/**
 * A starting guess at the parcel for an order, which the owner can edit
 * before quoting.
 *
 * Weight: the sum of every unit's weight when all of them are known.
 * Otherwise the default parcel weight covers the unknowns, and the known
 * weights only push it higher, never lower.
 *
 * Size: the largest length, width and height across all units. Any unit
 * without dimensions contributes the default box, so the result is never
 * smaller than the default unless every item is measured.
 */
export function parcelForOrder(lines: ParcelLine[], defaults: Parcel): Parcel {
  const units = lines.filter((l) => l.quantity > 0);
  if (!units.length) return { ...defaults };

  const allWeighed = units.every((l) => l.weight_g !== null && l.weight_g > 0);
  const knownGrams = units.reduce((sum, l) => sum + (l.weight_g && l.weight_g > 0 ? l.weight_g * l.quantity : 0), 0);
  const weightKg = allWeighed ? knownGrams / 1000 : Math.max(defaults.weightKg, knownGrams / 1000);

  const measured = (l: ParcelLine) =>
    l.length_cm !== null && l.width_cm !== null && l.height_cm !== null &&
    l.length_cm > 0 && l.width_cm > 0 && l.height_cm > 0;
  const boxes = units.map((l) =>
    measured(l)
      ? { lengthCm: l.length_cm as number, widthCm: l.width_cm as number, heightCm: l.height_cm as number }
      : { lengthCm: defaults.lengthCm, widthCm: defaults.widthCm, heightCm: defaults.heightCm },
  );

  return {
    weightKg: Math.round(weightKg * 100) / 100,
    lengthCm: Math.max(...boxes.map((b) => b.lengthCm)),
    widthCm: Math.max(...boxes.map((b) => b.widthCm)),
    heightCm: Math.max(...boxes.map((b) => b.heightCm)),
  };
}

/** Reads a parcel from form/query input, falling back to `fallback` for anything missing or silly. */
export function parseParcel(input: Record<string, unknown>, fallback: Parcel): Parcel {
  const num = (key: string, fb: number, max: number) => {
    const n = Number(input[key]);
    return Number.isFinite(n) && n > 0 && n <= max ? n : fb;
  };
  return {
    weightKg: num('weight_kg', fallback.weightKg, 1000),
    lengthCm: num('length_cm', fallback.lengthCm, 1000),
    widthCm: num('width_cm', fallback.widthCm, 1000),
    heightCm: num('height_cm', fallback.heightCm, 1000),
  };
}

// ---------------------------------------------------------------------------
// Quotes
// ---------------------------------------------------------------------------

export interface ShippingQuote {
  service: string;
  name: string;
  courier: string;
  pricePence: number;
  /** "Collection" = picked up from you; "DropOff" = you take it to a shop. */
  collectionType: string;
  /** Metres to the nearest drop-off shop, when Parcel2Go knows it. */
  dropShopDistanceM: number | null;
  /** ISO date of the first collection / drop-off slot — needed to book. */
  collectionDate: string | null;
  estimatedDelivery: string | null;
}

interface RawQuote {
  Service?: { Slug?: string; Name?: string; CourierName?: string; CollectionType?: string };
  TotalPrice?: number;
  Distance?: number | null;
  Collection?: string | null;
  EstimatedDeliveryDate?: string | null;
}

/** Turns Parcel2Go's quote response into pence-priced quotes, cheapest first. */
export function mapQuotes(raw: { Quotes?: RawQuote[] }): ShippingQuote[] {
  return (raw.Quotes ?? [])
    .filter((q) => q.Service?.Slug && typeof q.TotalPrice === 'number' && q.TotalPrice > 0)
    .map((q) => ({
      service: q.Service!.Slug!,
      name: q.Service!.Name ?? q.Service!.Slug!,
      courier: q.Service!.CourierName ?? '',
      pricePence: Math.round((q.TotalPrice as number) * 100),
      collectionType: q.Service!.CollectionType ?? '',
      dropShopDistanceM: typeof q.Distance === 'number' && q.Distance > 0 ? q.Distance : null,
      collectionDate: q.Collection ?? null,
      estimatedDelivery: q.EstimatedDeliveryDate ?? null,
    }))
    .sort((a, b) => a.pricePence - b.pricePence);
}

export async function getQuotes(env: Env, order: Order, parcel: Parcel): Promise<ShippingQuote[]> {
  const [store, delivery] = await Promise.all([storeContact(env), Promise.resolve(deliveryAddress(order))]);
  const raw = await p2gFetch<{ Quotes?: RawQuote[] }>(env, '/quotes', {
    method: 'POST',
    body: JSON.stringify({
      CollectionAddress: toQuoteAddress(store.address),
      DeliveryAddress: toQuoteAddress(delivery),
      Parcels: [
        {
          Value: order.total_pence / 100,
          Weight: parcel.weightKg,
          Length: parcel.lengthCm,
          Width: parcel.widthCm,
          Height: parcel.heightCm,
        },
      ],
      IncludedDropShopDistances: true,
    }),
  });
  return mapQuotes(raw);
}

// ---------------------------------------------------------------------------
// Booking
// ---------------------------------------------------------------------------

export interface BookingChoice {
  service: string;
  courier: string;
  collectionDate: string | null;
  /** The price the owner saw and clicked — the order must not cost more. */
  quotedPence: number;
  parcel: Parcel;
}

interface CreatedOrder {
  OrderId: string;
  Hash?: string;
  TotalPrice?: number;
}

async function createParcel2GoOrder(env: Env, order: Order, choice: BookingChoice): Promise<CreatedOrder> {
  const [store, delivery] = await Promise.all([storeContact(env), Promise.resolve(deliveryAddress(order))]);
  const [forename, ...rest] = store.name.split(' ');
  return p2gFetch<CreatedOrder>(env, '/orders', {
    method: 'POST',
    body: JSON.stringify({
      Items: [
        {
          Id: crypto.randomUUID(),
          CollectionDate: choice.collectionDate,
          Service: choice.service,
          Reference: order.order_number,
          Upsells: [],
          CollectionAddress: store.address,
          Parcels: [
            {
              Id: crypto.randomUUID(),
              EstimatedValue: order.total_pence / 100,
              Weight: choice.parcel.weightKg,
              Length: choice.parcel.lengthCm,
              Width: choice.parcel.widthCm,
              Height: choice.parcel.heightCm,
              DeliveryAddress: delivery,
              ContentsSummary: `${env.SITE_NAME} order ${order.order_number}`,
            },
          ],
        },
      ],
      // The *owner* is Parcel2Go's customer here — they pay from PrePay and
      // get the booking emails. The shopper only appears as the recipient.
      CustomerDetails: {
        Email: store.email,
        Forename: forename || store.name,
        Surname: rest.join(' ') || '-',
        OptInToEmails: false,
        OptInToPhone: false,
        OptInToPost: false,
        OptInToOther: false,
      },
    }),
  });
}

async function payWithPrepay(env: Env, orderId: string, hash: string): Promise<void> {
  await p2gFetch<unknown>(
    env,
    `/orders/${encodeURIComponent(orderId)}/paywithprepay?hash=${encodeURIComponent(hash)}`,
    { method: 'POST' },
  );
}

export type BookingResult =
  | { ok: true; trackingNumber: string | null }
  | { ok: false; error: string };

/**
 * Books and pays for shipping on a paid order. Safe to double-click: the
 * order is claimed atomically first, so a second request is refused rather
 * than paying twice. A retry after a failed payment reuses the Parcel2Go
 * order already created for the same service instead of making another.
 */
export async function bookShipment(env: Env, order: Order, choice: BookingChoice): Promise<BookingResult> {
  if (!(await claimParcel2GoBooking(env, order.id))) {
    return {
      ok: false,
      error: order.parcel2go_status === 'booked'
        ? 'Shipping is already booked for this order.'
        : 'This order is already being booked, or is not paid — refresh and check before trying again.',
    };
  }

  let p2gOrderId = order.parcel2go_order_id;
  let hash = order.parcel2go_hash;
  try {
    // Reuse only an unpaid order for the same service that was within the
    // quote — never one we refused to pay because it came back dearer.
    const reusable =
      p2gOrderId &&
      hash &&
      order.parcel2go_service === choice.service &&
      order.parcel2go_price_pence !== null &&
      order.parcel2go_price_pence <= choice.quotedPence + PRICE_DRIFT_TOLERANCE_PENCE;
    if (!reusable) {
      const created = await createParcel2GoOrder(env, order, choice);
      if (!created.Hash) throw new Error('Parcel2Go did not return an order hash, so it cannot be paid');
      const pricePence = typeof created.TotalPrice === 'number' ? Math.round(created.TotalPrice * 100) : choice.quotedPence;
      p2gOrderId = created.OrderId;
      hash = created.Hash;
      await recordParcel2GoOrder(env, order.id, {
        orderId: created.OrderId,
        hash: created.Hash,
        service: choice.service,
        courier: choice.courier,
        pricePence,
      });
      if (pricePence > choice.quotedPence + PRICE_DRIFT_TOLERANCE_PENCE) {
        throw new Error(
          `Parcel2Go priced this at £${(pricePence / 100).toFixed(2)}, more than the £${(choice.quotedPence / 100).toFixed(2)} quoted — not paid. Get fresh quotes and try again.`,
        );
      }
    }

    await payWithPrepay(env, p2gOrderId as string, hash as string);
    // Record the payment before anything else can fail, so a later error can
    // never make it look unpaid and invite a second payment.
    await markParcel2GoBooked(env, order.id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await markParcel2GoError(env, order.id, message);
    return { ok: false, error: message };
  }

  const trackingNumber = await fetchTrackingBestEffort(env, order.id, p2gOrderId as string, hash as string, choice.courier);
  return { ok: true, trackingNumber };
}

// ---------------------------------------------------------------------------
// Labels, tracking, balance
// ---------------------------------------------------------------------------

export type LabelMedia = 'Label4X6' | 'A4';

function labelQuery(hash: string, media: LabelMedia): string {
  return new URLSearchParams({
    referenceType: 'OrderId',
    detailLevel: 'Labels',
    labelMedia: media,
    labelFormat: 'PDF',
    hash,
  }).toString();
}

/** The printable label for a booked order, straight from Parcel2Go (not stored). */
export async function getLabelPdf(env: Env, order: Order, media: LabelMedia): Promise<Uint8Array> {
  if (order.parcel2go_status !== 'booked' || !order.parcel2go_order_id || !order.parcel2go_hash) {
    throw new Error('Book shipping for this order first');
  }
  const res = await p2gFetch<{ Base64EncodedLabels?: string[] }>(
    env,
    `/labels/${encodeURIComponent(order.parcel2go_order_id)}?${labelQuery(order.parcel2go_hash, media)}`,
  );
  const b64 = res.Base64EncodedLabels?.[0];
  if (!b64) throw new Error('Parcel2Go has not generated the label yet — try again in a minute');
  return Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
}

/**
 * Copies the courier tracking number onto the order, if Parcel2Go has one yet.
 * Never throws — tracking is a nicety and can be fetched again when printing.
 */
export async function fetchTrackingBestEffort(
  env: Env,
  orderRowId: number,
  p2gOrderId: string,
  hash: string,
  courier: string | null,
): Promise<string | null> {
  try {
    const res = await p2gFetch<{ Items?: { CourierTrackingNumbers?: string[] }[] }>(
      env,
      `/labels/${encodeURIComponent(p2gOrderId)}/separate?${labelQuery(hash, 'Label4X6')}`,
    );
    const tracking = (res.Items ?? []).flatMap((i) => i.CourierTrackingNumbers ?? []).filter(Boolean);
    if (!tracking.length) return null;
    const joined = tracking.join(', ');
    await recordParcel2GoTracking(env, orderRowId, joined, courier);
    return joined;
  } catch {
    return null;
  }
}

/** What the owner should do when the PrePay balance can't be read. */
export function prepayProblemHint(message: string): string {
  if (message.includes('OAuth')) {
    return 'Parcel2Go rejected the API credentials — check PARCEL2GO_CLIENT_ID / PARCEL2GO_CLIENT_SECRET.';
  }
  if (/HTTP 40[13]/.test(message)) {
    return 'Your API client isn’t allowed to pay from PrePay yet — ask apihelp@parcel2go.com to enable PrePay payments for it.';
  }
  return 'Parcel2Go didn’t answer — try again shortly.';
}

/** PrePay balance in pence — throws if the API client isn't allowed to use PrePay. */
export async function getPrepayBalancePence(env: Env): Promise<number> {
  const res = await p2gFetch<{ Balance?: number }>(env, '/prepay');
  return Math.round((res.Balance ?? 0) * 100);
}

/** Parcel line data for an order's items (product sizes may be unset). */
export async function parcelLinesForOrder(env: Env, items: OrderItem[]): Promise<ParcelLine[]> {
  const ids = [...new Set(items.map((i) => i.product_id).filter((id): id is number => id !== null))];
  const sizes = new Map<number, Omit<ParcelLine, 'quantity'>>();
  if (ids.length) {
    const { results } = await env.DB.prepare(
      `SELECT id, weight_g, length_cm, width_cm, height_cm FROM products WHERE id IN (${ids.map(() => '?').join(',')})`,
    )
      .bind(...ids)
      .all<{ id: number } & Omit<ParcelLine, 'quantity'>>();
    for (const r of results ?? []) sizes.set(r.id, r);
  }
  return items.map((i) => {
    const s = i.product_id !== null ? sizes.get(i.product_id) : undefined;
    return {
      quantity: i.quantity,
      weight_g: s?.weight_g ?? null,
      length_cm: s?.length_cm ?? null,
      width_cm: s?.width_cm ?? null,
      height_cm: s?.height_cm ?? null,
    };
  });
}

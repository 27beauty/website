/**
 * Parcel2Go integration: pushes a paid order across to the owner's Parcel2Go
 * account as soon as payment clears, so it "comes through" there ready to
 * book — the site never pays for or books a label itself, only creates the
 * order and hands back a payment link for the owner to finish in their own
 * Parcel2Go dashboard.
 *
 * Uses Parcel2Go's legacy API (www.parcel2go.com/api) with an OAuth2
 * client-credentials token. Confirmed against the real API (not just docs):
 * the newer api.p2g.com/checkout surface requires an account-linked OAuth
 * token from Parcel2Go's own first-party app and 500s on a bare
 * client-credentials token, so this deliberately targets the older surface,
 * which is what our credentials actually authenticate against.
 */

import type { Env, Order, ShippingAddress } from '../types';
import { getSetting } from './settings';

const AUTH_URL = 'https://www.parcel2go.com/auth/connect/token';
const API_ROOT = 'https://www.parcel2go.com/api';
const TOKEN_KV_KEY = 'parcel2go:token';
const SAFETY_MARGIN_SECONDS = 60;

interface Parcel2GoTokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
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

/** Splits a free-text address line into Parcel2Go's separate Property/Street fields. */
export function splitAddressLine(line1: string | null | undefined): { property: string; street: string } {
  const trimmed = (line1 ?? '').trim();
  if (!trimmed) return { property: '', street: '' };
  const firstSpace = trimmed.indexOf(' ');
  if (firstSpace === -1) return { property: trimmed, street: trimmed };
  return { property: trimmed.slice(0, firstSpace), street: trimmed.slice(firstSpace + 1) };
}

export interface Parcel2GoOrderResult {
  orderId: string;
  paymentUrl: string | null;
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

/** Best-effort GBR country code — Parcel2Go's legacy API only takes ISO3. */
export function toIso3Country(country: string | null | undefined): string {
  if (!country) return 'GBR';
  const c = country.trim().toUpperCase();
  if (c === 'GB' || c === 'UK' || c === 'GBR') return 'GBR';
  return c.length === 3 ? c : 'GBR';
}

/**
 * Pushes a paid order to Parcel2Go as a draft order (not paid/booked).
 * Throws on failure — callers should treat this as best-effort and never let
 * it block marking an order paid.
 */
export async function pushOrderToParcel2Go(env: Env, order: Order): Promise<Parcel2GoOrderResult> {
  const shipping: ShippingAddress = order.shipping_json ? JSON.parse(order.shipping_json) : {};
  const token = await getAccessToken(env);

  const [weightKg, lengthCm, widthCm, heightCm, storeAddress, storeName, storeEmail, storePhone] = await Promise.all([
    getSetting<number>(env, 'parcel2go.default_weight_kg', 1),
    getSetting<number>(env, 'parcel2go.default_length_cm', 30),
    getSetting<number>(env, 'parcel2go.default_width_cm', 20),
    getSetting<number>(env, 'parcel2go.default_height_cm', 5),
    getSetting<string>(env, 'store.address', ''),
    getSetting<string>(env, 'store.name', env.SITE_NAME),
    getSetting<string>(env, 'store.email', env.SUPPORT_EMAIL),
    getSetting<string>(env, 'store.phone', ''),
  ]);

  const collection = splitAddressLine(storeAddress.split(',')[0]);
  const collectionTown = storeAddress.split(',').slice(1, -1).join(',').trim() || 'Blackburn';
  const collectionPostcode = storeAddress.split(',').slice(-1)[0]?.trim() || '';

  const delivery = splitAddressLine(shipping.line1);
  const [nameFirst, ...nameRest] = (order.customer_name || 'Customer').split(' ');
  void nameFirst; // full name is passed through as ContactName below

  const collectionAddress: Parcel2GoAddress = {
    CountryIsoCode: 'GBR',
    Property: collection.property,
    Street: collection.street,
    Postcode: collectionPostcode,
    Town: collectionTown,
    ContactName: storeName,
    Email: storeEmail,
    Phone: storePhone || null,
    County: null,
  };

  const deliveryAddress: Parcel2GoAddress = {
    CountryIsoCode: toIso3Country(shipping.country),
    Property: delivery.property,
    Street: delivery.street || shipping.line2 || '',
    Postcode: shipping.postcode || '',
    Town: shipping.city || '',
    ContactName: order.customer_name || 'Customer',
    Email: order.email,
    Phone: order.phone,
    County: null,
  };

  const body = {
    Items: [
      {
        Id: crypto.randomUUID(),
        Upsells: [],
        CollectionDate: null,
        Parcels: [
          {
            Id: '00000000-0000-0000-0000-000000000000',
            EstimatedValue: Math.round(order.total_pence) / 100,
            Weight: weightKg,
            Length: lengthCm,
            Width: widthCm,
            Height: heightCm,
            DeliveryAddress: deliveryAddress,
            ContentsSummary: `27beauty order ${order.order_number}`,
            Contents: null,
          },
        ],
        Service: 'hermes-uk-economy',
        CollectionAddress: collectionAddress,
      },
    ],
    CustomerDetails: {
      Email: order.email,
      Forename: order.customer_name || 'Customer',
      Surname: nameRest.join(' ') || '-',
      OptInToEmails: false,
      OptInToPhone: false,
      OptInToPost: false,
      OptInToOther: false,
    },
  };

  const res = await fetch(`${API_ROOT}/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Parcel2Go order creation failed: HTTP ${res.status} ${text.slice(0, 300)}`);
  }
  const json = (await res.json()) as { OrderId: string; Links?: { payment?: string } };
  return { orderId: json.OrderId, paymentUrl: json.Links?.payment ?? null };
}

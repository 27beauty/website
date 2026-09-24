import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env, Order } from '../src/types';
import {
  bookShipment,
  mapQuotes,
  parcel2goErrorMessage,
  parcelForOrder,
  parseParcel,
  prepayProblemHint,
  splitAddressLine,
  toIso3Country,
  type BookingChoice,
  type Parcel,
  type ParcelLine,
} from '../src/lib/parcel2go';

describe('splitAddressLine', () => {
  it('splits a typical UK address line into property and street', () => {
    expect(splitAddressLine('4 Leamington Close')).toEqual({ property: '4', street: 'Leamington Close' });
  });

  it('falls back to the whole line for both fields when there is no space', () => {
    expect(splitAddressLine('Flat3B')).toEqual({ property: 'Flat3B', street: 'Flat3B' });
  });

  it('returns empty strings for empty input', () => {
    expect(splitAddressLine(undefined)).toEqual({ property: '', street: '' });
    expect(splitAddressLine('')).toEqual({ property: '', street: '' });
  });
});

describe('toIso3Country', () => {
  it('maps common GB spellings to GBR', () => {
    expect(toIso3Country('GB')).toBe('GBR');
    expect(toIso3Country('UK')).toBe('GBR');
    expect(toIso3Country('gb')).toBe('GBR');
  });

  it('passes through an existing ISO3 code', () => {
    expect(toIso3Country('FRA')).toBe('FRA');
  });

  it('defaults to GBR for missing or unrecognised input', () => {
    expect(toIso3Country(null)).toBe('GBR');
    expect(toIso3Country('XX')).toBe('GBR');
  });
});

const DEFAULTS: Parcel = { weightKg: 1, lengthCm: 30, widthCm: 20, heightCm: 5 };
const unsized = (quantity = 1): ParcelLine => ({ quantity, weight_g: null, length_cm: null, width_cm: null, height_cm: null });
const sized = (quantity: number, weight_g: number, l: number, w: number, h: number): ParcelLine => ({
  quantity,
  weight_g,
  length_cm: l,
  width_cm: w,
  height_cm: h,
});

describe('parcelForOrder', () => {
  it('uses the default parcel when no product has a size', () => {
    expect(parcelForOrder([unsized(), unsized(3)], DEFAULTS)).toEqual(DEFAULTS);
  });

  it('does not multiply the default weight by quantity', () => {
    expect(parcelForOrder([unsized(4)], DEFAULTS).weightKg).toBe(1);
  });

  it('sums real weights across quantities when every item is weighed and measured', () => {
    const parcel = parcelForOrder([sized(2, 150, 10, 8, 4), sized(1, 300, 20, 5, 5)], DEFAULTS);
    expect(parcel).toEqual({ weightKg: 0.6, lengthCm: 20, widthCm: 8, heightCm: 5 });
  });

  it('never goes below the default weight while any item is unweighed', () => {
    expect(parcelForOrder([sized(1, 200, 10, 10, 10), unsized()], DEFAULTS).weightKg).toBe(1);
    expect(parcelForOrder([sized(3, 800, 10, 10, 10), unsized()], DEFAULTS).weightKg).toBe(2.4);
  });

  it('takes the largest dimension from any unit, counting unmeasured units as the default box', () => {
    const parcel = parcelForOrder([sized(1, 100, 40, 10, 3), unsized()], DEFAULTS);
    expect(parcel).toMatchObject({ lengthCm: 40, widthCm: 20, heightCm: 5 });
  });

  it('falls back to the default for an empty order', () => {
    expect(parcelForOrder([], DEFAULTS)).toEqual(DEFAULTS);
  });
});

describe('parseParcel', () => {
  it('reads numeric strings from a form', () => {
    expect(parseParcel({ weight_kg: '2.5', length_cm: '40', width_cm: '30', height_cm: '10' }, DEFAULTS)).toEqual({
      weightKg: 2.5,
      lengthCm: 40,
      widthCm: 30,
      heightCm: 10,
    });
  });

  it('falls back for missing, zero, negative or absurd values', () => {
    expect(parseParcel({ weight_kg: '', length_cm: '0', width_cm: '-3', height_cm: '99999' }, DEFAULTS)).toEqual(DEFAULTS);
  });
});

describe('mapQuotes', () => {
  it('converts prices to pence, sorts cheapest first and keeps drop-off distance', () => {
    const quotes = mapQuotes({
      Quotes: [
        {
          Service: { Slug: 'dpd-next-day', Name: 'Next Day', CourierName: 'DPD', CollectionType: 'Collection' },
          TotalPrice: 6.99,
          Collection: '2026-09-25T00:00:00',
          EstimatedDeliveryDate: '2026-09-26T00:00:00',
        },
        {
          Service: { Slug: 'evri-drop', Name: 'Drop Off', CourierName: 'Evri', CollectionType: 'DropOff' },
          TotalPrice: 3.29,
          Distance: 640,
        },
      ],
    });
    expect(quotes.map((q) => [q.service, q.pricePence])).toEqual([
      ['evri-drop', 329],
      ['dpd-next-day', 699],
    ]);
    expect(quotes[0].dropShopDistanceM).toBe(640);
    expect(quotes[1].dropShopDistanceM).toBeNull();
    expect(quotes[1].collectionDate).toBe('2026-09-25T00:00:00');
  });

  it('rounds float prices to whole pence', () => {
    expect(mapQuotes({ Quotes: [{ Service: { Slug: 'x' }, TotalPrice: 4.175 }] })[0].pricePence).toBe(418);
  });

  it('drops quotes with no service or no price', () => {
    expect(mapQuotes({ Quotes: [{ Service: {}, TotalPrice: 3 }, { Service: { Slug: 'y' } }] })).toEqual([]);
    expect(mapQuotes({})).toEqual([]);
  });
});

describe('parcel2goErrorMessage', () => {
  it('reads the Errors list', () => {
    expect(parcel2goErrorMessage(400, JSON.stringify({ Errors: [{ Name: 'x', Description: 'Insufficient PrePay balance' }] }))).toBe(
      'HTTP 400 — Insufficient PrePay balance',
    );
  });

  it('reads a Message body and falls back to raw text', () => {
    expect(parcel2goErrorMessage(403, JSON.stringify({ Message: 'Forbidden scope' }))).toBe('HTTP 403 — Forbidden scope');
    expect(parcel2goErrorMessage(500, 'oops')).toBe('HTTP 500 — oops');
    expect(parcel2goErrorMessage(502, '')).toBe('HTTP 502');
  });
});

describe('prepayProblemHint', () => {
  it('distinguishes bad credentials, missing PrePay permission and outages', () => {
    expect(prepayProblemHint('Parcel2Go OAuth token request failed: HTTP 400')).toContain('credentials');
    expect(prepayProblemHint('Parcel2Go /prepay: HTTP 403 — Forbidden')).toContain('apihelp@parcel2go.com');
    expect(prepayProblemHint('Parcel2Go /prepay: HTTP 503')).toContain('try again');
  });
});

// ---------------------------------------------------------------------------
// bookShipment — fake D1/KV and a stubbed fetch; no network.
// ---------------------------------------------------------------------------

interface FakeState {
  claimSucceeds: boolean;
  writes: { sql: string; args: unknown[] }[];
}

function fakeEnv(state: FakeState): Env {
  const settings: Record<string, unknown> = {
    'store.address': '4 Leamington Close, Blackburn, BB2 6AL',
    'store.name': '27beauty Ltd',
    'store.email': 'owner@example.com',
  };
  const DB = {
    prepare(sql: string) {
      let args: unknown[] = [];
      const stmt = {
        bind(...a: unknown[]) {
          args = a;
          return stmt;
        },
        async first() {
          if (sql.includes('FROM settings')) {
            const key = args[0] as string;
            return key in settings ? { value: JSON.stringify(settings[key]) } : null;
          }
          return null;
        },
        async run() {
          state.writes.push({ sql, args });
          const isClaim = sql.includes("parcel2go_status = 'booking'") && sql.includes("status = 'paid'");
          return { meta: { changes: isClaim ? (state.claimSucceeds ? 1 : 0) : 1 } };
        },
      };
      return stmt;
    },
  };
  const KV = { get: async () => 'cached-token', put: async () => undefined };
  return {
    DB,
    KV,
    SITE_NAME: '27beauty',
    SUPPORT_EMAIL: 'support@example.com',
    PARCEL2GO_CLIENT_ID: 'id',
    PARCEL2GO_CLIENT_SECRET: 'secret',
  } as unknown as Env;
}

function paidOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: 7,
    order_number: '27B-TEST',
    status: 'paid',
    email: 'shopper@example.com',
    customer_name: 'Sam Shopper',
    phone: '07700900000',
    total_pence: 1999,
    shipping_json: JSON.stringify({ line1: '1 High Street', city: 'Leeds', postcode: 'LS1 1AA', country: 'GB' }),
    parcel2go_order_id: null,
    parcel2go_hash: null,
    parcel2go_service: null,
    parcel2go_price_pence: null,
    parcel2go_status: null,
    ...overrides,
  } as Order;
}

const CHOICE: BookingChoice = {
  service: 'evri-drop',
  courier: 'Evri',
  collectionDate: '2026-09-25T00:00:00',
  quotedPence: 329,
  parcel: DEFAULTS,
};

type Handler = (url: string, init?: RequestInit) => unknown;

function stubFetch(routes: Record<string, Handler>) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const path = url.replace('https://www.parcel2go.com/api', '').split('?')[0];
    const method = init?.method ?? 'GET';
    calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const key = Object.keys(routes).find((k) => `${method} ${path}`.startsWith(k));
    if (!key) return new Response('not stubbed', { status: 500 });
    const result = routes[key](url, init);
    return result instanceof Response ? result : Response.json(result);
  });
  return calls;
}

describe('bookShipment', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('refuses without calling Parcel2Go when the order cannot be claimed (double click)', async () => {
    const state: FakeState = { claimSucceeds: false, writes: [] };
    const calls = stubFetch({});
    const result = await bookShipment(fakeEnv(state), paidOrder(), CHOICE);
    expect(result.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it('creates, pays and records tracking on the happy path', async () => {
    const state: FakeState = { claimSucceeds: true, writes: [] };
    const calls = stubFetch({
      'POST /orders/P1/paywithprepay': () => ({ Links: [] }),
      'POST /orders': () => ({ OrderId: 'P1', Hash: 'h1', TotalPrice: 3.29 }),
      'GET /labels/P1/separate': () => ({ Items: [{ CourierTrackingNumbers: ['EV123'] }] }),
    });
    const result = await bookShipment(fakeEnv(state), paidOrder(), CHOICE);
    expect(result).toEqual({ ok: true, trackingNumber: 'EV123' });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /orders',
      'POST /orders/P1/paywithprepay',
      'GET /labels/P1/separate',
    ]);
    // The owner, not the shopper, is Parcel2Go's customer.
    const created = calls[0].body as { CustomerDetails: { Email: string } };
    expect(created.CustomerDetails.Email).toBe('owner@example.com');
    expect(state.writes.some((w) => w.sql.includes("parcel2go_status = 'booked'"))).toBe(true);
  });

  it('does not pay when the created order costs more than the quote', async () => {
    const state: FakeState = { claimSucceeds: true, writes: [] };
    const calls = stubFetch({
      'POST /orders': () => ({ OrderId: 'P2', Hash: 'h2', TotalPrice: 5.99 }),
    });
    const result = await bookShipment(fakeEnv(state), paidOrder(), CHOICE);
    expect(result.ok).toBe(false);
    expect(calls.some((c) => c.path.includes('paywithprepay'))).toBe(false);
    expect(state.writes.some((w) => w.sql.includes("parcel2go_status = 'error'"))).toBe(true);
  });

  it('reuses the unpaid Parcel2Go order on retry instead of creating another', async () => {
    const state: FakeState = { claimSucceeds: true, writes: [] };
    const calls = stubFetch({
      'POST /orders/P3/paywithprepay': () => ({ Links: [] }),
      'GET /labels/P3/separate': () => new Response('not ready', { status: 404 }),
    });
    const order = paidOrder({
      parcel2go_status: 'error',
      parcel2go_order_id: 'P3',
      parcel2go_hash: 'h3',
      parcel2go_service: 'evri-drop',
      parcel2go_price_pence: 329,
    });
    const result = await bookShipment(fakeEnv(state), order, CHOICE);
    expect(result).toEqual({ ok: true, trackingNumber: null });
    expect(calls.some((c) => c.method === 'POST' && c.path === '/orders')).toBe(false);
  });

  it('records a payment failure (e.g. low PrePay balance) as an error', async () => {
    const state: FakeState = { claimSucceeds: true, writes: [] };
    stubFetch({
      'POST /orders/P4/paywithprepay': () =>
        new Response(JSON.stringify({ Errors: [{ Description: 'Insufficient balance' }] }), { status: 400 }),
      'POST /orders': () => ({ OrderId: 'P4', Hash: 'h4', TotalPrice: 3.29 }),
    });
    const result = await bookShipment(fakeEnv(state), paidOrder(), CHOICE);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('Insufficient balance');
    expect(state.writes.some((w) => w.sql.includes("parcel2go_status = 'booked'"))).toBe(false);
  });
});

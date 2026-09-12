import { describe, expect, it } from 'vitest';
import { parseCouponBoundary, validateCoupon } from '../src/lib/coupons';
import type { Coupon, Env } from '../src/types';

/**
 * A fake D1 that answers only the two queries `validateCoupon` issues. It is
 * deliberately dumb: if the SQL changes shape, these tests fail loudly rather
 * than passing against a stub that no longer matches reality.
 */
function fakeEnv(coupon: Coupon | null, redemptionsForEmail = 0): Env {
  const db = {
    prepare(sql: string) {
      const statement = {
        _args: [] as unknown[],
        bind(...args: unknown[]) {
          statement._args = args;
          return statement;
        },
        async first<T>(): Promise<T | null> {
          if (sql.includes('FROM coupons WHERE code')) {
            if (!coupon) return null;
            return (coupon.code === statement._args[0] ? coupon : null) as T | null;
          }
          if (sql.includes('FROM coupon_redemptions')) {
            return { n: redemptionsForEmail } as T;
          }
          throw new Error(`Unexpected SQL in test: ${sql}`);
        },
      };
      return statement;
    },
  };
  return { DB: db } as unknown as Env;
}

const iso = (offsetDays: number) =>
  new Date(Date.now() + offsetDays * 86_400_000).toISOString().replace('T', ' ').slice(0, 19);

const coupon = (over: Partial<Coupon> = {}): Coupon => ({
  id: 1,
  code: 'QR10',
  kind: 'percent',
  value: 10,
  description: null,
  min_spend_pence: 0,
  max_redemptions: null,
  times_used: 0,
  per_customer_limit: null,
  free_shipping: 0,
  starts_at: null,
  expires_at: null,
  active: 1,
  batch: null,
  created_at: '2026-01-01 00:00:00',
  ...over,
});

describe('parseCouponBoundary', () => {
  it('reads a D1 timestamp as UTC', () => {
    expect(parseCouponBoundary('2026-06-01 12:00:00', 'end')).toBe(Date.parse('2026-06-01T12:00:00Z'));
  });

  it('treats a date-only expiry as the end of that day', () => {
    expect(parseCouponBoundary('2026-12-31', 'end')).toBe(Date.parse('2026-12-31T23:59:59Z'));
    expect(parseCouponBoundary('2026-12-31', 'start')).toBe(Date.parse('2026-12-31T00:00:00Z'));
  });

  it('reads a datetime-local form value', () => {
    expect(parseCouponBoundary('2026-12-31T18:30', 'end')).toBe(Date.parse('2026-12-31T18:30:00Z'));
  });

  it('returns null for blank or unparseable values rather than NaN', () => {
    expect(parseCouponBoundary(null, 'end')).toBeNull();
    expect(parseCouponBoundary('   ', 'end')).toBeNull();
    expect(parseCouponBoundary('not a date', 'end')).toBeNull();
  });
});

describe('validateCoupon', () => {
  it('applies a valid code', async () => {
    const res = await validateCoupon(fakeEnv(coupon()), 'QR10', 2000);
    expect(res.coupon?.code).toBe('QR10');
    expect(res.discountPence).toBe(200);
    expect(res.error).toBeUndefined();
  });

  it('accepts the code however the customer types it', async () => {
    const res = await validateCoupon(fakeEnv(coupon()), ' qr-10 ', 2000);
    expect(res.coupon?.code).toBe('QR10');
  });

  it('rejects an unknown code', async () => {
    const res = await validateCoupon(fakeEnv(null), 'NOPE', 2000);
    expect(res.coupon).toBeNull();
    expect(res.error).toMatch(/not recognised/i);
    expect(res.discountPence).toBe(0);
  });

  it('rejects a deactivated code', async () => {
    const res = await validateCoupon(fakeEnv(coupon({ active: 0 })), 'QR10', 2000);
    expect(res.coupon).toBeNull();
    expect(res.error).toMatch(/no longer active/i);
  });

  it('rejects an expired code and one that has not started', async () => {
    const expired = await validateCoupon(fakeEnv(coupon({ expires_at: iso(-1) })), 'QR10', 2000);
    expect(expired.error).toMatch(/expired/i);

    const future = await validateCoupon(fakeEnv(coupon({ starts_at: iso(1) })), 'QR10', 2000);
    expect(future.error).toMatch(/not active yet/i);
  });

  it('honours a date-only expiry until the end of that day', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const res = await validateCoupon(fakeEnv(coupon({ expires_at: today })), 'QR10', 2000);
    expect(res.error).toBeUndefined();
    expect(res.coupon?.code).toBe('QR10');
  });

  it('ignores an unparseable date instead of silently never expiring', async () => {
    const res = await validateCoupon(fakeEnv(coupon({ expires_at: 'whenever' })), 'QR10', 2000);
    expect(res.coupon?.code).toBe('QR10');
  });

  it('accepts a code inside its window', async () => {
    const res = await validateCoupon(
      fakeEnv(coupon({ starts_at: iso(-1), expires_at: iso(1) })),
      'QR10',
      2000,
    );
    expect(res.coupon).not.toBeNull();
  });

  it('enforces a single-use card', async () => {
    const res = await validateCoupon(
      fakeEnv(coupon({ max_redemptions: 1, times_used: 1 })),
      'QR10',
      2000,
    );
    expect(res.error).toMatch(/already been used/i);
  });

  it('enforces the minimum spend, and says what it is', async () => {
    const res = await validateCoupon(fakeEnv(coupon({ min_spend_pence: 2500 })), 'QR10', 2000);
    expect(res.error).toBe('Spend at least £25.00 to use this code.');
    expect(res.discountPence).toBe(0);
  });

  it('ignores the minimum spend on the QR landing page, where the basket is empty', async () => {
    const res = await validateCoupon(fakeEnv(coupon({ min_spend_pence: 2500 })), 'QR10', 0, null, {
      ignoreMinSpend: true,
    });
    expect(res.coupon?.code).toBe('QR10');
    expect(res.error).toBeUndefined();
  });

  it('enforces a per-customer limit only when an email is known', async () => {
    const spent = await validateCoupon(
      fakeEnv(coupon({ per_customer_limit: 1 }), 1),
      'QR10',
      2000,
      'repeat@example.com',
    );
    expect(spent.error).toMatch(/already used/i);

    const anonymous = await validateCoupon(fakeEnv(coupon({ per_customer_limit: 1 }), 1), 'QR10', 2000);
    expect(anonymous.coupon).not.toBeNull();
  });

  it('passes free shipping through', async () => {
    const res = await validateCoupon(fakeEnv(coupon({ free_shipping: 1 })), 'QR10', 2000);
    expect(res.freeShipping).toBe(true);
  });

  it('treats a missing code as no coupon rather than an error', async () => {
    const res = await validateCoupon(fakeEnv(coupon()), null, 2000);
    expect(res.coupon).toBeNull();
    expect(res.error).toBeUndefined();
  });
});

import type { Coupon, Env } from '../types';
import { normaliseCouponCode } from './util';

/**
 * Coupon rules. The QR cards handed to marketplace customers carry a code that
 * resolves here — usually the 10% "QR10" code, or a single-use code per card.
 */

export interface CouponCheck {
  coupon: Coupon | null;
  error?: string;
  discountPence: number;
  freeShipping: boolean;
}

/**
 * Coupon dates arrive in three shapes: D1's own "YYYY-MM-DD HH:MM:SS", an
 * admin <input type="date"> ("YYYY-MM-DD") and a datetime-local
 * ("YYYY-MM-DDTHH:MM"). All are stored and compared as UTC. A date-only
 * expiry means the END of that day, so a card marked "valid until 31 Dec" works
 * all day on the 31st.
 */
export function parseCouponBoundary(value: string | null, edge: 'start' | 'end'): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return Date.parse(`${trimmed}T${edge === 'end' ? '23:59:59' : '00:00:00'}Z`);
  }

  const normalised = trimmed.replace(' ', 'T');
  const withSeconds = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(normalised)
    ? `${normalised}:00`
    : normalised;
  const parsed = Date.parse(/[Zz]|[+-]\d{2}:\d{2}$/.test(withSeconds) ? withSeconds : `${withSeconds}Z`);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function findCoupon(env: Env, code: string): Promise<Coupon | null> {
  const normalised = normaliseCouponCode(code);
  if (!normalised) return null;
  return env.DB.prepare('SELECT * FROM coupons WHERE code = ?')
    .bind(normalised)
    .first<Coupon>();
}

/** Discount for a subtotal, never more than the subtotal itself. */
export function computeDiscount(coupon: Coupon, subtotalPence: number): number {
  if (subtotalPence <= 0) return 0;
  const raw =
    coupon.kind === 'percent'
      ? Math.round((subtotalPence * Math.min(Math.max(coupon.value, 0), 100)) / 100)
      : Math.max(coupon.value, 0);
  return Math.min(raw, subtotalPence);
}

export interface ValidateOptions {
  /**
   * Skips the minimum-spend rule. Used by the QR landing page, where the
   * basket is still empty: the code is genuinely valid, the shopper simply has
   * not put anything in the basket yet.
   */
  ignoreMinSpend?: boolean;
}

/**
 * Validates a code against the current basket. `email` is optional and only
 * used to enforce a per-customer limit at checkout time.
 */
export async function validateCoupon(
  env: Env,
  code: string | null | undefined,
  subtotalPence: number,
  email?: string | null,
  options: ValidateOptions = {},
): Promise<CouponCheck> {
  const empty: CouponCheck = { coupon: null, discountPence: 0, freeShipping: false };
  if (!code) return empty;

  const coupon = await findCoupon(env, code);
  if (!coupon) return { ...empty, error: 'That code was not recognised.' };
  if (!coupon.active) return { ...empty, error: 'That code is no longer active.' };

  const now = Date.now();
  const startsAt = parseCouponBoundary(coupon.starts_at, 'start');
  const expiresAt = parseCouponBoundary(coupon.expires_at, 'end');
  if (startsAt !== null && startsAt > now) {
    return { ...empty, error: 'That code is not active yet.' };
  }
  if (expiresAt !== null && expiresAt < now) {
    return { ...empty, error: 'That code has expired.' };
  }
  if (coupon.max_redemptions !== null && coupon.times_used >= coupon.max_redemptions) {
    return { ...empty, error: 'That code has already been used.' };
  }
  if (!options.ignoreMinSpend && subtotalPence < coupon.min_spend_pence) {
    return {
      ...empty,
      error: `Spend at least £${(coupon.min_spend_pence / 100).toFixed(2)} to use this code.`,
    };
  }
  if (email && coupon.per_customer_limit !== null) {
    const row = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM coupon_redemptions WHERE coupon_id = ? AND lower(email) = lower(?)',
    )
      .bind(coupon.id, email)
      .first<{ n: number }>();
    if ((row?.n ?? 0) >= coupon.per_customer_limit) {
      return { ...empty, error: 'You have already used this code.' };
    }
  }

  return {
    coupon,
    discountPence: computeDiscount(coupon, subtotalPence),
    freeShipping: coupon.free_shipping === 1,
  };
}

/**
 * Records a redemption once an order is paid. Idempotent per (coupon, order):
 * the unique index means a replayed Stripe webhook cannot double-count.
 */
export async function recordRedemption(
  env: Env,
  couponId: number,
  orderId: number,
  email: string | null,
  amountPence: number,
): Promise<boolean> {
  const res = await env.DB.prepare(
    `INSERT OR IGNORE INTO coupon_redemptions (coupon_id, order_id, email, amount_pence)
     VALUES (?, ?, ?, ?)`,
  )
    .bind(couponId, orderId, email, amountPence)
    .run();
  const inserted = (res.meta.changes ?? 0) > 0;
  if (inserted) {
    await env.DB.prepare('UPDATE coupons SET times_used = times_used + 1 WHERE id = ?')
      .bind(couponId)
      .run();
  }
  return inserted;
}

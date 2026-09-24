import type { CartItem, Coupon, Env } from '../types';
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
  /** Title of the product an item-scoped coupon applies to, for the UI. */
  productTitle?: string;
}

/**
 * The part of the basket a coupon may discount.
 *
 * Almost every coupon here discounts everything — a card that takes 10% off the
 * whole basket is what gets a marketplace customer to fill one. A coupon is
 * restricted to a single product only when `product_only` is set, in which case
 * it sees just that product's lines and never quietly discounts the rest.
 * `product_id` alone means "this is the product the QR card features", not a
 * restriction.
 */
export function eligiblePence(coupon: Coupon, subtotalPence: number, items?: CartItem[]): number {
  if (!coupon.product_id || coupon.product_only !== 1) return subtotalPence;
  if (!items) return 0;
  return items
    .filter((item) => item.product.id === coupon.product_id)
    .reduce((sum, item) => sum + item.lineTotalPence, 0);
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
  /** The resolved basket, needed to price a coupon tied to one product. */
  items?: CartItem[];
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
  const eligible = eligiblePence(coupon, subtotalPence, options.items);

  // An item-scoped code is valid, just not yet usable, until that item is in
  // the basket — say which item rather than "not recognised".
  if (coupon.product_id && coupon.product_only === 1 && eligible <= 0 && !options.ignoreMinSpend) {
    const product = await env.DB.prepare('SELECT title FROM products WHERE id = ?')
      .bind(coupon.product_id)
      .first<{ title: string }>();
    return {
      ...empty,
      error: product
        ? `This code is for ${product.title} — add it to your basket to use the discount.`
        : 'This code is for an item that is no longer available.',
    };
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

  const productTitle = coupon.product_id
    ? (
        await env.DB.prepare('SELECT title FROM products WHERE id = ?')
          .bind(coupon.product_id)
          .first<{ title: string }>()
      )?.title
    : undefined;

  return {
    coupon,
    discountPence: computeDiscount(coupon, eligible),
    freeShipping: coupon.free_shipping === 1,
    productTitle,
  };
}

export interface RedemptionResult {
  /** True when this call recorded a new redemption. */
  recorded: boolean;
  /** True when the code was already at its redemption limit — needs a human. */
  overLimit: boolean;
}

/**
 * Records a redemption once an order is paid.
 *
 * Idempotent per (coupon, order): the unique index means a replayed Stripe
 * webhook cannot double-count one order. The usage counter is incremented with
 * the limit in the WHERE clause, so two customers paying at the same moment
 * with the same single-use card cannot both slip past the cap — a shared or
 * photographed QR card is exactly the threat here. The second one is reported
 * back as `overLimit` so the order can be flagged rather than silently honoured.
 */
export async function recordRedemption(
  env: Env,
  couponId: number,
  orderId: number,
  email: string | null,
  amountPence: number,
): Promise<RedemptionResult> {
  const claim = await env.DB.prepare(
    `UPDATE coupons
        SET times_used = times_used + 1
      WHERE id = ?
        AND (max_redemptions IS NULL OR times_used < max_redemptions)`,
  )
    .bind(couponId)
    .run();

  if ((claim.meta.changes ?? 0) === 0) {
    // Already at the cap. Record nothing, and tell the caller to flag it.
    return { recorded: false, overLimit: true };
  }

  const res = await env.DB.prepare(
    `INSERT OR IGNORE INTO coupon_redemptions (coupon_id, order_id, email, amount_pence)
     VALUES (?, ?, ?, ?)`,
  )
    .bind(couponId, orderId, email, amountPence)
    .run();

  if ((res.meta.changes ?? 0) === 0) {
    // This order was already counted (a replayed webhook) — give the claim back.
    await env.DB.prepare('UPDATE coupons SET times_used = MAX(0, times_used - 1) WHERE id = ?')
      .bind(couponId)
      .run();
    return { recorded: false, overLimit: false };
  }

  return { recorded: true, overLimit: false };
}

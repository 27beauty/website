import type { Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import type { AppBindings, CartItem, CartLine, CartTotals, Env } from '../types';
import { getProductsByIds } from './db';
import { validateCoupon } from './coupons';
import { getShippingConfig } from './settings';
import { signPayload, verifyPayload } from './crypto';

/**
 * The basket lives in a signed cookie so the storefront stays stateless and
 * fast at the edge. Prices are always recomputed from the database.
 */

export const CART_COOKIE = 'cart';
export const COUPON_COOKIE = 'coupon';
export const MAX_LINE_QUANTITY = 20;

const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'Lax',
  path: '/',
  maxAge: 60 * 60 * 24 * 30,
} as const;

export async function readCartLines(c: Context<AppBindings>): Promise<CartLine[]> {
  const raw = getCookie(c, CART_COOKIE);
  const lines = await verifyPayload<CartLine[]>(raw, c.env.SESSION_SECRET);
  if (!Array.isArray(lines)) return [];
  return lines
    .filter((l) => l && Number.isInteger(l.id) && l.id > 0 && Number.isInteger(l.q) && l.q > 0)
    .map((l) => ({ id: l.id, q: Math.min(l.q, MAX_LINE_QUANTITY) }))
    .slice(0, 50);
}

export async function writeCartLines(c: Context<AppBindings>, lines: CartLine[]): Promise<void> {
  const cleaned = lines.filter((l) => l.q > 0).slice(0, 50);
  const token = await signPayload(cleaned, c.env.SESSION_SECRET);
  setCookie(c, CART_COOKIE, token, { ...COOKIE_OPTS, secure: isSecure(c) });
}

export function readCouponCode(c: Context<AppBindings>): string | null {
  return getCookie(c, COUPON_COOKIE) ?? null;
}

export function writeCouponCode(c: Context<AppBindings>, code: string | null): void {
  if (!code) {
    setCookie(c, COUPON_COOKIE, '', { ...COOKIE_OPTS, maxAge: 0, secure: isSecure(c) });
    return;
  }
  setCookie(c, COUPON_COOKIE, code, { ...COOKIE_OPTS, httpOnly: false, secure: isSecure(c) });
}

export function clearCart(c: Context<AppBindings>): void {
  setCookie(c, CART_COOKIE, '', { ...COOKIE_OPTS, maxAge: 0, secure: isSecure(c) });
  setCookie(c, COUPON_COOKIE, '', { ...COOKIE_OPTS, maxAge: 0, secure: isSecure(c) });
}

function isSecure(c: Context<AppBindings>): boolean {
  return new URL(c.req.url).protocol === 'https:';
}

export function addLine(lines: CartLine[], productId: number, quantity: number): CartLine[] {
  const next = lines.map((l) => ({ ...l }));
  const existing = next.find((l) => l.id === productId);
  if (existing) {
    existing.q = Math.min(existing.q + quantity, MAX_LINE_QUANTITY);
  } else {
    next.push({ id: productId, q: Math.min(Math.max(quantity, 1), MAX_LINE_QUANTITY) });
  }
  return next;
}

export function setLineQuantity(lines: CartLine[], productId: number, quantity: number): CartLine[] {
  if (quantity <= 0) return lines.filter((l) => l.id !== productId);
  return lines.map((l) =>
    l.id === productId ? { ...l, q: Math.min(quantity, MAX_LINE_QUANTITY) } : l,
  );
}

/**
 * Resolves cookie lines against the catalogue and prices the basket.
 * Out-of-stock lines are dropped; over-ordered lines are clamped to stock.
 */
export async function buildCart(
  env: Env,
  lines: CartLine[],
  couponCode?: string | null,
  email?: string | null,
): Promise<CartTotals> {
  const products = await getProductsByIds(
    env,
    lines.map((l) => l.id),
  );
  const items: CartItem[] = [];

  for (const product of products) {
    if (product.status !== 'active') continue;
    const line = lines.find((l) => l.id === product.id);
    if (!line) continue;
    const quantity = Math.min(line.q, product.stock);
    if (quantity <= 0) continue;
    items.push({
      product,
      quantity,
      lineTotalPence: quantity * product.price_pence,
      clamped: quantity < line.q,
    });
  }

  const subtotalPence = items.reduce((sum, i) => sum + i.lineTotalPence, 0);
  const itemCount = items.reduce((sum, i) => sum + i.quantity, 0);

  const check = await validateCoupon(env, couponCode, subtotalPence, email);
  const discountPence = check.discountPence;

  const { flatPence, freeThresholdPence } = await getShippingConfig(env);
  const afterDiscount = Math.max(subtotalPence - discountPence, 0);
  let shippingPence = items.length === 0 ? 0 : flatPence;
  if (check.freeShipping) shippingPence = 0;
  if (freeThresholdPence > 0 && afterDiscount >= freeThresholdPence) shippingPence = 0;

  return {
    items,
    itemCount,
    subtotalPence,
    discountPence,
    shippingPence,
    totalPence: afterDiscount + shippingPence,
    coupon: check.coupon,
    couponError: check.error,
  };
}

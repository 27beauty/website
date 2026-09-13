import { describe, expect, it } from 'vitest';
import { addLine, setLineQuantity, MAX_LINE_QUANTITY } from '../src/lib/cart';
import { computeDiscount } from '../src/lib/coupons';
import { applyMarkup, discountPercent, formatPence, penceToInput } from '../src/lib/money';
import {
  clampInt,
  excerpt,
  generateOrderNumber,
  isEmail,
  normaliseCouponCode,
  parseJsonArray,
  poundsToPence,
  slugify,
} from '../src/lib/util';
import { hashPassword, signPayload, verifyPassword, verifyPayload } from '../src/lib/crypto';
import type { Coupon } from '../src/types';

const coupon = (over: Partial<Coupon> = {}): Coupon => ({
  id: 1,
  code: 'QR10',
  kind: 'percent',
  value: 10,
  description: null,
  product_id: null,
  product_only: 0,
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

describe('money', () => {
  it('formats pence as GBP', () => {
    expect(formatPence(1299)).toBe('£12.99');
    expect(formatPence(0)).toBe('£0.00');
    expect(formatPence(100000)).toBe('£1,000.00');
  });

  it('round-trips pounds input to pence', () => {
    expect(poundsToPence('12.99')).toBe(1299);
    expect(poundsToPence('£12.99')).toBe(1299);
    expect(poundsToPence('1,000')).toBe(100000);
    expect(poundsToPence('')).toBeNull();
    expect(poundsToPence('-3')).toBeNull();
    expect(penceToInput(1299)).toBe('12.99');
  });

  it('applies a markup without drifting off integers', () => {
    expect(applyMarkup(1000, 10)).toBe(1100);
    expect(applyMarkup(999, 0)).toBe(999);
    expect(Number.isInteger(applyMarkup(1337, 7.5))).toBe(true);
  });

  it('reports a saving only when there is one', () => {
    expect(discountPercent(800, 1000)).toBe(20);
    expect(discountPercent(1000, 1000)).toBeNull();
    expect(discountPercent(1000, null)).toBeNull();
  });
});

describe('coupon discounts', () => {
  it('takes a percentage of the subtotal', () => {
    expect(computeDiscount(coupon(), 2000)).toBe(200);
  });

  it('never discounts more than the basket is worth', () => {
    expect(computeDiscount(coupon({ kind: 'fixed', value: 5000 }), 2000)).toBe(2000);
    expect(computeDiscount(coupon({ kind: 'percent', value: 250 }), 2000)).toBe(2000);
  });

  it('ignores an empty basket', () => {
    expect(computeDiscount(coupon(), 0)).toBe(0);
  });

  it('rounds to whole pence', () => {
    expect(computeDiscount(coupon({ value: 10 }), 999)).toBe(100);
  });
});

describe('basket lines', () => {
  it('merges a repeat add into one line', () => {
    const lines = addLine(addLine([], 4, 1), 4, 2);
    expect(lines).toEqual([{ id: 4, q: 3 }]);
  });

  it('caps a line at the maximum quantity', () => {
    expect(addLine([], 1, 999)[0].q).toBe(MAX_LINE_QUANTITY);
    expect(setLineQuantity([{ id: 1, q: 1 }], 1, 999)[0].q).toBe(MAX_LINE_QUANTITY);
  });

  it('removes a line when the quantity drops to zero', () => {
    expect(setLineQuantity([{ id: 1, q: 2 }], 1, 0)).toEqual([]);
  });

  it('does not mutate the input', () => {
    const original = [{ id: 1, q: 1 }];
    addLine(original, 1, 1);
    expect(original[0].q).toBe(1);
  });
});

describe('utilities', () => {
  it('slugifies product titles', () => {
    expect(slugify('Cadbury Dairy Milk 110g — 3 for £2!')).toBe('cadbury-dairy-milk-110g-3-for-2');
    expect(slugify('Salt & Vinegar')).toBe('salt-and-vinegar');
    expect(slugify('   ')).toBe('item');
  });

  it('normalises coupon codes typed any which way', () => {
    expect(normaliseCouponCode(' qr-10 ')).toBe('QR10');
    expect(normaliseCouponCode('27b_abcd')).toBe('27BABCD');
  });

  it('generates readable, unambiguous order numbers', () => {
    const numbers = new Set(Array.from({ length: 200 }, generateOrderNumber));
    expect(numbers.size).toBe(200);
    for (const n of numbers) expect(n).toMatch(/^27B-[2-9A-HJ-NP-Z]{6}$/);
  });

  it('clamps integers from untrusted input', () => {
    expect(clampInt('5', 1, 10)).toBe(5);
    expect(clampInt('999', 1, 10)).toBe(10);
    expect(clampInt('abc', 1, 10, 3)).toBe(3);
    expect(clampInt(undefined, 1, 10, 1)).toBe(1);
  });

  it('parses image arrays defensively', () => {
    expect(parseJsonArray('["a","b"]')).toEqual(['a', 'b']);
    expect(parseJsonArray('not json')).toEqual([]);
    expect(parseJsonArray(null)).toEqual([]);
    expect(parseJsonArray('[1,2,"c"]')).toEqual(['c']);
  });

  it('validates emails and truncates copy', () => {
    expect(isEmail('a@b.co.uk')).toBe(true);
    expect(isEmail('nope')).toBe(false);
    expect(excerpt('<p>Hello there friend</p>', 11)).toBe('Hello there…');
    expect(excerpt('<p>Short</p>', 40)).toBe('Short');
    expect(excerpt(null)).toBe('');
  });
});

describe('crypto', () => {
  it('signs and verifies a payload', async () => {
    const token = await signPayload([{ id: 1, q: 2 }], 'secret');
    expect(await verifyPayload(token, 'secret')).toEqual([{ id: 1, q: 2 }]);
  });

  it('rejects a tampered or wrongly-signed payload', async () => {
    const token = await signPayload([{ id: 1, q: 2 }], 'secret');
    expect(await verifyPayload(token, 'other-secret')).toBeNull();
    expect(await verifyPayload(token.slice(0, -2) + 'xx', 'secret')).toBeNull();
    expect(await verifyPayload(undefined, 'secret')).toBeNull();
    expect(await verifyPayload('garbage', 'secret')).toBeNull();
  });

  it('hashes and verifies a password', async () => {
    const hash = await hashPassword('correct horse battery staple', 1000);
    expect(hash.startsWith('pbkdf2$1000$')).toBe(true);
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
    expect(await verifyPassword('wrong password', hash)).toBe(false);
    expect(await verifyPassword('x', 'not-a-hash')).toBe(false);
  });

  it('salts each hash differently', async () => {
    const [a, b] = await Promise.all([hashPassword('same', 1000), hashPassword('same', 1000)]);
    expect(a).not.toBe(b);
  });
});

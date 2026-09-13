import { describe, expect, it } from 'vitest';
import type { CartItem, CartLine, CartTotals, Env, Product } from '../src/types';
import {
  absoluteImageUrl,
  buildDiscountCouponParams,
  buildShippingOptions,
  sumLineItemsPence,
  toLineItems,
} from '../src/lib/stripe';
import { checkStockForCheckout, orderStatusLabel } from '../src/lib/orders';

/** Minimal env stub — only the fields the pure helpers under test actually read. */
const env = { SITE_URL: 'https://27beauty.co.uk' } as Env;

function makeProduct(overrides: Partial<Product> = {}): Product {
  return {
    id: 1,
    slug: 'lip-gloss',
    title: 'Glossy Lip Gloss',
    description: null,
    category_id: null,
    brand: null,
    sku: 'SKU-1',
    price_pence: 999,
    compare_at_pence: null,
    cost_pence: null,
    stock: 10,
    image_url: '/media/lip-gloss.jpg',
    images_json: '[]',
    status: 'active',
    featured: 0,
    source: 'manual',
    ebay_item_id: null,
    ebay_account: null,
    ebay_url: null,
    ebay_synced_at: null,
  ebay_stock: null,
    price_locked: 0,
    stock_locked: 0,
    content_locked: 0,
    created_at: '2026-01-01 00:00:00',
    updated_at: '2026-01-01 00:00:00',
    ...overrides,
  };
}

function makeCartItem(overrides: Partial<CartItem> = {}, productOverrides: Partial<Product> = {}): CartItem {
  const product = makeProduct(productOverrides);
  const quantity = overrides.quantity ?? 2;
  return {
    product,
    quantity,
    lineTotalPence: quantity * product.price_pence,
    ...overrides,
  };
}

function makeCart(items: CartItem[], overrides: Partial<CartTotals> = {}): CartTotals {
  const subtotalPence = items.reduce((sum, i) => sum + i.lineTotalPence, 0);
  return {
    items,
    itemCount: items.reduce((sum, i) => sum + i.quantity, 0),
    subtotalPence,
    discountPence: 0,
    shippingPence: 349,
    totalPence: subtotalPence + 349,
    coupon: null,
    ...overrides,
  };
}

describe('toLineItems', () => {
  it('maps each cart item to a Stripe price_data line item priced in pence', () => {
    const item = makeCartItem({ quantity: 3 }, { price_pence: 1250, title: 'Rose Serum' });
    const [line] = toLineItems(env, [item]);

    expect(line.quantity).toBe(3);
    expect(line.price_data?.currency).toBe('gbp');
    expect(line.price_data?.unit_amount).toBe(1250);
    expect(line.price_data?.product_data?.name).toBe('Rose Serum');
  });

  it('never derives the unit amount from anything but product.price_pence', () => {
    // Regression guard: even if lineTotalPence looks wrong, price_data must
    // still come from the per-unit price, not a total divided by quantity.
    const item = makeCartItem({ quantity: 2, lineTotalPence: 999999 }, { price_pence: 500 });
    const [line] = toLineItems(env, [item]);
    expect(line.price_data?.unit_amount).toBe(500);
  });
});

describe('sumLineItemsPence', () => {
  it('matches the cart subtotal for a multi-line basket', () => {
    const items = [
      makeCartItem({ quantity: 2 }, { price_pence: 999 }),
      makeCartItem({ quantity: 1 }, { price_pence: 2500 }),
    ];
    const cart = makeCart(items);
    const lineItems = toLineItems(env, cart.items);
    expect(sumLineItemsPence(lineItems)).toBe(cart.subtotalPence);
  });
});

describe('absoluteImageUrl', () => {
  it('leaves absolute URLs untouched', () => {
    expect(absoluteImageUrl(env, 'https://cdn.example.com/a.jpg')).toEqual([
      'https://cdn.example.com/a.jpg',
    ]);
  });

  it('resolves a relative path against SITE_URL', () => {
    expect(absoluteImageUrl(env, '/media/a.jpg')).toEqual(['https://27beauty.co.uk/media/a.jpg']);
  });

  it('returns an empty array when there is no image', () => {
    expect(absoluteImageUrl(env, null)).toEqual([]);
  });
});

describe('buildShippingOptions', () => {
  it('charges the computed shipping amount when shipping is not free', () => {
    const [option] = buildShippingOptions(349);
    expect(option.shipping_rate_data?.fixed_amount).toEqual({ amount: 349, currency: 'gbp' });
    expect(option.shipping_rate_data?.display_name).toBe('UK delivery');
  });

  it('offers a £0 rate labelled as free shipping rather than omitting it', () => {
    const [option] = buildShippingOptions(0);
    expect(option.shipping_rate_data?.fixed_amount).toEqual({ amount: 0, currency: 'gbp' });
    expect(option.shipping_rate_data?.display_name).toBe('Free UK delivery');
  });
});

describe('buildDiscountCouponParams', () => {
  it('returns null when there is no discount', () => {
    expect(buildDiscountCouponParams(0)).toBeNull();
  });

  it('builds an amount_off, once-only, GBP coupon for a discount', () => {
    expect(buildDiscountCouponParams(150)).toEqual({
      amount_off: 150,
      currency: 'gbp',
      duration: 'once',
      name: 'Discount',
    });
  });
});

describe('checkStockForCheckout', () => {
  it('reports no issues when every requested line resolved cleanly', () => {
    const lines: CartLine[] = [{ id: 1, q: 2 }];
    const cart = makeCart([makeCartItem({ quantity: 2 }, { id: 1, stock: 10 })]);
    expect(checkStockForCheckout(lines, cart)).toEqual([]);
  });

  it('flags a line whose product disappeared from the resolved cart entirely', () => {
    const lines: CartLine[] = [{ id: 1, q: 2 }, { id: 2, q: 1 }];
    // Product 2 dropped out of the basket (e.g. sold out or deactivated).
    const cart = makeCart([makeCartItem({ quantity: 2 }, { id: 1, stock: 10 })]);
    const issues = checkStockForCheckout(lines, cart);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/no longer available/);
  });

  it('flags a line that buildCart clamped down to available stock', () => {
    const lines: CartLine[] = [{ id: 1, q: 5 }];
    const cart = makeCart([
      makeCartItem({ quantity: 2, clamped: true }, { id: 1, stock: 2, title: 'Rose Serum' }),
    ]);
    const issues = checkStockForCheckout(lines, cart);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('Rose Serum');
    expect(issues[0]).toContain('Only 2');
  });
});

describe('orderStatusLabel', () => {
  it('renders a human label for every order status', () => {
    expect(orderStatusLabel('pending')).toBe('Awaiting payment');
    expect(orderStatusLabel('paid')).toBe('Paid');
    expect(orderStatusLabel('fulfilled')).toBe('Fulfilled');
    expect(orderStatusLabel('cancelled')).toBe('Cancelled');
    expect(orderStatusLabel('refunded')).toBe('Refunded');
  });
});

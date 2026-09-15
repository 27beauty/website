import Stripe from 'stripe';
import type { CartItem, CartTotals, Env } from '../types';

/**
 * Stripe Checkout integration. All money we hand to Stripe is integer pence —
 * GBP is a 2-decimal currency so no zero-decimal conversion is needed.
 *
 * Every helper that touches the network takes an already-constructed `Stripe`
 * client so the pure request-shaping logic (line items, shipping options,
 * discount params) can be unit tested without hitting the network.
 */

const CURRENCY = 'gbp';

/** Returns null (never throws) when Stripe is not configured yet. */
export function getStripeClient(env: Env): Stripe | null {
  if (!env.STRIPE_SECRET_KEY) return null;
  return new Stripe(env.STRIPE_SECRET_KEY, {
    appInfo: { name: '27beauty', version: '1.0.0' },
  });
}

export function getWebhookSecret(env: Env): string | null {
  return env.STRIPE_WEBHOOK_SECRET ?? null;
}

/** Stripe wants fully-qualified image URLs; R2/relative paths are resolved against SITE_URL. */
export function absoluteImageUrl(env: Env, imageUrl: string | null | undefined): string[] {
  if (!imageUrl) return [];
  if (/^https?:\/\//i.test(imageUrl)) return [imageUrl];
  const base = env.SITE_URL.replace(/\/+$/, '');
  const path = imageUrl.startsWith('/') ? imageUrl : `/${imageUrl}`;
  return [`${base}${path}`];
}

/**
 * One Stripe Checkout line item per basket line, priced with `price_data` so
 * the amount always comes from what we just recomputed from D1 — never from
 * anything the client posted.
 */
export function toLineItems(
  env: Env,
  items: CartItem[],
): Stripe.Checkout.SessionCreateParams.LineItem[] {
  return items.map((item) => ({
    quantity: item.quantity,
    price_data: {
      currency: CURRENCY,
      unit_amount: item.product.price_pence,
      product_data: {
        name: item.product.title,
        images: absoluteImageUrl(env, item.product.image_url),
        metadata: {
          product_id: String(item.product.id),
          sku: item.product.sku ?? '',
        },
      },
    },
  }));
}

/** Sum of unit_amount * quantity across line items — used to sanity-check against the cart subtotal. */
export function sumLineItemsPence(items: Stripe.Checkout.SessionCreateParams.LineItem[]): number {
  return items.reduce((sum, item) => {
    const unit = item.price_data && 'unit_amount' in item.price_data ? item.price_data.unit_amount ?? 0 : 0;
    return sum + unit * (item.quantity ?? 0);
  }, 0);
}

/**
 * A single inline shipping rate representing the shipping cost we already
 * computed for this basket. A free basket still needs a £0 rate so the
 * customer sees "Free UK delivery" rather than no shipping line at all.
 */
export function buildShippingOptions(
  shippingPence: number,
): Stripe.Checkout.SessionCreateParams.ShippingOption[] {
  return [
    {
      shipping_rate_data: {
        type: 'fixed_amount',
        display_name: shippingPence > 0 ? 'UK delivery' : 'Free UK delivery',
        fixed_amount: { amount: Math.max(shippingPence, 0), currency: CURRENCY },
        delivery_estimate: {
          minimum: { unit: 'business_day', value: 2 },
          maximum: { unit: 'business_day', value: 5 },
        },
      },
    },
  ];
}

/**
 * Params for a one-off Stripe coupon mirroring our own discount, in pence.
 * Returns null when there is nothing to discount — never fake a discount by
 * editing a line item's unit price.
 */
export function buildDiscountCouponParams(discountPence: number): Stripe.CouponCreateParams | null {
  if (discountPence <= 0) return null;
  return {
    amount_off: Math.round(discountPence),
    currency: CURRENCY,
    duration: 'once',
    name: 'Discount',
  };
}

export interface CreateCheckoutSessionInput {
  orderId: number;
  orderNumber: string;
  couponCode: string | null;
  /** Null lets Stripe's own hosted page collect it — we no longer ask for it first. */
  email: string | null;
  cart: CartTotals;
}

/**
 * Creates the Stripe Checkout Session for an already-created pending order.
 * Callers are responsible for creating a one-off coupon first when a discount
 * applies (see `buildDiscountCouponParams`) and passing its id here.
 */
export async function createCheckoutSession(
  env: Env,
  stripe: Stripe,
  input: CreateCheckoutSessionInput,
  discountCouponId?: string | null,
): Promise<Stripe.Checkout.Session> {
  const siteUrl = env.SITE_URL.replace(/\/+$/, '');
  return stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: toLineItems(env, input.cart.items),
    customer_email: input.email ?? undefined,
    client_reference_id: String(input.orderId),
    metadata: {
      order_id: String(input.orderId),
      order_number: input.orderNumber,
      coupon_code: input.couponCode ?? '',
    },
    shipping_address_collection: { allowed_countries: ['GB'] },
    phone_number_collection: { enabled: true },
    shipping_options: buildShippingOptions(input.cart.shippingPence),
    discounts: discountCouponId ? [{ coupon: discountCouponId }] : undefined,
    success_url: `${siteUrl}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${siteUrl}/checkout/cancelled`,
    // Lets us capture a resumable link for the "Open baskets" admin view
    // when a session expires unpaid — see checkout.session.expired.
    after_expiration: { recovery: { enabled: true } },
  });
}

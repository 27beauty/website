import { Hono } from 'hono';
import type Stripe from 'stripe';
import type { AppBindings, ShippingAddress } from '../types';
import { getStripeClient, getWebhookSecret } from '../lib/stripe';
import { markOrderCancelled, markOrderPaid } from '../lib/orders';
import { findCoupon, recordRedemption } from '../lib/coupons';

/** Inbound webhooks (Stripe). Mounted before any body-parsing middleware. */
export const webhooks = new Hono<AppBindings>();

function extractShipping(session: Stripe.Checkout.Session): ShippingAddress | null {
  const details = session.collected_information?.shipping_details;
  if (!details?.address) return null;
  return {
    line1: details.address.line1 || undefined,
    line2: details.address.line2 || undefined,
    city: details.address.city || undefined,
    postcode: details.address.postal_code || undefined,
    country: details.address.country || undefined,
  };
}

function extractPaymentIntentId(session: Stripe.Checkout.Session): string | null {
  if (!session.payment_intent) return null;
  return typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent.id;
}

/** Marks the order paid and records the coupon redemption, both idempotently. */
async function handlePaidSession(env: AppBindings['Bindings'], session: Stripe.Checkout.Session) {
  const shipping = extractShipping(session);
  const name = session.collected_information?.shipping_details?.name ?? session.customer_details?.name ?? null;
  const phone = session.customer_details?.phone ?? null;
  const email = session.customer_details?.email ?? session.customer_email ?? null;
  const paymentIntent = extractPaymentIntentId(session);

  const { order, transitioned } = await markOrderPaid(env, {
    sessionId: session.id,
    paymentIntent,
    shipping,
    email,
    name,
    phone,
  });

  if (transitioned && order?.coupon_code) {
    const coupon = await findCoupon(env, order.coupon_code);
    if (coupon) {
      await recordRedemption(env, coupon.id, order.id, order.email, order.discount_pence);
    }
  }
}

webhooks.post('/webhooks/stripe', async (c) => {
  const env = c.env;
  const secret = getWebhookSecret(env);
  const stripe = getStripeClient(env);
  if (!secret || !stripe) {
    return c.text('Webhook not configured', 503);
  }

  const signature = c.req.header('stripe-signature');
  // Raw body only — Stripe's signature check needs the exact bytes it signed.
  const body = await c.req.text();

  let event: Stripe.Event;
  try {
    if (!signature) throw new Error('Missing stripe-signature header');
    event = await stripe.webhooks.constructEventAsync(body, signature, secret);
  } catch (err) {
    console.error('Stripe webhook signature verification failed', err);
    return c.text('Invalid signature', 400);
  }

  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      const session = event.data.object as Stripe.Checkout.Session;
      // On `completed`, a delayed payment method leaves payment_status
      // 'unpaid' — wait for async_payment_succeeded/failed instead.
      if (session.payment_status === 'paid') {
        await handlePaidSession(env, session);
      }
      break;
    }
    case 'checkout.session.expired':
    case 'checkout.session.async_payment_failed': {
      const session = event.data.object as Stripe.Checkout.Session;
      await markOrderCancelled(env, { sessionId: session.id });
      break;
    }
    default:
      break; // intentionally ignored — always 200 so Stripe stops retrying
  }

  return c.json({ received: true });
});

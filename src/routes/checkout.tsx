import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppBindings } from '../types';
import { buildCart, clearCart, readCartLines, readCouponCode } from '../lib/cart';
import { listCategories } from '../lib/db';
import { getSetting } from '../lib/settings';
import { formatPence } from '../lib/money';
import {
  attachStripeSession,
  checkStockForCheckout,
  createPendingOrder,
  getOrderByStripeSession,
  getOrderWithItems,
  markOrderCancelled,
  orderStatusLabel,
} from '../lib/orders';
import { buildDiscountCouponParams, createCheckoutSession, getStripeClient } from '../lib/stripe';
import { Layout } from '../ui/layout';
import { trackEvent } from '../lib/analytics';

/** Checkout flow: straight to Stripe Checkout (no details form of our own — Stripe collects email/address/name itself), plus success/cancel pages. */
export const checkout = new Hono<AppBindings>();

/**
 * The owner can close the till from Settings (stock-take, holiday, a pricing
 * fix). Both the review page and the pay button honour it — a switch that does
 * nothing is worse than no switch.
 */
async function checkoutClosed(c: Context<AppBindings>): Promise<Response | null> {
  const enabled = await getSetting<boolean>(c.env, 'checkout.enabled', true);
  if (enabled) return null;
  const categories = await listCategories(c.env).catch(() => []);
  return c.html(
    <Layout
      title="Checkout paused"
      categories={categories}
      cartCount={c.get('cartCount')}
      noindex
    >
      <div class="empty">
        <span class="emoji">🛠️</span>
        <h1>We've paused checkout</h1>
        <p class="muted">
          We're updating the shop and can't take orders for a moment. Your basket is saved — please
          try again shortly, or email 27beautyltd@gmail.com if you need something urgently.
        </p>
        <a class="btn" href="/cart">
          Back to your basket
        </a>
      </div>
    </Layout>,
    503,
  );
}

/**
 * Goes straight to Stripe Checkout — no details form of our own. Stripe's
 * own hosted page collects email, name (via shipping address) and phone,
 * which the webhook already reads back onto the order at payment time
 * (see routes/webhooks.ts), so collecting them ourselves first was always
 * redundant. On any problem (empty cart, stock, an invalid coupon, or
 * Stripe itself failing) this redirects back to the basket with a clear
 * message instead of leaving the shopper stuck.
 */
async function startCheckout(c: Context<AppBindings>) {
  const closed = await checkoutClosed(c);
  if (closed) return closed;

  const env = c.env;
  const lines = await readCartLines(c);
  const couponCode = readCouponCode(c);

  if (!lines.length) return c.redirect('/cart', 303);

  const stripe = getStripeClient(env);
  if (!stripe) {
    return c.redirect(
      '/cart?err=' + encodeURIComponent("Card payments aren't configured yet — please check back shortly."),
      303,
    );
  }

  const cart = await buildCart(env, lines, couponCode);
  if (!cart.items.length) return c.redirect('/cart', 303);

  const stockIssues = checkStockForCheckout(lines, cart);
  if (stockIssues.length) {
    return c.redirect('/cart?err=' + encodeURIComponent(stockIssues.join(' ')), 303);
  }

  if (cart.couponError) {
    return c.redirect(
      '/cart?err=' +
        encodeURIComponent(`${cart.couponError} Your total is up to date — continue when you're ready.`),
      303,
    );
  }

  const order = await createPendingOrder(env, { cart, email: null, name: null });
  trackEvent(c, { type: 'checkout', orderId: order.id });

  try {
    const discountParams = buildDiscountCouponParams(cart.discountPence);
    let discountCouponId: string | null = null;
    if (discountParams) {
      const stripeCoupon = await stripe.coupons.create(discountParams);
      discountCouponId = stripeCoupon.id;
    }

    const session = await createCheckoutSession(
      env,
      stripe,
      {
        orderId: order.id,
        orderNumber: order.order_number,
        couponCode: cart.coupon?.code ?? null,
        email: null,
        cart,
      },
      discountCouponId,
    );

    if (!session.url) throw new Error('Stripe did not return a Checkout URL');

    await attachStripeSession(env, order.id, session.id);
    return c.redirect(session.url, 303);
  } catch (err) {
    console.error('Stripe checkout session creation failed', err);
    await markOrderCancelled(env, { orderId: order.id });
    return c.redirect(
      '/cart?err=' + encodeURIComponent('We could not start your payment just now. Please try again in a moment.'),
      303,
    );
  }
}

checkout.get('/checkout', startCheckout);
checkout.post('/checkout/session', startCheckout);

checkout.get('/checkout/success', async (c) => {
  const sessionId = c.req.query('session_id');
  const categories = await listCategories(c.env).catch(() => []);
  clearCart(c);

  const order = sessionId ? await getOrderByStripeSession(c.env, sessionId) : null;
  const withItems = order ? await getOrderWithItems(c.env, order.id) : null;

  return c.html(
    <Layout title="Thank you" categories={categories} cartCount={c.get('cartCount')} noindex>
      <div class="stack">
        <div class="panel center">
          <h1>Thank you for your order</h1>
          {withItems ? (
            <p class="muted">
              Order <strong>{withItems.order_number}</strong> —{' '}
              {withItems.status === 'paid'
                ? 'payment confirmed, thank you!'
                : "we'll email your confirmation once payment settles."}
            </p>
          ) : (
            <p class="muted">
              We'll email your confirmation shortly once payment settles. If anything looks wrong,
              contact {c.env.SUPPORT_EMAIL}.
            </p>
          )}
        </div>

        {withItems ? (
          <div class="panel">
            <h2>Order {withItems.order_number}</h2>
            <p class="pill pill-ok">{orderStatusLabel(withItems.status)}</p>
            {withItems.items.map((item) => (
              <div class="line">
                {item.image_url ? <img src={item.image_url} alt="" /> : null}
                <div class="line-body">
                  <div class="line-title">{item.title}</div>
                  <div class="muted">
                    Qty {item.quantity} × {formatPence(item.unit_price_pence)}
                  </div>
                </div>
                <div class="nowrap">{formatPence(item.line_total_pence)}</div>
              </div>
            ))}
            <ul class="totals">
              <li>
                <span>Subtotal</span>
                <span>{formatPence(withItems.subtotal_pence)}</span>
              </li>
              {withItems.discount_pence > 0 ? (
                <li>
                  <span>Discount</span>
                  <span>-{formatPence(withItems.discount_pence)}</span>
                </li>
              ) : null}
              <li>
                <span>Delivery</span>
                <span>
                  {withItems.shipping_pence > 0 ? formatPence(withItems.shipping_pence) : 'Free'}
                </span>
              </li>
              <li class="total">
                <span>Total</span>
                <span>{formatPence(withItems.total_pence)}</span>
              </li>
            </ul>
            <p class="field-hint">
              Delivery usually takes 2–5 working days. We'll email tracking details once your order
              ships.
            </p>
          </div>
        ) : null}

        <div class="center">
          <a class="btn" href="/shop">
            Continue shopping
          </a>
        </div>
      </div>
    </Layout>,
  );
});

checkout.get('/checkout/cancelled', async (c) => {
  const categories = await listCategories(c.env).catch(() => []);
  return c.html(
    <Layout title="Checkout cancelled" categories={categories} cartCount={c.get('cartCount')} noindex>
      <div class="empty">
        <span class="emoji">🛒</span>
        <h1>No payment was taken</h1>
        <p class="muted">Your basket is still here whenever you're ready to check out.</p>
        <a class="btn" href="/cart">
          Back to your basket
        </a>
      </div>
    </Layout>,
  );
});

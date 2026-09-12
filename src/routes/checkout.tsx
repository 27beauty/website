import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppBindings, CartTotals } from '../types';
import { buildCart, clearCart, readCartLines, readCouponCode } from '../lib/cart';
import { listCategories } from '../lib/db';
import { isEmail } from '../lib/util';
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

/** Checkout flow: details form, Stripe Checkout redirect, success/cancel pages. */
export const checkout = new Hono<AppBindings>();

interface FormValues {
  email: string;
  name: string;
}

/** Shared review page for the initial GET and every "please fix this" re-render on POST. */
async function renderCheckoutPage(
  c: Context<AppBindings>,
  cart: CartTotals,
  opts: { notice?: string; values?: FormValues } = {},
) {
  const categories = await listCategories(c.env).catch(() => []);
  const values = opts.values ?? { email: '', name: '' };

  return c.html(
    <Layout
      title="Checkout"
      categories={categories}
      cartCount={c.get('cartCount')}
      noindex
    >
      <h1>Checkout</h1>
      {opts.notice ? <p class="notice notice-bad">{opts.notice}</p> : null}
      <div class="checkout-layout">
        <div>
          <div class="panel">
            <h2>Your details</h2>
            <form method="post" action="/checkout/session">
              <div class="field">
                <label for="checkout-email">Email address</label>
                <input
                  id="checkout-email"
                  name="email"
                  type="email"
                  autocomplete="email"
                  required
                  value={values.email}
                />
                <p class="field-hint">Your order confirmation goes here.</p>
              </div>
              <div class="field">
                <label for="checkout-name">Full name</label>
                <input
                  id="checkout-name"
                  name="name"
                  type="text"
                  autocomplete="name"
                  required
                  value={values.name}
                />
              </div>
              <p class="field-hint">
                Card details are entered on Stripe's secure payment page — we never see or store
                your card number.
              </p>
              <button class="btn btn-block" type="submit">
                Pay securely with card
              </button>
            </form>
          </div>

          <div class="panel">
            <h2>Your basket</h2>
            {cart.items.map((item) => (
              <div class="line">
                {item.product.image_url ? <img src={item.product.image_url} alt="" /> : null}
                <div class="line-body">
                  <div class="line-title">{item.product.title}</div>
                  <div class="muted">
                    Qty {item.quantity} × {formatPence(item.product.price_pence)}
                  </div>
                </div>
                <div class="nowrap">{formatPence(item.lineTotalPence)}</div>
              </div>
            ))}
            <p class="field-hint">
              Need to change a quantity or your discount code? <a href="/cart">Edit your basket</a>.
            </p>
          </div>
        </div>

        <div class="panel summary">
          <h2>Order summary</h2>
          {cart.coupon ? (
            <p class="notice notice-ok">Code {cart.coupon.code} applied.</p>
          ) : cart.couponError ? (
            <p class="notice notice-warn">
              {cart.couponError} <a href="/cart">Edit your code</a>.
            </p>
          ) : null}
          <ul class="totals">
            <li>
              <span>Subtotal</span>
              <span>{formatPence(cart.subtotalPence)}</span>
            </li>
            {cart.discountPence > 0 ? (
              <li>
                <span>Discount</span>
                <span>-{formatPence(cart.discountPence)}</span>
              </li>
            ) : null}
            <li>
              <span>Delivery</span>
              <span>{cart.shippingPence > 0 ? formatPence(cart.shippingPence) : 'Free'}</span>
            </li>
            <li class="total">
              <span>Total</span>
              <span>{formatPence(cart.totalPence)}</span>
            </li>
          </ul>
        </div>
      </div>
    </Layout>,
  );
}

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
          try again shortly, or email hello@27beauty.co.uk if you need something urgently.
        </p>
        <a class="btn" href="/cart">
          Back to your basket
        </a>
      </div>
    </Layout>,
    503,
  );
}

checkout.get('/checkout', async (c) => {
  const closed = await checkoutClosed(c);
  if (closed) return closed;

  const lines = await readCartLines(c);
  const couponCode = readCouponCode(c);
  const cart = await buildCart(c.env, lines, couponCode);

  if (!cart.items.length) return c.redirect('/cart', 303);

  return renderCheckoutPage(c, cart);
});

checkout.post('/checkout/session', async (c) => {
  const closed = await checkoutClosed(c);
  if (closed) return closed;

  const env = c.env;
  const form = await c.req.parseBody();
  const email = String(form.email ?? '').trim();
  const name = String(form.name ?? '').trim();
  const values: FormValues = { email, name };

  const lines = await readCartLines(c);
  const couponCode = readCouponCode(c);

  if (!lines.length) return c.redirect('/cart', 303);

  if (!isEmail(email) || !name) {
    const cart = await buildCart(env, lines, couponCode);
    return renderCheckoutPage(c, cart, {
      notice: !isEmail(email)
        ? 'Please enter a valid email address.'
        : 'Please enter your full name.',
      values,
    });
  }

  const stripe = getStripeClient(env);
  if (!stripe) {
    const cart = await buildCart(env, lines, couponCode, email);
    return renderCheckoutPage(c, cart, {
      notice: "Card payments aren't configured yet — please check back shortly.",
      values,
    });
  }

  // Recompute everything from D1 with the email attached, so per-customer
  // coupon limits apply. Never trust anything posted from the client here.
  const cart = await buildCart(env, lines, couponCode, email);

  if (!cart.items.length) return c.redirect('/cart', 303);

  const stockIssues = checkStockForCheckout(lines, cart);
  if (stockIssues.length) {
    return renderCheckoutPage(c, cart, { notice: stockIssues.join(' '), values });
  }

  if (cart.couponError) {
    return renderCheckoutPage(c, cart, {
      notice: `${cart.couponError} Your total below is up to date — continue when you're ready.`,
      values,
    });
  }

  const order = await createPendingOrder(env, { cart, email, name });

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
        email,
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
    return renderCheckoutPage(c, cart, {
      notice: 'We could not start your payment just now. Please try again in a moment.',
      values,
    });
  }
});

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

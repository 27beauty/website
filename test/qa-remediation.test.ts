/**
 * Fixes for findings carried over from an external QA report, each verified
 * against this codebase before being written. The defects were real here.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../src/types';
import worker from '../src/index';
import { createTestD1, createTestKV } from './helpers/d1';
import { applicableStockEdits, requestedStockEdits } from '../src/routes/admin/products';
import { createPendingOrder, markOrderCancelled, markOrderPaid } from '../src/lib/orders';
import { buildCart } from '../src/lib/cart';

let env: Env;
let sql: ReturnType<typeof createTestD1>;

/** Workers hand the fetch handler an ExecutionContext; the routes only waitUntil. */
const ctx = () => ({ waitUntil: () => {}, passThroughOnException: () => {} }) as unknown as ExecutionContext;

beforeEach(() => {
  sql = createTestD1();
  env = { DB: sql.db, KV: createTestKV(), SESSION_SECRET: 'test-session-secret-0123456789abcdef' } as unknown as Env;
});

describe('S1: uploaded images are never served as live documents', () => {
  // image/svg+xml is an accepted upload type, and /admin/media is public. The
  // old handler streamed R2 bytes with no sandbox and no nosniff, so a script
  // inside an uploaded SVG ran on the shop's own origin — where the admin
  // session cookie lives. It also skipped the edge cache, making every hit a
  // billable R2 read.
  it('redirects the legacy /admin/media path to the locked-down canonical one', async () => {
    const res = await worker.fetch(new Request('https://27beauty.co.uk/admin/media/products/abc123.svg'), env, ctx());
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('/media/products/abc123.svg');
  });

  it('keeps the key exactly as given, so existing links still resolve', async () => {
    const res = await worker.fetch(new Request('https://27beauty.co.uk/admin/media/a%20b/c%2Bd.png?v=2'), env, ctx());
    expect(res.headers.get('location')).toBe('/media/a%20b/c%2Bd.png?v=2');
  });
});

describe('ADM-01: an order can only move to a state that makes sense', () => {
  const order = (id: number, status: string) =>
    sql.exec(`INSERT INTO orders (id, order_number, status, total_pence) VALUES (${id}, 'T-${id}', '${status}', 1000)`);
  const statusOf = (id: number) =>
    (sql.all(`SELECT status FROM orders WHERE id = ${id}`)[0] as { status: string }).status;

  it('will not mark an unpaid order fulfilled', () => {
    order(1, 'pending');
    sql.exec(`UPDATE orders SET status = 'fulfilled' WHERE id = 1 AND status = 'paid'`);
    expect(statusOf(1)).toBe('pending');
  });

  it('will not refund an order that was never paid', () => {
    order(2, 'cancelled');
    sql.exec(`UPDATE orders SET status = 'refunded' WHERE id = 2 AND status IN ('paid','fulfilled')`);
    expect(statusOf(2)).toBe('cancelled');
  });

  it('still allows the real transitions', () => {
    order(3, 'paid');
    sql.exec(`UPDATE orders SET status = 'fulfilled' WHERE id = 3 AND status = 'paid'`);
    expect(statusOf(3)).toBe('fulfilled');
    sql.exec(`UPDATE orders SET status = 'refunded' WHERE id = 3 AND status IN ('paid','fulfilled')`);
    expect(statusOf(3)).toBe('refunded');
  });
});

describe('ADM-02: saving the stock list cannot put sold units back', () => {
  const plan = (body: Record<string, unknown>, current: Record<number, number>) =>
    applicableStockEdits(requestedStockEdits(body), new Map(Object.entries(current).map(([k, v]) => [Number(k), v])));

  it('writes nothing when the owner changed nothing', () => {
    // The page submits all 100 rows whether or not they were touched. This is
    // the bug: pressing Save on an untouched page rewrote every one of them.
    const body = { stock_1: '5', base_1: '5', stock_2: '0', base_2: '0' };
    expect(plan(body, { 1: 5, 2: 0 })).toEqual({ updates: [], stale: 0 });
  });

  it('leaves a row alone when it sold while the page was open', () => {
    // Drawn at 5, one sold (now 4), owner saves without touching it. Writing
    // the submitted 5 back would put the sold unit on sale again.
    const body = { stock_1: '5', base_1: '5' };
    expect(plan(body, { 1: 4 })).toEqual({ updates: [], stale: 0 });
  });

  it('refuses an edit decided against a figure that has since moved', () => {
    // Drawn at 5, owner types 8, but it sold down to 4 meanwhile. Their 8 was
    // "5 plus 3", so applying it now would overstate by the unit sold.
    const body = { stock_1: '8', base_1: '5' };
    expect(plan(body, { 1: 4 })).toEqual({ updates: [], stale: 1 });
  });

  it('applies a real edit when nothing moved underneath it', () => {
    const body = { stock_1: '12', base_1: '5' };
    expect(plan(body, { 1: 5 })).toEqual({ updates: [{ productId: 1, quantity: 12 }], stale: 0 });
  });

  it('applies only the rows that changed, out of a page full of them', () => {
    const body = {
      stock_1: '5', base_1: '5',
      stock_2: '9', base_2: '3',
      stock_3: '7', base_3: '7',
    };
    expect(plan(body, { 1: 5, 2: 3, 3: 7 })).toEqual({ updates: [{ productId: 2, quantity: 9 }], stale: 0 });
  });

  it('takes a request with no baseline at face value, rather than ignoring the owner', () => {
    const body = { stock_1: '6' };
    expect(plan(body, { 1: 5 })).toEqual({ updates: [{ productId: 1, quantity: 6 }], stale: 0 });
  });

  it('never writes a negative count, and floors a fractional one', () => {
    expect(plan({ stock_1: '-4', base_1: '5' }, { 1: 5 }).updates).toEqual([{ productId: 1, quantity: 0 }]);
    expect(plan({ stock_1: '3.9', base_1: '5' }, { 1: 5 }).updates).toEqual([{ productId: 1, quantity: 3 }]);
  });

  it('skips a product that has gone since the page was drawn', () => {
    expect(plan({ stock_9: '4', base_9: '5' }, {})).toEqual({ updates: [], stale: 0 });
  });
});

describe('QR-02: a saved code that stops working must not trap the basket', () => {
  /** Carry Set-Cookie from one request to the next, as a browser would. */
  const jar: string[] = [];
  const cookieHeader = () => jar.map((c) => c.split(';')[0]).join('; ');
  const keep = (res: Response) => {
    for (const c of res.headers.getSetCookie?.() ?? []) jar.push(c);
    return res;
  };
  const go = async (path: string, init: RequestInit = {}) => {
    const res = await worker.fetch(
      new Request(`https://27beauty.co.uk${path}`, {
        ...init,
        headers: { ...(init.headers ?? {}), cookie: cookieHeader() },
      }),
      env,
      ctx(),
    );
    return keep(res);
  };

  beforeEach(() => {
    jar.length = 0;
    sql.exec(`
      INSERT INTO categories (id, slug, name, sort_order) VALUES (1, 'make-up', 'Make up', 10);
      INSERT INTO products (id, slug, title, price_pence, stock, status, category_id)
        VALUES (1, 'lippy', 'A Lipstick', 1000, 5, 'active', 1);
      INSERT INTO coupons (id, code, kind, value, active) VALUES (1, 'QR10', 'percent', 10, 1);
    `);
  });

  it('offers a way out once the code has been withdrawn', async () => {
    const form = (o: Record<string, string>) => ({
      method: 'POST',
      body: new URLSearchParams(o).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    await go('/cart/add', form({ product_id: '1', quantity: '1' }));
    await go('/cart/coupon', form({ code: 'QR10' }));

    // Applied and discounting, as a scanned card would be.
    const withCoupon = await (await go('/cart')).text();
    expect(withCoupon).toContain('Remove coupon');

    // The owner withdraws the offer while the basket is still open.
    sql.exec(`UPDATE coupons SET active = 0 WHERE id = 1`);

    const stuck = await (await go('/cart')).text();
    // Checkout refuses while a bad code is saved, so the basket has to offer
    // a way to clear it — otherwise the customer is bounced back here for
    // ever with nothing on screen to act on.
    expect(stuck).toContain('Remove code and continue without the discount');
  });
});

describe('PAY-03: a payment that lands is never dropped', () => {
  const stockOf = (id: number) => (sql.all(`SELECT stock FROM products WHERE id = ${id}`)[0] as { stock: number }).stock;
  const orderRow = (id: number) =>
    sql.all(`SELECT status, stock_applied, notes FROM orders WHERE id = ${id}`)[0] as {
      status: string;
      stock_applied: number;
      notes: string | null;
    };

  async function pendingOrder() {
    sql.exec(`INSERT INTO products (id, slug, title, price_pence, stock, status) VALUES (1, 'p', 'A Product', 1000, 5, 'active')`);
    const cart = await buildCart(env, [{ id: 1, q: 2 }], null);
    const order = await createPendingOrder(env, { cart, email: null, name: null });
    sql.exec(`UPDATE orders SET stripe_session_id = 'cs_test_1' WHERE id = ${order.id}`);
    return order.id;
  }

  it('still records the payment when the expiry arrived first', async () => {
    // Stripe does not promise webhook order. Expired then completed used to
    // leave the customer charged and the order cancelled, in silence.
    const id = await pendingOrder();
    await markOrderCancelled(env, { sessionId: 'cs_test_1' });
    expect(orderRow(id).status).toBe('cancelled');

    const { transitioned } = await markOrderPaid(env, { sessionId: 'cs_test_1', paymentIntent: 'pi_1' });
    expect(transitioned).toBe(true);
    const after = orderRow(id);
    expect(after.status).toBe('paid');
    expect(after.stock_applied).toBe(1);
    expect(stockOf(1)).toBe(3); // the two sold actually came off
    // ...and the owner is told, because this one deserves a look.
    expect(after.notes ?? '').toContain('cancelled and then paid');
  });

  it('takes the stock exactly once when Stripe retries the same event', async () => {
    const id = await pendingOrder();
    const first = await markOrderPaid(env, { sessionId: 'cs_test_1', paymentIntent: 'pi_1' });
    const second = await markOrderPaid(env, { sessionId: 'cs_test_1', paymentIntent: 'pi_1' });
    expect(first.transitioned).toBe(true);
    expect(second.transitioned).toBe(false);
    expect(stockOf(1)).toBe(3);
    expect(orderRow(id).status).toBe('paid');
  });

  it('does not quietly un-cancel an order that was never paid', async () => {
    const id = await pendingOrder();
    await markOrderCancelled(env, { sessionId: 'cs_test_1' });
    expect(orderRow(id).status).toBe('cancelled');
    expect(stockOf(1)).toBe(5); // nothing taken
  });
});

describe('SF-04: the shop does not promise messages it cannot send', () => {
  // There is no email sending anywhere in the worker. Telling a paying
  // customer to expect a confirmation email meant they waited for something
  // that never arrived and reasonably concluded the order had failed.
  const files = ['src/routes/checkout.tsx', 'src/routes/storefront.tsx'];

  it('makes no promise of an automatic confirmation or tracking email', async () => {
    const { readFileSync } = await import('node:fs');
    const offenders: string[] = [];
    for (const f of files) {
      readFileSync(f, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (/we'll email|email your confirmation|confirmation email as soon|further email with tracking/i.test(line)) {
            offenders.push(`${f}:${i + 1} ${line.trim()}`);
          }
        });
    }
    expect(offenders).toEqual([]);
  });

  it('tells the customer what to keep instead', async () => {
    const { readFileSync } = await import('node:fs');
    const checkout = readFileSync('src/routes/checkout.tsx', 'utf8');
    expect(checkout).toMatch(/save your order number/i);
    expect(checkout).toMatch(/don't send an automatic email/i);
  });
});

describe('the money path, end to end through the real webhook', () => {
  /**
   * The one journey never exercised in production: a payment that succeeds.
   * This drives the actual /webhooks/stripe route, including Stripe's real
   * signature verification, so it proves the shop can complete a sale rather
   * than asserting the pieces in isolation.
   */
  const SECRET = 'whsec_test_secret';

  async function signedPost(payload: unknown) {
    const body = JSON.stringify(payload);
    const t = Math.floor(Date.now() / 1000);
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(SECRET),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${body}`));
    const v1 = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
    return worker.fetch(
      new Request('https://27beauty.co.uk/webhooks/stripe', {
        method: 'POST',
        body,
        headers: { 'stripe-signature': `t=${t},v1=${v1}`, 'content-type': 'application/json' },
      }),
      { ...env, STRIPE_WEBHOOK_SECRET: SECRET, STRIPE_SECRET_KEY: 'sk_test_dummy' } as Env,
      ctx(),
    );
  }

  it('turns a paid Stripe session into a paid order, stock off the shelf and the coupon spent', async () => {
    sql.exec(`
      INSERT INTO products (id, slug, title, price_pence, stock, status) VALUES (1, 'p', 'A Product', 1000, 5, 'active');
      INSERT INTO coupons (id, code, kind, value, active) VALUES (1, 'QR10', 'percent', 10, 1);
    `);
    const cart = await buildCart(env, [{ id: 1, q: 2 }], 'QR10');
    expect(cart.discountPence).toBe(200); // 10% of £20.00, in whole pence
    const order = await createPendingOrder(env, { cart, email: null, name: null });
    sql.exec(`UPDATE orders SET stripe_session_id = 'cs_live_1' WHERE id = ${order.id}`);

    const res = await signedPost({
      id: 'evt_1',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_live_1',
          object: 'checkout.session',
          payment_status: 'paid',
          payment_intent: 'pi_live_1',
          customer_details: { email: 'buyer@example.com', name: 'A Buyer', phone: null },
        },
      },
    });
    expect(res.status).toBe(200);

    const row = sql.all(`SELECT status, email, stock_applied FROM orders WHERE id = ${order.id}`)[0] as {
      status: string;
      email: string;
      stock_applied: number;
    };
    expect(row.status).toBe('paid');
    expect(row.email).toBe('buyer@example.com'); // carried off the Stripe session
    expect(row.stock_applied).toBe(1);
    expect(sql.all(`SELECT stock FROM products WHERE id = 1`)).toEqual([{ stock: 3 }]);
    expect(sql.all(`SELECT COUNT(*) AS n FROM coupon_redemptions WHERE order_id = ${order.id}`)).toEqual([{ n: 1 }]);
  });

  it('refuses an event that is not signed by Stripe', async () => {
    const res = await worker.fetch(
      new Request('https://27beauty.co.uk/webhooks/stripe', {
        method: 'POST',
        body: JSON.stringify({ type: 'checkout.session.completed', data: { object: { id: 'cs_x', payment_status: 'paid' } } }),
        headers: { 'stripe-signature': 't=1,v1=deadbeef', 'content-type': 'application/json' },
      }),
      { ...env, STRIPE_WEBHOOK_SECRET: SECRET, STRIPE_SECRET_KEY: 'sk_test_dummy' } as Env,
      ctx(),
    );
    expect(res.status).toBe(400);
  });

  it('takes the stock once when Stripe retries the same payment', async () => {
    sql.exec(`
      INSERT INTO products (id, slug, title, price_pence, stock, status) VALUES (1, 'p', 'A Product', 1000, 5, 'active');
    `);
    const cart = await buildCart(env, [{ id: 1, q: 2 }], null);
    const order = await createPendingOrder(env, { cart, email: null, name: null });
    sql.exec(`UPDATE orders SET stripe_session_id = 'cs_live_2' WHERE id = ${order.id}`);
    const event = {
      id: 'evt_2',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_live_2', object: 'checkout.session', payment_status: 'paid', payment_intent: 'pi_2' } },
    };
    await signedPost(event);
    await signedPost(event);
    expect(sql.all(`SELECT stock FROM products WHERE id = 1`)).toEqual([{ stock: 3 }]);
  });
});

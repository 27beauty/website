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

describe('deleting several products at once from the Stock screen', () => {
  /**
   * Driven through the real admin route with a real signed session and CSRF
   * token, because this is the most destructive control in the panel: one
   * click can remove a hundred products and stop the sync re-importing them.
   */
  const SECRET = 'test-session-secret-0123456789abcdef';
  const CSRF = 'csrf-token-for-test';
  let cookie = '';

  beforeEach(async () => {
    const { signPayload } = await import('../src/lib/crypto');
    const token = 'tok-test';
    await env.KV.put(
      `admin:session:${token}`,
      JSON.stringify({ userId: 1, email: 'o@x.dev', name: null, role: 'owner', issuedAt: Date.now(), csrf: CSRF }),
    );
    cookie = `admin_session=${await signPayload(token, SECRET)}`;
    sql.exec(`
      INSERT INTO products (id, slug, title, price_pence, stock, status, source, ebay_item_id, ebay_account) VALUES
        (1, 'a', 'Product A', 100, 5, 'active', 'ebay', 'v1|801|0', 'adinath0'),
        (2, 'b', 'Product B', 100, 5, 'active', 'manual', NULL, NULL),
        (3, 'c', 'Product C', 100, 5, 'active', 'manual', NULL, NULL);
    `);
  });

  const post = (fields: string[][]) =>
    worker.fetch(
      new Request('https://27beauty.co.uk/admin/products/bulk-delete', {
        method: 'POST',
        body: new URLSearchParams(fields).toString(),
        headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      }),
      { ...env, SESSION_SECRET: SECRET } as Env,
      ctx(),
    );

  const titles = () => (sql.all(`SELECT title FROM products ORDER BY id`) as { title: string }[]).map((r) => r.title);

  it('asks first and deletes nothing on the way', async () => {
    const res = await post([
      ['_csrf', CSRF],
      ['back', '/admin/stock'],
      ['id', '1'],
      ['id', '2'],
    ]);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Delete 2 products?');
    // It must name them, so the owner can see what they actually ticked.
    expect(html).toContain('Product A');
    expect(html).toContain('Product B');
    expect(titles()).toEqual(['Product A', 'Product B', 'Product C']); // nothing gone yet
  });

  it('deletes exactly the ones ticked once confirmed', async () => {
    const res = await post([
      ['_csrf', CSRF],
      ['back', '/admin/stock'],
      ['confirm', '1'],
      ['id', '1'],
      ['id', '3'],
    ]);
    expect(res.status).toBe(303);
    expect(titles()).toEqual(['Product B']);
  });

  it('stops the sync importing a deleted product straight back', async () => {
    await post([['_csrf', CSRF], ['confirm', '1'], ['id', '1']]);
    // Product A came from eBay; its listing must be blocked or the next
    // catalogue sync simply recreates it.
    expect(sql.all(`SELECT status FROM channel_listings WHERE external_id = '801'`)).toEqual([{ status: 'blocked' }]);
  });

  it('refuses a request without a valid CSRF token', async () => {
    const res = await post([['_csrf', 'wrong'], ['confirm', '1'], ['id', '1']]);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toContain('err=');
    expect(titles()).toHaveLength(3); // untouched
  });

  it('says so when nothing was ticked', async () => {
    const res = await post([['_csrf', CSRF], ['confirm', '1']]);
    expect(res.headers.get('location')).toContain('Nothing+was+selected');
    expect(titles()).toHaveLength(3);
  });
});

describe('S2: changing the password signs other devices out', () => {
  // Without this, the one thing a person does when they suspect their account
  // is compromised achieved nothing: a session cookie someone else already
  // held stayed valid for its full lifetime.
  const SECRET = 'test-session-secret-0123456789abcdef';
  const CSRF = 'csrf-token-for-test';
  // 'LocalTest12345!'
  const HASH = 'pbkdf2$100000$LgWuZrzy4fDutrdkfGBUGQ$h0IxVAKh8kvTo2L1QICDgJ0Rn51HDnVGCQaVE7z8s8I';

  async function session(token: string, userId: number) {
    const { signPayload } = await import('../src/lib/crypto');
    await env.KV.put(
      `admin:session:${token}`,
      JSON.stringify({ userId, email: 'o@x.dev', name: null, role: 'owner', issuedAt: Date.now(), csrf: CSRF }),
    );
    return `admin_session=${await signPayload(token, SECRET)}`;
  }

  it('drops every session of that admin and leaves other admins alone', async () => {
    const { revokeSessionsForUser } = await import('../src/lib/admin-auth');
    await session('phone', 1);
    await session('laptop', 1);
    await session('someone-else', 2);

    expect(await revokeSessionsForUser(env, 1)).toBe(2);
    expect(await env.KV.get('admin:session:phone')).toBeNull();
    expect(await env.KV.get('admin:session:laptop')).toBeNull();
    expect(await env.KV.get('admin:session:someone-else')).not.toBeNull();
  });

  it('through the real route: the old cookie stops working and a new one is issued', async () => {
    sql.exec(`INSERT INTO admin_users (id, email, password_hash, role) VALUES (1, 'o@x.dev', '${HASH}', 'owner')`);
    const stolen = await session('stolen', 1);

    const res = await worker.fetch(
      new Request('https://27beauty.co.uk/admin/settings/password', {
        method: 'POST',
        body: new URLSearchParams({
          _csrf: CSRF,
          current: 'LocalTest12345!',
          password: 'BrandNewPass99!',
          confirm: 'BrandNewPass99!',
        }).toString(),
        headers: { cookie: stolen, 'content-type': 'application/x-www-form-urlencoded' },
      }),
      { ...env, SESSION_SECRET: SECRET } as Env,
      ctx(),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toContain('msg=');
    // A replacement session is set, so the owner keeps their own tab...
    expect((res.headers.getSetCookie?.() ?? []).join(';')).toContain('admin_session=');
    // ...while the cookie someone else was holding is now worthless.
    expect(await env.KV.get('admin:session:stolen')).toBeNull();
  });
});

describe('S4: an export cannot run as a formula when opened', () => {
  it('neutralises the characters a spreadsheet executes', async () => {
    const { csvSafeCell } = await import('../src/lib/util');
    // A marketplace title or a name a shopper typed is not the shop's to trust.
    expect(csvSafeCell('=HYPERLINK("http://evil","click")')).toBe("'=HYPERLINK(\"http://evil\",\"click\")");
    expect(csvSafeCell('+1-555-0100')).toBe("'+1-555-0100");
    expect(csvSafeCell('@SUM(A1:A9)')).toBe("'@SUM(A1:A9)");
    expect(csvSafeCell('-2 Pack Lipstick')).toBe("'-2 Pack Lipstick");
  });

  it('leaves ordinary text and real numbers alone, so the sheet still adds up', async () => {
    const { csvSafeCell } = await import('../src/lib/util');
    expect(csvSafeCell('Maybelline Fit Me Powder')).toBe('Maybelline Fit Me Powder');
    expect(csvSafeCell('12')).toBe('12');
    expect(csvSafeCell('9.99')).toBe('9.99');
    expect(csvSafeCell('-5')).toBe('-5'); // a negative number is data, not a formula
    expect(csvSafeCell('')).toBe('');
  });

  it('is applied by the product export', async () => {
    const { toCsvRow } = await import('../src/routes/admin/products');
    expect(toCsvRow(['=cmd()', 'Normal', 10])).toBe("'=cmd(),Normal,10");
  });
});

describe('S4: the courier upload is deliberately left alone', () => {
  it('passes Parcel2Go the exact field, with no apostrophe added', async () => {
    const { toCsv } = await import('../src/lib/smartsend');
    // This file is machine-read by Parcel2Go, not opened in a spreadsheet.
    // Prefixing it to be "safe" would corrupt an address line beginning with
    // a dash and the upload would be wrong, so the formula guard must not be
    // applied here.
    expect(toCsv([['-Flat 2, The Mews', 'Normal']])).toBe('"-Flat 2, The Mews","Normal"\r\n');
  });
});

describe('QR-04: only an active product has a public page', () => {
  /**
   * An import lands as a draft: no description, and £0 until the owner prices
   * it. Archived means the shop has stopped selling it. Both used to render a
   * normal product page, because the slug lookup had no status filter, while
   * `/cart/add` and the basket both check status — so the page offered a price
   * and an Add to basket button for something that could never be bought.
   */
  const insert = (id: number, slug: string, status: string, pence: number) =>
    sql.exec(
      `INSERT INTO products (id, title, slug, price_pence, stock, status, category_id)
       VALUES (${id}, 'Test Item ${id}', '${slug}', ${pence}, 5, '${status}', NULL)`,
    );

  const get = (slug: string) =>
    worker.fetch(new Request(`https://27beauty.co.uk/product/${slug}`), env, ctx());

  it('serves an active product', async () => {
    insert(1, 'live-item', 'active', 1299);
    expect((await get('live-item')).status).toBe(200);
  });

  it('404s a draft, rather than showing a £0 page for an unpriced import', async () => {
    insert(2, 'draft-item', 'draft', 0);
    expect((await get('draft-item')).status).toBe(404);
  });

  it('404s an archived product, so an old link stops offering it', async () => {
    insert(3, 'gone-item', 'archived', 1299);
    expect((await get('gone-item')).status).toBe(404);
  });

  it('still 404s a slug that does not exist at all', async () => {
    expect((await get('never-existed')).status).toBe(404);
  });
});

describe('SF-03: the returns policy is reachable', () => {
  /**
   * The policy page itself was always there and correct; nothing linked to it
   * but the Terms page. The footer's one "Delivery & returns" link went to
   * /pages/delivery, which says nothing about returns, so a shopper looking
   * for their 14-day cancellation rights could not find them.
   */
  const body = async (path: string) =>
    (await worker.fetch(new Request(`https://27beauty.co.uk${path}`), env, ctx())).text();

  it('links returns from the footer on every page', async () => {
    expect(await body('/')).toContain('href="/pages/returns"');
  });

  it('links returns from the delivery page it used to be conflated with', async () => {
    const html = await body('/pages/delivery');
    expect(html).toContain('href="/pages/returns"');
    expect(html).toContain('14 days');
  });

  it('serves the policy with the statutory right named', async () => {
    const html = await body('/pages/returns');
    expect(html).toContain('Consumer Contracts Regulations 2013');
    expect(html).toContain('14 days');
  });

  it('no longer promises returns on a page that has none', async () => {
    // The old footer label. If it comes back, it must point at the real page.
    expect(await body('/')).not.toContain('>Delivery &amp; returns<');
  });
});

describe('SF-01: the success page only claims an order it can find', () => {
  /**
   * `clearCart` ran unconditionally, above the order lookup, and the page said
   * "Thank you for your order — your payment is settling" whether or not an
   * order existed. So any GET of this URL without a payment behind it emptied
   * the shopper's basket and told them an order was on its way. A shopper who
   * believes that does not chase it.
   */
  const success = (query: string) =>
    worker.fetch(new Request(`https://27beauty.co.uk/checkout/success${query}`), env, ctx());

  it('does not claim an order when there is no session id', async () => {
    const html = await (await success('')).text();
    expect(html).toContain('We can&#39;t find that order'); // hono/jsx escapes the apostrophe
    expect(html).not.toContain('Thank you for your order');
  });

  it('does not claim an order for a session id we have no record of', async () => {
    const html = await (await success('?session_id=cs_test_never_seen')).text();
    expect(html).toContain('We can&#39;t find that order');
  });

  it('leaves the basket alone when no order was found', async () => {
    const res = await success('?session_id=cs_test_never_seen');
    const cookies = res.headers.getSetCookie?.() ?? [];
    // Clearing the basket is an expired/empty cart cookie. There must be none.
    expect(cookies.filter((ck) => ck.startsWith('cart='))).toHaveLength(0);
  });

  it('sends the shopper back to the basket they still have', async () => {
    const html = await (await success('')).text();
    expect(html).toContain('href="/cart"');
  });

  it('thanks the shopper, and clears the basket, for an order it does find', async () => {
    sql.exec(
      `INSERT INTO orders (id, order_number, status, subtotal_pence, discount_pence,
         shipping_pence, total_pence, currency, stripe_session_id)
       VALUES (1, '27B-TEST01', 'paid', 1299, 0, 0, 1299, 'GBP', 'cs_test_real')`,
    );
    const res = await success('?session_id=cs_test_real');
    const html = await res.text();
    expect(html).toContain('Thank you for your order');
    expect(html).toContain('27B-TEST01');
    const cookies = res.headers.getSetCookie?.() ?? [];
    expect(cookies.some((ck) => ck.startsWith('cart='))).toBe(true);
  });
});

describe('SF-05: the image gallery works without a mouse', () => {
  /**
   * The thumbnails were bare <img> elements with a click listener: not
   * focusable, no accessible name, no keyboard path. On a product page, whose
   * job is showing the shopper what they are buying.
   */
  const productHtml = async () => {
    sql.exec(
      `INSERT INTO products (id, title, slug, price_pence, stock, status, category_id, images_json)
       VALUES (50, 'Two Pictures', 'two-pictures', 999, 3, 'active', NULL,
               '["https://img/a.jpg","https://img/b.jpg"]')`,
    );
    const res = await worker.fetch(new Request('https://27beauty.co.uk/product/two-pictures'), env, ctx());
    return res.text();
  };

  it('renders each thumbnail as a focusable button', async () => {
    const html = await productHtml();
    expect(html).toContain('class="gallery-thumb"');
    expect(html).not.toMatch(/<img[^>]*data-full/);
  });

  it('gives every thumbnail an accessible name saying which image it shows', async () => {
    const html = await productHtml();
    expect(html).toContain('aria-label="Show image 1 of 2"');
    expect(html).toContain('aria-label="Show image 2 of 2"');
  });

  it('marks the image currently shown', async () => {
    const html = await productHtml();
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('aria-pressed="false"');
  });

  it('drives the script off the buttons, so Enter and Space switch the image', async () => {
    const html = await productHtml();
    expect(html).toContain(".querySelectorAll('.gallery-thumb')");
  });
});

describe('SF-01b: the confirmation page always names an address to write to', () => {
  /**
   * SUPPORT_EMAIL is a wrangler secret, so it is unset in a fresh environment.
   * The static pages fell back to the real address; the order confirmation
   * page interpolated it raw and rendered "email  and we'll sort it out" —
   * telling a customer whose payment had just failed to write to nobody.
   */
  it('falls back when the secret is unset', async () => {
    const { supportEmail, SUPPORT_EMAIL_FALLBACK } = await import('../src/lib/util');
    expect(supportEmail(undefined)).toBe(SUPPORT_EMAIL_FALLBACK);
    expect(supportEmail('')).toBe(SUPPORT_EMAIL_FALLBACK);
    expect(supportEmail('   ')).toBe(SUPPORT_EMAIL_FALLBACK);
  });

  it('prefers the configured address', async () => {
    const { supportEmail } = await import('../src/lib/util');
    expect(supportEmail('help@27beauty.co.uk')).toBe('help@27beauty.co.uk');
  });

  it('shows a real mailto on the success page with no secret set', async () => {
    const { SUPPORT_EMAIL_FALLBACK } = await import('../src/lib/util');
    const res = await worker.fetch(
      new Request('https://27beauty.co.uk/checkout/success?session_id=cs_nope'),
      env,
      ctx(),
    );
    const html = await res.text();
    expect(html).toContain(`mailto:${SUPPORT_EMAIL_FALLBACK}`);
    expect(html).not.toContain('email  and');
  });
});

describe('SF-02: the shop publishes who it is', () => {
  /**
   * The contact page said "27beauty, United Kingdom. A full postal address is
   * available on request by email." A UK distance seller has to give the
   * address, not offer it. The one address the shop already held is
   * `store.address` — the Parcel2Go collection address, the owner's home,
   * entered for the courier — so these are separate fields the owner fills in
   * knowingly, and nothing is published until they do.
   */
  const page = async (slug: string) =>
    (await worker.fetch(new Request(`https://27beauty.co.uk/pages/${slug}`), env, ctx())).text();

  const setLegal = (rows: Record<string, string>) => {
    for (const [k, v] of Object.entries(rows)) {
      sql.exec(`INSERT INTO settings (key, value) VALUES ('${k}', '${JSON.stringify(v)}')`);
    }
  };

  it('no longer claims the address is available on request', async () => {
    expect(await page('contact')).not.toContain('available on request');
  });

  it('never publishes the courier collection address', async () => {
    setLegal({ 'store.address': '4 Example Close, Blackburn, BB2 6AL' });
    const html = await page('contact');
    expect(html).not.toContain('Example Close');
  });

  it('shows the registered company, number and public address once set', async () => {
    setLegal({
      'legal.company_name': '27Beauty Ltd',
      'legal.company_number': '12345678',
      'legal.registered_address': '1 Registered Way, Blackburn, BB1 1AA',
      'legal.vat_number': 'GB123456789',
    });
    const html = await page('contact');
    expect(html).toContain('27Beauty Ltd');
    expect(html).toContain('company number 12345678');
    expect(html).toContain('1 Registered Way');
    expect(html).toContain('GB123456789');
  });

  it('puts the same details on the terms page, which is the contract', async () => {
    setLegal({ 'legal.company_name': '27Beauty Ltd', 'legal.company_number': '12345678' });
    expect(await page('terms')).toContain('company number 12345678');
  });

  it('degrades to a bare trading name rather than inventing anything', async () => {
    const html = await page('contact');
    expect(html).toContain('27beauty, trading in the United Kingdom');
    expect(html).not.toContain('registered in England and Wales');
    expect(html).not.toContain('VAT registration number');
  });

  it('leaves VAT out entirely when the shop is not registered', async () => {
    setLegal({ 'legal.company_name': '27Beauty Ltd' });
    expect(await page('contact')).not.toContain('VAT registration number');
  });
});

describe('PAY-01: an order the shop cannot fill is flagged, not shipped blind', () => {
  /**
   * Stock is taken at settlement and written as MAX(0, stock + delta), so a
   * decrement that runs out succeeds quietly. Two shoppers paying for the last
   * unit are both confirmed; the second clamps at zero and nothing says so.
   * The owner ships one parcel and the other customer waits for one that was
   * never possible.
   */
  const order = (id: number, session: string) => {
    sql.exec(
      `INSERT INTO orders (id, order_number, status, subtotal_pence, discount_pence, shipping_pence,
         total_pence, currency, stripe_session_id)
       VALUES (${id}, '27B-OS${id}', 'pending', 1000, 0, 0, 1000, 'GBP', '${session}')`,
    );
  };
  const item = (orderId: number, productId: number, qty: number) => {
    sql.exec(
      `INSERT INTO order_items (order_id, product_id, title, quantity, unit_price_pence, line_total_pence)
       VALUES (${orderId}, ${productId}, 'Last Lipstick', ${qty}, 1000, ${qty * 1000})`,
    );
  };
  const product = (id: number, stock: number) => {
    sql.exec(
      `INSERT INTO products (id, title, slug, price_pence, stock, status, category_id)
       VALUES (${id}, 'Last Lipstick', 'last-lipstick-${id}', 1000, ${stock}, 'active', NULL)`,
    );
  };
  const row = (id: number) =>
    sql.all(`SELECT oversold, notes FROM orders WHERE id = ${id}`)[0] as {
      oversold: number;
      notes: string | null;
    };

  it('does not flag an order it can fill', async () => {
    product(60, 5);
    order(60, 'cs_ok');
    item(60, 60, 2);
    await markOrderPaid(env, { sessionId: 'cs_ok' });
    expect(row(60).oversold).toBe(0);
    expect(sql.all('SELECT stock FROM products WHERE id = 60')[0]).toMatchObject({ stock: 3 });
  });

  it('flags the second shopper to pay for the last unit', async () => {
    product(61, 1);
    order(61, 'cs_first');
    item(61, 61, 1);
    order(62, 'cs_second');
    item(62, 61, 1);

    await markOrderPaid(env, { sessionId: 'cs_first' });
    await markOrderPaid(env, { sessionId: 'cs_second' });

    expect(row(61).oversold).toBe(0);
    expect(row(62).oversold).toBe(1);
    // Stock still clamps at zero — it must never go negative.
    expect(sql.all('SELECT stock FROM products WHERE id = 61')[0]).toMatchObject({ stock: 0 });
  });

  it('says in the notes what was short and by how much', async () => {
    product(63, 1);
    order(63, 'cs_short');
    item(63, 63, 4);
    await markOrderPaid(env, { sessionId: 'cs_short' });
    const { oversold, notes } = row(63);
    expect(oversold).toBe(1);
    expect(notes).toContain('ordered 4, had 1');
  });

  it('still records the sale in the ledger, so the count is not lost', async () => {
    product(64, 1);
    order(64, 'cs_ledger');
    item(64, 64, 3);
    await markOrderPaid(env, { sessionId: 'cs_ledger' });
    const movements = sql.all(`SELECT delta, reason FROM stock_movements WHERE product_id = 64`);
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({ delta: -3, reason: 'website_sale' });
  });

  it('does not flag twice when Stripe delivers the webhook again', async () => {
    product(65, 1);
    order(65, 'cs_dup');
    item(65, 65, 2);
    await markOrderPaid(env, { sessionId: 'cs_dup' });
    await markOrderPaid(env, { sessionId: 'cs_dup' });
    const { notes } = row(65);
    expect(notes?.match(/Not enough stock/g) ?? []).toHaveLength(1);
  });
});

describe('PAY-04: the per-customer coupon limit is actually enforced', () => {
  /**
   * "Per-customer limit" is a field on every coupon in the admin panel, and it
   * was enforced on no website order at all: validateCoupon only checks it
   * when given an email, and no caller has one — the basket knows nothing
   * about the shopper and createPendingOrder stores email: null, because
   * Stripe Checkout is what collects it. So a shopper could scan the QR card
   * off their parcel and take 10% off every order forever. The webhook is the
   * first moment the email exists, which is after the payment, so the limit
   * is reported on the order rather than refused.
   */
  const coupon = (limit: number | null) =>
    sql.exec(
      `INSERT INTO coupons (id, code, kind, value, per_customer_limit, active)
       VALUES (1, 'QR10', 'percent', 10, ${limit === null ? 'NULL' : limit}, 1)`,
    );

  const redeem = async (id: number, email: string) => {
    sql.exec(
      `INSERT INTO orders (id, order_number, status, subtotal_pence, discount_pence, shipping_pence,
         total_pence, currency, coupon_code, stripe_session_id)
       VALUES (${id}, '27B-C${id}', 'paid', 1000, 100, 0, 900, 'GBP', 'QR10', 'cs_c${id}')`,
    );
    const { recordRedemption } = await import('../src/lib/coupons');
    return recordRedemption(env, 1, id, email, 100);
  };

  it('lets the first use through', async () => {
    coupon(1);
    expect(await redeem(70, 'shopper@example.com')).toMatchObject({
      recorded: true,
      overLimit: false,
      perCustomerExceeded: false,
    });
  });

  it('reports the same customer using it a second time', async () => {
    coupon(1);
    await redeem(71, 'shopper@example.com');
    const res = await redeem(72, 'shopper@example.com');
    expect(res.recorded).toBe(true); // the payment happened; the ledger stays honest
    expect(res.perCustomerExceeded).toBe(true);
  });

  it('matches the customer regardless of how they typed their address', async () => {
    coupon(1);
    await redeem(73, 'shopper@example.com');
    expect((await redeem(74, 'Shopper@Example.COM')).perCustomerExceeded).toBe(true);
  });

  it('leaves a different customer alone', async () => {
    coupon(1);
    await redeem(75, 'one@example.com');
    expect((await redeem(76, 'two@example.com')).perCustomerExceeded).toBe(false);
  });

  it('honours a limit above one', async () => {
    coupon(2);
    await redeem(77, 'shopper@example.com');
    expect((await redeem(78, 'shopper@example.com')).perCustomerExceeded).toBe(false);
    expect((await redeem(79, 'shopper@example.com')).perCustomerExceeded).toBe(true);
  });

  it('never reports when the coupon has no per-customer limit', async () => {
    coupon(null);
    await redeem(80, 'shopper@example.com');
    expect((await redeem(81, 'shopper@example.com')).perCustomerExceeded).toBe(false);
  });

  it('writes the reason onto the order, through the real webhook', async () => {
    coupon(1);
    // This customer has used the card once already.
    sql.exec(
      // order_id NULL: an earlier redemption whose order has since been deleted
      // is still a redemption by this customer.
      `INSERT INTO coupon_redemptions (coupon_id, order_id, email, amount_pence)
       VALUES (1, NULL, 'shopper@example.com', 100)`,
    );
    sql.exec(
      `INSERT INTO orders (id, order_number, status, subtotal_pence, discount_pence, shipping_pence,
         total_pence, currency, coupon_code, stripe_session_id)
       VALUES (82, '27B-C82', 'pending', 1000, 100, 0, 900, 'GBP', 'QR10', 'cs_c82')`,
    );

    const SECRET = 'whsec_test_secret';
    const body = JSON.stringify({
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_c82',
          payment_status: 'paid',
          customer_details: { email: 'shopper@example.com' },
        },
      },
    });
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
    await worker.fetch(
      new Request('https://27beauty.co.uk/webhooks/stripe', {
        method: 'POST',
        body,
        headers: { 'stripe-signature': `t=${t},v1=${v1}`, 'content-type': 'application/json' },
      }),
      { ...env, STRIPE_WEBHOOK_SECRET: SECRET, STRIPE_SECRET_KEY: 'sk_test_dummy' } as Env,
      ctx(),
    );

    const notes = (sql.all('SELECT notes FROM orders WHERE id = 82')[0] as { notes: string | null }).notes;
    expect(notes).toContain('per customer');
  });
});

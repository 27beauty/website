import { Hono } from 'hono';
import type { AppBindings, Order, OrderStatus, ShippingAddress } from '../../types';
import { getAdmin, verifyCsrf } from '../../lib/admin-auth';
import { AdminLayout, AdminPrintPage, CsrfField } from '../../ui/admin-layout';
import { formatPence } from '../../lib/money';
import { clampInt } from '../../lib/util';
import { getOrderWithItems, type OrderWithItems } from '../../lib/orders';

/**
 * Order management. Listing needs a status + free-text (order number/email)
 * search that src/lib/orders.ts's listOrders() doesn't offer, so the list
 * query lives here; order detail reuses getOrderWithItems() from there.
 */
export const orders = new Hono<AppBindings>();

const PER_PAGE = 30;

function flashOf(c: { req: { query: (k: string) => string | undefined } }) {
  return { msg: c.req.query('msg') ?? null, err: c.req.query('err') ?? null };
}

function statusPill(status: OrderStatus) {
  const cls =
    status === 'fulfilled'
      ? 'pill-ok'
      : status === 'paid'
        ? 'pill-warn'
        : status === 'cancelled' || status === 'refunded'
          ? 'pill-bad'
          : 'pill';
  return <span class={`pill ${cls}`}>{status}</span>;
}

function parseShipping(json: string | null): ShippingAddress | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as ShippingAddress;
  } catch {
    return null;
  }
}

orders.get('/', async (c) => {
  const admin = getAdmin(c);
  const query = c.req.query();
  const page = clampInt(query.page, 1, 100000, 1);
  const status = query.status;
  const search = query.q?.trim();

  const where: string[] = [];
  const params: unknown[] = [];
  if (status) {
    where.push('status = ?');
    params.push(status);
  }
  if (search) {
    where.push('(order_number LIKE ? OR lower(email) LIKE ?)');
    params.push(`%${search}%`, `%${search.toLowerCase()}%`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const offset = (page - 1) * PER_PAGE;

  const [countRow, listRes] = await Promise.all([
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM orders ${whereSql}`).bind(...params).first<{ n: number }>(),
    c.env.DB.prepare(`SELECT * FROM orders ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .bind(...params, PER_PAGE, offset)
      .all<Order>(),
  ]);
  const total = countRow?.n ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));
  const flash = flashOf(c);

  const qs = (overrides: Record<string, string | number | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...query, ...overrides })) {
      if (v !== undefined && v !== '' && k !== 'page') p.set(k, String(v));
    }
    return p.toString();
  };

  return c.html(
    <AdminLayout title="Orders" active="orders" admin={admin} msg={flash.msg} err={flash.err}>
      <div class="admin-head">
        <h1>Orders</h1>
        <p class="muted">{total} order{total === 1 ? '' : 's'}.</p>
      </div>

      <form method="get" action="/admin/orders" class="filter-bar">
        <div class="field field-wide">
          <label for="q">Search</label>
          <input id="q" type="search" name="q" value={query.q ?? ''} placeholder="Order number or email…" />
        </div>
        <div class="field">
          <label for="status">Status</label>
          <select id="status" name="status">
            <option value="">All</option>
            {(['pending', 'paid', 'fulfilled', 'cancelled', 'refunded'] as const).map((s) => (
              <option value={s} selected={status === s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <button class="btn btn-secondary" type="submit">
          Filter
        </button>
      </form>

      <div class="admin-table-wrap">
        <table class="admin-table">
          <thead>
            <tr>
              <th>Order</th>
              <th>Date</th>
              <th>Customer</th>
              <th>Status</th>
              <th class="num">Total</th>
              <th>Coupon</th>
            </tr>
          </thead>
          <tbody>
            {(listRes.results ?? []).map((o) => (
              <tr>
                <td>
                  <a href={`/admin/orders/${o.id}`}>{o.order_number}</a>
                </td>
                <td class="faint nowrap">{o.created_at}</td>
                <td>
                  {o.customer_name ?? '—'}
                  <div class="faint">{o.email ?? ''}</div>
                </td>
                <td>{statusPill(o.status)}</td>
                <td class="num">{formatPence(o.total_pence)}</td>
                <td class="faint">{o.coupon_code ?? '—'}</td>
              </tr>
            ))}
            {!(listRes.results ?? []).length ? (
              <tr>
                <td colSpan={6} class="center muted" style="padding:32px;">
                  No orders match these filters.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <nav class="pagination" aria-label="Pagination">
        {page > 1 ? <a href={`/admin/orders?${qs({ page: page - 1 })}`}>← Prev</a> : null}
        <span aria-current="page">
          Page {page} of {totalPages}
        </span>
        {page < totalPages ? <a href={`/admin/orders?${qs({ page: page + 1 })}`}>Next →</a> : null}
      </nav>
    </AdminLayout>,
  );
});

async function loadOrder(
  env: AppBindings['Bindings'],
  id: number,
): Promise<{ order: OrderWithItems; items: OrderWithItems['items'] } | null> {
  const order = await getOrderWithItems(env, id);
  if (!order) return null;
  return { order, items: order.items };
}

orders.get('/:id', async (c) => {
  const admin = getAdmin(c);
  const id = Number(c.req.param('id'));
  const loaded = await loadOrder(c.env, id);
  if (!loaded) return c.text('Not found', 404);
  const { order, items } = loaded;
  const shipping = parseShipping(order.shipping_json);
  const flash = flashOf(c);

  return c.html(
    <AdminLayout title={`Order ${order.order_number}`} active="orders" admin={admin} msg={flash.msg} err={flash.err}>
      <div class="admin-head">
        <div>
          <h1>
            Order {order.order_number} {statusPill(order.status)}
          </h1>
          <p class="muted">Placed {order.created_at}</p>
        </div>
        <div class="actions">
          <a class="btn btn-secondary" href={`/admin/orders/${id}/slip`} target="_blank">
            Print packing slip
          </a>
          <a class="btn btn-secondary" href="/admin/orders">
            ← Back to orders
          </a>
        </div>
      </div>

      <div class="admin-grid cols-2">
        <div class="admin-panel">
          <h3>Items</h3>
          <div class="admin-table-wrap">
            <table class="admin-table">
              <thead>
                <tr>
                  <th>Item</th>
                  <th class="num">Qty</th>
                  <th class="num">Unit</th>
                  <th class="num">Total</th>
                </tr>
              </thead>
              <tbody>
                {items.map((it) => (
                  <tr>
                    <td>
                      {it.title}
                      {it.sku ? <div class="faint">{it.sku}</div> : null}
                    </td>
                    <td class="num">{it.quantity}</td>
                    <td class="num">{formatPence(it.unit_price_pence)}</td>
                    <td class="num">{formatPence(it.line_total_pence)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul class="totals">
            <li>
              <span>Subtotal</span>
              <span>{formatPence(order.subtotal_pence)}</span>
            </li>
            <li>
              <span>Discount {order.coupon_code ? `(${order.coupon_code})` : ''}</span>
              <span>-{formatPence(order.discount_pence)}</span>
            </li>
            <li>
              <span>Shipping</span>
              <span>{formatPence(order.shipping_pence)}</span>
            </li>
            <li class="total">
              <span>Total</span>
              <span>{formatPence(order.total_pence)}</span>
            </li>
          </ul>
        </div>

        <div class="stack">
          <div class="admin-panel">
            <h3>Customer</h3>
            <p>
              {order.customer_name ?? '—'}
              <br />
              {order.email ?? '—'}
              <br />
              {order.phone ?? ''}
            </p>
            {shipping ? (
              <>
                <h3>Shipping address</h3>
                <p>
                  {shipping.line1}
                  <br />
                  {shipping.line2 ? (
                    <>
                      {shipping.line2}
                      <br />
                    </>
                  ) : null}
                  {shipping.city} {shipping.postcode}
                  <br />
                  {shipping.country}
                </p>
              </>
            ) : null}
            <h3>Payment</h3>
            <p class="faint" style="word-break:break-all;">
              Session: {order.stripe_session_id ?? '—'}
              <br />
              Payment intent: {order.stripe_payment_intent ?? '—'}
            </p>
            {order.tracking_number ? (
              <p>
                Tracking: <strong>{order.tracking_number}</strong> ({order.carrier ?? 'carrier not set'})
              </p>
            ) : null}
          </div>

          <div class="admin-panel">
            <h3>Actions</h3>
            <div class="stack">
              {order.status !== 'fulfilled' && order.status !== 'cancelled' ? (
                <form method="post" action={`/admin/orders/${id}/fulfil`} class="stack">
                  <CsrfField token={admin.csrf} />
                  <div class="admin-grid cols-2">
                    <div class="field">
                      <label for="tracking_number">Tracking number</label>
                      <input id="tracking_number" name="tracking_number" type="text" value={order.tracking_number ?? ''} />
                    </div>
                    <div class="field">
                      <label for="carrier">Carrier</label>
                      <input id="carrier" name="carrier" type="text" value={order.carrier ?? ''} placeholder="Royal Mail, Evri…" />
                    </div>
                  </div>
                  <button class="btn" type="submit">
                    Mark fulfilled
                  </button>
                </form>
              ) : null}

              <div class="row">
                {order.status !== 'refunded' ? (
                  <form method="post" action={`/admin/orders/${id}/refund`}>
                    <CsrfField token={admin.csrf} />
                    <button class="btn btn-secondary" type="submit">
                      Mark refunded
                    </button>
                  </form>
                ) : null}
                {order.status !== 'cancelled' && order.status !== 'fulfilled' ? (
                  <form method="post" action={`/admin/orders/${id}/cancel`}>
                    <CsrfField token={admin.csrf} />
                    <button class="btn btn-danger" type="submit">
                      Cancel order
                    </button>
                  </form>
                ) : null}
              </div>
            </div>
          </div>

          <div class="admin-panel">
            <h3>Internal note</h3>
            {order.notes ? <p class="notice">{order.notes}</p> : <p class="muted">No notes yet.</p>}
            <form method="post" action={`/admin/orders/${id}/note`} class="stack">
              <CsrfField token={admin.csrf} />
              <textarea name="note" placeholder="Visible only to admins…" rows={3} />
              <button class="btn btn-secondary btn-sm" type="submit">
                Add note
              </button>
            </form>
          </div>
        </div>
      </div>
    </AdminLayout>,
  );
});

orders.post('/:id/fulfil', async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.parseBody();
  if (!verifyCsrf(c, typeof body._csrf === 'string' ? body._csrf : undefined)) {
    return c.redirect(`/admin/orders/${id}?err=` + encodeURIComponent('Your session expired — please try again.'), 303);
  }
  const tracking = typeof body.tracking_number === 'string' ? body.tracking_number.trim() : '';
  const carrier = typeof body.carrier === 'string' ? body.carrier.trim() : '';
  await c.env.DB.prepare(
    "UPDATE orders SET status = 'fulfilled', tracking_number = ?, carrier = ?, updated_at = datetime('now') WHERE id = ?",
  )
    .bind(tracking || null, carrier || null, id)
    .run();
  return c.redirect(`/admin/orders/${id}?msg=${encodeURIComponent('Order marked fulfilled.')}`, 303);
});

orders.post('/:id/refund', async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.parseBody();
  if (!verifyCsrf(c, typeof body._csrf === 'string' ? body._csrf : undefined)) {
    return c.redirect(`/admin/orders/${id}?err=` + encodeURIComponent('Your session expired — please try again.'), 303);
  }
  await c.env.DB.prepare("UPDATE orders SET status = 'refunded', updated_at = datetime('now') WHERE id = ?")
    .bind(id)
    .run();
  return c.redirect(`/admin/orders/${id}?msg=${encodeURIComponent('Order marked refunded.')}`, 303);
});

orders.post('/:id/cancel', async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.parseBody();
  if (!verifyCsrf(c, typeof body._csrf === 'string' ? body._csrf : undefined)) {
    return c.redirect(`/admin/orders/${id}?err=` + encodeURIComponent('Your session expired — please try again.'), 303);
  }
  const loaded = await loadOrder(c.env, id);
  if (!loaded) return c.text('Not found', 404);

  // A fulfilled order has already left the building — restocking it would
  // invent stock that isn't on the shelf. Only pending/paid orders cancel.
  if (loaded.order.status !== 'pending' && loaded.order.status !== 'paid') {
    return c.redirect(
      `/admin/orders/${id}?err=` +
        encodeURIComponent(
          `A ${loaded.order.status} order can't be cancelled. Refund it instead if the customer is owed money.`,
        ),
      303,
    );
  }

  // Claim the cancellation atomically: whichever request wins the guarded
  // UPDATE is the one that restocks, so a double-tap cannot credit stock twice.
  const claim = await c.env.DB.prepare(
    `UPDATE orders
        SET status = 'cancelled', stock_applied = 0, updated_at = datetime('now')
      WHERE id = ? AND status IN ('pending', 'paid')`,
  )
    .bind(id)
    .run();

  if ((claim.meta.changes ?? 0) === 0) {
    return c.redirect(
      `/admin/orders/${id}?msg=${encodeURIComponent('That order was already cancelled.')}`,
      303,
    );
  }

  if (loaded.order.stock_applied) {
    const restocks = loaded.items
      .filter((item) => item.product_id)
      .map((item) =>
        c.env.DB.prepare(
          "UPDATE products SET stock = stock + ?, updated_at = datetime('now') WHERE id = ?",
        ).bind(item.quantity, item.product_id),
      );
    if (restocks.length) await c.env.DB.batch(restocks);
  }

  return c.redirect(
    `/admin/orders/${id}?msg=${encodeURIComponent(
      loaded.order.stock_applied ? 'Order cancelled and stock restored.' : 'Order cancelled.',
    )}`,
    303,
  );
});

orders.post('/:id/note', async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.parseBody();
  if (!verifyCsrf(c, typeof body._csrf === 'string' ? body._csrf : undefined)) {
    return c.redirect(`/admin/orders/${id}?err=` + encodeURIComponent('Your session expired — please try again.'), 303);
  }
  const note = typeof body.note === 'string' ? body.note.trim() : '';
  if (note) {
    await c.env.DB.prepare(
      "UPDATE orders SET notes = TRIM(COALESCE(notes || char(10), '') || ?), updated_at = datetime('now') WHERE id = ?",
    )
      .bind(`[${new Date().toISOString().slice(0, 16).replace('T', ' ')}] ${note}`, id)
      .run();
  }
  return c.redirect(`/admin/orders/${id}?msg=${encodeURIComponent('Note added.')}`, 303);
});

orders.get('/:id/slip', async (c) => {
  const id = Number(c.req.param('id'));
  const loaded = await loadOrder(c.env, id);
  if (!loaded) return c.text('Not found', 404);
  const { order, items } = loaded;
  const shipping = parseShipping(order.shipping_json);

  return c.html(
    <AdminPrintPage title={`Packing slip — ${order.order_number}`}>
      <div class="print-actions no-print">
        <button class="btn" onclick="window.print()">
          Print
        </button>
      </div>
      <div class="slip-head">
        <div>
          <div class="slip-wordmark">
            27<span style="color:var(--accent)">beauty</span>
          </div>
          <div class="faint">27beauty.co.uk</div>
        </div>
        <div class="slip-meta">
          <div>
            Order <strong>{order.order_number}</strong>
          </div>
          <div class="faint">{order.created_at}</div>
        </div>
      </div>
      <div class="slip-columns">
        <div>
          <h3>Ship to</h3>
          <p>
            {order.customer_name}
            <br />
            {shipping?.line1}
            <br />
            {shipping?.line2 ? (
              <>
                {shipping.line2}
                <br />
              </>
            ) : null}
            {shipping?.city} {shipping?.postcode}
            <br />
            {shipping?.country}
          </p>
        </div>
        <div>
          <h3>Order notes</h3>
          <p>{order.coupon_code ? `Coupon used: ${order.coupon_code}` : 'No coupon used.'}</p>
        </div>
      </div>
      <table class="admin-table">
        <thead>
          <tr>
            <th>Item</th>
            <th>SKU</th>
            <th class="num">Qty</th>
          </tr>
        </thead>
        <tbody>
          {items.map((it) => (
            <tr>
              <td>{it.title}</td>
              <td>{it.sku ?? '—'}</td>
              <td class="num">{it.quantity}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p class="faint" style="margin-top:24px;">
        Thank you for shopping with 27beauty. Questions? hello@27beauty.co.uk
      </p>
    </AdminPrintPage>,
  );
});

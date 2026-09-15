import { Hono } from 'hono';
import type { AppBindings, Order, OrderStatus, ShippingAddress } from '../../types';
import { getAdmin, verifyCsrf } from '../../lib/admin-auth';
import { AdminLayout, AdminPrintPage, CsrfField } from '../../ui/admin-layout';
import { formatPence } from '../../lib/money';
import { clampInt } from '../../lib/util';
import { getOrderWithItems, type OrderWithItems } from '../../lib/orders';
import { pushOrderToParcel2Go } from '../../lib/parcel2go';

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

/**
 * Step-by-step "what happened to this order" summary, since paid orders
 * quietly trigger several automated things (stock, Parcel2Go) that
 * otherwise aren't visible anywhere unless you know to scroll for them.
 */
function OrderFlow({ order }: { order: Order }) {
  type Step = { label: string; state: 'done' | 'pending' | 'error' | 'skip'; detail?: string };

  const isPaid = order.status === 'paid' || order.status === 'fulfilled' || order.status === 'refunded';
  const isCancelled = order.status === 'cancelled';

  const steps: Step[] = [
    { label: 'Basket started', state: 'done', detail: order.created_at },
    isCancelled
      ? { label: 'Payment', state: 'error', detail: 'Never completed — expired, failed, or cancelled' }
      : { label: 'Payment confirmed', state: isPaid ? 'done' : 'pending', detail: isPaid ? undefined : 'Waiting for checkout' },
  ];

  if (isPaid) {
    steps.push({
      label: 'Stock updated',
      state: order.stock_applied ? 'done' : 'pending',
    });
    steps.push(
      order.parcel2go_status === 'pushed'
        ? { label: 'Pushed to Parcel2Go', state: 'done', detail: `Order ${order.parcel2go_order_id}` }
        : order.parcel2go_status === 'error'
          ? { label: 'Pushed to Parcel2Go', state: 'error', detail: order.parcel2go_error ?? undefined }
          : { label: 'Pushed to Parcel2Go', state: 'pending', detail: 'Not sent yet' },
    );
    steps.push(
      order.status === 'fulfilled'
        ? { label: 'Fulfilled', state: 'done', detail: order.tracking_number ? `Tracking: ${order.tracking_number}` : undefined }
        : order.status === 'refunded'
          ? { label: 'Refunded', state: 'done' }
          : { label: 'Fulfilled', state: 'pending', detail: 'Mark fulfilled once shipped' },
    );
  }

  return (
    <ul class="order-flow">
      {steps.map((s) => (
        <li class={`flow-${s.state === 'skip' ? 'pending' : s.state}`}>
          <span class="flow-icon">{s.state === 'done' ? '✓' : s.state === 'error' ? '!' : '·'}</span>
          <span>
            <div class="flow-label">{s.label}</div>
            {s.detail ? <div class="flow-detail">{s.detail}</div> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

function parseShipping(json: string | null): ShippingAddress | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as ShippingAddress;
  } catch {
    return null;
  }
}

const PAID_STATUSES = ['paid', 'fulfilled', 'refunded'] as const;
const BASKET_STATUSES = ['pending', 'cancelled'] as const;
const SHIPPING_STATUSES = ['paid'] as const;

/** Push/Ship control shown per-row in the Orders and Shipping tabs. */
function ShipCell({ order, csrf, redirect }: { order: Order; csrf: string; redirect: string }) {
  if (order.status !== 'paid') return <span class="faint">—</span>;
  if (order.parcel2go_status === 'pushed' && order.parcel2go_payment_url) {
    return (
      <a class="btn btn-sm btn-secondary" href={order.parcel2go_payment_url} target="_blank" rel="noreferrer">
        Ship →
      </a>
    );
  }
  return (
    <form method="post" action={`/admin/orders/${order.id}/parcel2go`}>
      <input type="hidden" name="_csrf" value={csrf} />
      <input type="hidden" name="redirect" value={redirect} />
      <button class="btn btn-sm btn-accent" type="submit" title={order.parcel2go_error ?? undefined}>
        {order.parcel2go_status === 'error' ? 'Retry push' : 'Push to ship'}
      </button>
    </form>
  );
}

orders.get('/', async (c) => {
  const admin = getAdmin(c);
  const query = c.req.query();
  const page = clampInt(query.page, 1, 100000, 1);
  const view = query.view === 'baskets' ? 'baskets' : query.view === 'shipping' ? 'shipping' : 'orders';
  const allowedStatuses: readonly string[] =
    view === 'baskets' ? BASKET_STATUSES : view === 'shipping' ? SHIPPING_STATUSES : PAID_STATUSES;
  const status = query.status && allowedStatuses.includes(query.status) ? query.status : undefined;
  const search = query.q?.trim();
  const backHref = `/admin/orders?${new URLSearchParams(query as Record<string, string>).toString()}`;

  const where: string[] = [`status IN (${allowedStatuses.map(() => '?').join(',')})`];
  const params: unknown[] = [...allowedStatuses];
  if (status) {
    where.push('status = ?');
    params.push(status);
  }
  if (search) {
    where.push('(order_number LIKE ? OR lower(email) LIKE ?)');
    params.push(`%${search}%`, `%${search.toLowerCase()}%`);
  }
  const whereSql = `WHERE ${where.join(' AND ')}`;
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
  const results = listRes.results ?? [];

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
        <h1>{view === 'baskets' ? 'Open baskets' : view === 'shipping' ? 'Shipping' : 'Orders'}</h1>
        <p class="muted">
          {total} {view === 'baskets' ? 'basket' : view === 'shipping' ? 'order awaiting shipping' : 'order'}
          {total === 1 ? '' : 's'}.
        </p>
      </div>

      <nav class="admin-tabs" aria-label="Order views">
        <a href="/admin/orders" class={view === 'orders' ? 'active' : ''}>
          Orders
        </a>
        <a href="/admin/orders?view=shipping" class={view === 'shipping' ? 'active' : ''}>
          Shipping
        </a>
        <a href="/admin/orders?view=baskets" class={view === 'baskets' ? 'active' : ''}>
          Open baskets
        </a>
      </nav>

      {view === 'baskets' ? (
        <p class="muted" style="margin-top:-8px;margin-bottom:16px;">
          Baskets that started checkout but never paid — still in progress, expired, or abandoned at
          Stripe. Most won't have an email unless the shopper got as far as typing one in before leaving.
        </p>
      ) : null}
      {view === 'shipping' ? (
        <p class="muted" style="margin-top:-8px;margin-bottom:16px;">
          Paid orders not yet fulfilled. "Push to ship" sends the order to Parcel2Go — click "Ship →"
          to open the booking and pay for the label. An order drops off this list once marked fulfilled.
        </p>
      ) : null}

      <form method="get" action="/admin/orders" class="filter-bar">
        <input type="hidden" name="view" value={view} />
        <div class="field field-wide">
          <label for="q">Search</label>
          <input id="q" type="search" name="q" value={query.q ?? ''} placeholder="Order number or email…" />
        </div>
        {view !== 'shipping' ? (
          <div class="field">
            <label for="status">Status</label>
            <select id="status" name="status">
              <option value="">All</option>
              {allowedStatuses.map((s) => (
                <option value={s} selected={status === s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        <button class="btn btn-secondary" type="submit">
          Filter
        </button>
      </form>

      {view === 'shipping' ? (
        <div class="admin-table-wrap">
          <table class="admin-table">
            <thead>
              <tr>
                <th>Order</th>
                <th class="col-optional">Date</th>
                <th>Customer</th>
                <th class="num">Total</th>
                <th>Ship</th>
              </tr>
            </thead>
            <tbody>
              {results.map((o) => (
                <tr>
                  <td>
                    <a href={`/admin/orders/${o.id}`}>{o.order_number}</a>
                  </td>
                  <td class="faint nowrap col-optional">{o.created_at}</td>
                  <td>
                    {o.customer_name ?? '—'}
                    <div class="faint">{o.email ?? ''}</div>
                  </td>
                  <td class="num">{formatPence(o.total_pence)}</td>
                  <td>
                    <ShipCell order={o} csrf={admin.csrf} redirect={backHref} />
                    {o.parcel2go_status === 'error' ? (
                      <div class="faint small" style="max-width:220px;">
                        {o.parcel2go_error}
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))}
              {!results.length ? (
                <tr>
                  <td colSpan={5} class="center muted" style="padding:32px;">
                    Nothing waiting to ship — every paid order is fulfilled.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      ) : view === 'baskets' ? (
        <form method="post" action="/admin/orders/export-baskets">
          <input type="hidden" name="_csrf" value={admin.csrf} />
          <div class="bulk-bar">
            <label class="checkbox-row" style="margin:0;">
              <input type="checkbox" id="select-all-baskets" /> Select all on this page
            </label>
            <button class="btn btn-secondary btn-sm" type="submit">
              Export selected (CSV)
            </button>
          </div>
          <div class="admin-table-wrap">
            <table class="admin-table">
              <thead>
                <tr>
                  <th></th>
                  <th>Basket</th>
                  <th class="col-optional">Date</th>
                  <th>Contact</th>
                  <th>Status</th>
                  <th class="num">Total</th>
                  <th>Resume link</th>
                </tr>
              </thead>
              <tbody>
                {results.map((o) => (
                  <tr>
                    <td>
                      <input type="checkbox" name="ids" value={o.id} class="basket-select" />
                    </td>
                    <td>
                      <a href={`/admin/orders/${o.id}`}>{o.order_number}</a>
                    </td>
                    <td class="faint nowrap col-optional">{o.created_at}</td>
                    <td>
                      {o.customer_name ?? <span class="faint">Unknown</span>}
                      <div class="faint">{o.email ?? '—'}</div>
                    </td>
                    <td>{statusPill(o.status)}</td>
                    <td class="num">{formatPence(o.total_pence)}</td>
                    <td class="faint">
                      {o.recovery_url ? (
                        <a href={o.recovery_url} target="_blank" rel="noreferrer">
                          Resume link
                        </a>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                ))}
                {!results.length ? (
                  <tr>
                    <td colSpan={7} class="center muted" style="padding:32px;">
                      No open baskets match these filters.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </form>
      ) : (
        <div class="admin-table-wrap">
          <table class="admin-table">
            <thead>
              <tr>
                <th>Order</th>
                <th class="col-optional">Date</th>
                <th>Customer</th>
                <th>Status</th>
                <th class="num">Total</th>
                <th class="col-optional">Coupon</th>
                <th>Ship</th>
              </tr>
            </thead>
            <tbody>
              {results.map((o) => (
                <tr>
                  <td>
                    <a href={`/admin/orders/${o.id}`}>{o.order_number}</a>
                  </td>
                  <td class="faint nowrap col-optional">{o.created_at}</td>
                  <td>
                    {o.customer_name ?? '—'}
                    <div class="faint">{o.email ?? ''}</div>
                    {/* Shown here only on phones, where the Date column is hidden. */}
                    <div class="faint small show-when-narrow">{o.created_at?.slice(0, 10)}</div>
                  </td>
                  <td>{statusPill(o.status)}</td>
                  <td class="num">{formatPence(o.total_pence)}</td>
                  <td class="faint col-optional">{o.coupon_code ?? '—'}</td>
                  <td>
                    <ShipCell order={o} csrf={admin.csrf} redirect={backHref} />
                  </td>
                </tr>
              ))}
              {!results.length ? (
                <tr>
                  <td colSpan={7} class="center muted" style="padding:32px;">
                    No orders match these filters.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      )}

      <nav class="pagination" aria-label="Pagination">
        {page > 1 ? <a href={`/admin/orders?${qs({ page: page - 1 })}`}>← Prev</a> : null}
        <span aria-current="page">
          Page {page} of {totalPages}
        </span>
        {page < totalPages ? <a href={`/admin/orders?${qs({ page: page + 1 })}`}>Next →</a> : null}
      </nav>

      {view === 'baskets' ? (
        <script
          dangerouslySetInnerHTML={{
            __html: `document.getElementById('select-all-baskets')?.addEventListener('change', function (e) {
              document.querySelectorAll('.basket-select').forEach(function (cb) { cb.checked = e.target.checked; });
            });`,
          }}
        />
      ) : null}
    </AdminLayout>,
  );
});

orders.post('/export-baskets', async (c) => {
  const body = await c.req.parseBody();
  if (!verifyCsrf(c, typeof body._csrf === 'string' ? body._csrf : undefined)) {
    return c.redirect('/admin/orders?view=baskets&err=' + encodeURIComponent('Your session expired — please try again.'), 303);
  }
  const rawIds = body['ids'];
  const ids = (Array.isArray(rawIds) ? rawIds : rawIds ? [rawIds] : [])
    .map((v) => Number(v))
    .filter((n) => Number.isFinite(n));

  if (!ids.length) {
    return c.redirect('/admin/orders?view=baskets&err=' + encodeURIComponent('Select at least one basket to export.'), 303);
  }

  const placeholders = ids.map(() => '?').join(',');
  const { results } = await c.env.DB.prepare(
    `SELECT order_number, email, customer_name, phone, total_pence, status, created_at, recovery_url
       FROM orders WHERE id IN (${placeholders}) ORDER BY created_at DESC`,
  )
    .bind(...ids)
    .all<{
      order_number: string;
      email: string | null;
      customer_name: string | null;
      phone: string | null;
      total_pence: number;
      status: string;
      created_at: string;
      recovery_url: string | null;
    }>();

  const csvEscape = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const rows = [
    ['Order', 'Email', 'Name', 'Phone', 'Total', 'Status', 'Date', 'Resume link'],
    ...(results ?? []).map((r) => [
      r.order_number,
      r.email ?? '',
      r.customer_name ?? '',
      r.phone ?? '',
      formatPence(r.total_pence),
      r.status,
      r.created_at,
      r.recovery_url ?? '',
    ]),
  ];
  const csv = rows.map((row) => row.map((cell) => csvEscape(String(cell))).join(',')).join('\r\n');

  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="open-baskets-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
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

      <div class="admin-panel">
        <h3>Order flow</h3>
        <OrderFlow order={order} />
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

            <h3>Parcel2Go</h3>
            {order.parcel2go_status === 'pushed' ? (
              <p>
                Pushed as order <strong>{order.parcel2go_order_id}</strong>.{' '}
                {order.parcel2go_payment_url ? (
                  <a href={order.parcel2go_payment_url} target="_blank" rel="noreferrer">
                    Book shipping on Parcel2Go →
                  </a>
                ) : (
                  'No payment link returned.'
                )}
              </p>
            ) : order.parcel2go_status === 'error' ? (
              <p class="notice notice-bad">Push failed: {order.parcel2go_error}</p>
            ) : (
              <p class="muted">Not pushed yet.</p>
            )}
            <form method="post" action={`/admin/orders/${id}/parcel2go`}>
              <CsrfField token={admin.csrf} />
              <button class="btn btn-sm btn-secondary" type="submit">
                {order.parcel2go_status === 'pushed' ? 'Push again' : 'Push to Parcel2Go'}
              </button>
            </form>
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

/** Only ever sends the admin back into /admin/orders — never an open redirect. */
function safeOrdersRedirect(raw: unknown, fallback: string): string {
  return typeof raw === 'string' && raw.startsWith('/admin/orders') ? raw : fallback;
}

orders.post('/:id/parcel2go', async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.parseBody();
  if (!verifyCsrf(c, typeof body._csrf === 'string' ? body._csrf : undefined)) {
    return c.redirect(`/admin/orders/${id}?err=` + encodeURIComponent('Your session expired — please try again.'), 303);
  }
  const back = safeOrdersRedirect(body.redirect, `/admin/orders/${id}`);
  const sep = back.includes('?') ? '&' : '?';
  const order = await c.env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(id).first<Order>();
  if (!order) return c.redirect('/admin/orders', 303);

  try {
    const result = await pushOrderToParcel2Go(c.env, order);
    await c.env.DB.prepare(
      `UPDATE orders
         SET parcel2go_order_id = ?, parcel2go_payment_url = ?, parcel2go_status = 'pushed', parcel2go_error = NULL
       WHERE id = ?`,
    )
      .bind(result.orderId, result.paymentUrl, id)
      .run();
    return c.redirect(`${back}${sep}msg=` + encodeURIComponent('Pushed to Parcel2Go.'), 303);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await c.env.DB.prepare(`UPDATE orders SET parcel2go_status = 'error', parcel2go_error = ? WHERE id = ?`)
      .bind(message.slice(0, 1000), id)
      .run();
    return c.redirect(`${back}${sep}err=` + encodeURIComponent(`Parcel2Go: ${message}`), 303);
  }
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
        Thank you for shopping with 27beauty. Questions? 27beautyltd@gmail.com
      </p>
    </AdminPrintPage>,
  );
});

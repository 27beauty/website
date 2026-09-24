import { Hono } from 'hono';
import type { AppBindings, SyncRun } from '../../types';
import { auth } from './auth';
import { products } from './products';
import { stock } from './stock';
import { categories } from './categories';
import { media } from './media';
import { orders } from './orders';
import { coupons } from './coupons';
import { settings } from './settings';
import { b2b } from './b2b';
import { getAdmin, requireAdmin } from '../../lib/admin-auth';
import { AdminLayout } from '../../ui/admin-layout';
import { formatPence } from '../../lib/money';
import { getSetting } from '../../lib/settings';

/** Admin panel: auth, dashboard, products, orders, coupons, settings, sync. */
export const admin = new Hono<AppBindings>();

// Mounted BEFORE requireAdmin so they work with no session:
//  - /login, /setup, /logout (auth.tsx)
//  - /media/:key — uploaded product photos, which the storefront must also load
admin.route('/', auth);
admin.route('/media', media);

admin.use('*', requireAdmin);

interface OrderStats {
  today_revenue: number;
  today_orders: number;
  revenue_30d: number;
  orders_30d: number;
}

interface ProductStats {
  active_total: number;
  out_of_stock: number;
  low_stock: number;
}

admin.get('/', async (c) => {
  const session = getAdmin(c);
  const flash = { msg: c.req.query('msg') ?? null, err: c.req.query('err') ?? null };

  const [orderStats, awaitingRow, productStats, lastSync, lowStockRows, p2gStats, p2gEnabled, newB2bRow] = await Promise.all([
    c.env.DB.prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN date(created_at) = date('now') THEN total_pence ELSE 0 END), 0) AS today_revenue,
         COALESCE(SUM(CASE WHEN date(created_at) = date('now') THEN 1 ELSE 0 END), 0) AS today_orders,
         COALESCE(SUM(CASE WHEN created_at >= datetime('now', '-30 days') THEN total_pence ELSE 0 END), 0) AS revenue_30d,
         COALESCE(SUM(CASE WHEN created_at >= datetime('now', '-30 days') THEN 1 ELSE 0 END), 0) AS orders_30d
       FROM orders WHERE status IN ('paid', 'fulfilled')`,
    ).first<OrderStats>(),
    c.env.DB.prepare("SELECT COUNT(*) AS n FROM orders WHERE status = 'paid'").first<{ n: number }>(),
    c.env.DB.prepare(
      `SELECT
         COUNT(*) AS active_total,
         COALESCE(SUM(CASE WHEN stock = 0 THEN 1 ELSE 0 END), 0) AS out_of_stock,
         COALESCE(SUM(CASE WHEN stock > 0 AND stock <= 3 THEN 1 ELSE 0 END), 0) AS low_stock
       FROM products WHERE status = 'active'`,
    ).first<ProductStats>(),
    c.env.DB.prepare('SELECT * FROM sync_runs ORDER BY started_at DESC LIMIT 1').first<SyncRun>(),
    c.env.DB.prepare(
      `SELECT title, stock, id FROM products WHERE status = 'active' AND stock <= 3 ORDER BY stock ASC, title ASC LIMIT 8`,
    ).all<{ title: string; stock: number; id: number }>(),
    c.env.DB.prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN parcel2go_status = 'pushed' THEN 1 ELSE 0 END), 0) AS pushed,
         COALESCE(SUM(CASE WHEN parcel2go_status = 'error' THEN 1 ELSE 0 END), 0) AS errored
       FROM orders WHERE status IN ('paid', 'fulfilled', 'refunded')`,
    ).first<{ pushed: number; errored: number }>(),
    getSetting<boolean>(c.env, 'parcel2go.enabled', false),
    c.env.DB.prepare("SELECT COUNT(*) AS n FROM b2b_inquiries WHERE status = 'new'").first<{ n: number }>(),
  ]);

  const newB2bCount = newB2bRow?.n ?? 0;
  const stats: OrderStats = orderStats ?? { today_revenue: 0, today_orders: 0, revenue_30d: 0, orders_30d: 0 };
  const pStats: ProductStats = productStats ?? { active_total: 0, out_of_stock: 0, low_stock: 0 };
  const awaiting = awaitingRow?.n ?? 0;
  const p2g = p2gStats ?? { pushed: 0, errored: 0 };
  const p2gConfigured = Boolean(c.env.PARCEL2GO_CLIENT_ID && c.env.PARCEL2GO_CLIENT_SECRET);

  return c.html(
    <AdminLayout title="Dashboard" active="dashboard" admin={session} msg={flash.msg} err={flash.err}>
      <div class="admin-head">
        <h1>Welcome back{session.name ? `, ${session.name}` : ''}</h1>
      </div>

      <div class="stat-grid">
        <div class="stat-tile">
          <div class="stat-label">Today's revenue</div>
          <div class="stat-value">{formatPence(stats.today_revenue)}</div>
          <div class="stat-sub">{stats.today_orders} paid order{stats.today_orders === 1 ? '' : 's'}</div>
        </div>
        <div class="stat-tile">
          <div class="stat-label">Last 30 days</div>
          <div class="stat-value">{formatPence(stats.revenue_30d)}</div>
          <div class="stat-sub">{stats.orders_30d} paid order{stats.orders_30d === 1 ? '' : 's'}</div>
        </div>
        <div class={`stat-tile ${awaiting > 0 ? 'stat-warn' : ''}`}>
          <div class="stat-label">Awaiting fulfilment</div>
          <div class="stat-value">{awaiting}</div>
          <div class="stat-sub">
            <a href="/admin/orders?view=shipping">View orders →</a>
          </div>
        </div>
        <div class="stat-tile">
          <div class="stat-label">Active products</div>
          <div class="stat-value">{pStats.active_total}</div>
        </div>
        <div class={`stat-tile ${pStats.low_stock > 0 ? 'stat-warn' : ''}`}>
          <div class="stat-label">Low stock (≤3)</div>
          <div class="stat-value">{pStats.low_stock}</div>
        </div>
        <div class={`stat-tile ${pStats.out_of_stock > 0 ? 'stat-bad' : ''}`}>
          <div class="stat-label">Out of stock</div>
          <div class="stat-value">{pStats.out_of_stock}</div>
        </div>
        <div class={`stat-tile ${newB2bCount > 0 ? 'stat-warn' : ''}`}>
          <div class="stat-label">New trade enquiries</div>
          <div class="stat-value">{newB2bCount}</div>
          <div class="stat-sub">
            <a href="/admin/b2b">View enquiries →</a>
          </div>
        </div>
      </div>

      <div class="quick-links">
        <a class="btn btn-secondary" href="/admin/stock">
          Update stock
        </a>
        <a class="btn btn-secondary" href="/admin/products/new">
          + New product
        </a>
        <a class="btn btn-secondary" href="/admin/orders?view=shipping">
          Orders to fulfil
        </a>
        <a class="btn btn-secondary" href="/admin/coupons/new">
          + New coupon
        </a>
        <a class="btn btn-secondary" href="/admin/coupons/poster">
          QR10 poster
        </a>
        <a class="btn btn-secondary" href="/admin/b2b">
          Trade enquiries
        </a>
        <a class="btn btn-secondary" href="/admin/settings">
          Settings
        </a>
      </div>

      <div class="admin-grid cols-3">
        <div class="admin-panel">
          <h3>Low &amp; out of stock</h3>
          {(lowStockRows.results ?? []).length ? (
            <ul style="margin:0;padding-left:18px;">
              {(lowStockRows.results ?? []).map((p) => (
                <li>
                  <a href={`/admin/products/${p.id}`}>{p.title}</a> — {p.stock === 0 ? <strong>out of stock</strong> : `${p.stock} left`}
                </li>
              ))}
            </ul>
          ) : (
            <p class="muted">Everything is well stocked.</p>
          )}
          <p style="margin-top:10px;">
            <a href="/admin/stock">Update stock across every channel →</a>
          </p>
        </div>

        <div class="admin-panel">
          <h3>Last eBay sync</h3>
          {lastSync ? (
            <>
              <p>
                <span class={`pill ${lastSync.status === 'ok' ? 'pill-ok' : lastSync.status === 'error' ? 'pill-bad' : 'pill-warn'}`}>
                  {lastSync.status}
                </span>{' '}
                <span class="faint">{lastSync.started_at}</span>
              </p>
              <p class="muted">
                {lastSync.created_count} created · {lastSync.updated_count} updated · {lastSync.ended_count} ended
              </p>
              {lastSync.message ? <p class="faint">{lastSync.message}</p> : null}
            </>
          ) : (
            <p class="muted">No sync has run yet.</p>
          )}
          <p style="margin-top:10px;">
            <a href="/admin/settings">Manage eBay accounts →</a>
          </p>
        </div>

        <div class="admin-panel">
          <h3>Parcel2Go</h3>
          <p>
            <span class={`pill ${!p2gEnabled ? 'pill-warn' : !p2gConfigured ? 'pill-bad' : 'pill-ok'}`}>
              {!p2gEnabled ? 'disabled' : !p2gConfigured ? 'missing credentials' : 'active'}
            </span>
          </p>
          <p class="muted">
            {p2g.pushed} pushed · {p2g.errored} failed
          </p>
          {p2g.errored > 0 ? (
            <p class="faint">
              <a href="/admin/orders?view=shipping">Check failed pushes →</a>
            </p>
          ) : null}
          <p class="field-hint" style="margin-top:10px;">
            Pushed orders don't show up if you log into parcel2go.com — they're app-level bookings
            only reachable via the link on each order's admin page.
          </p>
          <p style="margin-top:10px;">
            <a href="/admin/settings">Manage Parcel2Go →</a>
          </p>
        </div>
      </div>
    </AdminLayout>,
  );
});

admin.route('/products', products);
admin.route('/stock', stock);
admin.route('/categories', categories);
admin.route('/orders', orders);
admin.route('/coupons', coupons);
admin.route('/b2b', b2b);
admin.route('/settings', settings);

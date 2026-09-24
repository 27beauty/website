import { Hono } from 'hono';
import type { AppBindings, ProductWithCategory } from '../../types';
import { getAdmin, verifyCsrf } from '../../lib/admin-auth';
import { AdminLayout, CsrfField } from '../../ui/admin-layout';
import { clampInt } from '../../lib/util';
import { REASON_LABELS, centralStockEnabled, movementsFor, setStock } from '../../lib/stock';
import { listingsForProducts, pushSoon, readiness } from '../../lib/channels';
import type { ChannelListing } from '../../types';

/**
 * One screen for stock across every channel the shop sells on.
 *
 * `stock` is the master figure. Once centralised stock is on (Sales channels),
 * every sale on the website, eBay or Amazon comes off it and every change here
 * is sent to each linked listing. Each row shows what every listing says, so
 * a listing that hasn't caught up yet is visible.
 */
export const stock = new Hono<AppBindings>();

const PER_PAGE = 100;

interface StockRow extends ProductWithCategory {
  category_name: string | null;
}

function flashOf(c: { req: { query: (k: string) => string | undefined } }) {
  return { msg: c.req.query('msg'), err: c.req.query('err') };
}

stock.get('/', async (c) => {
  const admin = getAdmin(c);
  const flash = flashOf(c);
  const view = c.req.query('view') ?? 'attention';
  const channel = c.req.query('channel') ?? '';

  const where: string[] = ["p.status != 'archived'", 'p.merged_into IS NULL'];
  const params: unknown[] = [];
  if (channel) {
    where.push(`EXISTS (SELECT 1 FROM channel_listings l WHERE l.product_id = p.id AND l.status = 'linked' AND l.account = ?)`);
    params.push(channel);
  }
  const differs = `EXISTS (SELECT 1 FROM channel_listings l WHERE l.product_id = p.id AND l.status = 'linked'
                    AND l.fulfilment = 'merchant' AND l.channel_qty IS NOT NULL AND l.channel_qty != p.stock)`;
  if (view === 'out') where.push('p.stock <= 0');
  if (view === 'low') where.push('p.stock > 0 AND p.stock <= 3');
  if (view === 'mismatch') where.push(differs);

  // "Needs attention" puts the rows that cost money first: nothing left to
  // sell, then nearly nothing, then anything a channel disagrees with.
  const order =
    view === 'attention'
      ? `CASE WHEN p.stock <= 0 THEN 0 WHEN p.stock <= 3 THEN 1 WHEN ${differs} THEN 2 ELSE 3 END, p.stock ASC, p.title ASC`
      : 'p.stock ASC, p.title ASC';

  const [{ results }, counts, accounts, ready, central] = await Promise.all([
    c.env.DB.prepare(
      `SELECT p.*, c.name AS category_name
         FROM products p LEFT JOIN categories c ON c.id = p.category_id
        WHERE ${where.join(' AND ')}
        ORDER BY ${order}
        LIMIT ${PER_PAGE}`,
    )
      .bind(...params)
      .all<StockRow>(),
    c.env.DB.prepare(
      `SELECT
         SUM(CASE WHEN p.stock <= 0 THEN 1 ELSE 0 END) AS out_of_stock,
         SUM(CASE WHEN p.stock > 0 AND p.stock <= 3 THEN 1 ELSE 0 END) AS low,
         SUM(CASE WHEN ${differs} THEN 1 ELSE 0 END) AS mismatched,
         SUM(p.stock) AS units,
         COUNT(*) AS total
       FROM products p WHERE p.status != 'archived' AND p.merged_into IS NULL`,
    ).first<{ out_of_stock: number; low: number; mismatched: number; units: number; total: number }>(),
    c.env.DB.prepare(`SELECT DISTINCT account, channel FROM channel_listings WHERE status = 'linked' ORDER BY channel, account`).all<{
      account: string;
      channel: string;
    }>(),
    readiness(c.env),
    centralStockEnabled(c.env),
  ]);
  const rows = results ?? [];
  const listings = await listingsForProducts(c.env, rows.map((r) => r.id));

  const tab = (key: string, label: string, n?: number) => (
    <a
      class="chip"
      aria-current={view === key ? 'page' : undefined}
      href={`/admin/stock?view=${key}${channel ? `&channel=${encodeURIComponent(channel)}` : ''}`}
    >
      {label}
      {n !== undefined ? ` ${n}` : ''}
    </a>
  );

  return c.html(
    <AdminLayout title="Stock" active="stock" admin={admin} msg={flash.msg} err={flash.err}>
      <div class="admin-head">
        <div>
          <h1>Stock</h1>
          <p class="muted small">
            {counts?.units ?? 0} units across {counts?.total ?? 0} products.{' '}
            {central ? 'This is the master count for the website, eBay and Amazon.' : 'The website sells from this figure.'}
          </p>
        </div>
        <div class="actions">
          <a class="btn btn-secondary btn-sm" href="/admin/channels">
            Sales channels{ready.toReview ? ` (${ready.toReview} to review)` : ''} →
          </a>
        </div>
      </div>

      {!central ? (
        <p class="notice notice-warn">
          Centralised stock is off: eBay's numbers are still copied in by the sync, and nothing here is sent to eBay or
          Amazon. <a href="/admin/channels">Set it up →</a>
        </p>
      ) : null}

      <div class="stat-grid stat-grid-compact">
        <div class={`stat-tile ${(counts?.out_of_stock ?? 0) > 0 ? 'stat-bad' : ''}`}>
          <div class="stat-label">Out of stock</div>
          <div class="stat-value">{counts?.out_of_stock ?? 0}</div>
        </div>
        <div class={`stat-tile ${(counts?.low ?? 0) > 0 ? 'stat-warn' : ''}`}>
          <div class="stat-label">Low (≤3)</div>
          <div class="stat-value">{counts?.low ?? 0}</div>
        </div>
        <div class="stat-tile">
          <div class="stat-label">A listing differs</div>
          <div class="stat-value">{counts?.mismatched ?? 0}</div>
        </div>
      </div>

      <div class="chip-row">
        {tab('attention', 'Needs attention')}
        {tab('all', 'Everything', counts?.total)}
        {tab('out', 'Out of stock', counts?.out_of_stock)}
        {tab('low', 'Low', counts?.low)}
        {tab('mismatch', 'A listing differs', counts?.mismatched)}
      </div>

      {(accounts.results ?? []).length > 1 ? (
        <div class="chip-row">
          <span class="chip-label">Channel</span>
          <a class="chip" aria-current={channel ? undefined : 'page'} href={`/admin/stock?view=${view}`}>
            All
          </a>
          {(accounts.results ?? []).map((a) => (
            <a
              class="chip"
              aria-current={channel === a.account ? 'page' : undefined}
              href={`/admin/stock?view=${view}&channel=${encodeURIComponent(a.account)}`}
            >
              {a.channel === 'amazon' ? 'Amazon' : a.account}
            </a>
          ))}
        </div>
      ) : null}

      <form method="post" action="/admin/stock" id="stock-form">
        <CsrfField token={admin.csrf} />
        <input type="hidden" name="view" value={view} />
        <input type="hidden" name="channel" value={channel} />
        <ul class="stock-list">
          {rows.map((p) => (
            <li>
              <div class="stock-main">
                <a href={`/admin/products/${p.id}`} class="stock-title">
                  {p.title}
                </a>
                <div class="stock-listings">
                  {(listings.get(p.id) ?? []).map((l) => (
                    <ListingBadge l={l} master={p.stock} central={central} />
                  ))}
                  {!(listings.get(p.id) ?? []).length ? <span class="faint small">Website only</span> : null}
                </div>
              </div>
              <div class="stock-edit">
                <input
                  type="number"
                  name={`stock_${p.id}`}
                  value={p.stock}
                  min="0"
                  step="1"
                  aria-label={`Stock for ${p.title}`}
                />
                <a class="small" href={`/admin/stock/${p.id}/history`}>
                  History
                </a>
              </div>
            </li>
          ))}
          {!rows.length ? <li class="center muted">Nothing here — that's good news.</li> : null}
        </ul>
        <div class="row-between stock-save">
          <button class="btn" type="submit">
            Save stock
          </button>
          <span class="muted small">
            {rows.length} row{rows.length === 1 ? '' : 's'} shown
            {rows.length === PER_PAGE ? ` (first ${PER_PAGE})` : ''}
          </span>
        </div>
      </form>
    </AdminLayout>,
  );
});

/** One linked listing: which channel, what it shows, and whether it has caught up. */
function ListingBadge({ l, master, central }: { l: ChannelListing; master: number; central: boolean }) {
  const name = l.channel === 'amazon' ? 'Amazon' : `eBay ${l.account}`;
  if (l.fulfilment === 'amazon') {
    return (
      <span class="stock-badge" title="Amazon ships this from its own warehouse (FBA) — not part of this count">
        {name} <strong>FBA</strong>
      </span>
    );
  }
  const shows = l.channel_qty;
  const behind = shows !== null && shows !== master;
  const state = l.last_error ? 'bad' : behind ? 'warn' : 'ok';
  const text = l.last_error
    ? `Couldn't update: ${l.last_error}`
    : behind
      ? central
        ? `Shows ${shows} — will be set to ${master} on the next check`
        : `Shows ${shows}`
      : `Shows ${shows ?? '?'} — matches`;
  return (
    <span class={`stock-badge stock-badge-${state}`} title={text}>
      {name} <strong>{shows ?? '?'}</strong>
      {state === 'bad' ? ' ⚠' : state === 'warn' ? ' ≠' : ''}
      <span class="sr-only"> — {text}</span>
    </span>
  );
}

stock.post('/', async (c) => {
  const body = await c.req.parseBody();
  if (!verifyCsrf(c, typeof body._csrf === 'string' ? body._csrf : undefined)) {
    return c.redirect('/admin/stock?err=' + encodeURIComponent('Your session expired — please try again.'), 303);
  }

  const view = typeof body.view === 'string' ? body.view : 'attention';
  const channel = typeof body.channel === 'string' ? body.channel : '';
  const back = `/admin/stock?view=${encodeURIComponent(view)}${channel ? `&channel=${encodeURIComponent(channel)}` : ''}`;

  const updates: { productId: number; quantity: number }[] = [];
  for (const [key, value] of Object.entries(body)) {
    if (!key.startsWith('stock_')) continue;
    const id = Number(key.slice('stock_'.length));
    if (!Number.isInteger(id) || id <= 0) continue;
    updates.push({ productId: id, quantity: clampInt(value, 0, 100000, 0) });
  }
  if (!updates.length) return c.redirect(`${back}&msg=${encodeURIComponent('Nothing to save.')}`, 303);

  // Only rows whose number changed are written (and recorded in History),
  // then sent to every linked eBay/Amazon listing.
  const moved = await setStock(c.env, updates, 'admin', 'Stock screen');
  if (!moved.length) return c.redirect(`${back}&msg=${encodeURIComponent('No changes to save.')}`, 303);
  pushSoon(c.env, c.executionCtx, moved);

  return c.redirect(
    `${back}&msg=${encodeURIComponent(`Saved ${moved.length} stock change${moved.length === 1 ? '' : 's'}.`)}`,
    303,
  );
});

/** Every change to one product's count, newest first. */
stock.get('/:id/history', async (c) => {
  const admin = getAdmin(c);
  const id = Number(c.req.param('id'));
  const product = await c.env.DB.prepare('SELECT id, title, stock FROM products WHERE id = ?').bind(id).first<{
    id: number;
    title: string;
    stock: number;
  }>();
  if (!product) return c.text('Not found', 404);
  const [moves, listings] = await Promise.all([movementsFor(c.env, id), listingsForProducts(c.env, [id])]);
  const central = await centralStockEnabled(c.env);

  return c.html(
    <AdminLayout title={`Stock history — ${product.title}`} active="stock" admin={admin}>
      <div class="admin-head">
        <div>
          <h1>Stock history</h1>
          <p class="muted">
            <a href={`/admin/products/${id}`}>{product.title}</a> · now <strong>{product.stock}</strong>
          </p>
        </div>
        <a class="btn btn-secondary btn-sm" href="/admin/stock">
          ← Stock
        </a>
      </div>
      <div class="admin-panel">
        <h3>Listings</h3>
        <div class="stock-listings">
          {(listings.get(id) ?? []).map((l) => (
            <ListingBadge l={l} master={product.stock} central={central} />
          ))}
          {!(listings.get(id) ?? []).length ? <span class="faint">Not listed on eBay or Amazon.</span> : null}
        </div>
      </div>
      <div class="admin-panel">
        <h3>Changes</h3>
        {moves.length ? (
          <ul class="stock-moves">
            {moves.map((m) => (
              <li>
                <span class={`stock-delta ${m.delta < 0 ? 'stock-delta-down' : 'stock-delta-up'}`}>
                  {m.delta > 0 ? `+${m.delta}` : m.delta}
                </span>
                <span class="stock-move-what">
                  <strong>{REASON_LABELS[m.reason] ?? m.reason}</strong>
                  {m.note ? <span class="faint"> · {m.note}</span> : null}
                  <div class="faint small">
                    {m.created_at} UTC{m.stock_after !== null ? ` · left ${m.stock_after}` : ''}
                  </div>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p class="muted">No changes recorded yet. Changes are recorded from when centralised stock was set up.</p>
        )}
      </div>
    </AdminLayout>,
  );
});

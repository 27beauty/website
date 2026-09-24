import { Hono } from 'hono';
import type { AppBindings, ProductWithCategory } from '../../types';
import { getAdmin, verifyCsrf } from '../../lib/admin-auth';
import { AdminLayout, CsrfField } from '../../ui/admin-layout';
import { clampInt } from '../../lib/util';

/**
 * One screen for stock across every channel the shop sells on.
 *
 * `stock` is the master figure the website sells from. `ebay_stock` is what the
 * last eBay sync reported. Showing both makes a drift between channels visible
 * — the thing that actually causes oversells when the same box of stock is
 * listed in two places.
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

  const where: string[] = ["p.status != 'archived'"];
  const params: unknown[] = [];
  if (channel) {
    where.push('p.ebay_account = ?');
    params.push(channel);
  }
  if (view === 'out') where.push('p.stock <= 0');
  if (view === 'low') where.push('p.stock > 0 AND p.stock <= 3');
  if (view === 'mismatch') where.push('p.ebay_stock IS NOT NULL AND p.ebay_stock != p.stock');

  // "Needs attention" puts the rows that cost money first: nothing left to
  // sell, then nearly nothing, then anything that disagrees with eBay.
  const order =
    view === 'attention'
      ? `CASE WHEN p.stock <= 0 THEN 0
              WHEN p.stock <= 3 THEN 1
              WHEN p.ebay_stock IS NOT NULL AND p.ebay_stock != p.stock THEN 2
              ELSE 3 END, p.stock ASC, p.title ASC`
      : 'p.stock ASC, p.title ASC';

  const { results } = await c.env.DB.prepare(
    `SELECT p.*, c.name AS category_name
       FROM products p LEFT JOIN categories c ON c.id = p.category_id
      WHERE ${where.join(' AND ')}
      ORDER BY ${order}
      LIMIT ${PER_PAGE}`,
  )
    .bind(...params)
    .all<StockRow>();
  const rows = results ?? [];

  const counts = await c.env.DB.prepare(
    `SELECT
       SUM(CASE WHEN stock <= 0 THEN 1 ELSE 0 END) AS out_of_stock,
       SUM(CASE WHEN stock > 0 AND stock <= 3 THEN 1 ELSE 0 END) AS low,
       SUM(CASE WHEN ebay_stock IS NOT NULL AND ebay_stock != stock THEN 1 ELSE 0 END) AS mismatched,
       SUM(stock) AS units,
       COUNT(*) AS total
     FROM products WHERE status != 'archived'`,
  ).first<{ out_of_stock: number; low: number; mismatched: number; units: number; total: number }>();

  const { results: channels } = await c.env.DB.prepare(
    `SELECT DISTINCT ebay_account FROM products WHERE ebay_account IS NOT NULL ORDER BY ebay_account`,
  ).all<{ ebay_account: string }>();

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
            {counts?.units ?? 0} units across {counts?.total ?? 0} products. The website sells from
            this figure.
          </p>
        </div>
        <div class="actions">
          <a class="btn btn-secondary btn-sm" href="/admin/products">
            Edit products →
          </a>
        </div>
      </div>

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
          <div class="stat-label">Differs from eBay</div>
          <div class="stat-value">{counts?.mismatched ?? 0}</div>
        </div>
      </div>

      <div class="chip-row">
        {tab('attention', 'Needs attention')}
        {tab('all', 'Everything', counts?.total)}
        {tab('out', 'Out of stock', counts?.out_of_stock)}
        {tab('low', 'Low', counts?.low)}
        {tab('mismatch', 'Differs from eBay', counts?.mismatched)}
      </div>

      {(channels ?? []).length > 1 ? (
        <div class="chip-row">
          <span class="chip-label">Channel</span>
          <a class="chip" aria-current={channel ? undefined : 'page'} href={`/admin/stock?view=${view}`}>
            All
          </a>
          {(channels ?? []).map((ch) => (
            <a
              class="chip"
              aria-current={channel === ch.ebay_account ? 'page' : undefined}
              href={`/admin/stock?view=${view}&channel=${encodeURIComponent(ch.ebay_account)}`}
            >
              {ch.ebay_account}
            </a>
          ))}
        </div>
      ) : null}

      <form method="post" action="/admin/stock" id="stock-form">
        <CsrfField token={admin.csrf} />
        <input type="hidden" name="view" value={view} />
        <input type="hidden" name="channel" value={channel} />
        <div class="admin-table-wrap">
          <table class="admin-table table-stock">
            <thead>
              <tr>
                <th>Product</th>
                <th class="col-optional">Channel</th>
                <th class="num">On eBay</th>
                <th class="num">Website</th>
                <th class="col-optional">Locked</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => {
                const mismatch = p.ebay_stock !== null && p.ebay_stock !== p.stock;
                return (
                  <tr>
                    <td>
                      <a href={`/admin/products/${p.id}`}>{p.title}</a>
                      <div class="faint small">
                        {p.sku ?? '—'}
                        {p.category_name ? ` · ${p.category_name}` : ''}
                      </div>
                    </td>
                    <td class="faint col-optional">{p.ebay_account ?? 'website only'}</td>
                    <td class={`num ${mismatch ? 'stock-mismatch' : 'faint'}`}>
                      {p.ebay_stock === null ? '—' : p.ebay_stock}
                    </td>
                    <td class="num">
                      <input
                        type="number"
                        name={`stock_${p.id}`}
                        value={p.stock}
                        min="0"
                        step="1"
                        aria-label={`Website stock for ${p.title}`}
                      />
                    </td>
                    <td class="col-optional">
                      {p.stock_locked === 1 ? (
                        <span class="pill pill-warn" title="The eBay sync will not change this figure">
                          locked
                        </span>
                      ) : (
                        <span class="faint small">follows eBay</span>
                      )}
                    </td>
                  </tr>
                );
              })}
              {!rows.length ? (
                <tr>
                  <td colSpan={5} class="center muted" style="padding:32px;">
                    Nothing here — that's good news.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        <div class="row-between" style="margin-top:14px">
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

stock.post('/', async (c) => {
  const body = await c.req.parseBody();
  if (!verifyCsrf(c, typeof body._csrf === 'string' ? body._csrf : undefined)) {
    return c.redirect('/admin/stock?err=' + encodeURIComponent('Your session expired — please try again.'), 303);
  }

  const view = typeof body.view === 'string' ? body.view : 'attention';
  const channel = typeof body.channel === 'string' ? body.channel : '';
  const back = `/admin/stock?view=${encodeURIComponent(view)}${channel ? `&channel=${encodeURIComponent(channel)}` : ''}`;

  // Only write rows whose number actually changed, so saving a screen of
  // untouched stock costs nothing and never fights the sync.
  const updates: Array<{ id: number; stock: number }> = [];
  for (const [key, value] of Object.entries(body)) {
    if (!key.startsWith('stock_')) continue;
    const id = Number(key.slice('stock_'.length));
    if (!Number.isInteger(id) || id <= 0) continue;
    updates.push({ id, stock: clampInt(value, 0, 100000, 0) });
  }
  if (!updates.length) return c.redirect(`${back}&msg=${encodeURIComponent('Nothing to save.')}`, 303);

  const ids = updates.map((u) => u.id);
  const { results: current } = await c.env.DB.prepare(
    `SELECT id, stock FROM products WHERE id IN (${ids.map(() => '?').join(',')})`,
  )
    .bind(...ids)
    .all<{ id: number; stock: number }>();
  const currentById = new Map((current ?? []).map((r) => [r.id, r.stock]));

  const changed = updates.filter((u) => currentById.get(u.id) !== u.stock);
  if (!changed.length) {
    return c.redirect(`${back}&msg=${encodeURIComponent('No changes to save.')}`, 303);
  }

  await c.env.DB.batch(
    changed.map((u) =>
      c.env.DB.prepare("UPDATE products SET stock = ?, updated_at = datetime('now') WHERE id = ?").bind(
        u.stock,
        u.id,
      ),
    ),
  );

  return c.redirect(
    `${back}&msg=${encodeURIComponent(
      `Saved ${changed.length} stock change${changed.length === 1 ? '' : 's'}.`,
    )}`,
    303,
  );
});

import { Hono } from 'hono';
import type { AppBindings, Category, Coupon, Env, ProductStatus, ProductWithCategory } from '../../types';
import { getProductById, listCategories } from '../../lib/db';
import { getAdmin, verifyCsrf } from '../../lib/admin-auth';
import { AdminLayout, CsrfField } from '../../ui/admin-layout';
import { formatPence, penceToInput } from '../../lib/money';
import { clampInt, parseJsonArray, poundsToPence, uniqueSlug } from '../../lib/util';
import { randomToken } from '../../lib/crypto';
import { basketCouponCode, couponQrUrl, formatCouponCode, productCouponCode, renderQrSvg } from '../../lib/qr';
import { getSetting } from '../../lib/settings';
import {
  canStore,
  deleteProductImages,
  deleteStoredImage,
  formatBytes,
  getMediaUsage,
  recordUpload,
} from '../../lib/media';

/** Product catalogue: list, editor, image upload, CSV import/export.
 * Categories live in ./categories.tsx and the R2 media route in ./media.tsx —
 * split out so each file exports exactly one Hono app, per CLAUDE.md. */
export const products = new Hono<AppBindings>();

const PER_PAGE = 30;

function flashOf(c: { req: { query: (k: string) => string | undefined } }) {
  return { msg: c.req.query('msg') ?? null, err: c.req.query('err') ?? null };
}

function redirectWith(base: string, params: Record<string, string | undefined>): string {
  const url = new URL(base, 'https://internal.local');
  for (const [k, v] of Object.entries(params)) if (v) url.searchParams.set(k, v);
  return url.pathname + url.search;
}

/* ---------------------------------------------------------------------- */
/* Listing                                                                 */
/* ---------------------------------------------------------------------- */

interface AdminProductQuery {
  q?: string;
  categoryId?: number;
  status?: string;
  source?: string;
  lowStock?: boolean;
  sort?: string;
  page: number;
}

async function queryAdminProducts(
  env: Env,
  q: AdminProductQuery,
): Promise<{ items: ProductWithCategory[]; total: number }> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.status) {
    where.push('p.status = ?');
    params.push(q.status);
  }
  if (q.categoryId) {
    where.push('p.category_id = ?');
    params.push(q.categoryId);
  }
  if (q.source) {
    where.push('p.source = ?');
    params.push(q.source);
  }
  if (q.lowStock) where.push('p.stock <= 3');
  if (q.q && q.q.trim()) {
    const term = `%${q.q.trim().toLowerCase()}%`;
    where.push('(lower(p.title) LIKE ? OR lower(p.sku) LIKE ? OR lower(p.brand) LIKE ?)');
    params.push(term, term, term);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const orderSql =
    {
      newest: 'p.created_at DESC, p.id DESC',
      title: 'p.title ASC',
      price_asc: 'p.price_pence ASC',
      price_desc: 'p.price_pence DESC',
      stock_asc: 'p.stock ASC, p.title ASC',
      stock_desc: 'p.stock DESC, p.title ASC',
    }[q.sort ?? 'newest'] ?? 'p.created_at DESC, p.id DESC';

  const offset = (Math.max(q.page, 1) - 1) * PER_PAGE;
  const countRow = await env.DB.prepare(`SELECT COUNT(*) AS n FROM products p ${whereSql}`)
    .bind(...params)
    .first<{ n: number }>();
  const { results } = await env.DB.prepare(
    `SELECT p.*, c.name AS category_name, c.slug AS category_slug
     FROM products p LEFT JOIN categories c ON c.id = p.category_id
     ${whereSql} ORDER BY ${orderSql} LIMIT ? OFFSET ?`,
  )
    .bind(...params, PER_PAGE, offset)
    .all<ProductWithCategory>();
  return { items: results ?? [], total: countRow?.n ?? 0 };
}

function statusPill(status: ProductStatus) {
  const cls = status === 'active' ? 'pill-ok' : status === 'draft' ? 'pill-warn' : 'pill-bad';
  return <span class={`pill ${cls}`}>{status}</span>;
}

products.get('/', async (c) => {
  const admin = getAdmin(c);
  const query = c.req.query();
  const page = clampInt(query.page, 1, 100000, 1);
  const q: AdminProductQuery = {
    q: query.q,
    categoryId: query.category ? Number(query.category) : undefined,
    status: query.status,
    source: query.source,
    lowStock: query.lowStock === '1',
    sort: query.sort,
    page,
  };
  const [{ items, total }, cats] = await Promise.all([queryAdminProducts(c.env, q), listCategories(c.env)]);
  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));
  const flash = flashOf(c);
  const backUrl = c.req.path + (new URL(c.req.url).search || '');

  const qs = (overrides: Record<string, string | number | undefined>) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...query, ...overrides })) {
      if (v !== undefined && v !== '' && k !== 'page') params.set(k, String(v));
    }
    return params.toString();
  };

  return c.html(
    <AdminLayout title="Products" active="products" admin={admin} msg={flash.msg} err={flash.err}>
      <div class="admin-head">
        <div>
          <h1>Products</h1>
          <p class="muted">{total} product{total === 1 ? '' : 's'} in the catalogue.</p>
        </div>
        <div class="actions">
          <a class="btn btn-secondary" href="/admin/categories">
            Categories
          </a>
          <a class="btn btn-secondary" href="/admin/products/import">
            Import CSV
          </a>
          <a class="btn btn-secondary" href="/admin/products/export.csv">
            Export CSV
          </a>
          <a class="btn" href="/admin/products/new">
            + New product
          </a>
        </div>
      </div>

      {/* Collapsed by default: the stock table is what the owner opens this
          page for, and an expanded filter form pushed it off a phone screen.
          Opens automatically when a filter is actually in use. */}
      <details class="filter-details" open={Boolean(query.q || query.category || query.status || query.source || query.lowStock)}>
        <summary>Search &amp; filter</summary>
      <form method="get" action="/admin/products" class="filter-bar">
        <div class="field field-wide">
          <label for="q">Search</label>
          <input id="q" type="search" name="q" value={query.q ?? ''} placeholder="Title, SKU or brand…" />
        </div>
        <div class="field">
          <label for="category">Category</label>
          <select id="category" name="category">
            <option value="">All</option>
            {cats.map((cat: Category) => (
              <option value={cat.id} selected={String(cat.id) === query.category}>
                {cat.name}
              </option>
            ))}
          </select>
        </div>
        <div class="field">
          <label for="status">Status</label>
          <select id="status" name="status">
            <option value="">All</option>
            {(['active', 'draft', 'archived'] as const).map((s) => (
              <option value={s} selected={query.status === s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <div class="field">
          <label for="source">Source</label>
          <select id="source" name="source">
            <option value="">All</option>
            {(['manual', 'ebay', 'csv'] as const).map((s) => (
              <option value={s} selected={query.source === s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <div class="field">
          <label for="sort">Sort</label>
          <select id="sort" name="sort">
            {[
              ['newest', 'Newest'],
              ['title', 'Title'],
              ['price_asc', 'Price ↑'],
              ['price_desc', 'Price ↓'],
              ['stock_asc', 'Stock ↑'],
              ['stock_desc', 'Stock ↓'],
            ].map(([val, label]) => (
              <option value={val} selected={(query.sort ?? 'newest') === val}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div class="checkbox-row field">
          <input id="lowStock" type="checkbox" name="lowStock" value="1" checked={query.lowStock === '1'} />
          <label for="lowStock">Low stock only</label>
        </div>
        <button class="btn btn-secondary" type="submit">
          Filter
        </button>
      </form>
      </details>

      <form id="bulk-stock-form" method="post" action="/admin/products/bulk-stock">
        <CsrfField token={admin.csrf} />
        <input type="hidden" name="back" value={backUrl} />
      </form>

      <div class="admin-table-wrap">
        <table class="admin-table table-products">
          <thead>
            <tr>
              <th></th>
              <th>Title</th>
              <th class="col-optional">SKU</th>
              <th class="col-optional">Category</th>
              <th class="num">Price</th>
              <th class="num">Stock</th>
              <th>Status</th>
              <th class="col-optional">Source</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {items.map((p) => (
              <tr>
                <td>
                  {p.image_url ? <img class="thumb" src={p.image_url} alt="" /> : <span class="faint">—</span>}
                </td>
                <td>
                  <a href={`/admin/products/${p.id}`}>{p.title}</a>
                </td>
                <td class="faint col-optional">{p.sku ?? '—'}</td>
                <td class="faint col-optional">{p.category_name ?? '—'}</td>
                <td class="num">{formatPence(p.price_pence)}</td>
                <td class="num">
                  <input
                    type="number"
                    name={`stock_${p.id}`}
                    value={p.stock}
                    min="0"
                    step="1"
                    form="bulk-stock-form"
                    disabled={p.stock_locked === 1 && p.source === 'ebay'}
                    aria-label={`Stock for ${p.title}`}
                    title={
                      p.stock_locked === 1 && p.source === 'ebay'
                        ? 'Stock is locked for this product — unlock it in the product editor to edit here.'
                        : undefined
                    }
                  />
                </td>
                <td>{statusPill(p.status)}</td>
                <td class="col-optional">
                  <span class={`badge-source ${p.source}`}>{p.source}</span>
                </td>
                <td class="row-actions">
                  <a class="btn btn-sm btn-secondary" href={`/admin/products/${p.id}`}>
                    Edit
                  </a>
                  <form method="post" action={`/admin/products/${p.id}/duplicate`}>
                    <CsrfField token={admin.csrf} />
                    <input type="hidden" name="back" value={backUrl} />
                    <button class="btn btn-sm btn-secondary" type="submit">
                      Duplicate
                    </button>
                  </form>
                  <form method="post" action={`/admin/products/${p.id}/archive`}>
                    <CsrfField token={admin.csrf} />
                    <input type="hidden" name="back" value={backUrl} />
                    <input type="hidden" name="to" value={p.status === 'archived' ? 'active' : 'archived'} />
                    <button class="btn btn-sm btn-secondary" type="submit">
                      {p.status === 'archived' ? 'Restore' : 'Archive'}
                    </button>
                  </form>
                  <a class="btn btn-sm btn-danger" href={`/admin/products/${p.id}/delete?back=${encodeURIComponent(backUrl)}`}>
                    Delete
                  </a>
                </td>
              </tr>
            ))}
            {!items.length ? (
              <tr>
                <td colSpan={9} class="center muted" style="padding:32px;">
                  No products match these filters.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <div class="row-between" style="margin-top:14px;">
        <button type="submit" form="bulk-stock-form" class="btn">
          Save all changes
        </button>
        <nav class="pagination" aria-label="Pagination">
          {page > 1 ? <a href={`/admin/products?${qs({ page: page - 1 })}`}>← Prev</a> : null}
          <span aria-current="page">
            Page {page} of {totalPages}
          </span>
          {page < totalPages ? <a href={`/admin/products?${qs({ page: page + 1 })}`}>Next →</a> : null}
        </nav>
      </div>
    </AdminLayout>,
  );
});

products.post('/bulk-stock', async (c) => {
  const body = await c.req.parseBody();
  const back = typeof body.back === 'string' && body.back ? body.back : '/admin/products';
  if (!verifyCsrf(c, typeof body._csrf === 'string' ? body._csrf : undefined)) {
    return c.redirect(redirectWith(back, { err: 'Your session expired — please try again.' }), 303);
  }
  let count = 0;
  for (const [key, value] of Object.entries(body)) {
    const m = /^stock_(\d+)$/.exec(key);
    if (!m || typeof value !== 'string') continue;
    const n = parseInt(value, 10);
    if (!Number.isFinite(n)) continue;
    const stock = Math.max(0, Math.trunc(n));
    const res = await c.env.DB.prepare(
      "UPDATE products SET stock = ?, updated_at = datetime('now') WHERE id = ? AND stock != ? AND stock_locked = 0",
    )
      .bind(stock, Number(m[1]), stock)
      .run();
    count += res.meta.changes ?? 0;
  }
  return c.redirect(redirectWith(back, { msg: `Updated stock for ${count} product${count === 1 ? '' : 's'}.` }), 303);
});

/* ---------------------------------------------------------------------- */
/* Editor                                                                  */
/* ---------------------------------------------------------------------- */

interface ProductFormValues {
  title: string;
  description: string;
  category_id: string;
  brand: string;
  sku: string;
  price: string;
  compare_at: string;
  cost: string;
  stock: string;
  status: ProductStatus;
  featured: boolean;
  image_url: string;
  extra_images: string;
  price_locked: boolean;
  stock_locked: boolean;
  content_locked: boolean;
}

function blankForm(): ProductFormValues {
  return {
    title: '',
    description: '',
    category_id: '',
    brand: '',
    sku: '',
    price: '',
    compare_at: '',
    cost: '',
    stock: '0',
    status: 'active',
    featured: false,
    image_url: '',
    extra_images: '',
    price_locked: false,
    stock_locked: false,
    content_locked: false,
  };
}

function formFromProduct(p: ProductWithCategory): ProductFormValues {
  return {
    title: p.title,
    description: p.description ?? '',
    category_id: p.category_id ? String(p.category_id) : '',
    brand: p.brand ?? '',
    sku: p.sku ?? '',
    price: penceToInput(p.price_pence),
    compare_at: p.compare_at_pence ? penceToInput(p.compare_at_pence) : '',
    cost: p.cost_pence ? penceToInput(p.cost_pence) : '',
    stock: String(p.stock),
    status: p.status,
    featured: p.featured === 1,
    image_url: p.image_url ?? '',
    extra_images: parseJsonArray(p.images_json).join('\n'),
    price_locked: p.price_locked === 1,
    stock_locked: p.stock_locked === 1,
    content_locked: p.content_locked === 1,
  };
}

function ProductEditor(props: {
  admin: { csrf: string };
  cats: Category[];
  values: ProductFormValues;
  product: ProductWithCategory | null;
  action: string;
  heading: string;
}) {
  const { values, product } = props;
  return (
    <>
      <div class="admin-head">
        <h1>{props.heading}</h1>
        <div class="actions">
          <a class="btn btn-secondary" href="/admin/products">
            ← Back to products
          </a>
        </div>
      </div>

      {product && product.source === 'ebay' ? (
        <div class="notice notice-warn admin-panel">
          Linked to eBay listing <strong>{product.ebay_item_id}</strong>
          {product.ebay_account ? ` on account "${product.ebay_account}"` : ''}.
          {product.ebay_url ? (
            <>
              {' '}
              <a href={product.ebay_url} target="_blank" rel="noreferrer">
                View on eBay ↗
              </a>
            </>
          ) : null}
          {product.ebay_synced_at ? <div class="faint">Last synced {product.ebay_synced_at}</div> : null}
        </div>
      ) : null}

      <form method="post" action={props.action} class="admin-panel stack" enctype="application/x-www-form-urlencoded">
        <CsrfField token={props.admin.csrf} />

        <div class="admin-grid cols-2">
          <div class="field">
            <label for="title">Title</label>
            <input id="title" name="title" type="text" required value={values.title} />
          </div>
          <div class="field">
            <label for="category_id">Category</label>
            <select id="category_id" name="category_id">
              <option value="">Uncategorised</option>
              {props.cats.map((cat) => (
                <option value={cat.id} selected={String(cat.id) === values.category_id}>
                  {cat.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div class="field">
          <label for="description">Description</label>
          <textarea id="description" name="description">
            {values.description}
          </textarea>
        </div>

        <div class="admin-grid cols-3">
          <div class="field">
            <label for="brand">Brand</label>
            <input id="brand" name="brand" type="text" value={values.brand} />
          </div>
          <div class="field">
            <label for="sku">SKU</label>
            <input id="sku" name="sku" type="text" value={values.sku} />
          </div>
          <div class="field">
            <label for="status">Status</label>
            <select id="status" name="status">
              {(['active', 'draft', 'archived'] as const).map((s) => (
                <option value={s} selected={values.status === s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div class="admin-grid cols-3">
          <div class="field">
            <label for="price">Price (£)</label>
            <input id="price" name="price" type="text" inputmode="decimal" required value={values.price} />
          </div>
          <div class="field">
            <label for="compare_at">Compare-at price (£)</label>
            <input id="compare_at" name="compare_at" type="text" inputmode="decimal" value={values.compare_at} />
          </div>
          <div class="field">
            <label for="cost">Cost price (£)</label>
            <input id="cost" name="cost" type="text" inputmode="decimal" value={values.cost} />
          </div>
        </div>

        <div class="admin-grid cols-2">
          <div class="field">
            <label for="stock">Stock</label>
            <input id="stock" name="stock" type="number" min="0" step="1" value={values.stock} />
          </div>
          <div class="checkbox-row field" style="align-self:end;">
            <input id="featured" type="checkbox" name="featured" value="1" checked={values.featured} />
            <label for="featured">Featured on the shop homepage</label>
          </div>
        </div>

        <div class="field">
          <label for="image_url">Main image URL</label>
          <input id="image_url" name="image_url" type="url" value={values.image_url} placeholder="https://…" />
          {values.image_url ? <img src={values.image_url} alt="" style="max-width:120px;margin-top:8px;border-radius:8px;" /> : null}
        </div>
        <div class="field">
          <label for="extra_images">Extra image URLs (one per line)</label>
          <textarea id="extra_images" name="extra_images">
            {values.extra_images}
          </textarea>
        </div>

        <fieldset>
          <legend>eBay sync locks</legend>
          <div class="admin-grid cols-3">
            <div>
              <div class="checkbox-row">
                <input id="price_locked" type="checkbox" name="price_locked" value="1" checked={values.price_locked} />
                <label for="price_locked">Lock price</label>
              </div>
              <p class="lock-hint">Stops the eBay sync overwriting this price.</p>
            </div>
            <div>
              <div class="checkbox-row">
                <input id="stock_locked" type="checkbox" name="stock_locked" value="1" checked={values.stock_locked} />
                <label for="stock_locked">Lock stock</label>
              </div>
              <p class="lock-hint">Stops the eBay sync overwriting the stock level.</p>
            </div>
            <div>
              <div class="checkbox-row">
                <input id="content_locked" type="checkbox" name="content_locked" value="1" checked={values.content_locked} />
                <label for="content_locked">Lock content</label>
              </div>
              <p class="lock-hint">Stops the sync overwriting title, description and images.</p>
            </div>
          </div>
        </fieldset>

        <div class="row">
          <button class="btn" type="submit">
            Save product
          </button>
        </div>
      </form>

      {product ? (
        <div class="admin-panel">
          <h3>Product photo</h3>
          <form method="post" action={`/admin/products/${product.id}/image`} enctype="multipart/form-data" class="row">
            <CsrfField token={props.admin.csrf} />
            <input type="file" name="file" accept="image/*" required />
            <button class="btn btn-secondary" type="submit">
              Upload image
            </button>
          </form>
          <p class="field-hint">JPEG, PNG, WebP or GIF, up to 5MB. Replaces the main image above.</p>
        </div>
      ) : null}
    </>
  );
}

products.get('/new', async (c) => {
  const admin = getAdmin(c);
  const cats = await listCategories(c.env);
  return c.html(
    <AdminLayout title="New product" active="products" admin={admin}>
      <ProductEditor admin={admin} cats={cats} values={blankForm()} product={null} action="/admin/products/new" heading="New product" />
    </AdminLayout>,
  );
});

function readProductForm(body: Record<string, unknown>): ProductFormValues {
  const str = (k: string) => (typeof body[k] === 'string' ? (body[k] as string) : '');
  return {
    title: str('title').trim(),
    description: str('description'),
    category_id: str('category_id'),
    brand: str('brand').trim(),
    sku: str('sku').trim(),
    price: str('price'),
    compare_at: str('compare_at'),
    cost: str('cost'),
    stock: str('stock'),
    status: (['active', 'draft', 'archived'].includes(str('status')) ? str('status') : 'active') as ProductStatus,
    featured: str('featured') === '1',
    image_url: str('image_url').trim(),
    extra_images: str('extra_images'),
    price_locked: str('price_locked') === '1',
    stock_locked: str('stock_locked') === '1',
    content_locked: str('content_locked') === '1',
  };
}

products.post('/new', async (c) => {
  const admin = getAdmin(c);
  const body = await c.req.parseBody();
  if (!verifyCsrf(c, typeof body._csrf === 'string' ? body._csrf : undefined)) {
    return c.redirect('/admin/products?err=' + encodeURIComponent('Your session expired — please try again.'), 303);
  }
  const values = readProductForm(body);
  const cats = await listCategories(c.env);
  const price = poundsToPence(values.price);

  if (!values.title || price === null) {
    return c.html(
      <AdminLayout title="New product" active="products" admin={admin} err="Enter a title and a valid price.">
        <ProductEditor admin={admin} cats={cats} values={values} product={null} action="/admin/products/new" heading="New product" />
      </AdminLayout>,
      400,
    );
  }

  const slug = await uniqueSlug(c.env.DB, 'products', values.title);
  const compareAt = poundsToPence(values.compare_at);
  const cost = poundsToPence(values.cost);
  const stock = clampInt(values.stock, 0, 999999, 0);
  const images = values.extra_images
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

  const result = await c.env.DB.prepare(
    `INSERT INTO products
      (slug, title, description, category_id, brand, sku, price_pence, compare_at_pence, cost_pence, stock,
       image_url, images_json, status, featured, source, price_locked, stock_locked, content_locked)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'manual', ?,?,?)`,
  )
    .bind(
      slug,
      values.title,
      values.description || null,
      values.category_id ? Number(values.category_id) : null,
      values.brand || null,
      values.sku || null,
      price,
      compareAt,
      cost,
      stock,
      values.image_url || null,
      JSON.stringify(images),
      values.status,
      values.featured ? 1 : 0,
      values.price_locked ? 1 : 0,
      values.stock_locked ? 1 : 0,
      values.content_locked ? 1 : 0,
    )
    .run();
  const id = result.meta.last_row_id as number;
  return c.redirect(`/admin/products/${id}?msg=${encodeURIComponent('Product created.')}`, 303);
});

products.get('/import', async (c) => {
  const admin = getAdmin(c);
  const flash = flashOf(c);
  return c.html(
    <AdminLayout title="Import products" active="products" admin={admin} msg={flash.msg} err={flash.err}>
      <div class="admin-head">
        <h1>Import products from CSV</h1>
        <a class="btn btn-secondary" href="/admin/products">
          ← Back to products
        </a>
      </div>
      <div class="admin-panel">
        <p class="muted">
          Columns: <code>title, price, stock, sku, category, image_url, description</code>. A row with a SKU that
          matches an existing product updates it; otherwise a new product is created. <code>title</code> and{' '}
          <code>price</code> are required.
        </p>
        <form method="post" action="/admin/products/import" enctype="multipart/form-data" class="stack">
          <CsrfField token={admin.csrf} />
          <div class="field">
            <label for="file">CSV file</label>
            <input id="file" type="file" name="file" accept=".csv,text/csv" />
          </div>
          <div class="field">
            <label for="csv">…or paste CSV</label>
            <textarea id="csv" name="csv" placeholder="title,price,stock,sku,category,image_url,description" rows={8} />
          </div>
          <button class="btn" type="submit">
            Import
          </button>
        </form>
      </div>
    </AdminLayout>,
  );
});

products.post('/import', async (c) => {
  const admin = getAdmin(c);
  const body = await c.req.parseBody();
  if (!verifyCsrf(c, typeof body._csrf === 'string' ? body._csrf : undefined)) {
    return c.redirect('/admin/products/import?err=' + encodeURIComponent('Your session expired — please try again.'), 303);
  }
  let text = '';
  if (body.file instanceof File && body.file.size > 0) text = await body.file.text();
  else if (typeof body.csv === 'string') text = body.csv;

  const { rows, error } = parseProductCsvRows(text);
  if (error || !rows.length) {
    return c.redirect(
      '/admin/products/import?err=' + encodeURIComponent(error ?? 'No rows found in that CSV.'),
      303,
    );
  }

  const cats = await listCategories(c.env);
  const catByName = new Map(cats.map((cat) => [cat.name.toLowerCase(), cat.id]));
  const catBySlug = new Map(cats.map((cat) => [cat.slug, cat.id]));

  let created = 0;
  let updated = 0;
  let skipped = 0;
  const rowErrors: string[] = [];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const lineNo = i + 2;
    const title = (r.title ?? '').trim();
    const price = poundsToPence(r.price);
    if (!title || price === null) {
      skipped++;
      rowErrors.push(`Row ${lineNo}: missing title or invalid price — skipped.`);
      continue;
    }
    const stockNum = Number(r.stock);
    const stock = Number.isFinite(stockNum) ? Math.max(0, Math.trunc(stockNum)) : 0;
    const sku = (r.sku ?? '').trim() || null;
    const imageUrl = (r.image_url ?? '').trim() || null;
    const description = (r.description ?? '').trim() || null;

    let categoryId: number | null = null;
    if (r.category) {
      const key = r.category.trim().toLowerCase();
      categoryId = catByName.get(key) ?? catBySlug.get(key) ?? null;
      if (categoryId === null) rowErrors.push(`Row ${lineNo}: category "${r.category}" not found — left uncategorised.`);
    }

    let existingId: number | null = null;
    if (sku) {
      const row = await c.env.DB.prepare('SELECT id FROM products WHERE sku = ?').bind(sku).first<{ id: number }>();
      existingId = row?.id ?? null;
    }
    if (existingId === null) {
      const row = await c.env.DB.prepare('SELECT id FROM products WHERE lower(title) = lower(?)')
        .bind(title)
        .first<{ id: number }>();
      existingId = row?.id ?? null;
    }

    if (existingId !== null) {
      await c.env.DB.prepare(
        `UPDATE products SET
           price_pence = CASE WHEN price_locked = 1 THEN price_pence ELSE ? END,
           stock = CASE WHEN stock_locked = 1 THEN stock ELSE ? END,
           category_id = COALESCE(?, category_id),
           image_url = COALESCE(?, image_url),
           description = CASE WHEN content_locked = 1 THEN description ELSE COALESCE(?, description) END,
           sku = COALESCE(sku, ?),
           updated_at = datetime('now')
         WHERE id = ?`,
      )
        .bind(price, stock, categoryId, imageUrl, description, sku, existingId)
        .run();
      updated++;
    } else {
      const slug = await uniqueSlug(c.env.DB, 'products', title);
      await c.env.DB.prepare(
        `INSERT INTO products (slug, title, description, category_id, sku, price_pence, stock, image_url, status, source)
         VALUES (?,?,?,?,?,?,?,?, 'active', 'csv')`,
      )
        .bind(slug, title, description, categoryId, sku, price, stock, imageUrl)
        .run();
      created++;
    }
  }

  return c.html(
    <AdminLayout title="Import results" active="products" admin={admin}>
      <div class="admin-head">
        <h1>Import results</h1>
        <a class="btn btn-secondary" href="/admin/products">
          ← Back to products
        </a>
      </div>
      <div class="admin-panel">
        <p>
          <strong>{created}</strong> created, <strong>{updated}</strong> updated, <strong>{skipped}</strong> skipped
          out of {rows.length} row{rows.length === 1 ? '' : 's'}.
        </p>
        {rowErrors.length ? (
          <>
            <h3>Row notes</h3>
            <ul>
              {rowErrors.map((e) => (
                <li>{e}</li>
              ))}
            </ul>
          </>
        ) : (
          <p class="muted">No row-level issues.</p>
        )}
      </div>
    </AdminLayout>,
  );
});

products.get('/export.csv', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT p.*, c.name AS category_name, c.slug AS category_slug
     FROM products p LEFT JOIN categories c ON c.id = p.category_id
     ORDER BY p.title ASC`,
  ).all<ProductWithCategory>();
  const csv = productsToCsv(results ?? []);
  return new Response(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="27beauty-products.csv"',
    },
  });
});

products.get('/:id', async (c) => {
  const admin = getAdmin(c);
  const id = Number(c.req.param('id'));
  const product = await getProductById(c.env, id);
  if (!product) return c.text('Not found', 404);
  const cats = await listCategories(c.env);
  const flash = flashOf(c);
  const [{ results: itemCoupons }, defaultPercent] = await Promise.all([
    c.env.DB.prepare('SELECT * FROM coupons WHERE product_id = ? ORDER BY id DESC')
      .bind(product.id)
      .all<Coupon>(),
    getSetting<number>(c.env, 'coupon.default_percent', 10),
  ]);
  return c.html(
    <AdminLayout title={product.title} active="products" admin={admin} msg={flash.msg} err={flash.err}>
      <ProductEditor
        admin={admin}
        cats={cats}
        values={formFromProduct(product)}
        product={product}
        action={`/admin/products/${product.id}`}
        heading={`Edit — ${product.title}`}
      />
      <ProductQrPanel
        admin={admin}
        product={product}
        coupons={itemCoupons ?? []}
        defaultPercent={defaultPercent}
        siteUrl={c.env.SITE_URL}
      />
    </AdminLayout>,
  );
});


/* ---------------------------------------------------------------------- */
/* Per-item QR discounts                                                   */
/* ---------------------------------------------------------------------- */

/**
 * "Make a QR code for this item." The owner picks a percentage, presses one
 * button, and gets a printable card whose discount applies to this product
 * only — no random codes to keep track of.
 */
function ProductQrPanel(props: {
  admin: { csrf: string };
  product: ProductWithCategory;
  coupons: Coupon[];
  defaultPercent: number;
  siteUrl: string;
}) {
  const { product, coupons } = props;
  return (
    <section class="admin-panel" id="qr">
      <h2>QR discount for this item</h2>
      <p class="muted">
        Creates a discount code and a QR card you can print and drop into parcels. The discount comes
        off <strong>the customer's whole basket</strong> — scanning the card takes them to{' '}
        <strong>{product.title}</strong> with the discount already applied, and it keeps working on
        everything else they add.
      </p>

      <form method="post" action={`/admin/products/${product.id}/qr`} class="qr-create-form">
        <CsrfField token={props.admin.csrf} />
        <div class="field">
          <label for="percent">Discount</label>
          <div class="input-suffix">
            <input
              id="percent"
              name="percent"
              type="number"
              min="1"
              max="90"
              step="1"
              value={String(props.defaultPercent)}
              required
            />
            <span>% off</span>
          </div>
        </div>
        <div class="field">
          <label for="qr_expires">Expires (optional)</label>
          <input id="qr_expires" name="expires_at" type="date" />
          <p class="field-hint">Leave blank for a code that never expires.</p>
        </div>
        <div class="field">
          <label class="check">
            <input type="checkbox" name="single_use" value="1" />
            <span>Single use — the card works once, then stops</span>
          </label>
        </div>
        <div class="field">
          <label class="check">
            <input type="checkbox" name="product_only" value="1" />
            <span>Restrict to this item only (otherwise it discounts everything)</span>
          </label>
        </div>
        <button class="btn btn-accent" type="submit">
          Create QR code
        </button>
      </form>

      {coupons.length ? (
        <div class="qr-existing">
          <h3>Codes for this item</h3>
          <div class="qr-card-list">
            {coupons.map((coupon) => (
              <div class="qr-card-mini">
                <div
                  class="qr-card-mini-img"
                  dangerouslySetInnerHTML={{
                    __html: renderQrSvg(couponQrUrl({ SITE_URL: props.siteUrl }, coupon.code), 150),
                  }}
                />
                <div class="qr-card-mini-body">
                  <strong>{formatCouponCode(coupon.code)}</strong>
                  <p class="small muted">
                    {coupon.kind === 'percent'
                      ? `${coupon.value}% off`
                      : `${formatPence(coupon.value)} off`}
                    {coupon.product_only === 1 ? ' this item only' : ' everything'}
                    {coupon.max_redemptions === 1 ? ' · single use' : ''}
                    {coupon.expires_at ? ` · until ${coupon.expires_at.slice(0, 10)}` : ''}
                    {' · used '}
                    {coupon.times_used}
                    {coupon.max_redemptions ? `/${coupon.max_redemptions}` : ''}
                    {coupon.active ? '' : ' · inactive'}
                  </p>
                  <div class="row">
                    <a class="btn btn-sm btn-secondary" href={`/admin/coupons/print?batch=item-${product.id}`}>
                      Print cards
                    </a>
                    <a class="btn btn-sm btn-secondary" href={`/admin/coupons/poster?code=${coupon.code}`}>
                      Poster
                    </a>
                    <a class="btn btn-sm btn-secondary" href={`/admin/coupons/${coupon.id}`}>
                      Edit
                    </a>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

/** Creates a product-scoped coupon and sends the owner straight to its card. */
products.post('/:id/qr', async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.parseBody();
  if (!verifyCsrf(c, typeof body._csrf === 'string' ? body._csrf : undefined)) {
    return c.redirect('/admin/login', 303);
  }

  const product = await getProductById(c.env, id);
  if (!product) return c.text('Not found', 404);

  const percent = clampInt(body.percent, 1, 90, 10);
  const expiresAt = typeof body.expires_at === 'string' && body.expires_at.trim() ? body.expires_at.trim() : null;
  const singleUse = body.single_use === '1';
  const productOnly = body.product_only === '1';

  // A whole-basket card gets a neutral code, because "10OFFYORKSHIRETEA" on a
  // card that actually discounts everything reads like a restriction. A code
  // that really is restricted to one item says so in its name.
  const makeCode = (attempt: number) =>
    productOnly ? productCouponCode(percent, product.title, attempt) : basketCouponCode(percent, attempt);

  let code = makeCode(0);
  for (let attempt = 0; attempt < 20; attempt++) {
    const clash = await c.env.DB.prepare('SELECT id, product_id FROM coupons WHERE code = ?')
      .bind(code)
      .first<{ id: number; product_id: number | null }>();
    if (!clash) break;
    if (productOnly && clash.product_id === product.id) {
      return c.redirect(
        `/admin/coupons/${clash.id}?msg=` +
          encodeURIComponent(`That code already exists for ${product.title}.`),
        303,
      );
    }
    code = makeCode(attempt + 1);
  }

  const res = await c.env.DB.prepare(
    `INSERT INTO coupons (code, kind, value, description, product_id, product_only, max_redemptions, expires_at, batch, active)
     VALUES (?, 'percent', ?, ?, ?, ?, ?, ?, ?, 1)`,
  )
    .bind(
      code,
      percent,
      productOnly
        ? `${percent}% off ${product.title}`
        : `${percent}% off everything — card printed for ${product.title}`,
      product.id,
      productOnly ? 1 : 0,
      singleUse ? 1 : null,
      expiresAt,
      `item-${product.id}`,
    )
    .run();

  const couponId = Number(res.meta.last_row_id);
  return c.redirect(
    `/admin/coupons/${couponId}?msg=` +
      encodeURIComponent(`QR code ${formatCouponCode(code)} created for ${product.title}.`),
    303,
  );
});

products.post('/:id', async (c) => {
  const admin = getAdmin(c);
  const id = Number(c.req.param('id'));
  const existing = await getProductById(c.env, id);
  if (!existing) return c.text('Not found', 404);

  const body = await c.req.parseBody();
  if (!verifyCsrf(c, typeof body._csrf === 'string' ? body._csrf : undefined)) {
    return c.redirect(`/admin/products/${id}?err=` + encodeURIComponent('Your session expired — please try again.'), 303);
  }
  const values = readProductForm(body);
  const price = poundsToPence(values.price);
  const cats = await listCategories(c.env);

  if (!values.title || price === null) {
    return c.html(
      <AdminLayout title="Edit product" active="products" admin={admin} err="Enter a title and a valid price.">
        <ProductEditor admin={admin} cats={cats} values={values} product={existing} action={`/admin/products/${id}`} heading="Edit product" />
      </AdminLayout>,
      400,
    );
  }

  const compareAt = poundsToPence(values.compare_at);
  const cost = poundsToPence(values.cost);
  const stock = clampInt(values.stock, 0, 999999, 0);
  const images = values.extra_images
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

  await c.env.DB.prepare(
    `UPDATE products SET
       title = ?, description = ?, category_id = ?, brand = ?, sku = ?, price_pence = ?, compare_at_pence = ?,
       cost_pence = ?, stock = ?, image_url = ?, images_json = ?, status = ?, featured = ?,
       price_locked = ?, stock_locked = ?, content_locked = ?, updated_at = datetime('now')
     WHERE id = ?`,
  )
    .bind(
      values.title,
      values.description || null,
      values.category_id ? Number(values.category_id) : null,
      values.brand || null,
      values.sku || null,
      price,
      compareAt,
      cost,
      stock,
      values.image_url || null,
      JSON.stringify(images),
      values.status,
      values.featured ? 1 : 0,
      values.price_locked ? 1 : 0,
      values.stock_locked ? 1 : 0,
      values.content_locked ? 1 : 0,
      id,
    )
    .run();

  return c.redirect(`/admin/products/${id}?msg=${encodeURIComponent('Saved.')}`, 303);
});

products.post('/:id/duplicate', async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.parseBody();
  const back = typeof body.back === 'string' && body.back ? body.back : '/admin/products';
  if (!verifyCsrf(c, typeof body._csrf === 'string' ? body._csrf : undefined)) {
    return c.redirect(redirectWith(back, { err: 'Your session expired — please try again.' }), 303);
  }
  const p = await getProductById(c.env, id);
  if (!p) return c.redirect(redirectWith(back, { err: 'Product not found.' }), 303);

  const title = `${p.title} (copy)`;
  const slug = await uniqueSlug(c.env.DB, 'products', title);
  const result = await c.env.DB.prepare(
    `INSERT INTO products
      (slug, title, description, category_id, brand, sku, price_pence, compare_at_pence, cost_pence, stock,
       image_url, images_json, status, featured, source, price_locked, stock_locked, content_locked)
     VALUES (?,?,?,?,?,?,?,?,?,0,?,?, 'draft', 0, 'manual', ?,?,?)`,
  )
    .bind(
      slug,
      title,
      p.description,
      p.category_id,
      p.brand,
      null,
      p.price_pence,
      p.compare_at_pence,
      p.cost_pence,
      p.image_url,
      p.images_json,
      p.price_locked,
      p.stock_locked,
      p.content_locked,
    )
    .run();
  const newId = result.meta.last_row_id as number;
  return c.redirect(`/admin/products/${newId}?msg=${encodeURIComponent('Duplicated as a draft with 0 stock.')}`, 303);
});

products.post('/:id/archive', async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.parseBody();
  const back = typeof body.back === 'string' && body.back ? body.back : '/admin/products';
  if (!verifyCsrf(c, typeof body._csrf === 'string' ? body._csrf : undefined)) {
    return c.redirect(redirectWith(back, { err: 'Your session expired — please try again.' }), 303);
  }
  const to = body.to === 'active' ? 'active' : 'archived';
  await c.env.DB.prepare("UPDATE products SET status = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(to, id)
    .run();
  return c.redirect(redirectWith(back, { msg: to === 'archived' ? 'Product archived.' : 'Product restored.' }), 303);
});

products.get('/:id/delete', async (c) => {
  const admin = getAdmin(c);
  const id = Number(c.req.param('id'));
  const product = await getProductById(c.env, id);
  if (!product) return c.text('Not found', 404);
  const back = c.req.query('back') ?? '/admin/products';
  return c.html(
    <AdminLayout title="Delete product" active="products" admin={admin}>
      <div class="admin-panel" style="max-width:520px;">
        <h1>Delete "{product.title}"?</h1>
        <p class="muted">
          This permanently removes the product from the catalogue. Past orders keep their own copy of the line
          item, so order history is unaffected. This cannot be undone.
        </p>
        <div class="row">
          <form method="post" action={`/admin/products/${id}/delete`}>
            <CsrfField token={admin.csrf} />
            <input type="hidden" name="back" value={back} />
            <button class="btn btn-danger" type="submit">
              Delete permanently
            </button>
          </form>
          <a class="btn btn-secondary" href={back}>
            Cancel
          </a>
        </div>
      </div>
    </AdminLayout>,
  );
});

products.post('/:id/delete', async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.parseBody();
  const back = typeof body.back === 'string' && body.back ? body.back : '/admin/products';
  if (!verifyCsrf(c, typeof body._csrf === 'string' ? body._csrf : undefined)) {
    return c.redirect(redirectWith(back, { err: 'Your session expired — please try again.' }), 303);
  }
  // Reclaim the product's stored photos too, or deleted products would keep
  // paying rent in R2 forever.
  const removed = await deleteProductImages(c.env, id);
  await c.env.DB.prepare('DELETE FROM products WHERE id = ?').bind(id).run();
  return c.redirect(
    redirectWith('/admin/products', {
      msg: removed
        ? `Product deleted, along with ${removed} stored image${removed === 1 ? '' : 's'}.`
        : 'Product deleted.',
    }),
    303,
  );
});

const IMAGE_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
};
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

products.post('/:id/image', async (c) => {
  const id = Number(c.req.param('id'));
  const product = await getProductById(c.env, id);
  if (!product) return c.text('Not found', 404);
  const body = await c.req.parseBody();
  if (!verifyCsrf(c, typeof body._csrf === 'string' ? body._csrf : undefined)) {
    return c.redirect(`/admin/products/${id}?err=` + encodeURIComponent('Your session expired — please try again.'), 303);
  }
  const file = body.file;
  if (!(file instanceof File) || file.size === 0) {
    return c.redirect(`/admin/products/${id}?err=` + encodeURIComponent('Choose an image file.'), 303);
  }
  if (!file.type.startsWith('image/')) {
    return c.redirect(`/admin/products/${id}?err=` + encodeURIComponent('Only image files are allowed.'), 303);
  }
  if (!c.env.MEDIA) {
    return c.redirect(
      `/admin/products/${id}?err=` +
        encodeURIComponent(
          'Image uploads need R2 storage. Turn R2 on in the Cloudflare dashboard, then redeploy. In the meantime you can paste an image URL into the Main image URL field.',
        ),
      303,
    );
  }

  // Refuse anything that would push stored bytes past the self-imposed budget.
  // Cloudflare has no hard spend cap on R2, so this is the cap.
  const decision = await canStore(c.env, file.size);
  if (!decision.ok) {
    return c.redirect(`/admin/products/${id}?err=` + encodeURIComponent(decision.reason ?? 'Upload refused.'), 303);
  }

  const ext = IMAGE_EXT[file.type] ?? 'jpg';
  const key = `products/${id}/${randomToken(8)}.${ext}`;

  // What this photo replaces, so the old object does not linger and eat the
  // budget — re-uploading ten times used to leave ten copies behind.
  const previous = await c.env.DB.prepare('SELECT image_url FROM products WHERE id = ?')
    .bind(id)
    .first<{ image_url: string | null }>();

  await c.env.MEDIA.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: file.type } });
  await recordUpload(c.env, file.size);

  // Stored under the public /media/ route (src/index.tsx), not /admin/media —
  // robots.txt disallows /admin, and product photos need to be crawlable.
  await c.env.DB.prepare("UPDATE products SET image_url = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(`/media/${key}`, id)
    .run();

  await deleteStoredImage(c.env, previous?.image_url);

  const after = await getMediaUsage(c.env);
  return c.redirect(
    `/admin/products/${id}?msg=${encodeURIComponent(
      `Image uploaded. Storage used: ${formatBytes(after.bytesUsed)} of ${formatBytes(after.budgetBytes)}.`,
    )}`,
    303,
  );
});

/* ---------------------------------------------------------------------- */
/* CSV — pure functions (covered by test/admin.test.ts)                   */
/* ---------------------------------------------------------------------- */

/** Minimal RFC4180-ish CSV parser: quoted fields, "" escapes, CRLF or LF. */
export function parseCsv(input: string): string[][] {
  const text = input.trim();
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let sawAny = false;

  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      sawAny = true;
    } else if (ch === ',') {
      pushField();
      sawAny = true;
    } else if (ch === '\n') {
      pushRow();
      sawAny = true;
    } else if (ch === '\r') {
      // ignore; a following \n (if any) ends the row
    } else {
      field += ch;
      sawAny = true;
    }
  }
  if (field.length > 0 || row.length > 0) pushRow();
  if (!sawAny) return [];
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

function csvField(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export function toCsvRow(values: Array<string | number | null | undefined>): string {
  return values.map((v) => csvField(String(v ?? ''))).join(',');
}

export interface ProductCsvParseResult {
  rows: Array<Record<string, string>>;
  error?: string;
}

/** Parses a products CSV into header-keyed row objects. Pure — no I/O. */
export function parseProductCsvRows(text: string): ProductCsvParseResult {
  const table = parseCsv(text.trim());
  if (!table.length) return { rows: [] };
  const header = table[0].map((h) => h.trim().toLowerCase());
  for (const col of ['title', 'price']) {
    if (!header.includes(col)) return { rows: [], error: `Missing required column "${col}".` };
  }
  const rows = table
    .slice(1)
    .filter((r) => r.some((cell) => cell.trim() !== ''))
    .map((r) => {
      const obj: Record<string, string> = {};
      header.forEach((h, idx) => {
        obj[h] = (r[idx] ?? '').trim();
      });
      return obj;
    });
  return { rows };
}

const EXPORT_HEADER = ['title', 'price', 'stock', 'sku', 'category', 'image_url', 'description', 'status'];

/** Full-catalogue CSV export. Pure given the row data. */
export function productsToCsv(rows: ProductWithCategory[]): string {
  const lines = [EXPORT_HEADER.join(',')];
  for (const p of rows) {
    lines.push(
      toCsvRow([
        p.title,
        penceToInput(p.price_pence),
        p.stock,
        p.sku ?? '',
        p.category_name ?? '',
        p.image_url ?? '',
        (p.description ?? '').replace(/\r?\n/g, ' '),
        p.status,
      ]),
    );
  }
  return lines.join('\r\n') + '\r\n';
}

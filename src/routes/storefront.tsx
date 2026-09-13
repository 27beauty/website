import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppBindings, Env, ProductWithCategory } from '../types';
import {
  listCategories,
  listCategoriesWithCounts,
  getCategoryBySlug,
  queryProducts,
  getProductBySlug,
  getProductById,
  relatedProducts,
} from '../lib/db';
import {
  addLine,
  buildCart,
  MAX_LINE_QUANTITY,
  readCartLines,
  readCouponCode,
  setLineQuantity,
  writeCartLines,
  writeCouponCode,
} from '../lib/cart';
import { validateCoupon } from '../lib/coupons';
import { getShippingConfig } from '../lib/settings';
import { formatPence } from '../lib/money';
import { clampInt, excerpt, normaliseCouponCode, parseJsonArray } from '../lib/util';
import { Layout } from '../ui/layout';
import {
  Breadcrumbs,
  CategoryTile,
  EmptyState,
  ImagePlaceholder,
  Notice,
  Pagination,
  PriceBlock,
  ProductGrid,
  StockBadge,
} from '../ui/components';

/** Public shop pages: home, category, product, search, cart, static pages. */
export const storefront = new Hono<AppBindings>();

const PER_PAGE = 24;
const SORTS = ['newest', 'price_asc', 'price_desc', 'title'] as const;
type SortKey = (typeof SORTS)[number];

function parseSort(value: string | undefined): SortKey {
  return (SORTS as readonly string[]).includes(value ?? '') ? (value as SortKey) : 'newest';
}

function canonicalUrl(env: Env, path: string): string {
  const base = (env.SITE_URL || '').replace(/\/$/, '');
  return `${base}${path}`;
}

/** Only ever redirect to a same-site path, never to an attacker-supplied host. */
function safeRedirect(value: unknown, fallback: string): string {
  if (typeof value === 'string' && value.startsWith('/') && !value.startsWith('//')) return value;
  return fallback;
}

function firstString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return '';
}

function escapeXml(value: string): string {
  return value.replace(/[<>&'"]/g, (ch) => {
    switch (ch) {
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '&':
        return '&amp;';
      case "'":
        return '&apos;';
      default:
        return '&quot;';
    }
  });
}

/** JSON-LD is trusted content we generate ourselves, but escape "</" so a
 * product title/description can never terminate the <script> tag early. */
function jsonLdString(data: unknown): string {
  return JSON.stringify(data).replace(/</g, '\\u003c');
}

async function featuredOrNewest(env: Env, limit = 8): Promise<ProductWithCategory[]> {
  const featured = await queryProducts(env, { featured: true, limit });
  if (featured.items.length) return featured.items;
  const newest = await queryProducts(env, { sort: 'newest', limit });
  return newest.items;
}

/** All active products, paging past the 100-row cap in queryProducts(). */
async function getAllActiveProducts(env: Env): Promise<ProductWithCategory[]> {
  const all: ProductWithCategory[] = [];
  let offset = 0;
  const limit = 100;
  for (let i = 0; i < 50; i++) {
    const { items, total } = await queryProducts(env, { status: 'active', sort: 'newest', limit, offset });
    all.push(...items);
    offset += limit;
    if (offset >= total || items.length === 0) break;
  }
  return all;
}

const TRUST_POINTS = [
  'Dispatched from the UK, usually within 1-2 working days',
  'Secure card payment, handled by Stripe',
  '14-day returns under the Consumer Contracts Regulations',
];

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------

storefront.get('/', async (c) => {
  const [categories, categoryTiles, featured] = await Promise.all([
    listCategories(c.env),
    listCategoriesWithCounts(c.env),
    featuredOrNewest(c.env, 8),
  ]);

  return c.html(
    <Layout
      title="27beauty — everyday brands, everyday prices"
      description="Everyday brands at everyday prices — pet food, snacks, coffee, toys, beauty, DIY and garden, dispatched from the UK. Scanned a QR card? Get 10% off here."
      categories={categories}
      cartCount={c.get('cartCount')}
      canonical={canonicalUrl(c.env, '/')}
      activeCategory="all"
    >
      <section class="hero">
        <h1>Everyday brands, without the marketplace markup.</h1>
        <p>
          Beauty and grooming, pet food, snacks, coffee and tea, toys, DIY, garden and household —
          genuine brands, shipped from the UK. Buying direct cuts out the marketplace's cut, and your
          QR card puts 10% of that straight back in your pocket.
        </p>
        <a class="btn btn-accent" href="/shop">
          Shop all products
        </a>
      </section>

      {categoryTiles.length ? (
        <section class="stack" style="margin-bottom:32px">
          <h2>Shop by category</h2>
          <div class="cat-grid">
            {categoryTiles.map((cat) => (
              <CategoryTile category={cat} />
            ))}
          </div>
        </section>
      ) : null}

      <section class="stack" style="margin-bottom:32px">
        <div class="row-between">
          <h2 style="margin-bottom:0">Popular right now</h2>
          <a href="/shop">See all products</a>
        </div>
        {featured.length ? (
          <ProductGrid products={featured} />
        ) : (
          <EmptyState emoji="🧴" title="New stock arriving soon" message="We're still filling the shelves.">
            <a class="btn" href="/shop">
              Browse the shop
            </a>
          </EmptyState>
        )}
      </section>

      <section class="panel" style="margin-bottom:24px">
        <h2>📇 Scanned a QR card?</h2>
        <p class="muted">
          Every 27beauty parcel includes a QR card. Scan it, or enter the code printed on it at checkout,
          and 10% comes straight off your order — our way of saying thanks for shopping with us directly.
        </p>
        <a class="btn btn-secondary" href="/qr">
          I've got a code
        </a>
      </section>

      <ul class="trust-list">
        {TRUST_POINTS.map((point) => (
          <li>{point}</li>
        ))}
      </ul>
    </Layout>,
  );
});

// ---------------------------------------------------------------------------
// Listing pages (shop + category) share layout, sorting and pagination.
// ---------------------------------------------------------------------------

interface ListingOptions {
  basePath: string;
  title: string;
  description: string;
  activeCategory?: string;
  categoryFilter?: string;
  intro?: unknown;
  emptyTitle: string;
  emptyMessage: string;
  emptyAction?: unknown;
}

async function renderListing(c: Context<AppBindings>, opts: ListingOptions) {
  const categories = await listCategories(c.env);
  const sort = parseSort(c.req.query('sort'));
  const requestedPage = clampInt(c.req.query('page'), 1, 100000, 1);

  let { items, total } = await queryProducts(c.env, {
    categorySlug: opts.categoryFilter,
    sort,
    limit: PER_PAGE,
    offset: (requestedPage - 1) * PER_PAGE,
  });
  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));
  let page = requestedPage;
  if (requestedPage > totalPages && total > 0) {
    page = totalPages;
    ({ items } = await queryProducts(c.env, {
      categorySlug: opts.categoryFilter,
      sort,
      limit: PER_PAGE,
      offset: (page - 1) * PER_PAGE,
    }));
  }

  const makeHref = (p: number) => {
    const params = new URLSearchParams();
    if (sort !== 'newest') params.set('sort', sort);
    if (p > 1) params.set('page', String(p));
    const qs = params.toString();
    return qs ? `${opts.basePath}?${qs}` : opts.basePath;
  };

  return c.html(
    <Layout
      title={opts.title}
      description={opts.description}
      categories={categories}
      cartCount={c.get('cartCount')}
      canonical={canonicalUrl(c.env, opts.basePath)}
      activeCategory={opts.activeCategory}
    >
      {opts.intro as never}
      <div class="row-between" style="margin-bottom:16px">
        <p class="muted" style="margin:0">
          {total} product{total === 1 ? '' : 's'}
        </p>
        <form method="get" action={opts.basePath} class="row">
          <label class="sr-only" for="sort">
            Sort by
          </label>
          <select id="sort" name="sort" onchange="this.form.submit()">
            <option value="newest" selected={sort === 'newest'}>
              Newest
            </option>
            <option value="price_asc" selected={sort === 'price_asc'}>
              Price: low to high
            </option>
            <option value="price_desc" selected={sort === 'price_desc'}>
              Price: high to low
            </option>
            <option value="title" selected={sort === 'title'}>
              Name: A–Z
            </option>
          </select>
          <noscript>
            <button class="btn btn-sm btn-secondary" type="submit">
              Sort
            </button>
          </noscript>
        </form>
      </div>
      {items.length === 0 ? (
        <EmptyState emoji="🧴" title={opts.emptyTitle} message={opts.emptyMessage}>
          {opts.emptyAction as never}
        </EmptyState>
      ) : (
        <>
          <ProductGrid products={items} />
          <Pagination page={page} totalPages={totalPages} makeHref={makeHref} />
        </>
      )}
    </Layout>,
  );
}

storefront.get('/shop', async (c) =>
  renderListing(c, {
    basePath: '/shop',
    title: 'Shop all products',
    description: 'Browse every product at 27beauty — everyday brands across food, drink, pet, home, garden and beauty, dispatched from the UK.',
    activeCategory: 'all',
    emptyTitle: 'No products yet',
    emptyMessage: "We're still stocking the shelves here — check back soon.",
    emptyAction: (
      <a class="btn" href="/">
        Back to home
      </a>
    ),
  }),
);

storefront.get('/category/:slug', async (c) => {
  const slug = c.req.param('slug');
  const category = await getCategoryBySlug(c.env, slug);
  if (!category) return c.notFound();

  const intro = (
    <div class="field">
      <Breadcrumbs
        items={[{ label: 'Home', href: '/' }, { label: 'Shop', href: '/shop' }, { label: category.name }]}
      />
      <h1>
        {category.emoji ? `${category.emoji} ` : ''}
        {category.name}
      </h1>
      {category.description ? <p class="muted">{category.description}</p> : null}
    </div>
  );

  return renderListing(c, {
    basePath: `/category/${category.slug}`,
    title: category.name,
    description:
      category.description || `Shop ${category.name} at 27beauty — everyday brands, UK dispatch, secure checkout.`,
    activeCategory: category.slug,
    categoryFilter: category.slug,
    intro,
    emptyTitle: `No products in ${category.name} yet`,
    emptyMessage: 'New stock is added all the time — check back soon, or browse everything we have.',
    emptyAction: (
      <a class="btn" href="/shop">
        Browse all products
      </a>
    ),
  });
});

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

storefront.get('/search', async (c) => {
  const categories = await listCategories(c.env);
  const term = (c.req.query('q') ?? '').trim();
  const sort = parseSort(c.req.query('sort'));
  const page = clampInt(c.req.query('page'), 1, 100000, 1);

  const { items, total } = term
    ? await queryProducts(c.env, { search: term, sort, limit: PER_PAGE, offset: (page - 1) * PER_PAGE })
    : { items: [] as ProductWithCategory[], total: 0 };
  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));

  const makeHref = (p: number) => {
    const params = new URLSearchParams({ q: term });
    if (sort !== 'newest') params.set('sort', sort);
    if (p > 1) params.set('page', String(p));
    return `/search?${params.toString()}`;
  };

  const browseCategories = (
    <div class="cat-grid" style="margin-top:14px">
      {categories.map((cat) => (
        <CategoryTile category={cat} />
      ))}
    </div>
  );

  return c.html(
    <Layout
      title={term ? `Search results for "${term}"` : 'Search'}
      description={term ? `${total} result(s) for "${term}" at 27beauty.` : 'Search the 27beauty shop.'}
      categories={categories}
      cartCount={c.get('cartCount')}
      canonical={canonicalUrl(c.env, '/search')}
      noindex
    >
      <h1>{term ? `Search results for "${term}"` : 'Search the shop'}</h1>
      {term ? (
        <>
          <p class="muted">
            {total} result{total === 1 ? '' : 's'} for &ldquo;{term}&rdquo;.
          </p>
          {items.length === 0 ? (
            <EmptyState emoji="🔍" title="No matches" message="Try a different word, or browse a category below.">
              {browseCategories}
            </EmptyState>
          ) : (
            <>
              <ProductGrid products={items} />
              <Pagination page={page} totalPages={totalPages} makeHref={makeHref} />
            </>
          )}
        </>
      ) : (
        <EmptyState emoji="🔍" title="Search the shop" message="Type a product name, brand or keyword in the box above.">
          {browseCategories}
        </EmptyState>
      )}
    </Layout>,
  );
});

// ---------------------------------------------------------------------------
// Product detail
// ---------------------------------------------------------------------------

storefront.get('/product/:slug', async (c) => {
  const product = await getProductBySlug(c.env, c.req.param('slug'));
  if (!product) return c.notFound();

  const categories = await listCategories(c.env);
  const images = parseJsonArray(product.images_json);
  if (images.length === 0 && product.image_url) images.push(product.image_url);
  const related = await relatedProducts(c.env, product, 4);

  const priceStr = formatPence(product.price_pence).replace(/[^0-9.]/g, '');
  const jsonLd = jsonLdString({
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: product.title,
    description: excerpt(product.description, 300) || product.title,
    sku: product.sku || undefined,
    brand: product.brand ? { '@type': 'Brand', name: product.brand } : undefined,
    image: images.length ? images : undefined,
    offers: {
      '@type': 'Offer',
      url: canonicalUrl(c.env, `/product/${product.slug}`),
      priceCurrency: 'GBP',
      price: priceStr,
      availability: product.stock > 0 ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
    },
  });

  const maxQty = Math.max(1, Math.min(MAX_LINE_QUANTITY, product.stock));

  return c.html(
    <Layout
      title={product.title}
      description={excerpt(product.description, 155) || `${product.title} at 27beauty.`}
      categories={categories}
      cartCount={c.get('cartCount')}
      canonical={canonicalUrl(c.env, `/product/${product.slug}`)}
      activeCategory={product.category_slug ?? undefined}
      jsonLd={jsonLd}
    >
      <Breadcrumbs
        items={[
          { label: 'Home', href: '/' },
          { label: 'Shop', href: '/shop' },
          ...(product.category_slug
            ? [{ label: product.category_name ?? 'Category', href: `/category/${product.category_slug}` }]
            : []),
          { label: product.title },
        ]}
      />
      <div class="product-layout">
        <div class="gallery">
          <div class="gallery-main">
            {images[0] ? (
              <img id="mainImage" src={images[0]} alt={product.title} />
            ) : (
              <ImagePlaceholder label={product.title} />
            )}
          </div>
          {images.length > 1 ? (
            <div class="gallery-thumbs">
              {images.map((src) => (
                <img src={src} alt="" data-full={src} />
              ))}
            </div>
          ) : null}
        </div>
        <div>
          {product.brand ? <div class="card-meta">{product.brand}</div> : null}
          <h1>{product.title}</h1>
          <div class="row" style="margin-bottom:10px">
            <PriceBlock pricePence={product.price_pence} compareAtPence={product.compare_at_pence} size="lg" />
            <StockBadge stock={product.stock} />
          </div>

          {product.stock > 0 ? (
            <form method="post" action="/cart/add" class="qty-row field">
              <input type="hidden" name="product_id" value={product.id} />
              <div class="field" style="margin-bottom:0">
                <label for="quantity">Quantity</label>
                <input id="quantity" type="number" name="quantity" min={1} max={maxQty} value={1} />
              </div>
              <button class="btn" type="submit">
                Add to basket
              </button>
            </form>
          ) : (
            <button class="btn field" type="button" disabled aria-disabled="true">
              Out of stock
            </button>
          )}

          {product.description ? (
            <div class="stack">
              <h2>Description</h2>
              <p>{product.description}</p>
            </div>
          ) : null}

          <ul class="trust-list">
            {TRUST_POINTS.map((point) => (
              <li>{point}</li>
            ))}
          </ul>
          <p class="small muted">
            Read our full <a href="/pages/delivery">delivery &amp; returns</a> policy.
          </p>
        </div>
      </div>

      {related.length ? (
        <section class="stack" style="margin-top:40px">
          <h2>You may also like</h2>
          <ProductGrid products={related} />
        </section>
      ) : null}

      {images.length > 1 ? (
        <script
          dangerouslySetInnerHTML={{
            __html: `document.querySelectorAll('.gallery-thumbs img').forEach(function(t){t.addEventListener('click',function(){var m=document.getElementById('mainImage');if(m&&t.dataset.full){m.src=t.dataset.full;}});});`,
          }}
        />
      ) : null}
    </Layout>,
  );
});

// ---------------------------------------------------------------------------
// Cart
// ---------------------------------------------------------------------------

async function renderCartPage(c: Context<AppBindings>, notice?: { message: string; kind?: 'ok' | 'bad' }) {
  const categories = await listCategories(c.env);
  const lines = await readCartLines(c);
  const couponCode = readCouponCode(c);
  const cart = await buildCart(c.env, lines, couponCode);
  const hasClamped = cart.items.some((item) => item.clamped);
  const shipping = await getShippingConfig(c.env);
  const afterDiscount = Math.max(cart.subtotalPence - cart.discountPence, 0);
  const remainingForFree =
    shipping.freeThresholdPence > 0 && cart.shippingPence > 0
      ? Math.max(shipping.freeThresholdPence - afterDiscount, 0)
      : 0;

  return c.html(
    <Layout
      title="Your basket"
      description="Review your basket and checkout securely."
      categories={categories}
      cartCount={c.get('cartCount')}
      canonical={canonicalUrl(c.env, '/cart')}
      noindex
    >
      <h1>Your basket</h1>
      {notice ? (
        <div class="field">
          <Notice kind={notice.kind}>{notice.message}</Notice>
        </div>
      ) : null}
      {hasClamped ? (
        <div class="field">
          <Notice kind="warn">
            We've reduced the quantity of one or more items so it matches what we currently have in stock.
          </Notice>
        </div>
      ) : null}

      {cart.items.length === 0 ? (
        <EmptyState emoji="🧺" title="Your basket is empty" message="Discover something new for your routine.">
          <a class="btn" href="/shop">
            Start shopping
          </a>
        </EmptyState>
      ) : (
        <div class="checkout-layout">
          <div class="panel">
            {cart.items.map((item) => (
              <div class="line">
                {item.product.image_url ? (
                  <img src={item.product.image_url} alt="" />
                ) : (
                  <div
                    style="width:68px;height:68px;background:var(--surface-2);border-radius:8px;flex:none;display:grid;place-items:center;color:var(--ink-faint)"
                  >
                    <ImagePlaceholder label={item.product.title} />
                  </div>
                )}
                <div class="line-body">
                  <div class="line-title">
                    <a href={`/product/${item.product.slug}`}>{item.product.title}</a>
                  </div>
                  <div class="muted small">{formatPence(item.product.price_pence)} each</div>
                  <form method="post" action="/cart/update" class="row" style="margin-top:6px">
                    <input type="hidden" name="product_id" value={item.product.id} />
                    <label class="sr-only" for={`qty-${item.product.id}`}>
                      Quantity for {item.product.title}
                    </label>
                    <input
                      id={`qty-${item.product.id}`}
                      type="number"
                      name="quantity"
                      min={0}
                      max={Math.max(item.product.stock, item.quantity)}
                      value={item.quantity}
                      style="width:76px"
                    />
                    <button class="btn btn-secondary btn-sm" type="submit">
                      Update
                    </button>
                  </form>
                </div>
                <div class="row" style="flex-direction:column;align-items:flex-end;gap:8px">
                  <strong class="nowrap">{formatPence(item.lineTotalPence)}</strong>
                  <form method="post" action="/cart/remove">
                    <input type="hidden" name="product_id" value={item.product.id} />
                    <button class="btn btn-secondary btn-sm" type="submit">
                      Remove
                    </button>
                  </form>
                </div>
              </div>
            ))}
          </div>

          <div class="summary">
            <div class="panel">
              <h2>Order summary</h2>
              <ul class="totals">
                <li>
                  <span>Subtotal</span>
                  <span>{formatPence(cart.subtotalPence)}</span>
                </li>
                {cart.discountPence > 0 ? (
                  <li>
                    <span>Discount{cart.coupon ? ` (${cart.coupon.code})` : ''}</span>
                    <span>-{formatPence(cart.discountPence)}</span>
                  </li>
                ) : null}
                <li>
                  <span>Delivery</span>
                  <span>{cart.shippingPence === 0 ? 'Free' : formatPence(cart.shippingPence)}</span>
                </li>
                <li class="total">
                  <span>Total</span>
                  <span>{formatPence(cart.totalPence)}</span>
                </li>
              </ul>
              {remainingForFree > 0 ? (
                <p class="field-hint">Spend {formatPence(remainingForFree)} more for free UK delivery.</p>
              ) : null}

              <form method="post" action="/cart/coupon" class="coupon-form field">
                <label class="sr-only" for="code">
                  Coupon code
                </label>
                <input id="code" type="text" name="code" placeholder="Coupon code" value={cart.coupon?.code ?? ''} />
                <button class="btn btn-secondary" type="submit">
                  Apply
                </button>
              </form>
              {cart.coupon ? (
                <form method="post" action="/cart/coupon" class="field">
                  <input type="hidden" name="remove" value="1" />
                  <button class="btn btn-secondary btn-sm" type="submit">
                    Remove coupon
                  </button>
                </form>
              ) : null}

              <a class="btn btn-block" href="/checkout">
                Continue to checkout
              </a>
            </div>
          </div>
        </div>
      )}
    </Layout>,
  );
}

storefront.get('/cart', async (c) => renderCartPage(c));

storefront.post('/cart/add', async (c) => {
  const body = await c.req.parseBody();
  const redirectTo = safeRedirect(body.redirect_to, '/cart');
  const productId = clampInt(body.product_id, 0, 1_000_000_000, 0);
  const product = productId ? await getProductById(c.env, productId) : null;

  if (!product || product.status !== 'active' || product.stock <= 0) {
    return c.redirect(redirectTo, 303);
  }

  const quantity = clampInt(body.quantity, 1, Math.min(MAX_LINE_QUANTITY, product.stock), 1);
  const lines = await readCartLines(c);
  await writeCartLines(c, addLine(lines, product.id, quantity));
  return c.redirect(redirectTo, 303);
});

storefront.post('/cart/update', async (c) => {
  const body = await c.req.parseBody();
  const productId = clampInt(body.product_id, 0, 1_000_000_000, 0);
  const quantity = clampInt(body.quantity, 0, MAX_LINE_QUANTITY, 0);
  if (productId) {
    const lines = await readCartLines(c);
    await writeCartLines(c, setLineQuantity(lines, productId, quantity));
  }
  return c.redirect('/cart', 303);
});

storefront.post('/cart/remove', async (c) => {
  const body = await c.req.parseBody();
  const productId = clampInt(body.product_id, 0, 1_000_000_000, 0);
  if (productId) {
    const lines = await readCartLines(c);
    await writeCartLines(c, setLineQuantity(lines, productId, 0));
  }
  return c.redirect('/cart', 303);
});

storefront.post('/cart/coupon', async (c) => {
  const body = await c.req.parseBody();
  const remove = firstString(body.remove) === '1';
  const rawCode = firstString(body.code);

  if (remove || !rawCode.trim()) {
    writeCouponCode(c, null);
    return c.redirect('/cart', 303);
  }

  const lines = await readCartLines(c);
  const cartWithoutCoupon = await buildCart(c.env, lines, null);
  const check = await validateCoupon(c.env, rawCode, cartWithoutCoupon.subtotalPence);

  if (!check.coupon) {
    return renderCartPage(c, { message: check.error ?? 'That code could not be applied.', kind: 'bad' });
  }

  writeCouponCode(c, normaliseCouponCode(rawCode));
  return c.redirect('/cart', 303);
});

// ---------------------------------------------------------------------------
// QR landing — the whole reason this site exists.
// ---------------------------------------------------------------------------

async function qrLanding(c: Context<AppBindings>, codeRaw: string) {
  const [categories, categoryTiles, featured] = await Promise.all([
    listCategories(c.env),
    listCategoriesWithCounts(c.env),
    featuredOrNewest(c.env, 4),
  ]);
  const code = codeRaw.trim();
  let notice: { message: string; kind: 'ok' | 'bad' } | null = null;

  // The basket is empty at this point, so the minimum-spend rule is not a
  // reason to reject the card — it becomes a hint further down instead.
  const check = code
    ? await validateCoupon(c.env, code, 0, null, { ignoreMinSpend: true })
    : null;
  const coupon = check?.coupon ?? null;

  if (coupon) {
    writeCouponCode(c, coupon.code);
    notice = {
      kind: 'ok',
      message: `Code ${coupon.code} is saved to your basket — it comes off your total at checkout.`,
    };
  } else if (code) {
    notice = {
      kind: 'bad',
      message: check?.error ?? "We couldn't recognise that code, but you're still welcome to shop below.",
    };
  }

  // The headline has to match the card the customer is holding: the offer is
  // whatever the coupon actually says, not a hardcoded 10%.
  const offer = coupon
    ? coupon.kind === 'percent'
      ? `${coupon.value}% off`
      : `${formatPence(coupon.value)} off`
    : null;

  // An item-scoped card should land on that item, not on a generic welcome.
  const scopedProduct = coupon?.product_id ? await getProductById(c.env, coupon.product_id) : null;
  const discountedPence =
    coupon && scopedProduct
      ? Math.max(
          scopedProduct.price_pence -
            (coupon.kind === 'percent'
              ? Math.round((scopedProduct.price_pence * Math.min(coupon.value, 100)) / 100)
              : coupon.value),
          0,
        )
      : null;

  const itemOnly = coupon?.product_only === 1;
  const heading = offer
    ? itemOnly && scopedProduct
      ? `🎉 ${offer} ${scopedProduct.title}`
      : `🎉 Here's your ${offer} everything`
    : 'Welcome to 27beauty';

  return c.html(
    <Layout
      title={offer ? `Your ${offer} code` : 'Welcome'}
      description={
        offer
          ? `Scanned a 27beauty QR card? Here's your ${offer}${itemOnly ? '' : ' everything'}, ready to use.`
          : 'Scanned a 27beauty QR card? Here is the shop.'
      }
      categories={categories}
      cartCount={c.get('cartCount')}
      canonical={canonicalUrl(c.env, code ? `/qr/${code}` : '/qr')}
      noindex
    >
      <section class="hero center">
        <h1>{heading}</h1>
        {coupon ? (
          <p class="qr-code-display">{coupon.code}</p>
        ) : null}
        <p>
          {coupon
            ? itemOnly
              ? 'Thanks for shopping with 27beauty. Your discount is saved to this basket and comes off that item at checkout.'
              : 'Thanks for shopping with 27beauty. Your discount is saved to this basket and comes off everything you buy — carry on browsing and it comes straight off your total at checkout, no need to remember a thing.'
            : 'Thanks for scanning. Browse the shop below — the same products you found on the marketplace, direct from us.'}
        </p>
        {coupon && coupon.min_spend_pence > 0 ? (
          <p class="small">Spend {formatPence(coupon.min_spend_pence)} or more to use it.</p>
        ) : null}
        {coupon?.expires_at ? (
          <p class="small">Valid until {coupon.expires_at.slice(0, 10)}.</p>
        ) : null}
        <a class="btn btn-accent" href={scopedProduct ? `/product/${scopedProduct.slug}` : '/shop'}>
          {scopedProduct ? 'See the offer' : 'Start shopping'}
        </a>
      </section>

      {notice ? <Notice kind={notice.kind}>{notice.message}</Notice> : null}

      {scopedProduct && discountedPence !== null ? (
        <section class="panel qr-offer" style="margin-top:20px">
          <div class="qr-offer-media">
            {scopedProduct.image_url ? (
              <img src={scopedProduct.image_url} alt={scopedProduct.title} />
            ) : (
              <ImagePlaceholder />
            )}
          </div>
          <div class="qr-offer-body">
            <h2>{scopedProduct.title}</h2>
            <div class="price-row">
              <span class="price price-lg">{formatPence(discountedPence)}</span>
              <span class="price-was">{formatPence(scopedProduct.price_pence)}</span>
              <span class="pill pill-ok">{offer} with your card{itemOnly ? '' : ' — on everything'}</span>
            </div>
            {scopedProduct.stock > 0 ? (
              <form method="post" action="/cart/add" class="qty-row">
                <input type="hidden" name="product_id" value={String(scopedProduct.id)} />
                <input type="hidden" name="quantity" value="1" />
                <button class="btn btn-accent" type="submit">
                  Add to basket
                </button>
                <a class="btn btn-secondary" href={`/product/${scopedProduct.slug}`}>
                  View item
                </a>
              </form>
            ) : (
              <p class="muted">
                Sold out just now — your code still works on it when it's back, or browse below.
              </p>
            )}
          </div>
        </section>
      ) : null}

      <ul class="trust-list" style="margin-top:20px">
        {TRUST_POINTS.map((point) => (
          <li>{point}</li>
        ))}
      </ul>

      {categoryTiles.length ? (
        <section class="stack" style="margin-top:32px">
          <h2>Shop by category</h2>
          <div class="cat-grid">
            {categoryTiles.map((cat) => (
              <CategoryTile category={cat} />
            ))}
          </div>
        </section>
      ) : null}

      {featured.length ? (
        <section class="stack" style="margin-top:32px">
          <h2>Popular right now</h2>
          <ProductGrid products={featured} />
        </section>
      ) : null}
    </Layout>,
  );
}

storefront.get('/qr', async (c) => qrLanding(c, c.req.query('code') || 'QR10'));
storefront.get('/qr/:code', async (c) => qrLanding(c, c.req.param('code')));

// ---------------------------------------------------------------------------
// Static content pages
// ---------------------------------------------------------------------------

storefront.get('/pages/:slug', async (c) => {
  const slug = c.req.param('slug');
  const categories = await listCategories(c.env);
  const email = c.env.SUPPORT_EMAIL || 'hello@27beauty.co.uk';
  const layoutFor = (title: string, description: string, body: unknown) =>
    c.html(
      <Layout
        title={title}
        description={description}
        categories={categories}
        cartCount={c.get('cartCount')}
        canonical={canonicalUrl(c.env, `/pages/${slug}`)}
      >
        <div class="panel stack" style="max-width:72ch">
          {body as never}
        </div>
      </Layout>,
    );

  switch (slug) {
    case 'delivery':
      return layoutFor(
        'Delivery information',
        'How and when we dispatch and deliver 27beauty orders across the UK.',
        <>
          <h1>Delivery</h1>
          <p>
            We dispatch every order from the UK, usually within 1-2 working days of payment clearing. You'll
            get a confirmation email as soon as your order is placed, and a further email with tracking details
            once it leaves us.
          </p>
          <h2>Delivery costs</h2>
          <p>
            Standard UK delivery is charged at checkout and shown before you pay. Orders over the free delivery
            threshold shown in your basket qualify for free standard delivery automatically — no code needed.
          </p>
          <h2>How long delivery takes</h2>
          <p>
            Most orders arrive within 2-4 working days of dispatch. Remote parts of the UK (including the
            Scottish Highlands, Northern Ireland, the Channel Islands and offshore islands) can occasionally take
            a little longer.
          </p>
          <h2>Something gone missing?</h2>
          <p>
            If your order hasn't arrived within 7 working days of dispatch, email us at{' '}
            <a href={`mailto:${email}`}>{email}</a> with your order number and we'll chase it up straight away.
          </p>
        </>,
      );

    case 'returns':
      return layoutFor(
        'Returns policy',
        '14-day returns under the Consumer Contracts Regulations, explained plainly.',
        <>
          <h1>Returns</h1>
          <p>
            We want you to be happy with what you've ordered. As an online retailer based in the UK, you're
            covered by the Consumer Contracts Regulations 2013, which give you the right to cancel your order
            and return most items for a full refund.
          </p>
          <h2>Your 14-day right to change your mind</h2>
          <p>
            You have 14 days from the day you receive your order to tell us you'd like to return it, and a
            further 14 days to send it back to us. Items should be unused, unopened and in their original
            packaging where possible — this matters for cosmetics and personal care products in particular, for
            hygiene reasons.
          </p>
          <h2>How to start a return</h2>
          <p>
            Email <a href={`mailto:${email}`}>{email}</a> with your order number and which item(s) you'd like to
            return, and we'll send you the address to post it back to along with instructions. Once we receive
            it, we'll refund you to your original payment method within 14 days.
          </p>
          <h2>Faulty or damaged items</h2>
          <p>
            If something arrives faulty, damaged or not as described, this doesn't affect your statutory rights
            under the Consumer Rights Act 2015 — contact us and we'll sort out a replacement or refund, including
            return postage.
          </p>
          <h2>Return postage</h2>
          <p>
            Unless an item is faulty or was sent in error, return postage for a change-of-mind return is your
            responsibility. We recommend using a tracked service, as we can't refund parcels that don't reach us.
          </p>
        </>,
      );

    case 'contact':
      return layoutFor(
        'Contact us',
        'Get in touch with the 27beauty team about an order, a product, or anything else.',
        <>
          <h1>Contact us</h1>
          <p>
            We're a small, independent UK team and read every message ourselves — there's no call centre and no
            chatbot here.
          </p>
          <h2>Email</h2>
          <p>
            The quickest way to reach us is <a href={`mailto:${email}`}>{email}</a>. If your query is about an
            existing order, please include your order number so we can help faster.
          </p>
          <h2>Response times</h2>
          <p>
            We aim to reply within one working day, Monday to Friday. During particularly busy periods (such as
            the run-up to Christmas) this may occasionally be a little longer.
          </p>
          <h2>Business address</h2>
          <p>27beauty, United Kingdom. A full postal address is available on request by email.</p>
        </>,
      );

    case 'terms':
      return layoutFor(
        'Terms & conditions',
        'The terms that apply when you shop with 27beauty.',
        <>
          <h1>Terms &amp; conditions</h1>
          <p>
            These terms apply whenever you place an order with 27beauty through this website. By placing an
            order you agree to them.
          </p>
          <h2>Orders and pricing</h2>
          <p>
            All prices are shown in pounds sterling (GBP) and include VAT where applicable. We take reasonable
            care to make sure prices and stock levels are accurate, but occasionally a mistake slips through —
            if it does, we'll contact you before dispatching anything affected.
          </p>
          <h2>Contract and payment</h2>
          <p>
            A contract is formed once we confirm your order by email. Payment is taken securely through Stripe
            at checkout; we never see or store your full card details.
          </p>
          <h2>Cancellations and returns</h2>
          <p>
            See our <a href="/pages/returns">returns policy</a> for how the Consumer Contracts Regulations apply
            to orders placed on this site.
          </p>
          <h2>Liability</h2>
          <p>
            Nothing in these terms limits or excludes our liability for anything that cannot lawfully be limited
            or excluded, including death or personal injury caused by negligence, or fraud.
          </p>
          <h2>Governing law</h2>
          <p>These terms are governed by the law of England and Wales.</p>
        </>,
      );

    case 'privacy':
      return layoutFor(
        'Privacy policy',
        'How 27beauty collects, uses and protects your personal data.',
        <>
          <h1>Privacy policy</h1>
          <p>
            This policy explains what personal data we collect when you shop with 27beauty, why, and what rights
            you have over it, in line with the UK General Data Protection Regulation (UK GDPR) and the Data
            Protection Act 2018.
          </p>
          <h2>What we collect</h2>
          <p>
            When you place an order we collect your name, delivery address, email address, phone number and
            order details. Payment card details are collected and processed directly by Stripe, our payment
            provider — we never see or store them.
          </p>
          <h2>Why we use it</h2>
          <p>
            We use your data to fulfil and deliver your order, provide customer support, meet our legal and tax
            obligations, and — only with your consent — to occasionally email you about offers.
          </p>
          <h2>Who we share it with</h2>
          <p>
            We share the minimum necessary data with our couriers (to deliver your parcel) and Stripe (to take
            payment). We do not sell your personal data to anyone.
          </p>
          <h2>How long we keep it</h2>
          <p>
            We keep order records for as long as required by UK tax law, and delete other personal data when
            it's no longer needed for the purpose it was collected for.
          </p>
          <h2>Your rights</h2>
          <p>
            You can ask us to access, correct, delete or export the personal data we hold about you at any time
            by emailing <a href={`mailto:${email}`}>{email}</a>. You also have the right to complain to the
            Information Commissioner's Office (ICO) if you're unhappy with how we've handled your data.
          </p>
        </>,
      );

    case 'about':
      return layoutFor(
        'About 27beauty',
        'Who we are and how 27beauty started.',
        <>
          <h1>About 27beauty</h1>
          <p>
            27beauty is a small, independent UK retailer of everyday branded goods — from pet food and
            snacks to coffee, toys, DIY, garden and beauty. We started
            out selling on marketplaces, and built this site so the customers we'd already served could shop
            with us directly — with the same genuine products, dispatched from the same UK stock.
          </p>
          <p>
            If you've bought from us before and kept a QR card from your parcel, it's worth 10% off here — see{' '}
            <a href="/qr">your code</a> to use it.
          </p>
          <p>
            Questions, feedback or just want to say hello? We're at{' '}
            <a href={`mailto:${email}`}>{email}</a>.
          </p>
        </>,
      );

    default:
      return c.notFound();
  }
});

// ---------------------------------------------------------------------------
// Sitemap
// ---------------------------------------------------------------------------

storefront.get('/sitemap.xml', async (c) => {
  const base = (c.env.SITE_URL || '').replace(/\/$/, '');
  const [categories, products] = await Promise.all([listCategories(c.env), getAllActiveProducts(c.env)]);

  const urls: Array<{ loc: string; lastmod?: string }> = [
    { loc: `${base}/` },
    { loc: `${base}/shop` },
    ...categories.map((cat) => ({ loc: `${base}/category/${cat.slug}` })),
    ...products.map((p) => ({ loc: `${base}/product/${p.slug}`, lastmod: p.updated_at?.slice(0, 10) })),
  ];

  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
    .map((u) => `  <url><loc>${escapeXml(u.loc)}</loc>${u.lastmod ? `<lastmod>${escapeXml(u.lastmod)}</lastmod>` : ''}</url>`)
    .join('\n')}\n</urlset>\n`;

  return c.body(body, 200, { 'Content-Type': 'application/xml; charset=utf-8' });
});

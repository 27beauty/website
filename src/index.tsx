import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import type { AppBindings, Env } from './types';
import { readCartLines } from './lib/cart';
import { listCategories } from './lib/db';
import { Layout } from './ui/layout';
import { storefront } from './routes/storefront';
import { checkout } from './routes/checkout';
import { webhooks } from './routes/webhooks';
import { api } from './routes/api';
import { admin } from './routes/admin/index';
import { runEbaySync } from './lib/ebay/sync';

const app = new Hono<AppBindings>();

const securityHeaders = secureHeaders({
  contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://js.stripe.com'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'https:'],
      frameSrc: ['https://js.stripe.com', 'https://hooks.stripe.com'],
      connectSrc: ["'self'", 'https://api.stripe.com'],
      formAction: ["'self'"],
      baseUri: ["'self'"],
    },
  xFrameOptions: 'SAMEORIGIN',
  referrerPolicy: 'strict-origin-when-cross-origin',
});

/**
 * Security headers apply to every page, but not to /media/* — those responses
 * come straight from the edge cache with immutable headers, and a CSP on a
 * product photo buys nothing.
 */
app.use('*', async (c, next) => {
  if (new URL(c.req.url).pathname.startsWith('/media/')) return next();
  return securityHeaders(c, next);
});

/** Basket count comes from the signed cookie alone — no database round trip. */
app.use('*', async (c, next) => {
  const lines = await readCartLines(c);
  c.set(
    'cartCount',
    lines.reduce((sum, l) => sum + l.q, 0),
  );
  await next();
});

/**
 * Product images uploaded through the admin panel live in R2 and are served
 * from here so the storefront can link to them directly.
 */
app.get('/media/*', async (c) => {
  if (!c.env.MEDIA) return c.notFound(); // R2 not enabled on the account yet

  const key = decodeURIComponent(new URL(c.req.url).pathname.replace(/^\/media\//, ''));
  if (!key || key.includes('..')) return c.notFound();

  // Serve from the edge cache whenever possible: every miss is a billable R2
  // read, and product images are requested far more often than they change.
  // This is what keeps read operations nowhere near the free-tier ceiling.
  const cache = caches.default;
  const cached = await cache.match(c.req.raw);
  if (cached) {
    // A cached Response has immutable headers, so hand back a copy that later
    // middleware is still allowed to touch.
    return new Response(cached.body, {
      status: cached.status,
      headers: new Headers(cached.headers),
    });
  }

  const object = await c.env.MEDIA.get(key);
  if (!object) return c.notFound();

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  // Keys are random per upload and never rewritten, so this can be immutable.
  headers.set('cache-control', 'public, max-age=31536000, immutable');

  // Read the object once and build two independent responses: sharing a single
  // R2 stream between the cache and the client cancels one of them. Uploads are
  // capped at a few MB (src/lib/media.ts), so buffering here is safe.
  const bytes = await object.arrayBuffer();
  c.executionCtx.waitUntil(cache.put(c.req.raw, new Response(bytes, { headers: new Headers(headers) })));
  return new Response(bytes, { headers });
});

app.route('/', webhooks); // must stay before body-parsing routes
app.route('/', storefront);
app.route('/', checkout);
app.route('/api', api);
app.route('/admin', admin);

app.notFound(async (c) => {
  const categories = await listCategories(c.env).catch(() => []);
  return c.html(
    <Layout title="Page not found" categories={categories} cartCount={c.get('cartCount')} noindex>
      <div class="empty">
        <span class="emoji">🔍</span>
        <h1>We couldn't find that page</h1>
        <p class="muted">The link may be out of date, or the product may have sold out.</p>
        <a class="btn" href="/shop">
          Browse the shop
        </a>
      </div>
    </Layout>,
    404,
  );
});

app.onError((err, c) => {
  console.error('Unhandled error', err);
  const wantsJson = c.req.path.startsWith('/api') || c.req.header('accept')?.includes('application/json');
  if (wantsJson) return c.json({ error: 'Something went wrong' }, 500);
  return c.html(
    <Layout title="Something went wrong" cartCount={c.get('cartCount')} noindex>
      <div class="empty">
        <span class="emoji">⚠️</span>
        <h1>Something went wrong</h1>
        <p class="muted">Please try again. If it keeps happening, email hello@27beauty.co.uk.</p>
        <a class="btn" href="/">
          Back to the shop
        </a>
      </div>
    </Layout>,
    500,
  );
});

export default {
  fetch: app.fetch,

  /** Cron trigger (wrangler.toml) — keeps the catalogue in step with eBay. */
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runEbaySync(env, 'cron').catch((err) => {
        console.error('Scheduled eBay sync failed', err);
      }),
    );
  },
} satisfies ExportedHandler<Env>;

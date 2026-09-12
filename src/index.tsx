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

app.use(
  '*',
  secureHeaders({
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
  }),
);

/** Basket count comes from the signed cookie alone — no database round trip. */
app.use('*', async (c, next) => {
  const lines = await readCartLines(c);
  c.set(
    'cartCount',
    lines.reduce((sum, l) => sum + l.q, 0),
  );
  await next();
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

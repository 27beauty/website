import { Hono } from 'hono';
import type { AppBindings } from '../types';
import { secretsMatch } from '../lib/crypto';
import { clampInt } from '../lib/util';
import { runEbaySync } from '../lib/ebay/sync';
import { parseBeacon, recordBeacon } from '../lib/analytics';
import { DELETION_ENDPOINT_PATH, challengeResponse } from '../lib/ebay/deletion';

/** Machine endpoints: eBay sync trigger, health check, product JSON feed. */
export const api = new Hono<AppBindings>();

const VERSION = '1.0.0';

/**
 * Leave-beacon from storefront pages: how long the page was visible and how
 * far it was scrolled. Always 204 — a beacon has nobody to read an error.
 */
api.post('/beacon', async (c) => {
  const beacon = parseBeacon(await c.req.text().catch(() => ''));
  if (beacon) {
    c.executionCtx.waitUntil(
      recordBeacon(c.env, beacon).catch((err) => console.error('beacon write failed', err instanceof Error ? err.message : err)),
    );
  }
  return c.body(null, 204);
});

/**
 * eBay Marketplace Account Deletion (required before eBay enables a
 * production keyset). GET answers eBay's ownership challenge; POST
 * acknowledges a closure notice — no eBay buyer data is stored here.
 */
api.get('/ebay/account-deletion', async (c) => {
  const code = c.req.query('challenge_code');
  const token = c.env.EBAY_DELETION_TOKEN;
  if (!code || !token) return c.json({ error: 'not configured' }, 400);
  const endpoint = `${c.env.SITE_URL}${DELETION_ENDPOINT_PATH}`;
  return c.json({ challengeResponse: await challengeResponse(code, token, endpoint) });
});

api.post('/ebay/account-deletion', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { notification?: { data?: { username?: string } } } | null;
  const username = body?.notification?.data?.username;
  // Only a username is logged — enough to notice if it's one of our own shops.
  console.log('eBay account deletion notice', username ? `for ${username}` : '(no username)');
  return c.body(null, 204);
});

api.get('/health', (c) => {
  return c.json({ ok: true, time: new Date().toISOString(), version: VERSION });
});

/**
 * Triggers an eBay sync on demand (e.g. from an external scheduler, or the
 * admin panel's "sync now" button). Authorised with a shared secret so it can
 * be called without an admin session cookie.
 */
api.post('/sync/ebay', async (c) => {
  if (!c.env.SYNC_TOKEN) {
    return c.json({ error: 'sync is not configured (SYNC_TOKEN unset)' }, 503);
  }

  const header = c.req.header('Authorization');
  const bearer = header?.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : undefined;
  const provided = bearer ?? c.req.header('X-Sync-Token');

  if (!secretsMatch(provided, c.env.SYNC_TOKEN)) {
    return c.json({ error: 'unauthorized' }, 401);
  }

  const result = await runEbaySync(c.env, 'api');
  return c.json(result);
});

/**
 * Small public JSON feed of active products, for future integrations
 * (e.g. a marketplace listing tool, a price-comparison widget). Never
 * exposes cost price, stock-lock flags or anything from the eBay account.
 */
api.get('/products.json', async (c) => {
  const limit = clampInt(c.req.query('limit'), 1, 100, 24);
  const offset = clampInt(c.req.query('offset'), 0, 1_000_000, 0);

  const { results } = await c.env.DB.prepare(
    `SELECT p.id, p.slug, p.title, p.price_pence, p.stock, p.image_url, c.slug AS category_slug
     FROM products p
     LEFT JOIN categories c ON c.id = p.category_id
     WHERE p.status = 'active'
     ORDER BY p.id ASC
     LIMIT ? OFFSET ?`,
  )
    .bind(limit, offset)
    .all<{
      id: number;
      slug: string;
      title: string;
      price_pence: number;
      stock: number;
      image_url: string | null;
      category_slug: string | null;
    }>();

  c.header('Cache-Control', 'public, max-age=300');
  return c.json({
    products: (results ?? []).map((p) => ({
      id: p.id,
      slug: p.slug,
      title: p.title,
      price_pence: p.price_pence,
      stock: p.stock,
      category: p.category_slug,
      image: p.image_url,
    })),
    limit,
    offset,
  });
});

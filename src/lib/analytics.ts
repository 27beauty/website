/**
 * First-party shop analytics: what shoppers look at, where they came from,
 * what they add to the basket and where they leave.
 *
 * Privacy by design: no cookies, no local storage, nothing sent to a third
 * party, and nothing that identifies a person.
 * - A "visitor" is a SHA-256 of (daily random salt + IP + user agent). The salt
 *   lives in KV for two days and is then gone, so hashes can't be reversed or
 *   linked across days, and the IP is never stored.
 * - Shoppers sending Global Privacy Control or Do Not Track aren't recorded.
 * - Bots, the owner's own admin sessions and non-HTML requests are skipped.
 *
 * Page views are recorded server-side by middleware in src/index.tsx. A tiny
 * inline script (LEAVE_BEACON) reports how long the page was visible and how
 * far down it was scrolled when the shopper leaves, to /api/beacon.
 *
 * Every write happens in waitUntil() after the response, so tracking never
 * slows a page down and a failure here can never break one.
 */

import type { Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import type { AppBindings, Env } from '../types';

export type EventType = 'view' | 'add' | 'checkout';

export type PageType =
  | 'home'
  | 'shop'
  | 'category'
  | 'product'
  | 'search'
  | 'basket'
  | 'qr'
  | 'info'
  | 'trade'
  | 'order-complete'
  | 'other';

export type TrafficSource =
  | 'qr'
  | 'ebay'
  | 'search'
  | 'social'
  | 'email'
  | 'campaign'
  | 'other-site'
  | 'direct'
  | 'internal';

export type Device = 'mobile' | 'tablet' | 'desktop';

/** Raw events older than this are deleted by the daily cron. */
export const RETENTION_DAYS = 180;

const BOT_PATTERN =
  /bot|crawl|spider|slurp|scrape|fetch|preview|facebookexternalhit|embedly|whatsapp|telegram|skype|discord|headless|lighthouse|pagespeed|gtmetrix|pingdom|uptime|monitor|curl|wget|python|java\/|go-http|okhttp|axios|node-fetch|httpclient|postman|insomnia|^mozilla\/5\.0$/i;

export function isBot(userAgent: string | undefined | null): boolean {
  if (!userAgent || userAgent.length < 20) return true;
  return BOT_PATTERN.test(userAgent);
}

export function deviceFor(userAgent: string | undefined | null): Device {
  const ua = userAgent ?? '';
  if (/iPad|Tablet|PlayBook|Silk|Kindle|(Android(?!.*Mobile))/i.test(ua)) return 'tablet';
  if (/Mobi|iPhone|iPod|Android|Windows Phone|Opera Mini/i.test(ua)) return 'mobile';
  return 'desktop';
}

export function pageTypeFor(path: string): PageType {
  if (path === '/') return 'home';
  if (path === '/shop') return 'shop';
  if (path.startsWith('/category/')) return 'category';
  if (path.startsWith('/product/')) return 'product';
  if (path === '/search') return 'search';
  if (path === '/cart') return 'basket';
  if (path === '/qr' || path.startsWith('/qr/')) return 'qr';
  if (path.startsWith('/pages/')) return 'info';
  if (path === '/b2b') return 'trade';
  if (path === '/checkout/success') return 'order-complete';
  return 'other';
}

const SEARCH_ENGINES = /(^|\.)(google|bing|duckduckgo|yahoo|ecosia|baidu|yandex|brave|startpage|qwant)\./i;
const SOCIAL = /(^|\.)(facebook|fb|instagram|tiktok|twitter|x|t|pinterest|youtube|reddit|linkedin|snapchat|threads)\.(com|co|net)$|^(l|m|lm)\.facebook\.com$|^t\.co$/i;
const EMAIL = /(^|\.)(mail\.google|outlook\.live|mail\.yahoo|outlook\.office)\./i;

/**
 * Where a page request came from. QR landing pages win (that's the whole
 * point of the site), then explicit UTM tags, then the referring site.
 */
export function classifySource(input: {
  path: string;
  referrerHost: string | null;
  ownHost: string;
  utmSource?: string | null;
  utmMedium?: string | null;
}): TrafficSource {
  if (pageTypeFor(input.path) === 'qr') return 'qr';
  const utmSource = (input.utmSource ?? '').toLowerCase();
  const utmMedium = (input.utmMedium ?? '').toLowerCase();
  if (utmSource || utmMedium) {
    if (utmSource.includes('qr') || utmMedium.includes('qr')) return 'qr';
    if (utmSource.includes('ebay')) return 'ebay';
    if (utmMedium === 'email' || utmSource.includes('mail')) return 'email';
    if (/social|facebook|instagram|tiktok/.test(utmMedium + utmSource)) return 'social';
    return 'campaign';
  }
  const host = (input.referrerHost ?? '').toLowerCase();
  if (!host) return 'direct';
  const own = input.ownHost.toLowerCase().replace(/^www\./, '');
  if (host === own || host.endsWith(`.${own}`)) return 'internal';
  if (host.includes('ebay.')) return 'ebay';
  if (EMAIL.test(host)) return 'email';
  if (SEARCH_ENGINES.test(host)) return 'search';
  if (SOCIAL.test(host)) return 'social';
  return 'other-site';
}

export const SOURCE_LABELS: Record<TrafficSource, string> = {
  qr: 'QR card in a parcel',
  ebay: 'eBay',
  search: 'Google & other search',
  social: 'Social media',
  email: 'Email',
  campaign: 'Tagged campaign link',
  'other-site': 'Another website',
  direct: 'Typed in / bookmark',
  internal: 'Came back later',
};

export const PAGE_LABELS: Record<PageType, string> = {
  home: 'Home page',
  shop: 'All products',
  category: 'Category page',
  product: 'Product page',
  search: 'Search results',
  basket: 'Basket',
  qr: 'QR card landing page',
  info: 'Info page (delivery, returns…)',
  trade: 'Trade enquiries',
  'order-complete': 'Order confirmation',
  other: 'Other page',
};

function referrerHostOf(referer: string | undefined): string | null {
  if (!referer) return null;
  try {
    return new URL(referer).host.slice(0, 120);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Anonymous daily visitor id
// ---------------------------------------------------------------------------

const saltCache = new Map<string, string>();

async function dailySalt(env: Env, day: string): Promise<string> {
  const cached = saltCache.get(day);
  if (cached) return cached;
  const key = `analytics:salt:${day}`;
  let salt = await env.KV.get(key);
  if (!salt) {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    salt = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
    // Kept two days so a visit straddling midnight UTC still resolves, then gone.
    await env.KV.put(key, salt, { expirationTtl: 2 * 86400 });
  }
  if (saltCache.size > 4) saltCache.clear();
  saltCache.set(day, salt);
  return salt;
}

export async function visitorHash(salt: string, ip: string, userAgent: string): Promise<string> {
  const data = new TextEncoder().encode(`${salt}|${ip}|${userAgent}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

/**
 * Marks this browser as the owner's so their own shop browsing isn't counted.
 * Separate from the admin session cookie, which is deliberately scoped to
 * /admin; this one carries no credentials. Set on every admin login and kept
 * after logout.
 */
const OWNER_COOKIE = 'stats_exclude';

export function markOwnerDevice(c: Context<AppBindings>): void {
  setCookie(c, OWNER_COOKIE, '1', {
    path: '/',
    httpOnly: true,
    sameSite: 'Lax',
    secure: new URL(c.req.url).protocol === 'https:',
    maxAge: 365 * 86400,
  });
}

/** True when this request should never be recorded at all. */
export function optedOutOrUntracked(c: Context<AppBindings>): boolean {
  if (c.req.header('sec-gpc') === '1' || c.req.header('dnt') === '1') return true;
  if (isBot(c.req.header('user-agent'))) return true;
  if (getCookie(c, OWNER_COOKIE)) return true; // the owner browsing their own shop
  return false;
}

interface EventInput {
  type: EventType;
  viewKey?: string;
  productId?: number | null;
  quantity?: number | null;
  orderId?: number | null;
}

async function insertEvent(c: Context<AppBindings>, input: EventInput): Promise<void> {
  const env = c.env;
  const url = new URL(c.req.url);
  const ua = c.req.header('user-agent') ?? '';
  const ip = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? '0.0.0.0';
  const day = new Date().toISOString().slice(0, 10);
  const visitor = await visitorHash(await dailySalt(env, day), ip, ua);

  const detail = c.get('track') ?? {};
  const path = url.pathname.slice(0, 200);
  const referrerHost = input.type === 'view' ? referrerHostOf(c.req.header('referer')) : null;
  const source =
    input.type === 'view'
      ? classifySource({
          path,
          referrerHost,
          ownHost: url.host,
          utmSource: url.searchParams.get('utm_source'),
          utmMedium: url.searchParams.get('utm_medium'),
        })
      : 'internal';
  const campaign = detail.campaign ?? url.searchParams.get('utm_campaign')?.slice(0, 60) ?? null;
  const cf = (c.req.raw as Request & { cf?: { country?: string } }).cf;

  await env.DB.prepare(
    `INSERT INTO analytics_events
       (visitor, type, view_key, path, page_type, product_id, quantity, search_term, search_results,
        order_id, source, referrer_host, campaign, device, country)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      visitor,
      input.type,
      input.viewKey ?? null,
      path,
      pageTypeFor(path),
      input.productId ?? detail.productId ?? null,
      input.quantity ?? null,
      input.type === 'view' && detail.searchTerm ? detail.searchTerm.toLowerCase().slice(0, 80) : null,
      input.type === 'view' && detail.searchTerm ? detail.searchResults ?? null : null,
      input.orderId ?? null,
      source,
      source === 'internal' ? null : referrerHost,
      campaign,
      deviceFor(ua),
      cf?.country ?? null,
    )
    .run();
}

function runInBackground(c: Context<AppBindings>, work: Promise<void>): void {
  const guarded = work.catch((err) => console.error('analytics write failed', err instanceof Error ? err.message : err));
  try {
    c.executionCtx.waitUntil(guarded);
  } catch {
    // No execution context (tests) — the promise still runs, just unawaited.
  }
}

/** Records a basket add or checkout start. Never throws, never delays the response. */
export function trackEvent(c: Context<AppBindings>, input: Omit<EventInput, 'viewKey'>): void {
  if (optedOutOrUntracked(c)) return;
  runInBackground(c, insertEvent(c, input));
}

const TRACKED_EXCLUDE = /^\/(admin|api|media|assets|webhooks|checkout\/session)(\/|$)/;

function newViewKey(): string {
  return [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Middleware: records every successful storefront HTML page view and adds the
 * leave-beacon to the page.
 */
export async function pageViewMiddleware(c: Context<AppBindings>, next: () => Promise<void>): Promise<void> {
  await next();
  if (c.req.method !== 'GET' || c.res.status !== 200) return;
  if (!(c.res.headers.get('content-type') ?? '').includes('text/html')) return;
  if (TRACKED_EXCLUDE.test(new URL(c.req.url).pathname)) return;
  if (optedOutOrUntracked(c)) return;

  const viewKey = newViewKey();
  runInBackground(c, insertEvent(c, { type: 'view', viewKey }));
  c.res = new HTMLRewriter()
    .on('body', {
      element(el) {
        el.append(`<script>${leaveBeacon(viewKey)}</script>`, { html: true });
      },
    })
    .transform(c.res);
}

/**
 * Reports visible time and scroll depth when the page is hidden or left.
 * Sends again (with the running total) if the shopper comes back to the tab;
 * the server keeps the largest value it has seen.
 */
export function leaveBeacon(viewKey: string): string {
  return `(function(){var k="${viewKey}",v=0,t=Date.now(),s=0,on=true;function sc(){var d=document.documentElement,h=Math.max(d.scrollHeight-innerHeight,1);s=Math.max(s,Math.min(100,Math.round(scrollY/h*100)))}addEventListener("scroll",sc,{passive:true});function send(){if(on){v+=Date.now()-t;on=false}sc();try{navigator.sendBeacon("/api/beacon",k+","+v+","+s)}catch(e){}}document.addEventListener("visibilitychange",function(){if(document.visibilityState==="hidden")send();else{on=true;t=Date.now()}});addEventListener("pagehide",send)})();`;
}

/** Parses "viewKey,visibleMs,scrollPct" from the beacon; null if malformed. */
export function parseBeacon(body: string): { viewKey: string; durationMs: number; scrollPct: number } | null {
  const [viewKey, ms, pct] = body.trim().slice(0, 100).split(',');
  if (!viewKey || !/^[0-9a-f]{24}$/.test(viewKey)) return null;
  const durationMs = Number(ms);
  const scrollPct = Number(pct);
  if (!Number.isFinite(durationMs) || durationMs < 0) return null;
  return {
    viewKey,
    // Anything over 30 minutes is a forgotten tab, not reading time.
    durationMs: Math.min(Math.round(durationMs), 30 * 60 * 1000),
    scrollPct: Number.isFinite(scrollPct) ? Math.max(0, Math.min(100, Math.round(scrollPct))) : 0,
  };
}

/** Applies a beacon to its page view — only recent rows, and only ever upwards. */
export async function recordBeacon(env: Env, beacon: { viewKey: string; durationMs: number; scrollPct: number }) {
  await env.DB.prepare(
    `UPDATE analytics_events
        SET duration_ms = MAX(COALESCE(duration_ms, 0), ?),
            scroll_pct = MAX(COALESCE(scroll_pct, 0), ?)
      WHERE view_key = ? AND ts > strftime('%Y-%m-%d %H:%M:%f', 'now', '-1 day')`,
  )
    .bind(beacon.durationMs, beacon.scrollPct, beacon.viewKey)
    .run();
}

/** Deletes events past the retention window. Called once a day by the cron. */
export async function pruneAnalytics(env: Env): Promise<void> {
  await env.DB.prepare(`DELETE FROM analytics_events WHERE ts < datetime('now', ?)`)
    .bind(`-${RETENTION_DAYS} days`)
    .run();
}

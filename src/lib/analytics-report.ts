/**
 * Turns analytics_events + orders into the numbers on Admin → Analytics, and
 * the plain-English "what to do next" suggestions.
 *
 * Aggregation happens in SQL (window functions for sessions) so the Worker
 * does very little CPU work however much data there is. A "visit" is a run of
 * one anonymous visitor's activity with no gap longer than 30 minutes.
 */

import type { Env } from '../types';
import { PAGE_LABELS, SOURCE_LABELS, type Device, type PageType, type TrafficSource } from './analytics';

export const RANGE_OPTIONS = [7, 30, 90] as const;
export type RangeDays = (typeof RANGE_OPTIONS)[number];

export interface Range {
  days: RangeDays;
  start: string;
  end: string;
  prevStart: string;
}

/** SQLite-style UTC timestamp ("YYYY-MM-DD HH:MM:SS"), comparable as text with `ts`. */
export function sqlTime(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

export function rangeFor(daysRaw: unknown, now = new Date()): Range {
  const n = Number(daysRaw);
  const days = (RANGE_OPTIONS as readonly number[]).includes(n) ? (n as RangeDays) : 30;
  const ms = days * 86400_000;
  return {
    days,
    end: sqlTime(now),
    start: sqlTime(new Date(now.getTime() - ms)),
    prevStart: sqlTime(new Date(now.getTime() - 2 * ms)),
  };
}

const PAID = `('paid', 'fulfilled')`;

/**
 * Events in [?1, ?2) with a session number per visitor. Every query that
 * needs visits starts from this.
 */
const SESSIONS_CTE = `
  ev AS (
    SELECT *,
      CASE WHEN (julianday(ts) - julianday(LAG(ts) OVER (PARTITION BY visitor ORDER BY ts, id))) * 1440 <= 30
           THEN 0 ELSE 1 END AS new_visit
      FROM analytics_events
     WHERE ts >= ?1 AND ts < ?2
  ),
  s AS (
    SELECT *, SUM(new_visit) OVER (PARTITION BY visitor ORDER BY ts, id ROWS UNBOUNDED PRECEDING) AS sn
      FROM ev
  )`;

const VISITS_CTE = `${SESSIONS_CTE},
  visits AS (
    SELECT visitor, sn,
           MIN(ts) AS started,
           SUM(type = 'view') AS views,
           MAX(type = 'view' AND page_type = 'product') AS saw_product,
           MAX(type = 'add') AS added,
           MAX(type = 'checkout') AS checked_out,
           MAX(CASE WHEN type = 'checkout' AND order_id IN (SELECT id FROM orders WHERE status IN ${PAID}) THEN 1 ELSE 0 END) AS bought
      FROM s GROUP BY visitor, sn
  ),
  firsts AS (
    SELECT visitor, sn, source, device,
           ROW_NUMBER() OVER (PARTITION BY visitor, sn ORDER BY ts, id) AS rn
      FROM s
  )`;

// ---------------------------------------------------------------------------
// Report shape
// ---------------------------------------------------------------------------

export interface Funnel {
  visits: number;
  sawProduct: number;
  added: number;
  checkedOut: number;
  bought: number;
  bounces: number;
  pageViews: number;
}

export interface PeriodTotals extends Funnel {
  orders: number;
  revenuePence: number;
}

export interface DailyPoint {
  date: string;
  visits: number;
  orders: number;
}

export interface SourceRow {
  source: TrafficSource;
  label: string;
  visits: number;
  bought: number;
}

export interface DeviceRow {
  device: Device;
  visits: number;
  bought: number;
}

export interface ProductRow {
  id: number;
  title: string;
  slug: string;
  stock: number;
  pricePence: number;
  views: number;
  viewers: number;
  avgSeconds: number | null;
  avgScroll: number | null;
  adds: number;
  unitsSold: number;
  orders: number;
  revenuePence: number;
}

export interface PairRow {
  a: { id: number; title: string };
  b: { id: number; title: string };
  count: number;
}

export interface ExitRow {
  pageType: PageType;
  label: string;
  exits: number;
  views: number;
}

export interface PageTimeRow {
  pageType: PageType;
  label: string;
  avgSeconds: number;
  avgScroll: number | null;
}

export interface SearchRow {
  term: string;
  count: number;
  results: number;
}

export interface QrRow {
  code: string;
  scans: number;
  orders: number;
  revenuePence: number;
}

export interface AnalyticsReport {
  range: Range;
  current: PeriodTotals;
  previous: PeriodTotals;
  daily: DailyPoint[];
  sources: SourceRow[];
  devices: DeviceRow[];
  products: ProductRow[];
  boughtTogether: PairRow[];
  viewedTogether: PairRow[];
  exits: ExitRow[];
  pageTimes: PageTimeRow[];
  searches: SearchRow[];
  /** Page views by UK-time hour of day, 0–23. */
  hours: number[];
  /** Page views by UK-time weekday, Monday first. */
  weekdays: number[];
  qr: QrRow[];
  /** Checkout started but never paid, in this period. */
  unpaidCheckouts: number;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

async function funnelFor(env: Env, start: string, end: string): Promise<Funnel> {
  const row = await env.DB.prepare(
    `WITH ${VISITS_CTE}
     SELECT COUNT(*) AS visits,
            COALESCE(SUM(views), 0) AS pageViews,
            COALESCE(SUM(saw_product), 0) AS sawProduct,
            COALESCE(SUM(added), 0) AS added,
            COALESCE(SUM(checked_out), 0) AS checkedOut,
            COALESCE(SUM(bought), 0) AS bought,
            COALESCE(SUM(views = 1), 0) AS bounces
       FROM visits`,
  )
    .bind(start, end)
    .first<Funnel>();
  return row ?? { visits: 0, pageViews: 0, sawProduct: 0, added: 0, checkedOut: 0, bought: 0, bounces: 0 };
}

async function ordersFor(env: Env, start: string, end: string): Promise<{ orders: number; revenuePence: number }> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS orders, COALESCE(SUM(total_pence), 0) AS revenuePence
       FROM orders WHERE status IN ${PAID} AND created_at >= ?1 AND created_at < ?2`,
  )
    .bind(start, end)
    .first<{ orders: number; revenuePence: number }>();
  return row ?? { orders: 0, revenuePence: 0 };
}

async function totalsFor(env: Env, start: string, end: string): Promise<PeriodTotals> {
  const [funnel, orders] = await Promise.all([funnelFor(env, start, end), ordersFor(env, start, end)]);
  return { ...funnel, ...orders };
}

async function dailyFor(env: Env, range: Range): Promise<DailyPoint[]> {
  const [visitRows, orderRows] = await Promise.all([
    env.DB.prepare(
      `WITH ${VISITS_CTE}
       SELECT date(started) AS date, COUNT(*) AS visits FROM visits GROUP BY date(started)`,
    )
      .bind(range.start, range.end)
      .all<{ date: string; visits: number }>(),
    env.DB.prepare(
      `SELECT date(created_at) AS date, COUNT(*) AS orders FROM orders
        WHERE status IN ${PAID} AND created_at >= ?1 AND created_at < ?2 GROUP BY date(created_at)`,
    )
      .bind(range.start, range.end)
      .all<{ date: string; orders: number }>(),
  ]);
  const visits = new Map((visitRows.results ?? []).map((r) => [r.date, r.visits]));
  const orders = new Map((orderRows.results ?? []).map((r) => [r.date, r.orders]));
  const out: DailyPoint[] = [];
  const endDay = new Date(`${range.end.slice(0, 10)}T00:00:00Z`);
  for (let i = range.days - 1; i >= 0; i--) {
    const date = new Date(endDay.getTime() - i * 86400_000).toISOString().slice(0, 10);
    out.push({ date, visits: visits.get(date) ?? 0, orders: orders.get(date) ?? 0 });
  }
  return out;
}

async function sourcesAndDevices(env: Env, range: Range): Promise<{ sources: SourceRow[]; devices: DeviceRow[] }> {
  const [src, dev] = await Promise.all([
    env.DB.prepare(
      `WITH ${VISITS_CTE}
       SELECT CASE WHEN f.source = 'internal' THEN 'direct' ELSE f.source END AS source,
              COUNT(*) AS visits, COALESCE(SUM(v.bought), 0) AS bought
         FROM visits v JOIN firsts f ON f.visitor = v.visitor AND f.sn = v.sn AND f.rn = 1
        GROUP BY 1 ORDER BY visits DESC`,
    )
      .bind(range.start, range.end)
      .all<{ source: TrafficSource; visits: number; bought: number }>(),
    env.DB.prepare(
      `WITH ${VISITS_CTE}
       SELECT f.device AS device, COUNT(*) AS visits, COALESCE(SUM(v.bought), 0) AS bought
         FROM visits v JOIN firsts f ON f.visitor = v.visitor AND f.sn = v.sn AND f.rn = 1
        GROUP BY 1 ORDER BY visits DESC`,
    )
      .bind(range.start, range.end)
      .all<DeviceRow>(),
  ]);
  return {
    sources: (src.results ?? []).map((r) => ({ ...r, label: SOURCE_LABELS[r.source] ?? r.source })),
    devices: dev.results ?? [],
  };
}

async function productsFor(env: Env, range: Range): Promise<ProductRow[]> {
  const [views, adds, sold] = await Promise.all([
    env.DB.prepare(
      `SELECT product_id AS id, COUNT(*) AS views, COUNT(DISTINCT visitor) AS viewers,
              AVG(duration_ms) / 1000.0 AS avgSeconds, AVG(scroll_pct) AS avgScroll
         FROM analytics_events
        WHERE type = 'view' AND page_type = 'product' AND product_id IS NOT NULL AND ts >= ?1 AND ts < ?2
        GROUP BY product_id ORDER BY views DESC LIMIT 100`,
    )
      .bind(range.start, range.end)
      .all<{ id: number; views: number; viewers: number; avgSeconds: number | null; avgScroll: number | null }>(),
    env.DB.prepare(
      `SELECT product_id AS id, COUNT(*) AS adds
         FROM analytics_events
        WHERE type = 'add' AND product_id IS NOT NULL AND ts >= ?1 AND ts < ?2
        GROUP BY product_id`,
    )
      .bind(range.start, range.end)
      .all<{ id: number; adds: number }>(),
    env.DB.prepare(
      `SELECT oi.product_id AS id, SUM(oi.quantity) AS units, COUNT(DISTINCT o.id) AS orders,
              SUM(oi.line_total_pence) AS revenue
         FROM order_items oi JOIN orders o ON o.id = oi.order_id
        WHERE o.status IN ${PAID} AND o.created_at >= ?1 AND o.created_at < ?2 AND oi.product_id IS NOT NULL
        GROUP BY oi.product_id`,
    )
      .bind(range.start, range.end)
      .all<{ id: number; units: number; orders: number; revenue: number }>(),
  ]);

  const byId = new Map<number, ProductRow>();
  const row = (id: number): ProductRow => {
    let r = byId.get(id);
    if (!r) {
      r = { id, title: '', slug: '', stock: 0, pricePence: 0, views: 0, viewers: 0, avgSeconds: null, avgScroll: null, adds: 0, unitsSold: 0, orders: 0, revenuePence: 0 };
      byId.set(id, r);
    }
    return r;
  };
  for (const v of views.results ?? []) Object.assign(row(v.id), { views: v.views, viewers: v.viewers, avgSeconds: v.avgSeconds, avgScroll: v.avgScroll });
  for (const a of adds.results ?? []) row(a.id).adds = a.adds;
  for (const s of sold.results ?? []) Object.assign(row(s.id), { unitsSold: s.units, orders: s.orders, revenuePence: s.revenue });

  const ids = [...byId.keys()];
  if (!ids.length) return [];
  const meta = await env.DB.prepare(
    `SELECT id, title, slug, stock, price_pence FROM products WHERE id IN (${ids.map(() => '?').join(',')})`,
  )
    .bind(...ids)
    .all<{ id: number; title: string; slug: string; stock: number; price_pence: number }>();
  for (const m of meta.results ?? []) Object.assign(row(m.id), { title: m.title, slug: m.slug, stock: m.stock, pricePence: m.price_pence });

  return [...byId.values()]
    .filter((r) => r.title) // deleted products
    .sort((a, b) => b.views - a.views || b.unitsSold - a.unitsSold);
}

async function pairsFor(env: Env, range: Range): Promise<{ bought: PairRow[]; viewed: PairRow[] }> {
  const [bought, viewed] = await Promise.all([
    // All time: bundles are rare, and every one is worth seeing.
    env.DB.prepare(
      `SELECT a.product_id AS a, b.product_id AS b, COUNT(DISTINCT a.order_id) AS count
         FROM order_items a
         JOIN order_items b ON b.order_id = a.order_id AND a.product_id < b.product_id
         JOIN orders o ON o.id = a.order_id AND o.status IN ${PAID}
        GROUP BY a.product_id, b.product_id
        ORDER BY count DESC LIMIT 10`,
    ).all<{ a: number; b: number; count: number }>(),
    env.DB.prepare(
      `WITH ${SESSIONS_CTE},
       pv AS (SELECT DISTINCT visitor, sn, product_id FROM s
               WHERE type = 'view' AND page_type = 'product' AND product_id IS NOT NULL)
       SELECT x.product_id AS a, y.product_id AS b, COUNT(*) AS count
         FROM pv x JOIN pv y ON y.visitor = x.visitor AND y.sn = x.sn AND x.product_id < y.product_id
        GROUP BY x.product_id, y.product_id
       HAVING count >= 2
        ORDER BY count DESC LIMIT 10`,
    )
      .bind(range.start, range.end)
      .all<{ a: number; b: number; count: number }>(),
  ]);
  const raw = [...(bought.results ?? []), ...(viewed.results ?? [])];
  const ids = [...new Set(raw.flatMap((r) => [r.a, r.b]))];
  const titles = new Map<number, string>();
  if (ids.length) {
    const res = await env.DB.prepare(`SELECT id, title FROM products WHERE id IN (${ids.map(() => '?').join(',')})`)
      .bind(...ids)
      .all<{ id: number; title: string }>();
    for (const r of res.results ?? []) titles.set(r.id, r.title);
  }
  const toPairs = (rows: { a: number; b: number; count: number }[]) =>
    rows
      .filter((r) => titles.has(r.a) && titles.has(r.b))
      .map((r) => ({ a: { id: r.a, title: titles.get(r.a)! }, b: { id: r.b, title: titles.get(r.b)! }, count: r.count }));
  return { bought: toPairs(bought.results ?? []), viewed: toPairs(viewed.results ?? []) };
}

async function exitsAndTimes(env: Env, range: Range): Promise<{ exits: ExitRow[]; pageTimes: PageTimeRow[] }> {
  const [exits, times] = await Promise.all([
    env.DB.prepare(
      `WITH ${SESSIONS_CTE},
       views AS (
         SELECT page_type, ROW_NUMBER() OVER (PARTITION BY visitor, sn ORDER BY ts DESC, id DESC) AS rn
           FROM s WHERE type = 'view'
       )
       SELECT page_type AS pageType, SUM(rn = 1) AS exits, COUNT(*) AS views
         FROM views GROUP BY page_type ORDER BY exits DESC`,
    )
      .bind(range.start, range.end)
      .all<{ pageType: PageType; exits: number; views: number }>(),
    env.DB.prepare(
      `SELECT page_type AS pageType, AVG(duration_ms) / 1000.0 AS avgSeconds, AVG(scroll_pct) AS avgScroll
         FROM analytics_events
        WHERE type = 'view' AND duration_ms IS NOT NULL AND duration_ms > 0 AND ts >= ?1 AND ts < ?2
        GROUP BY page_type HAVING COUNT(*) >= 3 ORDER BY avgSeconds DESC`,
    )
      .bind(range.start, range.end)
      .all<{ pageType: PageType; avgSeconds: number; avgScroll: number | null }>(),
  ]);
  return {
    exits: (exits.results ?? [])
      .filter((r) => r.pageType !== 'order-complete')
      .map((r) => ({ ...r, label: PAGE_LABELS[r.pageType] ?? r.pageType })),
    pageTimes: (times.results ?? []).map((r) => ({ ...r, label: PAGE_LABELS[r.pageType] ?? r.pageType })),
  };
}

async function searchesFor(env: Env, range: Range): Promise<SearchRow[]> {
  const res = await env.DB.prepare(
    `SELECT search_term AS term, COUNT(*) AS count, MAX(search_results) AS results
       FROM analytics_events
      WHERE type = 'view' AND search_term IS NOT NULL AND ts >= ?1 AND ts < ?2
      GROUP BY search_term ORDER BY count DESC, term LIMIT 25`,
  )
    .bind(range.start, range.end)
    .all<SearchRow>();
  return res.results ?? [];
}

/** Hour of day and weekday in UK time (handles BST) for a UTC "YYYY-MM-DD HH" bucket. */
export function ukHourAndWeekday(utcHourBucket: string): { hour: number; weekday: number } {
  const d = new Date(`${utcHourBucket.replace(' ', 'T')}:00:00Z`);
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: 'numeric', hourCycle: 'h23', weekday: 'short' })
    .formatToParts(d);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0) % 24;
  const wd = parts.find((p) => p.type === 'weekday')?.value ?? 'Mon';
  return { hour, weekday: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(wd) };
}

async function timesFor(env: Env, range: Range): Promise<{ hours: number[]; weekdays: number[] }> {
  const res = await env.DB.prepare(
    `SELECT strftime('%Y-%m-%d %H', ts) AS bucket, COUNT(*) AS n
       FROM analytics_events WHERE type = 'view' AND ts >= ?1 AND ts < ?2 GROUP BY bucket`,
  )
    .bind(range.start, range.end)
    .all<{ bucket: string; n: number }>();
  const hours = new Array<number>(24).fill(0);
  const weekdays = new Array<number>(7).fill(0);
  for (const r of res.results ?? []) {
    const { hour, weekday } = ukHourAndWeekday(r.bucket);
    hours[hour] += r.n;
    if (weekday >= 0) weekdays[weekday] += r.n;
  }
  return { hours, weekdays };
}

async function qrFor(env: Env, range: Range): Promise<QrRow[]> {
  const [scans, orders] = await Promise.all([
    env.DB.prepare(
      `SELECT COALESCE(campaign, 'QR10') AS code, COUNT(*) AS scans
         FROM analytics_events
        WHERE type = 'view' AND page_type = 'qr' AND ts >= ?1 AND ts < ?2
        GROUP BY 1`,
    )
      .bind(range.start, range.end)
      .all<{ code: string; scans: number }>(),
    env.DB.prepare(
      `SELECT coupon_code AS code, COUNT(*) AS orders, COALESCE(SUM(total_pence), 0) AS revenue
         FROM orders WHERE status IN ${PAID} AND coupon_code IS NOT NULL AND created_at >= ?1 AND created_at < ?2
        GROUP BY coupon_code`,
    )
      .bind(range.start, range.end)
      .all<{ code: string; orders: number; revenue: number }>(),
  ]);
  const rows = new Map<string, QrRow>();
  for (const s of scans.results ?? []) rows.set(s.code, { code: s.code, scans: s.scans, orders: 0, revenuePence: 0 });
  for (const o of orders.results ?? []) {
    const r = rows.get(o.code) ?? { code: o.code, scans: 0, orders: 0, revenuePence: 0 };
    r.orders = o.orders;
    r.revenuePence = o.revenue;
    rows.set(o.code, r);
  }
  return [...rows.values()].sort((a, b) => b.orders - a.orders || b.scans - a.scans);
}

async function unpaidCheckoutsFor(env: Env, range: Range): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM orders WHERE status IN ('pending', 'cancelled') AND created_at >= ?1 AND created_at < ?2`,
  )
    .bind(range.start, range.end)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function getAnalyticsReport(env: Env, range: Range): Promise<AnalyticsReport> {
  const [current, previous, daily, sd, products, pairs, et, searches, times, qr, unpaidCheckouts] = await Promise.all([
    totalsFor(env, range.start, range.end),
    totalsFor(env, range.prevStart, range.start),
    dailyFor(env, range),
    sourcesAndDevices(env, range),
    productsFor(env, range),
    pairsFor(env, range),
    exitsAndTimes(env, range),
    searchesFor(env, range),
    timesFor(env, range),
    qrFor(env, range),
    unpaidCheckoutsFor(env, range),
  ]);
  return {
    range,
    current,
    previous,
    daily,
    sources: sd.sources,
    devices: sd.devices,
    products,
    boughtTogether: pairs.bought,
    viewedTogether: pairs.viewed,
    exits: et.exits,
    pageTimes: et.pageTimes,
    searches,
    hours: times.hours,
    weekdays: times.weekdays,
    qr,
    unpaidCheckouts,
  };
}

// ---------------------------------------------------------------------------
// Suggestions
// ---------------------------------------------------------------------------

export interface Suggestion {
  /** Higher = shown first. */
  weight: number;
  title: string;
  detail: string;
  href?: string;
  linkText?: string;
}

export function pct(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0;
}

const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

function hourLabel(h: number): string {
  const suffix = h < 12 ? 'am' : 'pm';
  const twelve = h % 12 === 0 ? 12 : h % 12;
  return `${twelve}${suffix}`;
}

/**
 * Rule-based advice from the report. Every rule needs enough data to be
 * meaningful, so a quiet week produces fewer suggestions rather than noise.
 */
export function buildSuggestions(r: AnalyticsReport): Suggestion[] {
  const out: Suggestion[] = [];
  const cur = r.current;

  // Popular but not selling.
  for (const p of r.products.filter((p) => p.views >= 15 && p.unitsSold === 0).slice(0, 2)) {
    out.push({
      weight: 90 + Math.min(p.views, 100) / 10,
      title: `“${p.title}” gets looked at but isn't selling`,
      detail: `${p.views} views and no sales in the last ${r.range.days} days. Compare the price with eBay, and check the photos and description answer the obvious questions (size, scent, what's in the box).`,
      href: `/admin/products/${p.id}`,
      linkText: 'Edit product',
    });
  }

  // Added to basket, then abandoned.
  for (const p of r.products.filter((p) => p.adds >= 3 && p.unitsSold * 2 < p.adds).slice(0, 1)) {
    out.push({
      weight: 85,
      title: `People add “${p.title}” to their basket, then don't buy`,
      detail: `Added ${p.adds} times, bought ${p.unitsSold}. Something at the basket puts them off — often the total. A small QR discount or a cheaper multi-buy on this item can tip it.`,
      href: `/admin/coupons/new`,
      linkText: 'Make a coupon',
    });
  }

  // Best sellers running low.
  for (const p of r.products.filter((p) => p.unitsSold >= 2 && p.stock <= 3).slice(0, 2)) {
    out.push({
      weight: 95,
      title: `Restock “${p.title}”`,
      detail: `It sold ${p.unitsSold} in the last ${r.range.days} days and only ${p.stock} ${p.stock === 1 ? 'is' : 'are'} left. Running out loses the sale and the visit.`,
      href: `/admin/products/${p.id}`,
      linkText: 'Update stock',
    });
  }

  // Searches with no results.
  const missed = r.searches.filter((s) => s.results === 0 && s.count >= 2).slice(0, 3);
  if (missed.length) {
    out.push({
      weight: 88,
      title: 'Shoppers are searching for things they can’t find',
      detail: `${missed.map((s) => `“${s.term}” (${s.count}×)`).join(', ')} found nothing. Stock it, or add that word to the title or description of the closest product you do sell.`,
      href: '/admin/products',
      linkText: 'Go to products',
    });
  }

  // Leaks in the funnel.
  if (cur.added >= 5 && cur.checkedOut / cur.added < 0.5) {
    out.push({
      weight: 80,
      title: 'Most baskets never reach the payment page',
      detail: `Only ${pct(cur.checkedOut, cur.added)}% of visits that added something went on to checkout. Make sure delivery time and the free-delivery promise are obvious on the basket page, and that the checkout button is easy to find on a phone.`,
    });
  }
  if (r.unpaidCheckouts >= 3 && cur.checkedOut > 0 && cur.bought / cur.checkedOut < 0.6) {
    out.push({
      weight: 78,
      title: `${r.unpaidCheckouts} people reached payment but didn't pay`,
      detail: 'Some of them left an email at the payment page. The Open baskets list has a resume link for each — a friendly nudge often wins the sale back.',
      href: '/admin/orders?view=baskets',
      linkText: 'See open baskets',
    });
  }
  if (cur.visits >= 30 && pct(cur.bounces, cur.visits) >= 60) {
    const topExit = r.exits[0];
    out.push({
      weight: 70,
      title: `${pct(cur.bounces, cur.visits)}% of visits look at one page and leave`,
      detail: topExit
        ? `The page people leave from most is the ${topExit.label.toLowerCase()}. Put your best sellers and the 10% QR offer where they're seen straight away.`
        : 'Put your best sellers and the 10% QR offer where they are seen straight away.',
    });
  }

  // Bundles.
  const pair = r.boughtTogether.find((p) => p.count >= 2);
  if (pair) {
    out.push({
      weight: 75,
      title: 'Customers buy these together — try a bundle',
      detail: `“${pair.a.title}” and “${pair.b.title}” have been bought in the same order ${pair.count} times. A small bundle discount or a mention on each product page can make that the default.`,
    });
  }

  // Best source.
  const withSales = r.sources.filter((s) => s.visits >= 10);
  if (withSales.length >= 2) {
    const best = [...withSales].sort((a, b) => b.bought / b.visits - a.bought / a.visits)[0];
    if (best.bought > 0) {
      out.push({
        weight: 60,
        title: `Your best customers come from: ${best.label}`,
        detail: `${pct(best.bought, best.visits)}% of those visits end in an order, against ${pct(cur.bought, cur.visits)}% overall. Put more effort there${best.source === 'qr' ? ' — keep a QR card in every parcel' : ''}.`,
      });
    }
  }

  // Timing.
  const totalViews = r.hours.reduce((a, b) => a + b, 0);
  if (totalViews >= 100) {
    let bestStart = 0;
    let bestSum = -1;
    for (let h = 0; h < 24; h++) {
      const sum = r.hours[h] + r.hours[(h + 1) % 24] + r.hours[(h + 2) % 24];
      if (sum > bestSum) {
        bestSum = sum;
        bestStart = h;
      }
    }
    const bestDay = r.weekdays.indexOf(Math.max(...r.weekdays));
    out.push({
      weight: 40,
      title: `Busiest time: ${WEEKDAY_NAMES[bestDay]}s, ${hourLabel(bestStart)}–${hourLabel((bestStart + 3) % 24)}`,
      detail: 'Add new stock and start offers just before then, so the most people see them fresh.',
    });
  }

  return out.sort((a, b) => b.weight - a.weight).slice(0, 6);
}

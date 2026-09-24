import { Hono } from 'hono';
import type { FC } from 'hono/jsx';
import type { AppBindings } from '../../types';
import { getAdmin } from '../../lib/admin-auth';
import { AdminLayout } from '../../ui/admin-layout';
import { formatPence } from '../../lib/money';
import { RETENTION_DAYS, markOwnerDevice } from '../../lib/analytics';
import {
  RANGE_OPTIONS,
  buildSuggestions,
  getAnalyticsReport,
  pct,
  rangeFor,
  type AnalyticsReport,
  type PairRow,
  type PeriodTotals,
  type ProductRow,
} from '../../lib/analytics-report';

/**
 * Admin → Analytics: what shoppers do on the site, in plain English, with a
 * "what to do next" list at the top. All figures come from
 * src/lib/analytics-report.ts; nothing here queries the database directly.
 */
export const analytics = new Hono<AppBindings>();

// ---------------------------------------------------------------------------
// Small formatting helpers
// ---------------------------------------------------------------------------

const n = (v: number) => v.toLocaleString('en-GB');

function duration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return '—';
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

function shortDate(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function hourName(h: number): string {
  if (h === 0) return '12am';
  if (h === 12) return '12pm';
  return h < 12 ? `${h}am` : `${h - 12}pm`;
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

/** Change vs the previous period. Direction is spelled out, never colour alone. */
const Delta: FC<{ now: number; before: number; days: number; lowerIsBetter?: boolean }> = ({ now, before, days, lowerIsBetter }) => {
  if (before === 0 && now === 0) return <div class="stat-sub">No data for the previous {days} days</div>;
  if (before === 0) return <div class="stat-sub">New — none in the previous {days} days</div>;
  const change = Math.round(((now - before) / before) * 100);
  if (change === 0) return <div class="stat-sub">Same as the previous {days} days</div>;
  const good = lowerIsBetter ? change < 0 : change > 0;
  return (
    <div class={`stat-sub an-delta ${good ? 'an-delta-good' : 'an-delta-bad'}`}>
      {change > 0 ? '▲ Up' : '▼ Down'} {Math.abs(change)}% vs previous {days} days
    </div>
  );
};

const Tile: FC<{ label: string; value: string; children?: unknown }> = ({ label, value, children }) => (
  <div class="stat-tile">
    <div class="stat-label">{label}</div>
    <div class="stat-value">{value}</div>
    {children}
  </div>
);

interface Bar {
  label: string;
  value: number;
  /** Full sentence for hover, focus and screen readers. */
  describe: string;
}

/**
 * Single-series column chart in plain HTML/CSS: one hue, 4px rounded tops on
 * a shared baseline, hover/focus readout via title + aria-label, and a table
 * twin so no value depends on hovering.
 */
const ColumnChart: FC<{ bars: Bar[]; caption: string; axisLabels: string[] }> = ({ bars, caption, axisLabels }) => {
  const max = Math.max(1, ...bars.map((b) => b.value));
  return (
    <figure class="an-chart">
      <div class="an-cols" role="list" aria-label={caption}>
        {bars.map((b) => (
          <div class="an-col-slot" role="listitem" tabindex={0} title={b.describe} aria-label={b.describe}>
            <div class={`an-col ${b.value === 0 ? 'an-col-zero' : ''}`} style={`--v:${(b.value / max) * 100}%`} />
          </div>
        ))}
      </div>
      <div class="an-axis" aria-hidden="true">
        {axisLabels.map((l) => (
          <span>{l}</span>
        ))}
      </div>
      <details class="an-table-toggle">
        <summary>Show as a table</summary>
        <div class="admin-table-wrap">
          <table class="admin-table">
            <tbody>
              {bars.map((b) => (
                <tr>
                  <td>{b.label}</td>
                  <td class="num">{n(b.value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
};

/** A labelled horizontal meter, for rows in a ranked list. */
const Meter: FC<{ value: number; max: number }> = ({ value, max }) => (
  <span class="an-meter" aria-hidden="true">
    {value > 0 && max > 0 ? <span style={`--v:${(value / max) * 100}%`} /> : null}
  </span>
);

const Funnel: FC<{ t: PeriodTotals }> = ({ t }) => {
  const steps = [
    { label: 'Visited the shop', verb: 'visit', value: t.visits },
    { label: 'Looked at a product', verb: 'look at a product', value: t.sawProduct },
    { label: 'Added to basket', verb: 'add something to the basket', value: t.added },
    { label: 'Went to payment', verb: 'go to the payment page', value: t.checkedOut },
    { label: 'Paid', verb: 'pay', value: t.bought },
  ];
  // Biggest drop between two steps, named in plain words under the chart.
  let worst = -1;
  let worstLoss = 0;
  for (let i = 1; i < steps.length; i++) {
    const prev = steps[i - 1].value;
    const loss = prev > 0 ? 1 - steps[i].value / prev : 0;
    if (prev >= 5 && loss > worstLoss) {
      worstLoss = loss;
      worst = i;
    }
  }
  return (
    <div class="stack">
      <ol class="an-funnel">
        {steps.map((s, i) => (
          <li>
            <div class="an-funnel-head">
              <span>{s.label}</span>
              <strong>
                {n(s.value)}
                {i > 0 ? <span class="faint"> · {pct(s.value, t.visits)}%</span> : null}
              </strong>
            </div>
            <Meter value={s.value} max={t.visits} />
          </li>
        ))}
      </ol>
      {worst > 0 ? (
        <p class="an-callout">
          Biggest drop: <strong>{Math.round(worstLoss * 100)}%</strong> of visits that{' '}
          {steps[worst - 1].label.toLowerCase()} didn't go on to {steps[worst].verb}.
        </p>
      ) : null}
    </div>
  );
};

function productBadges(p: ProductRow): { text: string; kind: 'ok' | 'warn' | 'bad' }[] {
  const out: { text: string; kind: 'ok' | 'warn' | 'bad' }[] = [];
  if (p.unitsSold >= 2 && p.stock <= 3) out.push({ text: `Low stock (${p.stock})`, kind: 'bad' });
  if (p.views >= 15 && p.unitsSold === 0) out.push({ text: 'Viewed, not bought', kind: 'warn' });
  if (p.adds >= 3 && p.unitsSold * 2 < p.adds) out.push({ text: 'Left in baskets', kind: 'warn' });
  if (p.views >= 5 && p.unitsSold / p.viewers >= 0.1) out.push({ text: 'Converts well', kind: 'ok' });
  return out;
}

const PairList: FC<{ pairs: PairRow[]; noun: string }> = ({ pairs, noun }) => (
  <ul class="an-pairs">
    {pairs.map((p) => (
      <li>
        <span class="an-pair-names">
          <a href={`/admin/products/${p.a.id}`}>{p.a.title}</a>
          <span class="faint"> + </span>
          <a href={`/admin/products/${p.b.id}`}>{p.b.title}</a>
        </span>
        <span class="pill">
          {n(p.count)} {p.count === 1 ? noun.replace(/s$/, '') : noun}
        </span>
      </li>
    ))}
  </ul>
);

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function Report({ r }: { r: AnalyticsReport }) {
  const cur = r.current;
  const prev = r.previous;
  const days = r.range.days;
  const tips = buildSuggestions(r);
  const conv = pct(cur.bought, cur.visits);
  const prevConv = pct(prev.bought, prev.visits);
  const aov = cur.orders ? Math.round(cur.revenuePence / cur.orders) : 0;
  const prevAov = prev.orders ? Math.round(prev.revenuePence / prev.orders) : 0;
  const abandon = pct(cur.added - cur.bought, cur.added);
  const prevAbandon = pct(prev.added - prev.bought, prev.added);

  const dailyBars: Bar[] = r.daily.map((d) => ({
    label: shortDate(d.date),
    value: d.visits,
    describe: `${shortDate(d.date)}: ${n(d.visits)} visit${d.visits === 1 ? '' : 's'}, ${n(d.orders)} order${d.orders === 1 ? '' : 's'}`,
  }));
  const dailyAxis = r.daily.length
    ? [shortDate(r.daily[0].date), shortDate(r.daily[Math.floor(r.daily.length / 2)].date), shortDate(r.daily[r.daily.length - 1].date)]
    : [];
  const hourBars: Bar[] = r.hours.map((v, h) => ({ label: hourName(h), value: v, describe: `${hourName(h)}–${hourName((h + 1) % 24)}: ${n(v)} page views` }));
  const dayBars: Bar[] = r.weekdays.map((v, i) => ({ label: WEEKDAYS[i], value: v, describe: `${WEEKDAYS[i]}: ${n(v)} page views` }));

  const maxSource = Math.max(0, ...r.sources.map((s) => s.visits));
  const maxExit = Math.max(0, ...r.exits.map((e) => e.exits));
  const totalExits = r.exits.reduce((a, e) => a + e.exits, 0);
  const deviceTotal = r.devices.reduce((a, d) => a + d.visits, 0);
  const products = r.products.slice(0, 20);

  return (
    <>
      <div class="admin-panel an-tips">
        <h3>What to do next</h3>
        {tips.length ? (
          <ol class="an-tip-list">
            {tips.map((t) => (
              <li>
                <strong>{t.title}</strong>
                <p>{t.detail}</p>
                {t.href ? <a href={t.href}>{t.linkText ?? 'Open'} →</a> : null}
              </li>
            ))}
          </ol>
        ) : (
          <p class="muted">
            No suggestions yet — they appear once there's enough activity to spot a pattern (a few days of
            visits usually does it).
          </p>
        )}
      </div>

      <div class="stat-grid">
        <Tile label="Visits" value={n(cur.visits)}>
          <Delta now={cur.visits} before={prev.visits} days={days} />
        </Tile>
        <Tile label="Visits that bought" value={`${conv}%`}>
          <Delta now={conv} before={prevConv} days={days} />
        </Tile>
        <Tile label="Orders" value={n(cur.orders)}>
          <Delta now={cur.orders} before={prev.orders} days={days} />
        </Tile>
        <Tile label="Revenue" value={formatPence(cur.revenuePence)}>
          <Delta now={cur.revenuePence} before={prev.revenuePence} days={days} />
        </Tile>
        <Tile label="Average order" value={aov ? formatPence(aov) : '—'}>
          <Delta now={aov} before={prevAov} days={days} />
        </Tile>
        <Tile label="Baskets not bought" value={cur.added ? `${abandon}%` : '—'}>
          <Delta now={abandon} before={prevAbandon} days={days} lowerIsBetter />
        </Tile>
      </div>

      <div class="admin-panel">
        <h3>Visits per day</h3>
        <ColumnChart bars={dailyBars} caption={`Visits per day, last ${days} days`} axisLabels={dailyAxis} />
      </div>

      <div class="admin-grid cols-2">
        <div class="admin-panel">
          <h3>From visit to sale</h3>
          <p class="muted small">Out of every visit, how many got to each step.</p>
          <Funnel t={cur} />
        </div>

        <div class="admin-panel">
          <h3>Where visitors come from</h3>
          {r.sources.length ? (
            <ul class="an-ranked">
              {r.sources.map((s) => (
                <li>
                  <div class="an-ranked-head">
                    <span>{s.label}</span>
                    <span>
                      <strong>{n(s.visits)}</strong>{' '}
                      <span class="faint">
                        visit{s.visits === 1 ? '' : 's'} · {pct(s.bought, s.visits)}% bought
                      </span>
                    </span>
                  </div>
                  <Meter value={s.visits} max={maxSource} />
                </li>
              ))}
            </ul>
          ) : (
            <p class="muted">No visits yet.</p>
          )}
          {deviceTotal > 0 ? (
            <p class="an-callout">
              {r.devices.map((d, i) => (
                <>
                  {i > 0 ? ' · ' : ''}
                  <strong>{pct(d.visits, deviceTotal)}%</strong> on {d.device === 'mobile' ? 'phones' : d.device === 'tablet' ? 'tablets' : 'computers'}
                  {d.visits >= 10 ? <span class="faint"> ({pct(d.bought, d.visits)}% bought)</span> : null}
                </>
              ))}
            </p>
          ) : null}
        </div>
      </div>

      <div class="admin-panel">
        <h3>Products</h3>
        <p class="muted small">
          What people looked at, added to the basket and bought in the last {days} days. Time and scroll show how
          closely the product page was read.
        </p>
        {products.length ? (
          <ul class="an-products">
            {products.map((p) => (
              <li>
                <div class="an-product-head">
                  <a href={`/admin/products/${p.id}`}>{p.title}</a>
                  <span class="an-badges">
                    {productBadges(p).map((b) => (
                      <span class={`pill pill-${b.kind}`}>{b.text}</span>
                    ))}
                  </span>
                </div>
                <div class="an-product-stats">
                  <span>
                    <strong>{n(p.views)}</strong> view{p.views === 1 ? '' : 's'}
                  </span>
                  <span>
                    <strong>{n(p.adds)}</strong> added to basket
                  </span>
                  <span>
                    <strong>{n(p.unitsSold)}</strong> sold
                  </span>
                  {p.avgSeconds !== null ? (
                    <span class="faint">
                      read for {duration(p.avgSeconds)}
                      {p.avgScroll !== null ? `, ${Math.round(p.avgScroll)}% of the page` : ''}
                    </span>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p class="muted">No product views or sales in this period yet.</p>
        )}
      </div>

      <div class="admin-grid cols-2">
        <div class="admin-panel">
          <h3>Bought together</h3>
          <p class="muted small">Products that appear in the same order (all time). Good candidates for a bundle.</p>
          {r.boughtTogether.length ? <PairList pairs={r.boughtTogether} noun="orders" /> : <p class="muted">No orders with more than one product yet.</p>}
        </div>
        <div class="admin-panel">
          <h3>Looked at together</h3>
          <p class="muted small">Products viewed in the same visit — people comparing, or interested in both.</p>
          {r.viewedTogether.length ? <PairList pairs={r.viewedTogether} noun="visits" /> : <p class="muted">Not enough visits yet.</p>}
        </div>
      </div>

      <div class="admin-grid cols-2">
        <div class="admin-panel">
          <h3>Where people leave</h3>
          <p class="muted small">Share of visits that ended on each kind of page.</p>
          {r.exits.length ? (
            <ul class="an-ranked">
              {r.exits.filter((e) => e.exits > 0).slice(0, 8).map((e) => (
                <li>
                  <div class="an-ranked-head">
                    <span>{e.label}</span>
                    <strong>{pct(e.exits, totalExits)}%</strong>
                  </div>
                  <Meter value={e.exits} max={maxExit} />
                  <div class="an-ranked-note">
                    {pct(e.exits, e.views)}% of people who saw this page left from it
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p class="muted">No visits yet.</p>
          )}
          {r.pageTimes.length ? (
            <>
              <h3 class="an-subhead">Time spent on each kind of page</h3>
              <div class="admin-table-wrap">
                <table class="admin-table">
                  <tbody>
                    {r.pageTimes.map((t) => (
                      <tr>
                        <td>{t.label}</td>
                        <td class="num">{duration(t.avgSeconds)}</td>
                        <td class="num faint">{t.avgScroll === null ? '' : `${Math.round(t.avgScroll)}% scrolled`}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}
        </div>

        <div class="admin-panel">
          <h3>What people search for</h3>
          {r.searches.length ? (
            <div class="admin-table-wrap">
              <table class="admin-table">
                <thead>
                  <tr>
                    <th>Search</th>
                    <th class="num">Times</th>
                    <th class="num">Results</th>
                  </tr>
                </thead>
                <tbody>
                  {r.searches.map((s) => (
                    <tr>
                      <td>
                        {s.term}
                        {s.results === 0 ? <span class="pill pill-bad an-inline-pill">Nothing found</span> : null}
                      </td>
                      <td class="num">{n(s.count)}</td>
                      <td class="num">{n(s.results)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p class="muted">Nobody has used the search box in this period.</p>
          )}
        </div>
      </div>

      <div class="admin-grid cols-2">
        <div class="admin-panel">
          <h3>Busiest times of day</h3>
          <p class="muted small">Page views by hour, UK time.</p>
          <ColumnChart bars={hourBars} caption="Page views by hour of day" axisLabels={['12am', '6am', '12pm', '6pm', '11pm']} />
        </div>
        <div class="admin-panel">
          <h3>Busiest days</h3>
          <p class="muted small">Page views by day of the week.</p>
          <ColumnChart bars={dayBars} caption="Page views by day of the week" axisLabels={WEEKDAYS} />
        </div>
      </div>

      <div class="admin-panel">
        <h3>QR cards &amp; coupon codes</h3>
        <p class="muted small">Scans of each card's landing page, and paid orders that used the code.</p>
        {r.qr.length ? (
          <div class="admin-table-wrap">
            <table class="admin-table">
              <thead>
                <tr>
                  <th>Code</th>
                  <th class="num">Scans</th>
                  <th class="num">Orders</th>
                  <th class="num">Revenue</th>
                </tr>
              </thead>
              <tbody>
                {r.qr.map((q) => (
                  <tr>
                    <td>{q.code}</td>
                    <td class="num">{n(q.scans)}</td>
                    <td class="num">{n(q.orders)}</td>
                    <td class="num">{formatPence(q.revenuePence)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p class="muted">No QR scans or coupon orders in this period.</p>
        )}
      </div>

      <p class="field-hint an-footnote">
        Counted without cookies or tracking scripts: visitors are anonymous and can't be identified or followed
        between days, and anyone with "Do Not Track" or Global Privacy Control switched on isn't counted. Your own
        shop browsing isn't counted on any device you've logged in to admin from. Detailed records are kept for {RETENTION_DAYS} days.
      </p>
    </>
  );
}

analytics.get('/', async (c) => {
  const admin = getAdmin(c);
  const range = rangeFor(c.req.query('days'));
  // Sessions that predate this feature never got the cookie at login.
  markOwnerDevice(c);
  const report = await getAnalyticsReport(c.env, range);
  const empty = report.current.pageViews === 0 && report.previous.pageViews === 0;

  return c.html(
    <AdminLayout title="Analytics" active="analytics" admin={admin}>
      <div class="admin-head">
        <div>
          <h1>Analytics</h1>
          <p class="muted">What shoppers do on the site, and what to do about it.</p>
        </div>
      </div>

      <nav class="admin-tabs" aria-label="Time period">
        {RANGE_OPTIONS.map((d) => (
          <a href={`/admin/analytics?days=${d}`} class={range.days === d ? 'active' : ''} aria-current={range.days === d ? 'page' : undefined}>
            Last {d} days
          </a>
        ))}
      </nav>

      {empty ? (
        <p class="notice notice-warn">
          No visits recorded yet. Tracking starts from the moment this was switched on, so give it a day or two
          of shoppers — orders and "bought together" below already use your full order history.
        </p>
      ) : null}

      <Report r={report} />
    </AdminLayout>,
  );
});

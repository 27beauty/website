import { Hono } from 'hono';
import type { AppBindings, EbayAccount } from '../../types';
import { getAdmin, verifyCsrf } from '../../lib/admin-auth';
import { AdminLayout, CsrfField, Guide } from '../../ui/admin-layout';
import { getProductById, listProductChoices } from '../../lib/db';
import { signPayload, verifyPayload } from '../../lib/crypto';
import { getSetting, setSetting } from '../../lib/settings';
import { consentUrl, exchangeConsentCode, forgetUserToken, getUserAccessToken } from '../../lib/ebay/oauth';
import { outOfStockControlEnabled, tokenUserId } from '../../lib/ebay/trading';
import {
  Budget,
  countListingsToReview,
  getChannelListing,
  disableCentralStock,
  enableCentralStock,
  importAmazonListings,
  importEbayListings,
  listingsToReview,
  pushSoon,
  readiness,
  resolveListing,
  runStockJob,
  suggestionsFor,
  takeStartingStock,
  type StockJobSummary,
} from '../../lib/channels';

/**
 * Admin → Stock → Sales channels: connect each eBay shop and Amazon, check
 * the listings are matched to the right products, take the starting count,
 * then switch the website on as the master stock for every channel.
 */
export const channels = new Hono<AppBindings>();

/** Outbound requests an admin action may spend: Workers Free's 50, less 6 for tokens and retries. */
const ACTION_BUDGET = 44;

function flashOf(c: { req: { query: (k: string) => string | undefined } }) {
  return { msg: c.req.query('msg') ?? null, err: c.req.query('err') ?? null };
}

function back(path: string, kind: 'msg' | 'err', text: string): string {
  return `${path}${path.includes('?') ? '&' : '?'}${kind}=${encodeURIComponent(text)}`;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function csrfOk(c: Parameters<typeof verifyCsrf>[0]): Promise<boolean> {
  const body = await c.req.parseBody();
  return verifyCsrf(c, typeof body._csrf === 'string' ? body._csrf : undefined);
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

channels.get('/', async (c) => {
  const admin = getAdmin(c);
  const flash = flashOf(c);
  const [r, lastRun, cursors, oos] = await Promise.all([
    readiness(c.env),
    getSetting<StockJobSummary | null>(c.env, 'stock.last_run', null),
    c.env.DB.prepare('SELECT * FROM channel_cursors ORDER BY channel, account').all<{
      channel: string;
      account: string;
      last_run_at: string | null;
      last_error: string | null;
    }>(),
    getSetting<Record<string, boolean>>(c.env, 'stock.ebay_oos_control', {}),
  ]);
  const cursorFor = (channel: string, account: string) =>
    (cursors.results ?? []).find((x) => x.channel === channel && x.account === account);
  const runeConfigured = Boolean(c.env.EBAY_RUNAME);

  const Step = ({ n, done, title, children }: { n: number; done: boolean; title: string; children?: unknown }) => (
    <li class={`ch-step ${done ? 'ch-step-done' : ''}`}>
      <span class="ch-step-n" aria-hidden="true">
        {done ? '✓' : n}
      </span>
      <div class="ch-step-body">
        <strong>
          {title}
          {done ? <span class="sr-only"> (done)</span> : null}
        </strong>
        {children}
      </div>
    </li>
  );

  return c.html(
    <AdminLayout title="Sales channels" active="stock" admin={admin} msg={flash.msg} err={flash.err}>
      <div class="admin-head">
        <div>
          <h1>Sales channels</h1>
          <p class="muted">One stock count for the website, both eBay shops and Amazon.</p>
        </div>
        <div class="actions">
          <a class="btn btn-secondary btn-sm" href="/admin/stock">
            ← Stock
          </a>
        </div>
      </div>

      <div class={`admin-panel ch-status ${r.enabled ? 'ch-status-on' : ''}`}>
        <h3>
          Centralised stock is <span class={`pill ${r.enabled ? 'pill-ok' : 'pill-warn'}`}>{r.enabled ? 'ON' : 'OFF'}</span>
        </h3>
        {r.enabled ? (
          <p>
            Sales on the website, eBay and Amazon (orders you ship yourself) all come off the same count, and every
            change is sent to each listing. Marketplace orders are checked every 5 minutes.
          </p>
        ) : (
          <p>
            Until this is on, stock works as before: the eBay sync copies eBay's numbers in. Follow the steps below,
            then switch it on.
          </p>
        )}
        {lastRun ? (
          <p class="faint small">
            Last check {lastRun.at.slice(0, 16).replace('T', ' ')} UTC · {lastRun.sales} sale(s) · {lastRun.pushed} listing(s)
            updated{lastRun.corrected ? ` · ${lastRun.corrected} double-counted sale(s) put back` : ''}
            {lastRun.revived ? ` · ${lastRun.revived} sold-out listing(s) re-linked` : ''}
            {lastRun.filled ? ` · ${lastRun.filled} Amazon draft(s) filled in` : ''}
            {lastRun.failed ? ` · ${lastRun.failed} failed` : ''}
            {lastRun.left ? ` · ${lastRun.left} waiting` : ''}
            {lastRun.errors.length ? <span class="ch-error"> · {lastRun.errors.join(' · ')}</span> : null}
          </p>
        ) : null}
        <div class="row">
          {r.enabled ? (
            <>
              <form method="post" action="/admin/channels/run">
                <CsrfField token={admin.csrf} />
                <button class="btn btn-secondary btn-sm" type="submit">
                  Check now
                </button>
              </form>
              <form method="post" action="/admin/channels/disable">
                <CsrfField token={admin.csrf} />
                <button class="btn btn-danger btn-sm" type="submit">
                  Switch off
                </button>
              </form>
            </>
          ) : null}
        </div>
      </div>

      <ol class="ch-steps">
        <Step n={1} done={r.ebayShops.length > 0 && r.ebayShops.every((s) => s.connected)} title="Connect each eBay shop">
          <p class="muted small">
            You'll be sent to eBay to sign in <em>as that shop</em> and allow access. If you're signed in to the other
            shop, eBay asks you to sign in again.
          </p>
          {!runeConfigured ? (
            <p class="notice notice-warn">
              Waiting on the eBay RuName (see the setup notes). Until it's set, shops can't be connected.
            </p>
          ) : null}
          <ul class="ch-list">
            {r.ebayShops.map((s) => (
              <EbayShopRow
                account={s.account}
                connected={s.connected}
                listings={s.listings}
                oos={oos[s.account.seller_username ?? ''] ?? null}
                cursor={cursorFor('ebay', s.account.seller_username ?? '')}
                csrf={admin.csrf}
                canConnect={runeConfigured}
              />
            ))}
          </ul>
        </Step>

        <Step n={2} done={r.amazonConfigured && r.amazonListings > 0} title="Connect Amazon">
          {r.amazonConfigured ? (
            <div class="ch-row">
              <span>
                {r.amazonListings} listing{r.amazonListings === 1 ? '' : 's'} imported. Only ones you ship yourself (FBM) share
                stock; FBA listings are shown but never changed.
              </span>
              <form method="post" action="/admin/channels/amazon/import">
                <CsrfField token={admin.csrf} />
                <button class="btn btn-secondary btn-sm" type="submit">
                  {r.amazonListings ? 'Re-import listings' : 'Import listings'}
                </button>
              </form>
            </div>
          ) : (
            <p class="muted small">
              Not set up yet — needs the Amazon client secret, refresh token and merchant token (see the setup notes).
              You can switch on without Amazon and add it later.
            </p>
          )}
        </Step>

        <Step n={3} done={r.toReview === 0 && r.ebayShops.some((s) => s.listings > 0)} title="Check the matches">
          {r.toReview ? (
            <p>
              <strong>{r.toReview}</strong> listing{r.toReview === 1 ? '' : 's'} couldn't be matched with certainty.{' '}
              <a href="/admin/channels/review">Review them →</a>
            </p>
          ) : (
            <p class="muted small">Nothing waiting. Exact duplicates are merged automatically.</p>
          )}
        </Step>

        <Step n={4} done={Boolean(r.startTakenAt)} title="Take the starting count">
          <p class="muted small">
            Sets every product's stock to what its listing shows on eBay/Amazon right now (the higher number if an
            item is listed twice). Check the numbers on the Stock screen afterwards.
          </p>
          {r.startTakenAt ? <p class="faint small">Taken {r.startTakenAt.slice(0, 16).replace('T', ' ')} UTC.</p> : null}
          <form method="post" action="/admin/channels/start">
            <CsrfField token={admin.csrf} />
            <button class="btn btn-secondary btn-sm" type="submit" disabled={!r.canTakeStart}>
              {r.startTakenAt ? 'Take it again' : 'Take starting count'}
            </button>
          </form>
        </Step>

        <Step n={5} done={r.enabled} title="Switch on">
          <p class="muted small">
            From then on the website is the master count. Sales anywhere come off it; changes you make are sent to
            every listing.
          </p>
          <form method="post" action="/admin/channels/enable">
            <CsrfField token={admin.csrf} />
            <button class="btn btn-accent" type="submit" disabled={!r.canEnable}>
              Switch on centralised stock
            </button>
          </form>
        </Step>
      </ol>
    </AdminLayout>,
  );
});

function EbayShopRow(props: {
  account: EbayAccount;
  connected: boolean;
  listings: number;
  oos: boolean | null;
  cursor?: { last_run_at: string | null; last_error: string | null };
  csrf: string;
  canConnect: boolean;
}) {
  const a = props.account;
  return (
    <li>
      <div class="ch-row">
        <span>
          <strong>{a.label}</strong> <span class={`pill ${props.connected ? 'pill-ok' : 'pill-warn'}`}>{props.connected ? 'connected' : 'not connected'}</span>
          <span class="faint small">
            {' '}
            · {props.listings} listing{props.listings === 1 ? '' : 's'}
            {props.cursor?.last_run_at ? ` · orders checked ${props.cursor.last_run_at} UTC` : ''}
          </span>
        </span>
        <span class="row">
          {props.connected ? (
            <form method="post" action={`/admin/channels/ebay/${a.id}/import`}>
              <input type="hidden" name="_csrf" value={props.csrf} />
              <button class="btn btn-secondary btn-sm" type="submit">
                Re-read listings
              </button>
            </form>
          ) : null}
          {props.canConnect ? (
            <a class="btn btn-sm" href={`/admin/channels/ebay/connect?account=${a.id}`}>
              {props.connected ? 'Reconnect' : 'Connect'}
            </a>
          ) : null}
        </span>
      </div>
      {props.connected && props.oos === false ? (
        <p class="notice notice-bad">
          Out-of-stock control is <strong>off</strong> in this shop. Turn it on (Seller Hub → Site preferences →
          Selling) or a listing that reaches 0 will be ended instead of hidden.
        </p>
      ) : null}
      {props.cursor?.last_error ? <p class="notice notice-warn small">{props.cursor.last_error}</p> : null}
    </li>
  );
}

// ---------------------------------------------------------------------------
// eBay connect
// ---------------------------------------------------------------------------

interface ConsentState {
  accountId: number;
  exp: number;
}

channels.get('/ebay/connect', async (c) => {
  const id = Number(c.req.query('account'));
  const account = await c.env.DB.prepare('SELECT id FROM ebay_accounts WHERE id = ?').bind(id).first();
  if (!account) return c.redirect(back('/admin/channels', 'err', 'Unknown eBay shop.'), 303);
  try {
    const state = await signPayload({ accountId: id, exp: Date.now() + 15 * 60_000 } satisfies ConsentState, c.env.SESSION_SECRET);
    return c.redirect(consentUrl(c.env, state), 302);
  } catch (err) {
    return c.redirect(back('/admin/channels', 'err', errorText(err)), 303);
  }
});

/** eBay sends the owner back here (the RuName's "accepted URL") after they allow access. */
channels.get('/ebay/callback', async (c) => {
  const state = await verifyPayload<ConsentState>(c.req.query('state'), c.env.SESSION_SECRET);
  const code = c.req.query('code');
  if (!state || state.exp < Date.now()) {
    return c.redirect(back('/admin/channels', 'err', 'That eBay sign-in link expired — press Connect again.'), 303);
  }
  if (!code) return c.redirect(back('/admin/channels', 'err', 'eBay access was not granted.'), 303);

  const account = await c.env.DB.prepare('SELECT * FROM ebay_accounts WHERE id = ?').bind(state.accountId).first<EbayAccount>();
  if (!account) return c.redirect(back('/admin/channels', 'err', 'Unknown eBay shop.'), 303);

  try {
    const { encryptedRefreshToken, accessToken } = await exchangeConsentCode(c.env, code);
    // Guard against signing in as the other shop by mistake.
    const userId = await tokenUserId(accessToken);
    if (account.seller_username && userId && userId.toLowerCase() !== account.seller_username.toLowerCase()) {
      return c.redirect(
        back('/admin/channels', 'err', `You signed in to eBay as "${userId}", but this is the "${account.seller_username}" shop. Nothing was saved — press Connect and sign in as ${account.seller_username}.`),
        303,
      );
    }
    await c.env.DB.prepare(
      `UPDATE ebay_accounts SET refresh_token_enc = ?, connected_at = datetime('now'), seller_username = COALESCE(seller_username, ?) WHERE id = ?`,
    )
      .bind(encryptedRefreshToken, userId, account.id)
      .run();
    await forgetUserToken(c.env, account);

    const fresh = (await c.env.DB.prepare('SELECT * FROM ebay_accounts WHERE id = ?').bind(account.id).first<EbayAccount>()) as EbayAccount;
    const budget = new Budget(ACTION_BUDGET);
    const imported = await importEbayListings(c.env, fresh, budget);
    const oos = await outOfStockControlEnabled(accessToken).catch(() => null);
    if (oos !== null && fresh.seller_username) {
      const map = await getSetting<Record<string, boolean>>(c.env, 'stock.ebay_oos_control', {});
      map[fresh.seller_username] = oos;
      await setSetting(c.env, 'stock.ebay_oos_control', map);
    }
    return c.redirect(
      back(
        '/admin/channels',
        'msg',
        `Connected ${fresh.label}: read ${imported.listings} listing(s)${imported.review ? `, ${imported.review} to review` : ''}.${imported.complete ? '' : ' More will be read on the next check.'}`,
      ),
      303,
    );
  } catch (err) {
    return c.redirect(back('/admin/channels', 'err', `eBay: ${errorText(err)}`), 303);
  }
});

channels.post('/ebay/:id/import', async (c) => {
  if (!(await csrfOk(c))) return c.redirect(back('/admin/channels', 'err', 'Your session expired — please try again.'), 303);
  const account = await c.env.DB.prepare('SELECT * FROM ebay_accounts WHERE id = ?').bind(Number(c.req.param('id'))).first<EbayAccount>();
  if (!account) return c.redirect(back('/admin/channels', 'err', 'Unknown eBay shop.'), 303);
  try {
    const r = await importEbayListings(c.env, account, new Budget(ACTION_BUDGET));
    const token = await getUserAccessToken(c.env, account);
    if (token && account.seller_username) {
      const oos = await outOfStockControlEnabled(token).catch(() => null);
      if (oos !== null) {
          const map = await getSetting<Record<string, boolean>>(c.env, 'stock.ebay_oos_control', {});
        map[account.seller_username] = oos;
        await setSetting(c.env, 'stock.ebay_oos_control', map);
      }
    }
    return c.redirect(back('/admin/channels', 'msg', `${account.label}: read ${r.listings} listing(s), ${r.added} new, ${r.review} to review.`), 303);
  } catch (err) {
    return c.redirect(back('/admin/channels', 'err', `eBay: ${errorText(err)}`), 303);
  }
});

channels.post('/amazon/import', async (c) => {
  if (!(await csrfOk(c))) return c.redirect(back('/admin/channels', 'err', 'Your session expired — please try again.'), 303);
  try {
    const r = await importAmazonListings(c.env, new Budget(ACTION_BUDGET));
    return c.redirect(
      back('/admin/channels', 'msg', `Amazon: read ${r.listings} listing(s), ${r.added} new, ${r.review} to review.${r.complete ? '' : ' The rest will be read over the next hourly checks.'}`),
      303,
    );
  } catch (err) {
    return c.redirect(back('/admin/channels', 'err', `Amazon: ${errorText(err)}`), 303);
  }
});

// ---------------------------------------------------------------------------
// Go-live
// ---------------------------------------------------------------------------

channels.post('/start', async (c) => {
  if (!(await csrfOk(c))) return c.redirect(back('/admin/channels', 'err', 'Your session expired — please try again.'), 303);
  const r = await readiness(c.env);
  if (!r.canTakeStart) return c.redirect(back('/admin/channels', 'err', 'Connect every eBay shop first.'), 303);
  const n = await takeStartingStock(c.env);
  return c.redirect(back('/admin/stock?view=all', 'msg', `Starting count set for ${n} product(s). Check the numbers below, then switch on from Sales channels.`), 303);
});

channels.post('/enable', async (c) => {
  if (!(await csrfOk(c))) return c.redirect(back('/admin/channels', 'err', 'Your session expired — please try again.'), 303);
  try {
    await enableCentralStock(c.env);
    return c.redirect(back('/admin/channels', 'msg', 'Centralised stock is on. The website is now the master count for every channel.'), 303);
  } catch (err) {
    return c.redirect(back('/admin/channels', 'err', errorText(err)), 303);
  }
});

channels.post('/disable', async (c) => {
  if (!(await csrfOk(c))) return c.redirect(back('/admin/channels', 'err', 'Your session expired — please try again.'), 303);
  await disableCentralStock(c.env);
  return c.redirect(back('/admin/channels', 'msg', 'Centralised stock is off. Nothing is sent to eBay or Amazon until you switch it back on.'), 303);
});

channels.post('/run', async (c) => {
  if (!(await csrfOk(c))) return c.redirect(back('/admin/channels', 'err', 'Your session expired — please try again.'), 303);
  const s = await runStockJob(c.env);
  return c.redirect(
    back('/admin/channels', s.errors.length ? 'err' : 'msg', `Checked: ${s.sales} sale(s), ${s.pushed} listing(s) updated.${s.errors.length ? ` Problems: ${s.errors.join(' · ')}` : ''}`),
    303,
  );
});

// ---------------------------------------------------------------------------
// Review matches
// ---------------------------------------------------------------------------

/** The three kinds of listing, as the owner thinks of them. */
type ListingKind = 'ebay' | 'fba' | 'fbm';
function kindOf(l: { channel: string; fulfilment: string }): ListingKind {
  return l.channel === 'ebay' ? 'ebay' : l.fulfilment === 'amazon' ? 'fba' : 'fbm';
}

const REVIEW_PAGE_SIZE = 30;

channels.get('/review', async (c) => {
  const admin = getAdmin(c);
  const flash = flashOf(c);
  const [rows, total, allProducts] = await Promise.all([
    listingsToReview(c.env, REVIEW_PAGE_SIZE),
    countListingsToReview(c.env),
    listProductChoices(c.env),
  ]);
  const withSuggestions = await Promise.all(rows.map(async (l) => ({ l, suggestions: await suggestionsFor(c.env, l) })));

  return c.html(
    <AdminLayout title="Review matches" active="stock" admin={admin} msg={flash.msg} err={flash.err}>
      <div class="admin-head">
        <div>
          <h1>Review matches</h1>
          <p class="muted">
            {total ? `${total} waiting.` : 'Nothing waiting.'}
            {total > rows.length ? ` Showing ${rows.length}; the rest appear as you decide these.` : ''}
          </p>
        </div>
        <a class="btn btn-secondary btn-sm" href="/admin/channels">
          ← Sales channels
        </a>
      </div>

      {total ? (
        <Guide
          what="These eBay and Amazon listings couldn't be matched to a website product for certain."
          why="Matching by title alone can't always tell sizes, packs or shades apart. Until you decide, each one is left alone: not counted and not updated."
          choices={[
            { label: 'Same item — link', effect: 'it becomes part of that product.' },
            { label: 'Add as new product', effect: 'creates a draft product on the website, not on sale yet.' },
            { label: 'Different items', effect: 'eBay only: keeps two similar products apart.' },
            { label: "Don't track", effect: 'ignored for good. Never counted or updated.' },
          ]}
        />
      ) : (
        <div class="admin-panel">
          <p>All done — every listing is matched or set aside.</p>
        </div>
      )}

      <datalist id="all-products">
        {allProducts.map((p) => (
          <option value={`${p.title} — #${p.id}`}>{p.status === 'active' ? '' : p.status}</option>
        ))}
      </datalist>

      <ul class="ch-review">
        {withSuggestions.map(({ l, suggestions }) => {
          const kind = kindOf(l);
          const where = kind === 'ebay' ? 'eBay' : 'Amazon';
          const top = suggestions[0];
          const why = l.product_id
            ? 'This eBay listing already has its own product, and it looks like the same item as another one you have.'
            : top
              ? `The closest website product is ${Math.round(top.score * 100)}% similar: close, but not certain.`
              : 'Nothing on the website looks like this item.';
          const linkEffect =
            kind === 'fba'
              ? "Shown on that product for reference. Amazon holds this stock, so your count doesn't change."
              : l.product_id
                ? 'Merged into one product with one count (the higher quantity is kept).'
                : `One shared count: this ${where} listing's quantity will follow the website's.`;
          const newEffect =
            kind === 'fba'
              ? "Draft product with no stock (Amazon holds it). Its price, photo and description are filled in from Amazon within a few minutes."
              : kind === 'fbm'
                ? `Draft product starting at ${l.channel_qty ?? 0} in stock, shared with this listing. Price, photo and description follow from Amazon within minutes.`
                : `Draft product starting at ${l.channel_qty ?? 0} in stock, shared with this listing.`;
          return (
            <li class="admin-panel">
              <div class="ch-review-head">
                <span class="pill">{kind === 'ebay' ? `eBay · ${l.account}` : 'Amazon'}</span>
                {kind === 'fba' ? <span class="pill pill-warn">FBA · Amazon ships it · never shares your count</span> : null}
                {kind === 'fbm' ? <span class="pill pill-ok">FBM · you ship it · shares your count once linked</span> : null}
                {l.channel_qty !== null ? <span class="faint small">{where} shows {l.channel_qty} in stock</span> : null}
              </div>
              <p class="ch-review-title">
                <strong>{l.title}</strong>
                {l.sku ? <span class="faint small"> · SKU {l.sku}</span> : null}
              </p>
              <p class="muted small ch-why">
                <strong>Why it's here:</strong> {why}
              </p>
              <form method="post" action={`/admin/channels/review/${l.id}`} class="stack">
                <CsrfField token={admin.csrf} />
                <div class="ch-options">
                  {suggestions.map((s, i) => (
                    <label class="quote-option">
                      <input type="radio" name="product_id" value={String(s.id)} checked={i === 0} />
                      <span class="quote-main">
                        <span class="quote-name">{s.title}</span>
                        <span class="quote-meta">{Math.round(s.score * 100)}% similar</span>
                      </span>
                    </label>
                  ))}
                  <label class="quote-option">
                    <input type="radio" name="product_id" value="other" checked={!suggestions.length} />
                    <span class="quote-main">
                      <span class="quote-name">A different product</span>
                      <input
                        class="ch-other"
                        type="text"
                        name="other_product"
                        list="all-products"
                        placeholder="Start typing a product name…"
                        aria-label={`Choose a different product for ${l.title}`}
                      />
                    </span>
                  </label>
                </div>
                <div class="ch-actions">
                  <div class="ch-action">
                    <button class="btn btn-sm" type="submit" name="action" value="link">
                      Same item — link
                    </button>
                    <span>{linkEffect}</span>
                  </div>
                  {l.product_id ? (
                    <div class="ch-action">
                      <button class="btn btn-secondary btn-sm" type="submit" name="action" value="keep">
                        Different items
                      </button>
                      <span>Both stay as separate products, each with its own count.</span>
                    </div>
                  ) : (
                    <div class="ch-action">
                      <button class="btn btn-secondary btn-sm" type="submit" name="action" value="new">
                        Add as new product
                      </button>
                      <span>{newEffect}</span>
                    </div>
                  )}
                  <div class="ch-action">
                    <button class="btn btn-secondary btn-sm" type="submit" name="action" value="ignore">
                      Don't track
                    </button>
                    <span>Ignored for good: never counted or updated.</span>
                  </div>
                </div>
              </form>
            </li>
          );
        })}
      </ul>
    </AdminLayout>,
  );
});

/** "Title — #123" from the type-to-search box, or a bare number. */
export function productIdFromChoice(value: unknown): number {
  const text = typeof value === 'string' ? value.trim() : '';
  const m = /#(\d+)\s*$/.exec(text) ?? /^(\d+)$/.exec(text);
  return m ? Number(m[1]) : NaN;
}

channels.post('/review/:id', async (c) => {
  const body = await c.req.parseBody();
  if (!verifyCsrf(c, typeof body._csrf === 'string' ? body._csrf : undefined)) {
    return c.redirect(back('/admin/channels/review', 'err', 'Your session expired — please try again.'), 303);
  }
  const id = Number(c.req.param('id'));
  const action = String(body.action ?? '');
  const productId =
    body.product_id === 'other' ? productIdFromChoice(body.other_product ?? body.other_id) : Number(body.product_id);
  try {
    const listing = await getChannelListing(c.env, id);
    if (!listing) throw new Error('That listing no longer exists.');
    const kind = kindOf(listing);
    const where = kind === 'ebay' ? 'eBay' : 'Amazon';
    let moved: number[];
    let done: string;
    if (action === 'link') {
      if (!Number.isInteger(productId) || productId <= 0) {
        throw new Error('Choose a product first: pick a suggestion, or type a product name and choose it from the list.');
      }
      const product = await getProductById(c.env, productId);
      if (!product) throw new Error('That product no longer exists.');
      moved = await resolveListing(c.env, id, { type: 'link', productId });
      done =
        kind === 'fba'
          ? `Linked to "${product.title}" for reference. Your stock count is unchanged.`
          : `Linked to "${product.title}". It now shares one stock count with this ${where} listing.`;
    } else if (action === 'keep') {
      moved = await resolveListing(c.env, id, { type: 'keep' });
      done = 'Kept as separate products.';
    } else if (action === 'new') {
      moved = await resolveListing(c.env, id, { type: 'new' });
      done = `Added "${listing.title}" as a draft product. It isn't on sale until you publish it (Products → Drafts).`;
    } else if (action === 'ignore') {
      moved = await resolveListing(c.env, id, { type: 'ignore' });
      done = `Set aside "${listing.title}". It won't be counted or updated.`;
    } else {
      throw new Error('Unknown action.');
    }
    pushSoon(c.env, c.executionCtx, moved);
    return c.redirect(back('/admin/channels/review', 'msg', done), 303);
  } catch (err) {
    return c.redirect(back('/admin/channels/review', 'err', errorText(err)), 303);
  }
});

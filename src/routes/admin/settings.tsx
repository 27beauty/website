import { Hono } from 'hono';
import type { AppBindings, EbayAccount, SyncRun } from '../../types';
import { getAdmin, validateNewPassword, verifyCsrf } from '../../lib/admin-auth';
import { AdminLayout, CsrfField } from '../../ui/admin-layout';
import { getAllSettings, setSetting } from '../../lib/settings';
import { hashPassword, verifyPassword } from '../../lib/crypto';
import { runEbaySync } from '../../lib/ebay/sync';
import { formatBytes, getMediaUsage, recalculateUsage } from '../../lib/media';
import { clampInt } from '../../lib/util';

/** Store settings, eBay accounts, sync control, secret status, own password. */
export const settings = new Hono<AppBindings>();

function flashOf(c: { req: { query: (k: string) => string | undefined } }) {
  return { msg: c.req.query('msg') ?? null, err: c.req.query('err') ?? null };
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function asNumber(v: unknown, fallback: number): number {
  const n = Number(str(v).replace(/[£,\s]/g, ''));
  return Number.isFinite(n) ? n : fallback;
}

const SECRET_KEYS = [
  'SESSION_SECRET',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'EBAY_CLIENT_ID',
  'EBAY_CLIENT_SECRET',
  'PARCEL2GO_CLIENT_ID',
  'PARCEL2GO_CLIENT_SECRET',
] as const;

settings.get('/', async (c) => {
  const admin = getAdmin(c);
  const flash = flashOf(c);
  const mediaUsage = await getMediaUsage(c.env);
  const [s, accountsRes, runsRes] = await Promise.all([
    getAllSettings(c.env),
    c.env.DB.prepare('SELECT * FROM ebay_accounts ORDER BY id ASC').all<EbayAccount>(),
    c.env.DB.prepare('SELECT * FROM sync_runs ORDER BY started_at DESC LIMIT 20').all<SyncRun>(),
  ]);
  const accounts = accountsRes.results ?? [];
  const runs = runsRes.results ?? [];

  return c.html(
    <AdminLayout title="Settings" active="settings" admin={admin} msg={flash.msg} err={flash.err}>
      <div class="admin-head">
        <h1>Settings</h1>
      </div>

      <form method="post" action="/admin/settings" class="admin-panel stack">
        <CsrfField token={admin.csrf} />
        <h3>Store</h3>
        <div class="admin-grid cols-2">
          <div class="field">
            <label for="store_name">Store name</label>
            <input id="store_name" name="store_name" type="text" value={String(s['store.name'] ?? '')} />
          </div>
          <div class="field">
            <label for="store_tagline">Tagline</label>
            <input id="store_tagline" name="store_tagline" type="text" value={String(s['store.tagline'] ?? '')} />
          </div>
          <div class="field">
            <label for="store_email">Contact email</label>
            <input id="store_email" name="store_email" type="email" value={String(s['store.email'] ?? '')} />
          </div>
          <div class="field">
            <label for="store_phone">Contact phone</label>
            <input id="store_phone" name="store_phone" type="text" value={String(s['store.phone'] ?? '')} />
          </div>
        </div>
        <div class="field">
          <label for="store_address">Contact address</label>
          <textarea id="store_address" name="store_address" rows={2}>
            {String(s['store.address'] ?? '')}
          </textarea>
        </div>

        <h3>Shipping &amp; checkout</h3>
        <div class="admin-grid cols-3">
          <div class="field">
            <label for="shipping_flat">Flat shipping (£)</label>
            <input
              id="shipping_flat"
              name="shipping_flat"
              type="text"
              value={(asNumber(s['shipping.flat_pence'], 349) / 100).toFixed(2)}
            />
          </div>
          <div class="field">
            <label for="shipping_free">Free delivery threshold (£, 0 = off)</label>
            <input
              id="shipping_free"
              name="shipping_free"
              type="text"
              value={(asNumber(s['shipping.free_threshold_pence'], 0) / 100).toFixed(2)}
            />
          </div>
          <div class="field">
            <label for="coupon_default_percent">Default QR coupon %</label>
            <input
              id="coupon_default_percent"
              name="coupon_default_percent"
              type="number"
              min="0"
              max="100"
              value={String(asNumber(s['coupon.default_percent'], 10))}
            />
          </div>
        </div>
        <div class="admin-grid cols-3">
          <div class="checkbox-row field">
            <input id="checkout_enabled" type="checkbox" name="checkout_enabled" value="1" checked={s['checkout.enabled'] !== false} />
            <label for="checkout_enabled">Checkout enabled</label>
          </div>
          <div class="checkbox-row field">
            <input id="ebay_sync_enabled" type="checkbox" name="ebay_sync_enabled" value="1" checked={Boolean(s['ebay.sync_enabled'])} />
            <label for="ebay_sync_enabled">eBay sync enabled</label>
          </div>
          <div class="checkbox-row field">
            <input id="ebay_auto_publish" type="checkbox" name="ebay_auto_publish" value="1" checked={s['ebay.auto_publish'] !== false} />
            <label for="ebay_auto_publish">Auto-publish new eBay listings</label>
          </div>
          <div class="checkbox-row field">
            <input id="parcel2go_enabled" type="checkbox" name="parcel2go_enabled" value="1" checked={Boolean(s['parcel2go.enabled'])} />
            <label for="parcel2go_enabled">Book shipping with Parcel2Go from order pages</label>
          </div>
        </div>
        <div class="field" style="max-width:220px;">
          <label for="ebay_markup_percent">eBay markup %</label>
          <input
            id="ebay_markup_percent"
            name="ebay_markup_percent"
            type="number"
            min="0"
            value={String(asNumber(s['ebay.markup_percent'], 0))}
          />
        </div>

        <h3>Parcel2Go default parcel size</h3>
        <p class="muted">
          Used for any product without its own parcel size (set on each product's edit page). You can
          still adjust the parcel on each order before getting quotes.
        </p>
        <div class="admin-grid cols-4">
          <div class="field">
            <label for="p2g_weight">Weight (kg)</label>
            <input id="p2g_weight" name="p2g_weight" type="number" step="0.1" min="0.1"
              value={String(asNumber(s['parcel2go.default_weight_kg'], 1))} />
          </div>
          <div class="field">
            <label for="p2g_length">Length (cm)</label>
            <input id="p2g_length" name="p2g_length" type="number" min="1"
              value={String(asNumber(s['parcel2go.default_length_cm'], 30))} />
          </div>
          <div class="field">
            <label for="p2g_width">Width (cm)</label>
            <input id="p2g_width" name="p2g_width" type="number" min="1"
              value={String(asNumber(s['parcel2go.default_width_cm'], 20))} />
          </div>
          <div class="field">
            <label for="p2g_height">Height (cm)</label>
            <input id="p2g_height" name="p2g_height" type="number" min="1"
              value={String(asNumber(s['parcel2go.default_height_cm'], 5))} />
          </div>
        </div>

        <button class="btn" type="submit">
          Save settings
        </button>
      </form>

      <div class="admin-panel">
        <h3>Image storage</h3>
        <p class="muted">
          Product photos live in Cloudflare R2. Cloudflare gives 10&nbsp;GB free but has no hard
          spending cap, so the shop enforces its own limit and refuses uploads that would cross it.
        </p>
        <div class="usage-bar" role="img"
             aria-label={`${mediaUsage.percentUsed}% of the image storage limit used`}>
          <span
            class={`usage-fill${mediaUsage.percentUsed >= 90 ? ' usage-fill-bad' : mediaUsage.percentUsed >= 70 ? ' usage-fill-warn' : ''}`}
            style={`width:${Math.max(mediaUsage.percentUsed, 2)}%`}
          />
        </div>
        <p>
          <strong>
            {formatBytes(mediaUsage.bytesUsed)} of {formatBytes(mediaUsage.budgetBytes)}
          </strong>{' '}
          used across {mediaUsage.objectCount} image{mediaUsage.objectCount === 1 ? '' : 's'} —{' '}
          {formatBytes(mediaUsage.remainingBytes)} left.
        </p>
        <form method="post" action="/admin/settings/media" class="row">
          <CsrfField token={admin.csrf} />
          <div class="field" style="margin-bottom:0">
            <label for="media_budget_mb">Limit (MB)</label>
            <input
              id="media_budget_mb"
              name="media_budget_mb"
              type="number"
              min="10"
              max="8192"
              step="10"
              value={String(Math.round(mediaUsage.budgetBytes / (1024 * 1024)))}
            />
            <p class="field-hint">
              Capped at 8&nbsp;GB so it always stays inside Cloudflare's free 10&nbsp;GB.
            </p>
          </div>
          <button class="btn btn-secondary" type="submit" name="action" value="save">
            Save limit
          </button>
          <button class="btn btn-secondary" type="submit" name="action" value="recount">
            Recount from R2
          </button>
        </form>
      </div>

      <div class="admin-panel">
        <h3>Secrets</h3>
        <p class="muted">Configured via <code>wrangler secret put</code>. Values are never shown here.</p>
        {SECRET_KEYS.map((key) => (
          <div class="secret-status">
            <span>{key}</span>
            {c.env[key] ? <span class="secret-set">set</span> : <span class="secret-unset">not set</span>}
          </div>
        ))}
      </div>

      <div class="admin-panel">
        <div class="admin-head" style="margin-bottom:10px;">
          <h3 style="margin:0;">eBay accounts</h3>
        </div>
        <div class="admin-table-wrap">
          <table class="admin-table">
            <thead>
              <tr>
                <th>Label</th>
                <th>Seller</th>
                <th>Mode</th>
                <th class="num">Markup %</th>
                <th>Auto-publish</th>
                <th>Active</th>
                <th>Last sync</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <tr>
                  <td>
                    <form method="post" action={`/admin/settings/ebay-accounts/${a.id}`} class="row" style="gap:6px;">
                      <CsrfField token={admin.csrf} />
                      <input type="text" name="label" value={a.label} style="min-width:110px;" />
                      <input type="text" name="seller_username" value={a.seller_username ?? ''} placeholder="username" style="min-width:110px;" />
                      <select name="mode">
                        <option value="browse" selected={a.mode === 'browse'}>
                          browse
                        </option>
                        <option value="sell" selected={a.mode === 'sell'}>
                          sell
                        </option>
                      </select>
                      <input type="number" name="markup_percent" value={a.markup_percent} style="width:70px;" />
                      <label class="checkbox-row" style="margin:0;">
                        <input type="checkbox" name="auto_publish" value="1" checked={a.auto_publish === 1} /> auto
                      </label>
                      <label class="checkbox-row" style="margin:0;">
                        <input type="checkbox" name="active" value="1" checked={a.active === 1} /> active
                      </label>
                      <button class="btn btn-sm btn-secondary" type="submit">
                        Save
                      </button>
                    </form>
                  </td>
                  <td class="faint">{a.seller_username ?? '—'}</td>
                  <td>{a.mode}</td>
                  <td class="num">{a.markup_percent}</td>
                  <td>{a.auto_publish ? 'yes' : 'no'}</td>
                  <td>{a.active ? 'yes' : 'no'}</td>
                  <td class="faint">{a.last_sync_at ?? 'never'}</td>
                  <td>
                    <form method="post" action={`/admin/settings/ebay-accounts/${a.id}/delete`}>
                      <CsrfField token={admin.csrf} />
                      <button class="btn btn-sm btn-danger" type="submit">
                        Delete
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <h4 style="margin-top:16px;">Add an account</h4>
        <form method="post" action="/admin/settings/ebay-accounts" class="admin-grid cols-3">
          <CsrfField token={admin.csrf} />
          <div class="field">
            <label for="new_label">Label</label>
            <input id="new_label" name="label" type="text" required />
          </div>
          <div class="field">
            <label for="new_seller">Seller username</label>
            <input id="new_seller" name="seller_username" type="text" />
          </div>
          <div class="field">
            <label for="new_mode">Mode</label>
            <select id="new_mode" name="mode">
              <option value="browse">browse</option>
              <option value="sell">sell</option>
            </select>
          </div>
          <div class="field" style="align-self:end;">
            <button class="btn btn-secondary" type="submit">
              Add account
            </button>
          </div>
        </form>
      </div>

      <div class="admin-panel">
        <div class="admin-head" style="margin-bottom:10px;">
          <h3 style="margin:0;">eBay sync</h3>
          <form method="post" action="/admin/settings/sync">
            <CsrfField token={admin.csrf} />
            <button class="btn" type="submit">
              Sync now
            </button>
          </form>
        </div>
        <div class="admin-table-wrap">
          <table class="admin-table">
            <thead>
              <tr>
                <th>Started</th>
                <th>Trigger</th>
                <th>Status</th>
                <th class="num">Created</th>
                <th class="num">Updated</th>
                <th class="num">Ended</th>
                <th>Message</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr>
                  <td class="nowrap">{r.started_at}</td>
                  <td>{r.trigger}</td>
                  <td>
                    <span class={`pill ${r.status === 'ok' ? 'pill-ok' : r.status === 'error' ? 'pill-bad' : 'pill-warn'}`}>{r.status}</span>
                  </td>
                  <td class="num">{r.created_count}</td>
                  <td class="num">{r.updated_count}</td>
                  <td class="num">{r.ended_count}</td>
                  <td class="faint">{r.message ?? ''}</td>
                </tr>
              ))}
              {!runs.length ? (
                <tr>
                  <td colSpan={7} class="center muted" style="padding:24px;">
                    No sync runs yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>
    </AdminLayout>,
  );
});

settings.post('/', async (c) => {
  const body = await c.req.parseBody();
  if (!verifyCsrf(c, typeof body._csrf === 'string' ? body._csrf : undefined)) {
    return c.redirect('/admin/settings?err=' + encodeURIComponent('Your session expired — please try again.'), 303);
  }
  await Promise.all([
    setSetting(c.env, 'store.name', str(body.store_name) || '27beauty'),
    setSetting(c.env, 'store.tagline', str(body.store_tagline)),
    setSetting(c.env, 'store.email', str(body.store_email)),
    setSetting(c.env, 'store.phone', str(body.store_phone)),
    setSetting(c.env, 'store.address', str(body.store_address)),
    setSetting(c.env, 'shipping.flat_pence', Math.round(asNumber(body.shipping_flat, 3.49) * 100)),
    setSetting(c.env, 'shipping.free_threshold_pence', Math.round(asNumber(body.shipping_free, 0) * 100)),
    setSetting(c.env, 'checkout.enabled', body.checkout_enabled === '1'),
    setSetting(c.env, 'ebay.sync_enabled', body.ebay_sync_enabled === '1'),
    setSetting(c.env, 'ebay.auto_publish', body.ebay_auto_publish === '1'),
    setSetting(c.env, 'ebay.markup_percent', Math.max(0, asNumber(body.ebay_markup_percent, 0))),
    setSetting(c.env, 'coupon.default_percent', Math.min(100, Math.max(0, asNumber(body.coupon_default_percent, 10)))),
    setSetting(c.env, 'parcel2go.enabled', body.parcel2go_enabled === '1'),
    setSetting(c.env, 'parcel2go.default_weight_kg', Math.max(0.1, asNumber(body.p2g_weight, 1))),
    setSetting(c.env, 'parcel2go.default_length_cm', Math.max(1, asNumber(body.p2g_length, 30))),
    setSetting(c.env, 'parcel2go.default_width_cm', Math.max(1, asNumber(body.p2g_width, 20))),
    setSetting(c.env, 'parcel2go.default_height_cm', Math.max(1, asNumber(body.p2g_height, 5))),
  ]);
  return c.redirect('/admin/settings?msg=' + encodeURIComponent('Settings saved.'), 303);
});

/** Image storage budget: save the cap, or recount actual usage from R2. */
settings.post('/media', async (c) => {
  const body = await c.req.parseBody();
  if (!verifyCsrf(c, typeof body._csrf === 'string' ? body._csrf : undefined)) {
    return c.redirect('/admin/settings?err=' + encodeURIComponent('Your session expired — please try again.'), 303);
  }

  if (body.action === 'recount') {
    const usage = await recalculateUsage(c.env);
    return c.redirect(
      '/admin/settings?msg=' +
        encodeURIComponent(
          `Recounted: ${formatBytes(usage.bytesUsed)} across ${usage.objectCount} image${
            usage.objectCount === 1 ? '' : 's'
          }.`,
        ),
      303,
    );
  }

  // 8 GB ceiling, so the limit itself can never be set past the free tier.
  const mb = clampInt(body.media_budget_mb, 10, 8192, 1024);
  await setSetting(c.env, 'media.max_bytes', mb * 1024 * 1024);
  return c.redirect(
    '/admin/settings?msg=' + encodeURIComponent(`Image storage limit set to ${formatBytes(mb * 1024 * 1024)}.`),
    303,
  );
});

settings.post('/ebay-accounts', async (c) => {
  const body = await c.req.parseBody();
  if (!verifyCsrf(c, typeof body._csrf === 'string' ? body._csrf : undefined)) {
    return c.redirect('/admin/settings?err=' + encodeURIComponent('Your session expired — please try again.'), 303);
  }
  const label = str(body.label).trim();
  if (!label) return c.redirect('/admin/settings?err=' + encodeURIComponent('Label is required.'), 303);
  await c.env.DB.prepare('INSERT INTO ebay_accounts (label, seller_username, mode) VALUES (?, ?, ?)')
    .bind(label, str(body.seller_username).trim() || null, str(body.mode) === 'sell' ? 'sell' : 'browse')
    .run();
  return c.redirect('/admin/settings?msg=' + encodeURIComponent('Account added.'), 303);
});

settings.post('/ebay-accounts/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.parseBody();
  if (!verifyCsrf(c, typeof body._csrf === 'string' ? body._csrf : undefined)) {
    return c.redirect('/admin/settings?err=' + encodeURIComponent('Your session expired — please try again.'), 303);
  }
  await c.env.DB.prepare(
    `UPDATE ebay_accounts SET label = ?, seller_username = ?, mode = ?, markup_percent = ?, auto_publish = ?, active = ? WHERE id = ?`,
  )
    .bind(
      str(body.label).trim() || 'Account',
      str(body.seller_username).trim() || null,
      str(body.mode) === 'sell' ? 'sell' : 'browse',
      asNumber(body.markup_percent, 0),
      body.auto_publish === '1' ? 1 : 0,
      body.active === '1' ? 1 : 0,
      id,
    )
    .run();
  return c.redirect('/admin/settings?msg=' + encodeURIComponent('Account updated.'), 303);
});

settings.post('/ebay-accounts/:id/delete', async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.parseBody();
  if (!verifyCsrf(c, typeof body._csrf === 'string' ? body._csrf : undefined)) {
    return c.redirect('/admin/settings?err=' + encodeURIComponent('Your session expired — please try again.'), 303);
  }
  await c.env.DB.prepare('DELETE FROM ebay_accounts WHERE id = ?').bind(id).run();
  return c.redirect('/admin/settings?msg=' + encodeURIComponent('Account removed.'), 303);
});

settings.post('/sync', async (c) => {
  const body = await c.req.parseBody();
  if (!verifyCsrf(c, typeof body._csrf === 'string' ? body._csrf : undefined)) {
    return c.redirect('/admin/settings?err=' + encodeURIComponent('Your session expired — please try again.'), 303);
  }
  const result = await runEbaySync(c.env, 'manual');
  const summary = `Sync finished: ${result.created} created, ${result.updated} updated, ${result.ended} ended.`;
  if (result.errors.length) {
    return c.redirect(
      '/admin/settings?err=' + encodeURIComponent(`${summary} Errors: ${result.errors.join('; ')}`),
      303,
    );
  }
  return c.redirect('/admin/settings?msg=' + encodeURIComponent(summary), 303);
});

/* ---------------------------------------------------------------------- */
/* Change password (signed-in user)                                       */
/* ---------------------------------------------------------------------- */

settings.get('/password', async (c) => {
  const admin = getAdmin(c);
  const flash = flashOf(c);
  return c.html(
    <AdminLayout title="Change password" active="settings" admin={admin} msg={flash.msg} err={flash.err}>
      <div class="admin-head">
        <h1>Change password</h1>
        <a class="btn btn-secondary" href="/admin/settings">
          ← Back to settings
        </a>
      </div>
      <form method="post" action="/admin/settings/password" class="admin-panel stack" style="max-width:420px;">
        <CsrfField token={admin.csrf} />
        <div class="field">
          <label for="current">Current password</label>
          <input id="current" name="current" type="password" required autocomplete="current-password" />
        </div>
        <div class="field">
          <label for="password">New password</label>
          <input id="password" name="password" type="password" required minlength={12} autocomplete="new-password" />
          <p class="field-hint">At least 12 characters.</p>
        </div>
        <div class="field">
          <label for="confirm">Confirm new password</label>
          <input id="confirm" name="confirm" type="password" required minlength={12} autocomplete="new-password" />
        </div>
        <button class="btn" type="submit">
          Update password
        </button>
      </form>
    </AdminLayout>,
  );
});

settings.post('/password', async (c) => {
  const admin = getAdmin(c);
  const body = await c.req.parseBody();
  if (!verifyCsrf(c, typeof body._csrf === 'string' ? body._csrf : undefined)) {
    return c.redirect('/admin/settings/password?err=' + encodeURIComponent('Your session expired — please try again.'), 303);
  }
  const current = str(body.current);
  const password = str(body.password);
  const confirm = str(body.confirm);

  const user = await c.env.DB.prepare('SELECT password_hash FROM admin_users WHERE id = ?')
    .bind(admin.userId)
    .first<{ password_hash: string }>();
  const ok = user && (await verifyPassword(current, user.password_hash));
  if (!ok) {
    return c.redirect('/admin/settings/password?err=' + encodeURIComponent('Current password is incorrect.'), 303);
  }
  const error = validateNewPassword(password, confirm);
  if (error) return c.redirect('/admin/settings/password?err=' + encodeURIComponent(error), 303);

  const newHash = await hashPassword(password);
  await c.env.DB.prepare('UPDATE admin_users SET password_hash = ? WHERE id = ?').bind(newHash, admin.userId).run();
  return c.redirect('/admin/settings/password?msg=' + encodeURIComponent('Password updated.'), 303);
});

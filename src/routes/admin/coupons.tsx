import { Hono } from 'hono';
import type { AppBindings, Coupon, CouponKind } from '../../types';
import { getAdmin, verifyCsrf } from '../../lib/admin-auth';
import { AdminLayout, AdminPrintPage, CsrfField } from '../../ui/admin-layout';
import { couponQrUrl, formatCouponCode, generateBatchCodes, renderQrSvg } from '../../lib/qr';
import { normaliseCouponCode } from '../../lib/util';

/** Coupons + the print-at-packing QR cards — the commercial heart of the site. */
export const coupons = new Hono<AppBindings>();

function flashOf(c: { req: { query: (k: string) => string | undefined } }) {
  return { msg: c.req.query('msg') ?? null, err: c.req.query('err') ?? null };
}

function couponStatus(c: Coupon): { label: string; cls: string } {
  if (!c.active) return { label: 'inactive', cls: 'pill-bad' };
  const now = Date.now();
  if (c.expires_at && Date.parse(c.expires_at.replace(' ', 'T') + 'Z') < now) return { label: 'expired', cls: 'pill-bad' };
  if (c.starts_at && Date.parse(c.starts_at.replace(' ', 'T') + 'Z') > now) return { label: 'scheduled', cls: 'pill-warn' };
  if (c.max_redemptions !== null && c.times_used >= c.max_redemptions) return { label: 'exhausted', cls: 'pill-bad' };
  return { label: 'active', cls: 'pill-ok' };
}

function valueLabel(c: Pick<Coupon, 'kind' | 'value'>): string {
  return c.kind === 'percent' ? `${c.value}% off` : `£${(c.value / 100).toFixed(2)} off`;
}

coupons.get('/', async (c) => {
  const admin = getAdmin(c);
  const flash = flashOf(c);
  const batchFilter = c.req.query('batch');
  const where = batchFilter ? 'WHERE batch = ?' : '';
  const params = batchFilter ? [batchFilter] : [];
  const { results } = await c.env.DB.prepare(`SELECT * FROM coupons ${where} ORDER BY created_at DESC`)
    .bind(...params)
    .all<Coupon>();
  const rows = results ?? [];

  // Group single-use batches so the print sheet link isn't repeated per row.
  const batches = new Set(rows.filter((r) => r.batch).map((r) => r.batch as string));

  // Titles for item-scoped codes, so the list reads "10% off Yorkshire Tea"
  // rather than an opaque product id.
  const productTitles = new Map<number, string>();
  const scopedIds = [...new Set(rows.map((r) => r.product_id).filter((id): id is number => !!id))];
  if (scopedIds.length) {
    const { results: titles } = await c.env.DB.prepare(
      `SELECT id, title FROM products WHERE id IN (${scopedIds.map(() => '?').join(',')})`,
    )
      .bind(...scopedIds)
      .all<{ id: number; title: string }>();
    for (const row of titles ?? []) productTitles.set(row.id, row.title);
  }

  return c.html(
    <AdminLayout title="Coupons" active="coupons" admin={admin} msg={flash.msg} err={flash.err}>
      <div class="admin-head">
        <div>
          <h1>Coupons</h1>
          <p class="muted">{rows.length} code{rows.length === 1 ? '' : 's'}{batchFilter ? ` in batch "${batchFilter}"` : ''}.</p>
        </div>
        <div class="actions">
          <a class="btn btn-secondary" href="/admin/coupons/poster">
            QR10 poster
          </a>
          <a class="btn btn-secondary" href="/admin/coupons/new">
            + New coupon
          </a>
        </div>
      </div>

      <div class="admin-panel">
        <h3>Bulk-generate single-use codes</h3>
        <form method="post" action="/admin/coupons/generate" class="admin-grid cols-3">
          <CsrfField token={admin.csrf} />
          <div class="field">
            <label for="count">How many codes</label>
            <input id="count" name="count" type="number" min="1" max="2000" value="100" required />
          </div>
          <div class="field">
            <label for="kind">Type</label>
            <select id="kind" name="kind">
              <option value="percent">Percent off</option>
              <option value="fixed">Fixed amount off</option>
            </select>
          </div>
          <div class="field">
            <label for="value">Value (% or £)</label>
            <input id="value" name="value" type="text" value="10" required />
          </div>
          <div class="field">
            <label for="batch">Batch label</label>
            <input id="batch" name="batch" type="text" placeholder="qr-cards-2026-09" required />
          </div>
          <div class="field">
            <label for="expires_at">Expiry (optional)</label>
            <input id="expires_at" name="expires_at" type="date" />
          </div>
          <div class="field" style="align-self:end;">
            <button class="btn" type="submit">
              Generate batch
            </button>
          </div>
        </form>
      </div>

      {batches.size ? (
        <div class="admin-panel">
          <h3>Print sheets</h3>
          <div class="row">
            {[...batches].map((b) => (
              <a class="btn btn-secondary btn-sm" href={`/admin/coupons/print?batch=${encodeURIComponent(b)}`} target="_blank">
                Print "{b}"
              </a>
            ))}
          </div>
        </div>
      ) : null}

      <div class="admin-table-wrap">
        <table class="admin-table">
          <thead>
            <tr>
              <th>Code</th>
              <th>Value</th>
              <th>Applies to</th>
              <th class="col-optional">Batch</th>
              <th class="num">Used</th>
              <th>Expiry</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((coupon) => {
              const status = couponStatus(coupon);
              return (
                <tr>
                  <td>
                    <a href={`/admin/coupons/${coupon.id}`}>{formatCouponCode(coupon.code)}</a>
                  </td>
                  <td>{valueLabel(coupon)}</td>
                  <td>
                    {coupon.product_id ? (
                      <a href={`/admin/products/${coupon.product_id}`}>
                        {productTitles.get(coupon.product_id) ?? `Item #${coupon.product_id}`}
                      </a>
                    ) : (
                      <span class="faint">Whole basket</span>
                    )}
                  </td>
                  <td class="faint col-optional">{coupon.batch ?? '—'}</td>
                  <td class="num">
                    {coupon.times_used}
                    {coupon.max_redemptions !== null ? ` / ${coupon.max_redemptions}` : ''}
                  </td>
                  <td class="faint">{coupon.expires_at ?? 'never'}</td>
                  <td>
                    <span class={`pill ${status.cls}`}>{status.label}</span>
                  </td>
                  <td class="row-actions">
                    <a class="btn btn-sm btn-secondary" href={`/admin/coupons/${coupon.id}`}>
                      Edit
                    </a>
                    <a class="btn btn-sm btn-secondary" href={`/admin/coupons/${coupon.id}/qr.svg`} target="_blank">
                      QR
                    </a>
                    <form method="post" action={`/admin/coupons/${coupon.id}/toggle`}>
                      <CsrfField token={admin.csrf} />
                      <button class="btn btn-sm btn-secondary" type="submit">
                        {coupon.active ? 'Deactivate' : 'Activate'}
                      </button>
                    </form>
                  </td>
                </tr>
              );
            })}
            {!rows.length ? (
              <tr>
                <td colSpan={7} class="center muted" style="padding:32px;">
                  No coupons yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </AdminLayout>,
  );
});

interface CouponFormValues {
  code: string;
  kind: CouponKind;
  value: string;
  description: string;
  min_spend: string;
  max_redemptions: string;
  per_customer_limit: string;
  free_shipping: boolean;
  starts_at: string;
  expires_at: string;
  batch: string;
  product_id: string;
}

function CouponForm(props: {
  admin: { csrf: string };
  values: CouponFormValues;
  action: string;
  heading: string;
  products?: Array<{ id: number; title: string }>;
}) {
  const v = props.values;
  return (
    <div class="admin-panel">
      <h1>{props.heading}</h1>
      <form method="post" action={props.action} class="stack">
        <CsrfField token={props.admin.csrf} />
        <div class="admin-grid cols-2">
          <div class="field">
            <label for="code">Code</label>
            <input id="code" name="code" type="text" required value={v.code} placeholder="QR10" />
          </div>
          <div class="field">
            <label for="batch">Batch label (optional)</label>
            <input id="batch" name="batch" type="text" value={v.batch} />
          </div>
        </div>
        <div class="field">
          <label for="product_id">Applies to</label>
          <select id="product_id" name="product_id">
            <option value="" selected={!v.product_id}>
              Everything in the basket
            </option>
            {(props.products ?? []).map((p) => (
              <option value={String(p.id)} selected={v.product_id === String(p.id)}>
                {p.title}
              </option>
            ))}
          </select>
          <p class="field-hint">
            Pick one item to make this a single-item offer — the discount then comes off that item
            only. To make a QR card for an item quickly, open the product and press
            <strong> Create QR code</strong>.
          </p>
        </div>
        <div class="admin-grid cols-3">
          <div class="field">
            <label for="kind">Type</label>
            <select id="kind" name="kind">
              <option value="percent" selected={v.kind === 'percent'}>
                Percent off
              </option>
              <option value="fixed" selected={v.kind === 'fixed'}>
                Fixed amount off (£)
              </option>
            </select>
          </div>
          <div class="field">
            <label for="value">Value</label>
            <input id="value" name="value" type="text" required value={v.value} />
            <p class="field-hint">Percent: a number 1-100. Fixed: pounds, e.g. 5.00.</p>
          </div>
          <div class="field">
            <label for="min_spend">Minimum spend (£)</label>
            <input id="min_spend" name="min_spend" type="text" value={v.min_spend} />
          </div>
        </div>
        <div class="field">
          <label for="description">Description (shown to no one but you)</label>
          <input id="description" name="description" type="text" value={v.description} />
        </div>
        <div class="admin-grid cols-3">
          <div class="field">
            <label for="max_redemptions">Max redemptions (blank = unlimited)</label>
            <input id="max_redemptions" name="max_redemptions" type="number" min="1" value={v.max_redemptions} />
          </div>
          <div class="field">
            <label for="per_customer_limit">Per-customer limit (blank = unlimited)</label>
            <input id="per_customer_limit" name="per_customer_limit" type="number" min="1" value={v.per_customer_limit} />
          </div>
          <div class="checkbox-row field" style="align-self:end;">
            <input id="free_shipping" type="checkbox" name="free_shipping" value="1" checked={v.free_shipping} />
            <label for="free_shipping">Also gives free shipping</label>
          </div>
        </div>
        <div class="admin-grid cols-2">
          <div class="field">
            <label for="starts_at">Starts (optional)</label>
            <input id="starts_at" name="starts_at" type="date" value={v.starts_at} />
          </div>
          <div class="field">
            <label for="expires_at">Expires (optional)</label>
            <input id="expires_at" name="expires_at" type="date" value={v.expires_at} />
          </div>
        </div>
        <button class="btn" type="submit">
          Save coupon
        </button>
      </form>
    </div>
  );
}

function blankCouponForm(): CouponFormValues {
  return {
    code: '',
    kind: 'percent',
    value: '10',
    description: '',
    min_spend: '',
    max_redemptions: '',
    per_customer_limit: '',
    free_shipping: false,
    starts_at: '',
    expires_at: '',
    batch: '',
    product_id: '',
  };
}

/** Products offered in the "applies to" selector. */
async function selectableProducts(env: AppBindings['Bindings']): Promise<Array<{ id: number; title: string }>> {
  const { results } = await env.DB.prepare(
    "SELECT id, title FROM products WHERE status != 'archived' ORDER BY title ASC LIMIT 500",
  ).all<{ id: number; title: string }>();
  return results ?? [];
}

coupons.get('/new', async (c) => {
  const admin = getAdmin(c);
  const products = await selectableProducts(c.env);
  return c.html(
    <AdminLayout title="New coupon" active="coupons" admin={admin}>
      <div class="admin-head">
        <div />
        <a class="btn btn-secondary" href="/admin/coupons">
          ← Back to coupons
        </a>
      </div>
      <CouponForm
        admin={admin}
        values={blankCouponForm()}
        action="/admin/coupons/new"
        heading="New coupon"
        products={products}
      />
    </AdminLayout>,
  );
});

function parsePoundsOrPercent(raw: string, kind: CouponKind): number | null {
  const n = Number(raw.replace(/[£,\s]/g, ''));
  if (!Number.isFinite(n) || n < 0) return null;
  if (kind === 'percent') return Math.round(Math.min(100, n));
  return Math.round(n * 100);
}

function parseOptionalPositiveInt(raw: string): number | null {
  if (!raw.trim()) return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

coupons.post('/new', async (c) => {
  const admin = getAdmin(c);
  const body = await c.req.parseBody();
  if (!verifyCsrf(c, typeof body._csrf === 'string' ? body._csrf : undefined)) {
    return c.redirect('/admin/coupons?err=' + encodeURIComponent('Your session expired — please try again.'), 303);
  }
  const str = (k: string) => (typeof body[k] === 'string' ? (body[k] as string).trim() : '');
  const code = normaliseCouponCode(str('code'));
  const kind: CouponKind = str('kind') === 'fixed' ? 'fixed' : 'percent';
  const value = parsePoundsOrPercent(str('value'), kind);

  if (!code || value === null) {
    return c.redirect('/admin/coupons/new?err=' + encodeURIComponent('Enter a code and a valid value.'), 303);
  }
  const minSpend = parsePoundsOrPercent(str('min_spend') || '0', 'fixed') ?? 0;

  try {
    await c.env.DB.prepare(
      `INSERT INTO coupons (code, kind, value, description, min_spend_pence, max_redemptions, per_customer_limit,
        free_shipping, starts_at, expires_at, batch, product_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
      .bind(
        code,
        kind,
        value,
        str('description') || null,
        minSpend,
        parseOptionalPositiveInt(str('max_redemptions')),
        parseOptionalPositiveInt(str('per_customer_limit')),
        str('free_shipping') === '1' ? 1 : 0,
        str('starts_at') || null,
        str('expires_at') || null,
        str('batch') || null,
        parseOptionalPositiveInt(str('product_id')),
      )
      .run();
  } catch {
    return c.redirect('/admin/coupons/new?err=' + encodeURIComponent(`Code "${code}" already exists.`), 303);
  }
  return c.redirect('/admin/coupons?msg=' + encodeURIComponent(`Coupon "${code}" created.`), 303);
});

coupons.post('/generate', async (c) => {
  const admin = getAdmin(c);
  const body = await c.req.parseBody();
  if (!verifyCsrf(c, typeof body._csrf === 'string' ? body._csrf : undefined)) {
    return c.redirect('/admin/coupons?err=' + encodeURIComponent('Your session expired — please try again.'), 303);
  }
  const str = (k: string) => (typeof body[k] === 'string' ? (body[k] as string).trim() : '');
  const count = Math.min(2000, Math.max(1, parseInt(str('count') || '0', 10) || 0));
  const kind: CouponKind = str('kind') === 'fixed' ? 'fixed' : 'percent';
  const value = parsePoundsOrPercent(str('value'), kind);
  const batch = str('batch');
  const expiresAt = str('expires_at') || null;

  if (!batch || value === null || !count) {
    return c.redirect('/admin/coupons?err=' + encodeURIComponent('Enter a batch label, value and count.'), 303);
  }

  const codes = generateBatchCodes(count);
  const statements = codes.map((code) =>
    c.env.DB.prepare(
      `INSERT INTO coupons (code, kind, value, min_spend_pence, max_redemptions, expires_at, batch)
       VALUES (?, ?, ?, 0, 1, ?, ?)`,
    ).bind(code, kind, value, expiresAt, batch),
  );
  // D1 batches are capped in practice; chunk to stay comfortably under limits.
  for (let i = 0; i < statements.length; i += 100) {
    await c.env.DB.batch(statements.slice(i, i + 100));
  }

  return c.redirect(
    `/admin/coupons?batch=${encodeURIComponent(batch)}&msg=${encodeURIComponent(`Generated ${codes.length} codes in batch "${batch}".`)}`,
    303,
  );
});

coupons.get('/print', async (c) => {
  const batch = c.req.query('batch') ?? '';
  const { results } = await c.env.DB.prepare('SELECT * FROM coupons WHERE batch = ? ORDER BY code ASC')
    .bind(batch)
    .all<Coupon>();
  const rows = results ?? [];
  return c.html(
    <AdminPrintPage title={`Print — ${batch}`}>
      <div class="print-actions no-print">
        <button class="btn" onclick="window.print()">
          Print sheet
        </button>
        <span class="faint" style="margin-left:10px;">
          {rows.length} card{rows.length === 1 ? '' : 's'} · batch "{batch}"
        </span>
      </div>
      <div class="qr-sheet">
        {rows.map((coupon) => {
          const svg = renderQrSvg(couponQrUrl(c.env, coupon.code), 200);
          return (
            <div class="qr-card">
              <div class="qr-wordmark">
                27<span style="color:var(--accent)">beauty</span>
              </div>
              <p class="qr-tagline">Scan for {valueLabel(coupon)} your next order</p>
              <div dangerouslySetInnerHTML={{ __html: svg }} />
              <p class="qr-code-text">{formatCouponCode(coupon.code)}</p>
              <p class="qr-domain">27beauty.co.uk</p>
            </div>
          );
        })}
      </div>
      {!rows.length ? <p class="muted no-print">No coupons found in that batch.</p> : null}
    </AdminPrintPage>,
  );
});

coupons.get('/poster', async (c) => {
  const code = normaliseCouponCode(c.req.query('code') || 'QR10');
  const coupon = await c.env.DB.prepare('SELECT * FROM coupons WHERE code = ?').bind(code).first<Coupon>();
  if (!coupon) return c.text('Coupon not found', 404);
  const url = couponQrUrl(c.env, coupon.code);
  const svg = renderQrSvg(url, 480);
  return c.html(
    <AdminPrintPage title={`QR poster — ${coupon.code}`}>
      <div class="print-actions no-print">
        <button class="btn" onclick="window.print()">
          Print
        </button>
      </div>
      <div class="qr-poster">
        <div class="qr-wordmark" style="font-size:1.4rem;">
          27<span style="color:var(--accent)">beauty</span>
        </div>
        <p class="qr-tagline" style="font-size:1rem;margin:8px 0 20px;">
          Scan for {valueLabel(coupon)} your next order
        </p>
        <div dangerouslySetInnerHTML={{ __html: svg }} />
        <p class="qr-code-text" style="font-size:1.4rem;margin-top:16px;">
          {formatCouponCode(coupon.code)}
        </p>
        <p class="qr-domain">27beauty.co.uk</p>
      </div>
    </AdminPrintPage>,
  );
});

coupons.get('/:id', async (c) => {
  const admin = getAdmin(c);
  const id = Number(c.req.param('id'));
  const coupon = await c.env.DB.prepare('SELECT * FROM coupons WHERE id = ?').bind(id).first<Coupon>();
  if (!coupon) return c.text('Not found', 404);
  const values: CouponFormValues = {
    code: coupon.code,
    kind: coupon.kind,
    value: coupon.kind === 'percent' ? String(coupon.value) : (coupon.value / 100).toFixed(2),
    description: coupon.description ?? '',
    min_spend: (coupon.min_spend_pence / 100).toFixed(2),
    max_redemptions: coupon.max_redemptions !== null ? String(coupon.max_redemptions) : '',
    per_customer_limit: coupon.per_customer_limit !== null ? String(coupon.per_customer_limit) : '',
    free_shipping: coupon.free_shipping === 1,
    starts_at: coupon.starts_at ?? '',
    expires_at: coupon.expires_at ?? '',
    batch: coupon.batch ?? '',
    product_id: coupon.product_id !== null ? String(coupon.product_id) : '',
  };
  const flash = flashOf(c);
  return c.html(
    <AdminLayout title={`Coupon ${coupon.code}`} active="coupons" admin={admin} msg={flash.msg} err={flash.err}>
      <div class="admin-head">
        <div>
          <p class="muted">
            Used {coupon.times_used}
            {coupon.max_redemptions !== null ? ` of ${coupon.max_redemptions}` : ' (unlimited)'} times.
          </p>
        </div>
        <div class="actions">
          <a class="btn btn-secondary" href={`/admin/coupons/${coupon.id}/qr.svg`} target="_blank">
            View QR
          </a>
          <a class="btn btn-secondary" href="/admin/coupons">
            ← Back to coupons
          </a>
        </div>
      </div>
      <CouponForm
        admin={admin}
        values={values}
        action={`/admin/coupons/${coupon.id}`}
        heading={`Edit — ${formatCouponCode(coupon.code)}`}
        products={await selectableProducts(c.env)}
      />
    </AdminLayout>,
  );
});

coupons.post('/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.parseBody();
  if (!verifyCsrf(c, typeof body._csrf === 'string' ? body._csrf : undefined)) {
    return c.redirect(`/admin/coupons/${id}?err=` + encodeURIComponent('Your session expired — please try again.'), 303);
  }
  const str = (k: string) => (typeof body[k] === 'string' ? (body[k] as string).trim() : '');
  const code = normaliseCouponCode(str('code'));
  const kind: CouponKind = str('kind') === 'fixed' ? 'fixed' : 'percent';
  const value = parsePoundsOrPercent(str('value'), kind);
  if (!code || value === null) {
    return c.redirect(`/admin/coupons/${id}?err=` + encodeURIComponent('Enter a code and a valid value.'), 303);
  }
  const minSpend = parsePoundsOrPercent(str('min_spend') || '0', 'fixed') ?? 0;
  await c.env.DB.prepare(
    `UPDATE coupons SET code=?, kind=?, value=?, description=?, min_spend_pence=?, max_redemptions=?,
       per_customer_limit=?, free_shipping=?, starts_at=?, expires_at=?, batch=?, product_id=? WHERE id=?`,
  )
    .bind(
      code,
      kind,
      value,
      str('description') || null,
      minSpend,
      parseOptionalPositiveInt(str('max_redemptions')),
      parseOptionalPositiveInt(str('per_customer_limit')),
      str('free_shipping') === '1' ? 1 : 0,
      str('starts_at') || null,
      str('expires_at') || null,
      str('batch') || null,
      parseOptionalPositiveInt(str('product_id')),
      id,
    )
    .run();
  return c.redirect(`/admin/coupons/${id}?msg=${encodeURIComponent('Saved.')}`, 303);
});

coupons.post('/:id/toggle', async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.parseBody();
  if (!verifyCsrf(c, typeof body._csrf === 'string' ? body._csrf : undefined)) {
    return c.redirect('/admin/coupons?err=' + encodeURIComponent('Your session expired — please try again.'), 303);
  }
  await c.env.DB.prepare('UPDATE coupons SET active = 1 - active WHERE id = ?').bind(id).run();
  return c.redirect('/admin/coupons?msg=' + encodeURIComponent('Updated.'), 303);
});

coupons.get('/:id/qr.svg', async (c) => {
  const id = Number(c.req.param('id'));
  const coupon = await c.env.DB.prepare('SELECT * FROM coupons WHERE id = ?').bind(id).first<Coupon>();
  if (!coupon) return c.text('Not found', 404);
  const size = clampSize(c.req.query('size'));
  const svg = renderQrSvg(couponQrUrl(c.env, coupon.code), size);
  return c.body(svg, 200, { 'content-type': 'image/svg+xml' });
});

function clampSize(raw: string | undefined): number {
  const n = raw ? parseInt(raw, 10) : 240;
  if (!Number.isFinite(n)) return 240;
  return Math.min(Math.max(n, 64), 1024);
}

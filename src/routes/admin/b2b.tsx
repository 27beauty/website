import { Hono } from 'hono';
import type { AppBindings, B2bInquiry } from '../../types';
import { getAdmin, verifyCsrf } from '../../lib/admin-auth';
import { AdminLayout, CsrfField } from '../../ui/admin-layout';

/** Trade/wholesale enquiries submitted via the public /b2b form. */
export const b2b = new Hono<AppBindings>();

const PER_PAGE = 30;

function flashOf(c: { req: { query: (k: string) => string | undefined } }) {
  return { msg: c.req.query('msg') ?? null, err: c.req.query('err') ?? null };
}

function statusPill(status: string) {
  const cls = status === 'new' ? 'pill-warn' : status === 'archived' ? 'pill' : 'pill-ok';
  return <span class={`pill ${cls}`}>{status}</span>;
}

b2b.get('/', async (c) => {
  const admin = getAdmin(c);
  const query = c.req.query();
  const page = Math.max(1, Number(query.page) || 1);
  const status = query.status && ['new', 'read', 'archived'].includes(query.status) ? query.status : undefined;
  const flash = flashOf(c);

  const where = status ? 'WHERE status = ?' : '';
  const params = status ? [status] : [];
  const offset = (page - 1) * PER_PAGE;

  const [countRow, listRes] = await Promise.all([
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM b2b_inquiries ${where}`).bind(...params).first<{ n: number }>(),
    c.env.DB.prepare(`SELECT * FROM b2b_inquiries ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .bind(...params, PER_PAGE, offset)
      .all<B2bInquiry>(),
  ]);
  const total = countRow?.n ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));
  const results = listRes.results ?? [];

  return c.html(
    <AdminLayout title="Trade enquiries" active="b2b" admin={admin} msg={flash.msg} err={flash.err}>
      <div class="admin-head">
        <h1>Trade &amp; wholesale enquiries</h1>
        <p class="muted">
          {total} enquir{total === 1 ? 'y' : 'ies'}.
        </p>
      </div>

      <form method="get" action="/admin/b2b" class="filter-bar">
        <div class="field">
          <label for="status">Status</label>
          <select id="status" name="status">
            <option value="">All</option>
            {(['new', 'read', 'archived'] as const).map((s) => (
              <option value={s} selected={status === s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <button class="btn btn-secondary" type="submit">
          Filter
        </button>
      </form>

      <div class="admin-table-wrap">
        <table class="admin-table">
          <thead>
            <tr>
              <th>Business</th>
              <th class="col-optional">Date</th>
              <th>Contact</th>
              <th>Message</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {results.map((inq) => (
              <tr>
                <td>{inq.business_name}</td>
                <td class="faint nowrap col-optional">{inq.created_at}</td>
                <td>
                  {inq.contact_name}
                  <div class="faint">
                    <a href={`mailto:${inq.email}`}>{inq.email}</a>
                  </div>
                  {inq.phone ? <div class="faint">{inq.phone}</div> : null}
                </td>
                <td style="max-width:320px;">{inq.message || <span class="faint">—</span>}</td>
                <td>{statusPill(inq.status)}</td>
                <td>
                  <div class="row" style="gap:6px;">
                    {inq.status !== 'read' ? (
                      <form method="post" action={`/admin/b2b/${inq.id}/status`}>
                        <CsrfField token={admin.csrf} />
                        <input type="hidden" name="status" value="read" />
                        <button class="btn btn-sm btn-secondary" type="submit">
                          Mark read
                        </button>
                      </form>
                    ) : null}
                    {inq.status !== 'archived' ? (
                      <form method="post" action={`/admin/b2b/${inq.id}/status`}>
                        <CsrfField token={admin.csrf} />
                        <input type="hidden" name="status" value="archived" />
                        <button class="btn btn-sm btn-secondary" type="submit">
                          Archive
                        </button>
                      </form>
                    ) : null}
                  </div>
                </td>
              </tr>
            ))}
            {!results.length ? (
              <tr>
                <td colSpan={6} class="center muted" style="padding:32px;">
                  No enquiries yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <nav class="pagination" aria-label="Pagination">
        {page > 1 ? <a href={`/admin/b2b?page=${page - 1}${status ? `&status=${status}` : ''}`}>← Prev</a> : null}
        <span aria-current="page">
          Page {page} of {totalPages}
        </span>
        {page < totalPages ? (
          <a href={`/admin/b2b?page=${page + 1}${status ? `&status=${status}` : ''}`}>Next →</a>
        ) : null}
      </nav>
    </AdminLayout>,
  );
});

b2b.post('/:id/status', async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.parseBody();
  if (!verifyCsrf(c, typeof body._csrf === 'string' ? body._csrf : undefined)) {
    return c.redirect('/admin/b2b?err=' + encodeURIComponent('Your session expired — please try again.'), 303);
  }
  const status = typeof body.status === 'string' ? body.status : '';
  if (!['new', 'read', 'archived'].includes(status)) return c.redirect('/admin/b2b', 303);

  await c.env.DB.prepare(`UPDATE b2b_inquiries SET status = ? WHERE id = ?`).bind(status, id).run();
  return c.redirect('/admin/b2b?msg=' + encodeURIComponent('Updated.'), 303);
});

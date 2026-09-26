import { Hono } from 'hono';
import type { AppBindings } from '../../types';
import { BEAUTY_CATEGORY_SLUG, deleteCategory, listCategories, listCategoriesForAdmin } from '../../lib/db';
import { getAdmin, verifyCsrf } from '../../lib/admin-auth';
import { AdminLayout, CsrfField } from '../../ui/admin-layout';
import { uniqueSlug } from '../../lib/util';

/** Category list, create, rename, reorder and delete. Mounted at /admin/categories. */
export const categories = new Hono<AppBindings>();

function flashOf(c: { req: { query: (k: string) => string | undefined } }) {
  return { msg: c.req.query('msg') ?? null, err: c.req.query('err') ?? null };
}

categories.get('/', async (c) => {
  const admin = getAdmin(c);
  const flash = flashOf(c);
  const cats = await listCategoriesForAdmin(c.env);
  return c.html(
    <AdminLayout title="Categories" active="products" admin={admin} msg={flash.msg} err={flash.err}>
      <div class="admin-head">
        <h1>Categories</h1>
        <a class="btn btn-secondary" href="/admin/products">
          ← Back to products
        </a>
      </div>

      <div class="admin-panel">
        <h3>New category</h3>
        <form method="post" action="/admin/categories" class="admin-grid cols-3">
          <CsrfField token={admin.csrf} />
          <div class="field">
            <label for="name">Name</label>
            <input id="name" name="name" type="text" required />
          </div>
          <div class="field">
            <label for="emoji">Emoji</label>
            <input id="emoji" name="emoji" type="text" maxlength={4} placeholder="🛍️" />
          </div>
          <div class="field" style="align-self:end;">
            <button class="btn" type="submit">
              Add category
            </button>
          </div>
        </form>
      </div>

      <div class="admin-table-wrap">
        <table class="admin-table">
          <thead>
            <tr>
              <th>Order</th>
              <th>Name</th>
              <th>Slug</th>
              <th class="num">Products</th>
              <th>Delete</th>
            </tr>
          </thead>
          <tbody>
            {cats.map((cat, i) => (
              <tr>
                <td class="nowrap">
                  <form method="post" action={`/admin/categories/${cat.id}/reorder`} style="display:inline;">
                    <CsrfField token={admin.csrf} />
                    <input type="hidden" name="dir" value="up" />
                    <button class="btn btn-sm btn-secondary" type="submit" disabled={i === 0}>
                      ↑
                    </button>
                  </form>
                  <form method="post" action={`/admin/categories/${cat.id}/reorder`} style="display:inline;">
                    <CsrfField token={admin.csrf} />
                    <input type="hidden" name="dir" value="down" />
                    <button class="btn btn-sm btn-secondary" type="submit" disabled={i === cats.length - 1}>
                      ↓
                    </button>
                  </form>
                </td>
                <td>
                  <form method="post" action={`/admin/categories/${cat.id}/rename`} class="row" style="gap:6px;">
                    <CsrfField token={admin.csrf} />
                    <input type="text" name="name" value={cat.name} style="min-width:160px;" />
                    <input type="text" name="emoji" value={cat.emoji ?? ''} style="width:52px;" />
                    <button class="btn btn-sm btn-secondary" type="submit">
                      Save
                    </button>
                  </form>
                </td>
                <td class="faint">{cat.slug}</td>
                <td class="num">{cat.product_count}</td>
                <td>
                  {cat.slug === BEAUTY_CATEGORY_SLUG ? (
                    <span class="faint small">Homepage category — rename only</span>
                  ) : (
                    <form method="post" action={`/admin/categories/${cat.id}/delete`} class="row-actions">
                      <CsrfField token={admin.csrf} />
                      {cat.product_count > 0 || cats.length > 1 ? (
                        <select name="into" aria-label={`Move ${cat.name} products into`} required={cat.product_count > 0}>
                          <option value="">{cat.product_count > 0 ? 'Move products into…' : 'Nothing to move'}</option>
                          {cats
                            .filter((other) => other.id !== cat.id)
                            .map((other) => (
                              <option value={other.id}>{other.name}</option>
                            ))}
                        </select>
                      ) : null}
                      <button class="btn btn-sm btn-danger" type="submit">
                        Delete
                      </button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p class="field-hint">
        Deleting a category moves its products into the one you pick, along with the eBay sync's rules for it, so
        new and updated eBay listings land there too.
      </p>
    </AdminLayout>,
  );
});

categories.post('/', async (c) => {
  const body = await c.req.parseBody();
  if (!verifyCsrf(c, typeof body._csrf === 'string' ? body._csrf : undefined)) {
    return c.redirect('/admin/categories?err=' + encodeURIComponent('Your session expired — please try again.'), 303);
  }
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const emoji = typeof body.emoji === 'string' ? body.emoji.trim() : '';
  if (!name) return c.redirect('/admin/categories?err=' + encodeURIComponent('Name is required.'), 303);
  const slug = await uniqueSlug(c.env.DB, 'categories', name);
  const maxRow = await c.env.DB.prepare('SELECT COALESCE(MAX(sort_order), 0) AS n FROM categories').first<{ n: number }>();
  await c.env.DB.prepare('INSERT INTO categories (slug, name, emoji, sort_order) VALUES (?,?,?,?)')
    .bind(slug, name, emoji || null, (maxRow?.n ?? 0) + 10)
    .run();
  return c.redirect('/admin/categories?msg=' + encodeURIComponent('Category added.'), 303);
});

categories.post('/:id/rename', async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.parseBody();
  if (!verifyCsrf(c, typeof body._csrf === 'string' ? body._csrf : undefined)) {
    return c.redirect('/admin/categories?err=' + encodeURIComponent('Your session expired — please try again.'), 303);
  }
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const emoji = typeof body.emoji === 'string' ? body.emoji.trim() : '';
  if (!name) return c.redirect('/admin/categories?err=' + encodeURIComponent('Name is required.'), 303);
  await c.env.DB.prepare('UPDATE categories SET name = ?, emoji = ? WHERE id = ?')
    .bind(name, emoji || null, id)
    .run();
  return c.redirect('/admin/categories?msg=' + encodeURIComponent('Category updated.'), 303);
});

categories.post('/:id/reorder', async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.parseBody();
  if (!verifyCsrf(c, typeof body._csrf === 'string' ? body._csrf : undefined)) {
    return c.redirect('/admin/categories?err=' + encodeURIComponent('Your session expired — please try again.'), 303);
  }
  const dir = body.dir === 'up' ? 'up' : 'down';
  const all = await listCategories(c.env);
  const idx = all.findIndex((cat) => cat.id === id);
  const swapIdx = dir === 'up' ? idx - 1 : idx + 1;
  if (idx < 0 || swapIdx < 0 || swapIdx >= all.length) return c.redirect('/admin/categories', 303);
  const a = all[idx];
  const b = all[swapIdx];
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE categories SET sort_order = ? WHERE id = ?').bind(b.sort_order, a.id),
    c.env.DB.prepare('UPDATE categories SET sort_order = ? WHERE id = ?').bind(a.sort_order, b.id),
  ]);
  return c.redirect('/admin/categories', 303);
});

categories.post('/:id/delete', async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.parseBody();
  if (!verifyCsrf(c, typeof body._csrf === 'string' ? body._csrf : undefined)) {
    return c.redirect('/admin/categories?err=' + encodeURIComponent('Your session expired — please try again.'), 303);
  }
  const into = typeof body.into === 'string' && body.into !== '' ? Number(body.into) : null;
  const result = await deleteCategory(c.env, id, into !== null && Number.isInteger(into) ? into : null);
  if (!result.ok) return c.redirect('/admin/categories?err=' + encodeURIComponent(result.error), 303);
  const moved = result.products || result.rules
    ? ` ${result.products} product${result.products === 1 ? '' : 's'} and ${result.rules} eBay rule${result.rules === 1 ? '' : 's'} moved.`
    : '';
  return c.redirect('/admin/categories?msg=' + encodeURIComponent(`Category deleted.${moved}`), 303);
});

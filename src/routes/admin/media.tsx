import { Hono } from 'hono';
import type { AppBindings } from '../../types';

/**
 * Legacy alias for uploaded images, mounted PUBLIC at /admin/media.
 *
 * It used to read R2 and stream the object itself, which was wrong twice
 * over. It set no security headers, so an uploaded SVG — and image/svg+xml is
 * an accepted upload type — was served as a live document on the shop's own
 * origin, where the admin session cookie lives: a script inside it ran as the
 * site. And it bypassed the edge cache, so every request was a billable R2
 * read, which is precisely what /media/* exists to avoid.
 *
 * There is nothing here worth keeping, so it redirects to the canonical
 * /media/* route, which sandboxes the response and is cached. Old links in
 * saved image_url values, printed material or search results keep working.
 */
export const media = new Hono<AppBindings>();

media.get('/:key{.+}', (c) => {
  const url = new URL(c.req.url);
  // Swapped on the raw path so the key's encoding is preserved exactly.
  url.pathname = url.pathname.replace(/^\/admin\/media\//, '/media/');
  return c.redirect(url.pathname + url.search, 301);
});

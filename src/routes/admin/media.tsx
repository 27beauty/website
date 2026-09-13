import { Hono } from 'hono';
import type { AppBindings } from '../../types';

/**
 * Serves uploaded product images from R2. Mounted PUBLIC (before requireAdmin)
 * at /admin/media in index.tsx, since product photos need to load on the
 * storefront too — see the note in the final report about a public alias.
 */
export const media = new Hono<AppBindings>();

media.get('/:key{.+}', async (c) => {
  const key = c.req.param('key');
  if (!c.env.MEDIA) return c.notFound(); // R2 not enabled on the account yet
  const obj = await c.env.MEDIA.get(key);
  if (!obj) return c.text('Not found', 404);
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('etag', obj.httpEtag);
  headers.set('cache-control', 'public, max-age=31536000, immutable');
  return new Response(obj.body, { headers });
});

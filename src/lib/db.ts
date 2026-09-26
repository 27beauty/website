import type { Category, Env, Product, ProductWithCategory } from '../types';

/**
 * Catalogue queries shared by the storefront, the admin panel and the eBay sync.
 * Keep SQL in here rather than in route files.
 */

const PRODUCT_SELECT = `
  SELECT p.*, c.name AS category_name, c.slug AS category_slug
  FROM products p
  LEFT JOIN categories c ON c.id = p.category_id
`;

export async function listCategories(env: Env): Promise<Category[]> {
  const { results } = await env.DB.prepare(
    'SELECT * FROM categories ORDER BY sort_order ASC, name ASC',
  ).all<Category>();
  return results ?? [];
}

/** Categories with a count of purchasable products, for the shop navigation. */
export async function listCategoriesWithCounts(
  env: Env,
): Promise<Array<Category & { product_count: number }>> {
  const { results } = await env.DB.prepare(
    `SELECT c.*, COUNT(p.id) AS product_count
     FROM categories c
     LEFT JOIN products p ON p.category_id = c.id AND p.status = 'active'
     GROUP BY c.id
     ORDER BY c.sort_order ASC, c.name ASC`,
  ).all<Category & { product_count: number }>();
  return results ?? [];
}

/** Homepage's beauty showcase pulls straight from this category — see db/seed.sql. It can't be deleted. */
export const BEAUTY_CATEGORY_SLUG = 'hair-beauty';

/** Every category with a count of all its products (any status), for Admin → Categories. */
export async function listCategoriesForAdmin(env: Env): Promise<Array<Category & { product_count: number }>> {
  const { results } = await env.DB.prepare(
    `SELECT c.*, COUNT(p.id) AS product_count
     FROM categories c
     LEFT JOIN products p ON p.category_id = c.id
     GROUP BY c.id
     ORDER BY c.sort_order ASC, c.name ASC`,
  ).all<Category & { product_count: number }>();
  return results ?? [];
}

/**
 * Deletes a category, first moving everything that points at it into
 * `intoId`: its products, the eBay sync's category rules (or the next sync
 * would put the products straight back into a category that no longer
 * exists) and any eBay account's default category. One batch, so nothing is
 * left half-moved. With no `intoId` it only deletes an empty category.
 */
export async function deleteCategory(
  env: Env,
  id: number,
  intoId: number | null,
): Promise<{ ok: true; products: number; rules: number } | { ok: false; error: string }> {
  const cat = await env.DB.prepare('SELECT id, slug FROM categories WHERE id = ?').bind(id).first<{ id: number; slug: string }>();
  if (!cat) return { ok: false, error: 'That category no longer exists.' };
  if (cat.slug === BEAUTY_CATEGORY_SLUG) {
    return { ok: false, error: "This is the homepage's beauty category, so it can't be deleted — rename it instead." };
  }
  const counts = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM products WHERE category_id = ?1) AS products,
            (SELECT COUNT(*) FROM ebay_category_map WHERE category_id = ?1) AS rules`,
  )
    .bind(id)
    .first<{ products: number; rules: number }>();
  const products = counts?.products ?? 0;
  const rules = counts?.rules ?? 0;

  if (intoId === null) {
    if (products > 0) return { ok: false, error: 'Choose a category to move its products into.' };
    await env.DB.prepare('DELETE FROM categories WHERE id = ?').bind(id).run();
    return { ok: true, products: 0, rules: 0 };
  }
  if (intoId === id) return { ok: false, error: "Choose a different category to move its products into." };
  const into = await env.DB.prepare('SELECT id FROM categories WHERE id = ?').bind(intoId).first();
  if (!into) return { ok: false, error: 'The category to move into no longer exists.' };

  await env.DB.batch([
    env.DB.prepare('UPDATE products SET category_id = ?, updated_at = datetime(\'now\') WHERE category_id = ?').bind(intoId, id),
    env.DB.prepare('UPDATE ebay_category_map SET category_id = ? WHERE category_id = ?').bind(intoId, id),
    env.DB.prepare('UPDATE ebay_accounts SET default_category_id = ? WHERE default_category_id = ?').bind(intoId, id),
    env.DB.prepare('DELETE FROM categories WHERE id = ?').bind(id),
  ]);
  return { ok: true, products, rules };
}

export async function getCategoryBySlug(env: Env, slug: string): Promise<Category | null> {
  return env.DB.prepare('SELECT * FROM categories WHERE slug = ?').bind(slug).first<Category>();
}

export interface ProductQuery {
  categorySlug?: string;
  categoryId?: number;
  search?: string;
  status?: 'active' | 'draft' | 'archived' | 'any';
  featured?: boolean;
  inStockOnly?: boolean;
  sort?: 'newest' | 'price_asc' | 'price_desc' | 'title' | 'stock_asc';
  limit?: number;
  offset?: number;
}

export async function queryProducts(
  env: Env,
  q: ProductQuery = {},
): Promise<{ items: ProductWithCategory[]; total: number }> {
  const where: string[] = [];
  const params: unknown[] = [];

  const status = q.status ?? 'active';
  if (status !== 'any') {
    where.push('p.status = ?');
    params.push(status);
  }
  if (q.categorySlug) {
    where.push('c.slug = ?');
    params.push(q.categorySlug);
  }
  if (q.categoryId) {
    where.push('p.category_id = ?');
    params.push(q.categoryId);
  }
  if (q.featured) where.push('p.featured = 1');
  if (q.inStockOnly) where.push('p.stock > 0');
  if (q.search && q.search.trim()) {
    const term = `%${q.search.trim().toLowerCase()}%`;
    where.push('(lower(p.title) LIKE ? OR lower(p.description) LIKE ? OR lower(p.brand) LIKE ? OR lower(p.sku) LIKE ?)');
    params.push(term, term, term, term);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const orderSql =
    {
      newest: 'p.created_at DESC, p.id DESC',
      price_asc: 'p.price_pence ASC',
      price_desc: 'p.price_pence DESC',
      title: 'p.title ASC',
      stock_asc: 'p.stock ASC, p.title ASC',
    }[q.sort ?? 'newest'] ?? 'p.created_at DESC';

  const limit = Math.min(Math.max(q.limit ?? 24, 1), 100);
  const offset = Math.max(q.offset ?? 0, 0);

  const countRow = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM products p LEFT JOIN categories c ON c.id = p.category_id ${whereSql}`,
  )
    .bind(...params)
    .first<{ n: number }>();

  const { results } = await env.DB.prepare(
    `${PRODUCT_SELECT} ${whereSql} ORDER BY ${orderSql} LIMIT ? OFFSET ?`,
  )
    .bind(...params, limit, offset)
    .all<ProductWithCategory>();

  return { items: results ?? [], total: countRow?.n ?? 0 };
}

export async function getProductBySlug(env: Env, slug: string): Promise<ProductWithCategory | null> {
  return env.DB.prepare(`${PRODUCT_SELECT} WHERE p.slug = ?`)
    .bind(slug)
    .first<ProductWithCategory>();
}

export async function getProductById(env: Env, id: number): Promise<ProductWithCategory | null> {
  return env.DB.prepare(`${PRODUCT_SELECT} WHERE p.id = ?`).bind(id).first<ProductWithCategory>();
}

/** Loads many products at once, preserving the caller's id order (cart rendering). */
export async function getProductsByIds(env: Env, ids: number[]): Promise<Product[]> {
  const unique = [...new Set(ids)].filter((id) => Number.isInteger(id) && id > 0);
  if (!unique.length) return [];
  const placeholders = unique.map(() => '?').join(',');
  const { results } = await env.DB.prepare(
    `SELECT * FROM products WHERE id IN (${placeholders})`,
  )
    .bind(...unique)
    .all<Product>();
  const byId = new Map((results ?? []).map((p) => [p.id, p]));
  return unique.map((id) => byId.get(id)).filter((p): p is Product => Boolean(p));
}

export async function relatedProducts(
  env: Env,
  product: Product,
  limit = 4,
): Promise<ProductWithCategory[]> {
  const { results } = await env.DB.prepare(
    `${PRODUCT_SELECT}
     WHERE p.status = 'active' AND p.id != ? AND (p.category_id = ? OR ? IS NULL)
     ORDER BY (p.category_id = ?) DESC, p.featured DESC, RANDOM()
     LIMIT ?`,
  )
    .bind(product.id, product.category_id, product.category_id, product.category_id, limit)
    .all<ProductWithCategory>();
  return results ?? [];
}

/** Decrements stock without going negative. Returns rows changed. */
export async function decrementStock(env: Env, productId: number, quantity: number): Promise<number> {
  const res = await env.DB.prepare(
    'UPDATE products SET stock = MAX(0, stock - ?), updated_at = datetime(\'now\') WHERE id = ?',
  )
    .bind(quantity, productId)
    .run();
  return res.meta.changes ?? 0;
}

export async function touchProduct(env: Env, productId: number): Promise<void> {
  await env.DB.prepare("UPDATE products SET updated_at = datetime('now') WHERE id = ?")
    .bind(productId)
    .run();
}

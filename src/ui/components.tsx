import type { FC, PropsWithChildren } from 'hono/jsx';
import type { Category, Product, ProductWithCategory } from '../types';
import { formatPence, discountPercent } from '../lib/money';
import { parseJsonArray } from '../lib/util';

/**
 * Shared storefront presentation components. No data fetching here — routes
 * in src/routes/storefront.tsx load rows and pass them in as props.
 */

type AnyProduct = Product | ProductWithCategory;

/** Generic neutral placeholder shown when a product/category has no image. */
export const ImagePlaceholder: FC<{ label?: string }> = ({ label }) => (
  <span class="ph" role="img" aria-label={label ?? 'No image available'}>
    <svg viewBox="0 0 64 64" width="42" height="42" aria-hidden="true">
      <path
        fill="currentColor"
        d="M25 5h14v7h3a5 5 0 0 1 5 5v36a6 6 0 0 1-6 6H23a6 6 0 0 1-6-6V17a5 5 0 0 1 5-5h3V5Zm4 4v3h6V9h-6ZM22 17a1 1 0 0 0-1 1v36a2 2 0 0 0 2 2h18a2 2 0 0 0 2-2V18a1 1 0 0 0-1-1H22Zm10 6a8 8 0 1 1 0 16 8 8 0 0 1 0-16Zm0 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z"
      />
    </svg>
  </span>
);

/** Price with an optional struck-through "was" price and a saving percentage. */
export const PriceBlock: FC<{
  pricePence: number;
  compareAtPence?: number | null;
  size?: 'sm' | 'lg';
}> = ({ pricePence, compareAtPence, size }) => {
  const pct = discountPercent(pricePence, compareAtPence ?? null);
  return (
    <div class="price-row">
      <span class={size === 'lg' ? 'price-lg' : 'price'}>{formatPence(pricePence)}</span>
      {pct ? <span class="price-was">{formatPence(compareAtPence as number)}</span> : null}
      {pct && size === 'lg' ? <span class="pill pill-warn">Save {pct}%</span> : null}
    </div>
  );
};

/** In-stock / low-stock / out-of-stock pill. */
export const StockBadge: FC<{ stock: number }> = ({ stock }) => {
  if (stock <= 0) return <span class="pill pill-bad">Out of stock</span>;
  if (stock <= 5) return <span class="pill pill-warn">Only {stock} left</span>;
  return <span class="pill pill-ok">In stock</span>;
};

export const ProductCard: FC<{ product: AnyProduct }> = ({ product }) => {
  const pct = discountPercent(product.price_pence, product.compare_at_pence);
  const outOfStock = product.stock <= 0;
  const images = parseJsonArray(product.images_json);
  const img = product.image_url || images[0] || null;
  return (
    <div class="card">
      <a href={`/product/${product.slug}`} tabindex={-1} aria-hidden="true">
        <div class="card-media">
          {outOfStock ? (
            <span class="badge badge-out">Out of stock</span>
          ) : pct ? (
            <span class="badge">-{pct}%</span>
          ) : null}
          {img ? <img src={img} alt="" loading="lazy" /> : <ImagePlaceholder label={product.title} />}
        </div>
      </a>
      <div class="card-body">
        {product.brand ? <div class="card-meta">{product.brand}</div> : null}
        <h3 class="card-title">
          <a href={`/product/${product.slug}`}>{product.title}</a>
        </h3>
        <PriceBlock pricePence={product.price_pence} compareAtPence={product.compare_at_pence} />
      </div>
    </div>
  );
};

export const ProductGrid: FC<{ products: AnyProduct[] }> = ({ products }) => (
  <div class="product-grid">
    {products.map((product) => (
      <ProductCard product={product} />
    ))}
  </div>
);

export const CategoryTile: FC<{ category: Category & { product_count?: number } }> = ({ category }) => (
  <a class="cat-tile" href={`/category/${category.slug}`}>
    {category.image_url ? (
      <img src={category.image_url} alt="" width={40} height={40} style="object-fit:contain" />
    ) : (
      <span class="emoji">{category.emoji || '🛍️'}</span>
    )}
    <strong>{category.name}</strong>
    {typeof category.product_count === 'number' ? (
      <span class="faint small">
        {category.product_count} product{category.product_count === 1 ? '' : 's'}
      </span>
    ) : null}
  </a>
);

export interface PaginationProps {
  page: number;
  totalPages: number;
  /** Builds the href for a given 1-based page number, preserving other query params. */
  makeHref: (page: number) => string;
}

export const Pagination: FC<PaginationProps> = ({ page, totalPages, makeHref }) => {
  if (totalPages <= 1) return null;
  const pages: number[] = [];
  const start = Math.max(1, page - 2);
  const end = Math.min(totalPages, page + 2);
  for (let i = start; i <= end; i++) pages.push(i);
  return (
    <nav class="pagination" aria-label="Pagination">
      {page > 1 ? <a href={makeHref(page - 1)}>Previous</a> : <span aria-disabled="true">Previous</span>}
      {start > 1 ? (
        <>
          <a href={makeHref(1)}>1</a>
          {start > 2 ? <span>…</span> : null}
        </>
      ) : null}
      {pages.map((p) =>
        p === page ? (
          <span aria-current="page">{p}</span>
        ) : (
          <a href={makeHref(p)}>{p}</a>
        ),
      )}
      {end < totalPages ? (
        <>
          {end < totalPages - 1 ? <span>…</span> : null}
          <a href={makeHref(totalPages)}>{totalPages}</a>
        </>
      ) : null}
      {page < totalPages ? <a href={makeHref(page + 1)}>Next</a> : <span aria-disabled="true">Next</span>}
    </nav>
  );
};

export const EmptyState: FC<PropsWithChildren<{ emoji?: string; title: string; message?: string }>> = ({
  emoji = '🛍️',
  title,
  message,
  children,
}) => (
  <div class="empty">
    <span class="emoji">{emoji}</span>
    <h2>{title}</h2>
    {message ? <p class="muted">{message}</p> : null}
    {children}
  </div>
);

export interface BreadcrumbItem {
  label: string;
  href?: string;
}

export const Breadcrumbs: FC<{ items: BreadcrumbItem[] }> = ({ items }) => (
  <nav class="breadcrumbs" aria-label="Breadcrumb">
    {items.map((item, i) => (
      <>
        {i > 0 ? <span> / </span> : null}
        {item.href ? <a href={item.href}>{item.label}</a> : <span>{item.label}</span>}
      </>
    ))}
  </nav>
);

export const Notice: FC<PropsWithChildren<{ kind?: 'ok' | 'warn' | 'bad' }>> = ({ kind, children }) => (
  <div class={kind ? `notice notice-${kind}` : 'notice'} role={kind === 'bad' ? 'alert' : undefined}>
    {children}
  </div>
);

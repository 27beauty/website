import type { FC, PropsWithChildren } from 'hono/jsx';
import type { Category } from '../types';

/**
 * The storefront shell: topbar, header, category nav and footer.
 * Admin pages use src/ui/admin-layout.tsx instead.
 */

export interface LayoutProps {
  title: string;
  description?: string;
  categories?: Category[];
  cartCount?: number;
  canonical?: string;
  siteName?: string;
  noindex?: boolean;
  /** Slug of the category to mark as the current page in the nav. */
  activeCategory?: string;
  /** Raw JSON-LD injected into <head> for product/organisation markup. */
  jsonLd?: string;
  bodyClass?: string;
}

export const Layout: FC<PropsWithChildren<LayoutProps>> = (props) => {
  const site = props.siteName ?? '27beauty';
  const title = props.title.includes(site) ? props.title : `${props.title} | ${site}`;
  const cartCount = props.cartCount ?? 0;
  return (
    <html lang="en-GB">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title}</title>
        {props.description ? <meta name="description" content={props.description} /> : null}
        {props.canonical ? <link rel="canonical" href={props.canonical} /> : null}
        {props.noindex ? <meta name="robots" content="noindex,nofollow" /> : null}
        <meta property="og:title" content={title} />
        {props.description ? <meta property="og:description" content={props.description} /> : null}
        <meta property="og:type" content="website" />
        <meta name="theme-color" content="#6d2350" />
        <link rel="icon" href="/assets/favicon.svg" type="image/svg+xml" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600;9..144,700&family=Inter:wght@400;500;600;700&display=swap"
        />
        <link rel="stylesheet" href="/assets/styles.css" />
        {props.jsonLd ? (
          <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: props.jsonLd }} />
        ) : null}
      </head>
      <body class={props.bodyClass}>
        <a class="skip-link" href="#main">
          Skip to content
        </a>
        <div class="topbar">
          <div class="wrap">
            <span>Free UK delivery on every order · Got a QR card? Use your code at checkout.</span>
          </div>
        </div>
        <header class="site-header">
          <div class="wrap">
            <a class="brand" href="/">
              27<span>beauty</span>
            </a>
            <form class="search-form" action="/search" method="get" role="search">
              <label class="sr-only" for="q">
                Search products
              </label>
              <input id="q" type="search" name="q" placeholder="Search the shop…" autocomplete="off" />
              <button type="submit">Search</button>
            </form>
            <div class="header-actions">
              <a class="header-link" href="/b2b">
                Trade
              </a>
              <a class="cart-link" href="/cart">
                Basket
                {cartCount > 0 ? <span class="cart-count">{cartCount}</span> : null}
              </a>
            </div>
          </div>
        </header>
        {props.categories && props.categories.length ? (
          <nav class="catnav" aria-label="Shop categories">
            <div class="wrap">
              <a href="/shop" aria-current={props.activeCategory === 'all' ? 'page' : undefined}>
                All products
              </a>
              {props.categories.map((cat) => (
                <a
                  href={`/category/${cat.slug}`}
                  aria-current={props.activeCategory === cat.slug ? 'page' : undefined}
                >
                  {cat.emoji ? `${cat.emoji} ` : ''}
                  {cat.name}
                </a>
              ))}
            </div>
          </nav>
        ) : null}
        <main id="main">
          <div class="wrap">{props.children}</div>
        </main>
        <footer class="site-footer">
          <div class="wrap">
            <div class="footer-grid">
              <div>
                <h4>27beauty</h4>
                <p class="muted">
                  Everyday brands at everyday prices, shipped from the UK. Bought from us on a
                  marketplace? Scan your card for 10% off here.
                </p>
              </div>
              <div>
                <h4>Shop</h4>
                <ul>
                  <li>
                    <a href="/shop">All products</a>
                  </li>
                  {(props.categories ?? []).slice(0, 5).map((cat) => (
                    <li>
                      <a href={`/category/${cat.slug}`}>{cat.name}</a>
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <h4>Help</h4>
                <ul>
                  <li>
                    <a href="/pages/delivery">Delivery &amp; returns</a>
                  </li>
                  <li>
                    <a href="/pages/contact">Contact us</a>
                  </li>
                  <li>
                    <a href="/b2b">Trade &amp; wholesale</a>
                  </li>
                  <li>
                    <a href="/pages/terms">Terms</a>
                  </li>
                  <li>
                    <a href="/pages/privacy">Privacy</a>
                  </li>
                </ul>
              </div>
            </div>
            <div class="footer-bottom row-between">
              <span>© {new Date().getFullYear()} 27beauty. All rights reserved.</span>
              <span class="faint">Secure card payments by Stripe</span>
            </div>
          </div>
        </footer>
      </body>
    </html>
  );
};

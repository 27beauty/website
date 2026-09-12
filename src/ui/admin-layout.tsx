import type { FC, PropsWithChildren } from 'hono/jsx';

/**
 * The admin shell: compact top bar + a section nav that is a thumb-reachable
 * bottom tab bar on a phone and a sidebar at desktop widths. Admin pages use
 * this instead of src/ui/layout.tsx. Genuinely usable one-handed — the owner
 * updates stock standing in a stockroom, packs orders at a kitchen table.
 */

export type AdminSection = 'dashboard' | 'products' | 'orders' | 'coupons' | 'settings';

export interface AdminLayoutProps {
  title: string;
  active?: AdminSection;
  admin: { email: string; csrf: string } | null;
  /** Flash message, driven by ?msg=/?err= on the redirect that led here. */
  msg?: string | null;
  err?: string | null;
  bodyClass?: string;
}

/** Small line-icon set for the nav, drawn inline so there's no extra asset or build step. */
const NAV_ICONS: Record<AdminSection, string> = {
  dashboard: 'M4 11.5 12 4l8 7.5M6 10.2V20h5v-5.5h2V20h5v-9.8',
  products: 'M13 4h5a2 2 0 0 1 2 2v5L11.5 19.5 4 12 13 4Z M15.5 8.5h.01',
  orders: 'M3 8l9-4 9 4-9 4-9-4Z M3 8v8l9 4 9-4V8 M12 12v8',
  coupons: 'M4 9a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v1.4a1.7 1.7 0 0 0 0 3.2V16a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-1.4a1.7 1.7 0 0 0 0-3.2V9Z',
  settings:
    'M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4Z M19.4 12a7.4 7.4 0 0 1-.1 1.3l1.9 1.5-1.9 3.3-2.2-.9a7.6 7.6 0 0 1-2.3 1.3L14.5 21h-5l-.3-2.5a7.6 7.6 0 0 1-2.3-1.3l-2.2.9-1.9-3.3 1.9-1.5A7.4 7.4 0 0 1 4.6 12c0-.4 0-.9.1-1.3l-1.9-1.5 1.9-3.3 2.2.9a7.6 7.6 0 0 1 2.3-1.3L9.5 3h5l.3 2.5a7.6 7.6 0 0 1 2.3 1.3l2.2-.9 1.9 3.3-1.9 1.5c.1.4.1.9.1 1.3Z',
};

const NavIcon: FC<{ id: AdminSection }> = ({ id }) => (
  <span class="nav-icon" aria-hidden="true">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
      <path d={NAV_ICONS[id]} />
    </svg>
  </span>
);

const NAV: Array<{ id: AdminSection; label: string; href: string }> = [
  { id: 'dashboard', label: 'Dashboard', href: '/admin' },
  { id: 'products', label: 'Products', href: '/admin/products' },
  { id: 'orders', label: 'Orders', href: '/admin/orders' },
  { id: 'coupons', label: 'Coupons', href: '/admin/coupons' },
  { id: 'settings', label: 'Settings', href: '/admin/settings' },
];

/** Hidden CSRF field for every admin POST form. */
export const CsrfField: FC<{ token: string | undefined }> = ({ token }) => (
  <input type="hidden" name="_csrf" value={token ?? ''} />
);

/**
 * One flash message with a CSS-only dismiss (a visually-hidden checkbox +
 * label — no JavaScript). `kind` picks the colour + icon; the text label
 * always states the state too, so nothing here relies on colour alone.
 */
const Flash: FC<{ id: string; kind: 'ok' | 'bad'; text: string }> = ({ id, kind, text }) => (
  <div class="admin-flash">
    <input type="checkbox" id={id} class="flash-toggle" />
    <div class={`notice notice-${kind} flash-notice`}>
      <span class="flash-icon" aria-hidden="true">
        {kind === 'ok' ? '✓' : '!'}
      </span>
      <span class="flash-text">{text}</span>
      <label for={id} class="flash-close" aria-label="Dismiss this message">
        ×
      </label>
    </div>
  </div>
);

/**
 * Floating shortcut to the one job the owner does most: updating stock.
 * Jumps straight into the products list sorted by lowest stock first, so the
 * fields that need attention are the first ones on screen — no filtering by
 * hand. Reuses the existing /admin/products query params; no new route.
 */
const StockShortcut: FC = () => (
  <a class="stock-fab no-print" href="/admin/products?sort=stock_asc" aria-label="Jump to stock levels, lowest first">
    <span aria-hidden="true">✎</span> Stock
  </a>
);

export const AdminLayout: FC<PropsWithChildren<AdminLayoutProps>> = (props) => {
  const title = props.title.includes('27beauty') ? props.title : `${props.title} · 27beauty admin`;
  return (
    <html lang="en-GB">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <title>{title}</title>
        <meta name="robots" content="noindex,nofollow" />
        <link rel="icon" href="/assets/favicon.svg" type="image/svg+xml" />
        <link rel="stylesheet" href="/assets/styles.css" />
        <link rel="stylesheet" href="/assets/admin.css" />
      </head>
      <body class={`admin-page ${props.bodyClass ?? ''}`}>
        <div class="admin-shell">
          <header class="admin-topbar no-print">
            <a class="admin-brand" href="/admin">
              27<span>beauty</span> <small>admin</small>
            </a>
            {props.admin ? (
              <div class="admin-user">
                <span class="admin-user-email">{props.admin.email}</span>
                <a class="admin-user-link" href="/admin/settings/password">
                  Change password
                </a>
                <form method="post" action="/admin/logout">
                  <CsrfField token={props.admin.csrf} />
                  <button class="btn btn-secondary btn-sm" type="submit">
                    Log out
                  </button>
                </form>
              </div>
            ) : null}
          </header>
          <div class="admin-layout">
            {props.admin ? (
              <nav class="admin-nav no-print" aria-label="Admin sections">
                {NAV.map((item) => (
                  <a href={item.href} aria-current={props.active === item.id ? 'page' : undefined}>
                    <NavIcon id={item.id} />
                    <span class="nav-label">{item.label}</span>
                  </a>
                ))}
              </nav>
            ) : null}
            <main class="admin-main">
              {props.msg ? <Flash id="flash-msg" kind="ok" text={props.msg} /> : null}
              {props.err ? <Flash id="flash-err" kind="bad" text={props.err} /> : null}
              {props.children}
            </main>
          </div>
          {/* A jump-to-stock shortcut earns its place on the dashboard. On the
              other pages it only floats over forms and the sticky save bar. */}
          {props.admin && props.active === 'dashboard' ? <StockShortcut /> : null}
        </div>
      </body>
    </html>
  );
};

/** Bare page (no nav/topbar) for print-only views: packing slips, QR sheets. */
export const AdminPrintPage: FC<PropsWithChildren<{ title: string; bodyClass?: string }>> = (props) => (
  <html lang="en-GB">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{props.title}</title>
      <meta name="robots" content="noindex,nofollow" />
      <link rel="stylesheet" href="/assets/styles.css" />
      <link rel="stylesheet" href="/assets/admin.css" />
    </head>
    <body class={`admin-print-page ${props.bodyClass ?? ''}`}>{props.children}</body>
  </html>
);

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
        <meta name="viewport" content="width=device-width, initial-scale=1" />
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
                    {item.label}
                  </a>
                ))}
              </nav>
            ) : null}
            <main class="admin-main">
              {props.msg ? <div class="notice notice-ok admin-flash">{props.msg}</div> : null}
              {props.err ? <div class="notice notice-bad admin-flash">{props.err}</div> : null}
              {props.children}
            </main>
          </div>
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

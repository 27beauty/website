# 27beauty — engineering notes

E-commerce site for **27beauty.co.uk**. It exists to convert marketplace (eBay)
customers into direct customers: every parcel ships with a QR card, the customer
scans it, lands here and gets 10% off with a coupon code.

## Stack

| Concern        | Choice                                                        |
| -------------- | ------------------------------------------------------------- |
| Runtime        | Cloudflare Workers (TypeScript, ES modules)                    |
| Routing / SSR  | Hono + `hono/jsx` server-rendered HTML (no client framework)    |
| Database       | Cloudflare D1 (SQLite) — binding `DB`                          |
| Sessions/cache | Cloudflare KV — binding `KV`                                   |
| Images         | Cloudflare R2 — binding `MEDIA`                                |
| Payments       | Stripe Checkout (hosted card page) + webhook                   |
| Scheduling     | Workers Cron Triggers (`*/30 * * * *`) → eBay sync             |
| Tests          | Vitest (pure logic; no network)                                |

## Commands

```bash
npm run dev                # wrangler dev on http://localhost:8787
npm run typecheck          # tsc --noEmit   (must pass before commit)
npm test                   # vitest run     (must pass before commit)
npm run db:migrate:local   # apply migrations to the local D1
npm run db:seed:local      # categories, settings, QR10 coupon
```

## Conventions

- **Money is integer pence, always.** Format only at render time with
  `formatPence()` from `src/lib/money.ts`. Never use floats for money.
- **SQL lives in `src/lib/*.ts`**, not in route files. Catalogue queries go in
  `src/lib/db.ts`.
- **Always use bound parameters** (`.bind(...)`). Never interpolate user input
  into SQL.
- **Escape nothing by hand** — `hono/jsx` escapes by default. Only use
  `dangerouslySetInnerHTML` for JSON-LD you generated yourself.
- **Server-rendered first.** Inline `<script>` is allowed for small
  progressive-enhancement touches (gallery thumbnails, print button). No build
  step for client JS, no npm UI libraries.
- **Styling**: use the existing classes and CSS custom properties in
  `public/assets/styles.css` (storefront) and `public/assets/admin.css` (admin).
  Add new rules to those files rather than inlining styles.
- **Mobile first.** Most traffic arrives by scanning a QR code on a phone.
- Every route module exports a `Hono<AppBindings>` instance; `src/index.tsx`
  mounts them. Do not create a second Hono app per file.
- Types come from `src/types.ts`. Extend that file rather than redeclaring rows.
- Prices, stock and product content that the owner has edited are protected from
  the eBay sync by the `price_locked`, `stock_locked` and `content_locked` flags.

## Module map

```
src/index.tsx            app wiring, security headers, 404/500, cron handler
src/types.ts             Env bindings + row types (single source of truth)
src/lib/db.ts            catalogue queries
src/lib/cart.ts          signed-cookie basket + pricing of the basket
src/lib/coupons.ts       coupon validation, discount maths, redemptions
src/lib/crypto.ts        HMAC cookie signing, PBKDF2 passwords (Web Crypto only)
src/lib/money.ts         pence formatting/markup helpers
src/lib/settings.ts      JSON settings stored in D1
src/lib/util.ts          slugs, order numbers, parsing helpers
src/lib/ebay/            eBay OAuth, API clients, sync engine
src/ui/layout.tsx        storefront shell
src/ui/admin-layout.tsx  admin shell
src/routes/storefront.tsx  home, shop, category, product, search, cart, pages
src/routes/checkout.tsx    checkout + Stripe Checkout session + success page
src/routes/webhooks.ts     Stripe webhook (raw body — keep it first in index)
src/routes/api.ts          health, sync trigger, JSON feeds
src/routes/admin/          admin panel routes
migrations/              D1 schema (0001_init.sql) + seed.sql
```

## Environment

Secrets live in `.dev.vars` locally (see `.dev.vars.example`) and in
`wrangler secret put` in production: `SESSION_SECRET`, `STRIPE_SECRET_KEY`,
`STRIPE_WEBHOOK_SECRET`, `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET`,
`EBAY_REFRESH_TOKEN`, `SYNC_TOKEN`.

## Definition of done

`npm run typecheck` and `npm test` both pass, the page works at 390px wide, and
no secret is printed, logged or rendered.

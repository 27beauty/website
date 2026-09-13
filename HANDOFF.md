# Handoff — 27beauty.co.uk

Context for whoever picks this up next, human or agent.

## What this is

A direct-to-customer shop for **27beauty**, a UK seller who currently sells
across two eBay accounts. The site exists for one commercial reason: every
marketplace parcel ships with a printed QR card, the customer scans it, lands on
the site with a discount already applied, and the next sale happens here with no
marketplace fee. Product range is everyday goods — pet food, toys and board
games, coffee and tea, hair/beauty/grooming, crisps and sweets, DIY, cereal
bars, small appliances, garden.

Everything runs on Cloudflare's free tier by design. The owner's hard constraint
is **never exceed free-tier limits** — see `docs/costs.md`.

## Where the code is

- Repo: `https://github.com/27beauty/website` (currently **public**)
- Branch: `claude/27beauty-ecommerce-site-9bqn9c` — this is the repo's **default
  branch**; there is no `main`
- Read `CLAUDE.md` first: stack, conventions, module map
- Then `docs/`: `deploy.md`, `admin-guide.md`, `qr-coupons.md`, `ebay-setup.md`,
  `costs.md`

## Stack

Cloudflare Workers + Hono + `hono/jsx` server-rendered HTML (no client
framework, no build step for client JS). D1 for data, KV for sessions and OAuth
tokens, R2 for uploaded images, Stripe Checkout for card payments, Workers Cron
for the eBay sync. TypeScript throughout, Vitest for tests.

## What is already built and verified

- **Storefront**: home, shop, 9 categories, search, product pages (gallery,
  JSON-LD), basket, `/qr/<CODE>` landing page, policy pages, sitemap
- **Checkout**: Stripe Checkout session built from prices recomputed server-side,
  webhook as the source of truth for payment, idempotent order/stock/coupon
  handling
- **Admin panel** at `/admin`: first-run setup, KV sessions with CSRF and login
  rate limiting, dashboard, a dedicated **Stock** screen showing website vs eBay
  quantities per channel, products with bulk stock editing, CSV import/export,
  image uploads, categories, orders with printable packing slips, coupon manager
  with QR generation and printable card sheets, settings
- **Coupons**: shop-wide (`QR10`), cards generated from a product (which discount
  the whole basket but land the customer on that product), an opt-in
  single-item restriction, and single-use batches
- **eBay sync**: OAuth (client-credentials and refresh-token), Browse and Sell
  Inventory clients, keyword category mapping, markup, per-field locks, delisted
  items archived not deleted, `sync_runs` audit trail, cron every 30 minutes,
  authenticated `/api/sync/ebay` trigger
- **133 tests passing**, `npm run typecheck` clean, CI on every push

## State of the Cloudflare account

Already created and configured (ids are committed in `wrangler.toml`):

| Resource | Name | State |
| --- | --- | --- |
| D1 database | `27beauty` | Created (WEUR). **Schema applied, seeded and populated**: 11 categories, 13 settings, the `QR10` coupon, 134 eBay category rules, **90 real products** imported from the owner's two eBay shops, and both shops registered in `ebay_accounts`. Both migrations recorded in `d1_migrations`, so `wrangler d1 migrations apply` correctly no-ops |
| KV namespace | `27beauty-KV` | Created, bound |
| R2 bucket | `27beauty-media` | Created, bound, 1 GB self-imposed budget |

**Nothing is deployed.** No Worker code has been uploaded and the domain is not
attached. The site is not reachable by anyone yet.

## What needs doing next

In order:

1. **Deploy the Worker.** The owner was walked through doing this from their own
   machine: `npm install && npx wrangler login && npx wrangler deploy`. Confirm
   with them whether this succeeded and what the `*.workers.dev` URL is.
   Alternatively the repo has a GitHub Actions workflow
   (`.github/workflows/deploy.yml`) that does bootstrap + migrate + deploy; it
   needs `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as repository
   secrets.
2. **`SESSION_SECRET`** — `npx wrangler secret put SESSION_SECRET` with 32 random
   bytes of hex. Signs admin sessions and basket cookies. Nothing should go live
   without it.
3. **First admin account** — visit `/admin/setup` once; it closes itself.
4. **Custom domain** — attach `27beauty.co.uk` and `www` in the Cloudflare
   dashboard (Workers & Pages → 27beauty → Settings → Domains & Routes). Needs
   the domain on Cloudflare nameservers. `SITE_URL` in `wrangler.toml` is already
   `https://27beauty.co.uk`; Stripe redirects, canonical URLs, the sitemap and
   every QR code are built from it, so don't run a real payment test before the
   domain resolves.
5. **Stripe** — `STRIPE_SECRET_KEY`, then add a webhook endpoint at
   `https://27beauty.co.uk/webhooks/stripe` for `checkout.session.completed`,
   `checkout.session.expired`, `checkout.session.async_payment_succeeded`,
   `checkout.session.async_payment_failed`, and store its signing secret as
   `STRIPE_WEBHOOK_SECRET`. Then place one real low-value order end to end and
   refund it: confirm the order shows **paid** in `/admin/orders` and stock went
   down by exactly one.
6. **eBay** — follow `docs/ebay-setup.md`: `EBAY_CLIENT_ID` and
   `EBAY_CLIENT_SECRET`, then flip `ebay.sync_enabled` on and press *Sync now*.
   Both accounts are already registered (**aisha-4515**, 30 listings, and
   **adinath0**, 60) in browse mode with 0% markup. Browse mode works with just
   app credentials; Sell mode needs a per-account refresh token and gives exact
   stock. **The first sync will correct the placeholder stock levels** — the 90
   imported products were seeded at 5 units each (1 where the listing said "Last
   one") because the catalogue capture carried no quantities.
7. **Ask whether the repo should be private.** It is public today. No secrets are
   committed (verified), but the owner may not have intended public.

## About the imported catalogue

The 90 products came from a spreadsheet capture of the owner's two eBay shops
(`db/ebay-catalogue.sql`), keyed on `ebay_item_id` so the live sync adopts and
updates them rather than duplicating. Two things to know:

- **Stock figures are placeholders** (5, or 1 for "Last one"). Nothing should be
  sold in volume until a real sync or a manual pass corrects them.
- **Images are hotlinked from eBay's CDN** (`i.ebayimg.com`, the `s-l500`
  variant). That costs no R2 storage, which suits the free-tier constraint, but
  the URLs die when a listing ends. The sync refreshes them; if a product is
  delisted the image goes with it.

## Things that will bite you if you don't know them

- **Money is integer pence everywhere.** Format only at render with
  `formatPence()`. Never floats.
- **Coupon codes are stored canonical** — uppercase letters and digits only.
  `normaliseCouponCode()` strips punctuation before every lookup, so a stored
  code containing a dash can never be found again. This shipped as a real bug
  once: every card in a generated batch was unredeemable. Render with
  `formatCouponCode()`; never store the pretty form.
- **The Stripe webhook, not the success redirect, marks an order paid.** All
  three of marking paid, decrementing stock and counting a redemption are
  idempotent because Stripe retries. Don't "simplify" those guards.
- **R2 has no spending cap.** Every write must go through `canStore()` in
  `src/lib/media.ts`, which refuses uploads past the budget; replaced and deleted
  images are reclaimed. Never add an R2 write path that skips it.
- **`/media/*` deliberately skips the security-headers middleware.** Rewriting
  headers on an edge-cached response throws `Can't modify immutable headers` and
  serves a 500. It's also edge-cached so reads rarely reach R2.
- **This SQLite build rejects long `UNION ALL` chains** ("too many terms in
  compound SELECT"). Build multi-row inserts with a `VALUES` CTE — see
  `db/seed.sql`.
- **Changing `database_id` in `wrangler.toml` re-keys local D1 storage**, so
  local dev starts from an empty database. Re-run
  `npm run db:migrate:local && npm run db:seed:local`.
- **Production migrations are already applied and recorded.** Don't re-run the
  schema by hand; the `ALTER TABLE` in `0002` would fail.
- **Claude Code's web sandbox is network-blocked from `api.cloudflare.com`,
  `developers.cloudflare.com` and eBay.** You cannot `wrangler deploy` or read
  Cloudflare docs from inside it. Deploy from the owner's machine or CI. The
  Cloudflare MCP connector does work for resources and D1 queries, but has no
  Worker-upload tool.

## How to work on this

```bash
npm install
cp .dev.vars.example .dev.vars     # fill in as needed
npm run db:migrate:local && npm run db:seed:local
npx wrangler d1 execute DB --local --file=./db/demo-products.sql   # optional sample catalogue
npm run dev                        # http://localhost:8787
npm run typecheck && npm test      # must both pass before committing
```

There is an agent team defined in `.claude/agents/` — an orchestrator on Opus 5
that owns shared foundations and integration, plus specialists for the
storefront, payments, admin, eBay sync and QA review, each owning a disjoint set
of files. The rule that keeps parallel work safe: **two agents never edit the
same file in the same round.**

Screenshots at 390px caught real problems that tests did not (crushed search
box, unreadable coupon code, 218px admin rows). If you change UI, drive a real
browser at phone width before calling it done.

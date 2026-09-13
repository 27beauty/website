# 27beauty.co.uk

The direct-to-customer shop for **27beauty**. Its job is narrow and commercial:
every marketplace parcel ships with a QR card, the customer scans it, lands on
this site with a 10% code already applied, and the next sale happens here
instead of on eBay — with no marketplace fee.

Built to run entirely on Cloudflare's free/cheap tier: one Worker, one D1
database, one KV namespace, one R2 bucket. No servers, no containers, no
monthly floor cost.

---

## What it does

| Area | Summary |
| --- | --- |
| **Storefront** | Home, nine categories, product pages, search, basket — server-rendered, mobile-first, works with JavaScript off |
| **Checkout** | Stripe Checkout (hosted card page), UK shipping address collection, flat-rate delivery with a free-delivery threshold |
| **Admin panel** | `/admin` — products, stock, categories, orders, coupons, settings, CSV import/export, image uploads |
| **eBay sync** | Pulls listings from both eBay accounts every 30 minutes: new listings, price and quantity changes, with per-field locks so your manual edits win |
| **QR coupons** | Shop-wide, **per-item** and single-use codes; printable QR card sheets for parcels; a `/qr/<CODE>` landing page that applies the discount and features the item it belongs to |

## Stack

- **Cloudflare Workers** — the whole app, deployed at the edge
- **Hono** + `hono/jsx` — routing and server-side rendering, no client framework
- **D1** (SQLite) — catalogue, orders, coupons, settings
- **KV** — admin sessions, eBay OAuth tokens, rate limits
- **R2** — product image uploads
- **Stripe Checkout** — card payments (no card data ever touches this app)
- **Cron Triggers** — the eBay sync, every 30 minutes

## Repository layout

```
src/index.tsx          app wiring, security headers, error pages, cron handler
src/types.ts           bindings + row types (single source of truth)
src/lib/               db, cart, coupons, crypto, money, settings, orders, stripe, qr
src/lib/ebay/          OAuth, Browse/Inventory clients, sync engine, category mapping
src/routes/            storefront, checkout, webhooks, api, admin/
src/ui/                storefront + admin shells and components
migrations/            D1 schema and seed data
docs/                  deployment, eBay setup, QR workflow runbooks
.claude/agents/        the agent team that builds and maintains this repo
```

---

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars      # then fill in your keys
npm run db:migrate:local
npm run db:seed:local
npm run dev                         # http://localhost:8787
```

Create your first admin login at <http://localhost:8787/admin/setup> — that page
only works while no admin account exists.

Before committing anything:

```bash
npm run typecheck && npm test
```

---

## Deploying to Cloudflare

Full step-by-step, including the domain, is in **[docs/deploy.md](docs/deploy.md)**.
The short version:

```bash
npx wrangler login
npx wrangler d1 create 27beauty                 # paste database_id into wrangler.toml
npx wrangler kv namespace create KV             # paste id into wrangler.toml
npx wrangler r2 bucket create 27beauty-media
npm run db:migrate:remote && npm run db:seed:remote
npx wrangler secret put SESSION_SECRET          # openssl rand -hex 32
npx wrangler secret put STRIPE_SECRET_KEY
npx wrangler secret put STRIPE_WEBHOOK_SECRET
npx wrangler secret put EBAY_CLIENT_ID
npx wrangler secret put EBAY_CLIENT_SECRET
npx wrangler secret put SYNC_TOKEN
npm run deploy
```

Then point `27beauty.co.uk` at the Worker (Workers & Pages → your Worker →
Settings → Domains & Routes → Add custom domain). The domain must use Cloudflare
nameservers; the certificate is issued automatically.

- **Stripe**: add a webhook endpoint at `https://27beauty.co.uk/webhooks/stripe`
  for `checkout.session.completed`, `checkout.session.expired`,
  `checkout.session.async_payment_succeeded` and
  `checkout.session.async_payment_failed`, then store the signing secret as
  `STRIPE_WEBHOOK_SECRET`.
- **eBay**: see **[docs/ebay-setup.md](docs/ebay-setup.md)**.
- **QR cards**: see **[docs/qr-coupons.md](docs/qr-coupons.md)**.
- **Running the shop day to day**: see **[docs/admin-guide.md](docs/admin-guide.md)**.
- **Staying inside the free tier**: see **[docs/costs.md](docs/costs.md)**.

---

## How the QR discount works

1. In the admin panel, open **Coupons**. `QR10` (10% off everything) exists out of
   the box. You can also generate single-use batches, or — the sharper move —
   open any product and press **Create QR code** to get a readable, item-specific
   code like `10OFFYORKSHIRETEA` that discounts just that product.
2. Print the card sheet (**Coupons → Print**) and slip one into every parcel.
3. The card's QR points at `https://27beauty.co.uk/qr/QR10`.
4. Scanning it opens the landing page, stores the code in the visitor's basket
   cookie and shows the discount all the way through checkout.
5. The discount is re-validated server-side when payment is taken — expiry, spend
   floor, usage limits and per-customer limits are all enforced at that moment,
   not when the code is typed in.

---

## The agent team

This repo is built and maintained by a small team of Claude Code agents defined
in [`.claude/agents/`](.claude/agents/README.md):

- **`shop-orchestrator`** (Opus 5) — plans work, splits it by file ownership,
  integrates and verifies. It owns the shared foundations.
- **`storefront-engineer`**, **`payments-engineer`**, **`admin-engineer`**,
  **`ebay-sync-engineer`**, **`qa-reviewer`** (Sonnet 5) — narrow briefs, each
  owning a disjoint set of files.

Ask for work at the top:

```
> use the shop-orchestrator agent to add gift wrapping as a checkout option
```

The rule that makes parallel agent work safe: **two agents never edit the same
file in the same round**, and anything shared belongs to the orchestrator.

## Running costs

Cloudflare Workers, D1, KV and R2 all have free tiers this shop sits inside
comfortably. R2 is the one service with no hard spending cap, so the app
enforces its own storage budget and refuses uploads that would cross it — see
**[docs/costs.md](docs/costs.md)** for exactly what is guarded and the two
things only you can do in the dashboard. Stripe charges per transaction (UK
cards ~1.5% + 20p at the time of writing). The only fixed cost is the domain.

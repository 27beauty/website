# Deploying 27beauty to Cloudflare

Everything below is done once. Budget about 45 minutes the first time, most of
it waiting for DNS.

## 0. Prerequisites

- A Cloudflare account (free tier is fine to start).
- `27beauty.co.uk` added to that Cloudflare account **using Cloudflare's
  nameservers** (Websites → Add a site → change the nameservers at your
  registrar). A custom domain on a Worker requires this; DNS propagation is
  usually minutes, occasionally a few hours.
- A Stripe account with UK bank details for payouts.
- Node 20+ locally.

```bash
git clone https://github.com/27beauty/website.git
cd website
npm install
npx wrangler login
```

## 1. Create the storage

```bash
npx wrangler d1 create 27beauty
npx wrangler kv namespace create KV
npx wrangler r2 bucket create 27beauty-media
```

Each command prints an id. Open `wrangler.toml` and replace:

- `database_id = "REPLACE_WITH_D1_DATABASE_ID"` with the D1 id
- `id = "REPLACE_WITH_KV_NAMESPACE_ID"` with the KV id

Commit that change — the ids are not secrets.

## 2. Create the schema

```bash
npm run db:migrate:remote     # tables
npm run db:seed:remote        # nine categories, default settings, the QR10 coupon
```

Locally, the same with `:local` gives you a sandbox database under `.wrangler/`.

## 3. Set the secrets

```bash
openssl rand -hex 32 | npx wrangler secret put SESSION_SECRET
npx wrangler secret put STRIPE_SECRET_KEY        # sk_live_... (sk_test_... to trial it)
npx wrangler secret put STRIPE_WEBHOOK_SECRET    # from step 6
npx wrangler secret put EBAY_CLIENT_ID
npx wrangler secret put EBAY_CLIENT_SECRET
openssl rand -hex 24 | npx wrangler secret put SYNC_TOKEN
```

`SESSION_SECRET` signs admin sessions and basket cookies. Rotating it logs
everyone out and empties live baskets — harmless, but do it deliberately.

Secrets are never rendered in the admin panel; Settings only shows *set* or
*not set*.

## 4. Deploy

```bash
npm run deploy
```

Wrangler prints a `*.workers.dev` URL. Open it and check the shop loads.

## 5. Point the domain at the Worker

Cloudflare dashboard → **Workers & Pages** → `27beauty` → **Settings** →
**Domains & Routes** → **Add** → **Custom domain**:

- `27beauty.co.uk`
- `www.27beauty.co.uk`

Cloudflare creates the DNS records and issues the TLS certificate itself. When
both show *Active*, the site is live on the real domain.

If `SITE_URL` in `wrangler.toml` is not already `https://27beauty.co.uk`, set it
and redeploy — Stripe redirects, canonical URLs, the sitemap and the QR links all
build on it.

## 6. Stripe

1. Stripe dashboard → **Developers → Webhooks → Add endpoint**.
2. URL: `https://27beauty.co.uk/webhooks/stripe`
3. Events: `checkout.session.completed`, `checkout.session.expired`,
   `checkout.session.async_payment_succeeded`,
   `checkout.session.async_payment_failed`.
4. Copy the signing secret (`whsec_…`) into `STRIPE_WEBHOOK_SECRET` (step 3) and
   redeploy.
5. Place one real low-value order end to end, then refund it in Stripe. Check the
   order appears in `/admin/orders` as **paid** and that stock went down by one.

The webhook — not the browser redirect — is what marks an order paid. A customer
who closes the tab after paying still gets a correct order.

## 7. First admin login

Visit `https://27beauty.co.uk/admin/setup`. It works only while no admin account
exists, and creates your owner account. After that it 404s.

If you ever lock yourself out:

```bash
node scripts/hash-password.mjs 'your-new-password'
npx wrangler d1 execute 27beauty --remote \
  --command "UPDATE admin_users SET password_hash='<paste-hash>' WHERE email='you@example.com';"
```

## 8. eBay sync

Follow [ebay-setup.md](ebay-setup.md), then in **Admin → Settings** add each eBay
account and press **Sync now**. The cron trigger in `wrangler.toml`
(`*/30 * * * *`) keeps it running every half hour after that.

## 9. Go-live checklist

- [ ] A real card payment completed and refunded
- [ ] The order shows as paid in `/admin/orders` with the right total
- [ ] Stock decremented once (not twice) for that order
- [ ] A QR card scanned on a phone applies the discount end to end
- [ ] `https://27beauty.co.uk/sitemap.xml` lists your products
- [ ] Delivery, returns, terms and privacy pages say what you actually do
- [ ] `SITE_URL` and the Stripe keys are the live ones, not test

## Day-to-day

```bash
npm run deploy                       # ship a change
npx wrangler tail                    # live logs
npx wrangler d1 execute 27beauty --remote --command "SELECT COUNT(*) FROM products;"
```

Rolling back: Workers keeps previous versions — **Workers & Pages → Deployments
→ Rollback**, or `npx wrangler rollback`.

## Backups

D1 is replicated by Cloudflare, but take your own copy before anything risky:

```bash
npx wrangler d1 export 27beauty --remote --output backup-$(date +%F).sql
```

Worth doing monthly, and always before a schema migration.

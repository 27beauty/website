# Staying inside the free tier

The shop is built to run at zero cost. This page says what the code enforces,
and what only you can do from the Cloudflare dashboard.

> **Check the numbers before relying on them.** The allowances below were
> correct when this was written, but Cloudflare changes them. The current
> figures are at [cloudflare.com/plans](https://www.cloudflare.com/plans/) and
> the per-product pricing pages.

## The one thing that matters most

**Stay on the Workers Free plan.** On the free plan, when you pass a limit
Cloudflare *throttles* — it does not bill you. The moment you upgrade to Workers
Paid ($5/month), overages become chargeable. Nothing in this shop needs the paid
plan.

The exception is **R2**: you had to add billing to switch it on, and R2 has **no
hard spending cap**. That is why the storage limit is enforced in the app
instead.

## What the code enforces

| Risk | Guardrail | Where |
| --- | --- | --- |
| Filling R2 with images | A storage budget set to the **10 GB** free allowance (decimal GB, the smaller reading). Uploads that would cross it are refused with a clear message. | `src/lib/media.ts` |
| A huge single file | Uploads capped at **50 MB** each (the Worker's 128 MB memory is the real ceiling) | `src/lib/media.ts` |
| A stolen admin login uploading in a loop | At most **30,000 uploads a day**, which keeps R2 writes inside the free 1,000,000 a month | `src/lib/media.ts` |
| Replaced photos piling up | Replacing a product photo **deletes the old object** and gives the bytes back | `src/routes/admin/products.tsx` |
| Deleted products leaving orphans | Deleting a product **deletes all its stored images** | `src/lib/media.ts` |
| Image views costing read operations | `/media/*` is served from the **edge cache**; only a cache miss reaches R2, and objects are immutable with a one-year TTL | `src/index.tsx` |
| Raising the limit by accident | The limit itself **cannot be set above the free 10 GB** | `src/routes/admin/settings.tsx` |
| Scripts inside an uploaded SVG | `/media/*` responses carry a locked-down CSP (`sandbox`) and `nosniff`, and ignore query strings when caching | `src/index.tsx` |
| Losing track | **Admin → Settings → Image storage** shows a meter, and "Recount from R2" re-checks reality | `/admin/settings` |

Tests in `test/media.test.ts` cover every guardrail, including the refusal paths.

## Free allowances, and how close this shop gets

| Service | Free allowance (verify current) | What the shop uses |
| --- | --- | --- |
| **Workers** | 100,000 requests/day | Every page view. A QR-card shop does not approach this; beyond it the free plan throttles rather than charges |
| **R2 storage** | 10 GB-month | Capped at 10 GB in the admin panel |
| **R2 Class A** (writes/lists) | 1,000,000/month | Only admin uploads — a few dozen a month |
| **R2 Class B** (reads) | 10,000,000/month | Only cache misses, because of the edge cache above |
| **R2 egress** | Free | — |
| **D1 storage** | 5 GB | A catalogue of thousands of products is a few MB |
| **D1 rows read** | Millions/day | A handful of rows per page view |
| **KV** | Reads generous, ~1,000 writes/day | Admin sessions, the eBay OAuth token cache (roughly 50/day), failed-login counters |

## What only you can do

1. **Do not upgrade to Workers Paid** unless you decide to. Nothing here needs it.
2. **Set a billing alert.** Cloudflare dashboard → Notifications → Add →
   *Billing usage* — and point it at your email. This is your safety net for R2,
   since Cloudflare will not stop the meter for you.
3. **Glance at R2 usage monthly.** Dashboard → R2 → your bucket. It should match
   what Admin → Settings → Image storage says. If it does not, press
   *Recount from R2*.
4. **Watch nothing else.** Everything outside R2 sits on free-plan throttling.

## If you want to use no R2 at all

Products work perfectly with image *URLs* rather than uploads — which is what
the eBay sync supplies anyway. Comment out the `[[r2_buckets]]` block in
`wrangler.toml` and redeploy: the shop, checkout, admin and sync all keep
working, and the upload form explains that uploads are off.

## If traffic ever grows

The next thing to watch would be D1 row reads on very high traffic. The fix is a
Cloudflare cache rule on the storefront HTML — worth doing at that point, not
before.

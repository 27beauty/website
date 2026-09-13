# Running the shop

Everything below happens at **27beauty.co.uk/admin**. It is built to work on a
phone as well as a laptop — you can update stock standing in the stockroom.

## Getting in

The first time, go to `/admin/setup` and create your account. That page stops
working the moment an account exists, so nobody else can use it.

After that, `/admin/login`. Ten wrong password attempts from the same connection
in fifteen minutes and it stops accepting more for a while — that is deliberate.

Forgotten the password? See the recovery command in
[deploy.md](deploy.md#7-first-admin-login).

## Dashboard

The front page answers the questions you actually ask each morning: what sold
today and over the last 30 days, what is waiting to be posted, what is running
low, what has gone out of stock, and when the eBay sync last ran.

## Products

**Products** lists everything, searchable and filterable by category, status,
source (manual or eBay) and low stock.

- **Stock** — edit the number straight in the list and press *Save changes*. One
  press saves every row you touched.
- **Add a product** — *New product*. Title, price and stock are the only fields
  that really matter; everything else improves the listing.
- **Photos** — upload straight from your phone's camera roll. Keep them square
  and on a white background where you can; the shop crops to a square tile.
- **Import a spreadsheet** — *Import CSV* takes
  `title,price,stock,sku,category,image_url,description`. It reports exactly
  which rows failed and why, so fix and re-import just those.
- **Export** — *Export CSV* gives you the whole catalogue, useful as a backup or
  for bulk-editing in a spreadsheet.
- **Archive vs delete** — archiving hides a product but keeps its history and
  its web address alive. Prefer it. Delete only something created by mistake.

### The eBay locks

Every product synced from eBay has three switches:

| Lock | What it protects |
| --- | --- |
| **Price** | Your price stays put even when eBay's changes |
| **Stock** | Your stock figure stays put — use when you keep website stock separately |
| **Content** | Your title, description and photos stay put |

Set a lock whenever you have edited something by hand and want it to survive the
next sync. Nothing else is protected: unlocked fields follow eBay.

## Orders

Orders arrive as **paid** — the money has already cleared through Stripe before
an order appears.

1. Open the order, press **Packing slip**, print it, pack the parcel.
2. **Slip a QR card in.** This is the point of the whole site.
3. Press **Mark fulfilled** and add the tracking number if there is one.

**Cancel** puts the stock back. **Refund** records it here — you still refund the
money in Stripe, which is deliberate: only Stripe can move money.

## Coupons and QR cards

**Coupons** is where the marketplace-to-direct loop lives.

- `QR10` is set up already: 10% off, unlimited use. It is the code on your
  standard card.
- **A card made from a product** — open the product, scroll to *QR discount for
  this item*, pick a percentage and press **Create QR code**. The discount comes
  off the customer's **whole basket**, and the card lands them on that product.
  Best used when you know what they bought: put a cat-treat card in a cat-treat
  parcel, and they arrive somewhere familiar with 10% off everything. Tick
  *Restrict to this item only* if you'd rather discount just that product.
- **Generate batch** creates a run of single-use codes (say 100 for a print run)
  that each work exactly once, so you can tell which cards converted.
- **Print** lays a batch out as cards on A4, ready to guillotine and drop into
  parcels.
- **Poster** prints a single large QR for a shop counter or a market stall.

The full playbook — how many to print, what to write on them, how to protect your
margin — is in [qr-coupons.md](qr-coupons.md).

## Settings

- **Store** — name, tagline, contact details shown on the site.
- **Delivery** — your flat rate and the order value that earns free delivery.
  Both apply immediately, including to baskets already open.
- **Checkout** — a switch to stop taking orders (holidays, stock-take).
- **eBay** — add each account, choose browse or sell mode, set a markup
  percentage, and press **Sync now** to pull listings immediately. Underneath is
  the log of the last 20 syncs and what each one changed.
- **Keys** — shows whether Stripe and eBay credentials are configured. It never
  shows the keys themselves, not even to you; that is the point of a secret.

## A sensible weekly rhythm

| When | What |
| --- | --- |
| Each morning | Dashboard → post yesterday's orders, QR card in every parcel |
| Twice a week | Products → low stock filter → restock or set to draft |
| Weekly | Coupons → check redemptions against parcels shipped |
| Monthly | Settings → check the sync log for repeated failures; export a CSV backup |

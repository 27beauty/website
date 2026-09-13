# Connecting eBay to the website

This page is for the shop owner, not a developer. It explains how to get your
eBay listings showing up automatically on 27beauty.co.uk, so a customer who
scans the QR card in their parcel finds the same product here.

The website checks eBay automatically **every 30 minutes**. You don't need to
do anything to trigger it — this guide is a one-off setup, plus how to add a
second eBay account later and how to read the sync log.

---

## 1. Create an eBay developer account

1. Go to **developer.ebay.com** and sign in with your normal eBay seller
   login (the same one you use for your shop).
2. Click **"Get Started"** / **"Register"** if you haven't got a developer
   account yet. This is free.
3. Once signed in, go to **"My Account" → "Application Keys"**.
4. You'll see two sets of keys: **Sandbox** (for testing, not needed here)
   and **Production**. You want the **Production** keys.
5. Create a "Production" keyset if you don't have one. eBay will show you:
   - **App ID (Client ID)**
   - **Cert ID (Client Secret)**

   Keep this page open — you'll need both in step 3.

You do **not** need to publish an app or get anything approved for the
"browse mode" described below — the production keys work immediately for
reading public listing data.

## 2. Find your seller username(s)

This is simply the name shown on your eBay shop / listings, e.g. if your
listings page is `ebay.co.uk/usr/mystore99`, your seller username is
`mystore99`. Since you sell across **two eBay accounts**, write down both
usernames — you'll enter one per account in the admin panel in step 4.

## 3. Give the website your eBay keys

The website's engineer (or whoever deployed the site) needs to run two
commands, once, on the server:

```bash
wrangler secret put EBAY_CLIENT_ID
# paste the "App ID (Client ID)" from step 1 when prompted

wrangler secret put EBAY_CLIENT_SECRET
# paste the "Cert ID (Client Secret)" from step 1 when prompted
```

These are shared by both of your eBay accounts — you only do this once, not
once per account. Nobody can see these values again after they're pasted in;
if they're ever lost, generate a new keyset in step 1 and repeat this step.

You will also want a **sync token** — a password the website uses to let an
external trigger (or the "Sync now" button) kick off a check without needing
to log into the admin panel:

```bash
wrangler secret put SYNC_TOKEN
# paste any long random password — a password manager's "generate" button is fine
```

## 4. Add each eBay account in the admin panel

In the admin panel, under **Settings → eBay Accounts**, add one row per eBay
account:

| Field | What to put |
| --- | --- |
| Label | A name for your own reference, e.g. "Main Shop" or "Pet & Garden" |
| Seller username | From step 2 |
| Mode | `browse` to start (see below) |
| Markup % | An amount added on top of the eBay price if you want the website price slightly higher (0 = same price) |
| Default category | Where to file a listing if none of the automatic category rules match it |
| Auto-publish | On = new listings appear live immediately; off = they arrive as drafts for you to check first |
| Active | Must be switched on for the account to sync at all |

Turn on the **"eBay sync enabled"** switch in Settings → eBay once you've
added your account(s) — the automatic 30-minute check does nothing while
this is off.

## 5. Browse mode vs. sell mode — which do I need?

There are two ways the website can read your eBay listings. You can mix
them — some accounts on browse, others on sell.

### Browse mode (the default, and the easiest)

- Works immediately with just the Client ID/Secret from step 1 — no further
  eBay authorisation needed.
- Reads your **public listings**, the same way a shopper searching eBay
  would see them.
- **Limitation: stock is a rough estimate, not an exact count.** eBay's
  public search only tells us "in stock", "limited stock" or "out of
  stock" — never the number left. The website turns that into a sensible
  guess (currently 10 / 3 / 0 units) so the "add to basket" button behaves
  reasonably, but it will not exactly match your true eBay stock. If you
  need exact stock, use sell mode below for that account.
- Only pulls the extra photos and full description for **brand-new**
  products (to stay within eBay's rate limits) — existing products only
  get their price and stock refreshed on later checks.

### Sell mode (exact stock, more setup)

- Reads your **private seller inventory** directly, so price and stock are
  always exact.
- Requires a one-off authorisation described in step 6 below.
- Falls back to browse mode automatically if the authorisation is ever
  missing or expires, so nothing breaks — but you'll want to notice and
  redo step 6 if that happens (check the sync log, step 7).

## 6. Getting a refresh token for sell mode

Do this only for an account you've set to **sell mode**. It's a one-off
"please allow this website to read my eBay inventory" consent, similar to
the popup you'd get connecting a bank account to a budgeting app.

1. In developer.ebay.com, under your application, set up a **RuName**
   (eBay's name for a redirect URL). Development → User Tokens → "Get a
   Token from eBay via Your Application" will prompt you to add one if you
   haven't. Any working redirect URL is fine — a simple confirmation page
   your engineer can set up, or eBay's own generic one from that same
   screen.
2. eBay will show you a sign-in link (the "authorisation" link). Open it,
   sign in with your eBay seller account, and click **Agree**/**I agree**
   to grant access to your inventory. Do this from the eBay account itself,
   not your developer account, if they differ.
3. eBay redirects back to the RuName above with a code in the address bar
   (a long string after `?code=`). Copy that whole code — it expires in a
   few minutes, so move to the next step quickly.
4. Your engineer exchanges that code for a **refresh token** (a one-time
   command using the Client ID/Secret from step 1 and the code from step 3
   — eBay's "Generate a User Token" page in the developer portal can do
   this exchange for you directly if you'd rather not involve an engineer at
   this step). The refresh token is the long-lived credential the sync uses
   from then on — the short-lived code from step 3 is discarded.
5. Store the refresh token as a secret:

   ```bash
   wrangler secret put EBAY_REFRESH_TOKEN
   # for a second account on sell mode, use EBAY_REFRESH_TOKEN_2 instead
   ```

6. In the admin panel, set that account's **"Refresh token"** field to the
   secret's name (`EBAY_REFRESH_TOKEN` or `EBAY_REFRESH_TOKEN_2`) and its
   **Mode** to `sell`.

eBay refresh tokens last about 18 months; you'll need to repeat this step
if one ever expires (the sync log, below, will start showing a "used browse
mode instead" note for that account when it does).

## 7. The automatic schedule

The website checks eBay every **30 minutes**, all day, every day, as long as
"eBay sync enabled" (step 4) is switched on. There's nothing to run
manually, but the admin panel also has a **"Sync now"** button if you've
just changed a listing on eBay and don't want to wait.

## 8. Reading the sync log

In the admin panel, under **Settings → eBay → Sync log**, each row is one
check, showing:

- **When** it ran, and whether it was the automatic schedule, a manual
  button press, or an external trigger.
- **Created / Updated / Ended** — how many products were added, refreshed,
  or marked as no longer available that time.
- **Status** — `ok` if everything went smoothly, `error` if something needs
  attention (see the message alongside it).

A few things worth knowing about what you'll see there:

- If one account has a problem (say, eBay is temporarily rate-limiting the
  website), the log will say so for that account, but your **other**
  account still syncs normally in the same run.
- A product that's sold out or been removed from eBay is never deleted from
  the website — it's kept as "archived" with zero stock, so old order
  history and any links you've shared to it keep working. It quietly comes
  back to life if you relist the same item.
- If you've hand-edited a product's price, stock or description/photos in
  the admin panel and ticked its "locked" box for that field, the eBay sync
  will leave that field alone from then on, and only update the parts you
  haven't locked.


## How quickly do new listings appear?

The sync runs **every 10 minutes**, so a listing you create on either eBay
account shows up on the website within about ten minutes. Pressing **Sync now**
in Admin → Settings pulls it immediately.

If you want it faster, change `crons` in `wrangler.toml` to `*/5 * * * *` and
redeploy — that doubles the number of runs and is still nowhere near any free
limit. Going below five minutes is not worth it: eBay's own search index takes
a few minutes to show a new listing anyway, so the website would just be asking
more often for the same answer.

Truly instant would mean eBay pushing a notification to the site the moment a
listing goes live, rather than the site asking. eBay does support that, but it
needs a notification subscription set up against a public endpoint and is a
noticeably bigger piece of work — worth doing only if ten minutes ever proves
too slow in practice.

## Stock across two channels

The website keeps its own stock figure — the one it sells from — and records
what eBay last reported alongside it. **Admin → Stock** shows both, and flags
any product where they disagree.

Unlocked products follow eBay: a sync overwrites the website figure. Tick
**Lock stock** on a product when you want your own number to stand, for example
when you hold stock back for the website. Either way the eBay figure keeps
updating in the background, so the comparison stays honest.

What this does *not* yet do is push your website figure back to eBay — that
needs sell-mode credentials (a refresh token per account) and is the natural
next step once the read-only sync is proven.

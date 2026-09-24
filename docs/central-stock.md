# Centralised stock — setup notes

The website's stock number is the one master count. Sales on the website, both
eBay shops and Amazon (orders you ship yourself) all come off it, and every
change is sent to each linked listing. Admin → Stock → **Sales channels** walks
through switching it on; this page covers the one-off setup outside the site.

## eBay (both shops)

The site already uses the **Production** eBay keys (`EBAY_CLIENT_ID` /
`EBAY_CLIENT_SECRET`). Sandbox keys (`SBX-…`) can't see real listings.

1. developer.ebay.com → *Application Keys* → your **Production** keyset →
   *User Tokens* → *Get a Token from eBay via Your Application* → *Add eBay
   Redirect URL*.
   - Auth accepted URL: `https://27beauty.co.uk/admin/channels/ebay/callback`
   - Auth declined URL: `https://27beauty.co.uk/admin/channels`
2. Copy the **RuName** it shows (looks like `27beauty-27beauty-PRD-…`) and set
   it: `npx wrangler secret put EBAY_RUNAME` (it isn't secret, but this keeps it
   out of the repo).
3. In **each** shop: Seller Hub → *Site preferences* → *Selling* → turn on
   **Out-of-stock control**. Without it, a listing that reaches 0 is ended
   rather than hidden. The Sales channels page warns if it's off.
4. Admin → Sales channels → **Connect** each shop. eBay asks you to sign in —
   sign in as *that* shop. The site checks and refuses the wrong one.

The refresh token eBay issues lasts about 18 months. It's stored encrypted
(AES-GCM, key derived from `SESSION_SECRET`). If a shop shows errors after that
time, press **Reconnect**.

## Amazon (Seller Central, UK)

1. *Apps and Services* → *Develop Apps*: the app needs the **Product Listing**
   and **Inventory and Order Tracking** roles.
2. *Authorise* the app for your own account to get a **refresh token**.
3. Settings → *Account Info* → *Merchant Token* (your seller id).
4. Set them — never paste secrets into chat or commit them:

   ```bash
   npx wrangler secret put AMAZON_LWA_CLIENT_ID      # amzn1.application-oa2-client.…
   npx wrangler secret put AMAZON_LWA_CLIENT_SECRET
   npx wrangler secret put AMAZON_REFRESH_TOKEN      # Atzr|…
   npx wrangler secret put AMAZON_SELLER_ID          # Merchant Token
   ```

5. Admin → Sales channels → **Import listings**.

Only listings you ship yourself (FBM) share the count. FBA listings are shown
but never changed: that stock is in Amazon's warehouse.

## How it behaves

- Every 5 minutes (its own cron, `*/5`): read new eBay and Amazon orders, take
  them off, put cancelled ones back, and send the count to any listing that
  doesn't show it. Once an hour it also re-reads every listing.
- Every change is in the ledger: Stock → **History** on any product.
- Replaying an order can never count it twice: each order line has a unique
  ledger entry.
- A listing is only updated once its real quantity has been read, so a listing
  the site hasn't seen properly is never overwritten blind.
- Workers Free allows 50 outbound requests per run. The job spends at most 40
  and carries the rest over to the next run, zeros first.

## Limits

- Orders are read every 5 minutes. If the last unit sells on two channels
  within that window, one order will need cancelling.
- Returns aren't added back automatically. Add the item back on the Stock
  screen.
- eBay listings with variations (sizes, colours) can't be updated by item
  alone. They show an error on the Stock screen and are left as they are.

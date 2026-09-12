# QR cards and the 10% discount

This is the whole point of the website: turn a one-off marketplace buyer into a
direct customer.

## The loop

1. A customer buys from one of the eBay accounts.
2. A printed card goes in the parcel: *"Scan for 10% off at 27beauty.co.uk"*.
3. They scan it. The QR points at `https://27beauty.co.uk/qr/QR10`.
4. That page welcomes them, stores the code against their basket and shows the
   shop. The discount follows them through the basket and into checkout.
5. They buy direct. No marketplace fee, and you now have their email address for
   future marketing (with their consent).

## Printing the cards

**Admin → Coupons → Print** produces an A4 sheet of cards ready to guillotine.
Each card carries the wordmark, the offer, the QR and the code in plain text —
so the code still works if the QR won't scan.

Practical notes:

- Keep each QR at least 25mm square. Smaller than that and older phone cameras
  struggle in poor light.
- Print on plain white; QR readers dislike glossy or coloured stock.
- Leave the white border alone — it is the "quiet zone" the scanner needs.
- Always test-scan one card from each print run before stuffing parcels.

## One shared code, or one code per card?

| | Shared code (`QR10`) | Single-use batch |
| --- | --- | --- |
| Setup | Already exists | **Coupons → Generate batch** |
| Reuse | Anyone can reuse and share it | Each card works once |
| Tracking | Total redemptions only | Which card converted |
| Best for | Getting started, low risk | Once volume grows, or higher discounts |

Start with `QR10`. Move to single-use batches when either the volume justifies
the extra handling or you want a discount deeper than 10%.

## Protecting the margin

Every rule is enforced server-side at the moment of payment, not when the code is
typed in:

- **Minimum spend** — set one so a 10% discount never undercuts postage.
- **Expiry** — a dated code creates urgency and limits your exposure.
- **Max redemptions** — a hard cap on total damage.
- **Per-customer limit** — stops one buyer recycling the same code weekly.
- **Free shipping** — an alternative to a percentage discount; often cheaper for
  you and more attractive to the customer.

Change any of these in **Admin → Coupons → Edit**. Deactivating a code takes
effect immediately, including for baskets that already hold it.

## Measuring it

**Admin → Coupons** shows redemptions per code and per batch. The number worth
watching is redemptions divided by parcels shipped — that is your marketplace →
direct conversion rate. A first run of 2–5% is normal; the lever that moves it
most is the card's wording, not the size of the discount.

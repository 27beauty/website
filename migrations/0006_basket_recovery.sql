-- Captures what we know about an abandoned Stripe Checkout session, so the
-- "Open baskets" admin view has something to show/export beyond a bare
-- order number: whatever contact details the shopper entered before giving
-- up, and Stripe's own resumable-checkout link.
ALTER TABLE orders ADD COLUMN recovery_url TEXT;

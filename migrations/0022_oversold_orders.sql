-- An order that could not be met in full from stock.
--
-- Stock is decremented when Stripe confirms payment, and `products.stock` is
-- written as MAX(0, stock + delta), so two shoppers paying for the last unit
-- both succeed: the second decrement clamps at zero and nothing anywhere says
-- so. The owner ships one parcel and the other customer waits for one that
-- was never possible. This records the shortfall at the moment of settlement
-- so the Orders screen can show it and the owner can refund or restock.
ALTER TABLE orders ADD COLUMN oversold INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_orders_oversold ON orders(oversold) WHERE oversold = 1;

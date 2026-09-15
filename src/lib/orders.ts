import type { CartLine, CartTotals, Env, Order, OrderItem, OrderStatus, ShippingAddress } from '../types';
import { generateOrderNumber } from './util';

/**
 * Order creation, lookup and state transitions. All money fields are copied
 * straight from a freshly-built `CartTotals` (never from client input), and
 * every state transition here is idempotent because Stripe retries webhooks.
 */

export interface CreatePendingOrderInput {
  cart: CartTotals;
  /** Null until Stripe Checkout collects it — we no longer ask for it ourselves before redirecting. */
  email: string | null;
  name: string | null;
}

export async function createPendingOrder(env: Env, input: CreatePendingOrderInput): Promise<Order> {
  const { cart, email, name } = input;
  const orderNumber = generateOrderNumber();

  const res = await env.DB.prepare(
    `INSERT INTO orders
       (order_number, status, email, customer_name, subtotal_pence, discount_pence,
        shipping_pence, total_pence, coupon_code, currency)
     VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?, 'GBP')`,
  )
    .bind(
      orderNumber,
      email,
      name,
      cart.subtotalPence,
      cart.discountPence,
      cart.shippingPence,
      cart.totalPence,
      cart.coupon?.code ?? null,
    )
    .run();

  const orderId = res.meta.last_row_id as number;

  if (cart.items.length) {
    const inserts = cart.items.map((item) =>
      env.DB.prepare(
        `INSERT INTO order_items
           (order_id, product_id, title, sku, image_url, unit_price_pence, quantity, line_total_pence)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        orderId,
        item.product.id,
        item.product.title,
        item.product.sku,
        item.product.image_url,
        item.product.price_pence,
        item.quantity,
        item.lineTotalPence,
      ),
    );
    await env.DB.batch(inserts);
  }

  const order = await getOrderById(env, orderId);
  if (!order) throw new Error('Order vanished immediately after insert');
  return order;
}

export async function attachStripeSession(env: Env, orderId: number, sessionId: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE orders SET stripe_session_id = ?, updated_at = datetime('now') WHERE id = ?`,
  )
    .bind(sessionId, orderId)
    .run();
}

export async function getOrderById(env: Env, id: number): Promise<Order | null> {
  return env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(id).first<Order>();
}

export async function getOrderByStripeSession(env: Env, sessionId: string): Promise<Order | null> {
  return env.DB.prepare('SELECT * FROM orders WHERE stripe_session_id = ?')
    .bind(sessionId)
    .first<Order>();
}

export interface OrderWithItems extends Order {
  items: OrderItem[];
}

export async function getOrderWithItems(env: Env, orderId: number): Promise<OrderWithItems | null> {
  const order = await getOrderById(env, orderId);
  if (!order) return null;
  const { results } = await env.DB.prepare(
    'SELECT * FROM order_items WHERE order_id = ? ORDER BY id ASC',
  )
    .bind(orderId)
    .all<OrderItem>();
  return { ...order, items: results ?? [] };
}

/** Applies stock decrements for an order exactly once, guarded by `stock_applied`. */
async function applyStockForOrder(env: Env, orderId: number): Promise<void> {
  const guard = await env.DB.prepare(
    `UPDATE orders SET stock_applied = 1 WHERE id = ? AND stock_applied = 0`,
  )
    .bind(orderId)
    .run();
  if ((guard.meta.changes ?? 0) === 0) return; // another webhook delivery already applied it

  const { results } = await env.DB.prepare(
    'SELECT product_id, quantity FROM order_items WHERE order_id = ? AND product_id IS NOT NULL',
  )
    .bind(orderId)
    .all<{ product_id: number; quantity: number }>();

  const decrements = (results ?? []).map((row) =>
    env.DB.prepare(
      `UPDATE products SET stock = MAX(0, stock - ?), updated_at = datetime('now') WHERE id = ?`,
    ).bind(row.quantity, row.product_id),
  );
  if (decrements.length) await env.DB.batch(decrements);
}

export interface MarkOrderPaidInput {
  sessionId?: string;
  orderId?: number;
  paymentIntent?: string | null;
  shipping?: ShippingAddress | null;
  email?: string | null;
  name?: string | null;
  phone?: string | null;
}

export interface OrderTransitionResult {
  order: Order | null;
  /** True only when this call actually moved the order out of `pending`. */
  transitioned: boolean;
}

async function findOrderForTransition(
  env: Env,
  input: { sessionId?: string; orderId?: number },
): Promise<Order | null> {
  if (input.orderId) return getOrderById(env, input.orderId);
  if (input.sessionId) return getOrderByStripeSession(env, input.sessionId);
  return null;
}

/**
 * Marks an order paid, idempotently. Safe to call multiple times for the same
 * order (Stripe retries webhooks, and both `checkout.session.completed` and
 * `checkout.session.async_payment_succeeded` can fire for one order) — only
 * the first call that finds the order still `pending` does anything.
 */
export async function markOrderPaid(env: Env, input: MarkOrderPaidInput): Promise<OrderTransitionResult> {
  const order = await findOrderForTransition(env, input);
  if (!order) return { order: null, transitioned: false };

  const shippingJson = input.shipping ? JSON.stringify(input.shipping) : order.shipping_json;
  const paymentIntent = input.paymentIntent ?? order.stripe_payment_intent;

  const res = await env.DB.prepare(
    `UPDATE orders
       SET status = 'paid',
           stripe_payment_intent = ?,
           shipping_json = ?,
           email = COALESCE(?, email),
           customer_name = COALESCE(?, customer_name),
           phone = COALESCE(?, phone),
           updated_at = datetime('now')
     WHERE id = ? AND status = 'pending'`,
  )
    .bind(paymentIntent, shippingJson, input.email ?? null, input.name ?? null, input.phone ?? null, order.id)
    .run();

  const transitioned = (res.meta.changes ?? 0) > 0;
  if (transitioned) {
    await applyStockForOrder(env, order.id);
  }

  const fresh = await getOrderById(env, order.id);
  return { order: fresh, transitioned };
}

export async function markOrderCancelled(
  env: Env,
  input: { sessionId?: string; orderId?: number },
): Promise<OrderTransitionResult> {
  const order = await findOrderForTransition(env, input);
  if (!order) return { order: null, transitioned: false };

  const res = await env.DB.prepare(
    `UPDATE orders SET status = 'cancelled', updated_at = datetime('now') WHERE id = ? AND status = 'pending'`,
  )
    .bind(order.id)
    .run();

  const transitioned = (res.meta.changes ?? 0) > 0;
  const fresh = await getOrderById(env, order.id);
  return { order: fresh, transitioned };
}

export interface ListOrdersOptions {
  status?: OrderStatus;
  limit?: number;
  offset?: number;
}

export async function listOrders(
  env: Env,
  opts: ListOrdersOptions = {},
): Promise<{ items: Order[]; total: number }> {
  const where = opts.status ? 'WHERE status = ?' : '';
  const params = opts.status ? [opts.status] : [];
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);

  const countRow = await env.DB.prepare(`SELECT COUNT(*) AS n FROM orders ${where}`)
    .bind(...params)
    .first<{ n: number }>();

  const { results } = await env.DB.prepare(
    `SELECT * FROM orders ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
  )
    .bind(...params, limit, offset)
    .all<Order>();

  return { items: results ?? [], total: countRow?.n ?? 0 };
}

export function orderStatusLabel(status: OrderStatus): string {
  switch (status) {
    case 'pending':
      return 'Awaiting payment';
    case 'paid':
      return 'Paid';
    case 'fulfilled':
      return 'Fulfilled';
    case 'cancelled':
      return 'Cancelled';
    case 'refunded':
      return 'Refunded';
    default:
      return status;
  }
}

/**
 * Pure re-check of a basket against what `buildCart` resolved, so checkout can
 * refuse to charge for stock that vanished between page-load and submit.
 * `buildCart` already clamps over-ordered lines and marks them `clamped`, and
 * silently drops lines whose product is gone/inactive/out of stock — both
 * cases are surfaced here as a human-readable issue.
 */
export function checkStockForCheckout(lines: CartLine[], cart: CartTotals): string[] {
  const issues: string[] = [];
  for (const line of lines) {
    const item = cart.items.find((i) => i.product.id === line.id);
    if (!item) {
      issues.push('One of the items in your basket has sold out or is no longer available.');
      continue;
    }
    if (item.clamped) {
      issues.push(
        `Only ${item.product.stock} of "${item.product.title}" left in stock — please update the quantity.`,
      );
    }
  }
  return issues;
}

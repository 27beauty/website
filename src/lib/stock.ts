/**
 * The one place products.stock changes. Every change writes a stock_movements
 * row in the same D1 batch, so there is always an answer to "why is this the
 * number?", and UNIQUE(reason, ref) makes replaying the same marketplace
 * order a no-op instead of a double count.
 *
 * Pushing the new number out to eBay/Amazon is src/lib/channels.ts's job;
 * callers here get back which products changed so they can queue that.
 */

import type { Env, StockMovement, StockReason } from '../types';
import { getSetting } from './settings';

export interface StockChange {
  productId: number;
  delta: number;
  reason: StockReason;
  /** Unique per reason: e.g. "ebay:12-34567-89012:1000123" for an eBay order line. */
  ref: string;
  note?: string | null;
  /**
   * The marketplace listing the sale (or cancellation) happened on. That
   * marketplace has already moved its own quantity by `delta`, so the
   * listing's last-known quantity moves with it — otherwise we'd think it
   * still shows the old number and never correct it.
   */
  listing?: { channel: 'ebay' | 'amazon'; account: string; externalId: string };
}

/**
 * The statements that apply one change atomically:
 * 1. record the movement (ignored if this reason+ref was already applied),
 * 2. move the stock only if step 1 inserted — `changes()` is the row count of
 *    the previous statement in the same batch — never below zero,
 * 3. (marketplace sales) mirror the move on that listing's last-known
 *    quantity, again only if step 2 ran,
 * 4. stamp the resulting stock level onto the movement.
 * The first statement is always the INSERT, whose change count says whether
 * this change was new.
 */
export function changeStatements(env: Env, change: StockChange): D1PreparedStatement[] {
  const out = [
    env.DB.prepare(
      `INSERT OR IGNORE INTO stock_movements (product_id, delta, reason, ref, note) VALUES (?, ?, ?, ?, ?)`,
    ).bind(change.productId, change.delta, change.reason, change.ref, change.note ?? null),
    env.DB.prepare(
      `UPDATE products SET stock = MAX(0, stock + ?), updated_at = datetime('now') WHERE id = ? AND changes() > 0`,
    ).bind(change.delta, change.productId),
  ];
  if (change.listing) {
    out.push(
      env.DB.prepare(
        `UPDATE channel_listings SET pushed_qty = MAX(0, pushed_qty + ?), channel_qty = MAX(0, COALESCE(channel_qty, pushed_qty) + ?)
          WHERE channel = ? AND account = ? AND external_id = ? AND pushed_qty IS NOT NULL AND changes() > 0`,
      ).bind(change.delta, change.delta, change.listing.channel, change.listing.account, change.listing.externalId),
    );
  }
  out.push(
    env.DB.prepare(
      `UPDATE stock_movements SET stock_after = (SELECT stock FROM products WHERE id = ?)
        WHERE reason = ? AND ref = ? AND stock_after IS NULL`,
    ).bind(change.productId, change.reason, change.ref),
  );
  return out;
}

/** Applies changes; returns the ids of products whose stock actually moved. */
export async function adjustStock(env: Env, changes: StockChange[]): Promise<number[]> {
  const real = changes.filter((c) => c.delta !== 0);
  if (!real.length) return [];
  const groups = real.map((c) => changeStatements(env, c));
  const results = await env.DB.batch(groups.flat());
  const moved = new Set<number>();
  let offset = 0;
  real.forEach((c, i) => {
    if ((results[offset]?.meta.changes ?? 0) > 0) moved.add(c.productId);
    offset += groups[i].length;
  });
  return [...moved];
}

/**
 * Sets products to exact quantities (admin edits, starting counts). Only
 * products whose number differs get a movement. `refPrefix` keeps the refs
 * unique per save.
 */
export async function setStock(
  env: Env,
  updates: { productId: number; quantity: number }[],
  reason: Extract<StockReason, 'admin' | 'start' | 'merge'>,
  note?: string,
): Promise<number[]> {
  if (!updates.length) return [];
  const ids = updates.map((u) => u.productId);
  const { results } = await env.DB.prepare(
    `SELECT id, stock FROM products WHERE id IN (${ids.map(() => '?').join(',')})`,
  )
    .bind(...ids)
    .all<{ id: number; stock: number }>();
  const current = new Map((results ?? []).map((r) => [r.id, r.stock]));
  const stamp = `${Date.now().toString(36)}${crypto.getRandomValues(new Uint32Array(1))[0].toString(36)}`;
  return adjustStock(
    env,
    updates
      .filter((u) => current.has(u.productId) && Number.isInteger(u.quantity) && u.quantity >= 0)
      .map((u) => ({
        productId: u.productId,
        delta: u.quantity - (current.get(u.productId) as number),
        reason,
        ref: `${reason}:${stamp}:${u.productId}`,
        note: note ?? null,
      })),
  );
}

export async function movementsFor(env: Env, productId: number, limit = 100): Promise<StockMovement[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM stock_movements WHERE product_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
  )
    .bind(productId, limit)
    .all<StockMovement>();
  return results ?? [];
}

/** True once the owner has switched the website on as the master for every channel. */
export async function centralStockEnabled(env: Env): Promise<boolean> {
  return getSetting<boolean>(env, 'stock.central_enabled', false);
}

export const REASON_LABELS: Record<StockReason, string> = {
  website_sale: 'Website sale',
  ebay_sale: 'eBay sale',
  amazon_sale: 'Amazon sale',
  cancel: 'Order cancelled — put back',
  admin: 'Changed in admin',
  start: 'Starting count',
  merge: 'Merged duplicate listing',
};

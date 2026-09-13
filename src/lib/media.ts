import type { Env } from '../types';

/**
 * Storage guardrails for R2.
 *
 * Cloudflare bills R2 once you pass the free allowance and offers no hard
 * spending cap, so the cap has to live here. The shop tracks every byte it
 * writes and refuses uploads that would take it past a self-imposed budget
 * that sits well inside the free tier.
 *
 * Free allowance at the time of writing: 10 GB-month of storage, 1M Class A
 * operations (writes/lists) and 10M Class B (reads) per month, egress free.
 * The default budget below is a tenth of the storage allowance.
 */

/** Self-imposed storage cap: 1 GiB, a tenth of the 10 GB free allowance. */
export const DEFAULT_MEDIA_BUDGET_BYTES = 1024 * 1024 * 1024;

/** Largest single upload accepted. A phone photo is comfortably under this. */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

const KEY_BYTES = 'media.bytes_used';
const KEY_COUNT = 'media.object_count';
const KEY_BUDGET = 'media.max_bytes';

export interface MediaUsage {
  bytesUsed: number;
  objectCount: number;
  budgetBytes: number;
  /** 0-100, clamped, for the admin progress bar. */
  percentUsed: number;
  remainingBytes: number;
}

async function readNumber(env: Env, key: string, fallback: number): Promise<number> {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?')
    .bind(key)
    .first<{ value: string }>();
  if (!row) return fallback;
  const n = Number(row.value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Adjusts a counter atomically in SQL rather than read-modify-write, so two
 * uploads landing together cannot lose one another's bytes. Counters are
 * stored as bare JSON numbers, which are valid integers to SQLite too.
 */
async function bump(env: Env, key: string, delta: number, floorAtZero = true): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, '0', datetime('now'))
     ON CONFLICT(key) DO NOTHING`,
  )
    .bind(key)
    .run();
  await env.DB.prepare(
    `UPDATE settings
        SET value = CAST(${floorAtZero ? 'MAX(0, CAST(value AS INTEGER) + ?)' : 'CAST(value AS INTEGER) + ?'} AS TEXT),
            updated_at = datetime('now')
      WHERE key = ?`,
  )
    .bind(delta, key)
    .run();
}

export async function getMediaUsage(env: Env): Promise<MediaUsage> {
  const [bytesUsed, objectCount, budgetBytes] = await Promise.all([
    readNumber(env, KEY_BYTES, 0),
    readNumber(env, KEY_COUNT, 0),
    readNumber(env, KEY_BUDGET, DEFAULT_MEDIA_BUDGET_BYTES),
  ]);
  const percentUsed = budgetBytes > 0 ? Math.min(100, Math.round((bytesUsed / budgetBytes) * 100)) : 100;
  return {
    bytesUsed,
    objectCount,
    budgetBytes,
    percentUsed,
    remainingBytes: Math.max(0, budgetBytes - bytesUsed),
  };
}

export interface StoreDecision {
  ok: boolean;
  reason?: string;
  usage: MediaUsage;
}

/** Decides whether one more file of `size` bytes may be written. */
export async function canStore(env: Env, size: number): Promise<StoreDecision> {
  const usage = await getMediaUsage(env);
  if (!Number.isFinite(size) || size <= 0) {
    return { ok: false, reason: 'That file looks empty.', usage };
  }
  if (size > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      reason: `Images must be ${formatBytes(MAX_UPLOAD_BYTES)} or smaller.`,
      usage,
    };
  }
  if (usage.bytesUsed + size > usage.budgetBytes) {
    return {
      ok: false,
      reason:
        `This upload would take image storage past its ${formatBytes(usage.budgetBytes)} limit ` +
        `(${formatBytes(usage.bytesUsed)} used). Delete some images, or raise the limit in Settings — ` +
        `but keep it under 10 GB or Cloudflare starts charging.`,
      usage,
    };
  }
  return { ok: true, usage };
}

export async function recordUpload(env: Env, bytes: number): Promise<void> {
  await Promise.all([bump(env, KEY_BYTES, bytes), bump(env, KEY_COUNT, 1)]);
}

export async function recordDelete(env: Env, bytes: number): Promise<void> {
  await Promise.all([bump(env, KEY_BYTES, -bytes), bump(env, KEY_COUNT, -1)]);
}

/**
 * Deletes an object the shop previously stored and gives its bytes back to the
 * budget. Replacing a product photo ten times must not leave ten copies behind.
 */
export async function deleteStoredImage(env: Env, imageUrl: string | null | undefined): Promise<void> {
  const key = keyFromMediaUrl(imageUrl);
  if (!key || !env.MEDIA) return;
  const head = await env.MEDIA.head(key);
  await env.MEDIA.delete(key);
  if (head) await recordDelete(env, head.size);
}

/** Deletes everything stored for one product (used when a product is deleted). */
export async function deleteProductImages(env: Env, productId: number): Promise<number> {
  if (!env.MEDIA) return 0;
  const listed = await env.MEDIA.list({ prefix: `products/${productId}/` });
  let freed = 0;
  for (const object of listed.objects) {
    await env.MEDIA.delete(object.key);
    freed += object.size;
  }
  if (listed.objects.length) {
    await Promise.all([
      bump(env, KEY_BYTES, -freed),
      bump(env, KEY_COUNT, -listed.objects.length),
    ]);
  }
  return listed.objects.length;
}

/**
 * Recounts the bucket from scratch and rewrites the counters. Costs a handful
 * of Class A list operations, so it is a manual admin action, not automatic.
 */
export async function recalculateUsage(env: Env): Promise<MediaUsage> {
  if (!env.MEDIA) return getMediaUsage(env);
  let cursor: string | undefined;
  let bytes = 0;
  let count = 0;
  // Bounded so a runaway bucket can never spin here forever.
  for (let page = 0; page < 50; page++) {
    const listed = await env.MEDIA.list({ cursor, limit: 1000 });
    for (const object of listed.objects) {
      bytes += object.size;
      count += 1;
    }
    if (!listed.truncated) break;
    cursor = listed.cursor;
  }
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).bind(KEY_BYTES, String(bytes)),
    env.DB.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).bind(KEY_COUNT, String(count)),
  ]);
  return getMediaUsage(env);
}

/** "/media/products/3/ab12.jpg" -> "products/3/ab12.jpg"; anything else -> null. */
export function keyFromMediaUrl(imageUrl: string | null | undefined): string | null {
  if (!imageUrl) return null;
  const match = /^\/(?:media|admin\/media)\/(.+)$/.exec(imageUrl.trim());
  if (!match) return null;
  const key = decodeURIComponent(match[1]);
  return key.includes('..') ? null : key;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MEDIA_BUDGET_BYTES,
  MAX_UPLOAD_BYTES,
  canStore,
  formatBytes,
  keyFromMediaUrl,
} from '../src/lib/media';
import type { Env } from '../src/types';

/** Fake D1 answering only the settings reads `getMediaUsage` performs. */
function fakeEnv(values: Record<string, number>): Env {
  const db = {
    prepare(sql: string) {
      const st = {
        _args: [] as unknown[],
        bind(...args: unknown[]) {
          st._args = args;
          return st;
        },
        async first<T>(): Promise<T | null> {
          if (!sql.includes('FROM settings WHERE key')) throw new Error(`unexpected SQL: ${sql}`);
          const key = String(st._args[0]);
          return key in values ? ({ value: String(values[key]) } as T) : null;
        },
        async run() {
          return { meta: { changes: 1 } };
        },
      };
      return st;
    },
  };
  return { DB: db } as unknown as Env;
}

const MB = 1024 * 1024;

describe('media storage guardrails', () => {
  it('defaults to a budget well inside the free tier', () => {
    // Cloudflare's free allowance is 10 GB; the default cap is a tenth of it.
    expect(DEFAULT_MEDIA_BUDGET_BYTES).toBe(1024 * MB);
    expect(DEFAULT_MEDIA_BUDGET_BYTES).toBeLessThan(10 * 1024 * MB);
  });

  it('allows an upload that fits', async () => {
    const res = await canStore(fakeEnv({ 'media.bytes_used': 100 * MB }), 2 * MB);
    expect(res.ok).toBe(true);
    expect(res.reason).toBeUndefined();
  });

  it('refuses an upload that would cross the budget', async () => {
    const env = fakeEnv({ 'media.bytes_used': 1020 * MB });
    const res = await canStore(env, 5 * MB);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/past its 1\.00 GB limit/);
  });

  it('refuses a single file over the per-upload cap', async () => {
    const res = await canStore(fakeEnv({}), MAX_UPLOAD_BYTES + 1);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/5\.0 MB or smaller/);
  });

  it('refuses an empty or nonsense file size', async () => {
    for (const size of [0, -1, Number.NaN]) {
      expect((await canStore(fakeEnv({}), size)).ok).toBe(false);
    }
  });

  it('respects a budget the owner lowered', async () => {
    const env = fakeEnv({ 'media.bytes_used': 40 * MB, 'media.max_bytes': 50 * MB });
    expect((await canStore(env, 5 * MB)).ok).toBe(true);
    expect((await canStore(env, 20 * MB)).ok).toBe(false);
  });

  it('reports usage as a percentage for the meter', async () => {
    const { usage } = await canStore(
      fakeEnv({ 'media.bytes_used': 512 * MB, 'media.max_bytes': 1024 * MB }),
      1,
    );
    expect(usage.percentUsed).toBe(50);
    expect(usage.remainingBytes).toBe(512 * MB);
  });

  it('maps a stored image URL back to its R2 key, and refuses anything else', () => {
    expect(keyFromMediaUrl('/media/products/3/ab12.jpg')).toBe('products/3/ab12.jpg');
    expect(keyFromMediaUrl('/admin/media/products/3/ab12.jpg')).toBe('products/3/ab12.jpg');
    // Remote images (the eBay sync supplies these) are not ours to delete.
    expect(keyFromMediaUrl('https://i.ebayimg.com/thumbs/x.jpg')).toBeNull();
    expect(keyFromMediaUrl('/media/../../etc/passwd')).toBeNull();
    expect(keyFromMediaUrl(null)).toBeNull();
    expect(keyFromMediaUrl('')).toBeNull();
  });

  it('formats sizes the way the admin panel shows them', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(5 * MB)).toBe('5.0 MB');
    expect(formatBytes(1024 * MB)).toBe('1.00 GB');
  });
});

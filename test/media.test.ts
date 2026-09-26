import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MEDIA_BUDGET_BYTES,
  FREE_STORAGE_BYTES,
  MAX_UPLOAD_BYTES,
  MAX_UPLOADS_PER_DAY,
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
  it('defaults to the whole free allowance, and never past it', async () => {
    // Cloudflare's free allowance is 10 GB; decimal GB is the smaller reading.
    expect(DEFAULT_MEDIA_BUDGET_BYTES).toBe(FREE_STORAGE_BYTES);
    expect(FREE_STORAGE_BYTES).toBeLessThanOrEqual(10 * 1000 ** 3);
    // Even a stored limit above the allowance is read back as the allowance.
    const env = fakeEnv({ 'media.bytes_used': FREE_STORAGE_BYTES - MB, 'media.max_bytes': 50 * 1000 ** 3 });
    expect((await canStore(env, 2 * MB)).ok).toBe(false);
  });

  it('accepts a large phone or camera photo', async () => {
    expect((await canStore(fakeEnv({}), 24 * MB)).ok).toBe(true);
  });

  it('allows an upload that fits', async () => {
    const res = await canStore(fakeEnv({ 'media.bytes_used': 100 * MB }), 2 * MB);
    expect(res.ok).toBe(true);
    expect(res.reason).toBeUndefined();
  });

  it('refuses an upload that would cross the budget', async () => {
    const env = fakeEnv({ 'media.bytes_used': FREE_STORAGE_BYTES - 3 * MB });
    const res = await canStore(env, 5 * MB);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/past its .* limit/);
  });

  it('refuses a single file over the per-upload cap', async () => {
    const res = await canStore(fakeEnv({}), MAX_UPLOAD_BYTES + 1);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/50\.0 MB or smaller/);
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
    expect(formatBytes(2000)).toBe('2 KB');
    expect(formatBytes(5 * 1000 ** 2)).toBe('5.0 MB');
    expect(formatBytes(FREE_STORAGE_BYTES)).toBe('10.00 GB');
  });
});

describe('daily upload limit', () => {
  const today = 'media.uploads.' + new Date().toISOString().slice(0, 10);

  it("refuses uploads once today's limit is reached, so R2 writes stay bounded", async () => {
    const res = await canStore(fakeEnv({ [today]: MAX_UPLOADS_PER_DAY }), MB);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/free allowance/);
  });

  it('allows uploads below the limit, and yesterday does not count', async () => {
    expect((await canStore(fakeEnv({ [today]: MAX_UPLOADS_PER_DAY - 1 }), MB)).ok).toBe(true);
    expect((await canStore(fakeEnv({ 'media.uploads.2000-01-01': 999 }), MB)).ok).toBe(true);
  });

  it('allows as many uploads as the free 1,000,000 R2 writes a month cover, and no more', () => {
    expect(MAX_UPLOADS_PER_DAY * 31).toBeLessThanOrEqual(1_000_000);
    expect(MAX_UPLOADS_PER_DAY).toBeGreaterThanOrEqual(30_000);
  });
});

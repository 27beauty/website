import type { Env } from '../types';

/**
 * Store settings live in the D1 `settings` table as JSON values so the owner can
 * change shipping, sync and checkout behaviour without a redeploy.
 */

export type SettingsMap = Record<string, unknown>;

export async function getAllSettings(env: Env): Promise<SettingsMap> {
  const { results } = await env.DB.prepare('SELECT key, value FROM settings').all<{
    key: string;
    value: string;
  }>();
  const out: SettingsMap = {};
  for (const row of results ?? []) {
    try {
      out[row.key] = JSON.parse(row.value);
    } catch {
      out[row.key] = row.value;
    }
  }
  return out;
}

export async function getSetting<T>(env: Env, key: string, fallback: T): Promise<T> {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?')
    .bind(key)
    .first<{ value: string }>();
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

export async function setSetting(env: Env, key: string, value: unknown): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  )
    .bind(key, JSON.stringify(value ?? null))
    .run();
}

export interface ShippingConfig {
  flatPence: number;
  freeThresholdPence: number;
}

/** Settings row wins; the wrangler.toml vars are the fallback. */
export async function getShippingConfig(env: Env): Promise<ShippingConfig> {
  const [flat, free] = await Promise.all([
    getSetting<number>(env, 'shipping.flat_pence', Number(env.SHIPPING_FLAT_PENCE ?? 349)),
    getSetting<number>(
      env,
      'shipping.free_threshold_pence',
      Number(env.FREE_SHIPPING_THRESHOLD_PENCE ?? 0),
    ),
  ]);
  return {
    flatPence: Number.isFinite(flat) ? flat : 349,
    freeThresholdPence: Number.isFinite(free) ? free : 0,
  };
}

/**
 * The business details a distance seller has to publish.
 *
 * Deliberately separate from `store.address`, which is the Parcel2Go
 * collection address: that is where the courier knocks, it is the owner's
 * home, and it was entered for the courier, not for publication. Publishing it
 * is the owner's decision to make, not a default, so these fields start empty
 * and the storefront shows only what has been filled in.
 */
export interface LegalDetails {
  tradingName: string;
  companyName: string;
  companyNumber: string;
  registeredAddress: string;
  vatNumber: string;
}

export async function getLegalDetails(env: Env): Promise<LegalDetails> {
  const [tradingName, companyName, companyNumber, registeredAddress, vatNumber] = await Promise.all([
    getSetting<string>(env, 'legal.trading_name', ''),
    getSetting<string>(env, 'legal.company_name', ''),
    getSetting<string>(env, 'legal.company_number', ''),
    getSetting<string>(env, 'legal.registered_address', ''),
    getSetting<string>(env, 'legal.vat_number', ''),
  ]);
  const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  return {
    tradingName: text(tradingName) || '27beauty',
    companyName: text(companyName),
    companyNumber: text(companyNumber),
    registeredAddress: text(registeredAddress),
    vatNumber: text(vatNumber),
  };
}

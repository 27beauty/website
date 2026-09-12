/**
 * Pure money/stock helpers for the eBay sync. Kept dependency-free so
 * test/ebay.test.ts can exercise them without touching D1/KV/fetch.
 */

import type { EbayAmount, EbayAvailabilityBucket } from './types';

/**
 * Converts an eBay `Amount` (e.g. { value: "12.99", currency: "GBP" }) to
 * integer pence. Returns null for non-GBP listings so callers can skip or
 * flag them rather than silently importing the wrong currency at face value.
 *
 * Parses the decimal string directly (never `parseFloat` then trusting binary
 * rounding) — split on the decimal point and combine the integer and
 * fractional parts as integers, which avoids float artefacts like
 * 19.99 * 100 === 1998.9999999999998 for some inputs.
 */
export function amountToPence(amount: EbayAmount | null | undefined): number | null {
  if (!amount || typeof amount.value !== 'string') return null;
  if (amount.currency && amount.currency.toUpperCase() !== 'GBP') return null;
  return decimalStringToPence(amount.value);
}

/** "12.99" -> 1299, "5" -> 500, "3.4" -> 340, "1.005" -> 101 (rounds half up). */
export function decimalStringToPence(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed || !/^-?\d+(\.\d+)?$/.test(trimmed)) return null;
  const negative = trimmed.startsWith('-');
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [wholeStr, fracStr = ''] = unsigned.split('.');
  const whole = wholeStr === '' ? 0 : Number(wholeStr);
  if (!Number.isFinite(whole)) return null;
  // Pad/truncate to 3 fractional digits so we can round the thousandths place
  // ourselves instead of leaning on float multiplication.
  const fracPadded = (fracStr + '000').slice(0, 3);
  const thousandths = Number(fracPadded);
  if (!Number.isFinite(thousandths)) return null;
  // 0-999 thousandths -> 0-100 pence, rounded (100 correctly carries into the pound above).
  const pencePart = Math.round(thousandths / 10);
  const pence = whole * 100 + pencePart;
  return negative ? -pence : pence;
}

/**
 * Browse-mode listings often expose only a coarse availability bucket rather
 * than an exact quantity. We map that bucket to a conservative default
 * quantity so the storefront shows realistic (if imprecise) stock.
 *
 * KNOWN LIMITATION: this is a guess, not a count. `IN_STOCK` does not tell us
 * whether eBay has 3 or 300 units left, so we pick a modest number that keeps
 * the "add to basket" flow working without promising more than we know. Sell
 * mode (Inventory API) gives an exact quantity and should always be preferred
 * when a refresh token is configured.
 */
export const AVAILABILITY_STOCK_MAP: Record<string, number> = {
  IN_STOCK: 10,
  LIMITED_STOCK: 3,
  OUT_OF_STOCK: 0,
};

export function availabilityToStock(bucket: EbayAvailabilityBucket | null | undefined): number {
  if (!bucket) return AVAILABILITY_STOCK_MAP.IN_STOCK; // Browse omits the field when plentiful in stock.
  return AVAILABILITY_STOCK_MAP[bucket] ?? AVAILABILITY_STOCK_MAP.IN_STOCK;
}

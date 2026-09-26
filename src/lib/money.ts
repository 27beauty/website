/** All prices are integer pence; formatting happens only at the edges. */

export function formatPence(pence: number, currency = 'GBP'): string {
  const amount = (pence || 0) / 100;
  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(amount);
}

/** "12.99" for prefilling number inputs in the admin panel. */
export function penceToInput(pence: number | null | undefined): string {
  if (pence === null || pence === undefined) return '';
  return (pence / 100).toFixed(2);
}

export function applyMarkup(pence: number, markupPercent: number): number {
  if (!markupPercent) return pence;
  return Math.round(pence * (1 + markupPercent / 100));
}

/**
 * A band of eBay prices and how much less the website charges for them.
 * `underPence: null` is the catch-all for everything above the last band.
 */
export interface PriceTier {
  underPence: number | null;
  offPence: number;
}

/**
 * Cleans tiers read from settings: drops malformed or zero rows, keeps at
 * most one catch-all, and sorts by threshold (catch-all last) so the first
 * matching band wins.
 */
export function normalisePriceTiers(raw: unknown): PriceTier[] {
  if (!Array.isArray(raw)) return [];
  const tiers: PriceTier[] = [];
  let catchAll: PriceTier | null = null;
  for (const t of raw) {
    if (!t || typeof t !== 'object') continue;
    const off = Math.round(Number((t as PriceTier).offPence));
    const under = (t as PriceTier).underPence;
    if (!Number.isFinite(off) || off <= 0) continue;
    if (under === null || under === undefined) {
      catchAll ??= { underPence: null, offPence: off };
    } else if (Number.isFinite(Number(under)) && Number(under) > 0) {
      tiers.push({ underPence: Math.round(Number(under)), offPence: off });
    }
  }
  tiers.sort((a, b) => (a.underPence as number) - (b.underPence as number));
  return catchAll ? [...tiers, catchAll] : tiers;
}

/** Pence to take off an eBay price: the first band the price is under, or the catch-all. */
export function tierDiscountPence(ebayPence: number, tiers: PriceTier[]): number {
  const tier = tiers.find((t) => t.underPence === null || ebayPence < t.underPence);
  return tier ? tier.offPence : 0;
}

/**
 * What the website charges for an eBay listing: the account's markup %, then
 * the £ amount off for the eBay price's band. Never below 1p, so a band set
 * too generously can't make an item free.
 */
export function websitePriceFromEbay(ebayPence: number, markupPercent: number, tiers: PriceTier[]): number {
  return Math.max(1, applyMarkup(ebayPence, markupPercent) - tierDiscountPence(ebayPence, tiers));
}

/** Percentage saved vs the compare-at price, or null when there is no saving. */
export function discountPercent(pricePence: number, compareAtPence: number | null): number | null {
  if (!compareAtPence || compareAtPence <= pricePence) return null;
  return Math.round(((compareAtPence - pricePence) / compareAtPence) * 100);
}

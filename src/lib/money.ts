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

/** Percentage saved vs the compare-at price, or null when there is no saving. */
export function discountPercent(pricePence: number, compareAtPence: number | null): number | null {
  if (!compareAtPence || compareAtPence <= pricePence) return null;
  return Math.round(((compareAtPence - pricePence) / compareAtPence) * 100);
}

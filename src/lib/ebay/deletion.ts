/**
 * eBay Marketplace Account Deletion notifications. eBay keeps a production
 * keyset disabled until the app has an endpoint that (1) answers a challenge
 * proving it owns the URL and (2) acknowledges each "this eBay user closed
 * their account" notice.
 *
 * The site stores no data about eBay buyers — only the owner's own shops and
 * listings, and order/line ids in the stock ledger — so acknowledging is all
 * a notice requires. It is logged so a closure of one of the owner's own
 * shops is visible.
 */

export const DELETION_ENDPOINT_PATH = '/api/ebay/account-deletion';

/** hex(SHA-256(challengeCode + verificationToken + endpoint)), per eBay's spec. */
export async function challengeResponse(challengeCode: string, verificationToken: string, endpoint: string): Promise<string> {
  const data = new TextEncoder().encode(challengeCode + verificationToken + endpoint);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

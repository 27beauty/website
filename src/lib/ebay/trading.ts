/**
 * eBay Trading API (XML) — the calls that work on listings made in Seller Hub,
 * which the REST Inventory API can't see:
 *   ReviseInventoryStatus  set available quantity, up to 4 listings per call
 *   GetMyeBaySelling       every active listing with its exact quantity
 *   GetUserPreferences     is Out-of-stock control on? (else 0 ends a listing)
 *   GetUser                which seller a consent token belongs to
 *
 * Authenticated with the seller's OAuth user token in X-EBAY-API-IAF-TOKEN.
 * Workers has no DOM parser, so responses are read with small, strict regex
 * helpers over these known, flat shapes.
 */

import { fetchWithRetry } from './http';

const TRADING_URL = 'https://api.ebay.com/ws/api.dll';
const SITE_ID_UK = '3';
const COMPAT_LEVEL = '1349';
export const REVISE_BATCH = 4;

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[ch] as string);
}

function unescapeXml(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Text of the first <tag> inside `xml`, or null. */
export function tagText(xml: string, tag: string): string | null {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(xml);
  return m ? unescapeXml(m[1].trim()) : null;
}

/** Every <tag>…</tag> block (non-nested use only). */
export function tagBlocks(xml: string, tag: string): string[] {
  return [...xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g'))].map((m) => m[1]);
}

export interface TradingError {
  code: string | null;
  message: string;
  severity: string | null;
}

export function tradingErrors(xml: string): TradingError[] {
  return tagBlocks(xml, 'Errors').map((e) => ({
    code: tagText(e, 'ErrorCode'),
    message: tagText(e, 'LongMessage') ?? tagText(e, 'ShortMessage') ?? 'Unknown eBay error',
    severity: tagText(e, 'SeverityCode'),
  }));
}

async function tradingCall(token: string, call: string, innerXml: string): Promise<string> {
  const body = `<?xml version="1.0" encoding="utf-8"?>\n<${call}Request xmlns="urn:ebay:apis:eBLBaseComponents"><ErrorLanguage>en_GB</ErrorLanguage><WarningLevel>High</WarningLevel>${innerXml}</${call}Request>`;
  const res = await fetchWithRetry(TRADING_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml',
      'X-EBAY-API-CALL-NAME': call,
      'X-EBAY-API-SITEID': SITE_ID_UK,
      'X-EBAY-API-COMPATIBILITY-LEVEL': COMPAT_LEVEL,
      'X-EBAY-API-IAF-TOKEN': token,
    },
    body,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`eBay ${call}: HTTP ${res.status}`);
  const ack = tagText(text, 'Ack');
  if (ack === 'Failure' || ack === 'PartialFailure') {
    // ReviseInventoryStatus reports per-item failures this way, and GetItem's
    // "no such item" is an answer, not an error; those callers parse it themselves.
    if (call !== 'ReviseInventoryStatus' && call !== 'GetItem') {
      const errs = tradingErrors(text).filter((e) => e.severity !== 'Warning');
      throw new Error(`eBay ${call}: ${errs.map((e) => e.message).join('; ') || ack}`);
    }
  }
  return text;
}

// ---------------------------------------------------------------------------
// ReviseInventoryStatus
// ---------------------------------------------------------------------------

export interface QuantityUpdate {
  itemId: string;
  quantity: number;
}

export function buildReviseInventoryStatus(updates: QuantityUpdate[]): string {
  if (updates.length < 1 || updates.length > REVISE_BATCH) throw new Error(`ReviseInventoryStatus takes 1–${REVISE_BATCH} items`);
  return updates
    .map((u) => `<InventoryStatus><ItemID>${escapeXml(u.itemId)}</ItemID><Quantity>${Math.max(0, Math.trunc(u.quantity))}</Quantity></InventoryStatus>`)
    .join('');
}

/**
 * Which items eBay confirmed, and an error message for each one it didn't.
 * eBay echoes an <InventoryStatus> for every listing it revised.
 */
export function parseReviseResponse(xml: string, sent: QuantityUpdate[]): { ok: Set<string>; failed: Map<string, string> } {
  const ok = new Set(tagBlocks(xml, 'InventoryStatus').map((b) => tagText(b, 'ItemID')).filter((x): x is string => Boolean(x)));
  const all = tradingErrors(xml);
  const errors = all.filter((e) => e.severity !== 'Warning');
  // With no error, say what eBay did send back (warnings, or the Ack and
  // what it echoed), so a silent refusal can be diagnosed from the Stock screen.
  const unexplained = () => {
    const warnings = all.map((e) => `${e.code ?? ''} ${e.message}`.trim()).join('; ');
    const echoed = [...ok].join(', ') || 'none';
    return `eBay did not confirm this listing (Ack ${tagText(xml, 'Ack') ?? '?'}; confirmed: ${echoed}${warnings ? `; eBay said: ${warnings}` : ''})`.slice(0, 500);
  };
  const failed = new Map<string, string>();
  for (const u of sent) {
    if (ok.has(u.itemId)) continue;
    const specific = errors.find((e) => e.message.includes(u.itemId));
    const e = specific ?? errors[0];
    failed.set(u.itemId, e ? `${e.message}${e.code ? ` (eBay error ${e.code})` : ''}` : unexplained());
  }
  return { ok, failed };
}

export async function reviseQuantities(token: string, updates: QuantityUpdate[]) {
  const xml = await tradingCall(token, 'ReviseInventoryStatus', buildReviseInventoryStatus(updates));
  return parseReviseResponse(xml, updates);
}

// ---------------------------------------------------------------------------
// GetMyeBaySelling
// ---------------------------------------------------------------------------

export interface ActiveListing {
  itemId: string;
  title: string;
  sku: string | null;
  quantityAvailable: number;
  hasVariations: boolean;
}

export function parseActiveList(xml: string): { listings: ActiveListing[]; totalPages: number } {
  const active = tagText(xml, 'ActiveList') ?? '';
  const totalPages = Number(tagText(tagText(active, 'PaginationResult') ?? '', 'TotalNumberOfPages') ?? '1') || 1;
  const listings = tagBlocks(tagText(active, 'ItemArray') ?? '', 'Item')
    .map((item) => {
      const itemId = tagText(item, 'ItemID');
      const quantity = Number(tagText(item, 'Quantity') ?? '0');
      const sold = Number(tagText(tagText(item, 'SellingStatus') ?? '', 'QuantitySold') ?? '0');
      const available = tagText(item, 'QuantityAvailable');
      return itemId
        ? {
            itemId,
            title: tagText(item, 'Title') ?? itemId,
            sku: tagText(item, 'SKU'),
            quantityAvailable: available !== null ? Number(available) : Math.max(0, quantity - sold),
            hasVariations: item.includes('<Variations>'),
          }
        : null;
    })
    .filter((l): l is ActiveListing => l !== null);
  return { listings, totalPages };
}

export async function getActiveListingsPage(token: string, page: number) {
  const xml = await tradingCall(
    token,
    'GetMyeBaySelling',
    `<ActiveList><Include>true</Include><Pagination><EntriesPerPage>200</EntriesPerPage><PageNumber>${page}</PageNumber></Pagination></ActiveList><DetailLevel>ReturnAll</DetailLevel>`,
  );
  return parseActiveList(xml);
}

// ---------------------------------------------------------------------------
// GetUserPreferences / GetUser
// ---------------------------------------------------------------------------

export async function outOfStockControlEnabled(token: string): Promise<boolean> {
  const xml = await tradingCall(token, 'GetUserPreferences', '<ShowOutOfStockControlPreference>true</ShowOutOfStockControlPreference>');
  return (tagText(xml, 'OutOfStockControlPreference') ?? '').toLowerCase() === 'true';
}

export async function tokenUserId(token: string): Promise<string | null> {
  const xml = await tradingCall(token, 'GetUser', '');
  return tagText(tagText(xml, 'User') ?? '', 'UserID');
}

// ---------------------------------------------------------------------------
// GetItem — is a listing still live?
// ---------------------------------------------------------------------------

export type SellerListingState = 'live' | 'ended' | 'unknown';

/**
 * A listing's real status from the seller's side. The public Browse API
 * can't tell a sold-out listing (hidden by Out-of-stock control, still live)
 * from an ended one — both are "not found" there. This can: an Active listing
 * at 0 is live.
 */
export function parseItemStatus(xml: string): { state: SellerListingState; quantityAvailable: number | null } {
  const errors = tradingErrors(xml).filter((e) => e.severity !== 'Warning');
  // 17: the item doesn't exist, or it ended long enough ago to be removed.
  if (errors.some((e) => e.code === '17')) return { state: 'ended', quantityAvailable: null };
  const status = tagText(tagText(xml, 'SellingStatus') ?? '', 'ListingStatus');
  if (!status) return { state: 'unknown', quantityAvailable: null };
  const quantity = Number(tagText(xml, 'Quantity') ?? NaN);
  const sold = Number(tagText(tagText(xml, 'SellingStatus') ?? '', 'QuantitySold') ?? 0);
  const available = Number.isFinite(quantity) ? Math.max(0, quantity - (Number.isFinite(sold) ? sold : 0)) : null;
  return { state: status === 'Active' ? 'live' : 'ended', quantityAvailable: available };
}

export async function getItemStatus(token: string, itemId: string) {
  const xml = await tradingCall(
    token,
    'GetItem',
    `<ItemID>${escapeXml(itemId)}</ItemID><OutputSelector>Item.ItemID</OutputSelector><OutputSelector>Item.Quantity</OutputSelector><OutputSelector>Item.SellingStatus</OutputSelector>`,
  );
  return parseItemStatus(xml);
}

/**
 * QR code rendering and coupon-code generation for the print-at-packing QR
 * cards. qrcode-svg is pure JS (no DOM, no fs at import time) so it runs
 * unchanged on Workers.
 */
import QRCodeGenerator from 'qrcode-svg';
import type { Env } from '../types';

// qrcode-svg ships no types; this is the minimal ambient shape we use.
declare module 'qrcode-svg' {
  interface QRCodeSvgOptions {
    content: string;
    padding?: number;
    width?: number;
    height?: number;
    color?: string;
    background?: string;
    ecl?: 'L' | 'M' | 'Q' | 'H';
    join?: boolean;
  }
  export default class QRCodeGenerator {
    constructor(options: QRCodeSvgOptions);
    svg(): string;
  }
}

/** Unambiguous alphabet: no 0/O or 1/I, so codes read cleanly off a printed card. */
export const COUPON_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

/** A short random block of the coupon alphabet, e.g. "K7XQ". */
export function randomCode(length = 4, alphabet = COUPON_ALPHABET): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

/**
 * A single coupon code, stored in its canonical form: uppercase letters and
 * digits only, no separator. `normaliseCouponCode` strips punctuation before
 * every lookup, so a stored "27B-K7XQ" could never be found again — the dash
 * belongs to the printed card, not the database. Use `formatCouponCode` to
 * render it.
 */
export function generateCouponCode(prefix = '27B'): string {
  return `${prefix}${randomCode(4)}`;
}

/**
 * A deliberate, readable code for a single product — "10OFFYORKSHIRETEA"
 * rather than a random block, so the owner (and the customer) can see at a
 * glance what the card is for. Canonical form: uppercase letters and digits.
 */
export function productCouponCode(percent: number, productTitle: string, suffix = 0): string {
  const words = productTitle
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  let stem = '';
  for (const word of words) {
    if (stem.length >= 12) break;
    stem += word;
  }
  stem = stem.slice(0, 14) || randomCode(4);
  const base = `${Math.round(percent)}OFF${stem}`;
  return suffix > 0 ? `${base}${suffix + 1}` : base;
}

/**
 * A code for a card that discounts the whole basket. Deliberately NOT named
 * after a product: a customer holding a card marked "10OFFYORKSHIRETEA" would
 * reasonably assume it only worked on the tea. "10OFFK7XQ" promises nothing it
 * cannot keep, and the product it was printed for is recorded against the
 * coupon for the owner's own tracking.
 */
export function basketCouponCode(percent: number, suffix = 0): string {
  const base = `${Math.round(percent)}OFF${randomCode(4)}`;
  return suffix > 0 ? `${base}${suffix + 1}` : base;
}

/** Print/display form of a stored code: "27BK7XQ" reads as "27B-K7XQ". */
export function formatCouponCode(code: string, prefix = '27B'): string {
  return code.startsWith(prefix) && code.length > prefix.length
    ? `${prefix}-${code.slice(prefix.length)}`
    : code;
}

/**
 * `count` unique single-use codes for a print batch. Retries on the (very
 * rare) collision rather than ever returning a duplicate or short list.
 */
export function generateBatchCodes(count: number, prefix = '27B'): string[] {
  const codes = new Set<string>();
  const maxAttempts = count * 20 + 200;
  let attempts = 0;
  while (codes.size < count && attempts < maxAttempts) {
    codes.add(generateCouponCode(prefix));
    attempts++;
  }
  return [...codes];
}

/** The URL encoded into every coupon QR: SITE_URL/qr/<CODE>. */
export function couponQrUrl(env: Pick<Env, 'SITE_URL'>, code: string): string {
  const base = (env.SITE_URL || 'https://27beauty.co.uk').replace(/\/+$/, '');
  return `${base}/qr/${encodeURIComponent(code)}`;
}

/** Renders a QR code as a standalone <svg> string. `size` is CSS pixels/units. */
export function renderQrSvg(content: string, size = 240): string {
  const clamped = Math.min(Math.max(Math.round(size) || 240, 48), 2048);
  const qr = new QRCodeGenerator({
    content,
    // 4 modules of quiet zone is what ISO/IEC 18004 requires — printed cards
    // with a thinner border are the single most common cause of a QR that
    // "sometimes" scans. Error correction Q tolerates a scuffed or
    // ink-starved card in a parcel; the URL is short enough that the extra
    // redundancy costs almost nothing.
    padding: 4,
    width: clamped,
    height: clamped,
    color: '#1b1620',
    background: '#ffffff',
    ecl: 'Q',
  });
  return qr.svg();
}

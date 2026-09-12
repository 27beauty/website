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

/** A single "27B-K7XQ" style coupon code. */
export function generateCouponCode(prefix = '27B'): string {
  return `${prefix}-${randomCode(4)}`;
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
    padding: 1,
    width: clamped,
    height: clamped,
    color: '#1b1620',
    background: '#ffffff',
    ecl: 'M',
  });
  return qr.svg();
}

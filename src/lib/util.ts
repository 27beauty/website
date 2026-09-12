/** Small helpers shared across the app. */

export function slugify(input: string, maxLength = 70): string {
  const base = input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
  return base || 'item';
}

/** Ensures a slug is unique in a table by appending -2, -3, ... */
export async function uniqueSlug(
  db: D1Database,
  table: 'products' | 'categories',
  desired: string,
  ignoreId?: number,
): Promise<string> {
  const base = slugify(desired);
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`;
    const row = await db
      .prepare(`SELECT id FROM ${table} WHERE slug = ?`)
      .bind(candidate)
      .first<{ id: number }>();
    if (!row || (ignoreId !== undefined && row.id === ignoreId)) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

export function clampInt(value: unknown, min: number, max: number, fallback = min): number {
  const n = typeof value === 'number' ? value : parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** Parses a "12.99" style form field into pence. Returns null when blank/invalid. */
export function poundsToPence(input: unknown): number | null {
  if (input === null || input === undefined) return null;
  const raw = String(input).trim().replace(/[£,\s]/g, '');
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

export function isEmail(value: string): boolean {
  return /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(value.trim());
}

export function nowIso(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

/** Truncates text for cards and meta descriptions, on a word boundary. */
export function excerpt(text: string | null | undefined, length = 160): string {
  if (!text) return '';
  const plain = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  if (plain.length <= length) return plain;
  return plain.slice(0, plain.lastIndexOf(' ', length) || length).trimEnd() + '…';
}

export function parseJsonArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

/** Order numbers look like 27B-8F3K2Q — short, unambiguous, easy to read out. */
export function generateOrderNumber(): string {
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let out = '';
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return `27B-${out}`;
}

/** Uppercase, dash-free coupon codes so QR10 and qr-10 both match. */
export function normaliseCouponCode(code: string): string {
  return code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

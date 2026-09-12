import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/lib/crypto';
import { validateNewPassword } from '../src/lib/admin-auth';
import {
  COUPON_ALPHABET,
  couponQrUrl,
  generateBatchCodes,
  formatCouponCode,
  generateCouponCode,
  productCouponCode,
  randomCode,
  renderQrSvg,
} from '../src/lib/qr';
import { normaliseCouponCode } from '../src/lib/util';
import { parseCsv, parseProductCsvRows, productsToCsv, toCsvRow } from '../src/routes/admin/products';
import { hashPasswordPbkdf2 } from '../scripts/hash-password.mjs';
import type { ProductWithCategory } from '../src/types';

describe('CSV parsing', () => {
  it('splits simple rows on commas and newlines', () => {
    const rows = parseCsv('a,b,c\n1,2,3\n');
    expect(rows).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  it('handles quoted fields with embedded commas, quotes and newlines', () => {
    const rows = parseCsv('title,description\n"Widget, deluxe","Says ""hello""\nnewline inside"\n');
    expect(rows).toEqual([
      ['title', 'description'],
      ['Widget, deluxe', 'Says "hello"\nnewline inside'],
    ]);
  });

  it('tolerates CRLF line endings', () => {
    const rows = parseCsv('a,b\r\n1,2\r\n');
    expect(rows).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('returns nothing for empty input', () => {
    expect(parseCsv('')).toEqual([]);
    expect(parseCsv('   ')).toEqual([]);
  });

  it('round-trips a field through toCsvRow when it needs quoting', () => {
    const row = toCsvRow(['plain', 'has,comma', 'has"quote', 'has\nnewline']);
    const parsed = parseCsv(row)[0];
    expect(parsed).toEqual(['plain', 'has,comma', 'has"quote', 'has\nnewline']);
  });
});

describe('parseProductCsvRows', () => {
  it('parses header-keyed rows for a well-formed products CSV', () => {
    const csv = 'title,price,stock,sku,category,image_url,description\nLip balm,3.50,10,SKU1,Beauty,https://x/y.jpg,Nice balm\n';
    const { rows, error } = parseProductCsvRows(csv);
    expect(error).toBeUndefined();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      title: 'Lip balm',
      price: '3.50',
      stock: '10',
      sku: 'SKU1',
      category: 'Beauty',
      image_url: 'https://x/y.jpg',
      description: 'Nice balm',
    });
  });

  it('rejects a CSV missing a required column', () => {
    const { error, rows } = parseProductCsvRows('title,stock\nThing,4\n');
    expect(error).toMatch(/price/);
    expect(rows).toEqual([]);
  });

  it('skips blank rows', () => {
    const { rows } = parseProductCsvRows('title,price\nA,1.00\n,\nB,2.00\n');
    expect(rows).toHaveLength(2);
  });

  it('exports products to a CSV that re-parses to the same values', () => {
    const products = [
      {
        title: 'Comma, test',
        price_pence: 1050,
        stock: 3,
        sku: 'SKU-1',
        category_name: 'Hair, Beauty & Grooming',
        image_url: 'https://example.com/a.jpg',
        description: 'Line one\nLine two',
        status: 'active',
      } as unknown as ProductWithCategory,
    ];
    const csv = productsToCsv(products);
    const table = parseCsv(csv);
    expect(table[0]).toEqual(['title', 'price', 'stock', 'sku', 'category', 'image_url', 'description', 'status']);
    expect(table[1][0]).toBe('Comma, test');
    expect(table[1][1]).toBe('10.50');
    expect(table[1][4]).toBe('Hair, Beauty & Grooming');
  });
});

describe('coupon code generation', () => {
  it('uses only unambiguous characters (no 0/O or 1/I)', () => {
    expect(COUPON_ALPHABET).not.toMatch(/[01OI]/);
    for (let i = 0; i < 50; i++) {
      const code = randomCode(8);
      expect(code).toMatch(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]+$/);
    }
  });

  it('generates codes that survive normalisation — a separator here would kill every printed card', () => {
    for (let i = 0; i < 50; i++) {
      const code = generateCouponCode('27B');
      expect(normaliseCouponCode(code)).toBe(code);
      expect(normaliseCouponCode(formatCouponCode(code))).toBe(code);
    }
  });

  it('builds a readable, deliberate code for one product', () => {
    expect(productCouponCode(10, 'Yorkshire Tea 240 Bags')).toBe('10OFFYORKSHIRETEA');
    expect(productCouponCode(15, 'Head & Shoulders Classic 500ml')).toBe('15OFFHEADSHOULDERS');
    expect(productCouponCode(10, 'Yorkshire Tea 240 Bags', 1)).toBe('10OFFYORKSHIRETEA2');
  });

  it('keeps per-product codes safe to type and to look up', () => {
    for (const title of ['Cadbury Dairy Milk 850g', 'Rubik\'s Cube 3x3', '   ', 'Nescafé Gold 200g']) {
      const code = productCouponCode(10, title);
      expect(code).toMatch(/^[A-Z0-9]+$/);
      expect(normaliseCouponCode(code)).toBe(code);
    }
  });

  it('formats a stored code for print without changing what is stored', () => {
    expect(formatCouponCode('27BK7XQ')).toBe('27B-K7XQ');
    expect(formatCouponCode('QR10')).toBe('QR10');
  });

  it('generates codes in canonical PREFIXXXXX format', () => {
    const code = generateCouponCode('27B');
    expect(code).toMatch(/^27B[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/);
  });

  it('generates the requested number of unique codes in a batch', () => {
    const codes = generateBatchCodes(200, '27B');
    expect(codes).toHaveLength(200);
    expect(new Set(codes).size).toBe(200);
    for (const code of codes) expect(code).toMatch(/^27B[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/);
  });
});

describe('QR URL builder', () => {
  it('builds SITE_URL/qr/<CODE>, stripping a trailing slash from SITE_URL', () => {
    expect(couponQrUrl({ SITE_URL: 'https://27beauty.co.uk' }, 'QR10')).toBe('https://27beauty.co.uk/qr/QR10');
    expect(couponQrUrl({ SITE_URL: 'https://27beauty.co.uk/' }, 'QR10')).toBe('https://27beauty.co.uk/qr/QR10');
  });

  it('URL-encodes the code', () => {
    expect(couponQrUrl({ SITE_URL: 'https://27beauty.co.uk' }, 'AB CD')).toBe('https://27beauty.co.uk/qr/AB%20CD');
  });

  it('falls back to the production domain when SITE_URL is empty', () => {
    expect(couponQrUrl({ SITE_URL: '' }, 'QR10')).toBe('https://27beauty.co.uk/qr/QR10');
  });
});

describe('renderQrSvg', () => {
  it('renders a standalone SVG at the requested size', () => {
    const svg = renderQrSvg('https://27beauty.co.uk/qr/QR10', 300);
    expect(svg).toContain('<svg');
    expect(svg).toContain('width="300"');
    expect(svg).toContain('height="300"');
  });

  it('clamps absurd sizes into a sane range', () => {
    const svg = renderQrSvg('https://27beauty.co.uk/qr/QR10', 5);
    expect(svg).toContain('width="48"');
  });
});

describe('password hashing round trip (src/lib/crypto.ts)', () => {
  it('hashPassword produces the documented pbkdf2$iterations$salt$hash format', async () => {
    const hash = await hashPassword('a-very-strong-password');
    const parts = hash.split('$');
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe('pbkdf2');
    expect(parts[1]).toBe('150000');
  });

  it('verifyPassword accepts the correct password and rejects a wrong one', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
    expect(await verifyPassword('wrong password here', hash)).toBe(false);
  });

  it('scripts/hash-password.mjs produces a hash verifyPassword() accepts', async () => {
    const hash = await hashPasswordPbkdf2('owner-seeded-password-123');
    expect(hash.split('$')).toHaveLength(4);
    expect(await verifyPassword('owner-seeded-password-123', hash)).toBe(true);
    expect(await verifyPassword('not-the-password', hash)).toBe(false);
  });
});

describe('validateNewPassword', () => {
  it('requires at least 12 characters', () => {
    expect(validateNewPassword('short', 'short')).toMatch(/12 characters/);
  });

  it('requires the confirmation to match', () => {
    expect(validateNewPassword('a-long-enough-password', 'different-password-here')).toMatch(/not match/);
  });

  it('accepts a valid, matching password pair', () => {
    expect(validateNewPassword('a-long-enough-password', 'a-long-enough-password')).toBeNull();
  });
});

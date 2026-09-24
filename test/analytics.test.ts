import { describe, expect, it } from 'vitest';
import {
  classifySource,
  deviceFor,
  isBot,
  leaveBeacon,
  pageTypeFor,
  parseBeacon,
  visitorHash,
} from '../src/lib/analytics';
import {
  buildSuggestions,
  pct,
  rangeFor,
  ukHourAndWeekday,
  type AnalyticsReport,
  type PeriodTotals,
  type ProductRow,
} from '../src/lib/analytics-report';

const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const IPAD =
  'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const ANDROID_TABLET = 'Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
const ANDROID_PHONE =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Mobile Safari/537.36';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';

describe('isBot', () => {
  it('lets real browsers through', () => {
    for (const ua of [IPHONE, IPAD, ANDROID_PHONE, MAC]) expect(isBot(ua)).toBe(false);
  });

  it('drops crawlers, link previews, scripts and empty agents', () => {
    expect(isBot('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)')).toBe(true);
    expect(isBot('facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)')).toBe(true);
    expect(isBot('WhatsApp/2.24.1 A')).toBe(true);
    expect(isBot('curl/8.7.1')).toBe(true);
    expect(isBot('python-requests/2.32.3')).toBe(true);
    expect(isBot('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/128.0 Safari/537.36')).toBe(true);
    expect(isBot('')).toBe(true);
    expect(isBot(undefined)).toBe(true);
  });
});

describe('deviceFor', () => {
  it('tells phones, tablets and computers apart', () => {
    expect(deviceFor(IPHONE)).toBe('mobile');
    expect(deviceFor(ANDROID_PHONE)).toBe('mobile');
    expect(deviceFor(IPAD)).toBe('tablet');
    expect(deviceFor(ANDROID_TABLET)).toBe('tablet');
    expect(deviceFor(MAC)).toBe('desktop');
  });
});

describe('pageTypeFor', () => {
  it('maps storefront paths to page kinds', () => {
    expect(pageTypeFor('/')).toBe('home');
    expect(pageTypeFor('/product/lip-gloss')).toBe('product');
    expect(pageTypeFor('/category/hair-beauty')).toBe('category');
    expect(pageTypeFor('/cart')).toBe('basket');
    expect(pageTypeFor('/qr')).toBe('qr');
    expect(pageTypeFor('/qr/QR10')).toBe('qr');
    expect(pageTypeFor('/checkout/success')).toBe('order-complete');
    expect(pageTypeFor('/pages/delivery')).toBe('info');
    expect(pageTypeFor('/whatever')).toBe('other');
  });
});

describe('classifySource', () => {
  const base = { path: '/', ownHost: '27beauty.co.uk' };

  it('credits QR landing pages to the QR card, whatever the referrer', () => {
    expect(classifySource({ ...base, path: '/qr/QR10', referrerHost: 'www.google.com' })).toBe('qr');
  });

  it('uses UTM tags before the referrer', () => {
    expect(classifySource({ ...base, referrerHost: 'www.google.com', utmSource: 'ebay-message' })).toBe('ebay');
    expect(classifySource({ ...base, referrerHost: null, utmMedium: 'email' })).toBe('email');
    expect(classifySource({ ...base, referrerHost: null, utmSource: 'flyer' })).toBe('campaign');
  });

  it('recognises the common referrers', () => {
    expect(classifySource({ ...base, referrerHost: 'www.ebay.co.uk' })).toBe('ebay');
    expect(classifySource({ ...base, referrerHost: 'www.google.co.uk' })).toBe('search');
    expect(classifySource({ ...base, referrerHost: 'duckduckgo.com' })).toBe('search');
    expect(classifySource({ ...base, referrerHost: 'l.facebook.com' })).toBe('social');
    expect(classifySource({ ...base, referrerHost: 'www.instagram.com' })).toBe('social');
    expect(classifySource({ ...base, referrerHost: 't.co' })).toBe('social');
    expect(classifySource({ ...base, referrerHost: 'someblog.example' })).toBe('other-site');
  });

  it('treats its own pages as internal and no referrer as direct', () => {
    expect(classifySource({ ...base, referrerHost: '27beauty.co.uk' })).toBe('internal');
    expect(classifySource({ ...base, referrerHost: 'www.27beauty.co.uk' })).toBe('internal');
    expect(classifySource({ ...base, referrerHost: null })).toBe('direct');
  });
});

describe('visitorHash', () => {
  it('is stable for the same salt and visitor, and changes with the salt', async () => {
    const a = await visitorHash('salt-1', '203.0.113.9', IPHONE);
    expect(a).toMatch(/^[0-9a-f]{24}$/);
    expect(await visitorHash('salt-1', '203.0.113.9', IPHONE)).toBe(a);
    expect(await visitorHash('salt-2', '203.0.113.9', IPHONE)).not.toBe(a);
    expect(await visitorHash('salt-1', '203.0.113.10', IPHONE)).not.toBe(a);
  });

  it('never contains the IP address', async () => {
    expect(await visitorHash('s', '203.0.113.9', IPHONE)).not.toContain('203');
  });
});

describe('parseBeacon', () => {
  const key = 'a1b2c3d4e5f6a1b2c3d4e5f6';

  it('reads key, visible time and scroll depth', () => {
    expect(parseBeacon(`${key},12345.6,73`)).toEqual({ viewKey: key, durationMs: 12346, scrollPct: 73 });
  });

  it('caps forgotten tabs at 30 minutes and scroll at 0–100', () => {
    expect(parseBeacon(`${key},99999999,250`)).toEqual({ viewKey: key, durationMs: 1_800_000, scrollPct: 100 });
    expect(parseBeacon(`${key},10,-5`)?.scrollPct).toBe(0);
  });

  it('rejects anything malformed', () => {
    expect(parseBeacon('')).toBeNull();
    expect(parseBeacon('not-a-key,100,10')).toBeNull();
    expect(parseBeacon(`${key},-1,10`)).toBeNull();
    expect(parseBeacon(`${key},abc,10`)).toBeNull();
    expect(parseBeacon(`'; DROP TABLE x;--,1,1`)).toBeNull();
  });

  it('matches what the page script sends', () => {
    const script = leaveBeacon(key);
    expect(script).toContain(`"${key}"`);
    expect(script).toContain('/api/beacon');
  });
});

describe('rangeFor', () => {
  const now = new Date('2026-09-24T12:00:00Z');

  it('builds current and previous windows of equal length', () => {
    expect(rangeFor('7', now)).toEqual({
      days: 7,
      end: '2026-09-24 12:00:00',
      start: '2026-09-17 12:00:00',
      prevStart: '2026-09-10 12:00:00',
    });
  });

  it('falls back to 30 days for anything unexpected', () => {
    expect(rangeFor('365', now).days).toBe(30);
    expect(rangeFor(undefined, now).days).toBe(30);
  });
});

describe('ukHourAndWeekday', () => {
  it('shifts UTC into British Summer Time', () => {
    // 2026-09-24 is a Thursday; 18:00 UTC is 19:00 BST.
    expect(ukHourAndWeekday('2026-09-24 18')).toEqual({ hour: 19, weekday: 3 });
  });

  it('uses GMT in winter and rolls the day over at midnight', () => {
    expect(ukHourAndWeekday('2026-12-06 23')).toEqual({ hour: 23, weekday: 6 });
    expect(ukHourAndWeekday('2026-07-05 23')).toEqual({ hour: 0, weekday: 0 });
  });
});

describe('pct', () => {
  it('rounds to one decimal and never divides by zero', () => {
    expect(pct(1, 3)).toBe(33.3);
    expect(pct(5, 0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Suggestions
// ---------------------------------------------------------------------------

const zeroTotals: PeriodTotals = {
  visits: 0,
  sawProduct: 0,
  added: 0,
  checkedOut: 0,
  bought: 0,
  bounces: 0,
  pageViews: 0,
  orders: 0,
  revenuePence: 0,
};

function product(overrides: Partial<ProductRow>): ProductRow {
  return {
    id: 1,
    title: 'Argan Oil Shampoo',
    slug: 'argan-oil-shampoo',
    stock: 10,
    pricePence: 899,
    views: 0,
    viewers: 0,
    avgSeconds: null,
    avgScroll: null,
    adds: 0,
    unitsSold: 0,
    orders: 0,
    revenuePence: 0,
    ...overrides,
  };
}

function report(overrides: Partial<AnalyticsReport>): AnalyticsReport {
  return {
    range: rangeFor(30, new Date('2026-09-24T12:00:00Z')),
    current: zeroTotals,
    previous: zeroTotals,
    daily: [],
    sources: [],
    devices: [],
    products: [],
    boughtTogether: [],
    viewedTogether: [],
    exits: [],
    pageTimes: [],
    searches: [],
    hours: new Array(24).fill(0),
    weekdays: new Array(7).fill(0),
    qr: [],
    unpaidCheckouts: 0,
    ...overrides,
  };
}

describe('buildSuggestions', () => {
  it('says nothing when there is no data', () => {
    expect(buildSuggestions(report({}))).toEqual([]);
  });

  it('flags a product that is viewed a lot but never bought', () => {
    const tips = buildSuggestions(report({ products: [product({ views: 40, viewers: 30 })] }));
    expect(tips[0].title).toContain('Argan Oil Shampoo');
    expect(tips[0].href).toBe('/admin/products/1');
  });

  it('puts restocking a low-stock best seller first', () => {
    const tips = buildSuggestions(
      report({
        products: [product({ id: 2, title: 'Lip Gloss', unitsSold: 5, stock: 1 }), product({ views: 40 })],
      }),
    );
    expect(tips[0].title).toBe('Restock “Lip Gloss”');
  });

  it('lists searches that found nothing, but only repeated ones', () => {
    const tips = buildSuggestions(
      report({
        searches: [
          { term: 'rose water', count: 4, results: 0 },
          { term: 'typo', count: 1, results: 0 },
          { term: 'shampoo', count: 9, results: 12 },
        ],
      }),
    );
    expect(tips).toHaveLength(1);
    expect(tips[0].detail).toContain('“rose water” (4×)');
    expect(tips[0].detail).not.toContain('typo');
  });

  it('suggests a bundle for products bought together more than once', () => {
    const tips = buildSuggestions(
      report({ boughtTogether: [{ a: { id: 1, title: 'Shampoo' }, b: { id: 2, title: 'Conditioner' }, count: 3 }] }),
    );
    expect(tips[0].title).toContain('bundle');
  });

  it('spots a basket-to-checkout leak', () => {
    const tips = buildSuggestions(report({ current: { ...zeroTotals, visits: 100, added: 20, checkedOut: 4 } }));
    expect(tips.map((t) => t.title)).toContain('Most baskets never reach the payment page');
  });

  it('names the busiest time in UK hours once there is enough traffic', () => {
    const hours = new Array(24).fill(2);
    hours[19] = hours[20] = hours[21] = 30;
    const weekdays = [10, 10, 10, 10, 10, 50, 10];
    const tips = buildSuggestions(report({ hours, weekdays }));
    expect(tips.at(-1)?.title).toBe('Busiest time: Saturdays, 7pm–10pm');
  });

  it('never returns more than six suggestions', () => {
    const products = Array.from({ length: 10 }, (_, i) => product({ id: i + 1, title: `P${i}`, views: 50, adds: 10, unitsSold: 2, stock: 1 }));
    const tips = buildSuggestions(
      report({
        products,
        searches: [{ term: 'x', count: 5, results: 0 }],
        current: { ...zeroTotals, visits: 100, added: 20, checkedOut: 4, bounces: 80 },
        boughtTogether: [{ a: { id: 1, title: 'A' }, b: { id: 2, title: 'B' }, count: 2 }],
      }),
    );
    expect(tips.length).toBeLessThanOrEqual(6);
  });
});

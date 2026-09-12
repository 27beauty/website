import { describe, expect, it } from 'vitest';
import { applyMarkup } from '../src/lib/money';
import { diffListings, locksFromRow, resolveUpdateFields, type ExistingProductRow } from '../src/lib/ebay/diff';
import { mapCategory, matchesKeyword } from '../src/lib/ebay/mapping';
import { amountToPence, availabilityToStock, decimalStringToPence } from '../src/lib/ebay/pricing';
import type { CategoryRule, NormalisedListing } from '../src/lib/ebay/types';

function listing(overrides: Partial<NormalisedListing> = {}): NormalisedListing {
  return {
    itemId: 'ITEM-1',
    title: 'Sample Listing',
    description: null,
    pricePence: 1000,
    currency: 'GBP',
    stock: 5,
    stockIsEstimate: false,
    imageUrl: null,
    images: [],
    itemWebUrl: null,
    ebayCategoryId: null,
    ebayCategoryName: null,
    ...overrides,
  };
}

describe('decimalStringToPence / amountToPence', () => {
  it('converts a plain decimal string to pence', () => {
    expect(decimalStringToPence('12.99')).toBe(1299);
  });

  it('handles a whole-pound value with no decimal part', () => {
    expect(decimalStringToPence('5')).toBe(500);
  });

  it('pads a single decimal digit', () => {
    expect(decimalStringToPence('3.4')).toBe(340);
  });

  it('rounds a sub-penny fraction up', () => {
    expect(decimalStringToPence('1.005')).toBe(101);
  });

  it('never produces a float-rounding artefact for classic problem values', () => {
    // 19.99 * 100 in naive float math is 1998.9999999999998
    expect(decimalStringToPence('19.99')).toBe(1999);
    expect(decimalStringToPence('0.29')).toBe(29);
    expect(decimalStringToPence('2.90')).toBe(290);
  });

  it('rejects garbage input', () => {
    expect(decimalStringToPence('abc')).toBeNull();
    expect(decimalStringToPence('')).toBeNull();
  });

  it('amountToPence delegates to the decimal parser for GBP', () => {
    expect(amountToPence({ value: '12.99', currency: 'GBP' })).toBe(1299);
  });

  it('amountToPence rejects non-GBP currencies rather than importing a wrong price', () => {
    expect(amountToPence({ value: '12.99', currency: 'USD' })).toBeNull();
    expect(amountToPence({ value: '12.99', currency: 'EUR' })).toBeNull();
  });

  it('amountToPence handles a missing amount', () => {
    expect(amountToPence(null)).toBeNull();
    expect(amountToPence(undefined)).toBeNull();
  });
});

describe('applyMarkup', () => {
  it('leaves the price untouched when markup is zero', () => {
    expect(applyMarkup(1000, 0)).toBe(1000);
  });

  it('applies a percentage markup and rounds to the nearest penny', () => {
    expect(applyMarkup(1000, 10)).toBe(1100);
    expect(applyMarkup(999, 15)).toBe(Math.round(999 * 1.15));
  });

  it('supports a negative markup (discount)', () => {
    expect(applyMarkup(1000, -10)).toBe(900);
  });
});

describe('availabilityToStock', () => {
  it('maps IN_STOCK to a modest positive default', () => {
    expect(availabilityToStock('IN_STOCK')).toBeGreaterThan(0);
  });

  it('maps LIMITED_STOCK to fewer units than IN_STOCK', () => {
    expect(availabilityToStock('LIMITED_STOCK')).toBeGreaterThan(0);
    expect(availabilityToStock('LIMITED_STOCK')).toBeLessThan(availabilityToStock('IN_STOCK'));
  });

  it('maps OUT_OF_STOCK to zero', () => {
    expect(availabilityToStock('OUT_OF_STOCK')).toBe(0);
  });

  it('treats a missing bucket as in stock (Browse omits it when plentiful)', () => {
    expect(availabilityToStock(null)).toBe(availabilityToStock('IN_STOCK'));
    expect(availabilityToStock(undefined)).toBe(availabilityToStock('IN_STOCK'));
  });

  it('falls back sensibly for an unrecognised bucket value', () => {
    expect(availabilityToStock('SOME_NEW_BUCKET_EBAY_ADDS_LATER')).toBe(availabilityToStock('IN_STOCK'));
  });
});

describe('matchesKeyword (word-ish boundary matching)', () => {
  it('matches a whole word case-insensitively', () => {
    expect(matchesKeyword('Premium Cat Food 2kg', 'cat food')).toBe(true);
    expect(matchesKeyword('DOG TREATS VARIETY PACK', 'dog')).toBe(true);
  });

  it('does not match inside a larger word', () => {
    expect(matchesKeyword('Category Management Book', 'cat')).toBe(false);
    expect(matchesKeyword('Concatenated Cable', 'cat')).toBe(false);
  });

  it('matches at the start or end of the string', () => {
    expect(matchesKeyword('Toy car', 'toy')).toBe(true);
    expect(matchesKeyword('Board game night', 'night')).toBe(true);
  });
});

describe('mapCategory', () => {
  const rules: CategoryRule[] = [
    { matchType: 'keyword', matchValue: 'dog', categoryId: 1, priority: 100 },
    { matchType: 'keyword', matchValue: 'pet', categoryId: 1, priority: 60 },
    { matchType: 'keyword', matchValue: 'board game', categoryId: 2, priority: 100 },
    { matchType: 'ebay_category', matchValue: '11450', categoryId: 3, priority: 200 },
  ];

  it('matches a keyword rule case-insensitively', () => {
    expect(mapCategory({ title: 'Premium DOG Food 12kg' }, rules, null)).toBe(1);
  });

  it('prefers the higher-priority rule when more than one matches', () => {
    // "dog" (priority 100) and "pet" (priority 60) both appear in the title.
    expect(mapCategory({ title: 'Pet Dog Chews' }, rules, null)).toBe(1);
  });

  it('matches a multi-word keyword phrase', () => {
    expect(mapCategory({ title: 'Classic Board Game Bundle' }, rules, null)).toBe(2);
  });

  it('matches an ebay_category rule by id ahead of keyword rules by priority', () => {
    expect(mapCategory({ title: 'Dog Toy', ebayCategoryId: '11450' }, rules, null)).toBe(3);
  });

  it('falls back to the account default when nothing matches', () => {
    expect(mapCategory({ title: 'Unrelated Widget' }, rules, 9)).toBe(9);
  });

  it('falls back to null when nothing matches and there is no default', () => {
    expect(mapCategory({ title: 'Unrelated Widget' }, rules, null)).toBeNull();
  });
});

describe('resolveUpdateFields (lock rules)', () => {
  const candidate = {
    pricePence: 1200,
    stock: 7,
    title: 'New Title',
    description: 'New description',
    imageUrl: 'https://example.com/new.jpg',
    imagesJson: '["https://example.com/new.jpg"]',
    categoryId: 5,
  };

  it('writes every field when nothing is locked', () => {
    const fields = resolveUpdateFields(
      { priceLocked: false, stockLocked: false, contentLocked: false },
      candidate,
    );
    expect(fields.price_pence).toBe(1200);
    expect(fields.stock).toBe(7);
    expect(fields.title).toBe('New Title');
    expect(fields.image_url).toBe(candidate.imageUrl);
  });

  it('skips price when price_locked', () => {
    const fields = resolveUpdateFields(
      { priceLocked: true, stockLocked: false, contentLocked: false },
      candidate,
    );
    expect(fields.price_pence).toBeUndefined();
    expect(fields.stock).toBe(7);
  });

  it('skips stock when stock_locked', () => {
    const fields = resolveUpdateFields(
      { priceLocked: false, stockLocked: true, contentLocked: false },
      candidate,
    );
    expect(fields.stock).toBeUndefined();
    expect(fields.price_pence).toBe(1200);
  });

  it('skips title/description/images when content_locked', () => {
    const fields = resolveUpdateFields(
      { priceLocked: false, stockLocked: false, contentLocked: true },
      candidate,
    );
    expect(fields.title).toBeUndefined();
    expect(fields.description).toBeUndefined();
    expect(fields.image_url).toBeUndefined();
    expect(fields.images_json).toBeUndefined();
    // Price and stock are unaffected by content_locked.
    expect(fields.price_pence).toBe(1200);
    expect(fields.stock).toBe(7);
  });

  it('never writes a null price over a real one (unparseable/non-GBP source price)', () => {
    const fields = resolveUpdateFields(
      { priceLocked: false, stockLocked: false, contentLocked: false },
      { ...candidate, pricePence: null },
    );
    expect(fields.price_pence).toBeUndefined();
  });

  it('locksFromRow coerces the D1 integer flags to booleans', () => {
    expect(locksFromRow({ price_locked: 1, stock_locked: 0, content_locked: 1 })).toEqual({
      priceLocked: true,
      stockLocked: false,
      contentLocked: true,
    });
  });
});

describe('diffListings', () => {
  function row(overrides: Partial<ExistingProductRow> = {}): ExistingProductRow {
    return { id: 1, ebay_item_id: 'ITEM-1', price_locked: 0, stock_locked: 0, content_locked: 0, ...overrides };
  }

  it('treats a listing with no matching product as a create', () => {
    const diff = diffListings([], [listing({ itemId: 'NEW-1' })]);
    expect(diff.toCreate).toHaveLength(1);
    expect(diff.toCreate[0].itemId).toBe('NEW-1');
    expect(diff.toUpdate).toHaveLength(0);
    expect(diff.toEnd).toHaveLength(0);
  });

  it('treats a listing matching an existing product as an update', () => {
    const existing = [row({ id: 42, ebay_item_id: 'ITEM-1' })];
    const diff = diffListings(existing, [listing({ itemId: 'ITEM-1' })]);
    expect(diff.toCreate).toHaveLength(0);
    expect(diff.toUpdate).toHaveLength(1);
    expect(diff.toUpdate[0].product.id).toBe(42);
    expect(diff.toEnd).toHaveLength(0);
  });

  it('treats an existing product missing from the feed as ended', () => {
    const existing = [row({ id: 7, ebay_item_id: 'GONE-1' })];
    const diff = diffListings(existing, []);
    expect(diff.toEnd).toHaveLength(1);
    expect(diff.toEnd[0].id).toBe(7);
    expect(diff.toCreate).toHaveLength(0);
    expect(diff.toUpdate).toHaveLength(0);
  });

  it('handles a realistic mixed run: one create, one update, one ended', () => {
    const existing = [
      row({ id: 1, ebay_item_id: 'STILL-LISTED' }),
      row({ id: 2, ebay_item_id: 'NO-LONGER-LISTED' }),
    ];
    const fetched = [listing({ itemId: 'STILL-LISTED' }), listing({ itemId: 'BRAND-NEW' })];
    const diff = diffListings(existing, fetched);
    expect(diff.toCreate.map((l) => l.itemId)).toEqual(['BRAND-NEW']);
    expect(diff.toUpdate.map((u) => u.product.id)).toEqual([1]);
    expect(diff.toEnd.map((r) => r.id)).toEqual([2]);
  });

  it('ignores products with no ebay_item_id (manual/csv rows should never be touched)', () => {
    const existing = [row({ id: 1, ebay_item_id: null })];
    const diff = diffListings(existing, []);
    expect(diff.toEnd).toHaveLength(0);
  });
});

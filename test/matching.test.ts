import { describe, expect, it } from 'vitest';
import {
  AUTO_LINK_SCORE,
  exactDuplicateGroups,
  matchListing,
  normaliseTitle,
  titleSimilarity,
} from '../src/lib/matching';

// Real titles from the live catalogue.
const CATALOGUE = [
  { id: 5, title: '250 Clipper Organic Peppermint Tea Bags | Individually Wrapped Infusion' },
  { id: 6, title: 'Pukka Herbs Peace Organic Tea, Chamomile, Spearmint, Ashwagandha (4 x 20 Pack)' },
  { id: 77, title: 'Pukka Peace Organic Herbal Tea 20 Tea Bags Sachets' },
  { id: 156, title: 'TENA Men Level 1 Active Fit Discreet Absorbent Protector Pads 24 Pack' },
  { id: 157, title: '96 x TENA Men Absorbent Protector Level 1 |  Incontinence Pads| 4 Packs of 24' },
  { id: 18, title: '(TSUBAKI) Premium Moist & Repair Conditioner 450mL' },
  { id: 47, title: 'Dreamies Catisfactions Tuna 6 x 200g 1.2kg Total' },
  { id: 67, title: 'Airwick Freshmatic Refills - Crisp Linen & Lilac - Pack of 4 - 250ml' },
];

describe('normaliseTitle', () => {
  it('unifies units and drops punctuation and filler words', () => {
    expect(normaliseTitle('Peat-Free Multi-Purpose Compost 50 Litre')).toEqual(['peat', 'free', 'multi', 'purpose', 'compost', '50l']);
    expect(normaliseTitle('Compost 50L')).toEqual(['compost', '50l']);
    expect(normaliseTitle('Shampoo 1000ml')).toEqual(['shampoo', '1l']);
    expect(normaliseTitle('Dreamies 6 x 200g')).toEqual(['dreamies', '6', '200g']);
  });
});

describe('titleSimilarity', () => {
  it('scores the same product worded differently as a strong match', () => {
    expect(
      titleSimilarity('TSUBAKI Premium Moist & Repair Conditioner 450ml', '(TSUBAKI) Premium Moist & Repair Conditioner 450mL'),
    ).toBeGreaterThanOrEqual(AUTO_LINK_SCORE);
    expect(
      titleSimilarity('Air Wick Freshmatic Refills Crisp Linen and Lilac 4 x 250 ml', 'Airwick Freshmatic Refills - Crisp Linen & Lilac - Pack of 4 - 250ml'),
    ).toBeGreaterThan(0.6);
  });

  it('never lets different pack sizes reach the auto-link score', () => {
    expect(titleSimilarity(CATALOGUE[1].title, CATALOGUE[2].title)).toBeLessThan(AUTO_LINK_SCORE);
    expect(titleSimilarity(CATALOGUE[3].title, CATALOGUE[4].title)).toBeLessThan(AUTO_LINK_SCORE);
    expect(titleSimilarity('Peat Free Compost 50L', 'Peat Free Compost 25L')).toBeLessThanOrEqual(0.6);
  });

  it('scores unrelated products low', () => {
    expect(titleSimilarity(CATALOGUE[0].title, CATALOGUE[5].title)).toBeLessThan(0.2);
  });
});

describe('matchListing', () => {
  it('auto-links a confident title match', () => {
    const r = matchListing({ title: 'Tsubaki Premium Moist and Repair Conditioner 450 ml' }, CATALOGUE);
    expect(r.autoLinkId).toBe(18);
  });

  it('sends pack-size near-misses to review with suggestions', () => {
    const r = matchListing({ title: 'Pukka Peace Organic Herbal Tea 4 x 20 Tea Bags' }, CATALOGUE);
    expect(r.autoLinkId).toBeNull();
    expect(r.suggestions.map((s) => s.id)).toContain(6);
  });

  it('links on an exact SKU even when the title differs', () => {
    const r = matchListing({ title: 'Something else entirely', sku: 'tsu-450' }, [
      ...CATALOGUE,
      { id: 999, title: 'Conditioner', sku: 'TSU450' },
    ]);
    expect(r.autoLinkId).toBe(999);
  });

  it('does not auto-link when two products are equally good', () => {
    const r = matchListing({ title: 'Blue Widget 10 pack' }, [
      { id: 1, title: 'Blue Widget 10 pack' },
      { id: 2, title: 'Blue Widget 10pk' },
    ]);
    expect(r.autoLinkId).toBeNull();
    expect(r.suggestions).toHaveLength(2);
  });

  it('returns nothing to suggest for an unrelated listing', () => {
    const r = matchListing({ title: 'Garden hose reel 30m' }, CATALOGUE);
    expect(r.best).toBeNull();
    expect(r.autoLinkId).toBeNull();
  });
});

describe('exactDuplicateGroups', () => {
  it('groups the same item listed twice, keeping the lowest id first', () => {
    const groups = exactDuplicateGroups([
      { id: 162, title: 'Dreamies Catisfactions Tuna 6 x 200g 1.2kg Total' },
      { id: 47, title: 'Dreamies Catisfactions Tuna 6 x 200g 1.2kg Total' },
      { id: 161, title: 'Dreamies Cat Treats Tasty Snacks with Chicken & Duck 8 x 60g' },
      { id: 163, title: 'Dreamies Cat Treats Tasty Snacks with Chicken & Duck 8 x 60g' },
      { id: 6, title: CATALOGUE[1].title },
      { id: 77, title: CATALOGUE[2].title },
    ]);
    expect(groups).toEqual([
      [47, 162],
      [161, 163],
    ]);
  });
});

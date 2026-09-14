import { describe, expect, it } from 'vitest';
import { splitAddressLine, toIso3Country } from '../src/lib/parcel2go';

describe('splitAddressLine', () => {
  it('splits a typical UK address line into property and street', () => {
    expect(splitAddressLine('4 Leamington Close')).toEqual({ property: '4', street: 'Leamington Close' });
  });

  it('falls back to the whole line for both fields when there is no space', () => {
    expect(splitAddressLine('Flat3B')).toEqual({ property: 'Flat3B', street: 'Flat3B' });
  });

  it('returns empty strings for empty input', () => {
    expect(splitAddressLine(undefined)).toEqual({ property: '', street: '' });
    expect(splitAddressLine('')).toEqual({ property: '', street: '' });
  });
});

describe('toIso3Country', () => {
  it('maps common GB spellings to GBR', () => {
    expect(toIso3Country('GB')).toBe('GBR');
    expect(toIso3Country('UK')).toBe('GBR');
    expect(toIso3Country('gb')).toBe('GBR');
  });

  it('passes through an existing ISO3 code', () => {
    expect(toIso3Country('FRA')).toBe('FRA');
  });

  it('defaults to GBR for missing or unrecognised input', () => {
    expect(toIso3Country(null)).toBe('GBR');
    expect(toIso3Country('XX')).toBe('GBR');
  });
});

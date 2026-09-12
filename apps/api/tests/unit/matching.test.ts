import { describe, it, expect } from 'vitest';
import { unknownAttorney } from '@arca/contracts';
import { normalizeName, stableSample, matchAttorney, reconcileAvvoMatches, reconcileBarMatches } from '../../src/pipeline/matching.js';
describe('targeted identity matching', () => {
  it('removes credentials and suffixes', () => {
    expect(normalizeName('José Smith, Esq.')).toBe('jose smith');
    expect(normalizeName('John Smith III')).toBe('john smith');
  });
  it('selects at most 15 distinct normalized names independently of website ordering', () => {
    const names = Array.from({ length: 20 }, (_, i) => `Jane ${String.fromCharCode(65 + i)}`);
    expect(stableSample(names)).toHaveLength(15);
    expect(stableSample(names)).toEqual(stableSample([...names].reverse()));
    expect(stableSample(['John Smith Esq.', 'John Smith'])).toHaveLength(1);
  });
  it('does not choose arbitrarily between ambiguous identities', () => {
    const candidates = ['John Smith', 'James Smith'].map(name => ({ ...unknownAttorney(name), city: 'Miami' }));
    expect(matchAttorney('J Smith', candidates)).toMatchObject({ attorney: null, ambiguous: true });
  });
  it('uses the documented Miami filter to disambiguate', () => {
    const a = { ...unknownAttorney('John Smith'), city: 'Miami' };
    const b = { ...unknownAttorney('James Smith'), city: 'Orlando' };
    expect(matchAttorney('J Smith', [a, b])).toMatchObject({ attorney: a, matchConfidence: 'fuzzy' });
  });
  it('does not turn a directory response into an unrelated firm match', () => {
    expect(matchAttorney('Smith Law', [{ ...unknownAttorney('John Smith'), firmName: 'Other Law' }], true).attorney).toBeNull();
  });
  it('accepts an approximate Bar name only with independent firm support', () => {
    const candidate = { ...unknownAttorney('Jane Smith'), firmName: 'Smith Law' };
    const fuzzy = { searchedName: 'Jane Q Smith', matchConfidence: 'fuzzy' as const, attorney: candidate, ambiguous: false };
    expect(reconcileBarMatches([fuzzy], 'Smith Law')?.[0]).toMatchObject({
      attorney: candidate, matchConfidence: 'cross_ref', ambiguous: false,
    });
  });
  it('rejects an approximate Bar name without firm or county support', () => {
    const fuzzy = { searchedName: 'Jane Q Smith', matchConfidence: 'fuzzy' as const,
      attorney: { ...unknownAttorney('Jane Smith'), firmName: 'Other Law', county: 'Broward' }, ambiguous: false };
    expect(reconcileBarMatches([fuzzy], 'Smith Law')?.[0]).toMatchObject({
      attorney: null, matchConfidence: 'no_match', ambiguous: false,
    });
  });
  it('confirms a fuzzy Avvo candidate only through Bar cross-reference', () => {
    const avvo = { searchedName: 'Jane Q Smith', matchConfidence: 'fuzzy' as const, ambiguous: false,
      attorney: { ...unknownAttorney('Jane Smith'), phone: '(305) 555-0100' } };
    const bar = { searchedName: 'Jane Q Smith', matchConfidence: 'exact' as const, ambiguous: false,
      attorney: { ...unknownAttorney('Jane Q Smith'), phone: '3055550100' } };
    expect(reconcileAvvoMatches([avvo], [bar], 'Other Firm')?.[0]).toMatchObject({
      attorney: avvo.attorney, matchConfidence: 'cross_ref', ambiguous: false,
    });
  });
  it('rejects an unconfirmed fuzzy Avvo candidate', () => {
    const avvo = { searchedName: 'Jane Q Smith', matchConfidence: 'fuzzy' as const, ambiguous: false,
      attorney: { ...unknownAttorney('Jane Smith'), firmName: 'Unrelated Firm' } };
    expect(reconcileAvvoMatches([avvo], null, 'Expected Firm')?.[0]).toMatchObject({
      attorney: null, matchConfidence: 'no_match', ambiguous: false,
    });
  });
});

import { describe, it, expect } from 'vitest';
import { unknownAttorney } from '@arca/contracts';
import { normalizeName, stableSample, matchAttorney } from '../../src/pipeline/matching.js';
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
});

import { describe, it, expect } from 'vitest';
import { unknownAttorney } from '@arca/contracts';
import { normalizeName, stableSample, matchAttorney, reconcileAvvoMatches, reconcileBarMatches } from '../../src/pipeline/matching.js';
describe('targeted identity matching', () => {
  it('removes credentials and suffixes', () => {
    expect(normalizeName('José Smith, Esq.')).toBe('jose smith');
    expect(normalizeName('John Smith III')).toBe('john smith');
    expect(normalizeName('Amanda Hernandez "Amanda Hernandez"')).toBe('amanda hernandez');
  });
  it('keeps every distinct normalized name independently of website ordering', () => {
    const names = Array.from({ length: 30 }, (_, i) => `Jane Name${String.fromCharCode(65 + Math.floor(i / 26))}${String.fromCharCode(65 + i % 26)}`);
    expect(stableSample(names)).toHaveLength(30);
    expect(stableSample(names)).toEqual(stableSample([...names].reverse()));
    expect(stableSample(['John Smith Esq.', 'John Smith'])).toHaveLength(1);
  });
  it('does not choose arbitrarily between ambiguous identities', () => {
    const candidates = ['John Smith', 'James Smith'].map(name => ({ ...unknownAttorney(name), city: 'Miami' }));
    expect(matchAttorney('J Smith', candidates)).toMatchObject({ attorney: null, ambiguous: true });
  });
  it('uses the observed city to disambiguate without a hard-coded Miami preference', () => {
    const a = { ...unknownAttorney('John Smith'), city: 'Miami' };
    const b = { ...unknownAttorney('James Smith'), city: 'Orlando' };
    expect(matchAttorney('J Smith', [a, b], false, { firmName: null, aliases: [], city: 'Orlando',
      county: null, addressStreet: null, phone: null })).toMatchObject({ attorney: b, matchConfidence: 'fuzzy' });
  });
  it('does not accept an exact-name homonym that contradicts all verified context', () => {
    const other = { ...unknownAttorney('Jane Smith'), firmName: 'Other Law', city: 'Orlando' };
    expect(matchAttorney('Jane Smith', [other], false, { firmName: 'Smith Law', aliases: [], city: 'Tampa',
      county: null, addressStreet: null, phone: null })).toMatchObject({ attorney: null, ambiguous: true });
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
  it('cross-checks a website-shortened name between Bar and Avvo', () => {
    const identity = { firmName: 'Gallardo Law Firm', aliases: [], city: 'Miami', county: null,
      addressStreet: '8492 SW 8th St', phone: '(305) 261-7000' };
    const barCandidate = { ...unknownAttorney('Briana Nicole Mauri'), admissionDate: '2025-10-30',
      addressStreet: '14561 SW 37th St', city: 'Miramar', county: 'Broward', firmName: 'Briana Nicole Mauri' };
    const avvoCandidate = { ...unknownAttorney('Briana Nicole Mauri'), licensedSince: '2025',
      addressStreet: '14561 SW 37th St', city: 'Miramar', firmName: 'Briana Nicole Mauri' };
    const rawBar = matchAttorney('Briana Mauri', [barCandidate], false, identity);
    const rawAvvo = matchAttorney('Briana Mauri', [avvoCandidate], false, identity);
    expect(rawBar).toMatchObject({ attorney: null, candidates: [barCandidate] });
    expect(rawAvvo).toMatchObject({ attorney: null, candidates: [avvoCandidate] });
    const avvo = reconcileAvvoMatches([rawAvvo], [rawBar], identity);
    expect(avvo?.[0]).toMatchObject({ attorney: avvoCandidate, matchConfidence: 'cross_ref', ambiguous: false });
    expect(reconcileBarMatches([rawBar], identity, avvo)?.[0]).toMatchObject({
      attorney: barCandidate, matchConfidence: 'cross_ref', ambiguous: false,
    });
  });
  it('does not trust a longer name without independent directory or firm evidence', () => {
    const candidate = { ...unknownAttorney('Briana Nicole Mauri'), firmName: 'Briana Nicole Mauri', city: 'Miramar' };
    const raw = matchAttorney('Briana Mauri', [candidate], false, { firmName: 'Gallardo Law Firm', aliases: [],
      city: 'Miami', county: null, addressStreet: '8492 SW 8th St', phone: '(305) 261-7000' });
    expect(reconcileAvvoMatches([raw], null, 'Gallardo Law Firm')?.[0]).toMatchObject({
      attorney: null, matchConfidence: 'no_match',
    });
  });
});

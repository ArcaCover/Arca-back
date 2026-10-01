import { describe, expect, it } from 'vitest';
import { Layer1Evidence, SourceStatus, unknownAttorney, unknownWebsite } from '@arca/contracts';
import { evaluateLayer1Evidence } from '../src/evaluate.js';

describe('provider-agnostic Layer 1 boundary', () => {
  it('is deterministic for the same structured evidence DTO', () => {
    const status = SourceStatus.parse({ status: 'ok', dataStatus: 'EMPTY', durationMs: 1 });
    const evidence = Layer1Evidence.parse({ identity: { canonicalDomain: 'firm.com', firmName: 'Smith Law', aliases: [],
      city: 'Miami', county: null, addressStreet: null, phone: null, attorneyNames: [], status: 'PARTIAL', evidence: [] },
      website: unknownWebsite(), bar: [], avvo: [],
      sources: { website: { ...status, dataStatus: 'PRESENT' }, bar: status, avvo: status },
      observedAt: '2026-09-12T12:00:00.000Z' });
    const first = evaluateLayer1Evidence(evidence);
    const second = evaluateLayer1Evidence(structuredClone(evidence));
    expect(second).toEqual(first);
  });
  it('recovers a shortened website name when Bar and Avvo agree on the full identity', () => {
    const status = SourceStatus.parse({ status: 'ok', dataStatus: 'PRESENT', durationMs: 1,
      attorneysSearched: 1, attorneysFound: 0 });
    const barAttorney = { ...unknownAttorney('Briana Nicole Mauri'), barNumber: '1071132', barStatus: 'active' as const,
      admissionDate: '2025-10-30', addressStreet: '14561 SW 37th St', city: 'Miramar' };
    const avvoAttorney = { ...unknownAttorney('Briana Nicole Mauri'), licensedSince: '2025',
      addressStreet: '14561 SW 37th St', city: 'Miramar', profileUrl: 'https://www.avvo.com/briana-mauri' };
    const result = evaluateLayer1Evidence({ identity: { canonicalDomain: 'gallardolawyers.com',
      firmName: 'Gallardo Law Firm', aliases: [], city: 'Miami', county: null, addressStreet: '8492 SW 8th St',
      phone: '(305) 261-7000', attorneyNames: ['Briana Mauri'], status: 'VERIFIED', evidence: [] },
      website: unknownWebsite(),
      bar: [{ searchedName: 'Briana Mauri', matchConfidence: 'no_match', attorney: null, ambiguous: false,
        candidates: [barAttorney] }],
      avvo: [{ searchedName: 'Briana Mauri', matchConfidence: 'no_match', attorney: null, ambiguous: false,
        candidates: [avvoAttorney] }],
      sources: { website: SourceStatus.parse({ status: 'ok', dataStatus: 'PRESENT', durationMs: 1 }),
        bar: status, avvo: status }, observedAt: '2026-09-15T12:00:00.000Z' });
    expect(result.signals.bar.attorneys?.[0]).toMatchObject({ searchedName: 'Briana Mauri',
      matchConfidence: 'cross_ref', attorney: { name: 'Briana Nicole Mauri', barNumber: '1071132' } });
    expect(result.sources).toMatchObject({ bar: { attorneysFound: 1 }, avvo: { attorneysFound: 1 } });
  });

  // pankauskilawfirm.com, 2026-10-01: the firm was renamed, so the Bar rejected the match on its
  // own, and a free-text Avvo search filled its ten-result page. Both directories agree on phone,
  // street and admission year, which the cross-check accepts; the source statuses have to follow.
  const pankauski = (avvoCandidate: Partial<ReturnType<typeof unknownAttorney>>) => {
    const barAttorney = { ...unknownAttorney('John Jeffrey Pankauski'), barNumber: '982032', barStatus: 'active' as const,
      admissionDate: '1993-09-25', firmName: 'Pankauski Lazarus PLLC', city: 'West Palm Beach',
      phone: '561-514-0900', addressStreet: '415 S Olive Ave' };
    const avvoAttorney = { ...unknownAttorney('John Jeffrey Pankauski'), city: 'West Palm Beach', ...avvoCandidate };
    const status = (fields: object) => SourceStatus.parse({ durationMs: 1, attorneysSearched: 1, attorneysFound: 0, ...fields });
    return evaluateLayer1Evidence({ identity: { canonicalDomain: 'pankauskilawfirm.com',
      firmName: 'Pankauski Law Firm PLLC', aliases: [], city: 'West Palm Beach', county: null, addressStreet: null,
      phone: null, attorneyNames: ['John J. Pankauski'], status: 'VERIFIED', evidence: [] },
      website: unknownWebsite(),
      bar: [{ searchedName: 'John J. Pankauski', matchConfidence: 'no_match', attorney: null, ambiguous: false, candidates: [barAttorney] }],
      avvo: [{ searchedName: 'John J. Pankauski', matchConfidence: 'no_match', attorney: null, ambiguous: false, candidates: [avvoAttorney] }],
      sources: { website: SourceStatus.parse({ status: 'ok', dataStatus: 'PRESENT', durationMs: 1 }),
        bar: status({ status: 'ok', dataStatus: 'EMPTY', code: 'NO_MATCH', reason: 'Provider completed successfully with no accepted identity match' }),
        avvo: status({ status: 'partial', dataStatus: 'UNKNOWN', code: 'TRUNCATED', reason: 'One or more targeted lookups were incomplete; raw responses retained' }) },
      observedAt: '2026-10-01T04:35:00.000Z' });
  };

  it('settles NO_MATCH and TRUNCATED once both directories confirm the same person', () => {
    const result = pankauski({ phone: '(561) 514-0900', addressStreet: '415 S Olive Ave', licensedSince: '1993' });
    expect(result.sources.bar).toMatchObject({ status: 'ok', dataStatus: 'PRESENT', attorneysFound: 1,
      reason: 'Accepted after cross-checking the other directory' });
    expect(result.sources.bar).not.toHaveProperty('code');
    expect(result.sources.avvo).toMatchObject({ status: 'ok', dataStatus: 'PRESENT', attorneysFound: 1 });
    expect(result.sources.avvo).not.toHaveProperty('code');
    expect(result.preScore.flags).not.toContain('INCOMPLETE_SOURCES');
  });

  it('keeps a full Avvo page partial when nothing but the name ties the match to the person', () => {
    // Same name and city only: lawyers past the tenth result could share both.
    const result = pankauski({});
    expect(result.sources.avvo).toMatchObject({ status: 'partial', code: 'TRUNCATED' });
  });
});

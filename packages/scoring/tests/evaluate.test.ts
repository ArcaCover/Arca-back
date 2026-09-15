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
});

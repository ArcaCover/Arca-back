import { describe, expect, it } from 'vitest';
import { Layer1Evidence, SourceStatus, unknownWebsite } from '@arca/contracts';
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
});

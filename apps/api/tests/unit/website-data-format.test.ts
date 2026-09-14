import { expect, it } from 'vitest';
import type { Claim } from '@arca/contracts';
import { toWebsiteData } from '../../src/pipeline/signal-grounding.js';
import { buildCorpus } from '../../src/pipeline/evidence-corpus.js';

it('writes a United States phone number in one format', () => {
  const corpus = buildCorpus({ partial: false, pages: [{ url: 'https://firm.com/', html: '', text: 'Call +1 305-436-0155' }] });
  const phone = (value: string): Claim => ({ id: 'phone', field: 'phone', value, explanation: 'header',
    citations: [{ segmentId: corpus.segments[0]!.id, quote: 'Call +1 305-436-0155' }] });
  expect(toWebsiteData([phone('+1 305-436-0155')], corpus).phone).toBe('(305) 436-0155');
  expect(toWebsiteData([phone('305.436.0155')], corpus).phone).toBe('(305) 436-0155');
  expect(toWebsiteData([phone('+57 60 1 426 3975')], corpus).phone).toBe('+57 60 1 426 3975');
});

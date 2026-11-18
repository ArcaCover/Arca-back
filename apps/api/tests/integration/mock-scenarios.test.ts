import { describe, it, expect } from 'vitest';
import { PollResponse, ScanResponse } from '@arca/contracts';
import { createApp } from '../../src/http/app.js';
import { InMemoryRepository } from '../../src/repositories/in-memory.js';
import { InProcessPipeline } from '../../src/pipeline/in-process-pipeline.js';
import { mockSources } from '../../src/pipeline/mock-sources.js';
import { PublicDomainResolver } from '../../src/pipeline/domain-resolution.js';

const secret = 's'.repeat(40);
const domainResolver = new PublicDomainResolver(async () => {});

// Drives a mock domain through POST /scan and the polling endpoint, exactly as the
// frontend does, and validates every response against the published contract.
async function scan(domain: string) {
  const repository = new InMemoryRepository();
  const { app, drain } = createApp({ domainResolver, repository, sessionSecret: secret, corsOrigins: [],
    clientIp: () => '127.0.0.1',
    pipeline: new InProcessPipeline({ ...mockSources(), repository, timeoutMs: 30_000 }) });
  const started = ScanResponse.parse(await (await app.request(new Request('http://localhost/scan', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `owner@${domain}`, domain }),
  }))).json());
  await drain();
  return PollResponse.parse(await (await app.request(`/scan/${started.scanId}`,
    { headers: { Authorization: `Bearer ${started.sessionToken}` } })).json());
}

describe('mock scenarios cover every terminal status the frontend renders', () => {
  it('completes when all three sources answer', async () => {
    const poll = await scan('robust.arca.example');
    expect(poll.status).toBe('COMPLETED');
    expect(poll.result?.preScore.tier).toBe('FORTRESS');
    // The state comes from the Bar source's registry, carried through the pipeline.
    expect(poll.result?.multipliers.jurisdiction).toEqual({ state: 'FL', value: 1.25, known: true });
  });

  it('stays partial when one directory is down, and blocks the commercial decision', async () => {
    const poll = await scan('partial.arca.example');
    expect(poll.status).toBe('PARTIAL');
    // The screen shows the score with an incomplete-evidence warning, and no decision.
    expect(poll.result?.preScore.assessmentStatus).toBe('INSUFFICIENT_EVIDENCE');
    expect(poll.result?.preScore.decision).toBe('UNKNOWN');
    expect(poll.result?.preScore.flags).toContain('INCOMPLETE_SOURCES');
    expect(poll.result?.sources.avvo.status).toBe('error');
  });

  it.each([['refuses to be read', 'blocked.arca.example', 'ACCESS_BLOCKED'], ['could not be reached', 'down.arca.example', 'PROVIDER_ERROR']])(
    'stays partial, with low confidence and no restriction, when the website %s', async (_name, domain, code) => {
      const poll = await scan(domain);
      expect(poll.status).toBe('PARTIAL');
      expect(poll.result?.sources.website).toMatchObject({ status: 'error', code, pagesCrawled: 0 });
      expect(poll.result?.preScore).toMatchObject({ confidence: 'LOW', decision: 'UNKNOWN', overrides: [] });
      expect(poll.result?.preScore.flags).toContain('WEBSITE_UNAVAILABLE');
    });

  it('fails with no result when our own extraction fails', async () => {
    const poll = await scan('failed.arca.example');
    expect(poll.status).toBe('FAILED');
    // PollResponse has no room for a result on FAILED. Parsing above is the real assertion:
    // persisting one here used to make the API violate its own published schema.
    expect(poll).not.toHaveProperty('result');
  });
});

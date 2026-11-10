import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { PollResponse, ScanResponse } from '@arca/contracts';
import { createApp } from '../../src/http/app.js';
import { answersFromCache, resultDegradation } from '../../src/http/scan-cache.js';
import { InMemoryRepository } from '../../src/repositories/in-memory.js';
import { InProcessPipeline } from '../../src/pipeline/in-process-pipeline.js';
import { WebsiteExtractionSource } from '../../src/pipeline/website-source.js';
import { AgenticEvidenceProvider } from '../../src/pipeline/agentic-evidence-provider.js';
import { ApifyClient } from '../../src/pipeline/apify-client.js';
import { ApifyDirectorySource } from '../../src/pipeline/directories.js';
import { mockSources } from '../../src/pipeline/mock-sources.js';
import { PublicDomainResolver } from '../../src/pipeline/domain-resolution.js';
import type { ScanCost } from '../../src/pipeline/scan-cost.js';
import { replayAccess, replayApify, replayModel, type ApifyRecording, type ModelRecordings } from '../fixtures/replay/replay.js';
import { ACCESS_PAGES, DOMAIN, PAGES } from '../fixtures/replay/harbor-vale/site.js';

// DN-12 §5. The real pipeline over the recordings of the replay test (DN-12 §4.5): the Apify client and its ledger,
// the agentic extraction and the directory sources are the real ones, and nothing leaves the process.
const fixture = (name: string) => new URL(`../fixtures/replay/harbor-vale/${name}`, import.meta.url);
const model: ModelRecordings = JSON.parse(readFileSync(fixture('llm.json'), 'utf8'));
const apifyRecordings: ApifyRecording[] = JSON.parse(readFileSync(fixture('apify.json'), 'utf8'));
const NOW = Date.parse('2026-11-09T12:00:00.000Z');
const EMAIL = 'owner@harborvale.example';
const TAG = '[scan-cost] ';
type Line = { scanId: string; status: string; durationMs: number } & ScanCost;

let log: MockInstance<typeof console.log>, errors: MockInstance<typeof console.error>;
beforeEach(() => {
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
  errors = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });
const rawLines = () => log.mock.calls.map(call => String(call[0])).filter(line => line.startsWith(TAG));
const lines = (): Line[] => rawLines().map(line => JSON.parse(line.slice(TAG.length)));

let scans = 0;
/** One scan through the real pipeline. Each recorded model answer reports the same token usage. */
async function scan(repository: InMemoryRepository, options: { spendCeilingUsd?: number | null } = {}) {
  const llm = replayModel(model), reader = replayAccess(ACCESS_PAGES), apify = replayApify(apifyRecordings);
  const metered = { chat: { completions: { create: async (body: Record<string, unknown>) =>
    ({ ...await llm.client.chat.completions.create(body), usage: { prompt_tokens: 1000, completion_tokens: 200 } }) } } };
  const website = new WebsiteExtractionSource(repository, new AgenticEvidenceProvider('replay-key', undefined, metered, reader.access),
    async () => ({ pages: structuredClone(PAGES), partial: false, issues: [], aborted: false }), { now: () => NOW });
  const client = new ApifyClient('replay-token', apify.request, 16, { store: repository, spendCeilingUsd: options.spendCeilingUsd });
  const pipeline = new InProcessPipeline({ website, bar: new ApifyDirectorySource('bar', client), avvo: new ApifyDirectorySource('avvo', client),
    repository, timeoutMs: 30_000, now: () => NOW });
  const scanId = `sc_cost${++scans}`, at = new Date(NOW).toISOString();
  await repository.create({ id: scanId, scan_id: scanId, email: EMAIL, canonical_domain: DOMAIN,
    domain_resolution: { status: 'RESOLVED', canonicalDomain: DOMAIN, source: 'request', reason: null },
    status: 'RUNNING', result: null, created_at: at, completed_at: null, duration_ms: null, cached: false });
  const outcome = await pipeline.run({ scanId, canonicalDomain: DOMAIN, email: EMAIL });
  expect([...llm.unexpected, ...reader.unexpected, ...apify.unexpected]).toEqual([]);
  return { scanId, outcome, llm, apify };
}
const recordedUsd = Math.round(apifyRecordings.reduce((total, item) => total + item.run.usageTotalUsd, 0) * 1e6) / 1e6;

describe('the cost line of a scan', () => {
  it('says what a first scan started and spent, and nothing that identifies the visitor or a key', async () => {
    const { scanId, outcome, llm, apify } = await scan(new InMemoryRepository());
    expect(outcome.status).toBe('COMPLETED');
    expect(lines()).toEqual([{ scanId, status: 'COMPLETED', durationMs: 0,
      // Four actor runs, each holding its USD 1 reservation until Apify settles the charge it reported so far.
      apify: { started: 4, refused: 0, resumed: 0, chargedUsd: recordedUsd, reservedUsd: 4, cachedUsd: 0 },
      openai: { requests: 7, inputTokens: 7000, outputTokens: 1400 },
      cacheHits: { apifyRuns: 0, websiteAnalysis: false } }]);
    expect(llm.calls).toHaveLength(7);
    expect(apify.posts).toHaveLength(4);
    expect(recordedUsd).toBeGreaterThan(0);
    const [line] = rawLines();
    for (const secret of [EMAIL, 'harborvale', DOMAIN, 'replay-token', 'replay-key', 'Harbor', 'Vale']) expect(line).not.toContain(secret);
  });

  it('says what a second scan of the firm took from the caches instead of paying for it again', async () => {
    const repository = new InMemoryRepository();
    await scan(repository);
    const second = await scan(repository);
    expect(lines()).toHaveLength(2);
    expect(lines()[1]).toEqual({ scanId: second.scanId, status: 'COMPLETED', durationMs: 0,
      apify: { started: 0, refused: 0, resumed: 0, chargedUsd: 0, reservedUsd: 0, cachedUsd: recordedUsd },
      openai: { requests: 0, inputTokens: null, outputTokens: null },
      cacheHits: { apifyRuns: 4, websiteAnalysis: true } });
    expect(second.apify.posts).toEqual([]);
  });

  it('keeps the counts of scans that run at the same time apart', async () => {
    const [a, b] = await Promise.all([scan(new InMemoryRepository()), scan(new InMemoryRepository())]);
    const byScan = new Map(lines().map(line => [line.scanId, line]));
    for (const { scanId } of [a, b]) {
      expect(byScan.get(scanId)).toMatchObject({ apify: { started: 4, reservedUsd: 4 }, openai: { requests: 7, inputTokens: 7000 } });
    }
  });

  it('counts the lookups the spend ceiling refused, and the scan degrades for a passing cause', async () => {
    const repository = new InMemoryRepository();
    const { outcome, apify } = await scan(repository, { spendCeilingUsd: 2 });
    // Two runs fit under USD 2; the other two were refused before any request.
    expect(apify.posts).toHaveLength(2);
    expect(lines()[0]).toMatchObject({ status: 'PARTIAL', apify: { started: 2, refused: 2, reservedUsd: 2 }, openai: { requests: 7 } });
    expect(outcome.status).toBe('PARTIAL');
    const { bar, avvo } = outcome.result.sources;
    const refused = [bar, avvo].filter(source => /spend ceiling/.test(source.reason ?? ''));
    expect(refused.length).toBeGreaterThan(0);
    for (const source of refused) expect(source).toMatchObject({ code: 'PROVIDER_ERROR' });
    // Nothing is concluded about the firm: no flag brands it, and the scan cache repairs the result after the cooldown.
    expect(outcome.result.preScore.flags).not.toContain('WEBSITE_UNAVAILABLE');
    expect(resultDegradation(outcome.result.sources)).toBe('TRANSIENT');
    const stored = { status: outcome.status, result: outcome.result, completed_at: new Date(NOW).toISOString() };
    expect(answersFromCache(stored, NOW + 60_000, 3_600_000)).toBe(true);
    expect(answersFromCache(stored, NOW + 3_600_001, 3_600_000)).toBe(false);
    expect(errors.mock.calls.map(call => String(call[0])).filter(line => line.startsWith('[apify] Apify spend ceiling reached'))).toHaveLength(1);
  });

  it('is written for a pipeline run that throws, as FAILED', async () => {
    const repository = new InMemoryRepository();
    vi.spyOn(repository, 'saveRaw').mockImplementation(() => new Promise(() => {}));
    const pipeline = new InProcessPipeline({ ...mockSources(), repository, timeoutMs: 1000 });
    await expect(pipeline.run({ scanId: 'sc_thrown', canonicalDomain: 'robust.arca.example', email: 'owner@robust.arca.example' }))
      .rejects.toThrow('persistence deadline');
    expect(lines()).toMatchObject([{ scanId: 'sc_thrown', status: 'FAILED', apify: { started: 0 }, openai: { requests: 0 } }]);
  });

  it('is written once per pipeline run and never for a scan served from the cache', async () => {
    const repository = new InMemoryRepository();
    const pipeline = new InProcessPipeline({ ...mockSources(), repository, timeoutMs: 30_000 });
    const { app, drain } = createApp({ repository, pipeline, sessionSecret: 's'.repeat(40), corsOrigins: [],
      clientIp: request => request.headers.get('X-Test-Visitor') ?? 'unknown', domainResolver: new PublicDomainResolver(async () => {}) });
    const post = async (visitor: number) => {
      const response = await app.request('/scan', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Test-Visitor': `visitor-${visitor}` },
        body: JSON.stringify({ email: `visitor${visitor}@robust.arca.example`, domain: 'robust.arca.example' }) });
      const started = ScanResponse.parse(await response.json());
      await drain();
      return PollResponse.parse(await (await app.request(`/scan/${started.scanId}`, { headers: { Authorization: `Bearer ${started.sessionToken}` } })).json());
    };
    const first = await post(1), second = await post(2);
    expect(first).toMatchObject({ status: 'COMPLETED', cached: false });
    expect(second).toMatchObject({ status: 'COMPLETED', cached: true });
    expect(lines()).toMatchObject([{ scanId: first.scanId, status: 'COMPLETED' }]);
    expect(rawLines()[0]).not.toContain('robust.arca.example');
  });
});

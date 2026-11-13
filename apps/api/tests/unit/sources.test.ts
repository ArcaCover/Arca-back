import { describe, it, expect, vi } from 'vitest';
import { unknownWebsite } from '@arca/contracts';
import { ApifyDirectorySource, AVVO_ACTOR, BAR_ACTOR, AVVO_TECHNICAL_MAX_LAWYERS, BAR_TECHNICAL_MAX_LAWYERS,
  AVVO_TARGETED_MAX_LAWYERS, BAR_TARGETED_MAX_LAWYERS, parseBar, parseAvvo,
  parseDisciplineSummary } from '../../src/pipeline/directories.js';
import { ApifyClient, ApifyClientError, committedUsd } from '../../src/pipeline/apify-client.js';
import { directoryDegradation } from '../../src/http/scan-cache.js';
import { RagWebsiteSource, WebsiteExtractionSource } from '../../src/pipeline/website-source.js';
import { RuleBasedEvidenceProvider } from '../../src/pipeline/website-evidence-provider.js';
import { CHALLENGE_PAGE, type CrawlIssue, type CrawlResult } from '../../src/pipeline/crawler.js';
import { InMemoryRepository } from '../../src/repositories/in-memory.js';
import type OpenAI from 'openai';

const query = { canonicalDomain: 'firm.com', names: ['Jane Smith'], firmName: 'Smith Law', city: 'Miami', state: 'FL' as const };
describe('provider evidence boundaries', () => {
  it('does not treat a ten-year clean summary as a lifetime clean record', () => {
    const person = parseBar({ name: 'Jane Smith', status: 'Member in Good Standing', disciplineHistory10Year: 'None' });
    expect(person?.barStatus).toBe('active');
    expect(person?.hasDisciplinaryHistory).toBeNull();
    expect(person?.activeInvestigation).toBeNull();
  });
  it('preserves ambiguous sanction dates and severities', () => {
    expect(parseDisciplineSummary('Suspension 08/01/2026')[0]).toMatchObject({ severity: 'suspension', date: '2026-08-01' });
    expect(parseDisciplineSummary('Suspension and public reprimand 2025-01-01 2026-01-01')[0]).toMatchObject({ severity: null, date: null });
    expect(parseDisciplineSummary('Suspension 02/30/2026')[0]?.date).toBeNull();
  });
  it('distinguishes explicit zero from missing Avvo fields', () => {
    expect(parseAvvo({ name: 'Jane Smith', reviewsCount: 0, disciplined: false })).toMatchObject({ reviewCount: 0, hasDisciplinaryHistory: false, avvoRating: null, awardsCount: null });
  });
  it('uses the structured Bar street and ignores directory contact placeholders', () => {
    expect(parseBar({ name: 'Briana Nicole Mauri', mailStreet: '14561 SW 37th St',
      mailAddress: 'Ms. Briana Nicole Mauri, 14561 SW 37th St, Miramar, FL 33027' })).toMatchObject({
      addressStreet: '14561 SW 37th St',
    });
    expect(parseAvvo({ name: 'Briana Nicole Mauri', phone: 'Not Available' })?.phone).toBeNull();
  });
  it('parses the latest Avvo actor fields used by scoring and cross-reference', () => {
    expect(parseAvvo({ name: 'Jane Q. Smith', avvoRating: 9.2, avvoRatingLevel: 'Superb',
      reviewsCount: 12, reviewsRating: 4.8, awardsCount: 3, topAward: 'Super Lawyer - 2026',
      disciplined: true, yearsLicensed: 20, licensedSince: '2006', phone: '305-555-0100',
      addressStreet: '100 Main St', firmName: 'Smith Law' })).toMatchObject({
      name: 'Jane Q. Smith', avvoRating: 9.2, avvoRatingLevel: 'Superb', reviewCount: 12,
      averageReviewRating: 4.8, awardsCount: 3, topAward: 'Super Lawyer - 2026',
      hasDisciplinaryHistory: true, yearsLicensed: 20, licensedSince: '2006',
      phone: '305-555-0100', addressStreet: '100 Main St', firmName: 'Smith Law',
    });
  });
  it('uses the latest Avvo actor and its name plus city input contract', async () => {
    const run = vi.fn(async () => []);
    await new ApifyDirectorySource('avvo', { run }).run(query, new AbortController().signal);
    expect(run).toHaveBeenCalledWith(AVVO_ACTOR, {
      searchQueries: ['Jane Smith'], cities: ['Miami, FL'], withDetails: true, maxLawyers: AVVO_TARGETED_MAX_LAWYERS,
    }, expect.any(AbortSignal), { scanId: undefined, kind: 'targeted' });
    expect(AVVO_ACTOR).toBe('scrapers_lat/avvo-lawyers-scraper');
  });
  it('caps targeted searches while preserving technical maxima for complete firm fallbacks', async () => {
    const run = vi.fn(async () => []);
    const signal = new AbortController().signal;
    await new ApifyDirectorySource('bar', { run }).run(query, signal);
    await new ApifyDirectorySource('avvo', { run }).run(query, signal);
    expect(run).toHaveBeenNthCalledWith(1, BAR_ACTOR, expect.objectContaining({ maxLawyers: BAR_TARGETED_MAX_LAWYERS }), signal, { scanId: undefined, kind: 'targeted' });
    expect(run).toHaveBeenNthCalledWith(2, AVVO_ACTOR, expect.objectContaining({ maxLawyers: AVVO_TARGETED_MAX_LAWYERS }), signal, { scanId: undefined, kind: 'targeted' });
    await new ApifyDirectorySource('bar', { run }).run({ ...query, names: [] }, signal);
    await new ApifyDirectorySource('avvo', { run }).run({ ...query, names: [] }, signal);
    expect(run).toHaveBeenNthCalledWith(3, BAR_ACTOR, expect.objectContaining({ maxLawyers: BAR_TECHNICAL_MAX_LAWYERS }), signal, { scanId: undefined, kind: 'firm' });
    expect(run).toHaveBeenNthCalledWith(4, AVVO_ACTOR, expect.objectContaining({ maxLawyers: AVVO_TECHNICAL_MAX_LAWYERS }), signal, { scanId: undefined, kind: 'firm' });
  });
  it('skips an Avvo firm search it could only run nationwide, and says why', async () => {
    const run = vi.fn(async () => []);
    const result = await new ApifyDirectorySource('avvo', { run }).run({ ...query, names: [], city: null }, new AbortController().signal);
    expect(run).not.toHaveBeenCalled();
    expect(result.status).toMatchObject({ status: 'skipped', code: 'INSUFFICIENT_IDENTITY', costUsd: 0,
      reason: 'A firm-wide search needs a verified city; a nationwide search is not run' });
  });
  it('reports TRUNCATED only when a full result page was the sole problem', async () => {
    const page = (extra: unknown[] = []) => [...Array.from({ length: AVVO_TARGETED_MAX_LAWYERS }, (_, index) =>
      ({ name: `John Other${index}`, city: 'Miami' })), ...extra];
    const full = await new ApifyDirectorySource('avvo', { run: vi.fn(async () => page()) })
      .run(query, new AbortController().signal);
    expect(full.status).toMatchObject({ status: 'partial', code: 'TRUNCATED' });
    // A record in the wrong shape is a contract failure, and a full page must not hide it.
    const broken = await new ApifyDirectorySource('avvo', { run: vi.fn(async () => page([{ name: 42 }])) })
      .run(query, new AbortController().signal);
    expect(broken.status).toMatchObject({ status: 'partial', code: 'PROVIDER_CONTRACT_ERROR' });
  });
  it('declares the Florida Bar as the jurisdiction of the Bar source only', () => {
    expect(new ApifyDirectorySource('bar', { run: vi.fn() }).jurisdiction).toBe('FL');
    expect(new ApifyDirectorySource('avvo', { run: vi.fn() }).jurisdiction).toBeUndefined();
  });
  it('treats a complete seven-record response as valid evidence', async () => {
    const candidates = Array.from({ length: 7 }, (_, index) => ({
      name: index === 0 ? 'Jane Smith' : `Other Lawyer ${index}`,
      status: 'Member in Good Standing',
    }));
    const result = await new ApifyDirectorySource('bar', { run: async () => candidates })
      .run(query, new AbortController().signal);
    expect(result.status).toMatchObject({ status: 'ok', candidatesReceived: 7, recordsValid: 7 });
    expect(result.data?.[0]?.attorney?.name).toBe('Jane Smith');
  });
  it('treats provider error records as failure, not an empty successful search', async () => {
    const source = new ApifyDirectorySource('bar', { run: async () => [{ error: 'blocked' }] });
    const result = await source.run(query, new AbortController().signal);
    expect(result.status).toMatchObject({ status: 'error', dataStatus: 'UNKNOWN', attorneysFound: null });
    expect(result.data).toBeNull();
    expect(result.rawContent).toContain('blocked');
  });
  it('reports a technically successful empty search separately', async () => {
    const source = new ApifyDirectorySource('avvo', { run: async () => [] });
    const result = await source.run(query, new AbortController().signal);
    expect(result.status).toMatchObject({ status: 'ok', dataStatus: 'EMPTY', attorneysSearched: 1, attorneysFound: 0 });
    expect(result.data?.[0]?.attorney).toBeNull();
  });
  it('classifies the actor no-match record as a successful empty query', async () => {
    const source = new ApifyDirectorySource('bar', { run: async () => [{
      error: 'No lawyers matched. Try a different last name, firm, county/city, or widen the filters.',
    }] });
    const result = await source.run(query, new AbortController().signal);
    expect(result.status).toMatchObject({ status: 'ok', dataStatus: 'EMPTY', code: 'NO_MATCH',
      candidatesReceived: 0, recordsValid: 0, attorneysFound: 0 });
    expect(result.data?.[0]?.attorney).toBeNull();
  });
  it('keeps Apify run and cost metadata with the source evidence', async () => {
    const source = new ApifyDirectorySource('avvo', { run: async () => ({ items: [{ name: 'Jane Smith' }],
      metadata: { provider: 'apify', actor: AVVO_ACTOR, runId: 'run-1', status: 'SUCCEEDED',
        queryFingerprint: 'a'.repeat(64), itemCount: 1, acceptedCount: 0, costUsd: .25 } }) });
    const result = await source.run(query, new AbortController().signal);
    expect(result.status).toMatchObject({ costUsd: .25, candidatesReceived: 1, recordsValid: 1,
      providerRuns: [{ runId: 'run-1', acceptedCount: 1, costUsd: .25 }] });
  });
  it('lists provider runs by query fingerprint, not by the order the lookups finished in', async () => {
    const names = ['Ana Perez', 'Bruno Diaz', 'Carla Ruiz', 'Diego Soto'];
    // Fingerprints are hashes: their order is unrelated to the order of the names.
    const fingerprints: Record<string, string> = { 'Ana Perez': 'c', 'Bruno Diaz': 'a', 'Carla Ruiz': 'd', 'Diego Soto': 'b' };
    const run = (delays: Record<string, number>) => async (_actor: string, input: Record<string, unknown>) => {
      const target = String((input.searchQueries as string[])[0]);
      await new Promise(resolve => setTimeout(resolve, delays[target]));
      return { items: [{ name: target }], metadata: { provider: 'apify' as const, actor: AVVO_ACTOR, runId: `run-${target}`,
        status: 'SUCCEEDED', queryFingerprint: fingerprints[target]!.repeat(64), itemCount: 1, acceptedCount: 0, costUsd: .01 } };
    };
    const lookup = (delays: Record<string, number>) => new ApifyDirectorySource('avvo', { run: run(delays) })
      .run({ ...query, names }, new AbortController().signal);
    const first = await lookup({ 'Ana Perez': 30, 'Bruno Diaz': 20, 'Carla Ruiz': 10, 'Diego Soto': 1 });
    const second = await lookup({ 'Ana Perez': 1, 'Bruno Diaz': 10, 'Carla Ruiz': 20, 'Diego Soto': 30 });
    expect(first.status.providerRuns?.map(item => item.runId))
      .toEqual(['run-Bruno Diaz', 'run-Diego Soto', 'run-Ana Perez', 'run-Carla Ruiz']);
    expect(first.status.providerRuns?.every(item => item.acceptedCount === 1)).toBe(true);
    expect(second.status.providerRuns).toEqual(first.status.providerRuns);
    // The stored raw evidence, and so its content hash, is the same for the same answers.
    expect(second.rawContent).toBe(first.rawContent);
  });
  it('isolates malformed rows instead of discarding valid rows from the same paid dataset', async () => {
    const source = new ApifyDirectorySource('bar', { run: async () => [{ name: 'Jane Smith' }, 'invalid'] });
    const result = await source.run(query, new AbortController().signal);
    expect(result.data?.[0]?.attorney?.name).toBe('Jane Smith');
    expect(result.status).toMatchObject({ status: 'partial', candidatesReceived: 2, recordsValid: 1 });
  });
  it('runs a lookup for every named attorney, including a thirty-attorney roster', async () => {
    const names = Array.from({ length: 30 }, (_, index) =>
      `Attorney Name${String.fromCharCode(65 + Math.floor(index / 26))}${String.fromCharCode(65 + index % 26)}`);
    const run = vi.fn(async (_actor: string, input: Record<string, unknown>) => {
      const target = String((input.searchQueries as string[] | undefined)?.[0] ?? '');
      return [{ name: target }];
    });
    const result = await new ApifyDirectorySource('avvo', { run }).run({ ...query, names }, new AbortController().signal);
    expect(run).toHaveBeenCalledTimes(30);
    expect(result.status).toMatchObject({ status: 'ok', attorneysSearched: 30, attorneysFound: 30 });
    expect(result.data?.map(match => match.searchedName)).toEqual(expect.arrayContaining(names));
  });
  it('keeps partial directory evidence when some named lookups fail', async () => {
    const run = vi.fn(async () => [{ name: 'Jane Smith' }, { error: 'unreadable' }]);
    const result = await new ApifyDirectorySource('bar', { run }).run({ ...query, names: Array.from({ length: 20 }, (_, i) => `Jane Smith${String.fromCharCode(97 + i)}`) }, new AbortController().signal);
    expect(run).toHaveBeenCalledTimes(20);
    expect(result.status.status).toBe('partial');
  });
  it('accepts every firm-fallback attorney the single paid run already returned', async () => {
    const candidates = ['A One', 'B Two', 'C Three'].map(name => ({ name, firm: 'Smith Law' }));
    const run = vi.fn(async () => candidates);
    const result = await new ApifyDirectorySource('bar', { run }).run({
      ...query, names: [],
    }, new AbortController().signal);
    expect(run).toHaveBeenCalledTimes(1);
    expect(result.data).toHaveLength(3);
    expect(result.status.attorneysFound).toBe(3);
  });
  it('keeps rejecting firm-fallback records belonging to another firm', async () => {
    const candidates = [{ name: 'A One', firm: 'Smith Law' }, { name: 'B Two', firm: 'Other Law' },
      { name: 'C Three', firm: null }];
    const result = await new ApifyDirectorySource('bar', { run: async () => candidates }).run({
      ...query, names: [],
    }, new AbortController().signal);
    expect(result.data).toHaveLength(1);
    expect(result.data?.[0]?.attorney?.name).toBe('A One');
  });
});
describe('Apify lifecycle', () => {
  it('paginates successful datasets and authenticates without putting tokens in URLs', async () => {
    const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).not.toContain('secret-token');
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer secret-token' });
      const data = String(url).includes('/runs?') ? { data: { id: 'run', status: 'SUCCEEDED', defaultDatasetId: 'dataset' } }
        : String(url).includes('offset=0&') ? Array.from({ length: 100 }, (_, id) => ({ id })) : [{ id: 100 }];
      return Response.json(data);
    });
    const output = await new ApifyClient('secret-token', request as typeof fetch).run('owner/actor', {}, new AbortController().signal);
    expect(output.items).toHaveLength(101);
    expect(output.metadata).toMatchObject({ actor: 'owner/actor', itemCount: 101, acceptedCount: 0 });
    expect(request).toHaveBeenCalledTimes(3);
  });
  it('continues dataset pagination beyond one thousand attorneys', async () => {
    const request = vi.fn(async (url: string | URL | Request) => {
      const value = String(url);
      if (value.includes('/runs?')) return Response.json({ data: { id: 'run', status: 'SUCCEEDED', defaultDatasetId: 'dataset' } });
      const offset = Number(new URL(value).searchParams.get('offset'));
      const count = offset < 1_000 ? 100 : 1;
      return Response.json(Array.from({ length: count }, (_, index) => ({ id: offset + index })));
    });
    const output = await new ApifyClient('token', request as typeof fetch).run('owner/actor', {}, new AbortController().signal);
    expect(output.items).toHaveLength(1_001);
    expect(request).toHaveBeenCalledTimes(12);
  });
  it('retains a remote run when the caller cancels so it can be recovered', async () => {
    const controller = new AbortController();
    const repository = new InMemoryRepository();
    const request = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('/runs?')) {
        controller.abort();
        return Response.json({ data: { id: 'run', status: 'RUNNING', defaultDatasetId: 'dataset' } });
      }
      return Response.json({});
    });
    await expect(new ApifyClient('token', request as typeof fetch, 2, { store: repository })
      .run('owner/actor', {}, controller.signal)).rejects.toThrow('retained for recovery');
    expect(request.mock.calls.some(call => String(call[0]).includes('/abort'))).toBe(false);
    expect([...repository.apifyRuns.values()][0]).toMatchObject({ run_id: 'run', status: 'RUNNING' });
  });
  it('recovers rows from a timed-out run as explicitly partial evidence', async () => {
    const request = vi.fn(async (url: string | URL | Request) => String(url).includes('/runs?')
      ? Response.json({ data: { id: 'run', status: 'TIMED-OUT', defaultDatasetId: 'dataset', usageTotalUsd: .4 } })
      : Response.json([{ name: 'Jane Smith' }]));
    const output = await new ApifyClient('token', request as typeof fetch).run('owner/actor', {}, new AbortController().signal);
    expect(output.items).toEqual([{ name: 'Jane Smith' }]);
    // Apify settles actor charges after the run ends, so the figure read at the end is provisional.
    expect(output.metadata).toMatchObject({ status: 'TIMED-OUT', partial: true, costUsd: .4, accountingComplete: false });
  });
  it('reuses a completed query without a second actor POST', async () => {
    const repository = new InMemoryRepository();
    const request = vi.fn(async (url: string | URL | Request) => String(url).includes('/runs?')
      ? Response.json({ data: { id: 'run', status: 'SUCCEEDED', defaultDatasetId: 'dataset', usageTotalUsd: .1 } })
      : Response.json([{ name: 'Jane Smith' }]));
    const client = new ApifyClient('token', request as typeof fetch, 2, { store: repository });
    await client.run('owner/actor', { name: 'Jane' }, new AbortController().signal, { scanId: 'sc_one' });
    const cached = await client.run('owner/actor', { name: 'Jane' }, new AbortController().signal, { scanId: 'sc_two' });
    expect(cached.metadata.cached).toBe(true);
    expect(request.mock.calls.filter(call => String(call[0]).includes('/runs?'))).toHaveLength(1);
  });
  it('reuses the dataset id without storing an oversized dataset in one ledger row', async () => {
    const repository = new InMemoryRepository();
    const request = vi.fn(async (url: string | URL | Request) => String(url).includes('/runs?')
      ? Response.json({ data: { id: 'run', status: 'SUCCEEDED', defaultDatasetId: 'dataset', usageTotalUsd: .1 } })
      : Response.json([{ name: 'Jane Smith' }, { name: 'John Smith' }]));
    const client = new ApifyClient('token', request as typeof fetch, 2, { store: repository, maxCachedItems: 1 });
    await client.run('owner/actor', { firm: 'Smith' }, new AbortController().signal);
    const cached = await client.run('owner/actor', { firm: 'Smith' }, new AbortController().signal);
    expect(cached.items).toHaveLength(2);
    expect([...repository.apifyRuns.values()][0]?.items).toBeNull();
    expect(request.mock.calls.filter(call => String(call[0]).includes('/runs?'))).toHaveLength(1);
  });
  it('reports zero incremental scan cost when a directory query is served from cache', async () => {
    const repository = new InMemoryRepository();
    const request = vi.fn(async (url: string | URL | Request) => String(url).includes('/runs?')
      ? Response.json({ data: { id: 'run', status: 'SUCCEEDED', defaultDatasetId: 'dataset', usageTotalUsd: .1 } })
      : Response.json([{ name: 'Jane Smith' }]));
    const source = new ApifyDirectorySource('bar', new ApifyClient('token', request as typeof fetch, 2, { store: repository }));
    const first = await source.run({ ...query, scanId: 'sc_one' }, new AbortController().signal);
    const second = await source.run({ ...query, scanId: 'sc_two' }, new AbortController().signal);
    // The paid run's charges are not settled yet, so its cost is unknown rather than understated.
    expect(first.status).toMatchObject({ costUsd: null, accountingComplete: false, cachedRuns: 0, costPerAcceptedAttorneyUsd: null });
    expect(second.status).toMatchObject({ costUsd: 0, cachedRuns: 1, costPerAcceptedAttorneyUsd: 0 });
  });
  it('resumes the same remote run after the first caller deadline', async () => {
    const repository = new InMemoryRepository();
    const firstController = new AbortController();
    const request = vi.fn(async (url: string | URL | Request) => {
      const value = String(url);
      if (value.includes('/runs?')) { firstController.abort(); return Response.json({ data: {
        id: 'run', status: 'RUNNING', defaultDatasetId: 'dataset' } }); }
      if (value.includes('/actor-runs/')) return Response.json({ data: {
        id: 'run', status: 'SUCCEEDED', defaultDatasetId: 'dataset', usageTotalUsd: .2 } });
      return Response.json([{ name: 'Jane Smith' }]);
    });
    const client = new ApifyClient('token', request as typeof fetch, 2, { store: repository });
    await expect(client.run('owner/actor', { name: 'Jane' }, firstController.signal)).rejects.toThrow();
    const recovered = await client.run('owner/actor', { name: 'Jane' }, new AbortController().signal);
    expect(recovered.metadata).toMatchObject({ runId: 'run', resumed: true, chargedToScan: false });
    expect(request.mock.calls.filter(call => String(call[0]).includes('/runs?'))).toHaveLength(1);
  });
  it('keeps working past the old scan ceiling and books every run on the ledger', async () => {
    const repository = new InMemoryRepository();
    await repository.create({ id: 'id', scan_id: 'sc_budget', email: 'owner@firm.com', canonical_domain: 'firm.com',
      domain_resolution: { status: 'RESOLVED', canonicalDomain: 'firm.com', source: 'request', reason: null },
      status: 'RUNNING', result: null, created_at: new Date().toISOString(), completed_at: null, duration_ms: null, cached: false });
    const request = vi.fn(async (url: string | URL | Request) => String(url).includes('/runs?')
      ? Response.json({ data: { id: 'run', status: 'SUCCEEDED', defaultDatasetId: 'dataset' } }) : Response.json([]));
    const client = new ApifyClient('token', request as typeof fetch, 2, { store: repository,
      expectedCostUsdPerRun: 1 });
    // Two runs on one scan: under the old per-scan cap of 1 USD the second was refused.
    const first = await client.run('owner/actor', { name: 'Jane' }, new AbortController().signal, { scanId: 'sc_budget' });
    const second = await client.run('owner/actor', { name: 'John' }, new AbortController().signal, { scanId: 'sc_budget' });
    expect(first.metadata.chargedToScan).toBe(true);
    expect(second.metadata.chargedToScan).toBe(true);
    // Both are distinct ledger entries: the spend is recorded, it is simply not refused.
    expect(second.metadata.ledgerId).not.toBe(first.metadata.ledgerId);
    for (const entry of [first, second]) {
      await expect(repository.getApifyRun(entry.metadata.ledgerId!))
        .resolves.toMatchObject({ reserved_usd: 1 });
    }
  });
  it('does not repeat a failed paid run during its retry cooldown', async () => {
    const repository = new InMemoryRepository();
    const request = vi.fn(async () => Response.json({ data: {
      id: 'failed-run', status: 'FAILED', defaultDatasetId: null, usageTotalUsd: .3, statusMessage: 'blocked' } }));
    const client = new ApifyClient('token', request as typeof fetch, 2, { store: repository });
    await expect(client.run('owner/actor', { name: 'Jane' }, new AbortController().signal)).rejects.toThrow('FAILED');
    await expect(client.run('owner/actor', { name: 'Jane' }, new AbortController().signal)).rejects.toThrow('cooldown');
    expect(request.mock.calls.filter(call => String(call[0]).includes('/runs?'))).toHaveLength(1);
  });
});
describe('Apify usage limit', () => {
  const QUOTA = "Actor aborted. You've reached the maximum usage for your current billing cycle.";
  const started = (calls: unknown[][]) => calls.filter(call => String(call[0]).includes('/runs?')).length;

  it('does not cache a run the usage limit cut short, and says why', async () => {
    const repository = new InMemoryRepository();
    const request = vi.fn(async (url: string | URL | Request) => String(url).includes('/runs?')
      ? Response.json({ data: { id: 'run', status: 'ABORTED', defaultDatasetId: 'dataset', usageTotalUsd: .05, statusMessage: QUOTA } })
      : Response.json([{ name: 'Jane Smith' }]));
    const client = new ApifyClient('token', request as typeof fetch, 2, { store: repository });
    const error = await client.run('owner/actor', { name: 'Jane' }, new AbortController().signal).catch(caught => caught);
    expect(error).toBeInstanceOf(ApifyClientError);
    expect(error).toMatchObject({ code: 'PROVIDER_QUOTA_EXCEEDED' });
    // The cut is not a property of the query: the rows must not be reused as partial evidence for a week.
    const [row] = [...repository.apifyRuns.values()];
    expect(row).toMatchObject({ status: 'QUOTA_EXCEEDED', partial: false, cost_usd: .05 });
    expect(Date.parse(row!.expires_at)).toBeLessThanOrEqual(Date.now());
  });

  it('treats a start refused for usage as the limit, not as an uncertain start', async () => {
    const repository = new InMemoryRepository();
    const request = vi.fn(async () => Response.json({ error: { type: 'not-enough-usage-to-run-paid-actor',
      message: 'You have reached your monthly usage hard limit.' } }, { status: 402 }));
    const client = new ApifyClient('token', request as typeof fetch, 2, { store: repository });
    await expect(client.run('owner/actor', { name: 'Jane' }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'PROVIDER_QUOTA_EXCEEDED' });
    expect([...repository.apifyRuns.values()][0]).toMatchObject({ status: 'QUOTA_EXCEEDED' });
  });

  it('starts no run while the limit holds, still serves cached queries, and tries again afterwards', async () => {
    const repository = new InMemoryRepository();
    let clock = 1_000_000;
    let limited = false;
    const request = vi.fn(async (url: string | URL | Request) => {
      if (!String(url).includes('/runs?')) return Response.json([{ name: 'Jane Smith' }]);
      return limited
        ? Response.json({ data: { id: `run${clock}`, status: 'ABORTED', defaultDatasetId: 'dataset', statusMessage: QUOTA } })
        : Response.json({ data: { id: `run${clock}`, status: 'SUCCEEDED', defaultDatasetId: 'dataset', usageTotalUsd: .1 } });
    });
    const client = new ApifyClient('token', request as typeof fetch, 2, { store: repository,
      quotaCooldownMs: 300_000, now: () => clock });
    const signal = new AbortController().signal;
    await client.run('owner/actor', { name: 'Cached' }, signal);
    limited = true;
    await expect(client.run('owner/actor', { name: 'First' }, signal)).rejects.toMatchObject({ code: 'PROVIDER_QUOTA_EXCEEDED' });
    const before = started(request.mock.calls);
    await expect(client.run('owner/actor', { name: 'Second' }, signal)).rejects.toMatchObject({ code: 'PROVIDER_QUOTA_EXCEEDED' });
    expect(started(request.mock.calls)).toBe(before);
    await expect(client.run('owner/actor', { name: 'Cached' }, signal)).resolves.toMatchObject({ metadata: { cached: true } });
    // Once the limit is raised, the next run after the cooldown goes through.
    limited = false; clock += 300_001;
    await expect(client.run('owner/actor', { name: 'Second' }, signal)).resolves.toMatchObject({ metadata: { status: 'SUCCEEDED' } });
  });

  it('stops a directory search at the limit and reports a provider error with the reason', async () => {
    const run = vi.fn(async (_actor: string, input: Record<string, unknown>) => {
      if ((input.lastNames as string[])[0] === 'Smithb') throw new ApifyClientError('PROVIDER_QUOTA_EXCEEDED', QUOTA);
      return [{ name: `Jane ${(input.lastNames as string[])[0]}`, status: 'Member in Good Standing' }];
    });
    const names = Array.from({ length: 14 }, (_, index) => `Jane Smith${String.fromCharCode(97 + index)}`);
    const result = await new ApifyDirectorySource('bar', { run }).run({ ...query, names }, new AbortController().signal);
    // Up to eight lookups in flight: the limit stops the queue, not the lookups already started.
    expect(run.mock.calls.length).toBeLessThan(names.length);
    expect(result.status).toMatchObject({ status: 'partial', code: 'PROVIDER_ERROR' });
    expect(result.status.reason).toMatch(/usage limit/i);
  });

  it('reports a lookup that threw as a provider error, not a contract error', async () => {
    const run = vi.fn(async (_actor: string, input: Record<string, unknown>) => {
      if ((input.lastNames as string[])[0] === 'Smithb') throw new ApifyClientError('PROVIDER_ERROR', 'Apify run unavailable');
      return [{ name: `Jane ${(input.lastNames as string[])[0]}`, status: 'Member in Good Standing' }];
    });
    const result = await new ApifyDirectorySource('bar', { run }).run({ ...query, names: ['Jane Smitha', 'Jane Smithb'] },
      new AbortController().signal);
    expect(result.status).toMatchObject({ status: 'partial', code: 'PROVIDER_ERROR' });
  });
});
describe('Apify spend ceiling', () => {
  // DN-12 §5.1. Every client here is built over a stub transport: nothing reaches Apify.
  const signal = () => new AbortController().signal;
  const started = (calls: unknown[][]) => calls.filter(call => String(call[0]).includes('/runs?'));
  /** An Apify that starts every run and answers one row. `usd` is what each run reports when it ends. */
  const apify = (usd: number | undefined = undefined) => {
    let runs = 0;
    return vi.fn(async (url: string | URL | Request, _init?: RequestInit) => String(url).includes('/runs?')
      ? Response.json({ data: { id: `run-${++runs}`, status: 'SUCCEEDED', defaultDatasetId: `dataset-${runs}`, usageTotalUsd: usd } })
      : Response.json([{ name: 'Jane Smith' }]));
  };
  const capped = (repository: InMemoryRepository, request: ReturnType<typeof apify>, spendCeilingUsd: number | null = 2) =>
    new ApifyClient('token', request as typeof fetch, 16, { store: repository, expectedCostUsdPerRun: 1, spendCeilingUsd });
  const rows = (repository: InMemoryRepository) => [...repository.apifyRuns.values()];

  it('refuses a run the ceiling has no room for before any request is sent, and says so once', async () => {
    const repository = new InMemoryRepository(), request = apify(), log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const client = capped(repository, request);
      await client.run('owner/actor', { name: 'One' }, signal());
      await client.run('owner/actor', { name: 'Two' }, signal());
      const sent = request.mock.calls.length;
      // Two unsettled runs hold their USD 1 reservation each: the third would pass USD 2.
      for (const name of ['Three', 'Four']) {
        const error = await client.run('owner/actor', { name }, signal()).catch(caught => caught);
        expect(error).toBeInstanceOf(ApifyClientError);
        expect(error).toMatchObject({ code: 'SPEND_CEILING_REACHED', message: 'Apify spend ceiling reached' });
      }
      expect(request.mock.calls).toHaveLength(sent);
      expect(started(request.mock.calls)).toHaveLength(2);
      // The refusal is not a property of the query: its ledger row is neither reused nor held in a retry cooldown.
      const refused = rows(repository).filter(row => row.status === 'SPEND_CEILING_REACHED');
      expect(refused).toHaveLength(2);
      for (const row of refused) {
        expect(row).toMatchObject({ run_id: null, last_error: 'Apify spend ceiling reached' });
        expect(Date.parse(row.expires_at)).toBeLessThanOrEqual(Date.now());
      }
      const lines = log.mock.calls.map(call => String(call[0])).filter(line => line.startsWith('[apify] Apify spend ceiling reached'));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('USD 2.00 held by the ledger over the last 24 hours, the ceiling is USD 2.00 and a run reserves USD 1.00');
      expect(lines[0]).toContain('APIFY_SPEND_CEILING_USD');
      expect(lines[0]).not.toContain('token');
    } finally { log.mockRestore(); }
  });

  it('admits exactly what fits when many runs start together', async () => {
    const repository = new InMemoryRepository(), request = apify(), log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const client = capped(repository, request);
      const outcomes = await Promise.allSettled(['A', 'B', 'C', 'D', 'E', 'F']
        .map(name => client.run('owner/actor', { name }, signal())));
      expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(2);
      expect(outcomes.filter(outcome => outcome.status === 'rejected'
        && (outcome.reason as ApifyClientError).code === 'SPEND_CEILING_REACHED')).toHaveLength(4);
      expect(started(request.mock.calls)).toHaveLength(2);
    } finally { log.mockRestore(); }
  });

  it('serves cached queries at the ceiling, and a cached run costs the ceiling nothing new', async () => {
    const repository = new InMemoryRepository(), request = apify(), log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const client = capped(repository, request);
      await client.run('owner/actor', { name: 'One' }, signal());
      // Served from the query cache any number of times: the ledger holds one row for it, counted once.
      for (let again = 0; again < 5; again++) {
        await expect(client.run('owner/actor', { name: 'One' }, signal())).resolves.toMatchObject({ metadata: { cached: true } });
      }
      await client.run('owner/actor', { name: 'Two' }, signal());
      await expect(client.run('owner/actor', { name: 'Three' }, signal())).rejects.toMatchObject({ code: 'SPEND_CEILING_REACHED' });
      await expect(client.run('owner/actor', { name: 'Two' }, signal())).resolves.toMatchObject({ metadata: { cached: true } });
      expect(started(request.mock.calls)).toHaveLength(2);
    } finally { log.mockRestore(); }
  });

  it('holds the whole reservation until the charges settle, then counts what Apify charged', async () => {
    const repository = new InMemoryRepository(), log = vi.spyOn(console, 'error').mockImplementation(() => {});
    // At its end a run reads USD 0, as the Florida Bar actor does. The charge is booked later.
    let settled = false;
    const request = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      const value = String(url);
      if (value.includes('/runs?')) return Response.json({ data: { id: `run-${started(request.mock.calls).length}`, status: 'SUCCEEDED',
        defaultDatasetId: 'dataset', usageTotalUsd: 0 } });
      if (value.includes('/actor-runs/')) return Response.json({ data: { id: value.split('/actor-runs/')[1], status: 'SUCCEEDED',
        usageTotalUsd: settled ? .045 : 0, finishedAt: new Date(Date.now() - 180_000).toISOString() } });
      return Response.json([{ name: 'Jane Smith' }]);
    });
    try {
      const client = capped(repository, request as ReturnType<typeof apify>);
      await client.run('owner/actor', { name: 'One' }, signal());
      await client.run('owner/actor', { name: 'Two' }, signal());
      await expect(client.run('owner/actor', { name: 'Three' }, signal())).rejects.toMatchObject({ code: 'SPEND_CEILING_REACHED' });
      settled = true;
      expect(await client.reconcileCosts()).toBe(2);
      // USD 0.09 is spent, so a third run fits. It may charge its reservation, not all the USD 1.91 left.
      await expect(client.run('owner/actor', { name: 'Three' }, signal())).resolves.toMatchObject({ metadata: { status: 'SUCCEEDED' } });
      expect(new URL(String(started(request.mock.calls).at(-1)![0])).searchParams.get('maxTotalChargeUsd')).toBe('1');
    } finally { log.mockRestore(); }
  });

  it('counts what the ledger recorded for other processes over the last 24 hours, and nothing older', async () => {
    const repository = new InMemoryRepository(), request = apify(), log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // A run this client never started: an earlier process, or production on the same ledger. Settled at USD 1.50.
      const other = await repository.reserveApifyRun({ queryFingerprint: 'd'.repeat(64), actor: 'owner/actor', build: 'latest',
        input: { name: 'Elsewhere' }, expectedCostUsd: 1, expiresAt: new Date(Date.now() + 600_000).toISOString() });
      await repository.updateApifyRun(other.record!.id, { run_id: 'run-elsewhere', status: 'SUCCEEDED', cost_usd: 1.5, accounting_complete: true });
      const client = capped(repository, request);
      await expect(client.run('owner/actor', { name: 'One' }, signal())).rejects.toMatchObject({ code: 'SPEND_CEILING_REACHED' });
      expect(request).not.toHaveBeenCalled();
      // The same row a day and a minute old is outside the window.
      repository.apifyRuns.get(other.record!.id)!.created_at = new Date(Date.now() - 86_460_000).toISOString();
      await expect(client.run('owner/actor', { name: 'One' }, signal())).resolves.toMatchObject({ metadata: { status: 'SUCCEEDED' } });
    } finally { log.mockRestore(); }
  });

  it('counts a run the way its ledger row stands', () => {
    const now = Date.parse('2026-11-09T12:00:00.000Z');
    const row = { id: 'row', run_id: 'run' as string | null, status: 'SUCCEEDED', cost_usd: null as number | null, reserved_usd: 1,
      accounting_complete: false, created_at: '2026-11-09T11:00:00.000Z', expires_at: '2026-11-09T11:15:00.000Z' };
    // Settled: what Apify charged, even when that is more than the reservation.
    expect(committedUsd({ ...row, cost_usd: .045, accounting_complete: true }, now)).toBe(.045);
    expect(committedUsd({ ...row, cost_usd: 1.8, accounting_complete: true }, now)).toBe(1.8);
    // Started and not settled: the reservation, or the figure already read when that is higher.
    expect(committedUsd({ ...row, status: 'RUNNING' }, now)).toBe(1);
    expect(committedUsd({ ...row, cost_usd: 0 }, now)).toBe(1);
    expect(committedUsd({ ...row, cost_usd: 1.4 }, now)).toBe(1.4);
    // Never started: counted only while it still may start.
    expect(committedUsd({ ...row, run_id: null, status: 'RESERVED', expires_at: '2026-11-09T12:10:00.000Z' }, now)).toBe(1);
    expect(committedUsd({ ...row, run_id: null, status: 'RESERVED' }, now)).toBe(0);
    expect(committedUsd({ ...row, run_id: null, status: 'SPEND_CEILING_REACHED', expires_at: '2026-11-09T12:10:00.000Z' }, now)).toBe(0);
    expect(committedUsd({ ...row, run_id: null, status: 'QUOTA_EXCEEDED', expires_at: '2026-11-09T12:10:00.000Z' }, now)).toBe(0);
    // A lost start answer: maybe a run, for the whole window, expired or not.
    expect(committedUsd({ ...row, run_id: null, status: 'START_UNCERTAIN' }, now)).toBe(1);
  });

  it('starts no run at all with a ceiling of 0, and still serves what is cached', async () => {
    const repository = new InMemoryRepository(), request = apify(), log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await capped(repository, request, null).run('owner/actor', { name: 'One' }, signal());
      const client = capped(repository, request, 0);
      await expect(client.run('owner/actor', { name: 'One' }, signal())).resolves.toMatchObject({ metadata: { cached: true } });
      await expect(client.run('owner/actor', { name: 'Two' }, signal())).rejects.toMatchObject({ code: 'SPEND_CEILING_REACHED' });
      expect(started(request.mock.calls)).toHaveLength(1);
    } finally { log.mockRestore(); }
  });

  it('refuses the start when the recorded spend cannot be read', async () => {
    const repository = new InMemoryRepository(), request = apify();
    vi.spyOn(repository, 'recentApifyRuns').mockRejectedValue(new Error('statement timeout'));
    const error = await capped(repository, request).run('owner/actor', { name: 'One' }, signal()).catch(caught => caught);
    expect(error).toMatchObject({ code: 'PROVIDER_ERROR', message: 'Recorded Apify spend unavailable; run not started' });
    expect(request).not.toHaveBeenCalled();
    // Nothing was started, so the query is free to run as soon as the ledger answers again.
    expect(Date.parse(rows(repository)[0]!.expires_at)).toBeLessThanOrEqual(Date.now());
  });

  it('without a ceiling reads no spend, refuses nothing and sends no charge limit', async () => {
    const repository = new InMemoryRepository(), request = apify();
    const recent = vi.spyOn(repository, 'recentApifyRuns');
    const client = capped(repository, request, null);
    for (const name of ['One', 'Two', 'Three', 'Four']) await client.run('owner/actor', { name }, signal());
    expect(recent).not.toHaveBeenCalled();
    const urls = started(request.mock.calls).map(call => new URL(String(call[0])));
    expect(urls).toHaveLength(4);
    for (const url of urls) {
      expect([...url.searchParams.keys()].sort()).toEqual(['build', 'timeout', 'waitForFinish']);
    }
    // The default client is the uncapped one: production builds it without the option.
    const plain = new ApifyClient('token', request as typeof fetch, 2, { store: repository });
    await plain.run('owner/actor', { name: 'Five' }, signal());
    expect(new URL(String(started(request.mock.calls).at(-1)![0])).searchParams.has('maxTotalChargeUsd')).toBe(false);
  });

  it('sends the reservation as the charge limit without touching the query or its fingerprint', async () => {
    const repository = new InMemoryRepository(), request = apify();
    const input = { firm: 'Smith Law', maxLawyers: 1_000_000 };
    const uncapped = await capped(repository, request, null).run('owner/actor', input, signal());
    const client = capped(repository, request);
    // A query paid for before the ceiling existed is still the same query: it is served from the cache.
    const reused = await client.run('owner/actor', input, signal());
    expect(reused.metadata).toMatchObject({ cached: true, queryFingerprint: uncapped.metadata.queryFingerprint });
    expect(started(request.mock.calls)).toHaveLength(1);
    // A new one starts with the limit in the URL and the input as it was built.
    const other = { firm: 'Doe Law', maxLawyers: 1_000_000 };
    await client.run('owner/actor', other, signal());
    const [url, init] = started(request.mock.calls).at(-1)! as [string, RequestInit];
    expect(new URL(url).searchParams.get('maxTotalChargeUsd')).toBe('1');
    expect(JSON.parse(String(init.body))).toEqual(other);
    expect(rows(repository).at(-1)).toMatchObject({ input_json: other });
    const plain = await capped(new InMemoryRepository(), apify(), null).run('owner/actor', other, signal());
    expect(rows(repository).at(-1)!.query_fingerprint).toBe(plain.metadata.queryFingerprint);
  });

  it('covers the firm-wide Bar search: the input still asks for every lawyer and the run may charge only its reservation', async () => {
    const repository = new InMemoryRepository(), request = apify();
    const source = new ApifyDirectorySource('bar', capped(repository, request));
    await source.run({ ...query, names: [] }, signal());
    const [url, init] = started(request.mock.calls)[0]! as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({ firm: 'Smith Law', maxLawyers: BAR_TECHNICAL_MAX_LAWYERS, lastNames: [] });
    // Alone under a ceiling of USD 2, and still limited to the USD 1 it reserved.
    expect(new URL(url).searchParams.get('maxTotalChargeUsd')).toBe('1');
  });

  it('never hands runs admitted together more charge limit than the ceiling', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (const [ceiling, reserve] of [[2, 1], [5, .5], [20, 1], [2, .3]] as const) {
        const repository = new InMemoryRepository(), request = apify(0);
        const client = new ApifyClient('token', request as typeof fetch, 32,
          { store: repository, expectedCostUsdPerRun: reserve, spendCeilingUsd: ceiling });
        // Thirty firm-wide searches at once, none settled: each could charge up to its limit.
        await Promise.allSettled(Array.from({ length: 30 }, (_, index) =>
          client.run('owner/actor', { firm: `Firm ${index}`, maxLawyers: BAR_TECHNICAL_MAX_LAWYERS }, signal())));
        const limits = started(request.mock.calls).map(call => Number(new URL(String(call[0])).searchParams.get('maxTotalChargeUsd')));
        expect(limits).toHaveLength(Math.floor(ceiling / reserve + 1e-9));
        expect(limits.every(limit => limit === reserve)).toBe(true);
        expect(limits.reduce((total, limit) => total + limit, 0)).toBeLessThanOrEqual(ceiling + 1e-9);
      }
    } finally { log.mockRestore(); }
  });

  it('keeps counting a start whose answer was lost, and not one Apify refused', async () => {
    const repository = new InMemoryRepository(), log = vi.spyOn(console, 'error').mockImplementation(() => {});
    let clock = Date.now(), answer: 'lost' | 'refused' | 'ok' = 'lost';
    const request = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      if (!String(url).includes('/runs?')) return Response.json([{ name: 'Jane Smith' }]);
      if (answer === 'lost') throw new TypeError('fetch failed');
      if (answer === 'refused') return new Response('actor not found', { status: 404 });
      return Response.json({ data: { id: `run-${started(request.mock.calls).length}`, status: 'SUCCEEDED', defaultDatasetId: 'dataset' } });
    });
    try {
      const client = new ApifyClient('token', request as typeof fetch, 16,
        { store: repository, expectedCostUsdPerRun: 1, spendCeilingUsd: 2, now: () => clock });
      await expect(client.run('owner/actor', { name: 'Lost' }, signal())).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
      answer = 'refused';
      await expect(client.run('owner/actor', { name: 'Refused' }, signal())).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
      expect(rows(repository).map(row => row.status)).toEqual(['START_UNCERTAIN', 'UNAVAILABLE']);
      // A scan that comes to resume the lost start leaves it uncertain.
      await expect(client.run('owner/actor', { name: 'Lost' }, signal())).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
      expect(rows(repository)[0]).toMatchObject({ status: 'START_UNCERTAIN', last_error: 'Actor start response unavailable: fetch failed' });
      // Long after its reservation expired the lost start may still have been a run: it holds USD 1 of the USD 2.
      clock += 3_600_000;
      answer = 'ok';
      await client.run('owner/actor', { name: 'One' }, signal());
      await expect(client.run('owner/actor', { name: 'Two' }, signal())).rejects.toMatchObject({ code: 'SPEND_CEILING_REACHED' });
    } finally { log.mockRestore(); }
  });

  it('leaves refused starts out of the rows it adds up, so refusals cannot fill the window', async () => {
    const repository = new InMemoryRepository(), request = apify(), log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const full = capped(repository, request, 0);
      for (let index = 0; index < 1000; index++) {
        await expect(full.run('owner/actor', { name: `Refused ${index}` }, signal())).rejects.toMatchObject({ code: 'SPEND_CEILING_REACHED' });
      }
      expect(rows(repository)).toHaveLength(1000);
      // Raising the ceiling is enough: the thousand refusals in the window do not count as a thousand runs.
      await expect(capped(repository, request, 2).run('owner/actor', { name: 'One' }, signal()))
        .resolves.toMatchObject({ metadata: { status: 'SUCCEEDED' } });
      expect(started(request.mock.calls)).toHaveLength(1);
    } finally { log.mockRestore(); }
  });

  it('does not cache a run that spent its whole charge limit, and keeps its rows as partial evidence', async () => {
    const repository = new InMemoryRepository(), log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const client = capped(repository, apify(2));
      const output = await client.run('owner/actor', { firm: 'Smith Law' }, signal());
      expect(output.items).toEqual([{ name: 'Jane Smith' }]);
      expect(output.metadata).toMatchObject({ status: 'SUCCEEDED', partial: true, costUsd: 2 });
      const [row] = rows(repository);
      expect(row).toMatchObject({ partial: true, last_error: 'Charge limit reached; the dataset may be incomplete' });
      expect(Date.parse(row!.expires_at)).toBeLessThanOrEqual(Date.now());
      expect(log.mock.calls.map(call => String(call[0])).some(line => line.includes('reached its charge limit of USD 1'))).toBe(true);
    } finally { log.mockRestore(); }
  });

  it('stops reusing a run whose settled cost shows it spent its whole charge limit', async () => {
    const repository = new InMemoryRepository(), log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const request = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      const value = String(url);
      if (value.includes('/runs?')) return Response.json({ data: { id: 'run-1', status: 'SUCCEEDED', defaultDatasetId: 'dataset', usageTotalUsd: 0 } });
      if (value.includes('/actor-runs/')) return Response.json({ data: { id: 'run-1', status: 'SUCCEEDED', usageTotalUsd: 2,
        finishedAt: new Date(Date.now() - 180_000).toISOString() } });
      return Response.json([{ name: 'Jane Smith' }]);
    });
    try {
      const client = capped(repository, request as ReturnType<typeof apify>);
      const output = await client.run('owner/actor', { firm: 'Smith Law' }, signal());
      // Read at the end of the run the cost was 0, so nothing showed yet.
      expect(output.metadata.partial).toBe(false);
      expect(Date.parse(rows(repository)[0]!.expires_at)).toBeGreaterThan(Date.now());
      await client.reconcileCosts();
      expect(rows(repository)[0]).toMatchObject({ cost_usd: 2, accounting_complete: true, partial: true,
        last_error: 'Charge limit reached; the dataset may be incomplete' });
      expect(Date.parse(rows(repository)[0]!.expires_at)).toBeLessThanOrEqual(Date.now());
    } finally { log.mockRestore(); }
  });

  it('reports refused lookups as a passing provider error, and still answers the ones already cached', async () => {
    const run = vi.fn(async (_actor: string, input: Record<string, unknown>) => {
      const surname = (input.lastNames as string[])[0]!;
      if (surname > 'Smithb') throw new ApifyClientError('SPEND_CEILING_REACHED', 'Apify spend ceiling reached');
      return [{ name: `Jane ${surname}`, status: 'Member in Good Standing' }];
    });
    const names = Array.from({ length: 14 }, (_, index) => `Jane Smith${String.fromCharCode(97 + index)}`);
    const result = await new ApifyDirectorySource('bar', { run }).run({ ...query, names }, signal());
    // Unlike the usage limit, the ceiling does not stop the queue: every lookup is asked, and a cached one is free.
    expect(run).toHaveBeenCalledTimes(names.length);
    expect(result.status).toMatchObject({ status: 'partial', code: 'PROVIDER_ERROR',
      reason: 'Apify spend ceiling reached; lookups it had no room for were not started', attorneysFound: 2 });
    expect(JSON.parse(result.rawContent!).queries.filter((item: { error: string | null }) => item.error === 'spend_ceiling_reached')).toHaveLength(12);
    // A passing cause: the scan cache repairs this result instead of keeping it as the firm's answer.
    expect(directoryDegradation(result.status)).toBe('TRANSIENT');
    // With every lookup refused the source has nothing, and says the same.
    const nothing = await new ApifyDirectorySource('avvo', { run: async () => { throw new ApifyClientError('SPEND_CEILING_REACHED', 'Apify spend ceiling reached'); } })
      .run(query, signal());
    expect(nothing.status).toMatchObject({ status: 'error', code: 'PROVIDER_ERROR', reason: expect.stringMatching(/spend ceiling/) });
    expect(nothing.data).toBeNull();
    expect(directoryDegradation(nothing.status)).toBe('TRANSIENT');
  });
});
describe('Apify cost reconciliation', () => {
  const finished = (secondsAgo: number) => new Date(Date.now() - secondsAgo * 1000).toISOString();
  const seed = async (repository: InMemoryRepository) => {
    const reservation = await repository.reserveApifyRun({ queryFingerprint: 'b'.repeat(64), actor: 'owner/actor',
      build: 'latest', input: { name: 'Jane' }, expectedCostUsd: 1, expiresAt: finished(-600) });
    await repository.updateApifyRun(reservation.record!.id, { run_id: 'run-1', status: 'SUCCEEDED', cost_usd: 0,
      accounting_complete: false });
    return reservation.record!.id;
  };

  it('books what Apify finally charged once the run has settled', async () => {
    const repository = new InMemoryRepository();
    const id = await seed(repository);
    const request = vi.fn(async () => Response.json({ data: { id: 'run-1', status: 'SUCCEEDED', usageTotalUsd: .4275,
      finishedAt: finished(180) } }));
    const settled = await new ApifyClient('token', request as typeof fetch, 2, { store: repository }).reconcileCosts();
    expect(settled).toBe(1);
    await expect(repository.getApifyRun(id)).resolves.toMatchObject({ cost_usd: .4275, accounting_complete: true });
  });

  it('leaves a run that finished moments ago for the next pass', async () => {
    const repository = new InMemoryRepository();
    const id = await seed(repository);
    const request = vi.fn(async () => Response.json({ data: { id: 'run-1', status: 'SUCCEEDED', usageTotalUsd: .02,
      finishedAt: finished(10) } }));
    await new ApifyClient('token', request as typeof fetch, 2, { store: repository }).reconcileCosts();
    await expect(repository.getApifyRun(id)).resolves.toMatchObject({ cost_usd: 0, accounting_complete: false });
  });

  it('never asks Apify about runs already settled or never started', async () => {
    const repository = new InMemoryRepository();
    const id = await seed(repository);
    await repository.updateApifyRun(id, { accounting_complete: true });
    await repository.reserveApifyRun({ queryFingerprint: 'c'.repeat(64), actor: 'owner/actor', build: 'latest',
      input: {}, expectedCostUsd: 1, expiresAt: finished(-600) });
    const request = vi.fn();
    await new ApifyClient('token', request as typeof fetch, 2, { store: repository }).reconcileCosts();
    expect(request).not.toHaveBeenCalled();
  });
});
describe('website extraction', () => {
  const pages = [{ url: 'https://firm.com/', html: '<body>Firm</body>', text: 'Firm' }];
  it('retains raw website evidence when model analysis fails', async () => {
    const parse = vi.fn(async () => { throw new Error('unavailable'); });
    const source = new RagWebsiteSource('test', new InMemoryRepository(), async () => ({ pages, partial: true }), { chat: { completions: { parse } } } as unknown as OpenAI);
    const result = await source.run('firm.com', new AbortController().signal);
    expect(result.data).toBeNull();
    expect(result.status.status).toBe('error');
    expect(JSON.parse(result.rawContent!).pages).toEqual(pages);
  });
  it('extracts conservative structured evidence without OpenAI', async () => {
    const provider = new RuleBasedEvidenceProvider();
    const result = await provider.extract({ partial: false, pages: [{ url: 'https://firm.com/privacy',
      html: '<meta property="og:site_name" content="Smith Law">',
      text: 'Smith Law, established 2001. We use Harvey and AI with human review. Our privacy policy protects client data. Corporate law.' }] },
    new AbortController().signal);
    expect(result).toMatchObject({
      ai_in_services: { found: true, tools_mentioned: ['Harvey'] },
      ai_disclosure: { found: true }, privacy_policy: { found: true, mentions_client_data: true },
      practice_areas: ['corporate'], firm_established_year: 2001, firm_name: 'Smith Law',
    });
    expect(result.team_members).toBeNull();
  });
  it('extracts firm identity and attorneys only from structured website evidence', async () => {
    const provider = new RuleBasedEvidenceProvider();
    const jsonLd = JSON.stringify({ '@graph': [
      { '@type': 'LegalService', name: 'Smith & Doe Law', alternateName: ['Smith Law'], telephone: '305-555-0100',
        address: { '@type': 'PostalAddress', streetAddress: '100 Main St', addressLocality: 'Miami' } },
      { '@type': 'Person', name: 'Jane Smith', jobTitle: 'Partner' },
      { '@type': 'Person', name: 'Alex Doe', jobTitle: 'Office Manager' },
    ] });
    const result = await provider.extract({ partial: false, pages: [{ url: 'https://firm.com/team',
      html: `<script type="application/ld+json">${jsonLd}</script>`, text: 'Our team' }] }, new AbortController().signal);
    expect(result).toMatchObject({ firm_name: 'Smith & Doe Law', firm_aliases: ['Smith Law'], city: 'Miami',
      address_street: '100 Main St', phone: '305-555-0100', team_members: [{ full_name: 'Jane Smith', title: 'Partner' }] });
    expect(result.provenance.firm_name?.[0]).toMatchObject({ sourceUrl: 'https://firm.com/team', method: 'json_ld' });
  });
  it('reports access blocking explicitly when no page can be read', async () => {
    const provider = { id: 'fixture', version: '1', extract: vi.fn() };
    const source = new WebsiteExtractionSource(new InMemoryRepository(), provider,
      async () => ({ pages: [], partial: true, issues: [{ url: 'https://firm.com/', code: 'ACCESS_BLOCKED', status: 403 }] }));
    const result = await source.run('firm.com', new AbortController().signal);
    expect(result.status).toMatchObject({ status: 'error', code: 'ACCESS_BLOCKED', pagesCrawled: 0 });
    expect(provider.extract).not.toHaveBeenCalled();
  });
  it('says why no page was read, with a code that tells the site\'s answer from a passing failure', async () => {
    const provider = { id: 'fixture', version: '1', extract: vi.fn() };
    const run = (crawl: CrawlResult) => new WebsiteExtractionSource(new InMemoryRepository(), provider, async () => crawl)
      .run('firm.com', new AbortController().signal);
    const home = 'https://firm.com/';
    const disallowed = await run({ pages: [], partial: false, issues: [{ url: home, code: 'ROBOTS_DISALLOWED', status: null, scope: 'page' }] });
    expect(disallowed.status).toMatchObject({ status: 'error', dataStatus: 'UNKNOWN', code: 'ACCESS_BLOCKED', pagesCrawled: 0,
      reason: 'robots.txt does not allow automated reading of the website' });
    expect(JSON.parse(disallowed.rawContent!)).toMatchObject({ unreadable: 'DEFINITIVE', analysis: null });
    // Each of these used to read "NO_READABLE_EVIDENCE: No readable website evidence", like a site with nothing on it.
    const unreachable = await run({ pages: [], partial: true, issues: [
      { url: 'https://firm.com/robots.txt', code: 'ROBOTS_UNAVAILABLE', status: 503, scope: 'robots' },
      { url: home, code: 'ROBOTS_UNAVAILABLE', status: 503, scope: 'page' }] });
    expect(unreachable.status).toMatchObject({ status: 'error', code: 'PROVIDER_ERROR',
      reason: 'robots.txt could not be retrieved (HTTP 503), so the website was not read' });
    expect(JSON.parse(unreachable.rawContent!).unreadable).toBe('TRANSIENT');
    const deadline = await run({ pages: [], partial: true, aborted: true,
      issues: [{ url: home, code: 'REQUEST_FAILED', status: null, scope: 'page' }] });
    expect(deadline.status).toMatchObject({ status: 'timeout', code: 'DEADLINE_REACHED' });
    const rateLimited = await run({ pages: [], partial: true, issues: [{ url: home, code: 'ACCESS_BLOCKED', status: 429, scope: 'page' }] });
    expect(rateLimited.status).toMatchObject({ status: 'error', code: 'PROVIDER_ERROR', reason: 'The website is rate limiting requests (HTTP 429)' });
    expect(provider.extract).not.toHaveBeenCalled();
  });
  it('keeps a fully read site ok and notes what the crawl left out by rule', async () => {
    const pages = [{ url: 'https://firm.com/', html: '<body>Firm</body>', text: 'Firm' }];
    const provider = { id: 'fixture', version: '1', extract: vi.fn(async () => unknownWebsite()) };
    const run = (crawl: CrawlResult) => new WebsiteExtractionSource(new InMemoryRepository(), provider, async () => crawl)
      .run('firm.com', new AbortController().signal);
    const decided = await run({ pages, partial: false, issues: [
      { url: 'https://firm.com/wp-admin/', code: 'ROBOTS_DISALLOWED', status: null, scope: 'page' },
      { url: 'https://firm.com/old', code: 'HTTP_ERROR', status: 404, scope: 'page' },
      { url: 'https://widgets.example/w.js', code: 'REQUEST_FAILED', status: null, scope: 'request' }] });
    expect(decided.status).toMatchObject({ status: 'ok', pagesCrawled: 1,
      reason: '1 page excluded by robots.txt; 1 dead link (HTTP 404/410)' });
    expect((await run({ pages, partial: false })).status).toMatchObject({ status: 'ok', reason: null });
    const failed = await run({ pages, partial: true, issues: [{ url: 'https://firm.com/team', code: 'HTTP_ERROR', status: 500, scope: 'page' }] });
    expect(failed.status).toMatchObject({ status: 'partial', reason: '1 page could not be read' });
  });
  it('gives the crawl and the extraction of one scan the same robots cache, and the next scan a new one', async () => {
    const pages = [{ url: 'https://firm.com/', html: '<body>Firm</body>', text: 'Firm' }];
    const crawl = vi.fn(async (_domain: string, _signal: AbortSignal, _robots: unknown): Promise<CrawlResult> => ({ pages, partial: false }));
    const extractDetailed = vi.fn(async (_crawl: CrawlResult, _signal: AbortSignal, _context: { robots: unknown }) =>
      ({ websiteData: unknownWebsite(), diagnostics: null }));
    const provider = { id: 'fixture', version: '1', extract: vi.fn(), extractDetailed };
    // A repository that remembers nothing, so the second scan cannot reuse the first analysis.
    const source = new WebsiteExtractionSource(new InMemoryRepository(), provider, crawl);
    await source.run('firm.com', new AbortController().signal);
    await source.run('firm.com', new AbortController().signal);
    const [first, second] = crawl.mock.calls.map(call => call[2]);
    expect(first).toBeInstanceOf(Map);
    expect(extractDetailed.mock.calls[0]![2].robots).toBe(first);
    expect(extractDetailed.mock.calls[1]![2].robots).toBe(second);
    expect(second).not.toBe(first);
  });
  it('keeps why the extraction failed in the stored evidence', async () => {
    // A failed extraction takes the whole scan down: without website data the identity is
    // insufficient, the directories are skipped and the scan ends FAILED. Discarding the
    // provider's error left no way to tell a token limit from a timeout after the fact.
    const provider = { id: 'fixture', version: '1',
      extract: vi.fn(async () => { throw new Error('Model call exceeded the per-call token limit'); }) };
    const source = new WebsiteExtractionSource(new InMemoryRepository(), provider,
      async () => ({ pages: [{ url: 'https://firm.com/', html: '<html></html>', text: 'Firm' }], partial: false }));
    const result = await source.run('firm.com', new AbortController().signal);

    expect(result.data).toBeNull();
    expect(result.status).toMatchObject({ status: 'error', code: 'PROVIDER_ERROR' });
    const stored = JSON.parse(result.rawContent!);
    expect(stored.analysis).toBeNull();
    expect(stored.diagnostics).toMatchObject({ error: 'Model call exceeded the per-call token limit' });
    // The public reason stays generic: provider internals do not belong in an API response.
    expect(result.status.reason).toBe('Website evidence extraction unavailable');
  });
});

// DN-12 §4.3. Each scan here is stored the way the pipeline stores it: a scan row, then the source's raw record.
describe('website signal reuse', () => {
  const DAY = 86_400_000, T0 = Date.parse('2026-11-01T10:00:00.000Z');
  const signal = () => new AbortController().signal;
  const page = (path: string, text: string, noise = '') => ({ url: `https://firm.com${path}`, text,
    html: `<html><head><title>Smith Law</title>${noise}</head><body>${noise}<p>${text}</p><a href="/team">Our team</a></body></html>` });
  const site = (noise = '') => [page('/', 'Smith Law, Miami.', noise), page('/team', 'Jane Smith, Partner.', noise)];
  const analysis = (firm: string) => ({ ...unknownWebsite(), firm_name: firm });
  function setup(options: { reuseMaxAgeMs?: number } = {}) {
    const repository = new InMemoryRepository();
    let clock = T0, crawl: CrawlResult = { pages: site(), partial: false }, scans = 0, version = '1';
    const extract = vi.fn(async (input: CrawlResult) => analysis(`Smith Law read from ${input.pages.length} pages`));
    const source = () => new WebsiteExtractionSource(repository, { id: 'fixture', version, extract }, async () => crawl,
      { now: () => clock, reuseMaxAgeMs: options.reuseMaxAgeMs });
    async function scan(next?: CrawlResult) {
      if (next) crawl = next;
      const scanId = `sc_${++scans}`, at = new Date(clock).toISOString();
      await repository.create({ id: scanId, scan_id: scanId, email: 'owner@firm.com', canonical_domain: 'firm.com',
        domain_resolution: { status: 'RESOLVED', canonicalDomain: 'firm.com', source: 'request', reason: null },
        status: 'RUNNING', result: null, created_at: at, completed_at: null, duration_ms: null, cached: false });
      const result = await source().run('firm.com', signal());
      if (result.rawContent !== null) await repository.saveRaw({ scan_id: scanId, source: 'website', raw_content: result.rawContent,
        content_hash: 'a'.repeat(64), fetched_at: at });
      return { scanId, result, stored: result.rawContent === null ? null : JSON.parse(result.rawContent) };
    }
    return { repository, extract, scan, advance: (ms: number) => { clock += ms; }, setVersion: (value: string) => { version = value; } };
  }

  it('reuses the analysis when the site reads the same, whatever changed in its HTML', async () => {
    const s = setup();
    const first = await s.scan();
    s.advance(8 * DAY);
    const noise = `<script nonce="${'9f'.repeat(8)}">window.__t=1762683000</script><!-- rendered 2026-11-09T10:10:00Z -->`;
    const second = await s.scan({ pages: site(noise).reverse(), partial: false });
    expect(s.extract).toHaveBeenCalledTimes(1);
    expect(second.result.data).toEqual(first.result.data);
    expect(second.result.status).toMatchObject({ status: 'ok', dataStatus: 'PRESENT', pagesCrawled: 2 });
    // The reused record says whose analysis it holds and how old it is.
    expect(second.stored.reuse).toMatchObject({ key: first.stored.reuse.key, from: 'sc_1', analyzedAt: '2026-11-01T10:00:00.000Z' });
    expect(first.stored.reuse).toMatchObject({ from: null, pages: 2 });
  });

  it('extracts again when a page reads differently', async () => {
    const s = setup();
    await s.scan();
    await s.scan({ pages: [page('/', 'Smith Law, Miami.'), page('/team', 'Jane Smith, Partner. John Doe, Associate.')], partial: false });
    expect(s.extract).toHaveBeenCalledTimes(2);
    // A title, a description or a link the corpus shows the model counts as much as the text.
    const titled = site();
    titled[0]!.html = titled[0]!.html.replace('<title>Smith Law</title>', '<title>Smith &amp; Doe Law</title>');
    await s.scan({ pages: titled, partial: false });
    expect(s.extract).toHaveBeenCalledTimes(3);
    const linked = site();
    linked[1]!.html = linked[1]!.html.replace('</body>', '<a href="/privacy">Privacy</a></body>');
    await s.scan({ pages: linked, partial: false });
    expect(s.extract).toHaveBeenCalledTimes(4);
  });

  it('extracts again under another provider version', async () => {
    const s = setup();
    await s.scan();
    s.setVersion('2');
    await s.scan();
    expect(s.extract).toHaveBeenCalledTimes(2);
    await s.scan();
    expect(s.extract).toHaveBeenCalledTimes(2);
  });

  it('looks past a newer record that holds no analysis', async () => {
    const s = setup();
    const first = await s.scan();
    s.advance(DAY);
    s.extract.mockRejectedValueOnce(new Error('Model unavailable'));
    const failed = await s.scan({ pages: [page('/', 'Smith Law, Miami. Now in Tampa too.')], partial: false });
    expect(failed.result.status).toMatchObject({ status: 'error', code: 'PROVIDER_ERROR' });
    expect(failed.stored).not.toHaveProperty('reuse');
    s.advance(DAY);
    const third = await s.scan({ pages: site(), partial: false });
    expect(s.extract).toHaveBeenCalledTimes(2);
    expect(third.result.data).toEqual(first.result.data);
  });

  it('skips a stored record it cannot trust and reads the next one', async () => {
    const s = setup();
    const first = await s.scan();
    s.advance(DAY);
    const copy = await s.scan();
    // The newer record is damaged in storage: it still carries the key, but no analysis that parses.
    const broken = s.repository.raw.find(record => record.scan_id === copy.scanId)!;
    broken.raw_content = JSON.stringify({ ...copy.stored, analysis: { firm_name: 7 } });
    s.advance(DAY);
    const third = await s.scan();
    expect(s.extract).toHaveBeenCalledTimes(1);
    expect(third.result.data).toEqual(first.result.data);
  });

  it('never fails the source because the lookup failed', async () => {
    const s = setup();
    await s.scan();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(s.repository, 'findRaw').mockRejectedValueOnce(new Error('The storage request timed out'));
    const searched = await s.scan();
    expect(searched.result.status).toMatchObject({ status: 'ok', dataStatus: 'PRESENT' });
    vi.spyOn(s.repository, 'rawOf').mockRejectedValueOnce(new Error('The storage request timed out'));
    const read = await s.scan();
    expect(read.result.status).toMatchObject({ status: 'ok', dataStatus: 'PRESENT' });
    expect(s.extract).toHaveBeenCalledTimes(3);
    expect(errors).toHaveBeenCalledTimes(2);
    errors.mockRestore();
  });

  it('keeps its reads small: ids first, then one record on a hit and none on a miss', async () => {
    const s = setup();
    await s.scan();
    for (let index = 0; index < 5; index++) { s.advance(DAY); await s.scan(); }
    const find = vi.spyOn(s.repository, 'findRaw'), read = vi.spyOn(s.repository, 'rawOf');
    await s.scan();
    expect(find).toHaveBeenCalledTimes(1);
    expect(find.mock.calls[0]).toEqual(['firm.com', 'website', expect.stringMatching(/^wsk1-[0-9a-f]{64}$/), expect.any(String), 3]);
    const listed = await find.mock.results[0]!.value;
    expect(listed).toHaveLength(3);
    expect(listed[0]).not.toHaveProperty('raw_content');
    expect(read).toHaveBeenCalledTimes(1);
    await s.scan({ pages: [page('/', 'Another firm entirely.')], partial: false });
    expect(find).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('caps the age of a reused analysis from the day it was extracted, however often it was reused', async () => {
    const s = setup({ reuseMaxAgeMs: 30 * DAY });
    await s.scan();
    for (let week = 0; week < 4; week++) { s.advance(7 * DAY); await s.scan(); }
    // Day 28: four reuses, each stored a week after the last. None of them made the analysis younger.
    expect(s.extract).toHaveBeenCalledTimes(1);
    s.advance(7 * DAY);
    const expired = await s.scan();
    expect(s.extract).toHaveBeenCalledTimes(2);
    expect(expired.stored.reuse).toMatchObject({ from: null, analyzedAt: new Date(T0 + 35 * DAY).toISOString() });
  });

  it('extracts on every scan when the reuse age is 0', async () => {
    const s = setup({ reuseMaxAgeMs: 0 });
    const find = vi.spyOn(s.repository, 'findRaw');
    await s.scan(); await s.scan();
    expect(s.extract).toHaveBeenCalledTimes(2);
    expect(find).not.toHaveBeenCalled();
  });

  describe('a crawl that was cut short', () => {
    const cut = (pages = [site()[0]!]): CrawlResult => ({ pages, partial: true, aborted: true, issues: [] });
    it('keeps the analysis of the complete reading instead of a thinner one', async () => {
      const s = setup();
      const complete = await s.scan();
      s.advance(2 * DAY);
      const short = await s.scan(cut());
      expect(s.extract).toHaveBeenCalledTimes(1);
      expect(short.result.data).toEqual(complete.result.data);
      // The status still describes this crawl, and says where the signals came from.
      expect(short.result.status).toMatchObject({ status: 'partial', code: 'DEADLINE_REACHED', pagesCrawled: 1,
        reason: 'Crawl deadline reached; signals kept from the complete reading of 2026-11-01' });
      expect(short.stored.reuse).toMatchObject({ key: complete.stored.reuse.key, from: 'sc_1', pages: 2 });
      // The next complete crawl of the same site still finds it, through the record the short crawl stored.
      s.advance(DAY);
      expect((await s.scan({ pages: site(), partial: false })).result.data).toEqual(complete.result.data);
      expect(s.extract).toHaveBeenCalledTimes(1);
    });
    it('prefers the complete reading over an older analysis of the same thin evidence', async () => {
      const s = setup();
      const thin = await s.scan(cut());
      expect(thin.stored.reuse).toMatchObject({ full: null, pages: 1 });
      s.advance(DAY);
      const complete = await s.scan({ pages: site(), partial: false });
      s.advance(DAY);
      const again = await s.scan(cut());
      expect(s.extract).toHaveBeenCalledTimes(2);
      expect(again.result.data).toEqual(complete.result.data);
      expect(again.result.data).not.toEqual(thin.result.data);
    });
    it('reuses its own earlier analysis when no complete reading exists', async () => {
      const s = setup();
      const first = await s.scan(cut());
      const second = await s.scan(cut());
      expect(s.extract).toHaveBeenCalledTimes(1);
      expect(second.result.data).toEqual(first.result.data);
    });
    it('extracts when it read more pages than the stored complete reading', async () => {
      const s = setup();
      await s.scan({ pages: [site()[0]!], partial: false });
      const grown = await s.scan(cut(site()));
      expect(s.extract).toHaveBeenCalledTimes(2);
      expect(grown.result.data?.firm_name).toBe('Smith Law read from 2 pages');
    });
    it('does not keep a complete reading older than the age cap', async () => {
      const s = setup({ reuseMaxAgeMs: 30 * DAY });
      await s.scan();
      s.advance(31 * DAY);
      await s.scan(cut());
      expect(s.extract).toHaveBeenCalledTimes(2);
    });
  });

  it('reports why a partial crawl is partial, so the scan cache can tell a passing failure from an answer of the site', async () => {
    const s = setup();
    const issue = (code: CrawlIssue['code'], status: number | null): CrawlIssue => ({ url: 'https://firm.com/about', code, status, scope: 'page' });
    const status = async (crawl: Partial<CrawlResult>) => (await s.scan({ pages: site(), partial: true, ...crawl })).result.status;
    expect(await status({ aborted: true })).toMatchObject({ status: 'partial', code: 'DEADLINE_REACHED' });
    expect(await status({ issues: [issue('HTTP_ERROR', 503)] })).toMatchObject({ status: 'partial', code: 'PROVIDER_ERROR' });
    expect(await status({ issues: [issue('ACCESS_BLOCKED', 403)] })).not.toHaveProperty('code');
    // An empty page is transient here as it is when it is the whole site: a script that failed to load once.
    expect(await status({ issues: [issue('NO_READABLE_CONTENT', 200)] })).toMatchObject({ status: 'partial', code: 'PROVIDER_ERROR' });
    expect(await status({ issues: [{ ...issue('ACCESS_BLOCKED', 429), detail: CHALLENGE_PAGE }] })).not.toHaveProperty('code');
    expect((await s.scan({ pages: site(), partial: false, issues: [issue('HTTP_ERROR', 404)] })).result.status).not.toHaveProperty('code');
  });
});

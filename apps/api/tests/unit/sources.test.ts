import { describe, it, expect, vi } from 'vitest';
import { unknownWebsite } from '@arca/contracts';
import { ApifyDirectorySource, AVVO_ACTOR, BAR_ACTOR, AVVO_TECHNICAL_MAX_LAWYERS, BAR_TECHNICAL_MAX_LAWYERS,
  AVVO_TARGETED_MAX_LAWYERS, BAR_TARGETED_MAX_LAWYERS, parseBar, parseAvvo,
  parseDisciplineSummary } from '../../src/pipeline/directories.js';
import { ApifyClient } from '../../src/pipeline/apify-client.js';
import { RagWebsiteSource, WebsiteExtractionSource } from '../../src/pipeline/website-source.js';
import { RuleBasedEvidenceProvider } from '../../src/pipeline/website-evidence-provider.js';
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
    }, expect.any(AbortSignal), { scanId: undefined });
    expect(AVVO_ACTOR).toBe('scrapers_lat/avvo-lawyers-scraper');
  });
  it('caps targeted searches while preserving technical maxima for complete firm fallbacks', async () => {
    const run = vi.fn(async () => []);
    const signal = new AbortController().signal;
    await new ApifyDirectorySource('bar', { run }).run(query, signal);
    await new ApifyDirectorySource('avvo', { run }).run(query, signal);
    expect(run).toHaveBeenNthCalledWith(1, BAR_ACTOR, expect.objectContaining({ maxLawyers: BAR_TARGETED_MAX_LAWYERS }), signal, { scanId: undefined });
    expect(run).toHaveBeenNthCalledWith(2, AVVO_ACTOR, expect.objectContaining({ maxLawyers: AVVO_TARGETED_MAX_LAWYERS }), signal, { scanId: undefined });
    await new ApifyDirectorySource('bar', { run }).run({ ...query, names: [] }, signal);
    await new ApifyDirectorySource('avvo', { run }).run({ ...query, names: [] }, signal);
    expect(run).toHaveBeenNthCalledWith(3, BAR_ACTOR, expect.objectContaining({ maxLawyers: BAR_TECHNICAL_MAX_LAWYERS }), signal, { scanId: undefined });
    expect(run).toHaveBeenNthCalledWith(4, AVVO_ACTOR, expect.objectContaining({ maxLawyers: AVVO_TECHNICAL_MAX_LAWYERS }), signal, { scanId: undefined });
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
    expect(output.metadata).toMatchObject({ status: 'TIMED-OUT', partial: true, costUsd: .4, accountingComplete: true });
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
    expect(first.status).toMatchObject({ costUsd: .1, cachedRuns: 0, costPerAcceptedAttorneyUsd: .1 });
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
  it('blocks new work when unknown accounting has consumed the scan reservation', async () => {
    const repository = new InMemoryRepository();
    await repository.create({ id: 'id', scan_id: 'sc_budget', email: 'owner@firm.com', canonical_domain: 'firm.com',
      domain_resolution: { status: 'RESOLVED', canonicalDomain: 'firm.com', source: 'request', reason: null },
      status: 'RUNNING', result: null, created_at: new Date().toISOString(), completed_at: null, duration_ms: null, cached: false });
    const request = vi.fn(async (url: string | URL | Request) => String(url).includes('/runs?')
      ? Response.json({ data: { id: 'run', status: 'SUCCEEDED', defaultDatasetId: 'dataset' } }) : Response.json([]));
    const client = new ApifyClient('token', request as typeof fetch, 2, { store: repository,
      maxCostUsdPerRun: 1, maxCostUsdPerScan: 1, maxCostUsdPerDay: 2 });
    await client.run('owner/actor', { name: 'Jane' }, new AbortController().signal, { scanId: 'sc_budget' });
    await expect(client.run('owner/actor', { name: 'John' }, new AbortController().signal, { scanId: 'sc_budget' }))
      .rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
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
describe('website extraction', () => {
  const pages = [{ url: 'https://firm.com/', html: '<body>Firm</body>', text: 'Firm' }];
  it('reuses validated analysis only after checking the newly crawled content hash', async () => {
    const repository = new InMemoryRepository();
    const parse = vi.fn(async () => ({ choices: [{ message: { parsed: unknownWebsite() } }] }));
    const client = { chat: { completions: { parse } } } as unknown as OpenAI;
    const source = new RagWebsiteSource('test', repository, async () => ({ pages, partial: false }), client);
    const first = await source.run('firm.com', new AbortController().signal);
    vi.spyOn(repository, 'latestRaw').mockResolvedValue({ scan_id: 'scan', source: 'website', raw_content: first.rawContent!, content_hash: 'hash', fetched_at: new Date().toISOString() });
    const second = await source.run('firm.com', new AbortController().signal);
    expect(parse).toHaveBeenCalledTimes(1);
    expect(second.data).toEqual(first.data);
  });
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
});

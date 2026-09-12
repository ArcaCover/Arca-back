import { describe, it, expect, vi } from 'vitest';
import { unknownWebsite } from '@arca/contracts';
import { ApifyDirectorySource, AVVO_ACTOR, BAR_ACTOR, MAX_PROVIDER_RESULTS, parseBar, parseAvvo,
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
      searchQueries: ['Jane Smith'], cities: ['Miami, FL'], withDetails: true, maxLawyers: 10,
    }, expect.any(AbortSignal));
    expect(AVVO_ACTOR).toBe('scrapers_lat/avvo-lawyers-scraper');
  });
  it('caps the records requested from both paid providers at ten', async () => {
    const run = vi.fn(async () => []);
    const signal = new AbortController().signal;
    await new ApifyDirectorySource('bar', { run }).run(query, signal);
    await new ApifyDirectorySource('avvo', { run }).run(query, signal);
    expect(MAX_PROVIDER_RESULTS).toBe(10);
    expect(run).toHaveBeenNthCalledWith(1, BAR_ACTOR, expect.objectContaining({ maxLawyers: 10 }), signal);
    expect(run).toHaveBeenNthCalledWith(2, AVVO_ACTOR, expect.objectContaining({ maxLawyers: 10 }), signal);
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
  it('keeps partial directory evidence and caps paid searches at two identities', async () => {
    const run = vi.fn(async () => [{ name: 'Jane Smith' }, { error: 'unreadable' }]);
    const result = await new ApifyDirectorySource('bar', { run }).run({ ...query, names: Array.from({ length: 20 }, (_, i) => `Jane Smith${String.fromCharCode(97 + i)}`) }, new AbortController().signal);
    expect(run).toHaveBeenCalledTimes(2);
    expect(result.status.status).toBe('partial');
  });
  it('accepts every firm-fallback attorney the single paid run already returned', async () => {
    const candidates = ['A One', 'B Two', 'C Three'].map(name => ({ name, firm: 'Smith Law' }));
    const run = vi.fn(async () => candidates);
    const result = await new ApifyDirectorySource('bar', { run }).run({
      ...query, names: [], maxTargets: 2,
    }, new AbortController().signal);
    // maxTargets budgets paid lookups, not the records one lookup already produced.
    expect(run).toHaveBeenCalledTimes(1);
    expect(result.data).toHaveLength(3);
    expect(result.status.attorneysFound).toBe(3);
  });
  it('keeps rejecting firm-fallback records belonging to another firm', async () => {
    const candidates = [{ name: 'A One', firm: 'Smith Law' }, { name: 'B Two', firm: 'Other Law' },
      { name: 'C Three', firm: null }];
    const result = await new ApifyDirectorySource('bar', { run: async () => candidates }).run({
      ...query, names: [], maxTargets: 2,
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
  it('aborts a remote run when the caller cancels', async () => {
    const controller = new AbortController();
    const request = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('/runs?')) {
        controller.abort();
        return Response.json({ data: { id: 'run', status: 'RUNNING', defaultDatasetId: 'dataset' } });
      }
      return Response.json({});
    });
    await expect(new ApifyClient('token', request as typeof fetch).run('owner/actor', {}, controller.signal)).rejects.toThrow();
    expect(String(request.mock.calls.at(-1)?.[0])).toContain('/actor-runs/run/abort');
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

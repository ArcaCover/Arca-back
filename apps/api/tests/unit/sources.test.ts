import { describe, it, expect, vi } from 'vitest';
import { unknownWebsite } from '@arca/contracts';
import { ApifyDirectorySource, parseBar, parseAvvo, parseDisciplineSummary } from '../../src/pipeline/directories.js';
import { ApifyClient } from '../../src/pipeline/apify-client.js';
import { RagWebsiteSource } from '../../src/pipeline/website-source.js';
import { InMemoryRepository } from '../../src/repositories/in-memory.js';
import type OpenAI from 'openai';

const query = { canonicalDomain: 'firm.com', names: ['Jane Smith'], firmName: 'Smith Law', state: 'FL' as const };
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
    expect(parseAvvo({ attorneyName: 'Jane Smith', reviewCount: 0, disciplinaryAction: false })).toMatchObject({ reviewCount: 0, hasDisciplinaryHistory: false, avvoRating: null, awards: null });
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
  it('keeps partial directory evidence and caps stable targeted searches at 15', async () => {
    const run = vi.fn(async () => [{ name: 'Jane Smith' }, { error: 'unreadable' }]);
    const result = await new ApifyDirectorySource('bar', { run }).run({ ...query, names: Array.from({ length: 20 }, (_, i) => `Jane Smith${String.fromCharCode(97 + i)}`) }, new AbortController().signal);
    expect(run).toHaveBeenCalledTimes(15);
    expect(result.status.status).toBe('partial');
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
    const items = await new ApifyClient('secret-token', request as typeof fetch).run('owner/actor', {}, new AbortController().signal);
    expect(items).toHaveLength(101);
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
});

import { describe, expect, it, vi } from 'vitest';
import { ApifyClient, ApifyClientError, dnsFailure } from '../../src/pipeline/apify-client.js';
import { ApifyDirectorySource, AVVO_ACTOR, BAR_ACTOR } from '../../src/pipeline/directories.js';
import { InMemoryRepository } from '../../src/repositories/in-memory.js';

// Every client here runs over a stub transport: nothing reaches Apify.
const signal = () => new AbortController().signal;
const started = (calls: unknown[][]) => calls.filter(call => String(call[0]).includes('/runs?'));
const limitOf = (call: unknown[]) => Number(new URL(String(call[0])).searchParams.get('maxTotalChargeUsd'));
const apify = () => {
  let runs = 0;
  return vi.fn(async (url: string | URL | Request, _init?: RequestInit) => String(url).includes('/runs?')
    ? Response.json({ data: { id: `run-${++runs}`, status: 'SUCCEEDED', defaultDatasetId: `dataset-${runs}` } })
    : Response.json([{ name: 'Jane Smith' }]));
};
const rows = (repository: InMemoryRepository) => [...repository.apifyRuns.values()];
// What Node's fetch throws when the name of the host cannot be resolved: the request never left the machine.
const dnsError = (code = 'ENOTFOUND') => Object.assign(new TypeError('fetch failed'),
  { cause: Object.assign(new Error(`getaddrinfo ${code} api.apify.com`), { code, syscall: 'getaddrinfo', hostname: 'api.apify.com' }) });

describe('Apify reservation per kind of lookup', () => {
  const client = (repository: InMemoryRepository, request: ReturnType<typeof apify>, ceiling: number | null = 2) =>
    new ApifyClient('token', request as typeof fetch, 32, { store: repository, spendCeilingUsd: ceiling,
      expectedCostUsdPerRun: 1, expectedCostUsdPerTargetedRun: 0.1, expectedCostUsdPerTargetedRunByActor: { [AVVO_ACTOR]: 0.4 } });

  it('reserves the targeted amount for a named lookup and the firm amount for a firm search', async () => {
    const repository = new InMemoryRepository(), request = apify();
    const apifyClient = client(repository, request, null);
    await apifyClient.run(BAR_ACTOR, { lastNames: ['Smith'] }, signal(), { kind: 'targeted' });
    await apifyClient.run(AVVO_ACTOR, { searchQueries: ['Jane Smith'] }, signal(), { kind: 'targeted' });
    await apifyClient.run(BAR_ACTOR, { firm: 'Smith Law' }, signal(), { kind: 'firm' });
    // A caller that does not say is charged as the larger kind: the ceiling errs on the side of refusing.
    await apifyClient.run(BAR_ACTOR, { firm: 'Other Law' }, signal());
    expect(rows(repository).map(row => row.reserved_usd)).toEqual([0.1, 0.4, 1, 1]);
  });

  it('fits many targeted lookups under a ceiling that held only two of them before', async () => {
    const repository = new InMemoryRepository(), request = apify(), log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const apifyClient = client(repository, request);
      const outcomes = await Promise.allSettled(Array.from({ length: 25 }, (_, index) =>
        apifyClient.run(BAR_ACTOR, { lastNames: [`Name ${index}`] }, signal(), { kind: 'targeted' })));
      // USD 2 / USD 0.10: twenty start, the other five are refused before any request.
      expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(20);
      expect(started(request.mock.calls)).toHaveLength(20);
      // Each run may charge only its own reservation, so together they never pass the ceiling.
      const limits = started(request.mock.calls).map(limitOf);
      expect(limits.every(limit => limit === 0.1)).toBe(true);
      expect(limits.reduce((total, limit) => total + limit, 0)).toBeLessThanOrEqual(2 + 1e-9);
    } finally { log.mockRestore(); }
  });

  it('adds both kinds up against one ceiling', async () => {
    const repository = new InMemoryRepository(), request = apify(), log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const apifyClient = client(repository, request);
      await apifyClient.run(BAR_ACTOR, { firm: 'Smith Law' }, signal(), { kind: 'firm' });
      for (let index = 0; index < 10; index++) await apifyClient.run(BAR_ACTOR, { lastNames: [`N${index}`] }, signal(), { kind: 'targeted' });
      // USD 1 + 10 × 0.10 = USD 2 held: neither another firm search nor another named lookup fits.
      await expect(apifyClient.run(BAR_ACTOR, { firm: 'Other Law' }, signal(), { kind: 'firm' }))
        .rejects.toMatchObject({ code: 'SPEND_CEILING_REACHED' });
      await expect(apifyClient.run(BAR_ACTOR, { lastNames: ['Late'] }, signal(), { kind: 'targeted' }))
        .rejects.toMatchObject({ code: 'SPEND_CEILING_REACHED' });
      expect(started(request.mock.calls).map(limitOf)).toEqual([1, ...Array(10).fill(0.1)]);
      const line = log.mock.calls.map(call => String(call[0])).find(text => text.startsWith('[apify] Apify spend ceiling reached'))!;
      expect(line).toContain('a run reserves USD 1.00');
      expect(line).toContain('APIFY_EXPECTED_COST_USD_PER_RUN');
    } finally { log.mockRestore(); }
  });

  it('names the targeted reservation in the refusal of a named lookup', async () => {
    const repository = new InMemoryRepository(), request = apify(), log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const apifyClient = client(repository, request, 0);
      await expect(apifyClient.run(BAR_ACTOR, { lastNames: ['Smith'] }, signal(), { kind: 'targeted' }))
        .rejects.toMatchObject({ code: 'SPEND_CEILING_REACHED' });
      const line = log.mock.calls.map(call => String(call[0])).find(text => text.startsWith('[apify] Apify spend ceiling reached'))!;
      expect(line).toContain('a run reserves USD 0.10');
      expect(line).toContain('APIFY_EXPECTED_COST_USD_PER_TARGETED_RUN');
    } finally { log.mockRestore(); }
  });

  it('tells the client which kind each directory lookup is', async () => {
    const run = vi.fn(async () => [{ name: 'Jane Smith', firm: 'Smith Law' }]);
    const query = { canonicalDomain: 'firm.com', firmName: 'Smith Law', city: 'Miami', state: 'FL' };
    await new ApifyDirectorySource('bar', { run }).run({ ...query, names: ['Jane Smith'] }, signal());
    await new ApifyDirectorySource('bar', { run }).run({ ...query, names: [] }, signal());
    await new ApifyDirectorySource('bar', { run }).run({ ...query, names: [], officeCities: ['Tampa'] }, signal());
    await new ApifyDirectorySource('avvo', { run }).run({ ...query, names: ['Jane Smith'] }, signal());
    await new ApifyDirectorySource('avvo', { run }).run({ ...query, names: [] }, signal());
    expect(run.mock.calls.map(call => (call as unknown[])[3])).toEqual([
      { scanId: undefined, kind: 'targeted' }, { scanId: undefined, kind: 'firm' }, { scanId: undefined, kind: 'firm' },
      { scanId: undefined, kind: 'targeted' }, { scanId: undefined, kind: 'firm' }]);
  });
});

describe('Apify start that never left the machine', () => {
  const client = (repository: InMemoryRepository, request: typeof fetch) => new ApifyClient('token', request, 16,
    { store: repository, expectedCostUsdPerRun: 1, spendCeilingUsd: 2, startRetryBackoffMs: [1, 1] });

  it('recognises a DNS lookup failure on the cause of a fetch error, and nothing else', () => {
    expect(dnsFailure(dnsError())).toBe('ENOTFOUND');
    expect(dnsFailure(dnsError('EAI_AGAIN'))).toBe('EAI_AGAIN');
    expect(dnsFailure(new TypeError('fetch failed'))).toBeNull();
    expect(dnsFailure(Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) }))).toBeNull();
    expect(dnsFailure(null)).toBeNull();
  });

  it('retries the start after a DNS failure and runs once the name resolves', async () => {
    const repository = new InMemoryRepository();
    let failures = 2;
    const request = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      if (String(url).includes('/runs?')) {
        if (failures-- > 0) throw dnsError();
        return Response.json({ data: { id: 'run-1', status: 'SUCCEEDED', defaultDatasetId: 'dataset-1' } });
      }
      return Response.json([{ name: 'Jane Smith' }]);
    });
    const result = await client(repository, request as typeof fetch).run(BAR_ACTOR, { firm: 'Smith Law' }, signal());
    expect(result.metadata).toMatchObject({ runId: 'run-1', status: 'SUCCEEDED' });
    expect(started(request.mock.calls)).toHaveLength(3);
    expect(rows(repository)).toHaveLength(1);
    expect(rows(repository)[0]).toMatchObject({ status: 'SUCCEEDED', run_id: 'run-1', last_error: null });
  });

  it('gives up after two retries without leaving an uncertain start, and keeps the error', async () => {
    const repository = new InMemoryRepository();
    const request = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('/runs?')) throw dnsError();
      return Response.json([]);
    });
    const apifyClient = client(repository, request as typeof fetch);
    const error = await apifyClient.run(BAR_ACTOR, { firm: 'Smith Law' }, signal()).catch(caught => caught);
    expect(error).toBeInstanceOf(ApifyClientError);
    expect(error).toMatchObject({ code: 'PROVIDER_ERROR' });
    expect(started(request.mock.calls)).toHaveLength(3);
    const [row] = rows(repository);
    // Nothing left the machine: the row is not an uncertain start, holds nothing against the ceiling and is not held
    // in a retry cooldown, so the next scan simply tries again.
    expect(row).toMatchObject({ status: 'UNAVAILABLE', run_id: null });
    expect(row!.last_error).toContain('getaddrinfo ENOTFOUND api.apify.com');
    expect(Date.parse(row!.expires_at)).toBeLessThanOrEqual(Date.now());
    request.mockImplementation(async (url: string | URL | Request) => String(url).includes('/runs?')
      ? Response.json({ data: { id: 'run-2', status: 'SUCCEEDED', defaultDatasetId: 'dataset-2' } }) : Response.json([]));
    await apifyClient.run(BAR_ACTOR, { firm: 'Smith Law' }, signal());
    await apifyClient.run(BAR_ACTOR, { firm: 'Other Law' }, signal());
    expect(rows(repository).map(item => item.status)).toEqual(['UNAVAILABLE', 'SUCCEEDED', 'SUCCEEDED']);
  });

  it('never retries a start whose request may have left, and stores why it is uncertain', async () => {
    const repository = new InMemoryRepository();
    const request = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('/runs?')) throw Object.assign(new TypeError('fetch failed'),
        { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) });
      return Response.json([]);
    });
    await expect(client(repository, request as typeof fetch).run(BAR_ACTOR, { firm: 'Smith Law' }, signal()))
      .rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    expect(started(request.mock.calls)).toHaveLength(1);
    const [row] = rows(repository);
    expect(row).toMatchObject({ status: 'START_UNCERTAIN', run_id: null });
    expect(row!.last_error).toBe('Actor start response unavailable: fetch failed (read ECONNRESET)');
  });

  it('truncates a long underlying error before storing it', async () => {
    const repository = new InMemoryRepository();
    const request = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('/runs?')) throw new Error(`proxy said ${'x'.repeat(1000)}`);
      return Response.json([]);
    });
    await expect(client(repository, request as typeof fetch).run(BAR_ACTOR, { firm: 'Smith Law' }, signal())).rejects.toThrow();
    expect(rows(repository)[0]!.last_error!.length).toBeLessThanOrEqual(300);
    expect(rows(repository)[0]!.last_error).toMatch(/^Actor start response unavailable: proxy said x+/);
  });

  it('stops retrying when the caller gives up', async () => {
    const repository = new InMemoryRepository(), controller = new AbortController();
    const request = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('/runs?')) { controller.abort(new Error('deadline')); throw dnsError(); }
      return Response.json([]);
    });
    await expect(client(repository, request as typeof fetch).run(BAR_ACTOR, { firm: 'Smith Law' }, controller.signal)).rejects.toThrow();
    expect(started(request.mock.calls)).toHaveLength(1);
    expect(rows(repository)[0]).toMatchObject({ status: 'UNAVAILABLE', run_id: null });
  });
});

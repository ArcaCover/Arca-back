import { describe, it, expect, vi, afterEach } from 'vitest';
import { unknownWebsite, type AttorneyMatch, type DirectoryQuery, type SourceResult,
  type WebsiteData } from '@arca/contracts';
import { DebugScenario, type DebugScenarioInput } from '@arca/contracts/debug';
import { LATENCY_MS, injectDirectory, injectWebsite } from '../../src/debug/sources.js';
import { APIFY_QUOTA_REASON, ApifyDirectorySource } from '../../src/pipeline/directories.js';
import { ApifyClientError } from '../../src/pipeline/apify-client.js';
import { InProcessPipeline } from '../../src/pipeline/in-process-pipeline.js';
import { InMemoryRepository } from '../../src/repositories/in-memory.js';

const scenario = (input: DebugScenarioInput = {}) => DebugScenario.parse(input);
const websiteResult: SourceResult<WebsiteData> = {
  data: { ...unknownWebsite(), firm_name: 'Smith Law', team_members: [{ full_name: 'Jane Smith', title: 'Attorney' }] },
  rawContent: '{}', status: { status: 'ok', dataStatus: 'PRESENT', durationMs: 5 } };
const directoryResult: SourceResult<AttorneyMatch[]> = { data: [], rawContent: '[]',
  status: { status: 'ok', dataStatus: 'EMPTY', durationMs: 5 } };
const query: DirectoryQuery = { canonicalDomain: 'firm.com', names: ['Jane Smith', 'John Roe'], firmName: 'Smith Law',
  city: 'Miami', state: 'FL', scanId: 'sc_x' };
const input = { scanId: 'sc_inject', canonicalDomain: 'firm.com', email: 'owner@firm.com' };

afterEach(() => { vi.useRealTimers(); });

describe('injected website source', () => {
  it('website default delegates and waits the latency', async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => websiteResult);
    const signal = new AbortController().signal;
    let settled: SourceResult<WebsiteData> | undefined;
    const pending = injectWebsite({ run }, scenario({ latency: 'normal' }), { latency: true }).run('firm.com', signal)
      .then(result => { settled = result; });
    await vi.advanceTimersByTimeAsync(LATENCY_MS.normal - 1);
    expect(settled).toBeUndefined();
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(settled).toBe(websiteResult);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith('firm.com', signal);
  });
  it('does not wait when the mode has no simulated latency, whatever the scenario says', async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => websiteResult);
    const result = await injectWebsite({ run }, scenario({ latency: 'slow' }), { latency: false })
      .run('firm.com', new AbortController().signal);
    expect(result).toBe(websiteResult);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('stops waiting when the scan is aborted and never reaches the real source', async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => websiteResult);
    const controller = new AbortController(), reason = new Error('Source deadline reached');
    const outcome = expect(injectWebsite({ run }, scenario({ latency: 'slow' }), { latency: true })
      .run('firm.com', controller.signal)).rejects.toBe(reason);
    await vi.advanceTimersByTimeAsync(1_000);
    controller.abort(reason);
    await outcome;
    expect(run).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('keeps the latencies the panel promises, with slow past the 60 second slow-scan notice', () => {
    expect(LATENCY_MS).toEqual({ instant: 0, normal: 8_000, slow: 70_000 });
  });
  it.each([
    ['no_identity', { data: unknownWebsite(), status: { status: 'error', dataStatus: 'EMPTY', durationMs: 0, pagesCrawled: 1, reason: null } }],
    ['blocked', { data: null, status: { status: 'error', dataStatus: 'UNKNOWN', durationMs: 0, pagesCrawled: 0,
      code: 'ACCESS_BLOCKED', reason: 'Website access was blocked' } }],
    ['timeout', { data: null, status: { status: 'timeout', dataStatus: 'UNKNOWN', durationMs: 0,
      code: 'DEADLINE_REACHED', reason: 'Deadline reached' } }],
  ] as const)('website %s fabricates its result without touching the real source', async (website, expected) => {
    const run = vi.fn(async () => websiteResult);
    const result = await injectWebsite({ run }, scenario({ website }), { latency: true }).run('firm.com', new AbortController().signal);
    expect(result).toEqual({ ...expected, rawContent: JSON.stringify({ injected: website }) });
    expect(run).not.toHaveBeenCalled();
  });
  it('website error throws so the pipeline converts it', async () => {
    const run = vi.fn(async () => websiteResult);
    await expect(injectWebsite({ run }, scenario({ website: 'error' }), { latency: true })
      .run('firm.com', new AbortController().signal)).rejects.toThrow('Injected website failure');
    expect(run).not.toHaveBeenCalled();
  });
});

describe('injected website source inside the real pipeline', () => {
  const spies = () => ({ bar: { jurisdiction: 'FL', run: vi.fn(async () => directoryResult) },
    avvo: { run: vi.fn(async () => directoryResult) } });
  it('website no_identity yields insufficient identity through the real pipeline', async () => {
    const { bar, avvo } = spies();
    const real = { run: vi.fn(async () => websiteResult) };
    const pipeline = new InProcessPipeline({ website: injectWebsite(real, scenario({ website: 'no_identity' }), { latency: false }),
      bar, avvo, repository: new InMemoryRepository() });
    const outcome = await pipeline.run(input);
    expect(outcome.status).toBe('FAILED');
    expect(outcome.result.sources.bar).toMatchObject({ status: 'skipped', code: 'INSUFFICIENT_IDENTITY' });
    expect(outcome.result.sources.avvo).toMatchObject({ status: 'skipped', code: 'INSUFFICIENT_IDENTITY' });
    expect(bar.run).not.toHaveBeenCalled();
    expect(avvo.run).not.toHaveBeenCalled();
    expect(real.run).not.toHaveBeenCalled();
  });
  it("website error goes through the pipeline's own unavailable path", async () => {
    const { bar, avvo } = spies();
    const pipeline = new InProcessPipeline({ website: injectWebsite({ run: vi.fn(async () => websiteResult) },
      scenario({ website: 'error' }), { latency: false }), bar, avvo, repository: new InMemoryRepository() });
    const outcome = await pipeline.run(input);
    expect(outcome.result.sources.website).toMatchObject({ status: 'error', code: 'PROVIDER_ERROR' });
  });
  it('website blocked reaches the scan result as an access block', async () => {
    const { bar, avvo } = spies();
    const pipeline = new InProcessPipeline({ website: injectWebsite({ run: vi.fn(async () => websiteResult) },
      scenario({ website: 'blocked' }), { latency: false }), bar, avvo, repository: new InMemoryRepository() });
    const outcome = await pipeline.run(input);
    expect(outcome.result.sources.website).toMatchObject({ status: 'error', code: 'ACCESS_BLOCKED' });
    expect(bar.run).not.toHaveBeenCalled();
  });
  it('a latency longer than the pipeline budget ends as a website timeout instead of hanging', async () => {
    vi.useFakeTimers();
    const { bar, avvo } = spies();
    const real = { run: vi.fn(async () => websiteResult) };
    const pipeline = new InProcessPipeline({ website: injectWebsite(real, scenario({ latency: 'slow' }), { latency: true }),
      bar, avvo, repository: new InMemoryRepository(), timeoutMs: 20_000 });
    const pending = pipeline.run(input);
    await vi.advanceTimersByTimeAsync(20_000);
    const outcome = await pending;
    expect(outcome.status).toBe('FAILED');
    expect(outcome.result.sources.website).toMatchObject({ status: 'timeout', code: 'DEADLINE_REACHED' });
    expect(real.run).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('an empty directory is an ordinary finding of nobody', async () => {
    const { bar, avvo } = spies();
    const faults = scenario({ bar: 'empty', avvo: 'empty' });
    const pipeline = new InProcessPipeline({ website: { run: vi.fn(async () => websiteResult) },
      bar: injectDirectory('bar', bar, faults), avvo: injectDirectory('avvo', avvo, faults), repository: new InMemoryRepository() });
    const outcome = await pipeline.run(input);
    expect(outcome.status).toBe('COMPLETED');
    expect(outcome.result.sources.bar).toMatchObject({ status: 'ok', dataStatus: 'EMPTY', code: 'NO_MATCH', attorneysSearched: 1, attorneysFound: 0 });
    expect(bar.run).not.toHaveBeenCalled();
  });
  it('injected directory faults land on their own source and leave the other one real', async () => {
    const website = { run: vi.fn(async () => websiteResult) };
    const bar = { jurisdiction: 'FL', run: vi.fn(async () => directoryResult) };
    const avvo = { run: vi.fn(async () => directoryResult) };
    const faults = scenario({ bar: 'error', avvo: 'timeout' });
    const pipeline = new InProcessPipeline({ website, bar: injectDirectory('bar', bar, faults),
      avvo: injectDirectory('avvo', avvo, faults), repository: new InMemoryRepository() });
    const outcome = await pipeline.run(input);
    expect(outcome.result.sources.bar).toMatchObject({ status: 'error', code: 'PROVIDER_ERROR' });
    expect(outcome.result.sources.avvo).toMatchObject({ status: 'timeout', code: 'DEADLINE_REACHED' });
    expect(bar.run).not.toHaveBeenCalled();
    expect(avvo.run).not.toHaveBeenCalled();
  });
});

describe('injected directory source', () => {
  const signal = new AbortController().signal;
  it('default directories drop the scan id so the ledger never points at an in-memory scan', async () => {
    const run = vi.fn(async () => directoryResult);
    const result = await injectDirectory('avvo', { run }, scenario()).run(query, signal);
    expect(result).toBe(directoryResult);
    expect(run).toHaveBeenCalledTimes(1);
    const [forwarded, forwardedSignal] = run.mock.calls[0] as unknown as [DirectoryQuery, AbortSignal];
    expect(forwarded.scanId).toBeUndefined();
    expect(forwarded).toMatchObject({ canonicalDomain: 'firm.com', names: ['Jane Smith', 'John Roe'], firmName: 'Smith Law',
      city: 'Miami', state: 'FL' });
    expect(forwardedSignal).toBe(signal);
  });
  it('jurisdiction survives the wrapper', () => {
    const run = vi.fn(async () => directoryResult);
    expect(injectDirectory('bar', { jurisdiction: 'FL', run }, scenario({ bar: 'error' })).jurisdiction).toBe('FL');
    expect(injectDirectory('avvo', { run }, scenario()).jurisdiction).toBeUndefined();
  });
  it('reads the axis of its own source only', async () => {
    const run = vi.fn(async () => directoryResult);
    const faults = scenario({ bar: 'error' });
    await expect(injectDirectory('bar', { run }, faults).run(query, signal)).rejects.toThrow('Injected directory failure');
    await expect(injectDirectory('avvo', { run }, faults).run(query, signal)).resolves.toBe(directoryResult);
  });
  it('empty finds nobody, without calling the real source', async () => {
    const run = vi.fn(async () => directoryResult);
    const result = await injectDirectory('bar', { jurisdiction: 'FL', run }, scenario({ bar: 'empty' })).run(query, signal);
    expect(result).toEqual({ data: [], rawContent: JSON.stringify({ injected: 'empty' }), status: { status: 'ok', dataStatus: 'EMPTY',
      durationMs: 0, code: 'NO_MATCH', attorneysSearched: 2, attorneysFound: 0, providerRuns: [], costUsd: 0,
      reason: 'Provider completed successfully with no accepted identity match' } });
    expect(run).not.toHaveBeenCalled();
  });
  it('timeout reports the deadline, without calling the real source', async () => {
    const run = vi.fn(async () => directoryResult);
    const result = await injectDirectory('avvo', { run }, scenario({ avvo: 'timeout' })).run(query, signal);
    expect(result).toEqual({ data: null, rawContent: JSON.stringify({ injected: 'timeout' }), status: { status: 'timeout',
      dataStatus: 'UNKNOWN', durationMs: 0, code: 'DEADLINE_REACHED', reason: 'Deadline reached' } });
    expect(run).not.toHaveBeenCalled();
  });
  it('error throws so the pipeline converts it', async () => {
    const run = vi.fn(async () => directoryResult);
    await expect(injectDirectory('avvo', { run }, scenario({ avvo: 'error' })).run(query, signal)).rejects.toThrow('Injected directory failure');
    expect(run).not.toHaveBeenCalled();
  });
});

describe('apify_quota', () => {
  const quotaClient = () => ({ run: vi.fn(async () => { throw new ApifyClientError('PROVIDER_QUOTA_EXCEEDED', 'Apify usage limit reached'); }) });
  const signal = new AbortController().signal;
  const withoutDuration = <T extends { status: object }>(result: T) => ({ ...result.status, durationMs: 0 });
  const firmOnly: DirectoryQuery = { ...query, names: [] };
  it.each([
    ['bar', 'named attorneys', query], ['avvo', 'named attorneys', query],
    ['bar', 'a firm-wide search', firmOnly], ['avvo', 'a firm-wide search', firmOnly],
  ] as const)('apify_quota matches the real directory source at the usage limit (%s, %s)', async (name, _case, lookup) => {
    const client = quotaClient();
    const real = await new ApifyDirectorySource(name, client).run(lookup, signal);
    const unused = vi.fn(async () => directoryResult);
    const injected = await injectDirectory(name, { run: unused }, scenario({ [name]: 'apify_quota' })).run(lookup, signal);
    expect(client.run).toHaveBeenCalled();
    expect(unused).not.toHaveBeenCalled();
    expect(withoutDuration(injected)).toEqual(withoutDuration(real));
    expect(injected.data).toBe(real.data);
    expect(injected.rawContent).toBe(real.rawContent);
    expect(injected.status).toMatchObject({ status: 'error', code: 'PROVIDER_ERROR', reason: APIFY_QUOTA_REASON });
  });
});

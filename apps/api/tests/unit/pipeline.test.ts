import { describe, it, expect, vi } from 'vitest';
import { InProcessPipeline } from '../../src/pipeline/in-process-pipeline.js';
import { mockSources } from '../../src/pipeline/mock-sources.js';
import { InMemoryRepository } from '../../src/repositories/in-memory.js';
import { createApp } from '../../src/http/app.js';
import { PublicDomainResolver } from '../../src/pipeline/domain-resolution.js';
import { unknownWebsite, type SourceResult, type AttorneyMatch } from '@arca/contracts';

const failed = (): Promise<SourceResult<AttorneyMatch[]>> => Promise.resolve({ data: null, rawContent: null,
  status: { status: 'error', dataStatus: 'UNKNOWN', durationMs: 0 } });
describe('three-source orchestration', () => {
  it('bounds raw persistence and refuses to return an unpersisted assessment', async () => {
    const repository = new InMemoryRepository();
    vi.spyOn(repository, 'saveRaw').mockImplementation(() => new Promise(() => {}));
    const pipeline = new InProcessPipeline({ ...mockSources(), repository, timeoutMs: 1000 });
    await expect(pipeline.run({ scanId: 'sc_storage', canonicalDomain: 'robust.arca.example', email: 'owner@robust.arca.example' })).rejects.toThrow('persistence deadline');
  });
  it('runs the full mock scan and stores all three raw source records', async () => {
    const repository = new InMemoryRepository();
    const pipeline = new InProcessPipeline({ ...mockSources(), repository });
    const start = Date.now();
    const result = await pipeline.run({ scanId: 'sc_mock', canonicalDomain: 'robust.arca.example', email: 'owner@robust.arca.example' });
    expect(result.status).toBe('COMPLETED');
    expect(result.result.preScore.total).toBe(82);
    expect(result.result.preScore.confidence).toBe('HIGH');
    expect(repository.raw.map(record => record.source).sort()).toEqual(['avvo', 'bar', 'website']);
    expect(repository.raw.every(record => /^[a-f0-9]{64}$/.test(record.content_hash))).toBe(true);
    expect(Date.now() - start).toBeLessThan(5000);
  });
  it('starts the directories together after website extraction', async () => {
    const sources = mockSources(); let barStarted = false, avvoStarted = false;
    const pipeline = new InProcessPipeline({ repository: new InMemoryRepository(), website: sources.website,
      bar: { run: async query => { barStarted = true; expect(query.names).toEqual(['Jane Smith']); await Promise.resolve(); expect(avvoStarted).toBe(true); return failed(); } },
      avvo: { run: async () => { avvoStarted = true; expect(barStarted).toBe(true); return failed(); } },
    });
    expect((await pipeline.run({ scanId: 'sc_parallel', canonicalDomain: 'robust.arca.example', email: 'owner@robust.arca.example' })).status).toBe('PARTIAL');
  });
  it('passes every verified attorney to both directories without a roster cap', async () => {
    const names = Array.from({ length: 30 }, (_, index) =>
      `Attorney Name${String.fromCharCode(65 + Math.floor(index / 26))}${String.fromCharCode(65 + index % 26)}`);
    const queries: string[][] = [];
    const directories = { run: async (query: { names: string[] }) => {
      queries.push(query.names);
      return failed();
    } };
    const pipeline = new InProcessPipeline({ repository: new InMemoryRepository(),
      website: { run: async () => ({ data: { ...unknownWebsite(), firm_name: 'Thirty Attorney Law',
        team_members: names.map(full_name => ({ full_name, title: 'Attorney' })) }, rawContent: '{}',
        status: { status: 'ok' as const, dataStatus: 'PRESENT' as const, durationMs: 0 } }) },
      bar: directories, avvo: directories });
    await pipeline.run({ scanId: 'sc_full_roster', canonicalDomain: 'firm.com', email: 'owner@firm.com' });
    expect(queries).toHaveLength(2);
    expect(queries.every(query => query.length === 30 && names.every(name => query.includes(name)))).toBe(true);
  });
  it('has MEDIUM technical confidence with one failed source', async () => {
    const pipeline = new InProcessPipeline({ ...mockSources(), avvo: { run: failed }, repository: new InMemoryRepository() });
    const result = await pipeline.run({ scanId: 'sc_partial', canonicalDomain: 'robust.arca.example', email: 'owner@robust.arca.example' });
    expect(result.status).toBe('PARTIAL');
    expect(result.result.preScore.confidence).toBe('MEDIUM');
    expect(result.result.signals.avvo.A1_avgRating).toBeNull();
  });
  it('retains a partial assessment with only one usable source', async () => {
    const pipeline = new InProcessPipeline({ ...mockSources(), avvo: { run: failed }, bar: { run: failed }, repository: new InMemoryRepository() });
    const result = await pipeline.run({ scanId: 'sc_single', canonicalDomain: 'robust.arca.example', email: 'owner@robust.arca.example' });
    expect(result.status).toBe('PARTIAL');
    expect(result.result.preScore.confidence).toBe('LOW');
  });
  it('skips paid directories after website failure without inventing a firm identity', async () => {
    const run = vi.fn(failed);
    const pipeline = new InProcessPipeline({ website: { run: async () => { throw new Error('Website unavailable'); } },
      bar: { run }, avvo: { run }, repository: new InMemoryRepository() });
    const result = await pipeline.run({ scanId: 'sc_failed', canonicalDomain: 'smithlaw.com', email: 'owner@smithlaw.com' });
    expect(run).not.toHaveBeenCalled();
    expect(result.status).toBe('FAILED');
    expect(result.result.preScore.total).toBe(0);
    expect(result.result.preScore.decision).toBe('UNKNOWN');
    expect(result.result.preScore.assessmentStatus).toBe('INSUFFICIENT_EVIDENCE');
    expect(result.result.sources.bar.code).toBe('INSUFFICIENT_IDENTITY');
  });
  it('enforces the global deadline even if an adapter ignores cancellation', async () => {
    const signalSeen: AbortSignal[] = [];
    const pipeline = new InProcessPipeline({ website: { run: (_domain, signal) => { signalSeen.push(signal); return new Promise(() => {}); } },
      bar: { run: failed }, avvo: { run: failed }, repository: new InMemoryRepository(), timeoutMs: 25 });
    const start = Date.now();
    const result = await pipeline.run({ scanId: 'sc_timeout', canonicalDomain: 'firm.com', email: 'owner@firm.com' });
    expect(Date.now() - start).toBeLessThan(1000);
    expect(result.status).toBe('FAILED');
    expect(result.result.sources.website.status).toBe('timeout');
    expect(signalSeen[0]?.aborted).toBe(true);
  });
  it('rejects a missing canonical domain at the pipeline boundary too', async () => {
    const pipeline = new InProcessPipeline({ ...mockSources(), repository: new InMemoryRepository() });
    await expect(pipeline.run({ scanId: 'sc_bad', canonicalDomain: '', email: 'owner@firm.com' })).rejects.toThrow('canonical domain');
  });
  it('runs all three local mock scenarios', async () => {
    const pipeline = new InProcessPipeline({ ...mockSources(), repository: new InMemoryRepository() });
    const minimal = await pipeline.run({ scanId: 'sc_minimal', canonicalDomain: 'minimal.arca.example', email: 'owner@minimal.arca.example' });
    const sanctioned = await pipeline.run({ scanId: 'sc_sanctioned', canonicalDomain: 'sanctioned.arca.example', email: 'owner@sanctioned.arca.example' });
    expect(minimal.result.preScore.total).toBe(25);
    expect(sanctioned.result.preScore.total).toBe(72);
    expect(sanctioned.result.preScore.decision).toBe('REFERRAL_SENIOR');
  });
  it('returns the same domain assessment for corporate and personal requesters', async () => {
    const repository = new InMemoryRepository();
    const { app, drain } = createApp({ repository, pipeline: new InProcessPipeline({ ...mockSources(), repository }),
      domainResolver: new PublicDomainResolver(async () => {}), sessionSecret: 's'.repeat(40), corsOrigins: [], clientIp: () => 'local' });
    const post = (email: string) => app.request('/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: 'robust.arca.example', email }) });
    const first = await (await post('owner@robust.arca.example')).json();
    await drain();
    const firstResult = (await (await app.request(`/scan/${first.scanId}`, { headers: { Authorization: `Bearer ${first.sessionToken}` } })).json()).result;
    const second = await (await post('user@gmail.com')).json();
    expect(second.cached).toBe(true);
    expect(second.result.preScore).toEqual(firstResult.preScore);
    expect(second.result.signals).toEqual(firstResult.signals);
    expect(second.result.email).toBe('user@gmail.com');
  });
});

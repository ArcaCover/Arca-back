import { describe, it, expect, vi } from 'vitest';
import { LAYER1_CONTRACT_VERSION, type Layer1Result, type RenderedQuestion } from '@arca/contracts';
import { RoutingAssessmentRepository, RoutingScanRepository } from '../../src/debug/isolation.js';
import { InMemoryRepository } from '../../src/repositories/in-memory.js';
import type { RawRecord, ScanRecord } from '../../src/repositories/types.js';
import { InMemoryAssessmentRepository, type AssessmentRecord } from '../../src/assessment/repository.js';
import { ScanLimiter } from '../../src/http/rate-limit.js';

const NOW = '2026-10-23T12:00:00.000Z';
const scan = (scanId: string, patch: Partial<ScanRecord> = {}): ScanRecord => ({ id: `id_${scanId}`, scan_id: scanId,
  email: 'owner@firm.com', canonical_domain: 'firm.com',
  domain_resolution: { status: 'RESOLVED', canonicalDomain: 'firm.com', source: 'request', reason: null },
  status: 'RUNNING', result: null, created_at: NOW, completed_at: null, duration_ms: null, cached: false, ...patch });
const completion = { status: 'FAILED', result: null, completed_at: NOW, duration_ms: 5 } as const;
const raw = (scanId: string): RawRecord => ({ scan_id: scanId, source: 'website', raw_content: '{}', content_hash: 'h', fetched_at: NOW });

// Every method of the interface is a spy, so a call that reaches durable storage cannot go unnoticed.
function durableScans() {
  return { create: vi.fn(async () => {}), get: vi.fn(async () => null), complete: vi.fn(async () => {}),
    cached: vi.fn(async () => null), saveRaw: vi.fn(async () => {}), latestRaw: vi.fn(async () => null),
    recoverInterrupted: vi.fn(async () => {}), reserveApifyRun: vi.fn(async () => ({ decision: 'failed' as const, record: null, chargedToScan: false })),
    getApifyRun: vi.fn(async () => null), pendingApifyAccounting: vi.fn(async () => []), updateApifyRun: vi.fn(async () => {}) };
}
function setup() {
  const durable = durableScans();
  const overlay = new InMemoryRepository();
  return { durable, overlay, repository: new RoutingScanRepository(durable, overlay) };
}

describe('scan repository routing', () => {
  it('an isolated scan never touches durable storage', async () => {
    const { durable, overlay, repository } = setup();
    repository.isolate('sc_i');
    expect(repository.isIsolated('sc_i')).toBe(true);
    await repository.create(scan('sc_i'));
    expect(await repository.get('sc_i')).toMatchObject({ scan_id: 'sc_i', status: 'RUNNING' });
    await repository.saveRaw(raw('sc_i'));
    await repository.complete('sc_i', completion);
    for (const spy of Object.values(durable)) expect(spy).not.toHaveBeenCalled();
    expect(await overlay.get('sc_i')).toMatchObject({ scan_id: 'sc_i', status: 'FAILED', duration_ms: 5 });
    expect(overlay.raw).toHaveLength(1);
  });

  it('a clean scan goes to durable storage', async () => {
    const { durable, overlay, repository } = setup();
    expect(repository.isIsolated('sc_c')).toBe(false);
    await repository.create(scan('sc_c'));
    await repository.get('sc_c');
    await repository.saveRaw(raw('sc_c'));
    await repository.complete('sc_c', completion);
    expect(durable.create).toHaveBeenCalledWith(scan('sc_c'));
    expect(durable.get).toHaveBeenCalledWith('sc_c');
    expect(durable.saveRaw).toHaveBeenCalledWith(raw('sc_c'));
    expect(durable.complete).toHaveBeenCalledWith('sc_c', completion);
    expect(overlay.scans.size).toBe(0);
    expect(overlay.raw).toHaveLength(0);
  });

  it('isolating one scan leaves a concurrent clean scan on durable storage', async () => {
    const { durable, overlay, repository } = setup();
    repository.isolate('sc_i');
    await repository.create(scan('sc_i'));
    await repository.create(scan('sc_c'));
    expect(durable.create).toHaveBeenCalledTimes(1);
    expect(durable.create).toHaveBeenCalledWith(scan('sc_c'));
    expect([...overlay.scans.keys()]).toEqual(['sc_i']);
  });

  it('cache and analysis reuse read only durable storage', async () => {
    const { durable, overlay, repository } = setup();
    repository.isolate('sc_i');
    // A finished isolated scan of the same domain that the overlay itself would serve from its cache.
    await repository.create(scan('sc_i', { status: 'COMPLETED', completed_at: NOW,
      result: { meta: { contractVersion: LAYER1_CONTRACT_VERSION } } as Layer1Result }));
    await repository.saveRaw(raw('sc_i'));
    expect(await overlay.cached('firm.com', '2026-01-01T00:00:00.000Z')).not.toBeNull();
    expect(await overlay.latestRaw('firm.com', 'website')).not.toBeNull();
    expect(await repository.cached('firm.com', '2026-01-01T00:00:00.000Z')).toBeNull();
    expect(await repository.latestRaw('firm.com', 'website')).toBeNull();
    expect(durable.cached).toHaveBeenCalledWith('firm.com', '2026-01-01T00:00:00.000Z');
    expect(durable.latestRaw).toHaveBeenCalledWith('firm.com', 'website');
  });

  it('recovering interrupted scans covers both repositories', async () => {
    const { durable, overlay, repository } = setup();
    repository.isolate('sc_i');
    await repository.create(scan('sc_i'));
    await repository.recoverInterrupted('2026-10-23T13:00:00.000Z');
    expect(durable.recoverInterrupted).toHaveBeenCalledWith('2026-10-23T13:00:00.000Z');
    expect((await overlay.get('sc_i'))?.status).toBe('FAILED');
  });

  it('the Apify ledger is durable storage only, even for an isolated scan', async () => {
    const { durable, overlay, repository } = setup();
    repository.isolate('sc_i');
    const request = { queryFingerprint: 'q', actor: 'a', build: 'b', input: {}, expectedCostUsd: 1, expiresAt: NOW };
    await repository.reserveApifyRun(request);
    await repository.getApifyRun('run_1');
    await repository.pendingApifyAccounting(5);
    await repository.updateApifyRun('run_1', { status: 'SUCCEEDED' });
    expect(durable.reserveApifyRun).toHaveBeenCalledWith(request);
    expect(durable.getApifyRun).toHaveBeenCalledWith('run_1');
    expect(durable.pendingApifyAccounting).toHaveBeenCalledWith(5);
    expect(durable.updateApifyRun).toHaveBeenCalledWith('run_1', { status: 'SUCCEEDED' });
    expect(overlay.apifyRuns.size).toBe(0);
    expect(overlay.scanApifyRuns.size).toBe(0);
  });
});

const assessment = (id: string, scanId: string) => ({ id, scan_id: scanId, revision: 0, status: 'PLANNING', bank_version: 'v1',
  bank_snapshot: {}, layer1_snapshot: {}, evidence_snapshot: [], planner: 'rules', planner_model: null, prompt_version: null,
  plan: null, rendered: [], answers: {}, result: null, attested_at: null, created_at: NOW, updated_at: NOW, expires_at: NOW,
  completed_at: null, answer_write_count: 0 }) as unknown as AssessmentRecord;

function durableAssessments() {
  return { create: vi.fn(async (record: AssessmentRecord) => record), get: vi.fn(async () => null), getByScan: vi.fn(async () => null),
    commit: vi.fn(async () => null), planningBefore: vi.fn(async (): Promise<AssessmentRecord[]> => []) };
}
function setupAssessments() {
  const scans = new RoutingScanRepository(durableScans(), new InMemoryRepository());
  scans.isolate('sc_i');
  const durable = durableAssessments();
  const overlay = new InMemoryAssessmentRepository();
  return { durable, overlay, repository: new RoutingAssessmentRepository(durable, overlay, scans) };
}

describe('assessment repository routing', () => {
  it('assessments of isolated scans stay in memory', async () => {
    const { durable, overlay, repository } = setupAssessments();
    const created = await repository.create(assessment('as_i', 'sc_i'));
    expect(created.id).toBe('as_i');
    expect(durable.create).not.toHaveBeenCalled();
    expect(await overlay.get('as_i')).toMatchObject({ id: 'as_i', scan_id: 'sc_i' });
    expect(await repository.get('as_i')).toMatchObject({ id: 'as_i', revision: 0 });
    expect(await repository.getByScan('sc_i')).toMatchObject({ id: 'as_i' });
    const committed = await repository.commit('as_i', 0, { status: 'READY', updated_at: NOW });
    expect(committed).toMatchObject({ id: 'as_i', revision: 1, status: 'READY' });
    expect((await overlay.get('as_i'))?.revision).toBe(1);
    expect(durable.get).not.toHaveBeenCalled();
    expect(durable.getByScan).not.toHaveBeenCalled();
    expect(durable.commit).not.toHaveBeenCalled();
    // The in-memory repository still enforces its own revision check.
    expect(await repository.commit('as_i', 0, { status: 'FAILED' })).toBeNull();
    expect(durable.commit).not.toHaveBeenCalled();
  });

  it('assessments of clean scans go to durable storage', async () => {
    const { durable, overlay, repository } = setupAssessments();
    const record = assessment('as_c', 'sc_c');
    await repository.create(record);
    expect(durable.create).toHaveBeenCalledWith(record);
    await repository.getByScan('sc_c');
    expect(durable.getByScan).toHaveBeenCalledWith('sc_c');
    await repository.get('as_c');
    expect(durable.get).toHaveBeenCalledWith('as_c');
    await repository.commit('as_c', 0, { status: 'READY' }, []);
    expect(durable.commit).toHaveBeenCalledWith('as_c', 0, { status: 'READY' }, []);
    expect(await overlay.get('as_c')).toBeNull();
  });

  it('planning recovery sees the durable and the in-memory assessments', async () => {
    const { durable, repository } = setupAssessments();
    durable.planningBefore.mockResolvedValue([assessment('as_c', 'sc_c')]);
    await repository.create(assessment('as_i', 'sc_i'));
    const stale = await repository.planningBefore('2026-10-23T13:00:00.000Z');
    expect(durable.planningBefore).toHaveBeenCalledWith('2026-10-23T13:00:00.000Z');
    expect(stale.map(record => record.id).sort()).toEqual(['as_c', 'as_i']);
  });
});

describe('clear', () => {
  it('clear empties memory repositories and the limiter', async () => {
    const repository = new InMemoryRepository();
    await repository.create(scan('sc_1'));
    await repository.saveRaw(raw('sc_1'));
    await repository.reserveApifyRun({ scanId: 'sc_1', queryFingerprint: 'q', actor: 'a', build: 'b', input: {}, expectedCostUsd: 1, expiresAt: '2999-01-01T00:00:00.000Z' });
    expect(repository.apifyRuns.size).toBe(1);
    expect(repository.scanApifyRuns.size).toBe(1);
    repository.clear();
    expect(await repository.get('sc_1')).toBeNull();
    expect(repository.raw).toHaveLength(0);
    expect(repository.apifyRuns.size).toBe(0);
    expect(repository.scanApifyRuns.size).toBe(0);

    const assessments = new InMemoryAssessmentRepository();
    await assessments.create(assessment('as_1', 'sc_1'));
    const question = { id: 'q1', text: 'Is there an AI policy?' } as unknown as RenderedQuestion;
    const answer = { kind: 'option', optionId: 'yes' } as const;
    await assessments.commit('as_1', 0, { status: 'IN_PROGRESS', rendered: [question], answers: { q1: answer }, answer_write_count: 1 },
      [{ question_id: 'q1', answer, kind: 'saved', suggested: false, rendered: question, created_at: NOW }]);
    expect(assessments.events).toHaveLength(1);
    assessments.clear();
    expect(await assessments.get('as_1')).toBeNull();
    expect(await assessments.getByScan('sc_1')).toBeNull();
    expect(await assessments.planningBefore('2999-01-01T00:00:00.000Z')).toEqual([]);
    expect(assessments.events).toHaveLength(0);
    // The scan id is free again: a record for it can be created from scratch.
    expect((await assessments.create(assessment('as_2', 'sc_1'))).id).toBe('as_2');

    const limiter = new ScanLimiter(() => 0);
    for (let i = 0; i < 3; i++) expect(limiter.check(`ip${i}`, 'one@firm.com').allowed).toBe(true);
    expect(limiter.check('ip9', 'one@firm.com').allowed).toBe(false);
    limiter.clear();
    expect(limiter.check('ip9', 'one@firm.com').allowed).toBe(true);
  });
});

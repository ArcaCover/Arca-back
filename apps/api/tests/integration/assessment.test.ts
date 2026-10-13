import { describe, expect, it, vi } from 'vitest';
import { SignJWT } from 'jose';
import { createClient } from '@supabase/supabase-js';
import { AssessmentResult, AssessmentView, StartedAssessmentResponse, type AnswerValue, type RenderedQuestion } from '@arca/contracts';
import { rulesPlan, type PlanningAgent } from '@arca/questions';
import { createApp } from '../../src/http/app.js';
import { InMemoryRepository } from '../../src/repositories/in-memory.js';
import { InMemoryAssessmentRepository, SupabaseAssessmentRepository } from '../../src/assessment/repository.js';
import { issueSessionToken } from '../../src/auth/session-token.js';
import { fixtureResult } from '../fixtures/result.js';

const secret = 'assessment-test-secret-'.repeat(3);
async function setup(options: { agent?: PlanningAgent; maxWrites?: number; planningTimeoutMs?: number; assessmentRepository?: InMemoryAssessmentRepository } = {}) {
  let clock = Date.now();
  const repository = new InMemoryRepository();
  const assessmentRepository = options.assessmentRepository ?? new InMemoryAssessmentRepository();
  const scanId = 'sc_assessment';
  await repository.create({ id: 'fixture', scan_id: scanId, canonical_domain: 'firm.com', email: 'user@firm.com',
    domain_resolution: { status: 'RESOLVED', canonicalDomain: 'firm.com', source: 'request', reason: null },
    status: 'COMPLETED', result: fixtureResult(scanId), created_at: new Date(clock).toISOString(), completed_at: new Date(clock).toISOString(), duration_ms: 10, cached: false });
  const deps = { repository, assessmentRepository, domainResolver: { resolve: vi.fn() }, pipeline: { run: vi.fn() },
    sessionSecret: secret, corsOrigins: ['http://localhost:3000'], clientIp: () => '127.0.0.1', now: () => clock,
    assessmentAgent: options.agent, assessmentMaxWritesPerMinute: options.maxWrites, assessmentPlanningTimeoutMs: options.planningTimeoutMs };
  const application = createApp(deps);
  const token = await issueSessionToken(scanId, 'user@firm.com', secret);
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const request = (path: string, method = 'GET', body?: unknown, customHeaders = headers) => application.app.request(path,
    { method, headers: customHeaders, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  async function start() {
    const response = await request(`/scan/${scanId}/assessment`, 'POST');
    expect(response.status).toBe(202);
    const body = StartedAssessmentResponse.parse(await response.json());
    await application.drain();
    return body.assessmentId;
  }
  async function view(id: string) { const response = await request(`/assessment/${id}`); expect(response.status).toBe(200); return AssessmentView.parse(await response.json()); }
  async function save(id: string, qid: string, answer: AnswerValue) { return request(`/assessment/${id}/answers/${qid}`, 'PUT', { answer }); }
  return { ...application, deps, repository, assessmentRepository, scanId, token, headers, request, start, view, save,
    advance: (milliseconds: number) => { clock += milliseconds; } };
}
function answerFor(question: RenderedQuestion): AnswerValue {
  if (question.type === 'multi_select') return { kind: 'options', optionIds: [question.options![0]!.id] };
  if (question.type === 'scale') return { kind: 'scale', value: question.scale!.max };
  if (question.type === 'number') return { kind: 'number', value: question.number!.min };
  return { kind: 'option', optionId: question.options![0]!.id };
}
async function fillAll(s: Awaited<ReturnType<typeof setup>>, id: string) {
  for (let i = 0; i < 20; i++) {
    const view = await s.view(id);
    const question = view.questions.find(question => !view.answers[question.id]);
    if (!question) return;
    expect((await s.save(id, question.id, answerFor(question))).status).toBe(200);
  }
  throw new Error('Questionnaire never finished');
}

describe('Layer 2 assessment API', () => {
  it('starts asynchronously and idempotently; never exposes points, weights or raw snapshots', async () => {
    const s = await setup();
    const starts = await Promise.all(Array.from({ length: 5 }, () => s.request(`/scan/${s.scanId}/assessment`, 'POST')));
    const bodies = await Promise.all(starts.map(response => response.json()));
    expect(new Set(bodies.map(body => body.assessmentId)).size).toBe(1);
    await s.drain();
    const id = bodies[0].assessmentId;
    const view = await s.view(id);
    expect(view).toMatchObject({ status: 'READY', planner: 'rules', bankStatus: 'DEMO', sessionScope: 'CURRENT_TAB_24H', skipped: [] });
    expect(view.questions.length).toBeGreaterThanOrEqual(8);
    const encoded = JSON.stringify(view);
    expect(encoded).not.toContain('maxPoints'); expect(encoded).not.toContain('"points"');
    expect(encoded).not.toContain('layer1_snapshot'); expect(encoded).not.toContain('user@firm.com');
    const repeated = await s.request(`/scan/${s.scanId}/assessment`, 'POST');
    expect(repeated.status).toBe(200); expect(await repeated.json()).toEqual({ assessmentId: id, status: 'READY' });
  });
  it('dispatches the optional agent once across repeated and competing creates', async () => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const plan = vi.fn(async (input: Parameters<PlanningAgent['plan']>[0]) => {
      await pending; return rulesPlan(input.bank, input.layer1, input.evidence);
    });
    const s = await setup({ agent: { model: 'fixture-agent', plan } });
    const responses = await Promise.all(Array.from({ length: 6 }, () => s.request(`/scan/${s.scanId}/assessment`, 'POST')));
    expect(responses.map(response => response.status)).toEqual(Array(6).fill(202));
    const body = await responses[0]!.json();
    const secondApp = createApp(s.deps);
    expect((await secondApp.app.request(`/scan/${s.scanId}/assessment`, { method: 'POST', headers: s.headers })).status).toBe(202);
    expect(plan).toHaveBeenCalledTimes(1);
    release(); await s.drain();
    expect((await s.view(body.assessmentId)).status).toBe('READY');
  });
  it('guards every endpoint with the original scan and email capability and rejects expired tokens', async () => {
    const s = await setup(); const id = await s.start();
    const otherScan = await issueSessionToken('sc_other', 'user@firm.com', secret);
    const otherEmail = await issueSessionToken(s.scanId, 'other@firm.com', secret);
    const expired = await new SignJWT({ email: 'user@firm.com' }).setProtectedHeader({ alg: 'HS256' }).setSubject(s.scanId)
      .setIssuer('arca-api').setAudience('arca-scan').setExpirationTime(1).sign(new TextEncoder().encode(secret));
    for (const token of ['', otherScan, otherEmail, expired]) for (const [path, method, body] of [
      [`/scan/${s.scanId}/assessment`, 'POST', undefined], [`/assessment/${id}`, 'GET', undefined],
      [`/assessment/${id}/answers/D1.1`, 'PUT', { answer: { kind: 'option', optionId: 'none' } }],
      [`/assessment/${id}/complete`, 'POST', { attestation: true }], [`/assessment/${id}/result`, 'GET', undefined],
    ] as const) {
      expect((await s.request(path, method, body, { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' })).status).toBe(401);
    }
  });
  it('rejects unready scans, invisible questions, invalid kinds/options/steps, and oversized requests', async () => {
    const s = await setup();
    await s.repository.complete(s.scanId, { status: 'FAILED', result: null, completed_at: new Date().toISOString(), duration_ms: 0 });
    expect((await s.request(`/scan/${s.scanId}/assessment`, 'POST')).status).toBe(409);
    await s.repository.complete(s.scanId, { status: 'COMPLETED', result: fixtureResult(s.scanId), completed_at: new Date().toISOString(), duration_ms: 0 });
    const id = await s.start();
    expect((await s.save(id, 'D1.1a', { kind: 'option', optionId: 'yearly' })).status).toBe(409);
    for (const [qid, answer] of [ ['D1.1', { kind: 'number', value: 1 }], ['D1.1', { kind: 'option', optionId: 'invented' }],
      ['D3.1', { kind: 'scale', value: 2.5 }], ['D5.1', { kind: 'number', value: -1 }],
      ['D2.1', { kind: 'options', optionIds: ['none', 'consumer'] }], ['D2.1', { kind: 'options', optionIds: ['consumer', 'consumer'] }],
    ] as const) expect((await s.request(`/assessment/${id}/answers/${qid}`, 'PUT', { answer })).status).toBe(400);
    expect((await s.request(`/assessment/${id}/answers/D1.1`, 'PUT', { answer: { kind: 'option', optionId: 'x'.repeat(20_000) } })).status).toBe(413);
    expect(s.assessmentRepository.events).toHaveLength(0);
  });
  it('persists answer changes and audits hidden-answer invalidation without resurrecting stale answers', async () => {
    const s = await setup(); const id = await s.start();
    expect((await s.save(id, 'D1.1', { kind: 'option', optionId: 'written_shared' })).status).toBe(200);
    expect((await s.view(id)).questions.some(question => question.id === 'D1.1a')).toBe(true);
    expect((await s.save(id, 'D1.1a', { kind: 'option', optionId: 'yearly' })).status).toBe(200);
    expect((await s.save(id, 'D1.1', { kind: 'option', optionId: 'none' })).status).toBe(200);
    const hidden = await s.view(id);
    expect(hidden.answers).not.toHaveProperty('D1.1a');
    expect(hidden.questions.some(question => question.id === 'D1.1a')).toBe(false);
    expect(s.assessmentRepository.events.at(-1)).toMatchObject({ question_id: 'D1.1a', kind: 'invalidated', answer: null });
    await s.save(id, 'D1.1', { kind: 'option', optionId: 'written_shared' });
    expect((await s.view(id)).answers).not.toHaveProperty('D1.1a');
    const saved = await s.assessmentRepository.get(id);
    expect(saved!.rendered.filter(question => question.id === 'D1.1a')).toHaveLength(1);
    expect(s.assessmentRepository.events[1]!.rendered).toEqual(saved!.rendered.find(question => question.id === 'D1.1a'));
  });
  it('keeps simultaneous answer writes and completes exactly once after truthfulness attestation', async () => {
    const s = await setup(); const id = await s.start();
    expect((await s.request(`/assessment/${id}/complete`, 'POST', { attestation: true })).status).toBe(409);
    expect((await s.request(`/assessment/${id}/complete`, 'POST', { attestation: false })).status).toBe(400);
    const saved = await Promise.all([s.save(id, 'D1.2', { kind: 'option', optionId: 'yes' }), s.save(id, 'D6.1', { kind: 'option', optionId: 'yes' })]);
    expect(saved.map(response => response.status)).toEqual([200, 200]);
    expect((await s.view(id)).answers).toMatchObject({ 'D1.2': { optionId: 'yes' }, 'D6.1': { optionId: 'yes' } });
    await fillAll(s, id);
    const completed = await Promise.all(Array.from({ length: 5 }, () => s.request(`/assessment/${id}/complete`, 'POST', { attestation: true })));
    const results = await Promise.all(completed.map(async response => { expect(response.status).toBe(200); return AssessmentResult.parse(await response.json()); }));
    for (const result of results) expect(result).toEqual(results[0]);
    expect(results[0]).toMatchObject({ bankStatus: 'DEMO', commercialDecisionBlocked: true, decision: 'UNKNOWN' });
    expect(await (await s.request(`/assessment/${id}/result`)).json()).toEqual(results[0]);
    const count = s.assessmentRepository.events.length;
    expect((await s.save(id, 'D1.2', { kind: 'option', optionId: 'no' })).status).toBe(409);
    expect(s.assessmentRepository.events).toHaveLength(count);
    expect(await (await s.request(`/scan/${s.scanId}/assessment`, 'POST')).json()).toEqual({ assessmentId: id, status: 'COMPLETED' });
  });
  it('resumes from persisted snapshots with another app instance while a fresh memory repository loses data', async () => {
    const s = await setup(); const id = await s.start();
    await s.save(id, 'D1.2', { kind: 'option', optionId: 'yes' });
    const before = await s.assessmentRepository.get(id);
    s.repository.scans.get(s.scanId)!.result!.preScore.total = 99;
    const second = createApp(s.deps);
    const response = await second.app.request(`/assessment/${id}`, { headers: s.headers });
    expect(AssessmentView.parse(await response.json()).answers['D1.2']).toEqual({ kind: 'option', optionId: 'yes' });
    expect((await s.assessmentRepository.get(id))!.layer1_snapshot.preScore.total).toBe(before!.layer1_snapshot.preScore.total);
    expect(await new InMemoryAssessmentRepository().get(id)).toBeNull();
  });
  it('falls back after agent errors or timeout and recovers stale planning from the frozen bank', async () => {
    for (const agent of [{ model: 'fixture', plan: vi.fn(async () => { throw new Error('Fixture unavailable'); }) },
      { model: 'fixture', plan: vi.fn(() => new Promise<never>(() => {})) }]) {
      const s = await setup({ agent, planningTimeoutMs: 15 }); const id = await s.start();
      expect((await s.view(id)).planner).toBe('rules');
      const ready = (await s.assessmentRepository.get(id))!;
      const replacement = new InMemoryAssessmentRepository();
      await replacement.create({ ...ready, status: 'PLANNING', revision: 0, plan: null, rendered: [], updated_at: new Date(Date.now() - 60_000).toISOString() });
      const recovered = createApp({ ...s.deps, assessmentRepository: replacement });
      await recovered.recoverAssessments();
      expect(await replacement.get(id)).toMatchObject({ status: 'READY', bank_version: ready.bank_version, plan: ready.plan });
    }
  });
  it('tracks accepted suggestions and the validated agent model/prompt without trusting novel context', async () => {
    const agent: PlanningAgent = { model: 'fixture-agent', plan: async input => rulesPlan(input.bank, input.layer1, input.evidence) };
    const s = await setup({ agent });
    const scan = s.repository.scans.get(s.scanId)!;
    scan.result!.signals.website.W1_aiPolicy.found = true;
    const id = await s.start();
    expect((await s.view(id)).planner).toBe('agent');
    const q = (await s.view(id)).questions.find(question => question.id === 'D1.1')!;
    expect(q.suggestedAnswer).toEqual({ kind: 'option', optionId: 'public_only' });
    await s.save(id, q.id, q.suggestedAnswer!);
    expect(s.assessmentRepository.events[0]!.suggested).toBe(true);
    expect(await s.assessmentRepository.get(id)).toMatchObject({ planner_model: 'fixture-agent', prompt_version: expect.any(String) });
  });
  it('expires at the original scan deadline and limits writes per assessment', async () => {
    const s = await setup({ maxWrites: 2 }); const id = await s.start();
    await s.save(id, 'D1.2', { kind: 'option', optionId: 'yes' });
    await s.save(id, 'D1.2', { kind: 'option', optionId: 'no' });
    const limited = await s.save(id, 'D1.2', { kind: 'option', optionId: 'yes' });
    expect(limited.status).toBe(429); expect(limited.headers.get('Retry-After')).toBe('60');
    s.advance(86_400_001);
    expect((await s.request(`/assessment/${id}`)).status).toBe(410);
    expect((await s.assessmentRepository.get(id))!.status).toBe('EXPIRED');
    expect((await s.request(`/scan/${s.scanId}/assessment`, 'POST')).status).toBe(410);
  });
  it('does not acknowledge or audit a save when atomic persistence fails', async () => {
    const s = await setup(); const id = await s.start();
    const spy = vi.spyOn(s.assessmentRepository, 'commit').mockRejectedValueOnce(new Error('Fixture database unavailable'));
    expect((await s.save(id, 'D1.2', { kind: 'option', optionId: 'yes' })).status).toBe(500);
    expect((await s.view(id)).answers).toEqual({}); expect(s.assessmentRepository.events).toHaveLength(0);
    spy.mockRestore();
  });
  it('allows authenticated PUT from the configured frontend origin', async () => {
    const s = await setup(); const id = await s.start();
    const response = await s.app.request(`/assessment/${id}/answers/D1.2`, { method: 'OPTIONS', headers: {
      Origin: 'http://localhost:3000', 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'authorization,content-type' } });
    expect(response.headers.get('Access-Control-Allow-Methods')).toContain('PUT');
  });
});

describe('Supabase assessment adapter', () => {
  it('sends a single atomic CAS RPC including all answer audit events and returns conflict as null', async () => {
    const transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(new URL(String(input)).pathname).toBe('/rest/v1/rpc/update_assessment');
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({ p_id: 'as_fixture', p_revision: 7, p_update: { status: 'IN_PROGRESS' }, p_events: [] });
      return Response.json(null);
    });
    const client = createClient('https://fixture.supabase.co', 'sb_secret_fixture', { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: transport } });
    expect(await new SupabaseAssessmentRepository(client).commit('as_fixture', 7, { status: 'IN_PROGRESS' })).toBeNull();
    expect(transport).toHaveBeenCalledTimes(1);
  });
});

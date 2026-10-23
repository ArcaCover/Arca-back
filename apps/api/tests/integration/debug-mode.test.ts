import { describe, it, expect, vi, afterEach } from 'vitest';
import { AssessmentView, PollResponse, ScanResponse, StartedAssessmentResponse, type DirectorySource,
  type PipelineResult } from '@arca/contracts';
import { DEBUG_PRESETS, DEBUG_SCENARIO_HEADER, DebugModeResponse, DebugScanState, DebugScenario,
  type DebugScenarioInput } from '@arca/contracts/debug';
import { rulesPlan, type PlanningAgent } from '@arca/questions';
import { createApp } from '../../src/http/app.js';
import { createDebugTools } from '../../src/debug/tools.js';
import { RoutingAssessmentRepository, RoutingScanRepository } from '../../src/debug/isolation.js';
import { LATENCY_MS } from '../../src/debug/sources.js';
import { InMemoryRepository } from '../../src/repositories/in-memory.js';
import { InMemoryAssessmentRepository } from '../../src/assessment/repository.js';
import { InProcessPipeline } from '../../src/pipeline/in-process-pipeline.js';
import { mockSources, MOCK_DOMAINS } from '../../src/pipeline/mock-sources.js';
import { PublicDomainResolver } from '../../src/pipeline/domain-resolution.js';
import { fixtureResult } from '../fixtures/result.js';

const secret = 's'.repeat(40);
const origin = 'http://localhost:3000';
type App = ReturnType<typeof createApp>['app'];
const preflight = (app: App) => app.request('/scan', { method: 'OPTIONS', headers: { Origin: origin,
  'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type, x-arca-debug-scenario' } });
// Lets the scan's own timers run on a fake clock while authorization and file reads still run on real I/O.
async function untilTimers(count: number) {
  for (let turn = 0; turn < 1000 && vi.getTimerCount() < count; turn++) await new Promise(resolve => setImmediate(resolve));
}

afterEach(() => { vi.useRealTimers(); });

describe('production wiring', () => {
  function production() {
    const run = vi.fn(async (): Promise<PipelineResult> => ({ status: 'PARTIAL', result: fixtureResult() }));
    const application = createApp({ domainResolver: new PublicDomainResolver(async () => {}), repository: new InMemoryRepository(),
      pipeline: { run }, sessionSecret: secret, corsOrigins: [origin], clientIp: () => '127.0.0.1' });
    const post = (scenario: string) => application.app.request('/scan', { method: 'POST',
      headers: { 'Content-Type': 'application/json', [DEBUG_SCENARIO_HEADER]: scenario },
      body: JSON.stringify({ email: 'user@firm.com', domain: 'firm.com' }) });
    return { ...application, run, post };
  }

  it('registers no debug route', async () => {
    const { app } = production();
    expect((await app.request('/__debug/mode')).status).toBe(404);
    expect((await app.request('/__debug/scan/sc_x')).status).toBe(404);
    expect((await app.request('/__debug/reset', { method: 'POST' })).status).toBe(404);
  });

  it('runs a scan that carries a scenario header as a normal scan', async () => {
    const { app, drain, run, post } = production();
    const response = await post('{"bar":"apify_quota"}');
    expect(response.status).toBe(202);
    const started = ScanResponse.parse(await response.json());
    await drain();
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith({ scanId: started.scanId, canonicalDomain: 'firm.com', email: 'user@firm.com' });
    const poll = PollResponse.parse(await (await app.request(`/scan/${started.scanId}`,
      { headers: { Authorization: `Bearer ${started.sessionToken}` } })).json());
    expect(poll.status).toBe('PARTIAL');
    // The sources are the spy pipeline's, not an injected Apify quota error.
    expect(poll.result?.sources).toEqual(fixtureResult().sources);
  });

  it('ignores a malformed scenario header instead of rejecting the scan', async () => {
    const { drain, run, post } = production();
    expect((await post('{not json')).status).toBe(202);
    await drain();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('never admits the scenario header in CORS', async () => {
    const response = await preflight(production().app);
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type,Authorization');
  });
});

const DOMAIN = 'robust.arca.example';
const description = (mode: 'mock' | 'live-debug'): DebugModeResponse => ({ mode, sourceMode: mode === 'mock' ? 'mock' : 'live',
  storageBackend: mode === 'mock' ? 'memory' : 'supabase', websiteEvidenceProvider: 'agentic', assessmentPlanner: 'rules',
  signalLlmModel: 'fixture-model', configured: { openai: mode !== 'mock', apify: mode !== 'mock', supabase: mode !== 'mock' } });

function debugSetup(options: { mode?: 'mock' | 'live-debug'; gate?: Promise<void>; assessmentAgent?: PlanningAgent;
  assessmentPlanningTimeoutMs?: number } = {}) {
  const mode = options.mode ?? 'live-debug';
  // Stands in for Supabase: a working repository whose every call is observed.
  const durable = new InMemoryRepository();
  const durableSpy = { create: vi.spyOn(durable, 'create'), complete: vi.spyOn(durable, 'complete'),
    saveRaw: vi.spyOn(durable, 'saveRaw'), cached: vi.spyOn(durable, 'cached') };
  const scans = new RoutingScanRepository(durable, new InMemoryRepository());
  const assessments = new RoutingAssessmentRepository(new InMemoryAssessmentRepository(), new InMemoryAssessmentRepository(), scans);
  const base = mockSources();
  // Records each query the real directories receive. Mock sources ignore `scanId`, so only this shows which id
  // would reach the Apify ledger in live-debug.
  const directoryRuns = { bar: vi.fn<DirectorySource['run']>((query, signal) => base.bar.run(query, signal)),
    avvo: vi.fn<DirectorySource['run']>((query, signal) => base.avvo.run(query, signal)) };
  const observed = { ...base, bar: { ...base.bar, run: directoryRuns.bar }, avvo: { ...base.avvo, run: directoryRuns.avvo } };
  const gate = options.gate;
  // The gate holds every website read, clean or injected, so two scans can be kept in flight together.
  const sources = gate ? { ...observed, website: { run: async (domain: string, signal: AbortSignal) => {
    await gate; return base.website.run(domain, signal);
  } } } : observed;
  const clearDurableMemory = vi.fn();
  const toolOptions = { mode, describe: description(mode), sources, scans, assessments, pipelineTimeoutMs: 600_000, clearDurableMemory };
  const debug = createDebugTools(toolOptions);
  const pipeline = new InProcessPipeline({ ...sources, repository: scans, timeoutMs: 600_000 });
  const run = vi.spyOn(pipeline, 'run');
  const renderReport = vi.fn(async () => new Uint8Array(new ArrayBuffer(4)));
  const application = createApp({ repository: scans, assessmentRepository: assessments, pipeline, debug, renderReport,
    domainResolver: new PublicDomainResolver(async url => {
      if (!(MOCK_DOMAINS as readonly string[]).includes(new URL(url).hostname)) throw new Error('Unknown mock domain');
    }),
    sessionSecret: secret, corsOrigins: [origin], clientIp: () => '127.0.0.1',
    assessmentAgent: options.assessmentAgent, assessmentPlanningTimeoutMs: options.assessmentPlanningTimeoutMs });
  const post = (scenario?: DebugScenarioInput | string, email = `owner@${DOMAIN}`, domain = DOMAIN) => application.app.request('/scan', {
    method: 'POST', body: JSON.stringify({ email, domain }), headers: { 'Content-Type': 'application/json',
      ...(scenario === undefined ? {} : { [DEBUG_SCENARIO_HEADER]: typeof scenario === 'string' ? scenario : JSON.stringify(scenario) }) } });
  async function start(scenario?: DebugScenarioInput, email?: string, domain?: string) {
    const response = await post(scenario, email, domain);
    expect(response.status).toBe(202);
    return ScanResponse.parse(await response.json());
  }
  type Started = Awaited<ReturnType<typeof start>>;
  const auth = (started: Started) => ({ Authorization: `Bearer ${started.sessionToken}` });
  const poll = (started: Started) => application.app.request(`/scan/${started.scanId}`, { headers: auth(started) });
  async function final(started: Started) {
    const response = await poll(started);
    expect(response.status).toBe(200);
    return PollResponse.parse(await response.json());
  }
  async function finish(scenario?: DebugScenarioInput) {
    const started = await start(scenario);
    await application.drain();
    return { started, final: await final(started) };
  }
  return { ...application, debug, toolOptions, durableSpy, scans, assessments, run, directoryRuns, renderReport, clearDurableMemory,
    post, start, auth, poll, final, finish };
}

describe('debug wiring', () => {
  it('admits the scenario header in CORS', async () => {
    const response = await preflight(debugSetup().app);
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type,Authorization,X-Arca-Debug-Scenario');
  });

  it('injected scan is isolated and ends as its sources dictate', async () => {
    const s = debugSetup();
    const { started, final } = await s.finish({ avvo: 'error' });
    expect(final.status).toBe('PARTIAL');
    expect(final.result?.sources.avvo.status).toBe('error');
    for (const spy of Object.values(s.durableSpy)) expect(spy).not.toHaveBeenCalled();
    expect(s.scans.overlay.scans.get(started.scanId)?.status).toBe('PARTIAL');
    expect(s.scans.overlay.raw.length).toBeGreaterThan(0);
    expect(s.run).not.toHaveBeenCalled();
  });

  it('apify quota preset ends PARTIAL with the real quota reason', async () => {
    const { final } = await debugSetup().finish(DEBUG_PRESETS.apify_quota.scenario);
    expect(final.status).toBe('PARTIAL');
    expect(final.result?.sources.bar.reason).toContain('Apify usage limit reached');
    expect(final.result?.sources.avvo.reason).toContain('Apify usage limit reached');
  });

  it('identity preset ends PARTIAL with skipped directories', async () => {
    const { final } = await debugSetup().finish(DEBUG_PRESETS.no_identity.scenario);
    expect(final.status).toBe('PARTIAL');
    expect(final.result?.sources.bar.code).toBe('INSUFFICIENT_IDENTITY');
    expect(final.result?.sources.avvo.code).toBe('INSUFFICIENT_IDENTITY');
  });

  it('every source down ends FAILED', async () => {
    const { final } = await debugSetup().finish(DEBUG_PRESETS.all_down.scenario);
    expect(final.status).toBe('FAILED');
  });

  it('a scan without a scenario still uses the durable repository and the cache', async () => {
    const s = debugSetup();
    const { started, final } = await s.finish();
    expect(final.status).toBe('COMPLETED');
    expect(s.durableSpy.create).toHaveBeenCalledTimes(1);
    expect(s.durableSpy.cached).toHaveBeenCalledWith(DOMAIN, expect.any(String));
    expect(s.durableSpy.complete).toHaveBeenCalledWith(started.scanId, expect.objectContaining({ status: 'COMPLETED' }));
    expect(s.scans.isIsolated(started.scanId)).toBe(false);
    expect(s.run).toHaveBeenCalledTimes(1);
    // A scenario that injects nothing is a normal scan too, so it is served from the domain cache.
    const again = await s.post({}, `other@${DOMAIN}`);
    expect(again.status).toBe(200);
    expect(ScanResponse.parse(await again.json()).cached).toBe(true);
    expect(s.durableSpy.cached).toHaveBeenCalledTimes(2);
  });

  it.each(['clean', 'injected'])('injected scans never share an in-flight pipeline (%s scan first)', async first => {
    let release!: () => void;
    const s = debugSetup({ gate: new Promise<void>(resolve => { release = resolve; }) });
    const clean = () => s.start(undefined, `clean@${DOMAIN}`);
    const injected = () => s.start({ avvo: 'error' }, `injected@${DOMAIN}`);
    let cleanScan, injectedScan;
    if (first === 'clean') { cleanScan = await clean(); injectedScan = await injected(); }
    else { injectedScan = await injected(); cleanScan = await clean(); }
    release();
    await s.drain();
    const cleanFinal = await s.final(cleanScan), injectedFinal = await s.final(injectedScan);
    expect(cleanFinal.status).toBe('COMPLETED');
    expect(cleanFinal.result?.meta.reusedEvidence).toBe(false);
    expect(injectedFinal.status).toBe('PARTIAL');
    expect(injectedFinal.result?.meta.reusedEvidence).toBe(false);
    expect(s.run).toHaveBeenCalledTimes(1);
  });

  // DN-09 5.5 and 8.5: an injected scan has no row in `scans`, so a real directory left on `default` must reserve in the
  // Apify ledger without its scanId. With the id, the reservation would hit the foreign key and show an error nobody injected.
  it.each([
    { real: 'bar', scenario: { avvo: 'error' } },
    { real: 'avvo', scenario: { bar: 'error' } },
  ] as const)('the real $real directory of an injected scan is asked without its scanId', async ({ real, scenario }) => {
    const s = debugSetup();
    const injected = real === 'bar' ? 'avvo' : 'bar';
    const { started, final } = await s.finish(scenario);
    expect(final.status).toBe('PARTIAL');
    expect(final.result?.sources[real].status).toBe('ok');
    expect(s.directoryRuns[injected]).not.toHaveBeenCalled();
    expect(s.directoryRuns[real]).toHaveBeenCalledTimes(1);
    const [query] = s.directoryRuns[real].mock.calls[0]!;
    expect(query.canonicalDomain).toBe(DOMAIN);
    expect(query.scanId).toBeUndefined();
    expect(JSON.stringify(query)).not.toContain(started.scanId);
    // A clean scan still hands the real directory its own id, as production does.
    const clean = await s.start(undefined, `clean@${DOMAIN}`);
    await s.drain();
    expect(s.directoryRuns[real]).toHaveBeenCalledTimes(2);
    expect(s.directoryRuns[real].mock.calls[1]![0].scanId).toBe(clean.scanId);
  });

  it('a slow scan runs on the configured budget, so the website does not end in timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const s = debugSetup({ mode: 'mock' });
    const started = await s.start({ latency: 'slow' });
    // The pipeline deadline and the simulated latency. The default 55 s budget would abort the scan at 50 s.
    await untilTimers(2);
    await vi.advanceTimersByTimeAsync(LATENCY_MS.slow);
    await s.drain();
    const final = await s.final(started);
    expect(final.status).toBe('COMPLETED');
    expect(final.result?.sources.website.status).toBe('ok');
  });

  it('start faults answer before the limiter', async () => {
    const s = debugSetup();
    const email = `owner@${DOMAIN}`;
    for (let attempt = 0; attempt < 4; attempt++) {
      const response = await s.post({ http: { start: 'rate_limited' } }, email);
      expect(response.status).toBe(429);
      expect(response.headers.get('Retry-After')).toBe('120');
      expect(await response.json()).toEqual({ error: 'rate_limited', message: 'Scan request limit exceeded' });
    }
    const failed = await s.post({ http: { start: 'server_error' } }, email);
    expect(failed.status).toBe(500);
    expect(await failed.json()).toMatchObject({ error: 'internal_error' });
    expect(s.scans.overlay.scans.size).toBe(0);
    expect(s.durableSpy.create).not.toHaveBeenCalled();
    // The real limiter still holds this email's three attempts.
    for (let attempt = 0; attempt < 3; attempt++) expect((await s.post({ avvo: 'error' }, email)).status).toBe(202);
    await s.drain();
  });

  describe('poll faults', () => {
    it('a server error spoils the first two polls only', async () => {
      const s = debugSetup();
      const started = await s.start({ http: { poll: 'server_error' } });
      await s.drain();
      // Faults apply after authorization: a poll without the token neither sees one nor uses one up.
      expect((await s.app.request(`/scan/${started.scanId}`)).status).toBe(401);
      const responses = [await s.poll(started), await s.poll(started), await s.poll(started)];
      expect(responses.map(response => response.status)).toEqual([500, 500, 200]);
      expect(await responses[0]!.json()).toMatchObject({ error: 'internal_error' });
    });

    it('an expired session answers 401 on every poll', async () => {
      const s = debugSetup();
      const started = await s.start({ http: { poll: 'unauthorized' } });
      await s.drain();
      for (let attempt = 0; attempt < 4; attempt++) {
        const response = await s.poll(started);
        expect(response.status).toBe(401);
        expect(await response.json()).toMatchObject({ error: 'unauthorized' });
      }
    });

    it('a hung poll answers only after 16 seconds', async () => {
      const s = debugSetup();
      const started = await s.start({ http: { poll: 'hang' } });
      await s.drain();
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      let answered = false;
      const pending = s.poll(started).then(response => { answered = true; return response; });
      await untilTimers(1);
      await vi.advanceTimersByTimeAsync(15_999);
      expect(answered).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const response = await pending;
      expect(response.status).toBe(200);
      expect(PollResponse.parse(await response.json()).status).toBe('COMPLETED');
    });
  });

  it('report fault answers 503 without rendering', async () => {
    const s = debugSetup();
    const { started, final } = await s.finish({ http: { report: 'unavailable' } });
    expect(final.status).toBe('COMPLETED');
    const response = await s.app.request(`/scan/${started.scanId}/report.pdf`, { headers: s.auth(started) });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'report_unavailable', message: 'Injected report failure' });
    expect(s.renderReport).not.toHaveBeenCalled();
  });

  it('planner timeout falls back to rules', async () => {
    // A working agent is wired, so a rules plan can only come from the injected stall.
    const agent: PlanningAgent = { model: 'fixture-agent', plan: async input => rulesPlan(input.bank, input.layer1, input.evidence) };
    const s = debugSetup({ assessmentAgent: agent, assessmentPlanningTimeoutMs: 50 });
    const { started } = await s.finish({ planner: 'timeout' });
    const response = await s.app.request(`/scan/${started.scanId}/assessment`, { method: 'POST', headers: s.auth(started) });
    expect(response.status).toBe(202);
    const { assessmentId } = StartedAssessmentResponse.parse(await response.json());
    await s.drain();
    const view = AssessmentView.parse(await (await s.app.request(`/assessment/${assessmentId}`, { headers: s.auth(started) })).json());
    expect(view).toMatchObject({ status: 'READY', planner: 'rules' });
    expect(await s.assessments.overlay.get(assessmentId)).not.toBeNull();
    // The stalled planner gives up as soon as it is aborted, so its planning job ends instead of leaking.
    const stalled = s.debug.assessmentAgentFor(started.scanId)!;
    const controller = new AbortController();
    const plan = stalled.plan({} as never, controller.signal);
    controller.abort(new Error('Planner timeout'));
    await expect(plan).rejects.toThrow('Planner timeout');
    expect(s.debug.assessmentAgentFor('sc_unknown')).toBeUndefined();
  });

  it('/__debug/scan requires the scan token and never returns the email', async () => {
    const s = debugSetup();
    const { started } = await s.finish({ avvo: 'error' });
    const clean = await s.start(undefined, `clean@${DOMAIN}`);
    await s.drain();
    const path = `/__debug/scan/${started.scanId}`;
    expect((await s.app.request(path)).status).toBe(401);
    expect((await s.app.request(path, { headers: s.auth(clean) })).status).toBe(401);
    const response = await s.app.request(path, { headers: s.auth(started) });
    expect(response.status).toBe(200);
    const body = await response.json();
    const state = DebugScanState.parse(body);
    expect(JSON.stringify(body)).not.toContain(`owner@${DOMAIN}`);
    expect(state).toMatchObject({ scanId: started.scanId, status: 'PARTIAL', canonicalDomain: DOMAIN, cached: false,
      storage: 'memory', injected: true, scenario: DebugScenario.parse({ avvo: 'error' }) });
    expect(state.domainResolution).toEqual({ status: 'RESOLVED', canonicalDomain: DOMAIN, source: 'request', reason: null });
    expect(state.sources?.avvo.status).toBe('error');
    const cleanState = DebugScanState.parse(await (await s.app.request(`/__debug/scan/${clean.scanId}`, { headers: s.auth(clean) })).json());
    expect(cleanState).toMatchObject({ status: 'COMPLETED', storage: 'supabase', injected: false, scenario: null });
  });

  // DN-09 5.2: the per-source codes, reasons and durations matter most when the scan failed, and a FAILED record stores no result.
  it('/__debug/scan keeps the per-source diagnostics of a failed scan, which its poll does not carry', async () => {
    const s = debugSetup();
    const internal = async (started: Parameters<typeof s.auth>[0]) => {
      const response = await s.app.request(`/__debug/scan/${started.scanId}`, { headers: s.auth(started) });
      expect(response.status).toBe(200);
      return DebugScanState.parse(await response.json());
    };
    const { started, final } = await s.finish(DEBUG_PRESETS.all_down.scenario);
    expect(final.status).toBe('FAILED');
    expect(final.result).toBeUndefined();
    const state = await internal(started);
    expect(state).toMatchObject({ status: 'FAILED', storage: 'memory', injected: true });
    expect(state.sources?.website).toMatchObject({ status: 'error', code: 'PROVIDER_ERROR', reason: 'Source unavailable' });
    // With the site unreadable there is no identity to look up, so the real pipeline skips both directories.
    expect(state.sources?.bar).toMatchObject({ status: 'skipped', code: 'INSUFFICIENT_IDENTITY' });
    expect(state.sources?.avvo).toMatchObject({ status: 'skipped', code: 'INSUFFICIENT_IDENTITY' });
    expect(typeof state.sources?.website.durationMs).toBe('number');
    // A clean failure keeps them too: the fixture's site refuses every request.
    const clean = await s.start(undefined, 'owner@failed.arca.example', 'failed.arca.example');
    await s.drain();
    expect((await s.final(clean)).status).toBe('FAILED');
    const cleanState = await internal(clean);
    expect(cleanState).toMatchObject({ status: 'FAILED', storage: 'supabase', injected: false, canonicalDomain: 'failed.arca.example' });
    expect(cleanState.sources?.website).toMatchObject({ status: 'error', code: 'ACCESS_BLOCKED', reason: 'The site refused every request' });
    expect(JSON.stringify(cleanState)).not.toContain('owner@failed.arca.example');
  });

  it('/__debug/mode answers with the description only', async () => {
    const s = debugSetup();
    const response = await s.app.request('/__debug/mode');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(DebugModeResponse.parse(body)).toEqual(description('live-debug'));
    expect(body).toEqual(description('live-debug'));
    // Only enums and booleans can be described: anything else is refused before a route can serve it.
    expect(() => createDebugTools({ ...s.toolOptions, describe: { ...description('live-debug'), apiKey: 'sk-x' } as never })).toThrow();
  });

  it('invalid scenario header → 400 invalid_request', async () => {
    const s = debugSetup();
    for (const header of ['{"bar":', '{"bar":"nope"}', '{"unknown":true}']) {
      const response = await s.post(header);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'invalid_request', message: 'Invalid debug scenario' });
    }
    expect(s.durableSpy.create).not.toHaveBeenCalled();
    expect(s.scans.overlay.scans.size).toBe(0);
  });

  it('reset clears the limiter and what lives in memory', async () => {
    const s = debugSetup();
    const email = `owner@${DOMAIN}`;
    const first = await s.start({ avvo: 'error' }, email);
    for (let attempt = 0; attempt < 2; attempt++) await s.start({ avvo: 'error' }, email);
    expect((await s.post({ avvo: 'error' }, email)).status).toBe(429);
    await s.drain();
    const clearAssessments = vi.spyOn(s.assessments.overlay, 'clear');
    const reset = await s.app.request('/__debug/reset', { method: 'POST' });
    expect(reset.status).toBe(200);
    expect(await reset.json()).toEqual({ ok: true });
    expect(clearAssessments).toHaveBeenCalledTimes(1);
    expect(s.clearDurableMemory).toHaveBeenCalledTimes(1);
    // The wiped scan is gone, and its id never falls through to durable storage.
    expect((await s.poll(first)).status).toBe(404);
    expect((await s.app.request(`/__debug/scan/${first.scanId}`, { headers: s.auth(first) })).status).toBe(404);
    expect((await s.post({ avvo: 'error' }, email)).status).toBe(202);
    await s.drain();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEBUG_REQUEST_HEADER, DebugModeResponse } from '@arca/contracts/debug';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { loadEnv } from '../../src/config/env.js';
import { compose } from '../../src/compose.js';
import { createApp } from '../../src/http/app.js';
import { createDebugTools } from '../../src/debug/tools.js';
import { RoutingAssessmentRepository, RoutingScanRepository } from '../../src/debug/isolation.js';
import { InMemoryRepository } from '../../src/repositories/in-memory.js';
import { SupabaseRepository } from '../../src/repositories/supabase.js';
import type { ScanRecord } from '../../src/repositories/types.js';
import { InMemoryAssessmentRepository, SupabaseAssessmentRepository } from '../../src/assessment/repository.js';
import { ApifyClient } from '../../src/pipeline/apify-client.js';
import { AVVO_ACTOR } from '../../src/pipeline/directories.js';
import { DEFAULT_SIGNAL_LLM_MODEL } from '../../src/pipeline/llm-endpoint.js';
import { OPENAI_EVIDENCE_MODEL } from '../../src/pipeline/website-evidence-provider.js';
import { MockAppAuth, SupabaseJwtAuth } from '../../src/webapp/auth.js';
import { InMemoryAuthAdmin } from '../../src/webapp/auth-admin.js';
import { MockBillingProvider } from '../../src/webapp/billing.js';
import { MailingWebappService } from '../../src/webapp/invitation-email.js';
import { MemoryMailer } from '../../src/webapp/mailer.js';
import { DEFAULT_PLANS } from '../../src/webapp/plans.js';
import { InMemoryWebappRepository } from '../../src/webapp/in-memory.js';
import { REAL_WEBAPP_ADAPTERS } from '../../src/webapp/real-adapters.js';
import type { PlanRecord } from '../../src/webapp/types.js';
import { StripeBillingProvider } from '../../src/webapp/stripe.js';
import { fakeStripe } from '../fixtures/stripe.js';

// Observed, not replaced: compose still builds the real app and tools.
vi.mock('../../src/http/app.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/http/app.js')>();
  return { ...actual, createApp: vi.fn(actual.createApp) };
});
vi.mock('../../src/debug/tools.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/debug/tools.js')>();
  return { ...actual, createDebugTools: vi.fn(actual.createDebugTools) };
});

const base = { SESSION_TOKEN_SECRET: 's'.repeat(40), CORS_ALLOWED_ORIGINS: 'http://localhost:3000' };
const live = { SOURCE_MODE: 'live', STORAGE_BACKEND: 'supabase', SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SECRET_KEY: 'sb_secret_x',
  OPENAI_API_KEY: 'sk-x', APIFY_API_TOKEN: 'apify_x' };
const appDeps = () => vi.mocked(createApp).mock.calls[0]![0];
const toolOptions = () => vi.mocked(createDebugTools).mock.calls[0]![0];
// What a routing repository wraps; private on purpose, read here only to check the wiring.
const durableOf = (repository: object) => (repository as unknown as { durable: unknown }).durable;
const scanRecord: ScanRecord = { id: 'fixture', scan_id: 'sc_fixture', email: 'owner@robust.arca.example',
  canonical_domain: 'robust.arca.example', domain_resolution: { status: 'RESOLVED', canonicalDomain: 'robust.arca.example',
    source: 'request', reason: null }, status: 'RUNNING', result: null, created_at: new Date().toISOString(),
  completed_at: null, duration_ms: null, cached: false };
// Stands in for Supabase, which compose reaches once at start to fail the scans a restart interrupted.
const supabase = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 204 }));
const supabaseCalls = () => supabase.mock.calls.map(([input, init]) => `${init?.method} ${String(input).split('?')[0]}`);

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', supabase);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('compose', () => {
  it.each([
    { mode: 'mock', durable: InMemoryRepository, durableAssessments: InMemoryAssessmentRepository },
    { mode: 'live-debug', durable: SupabaseRepository, durableAssessments: SupabaseAssessmentRepository },
  ] as const)('$mode hands createApp and the debug tools the very same routing repositories', async ({ mode, durable, durableAssessments }) => {
    const composed = await compose(loadEnv({ ...base, ...live, ARCA_MODE: mode }));
    const deps = appDeps(), tools = toolOptions();
    expect(deps.repository).toBeInstanceOf(RoutingScanRepository);
    expect(deps.assessmentRepository).toBeInstanceOf(RoutingAssessmentRepository);
    expect(tools.scans).toBe(deps.repository);
    expect(tools.assessments).toBe(deps.assessmentRepository);
    expect(deps.debug).toBe(vi.mocked(createDebugTools).mock.results[0]!.value);
    // The recovery timer in server.ts works on the routed repository too.
    expect(composed.repository).toBe(deps.repository);
    const scans = durableOf(deps.repository), assessments = durableOf(deps.assessmentRepository!);
    expect(scans).toBeInstanceOf(durable);
    expect(assessments).toBeInstanceOf(durableAssessments);
    expect(scans).not.toBe(tools.scans.overlay);
    expect(assessments).not.toBe(tools.assessments.overlay);
    // Both debug modes run the webapp on the same simulated pieces, held in memory whatever the scans are stored in (DN-12 §7),
    // and the debug login signs in to the very service the app serves.
    expect(tools.webapp!.repository).toBeInstanceOf(InMemoryWebappRepository);
    expect(tools.webapp!.auth).toBeInstanceOf(MockAppAuth);
    expect(deps.webapp!.service).toBe(tools.webapp!.service);
    expect(deps.webapp!.auth).toBe(tools.webapp!.auth);
    if (mode === 'mock') {
      // A debug reset forgets the durable memory as well.
      await (scans as InMemoryRepository).create(scanRecord);
      const clearAssessments = vi.spyOn(assessments as InMemoryAssessmentRepository, 'clear');
      tools.clearDurableMemory!();
      expect((scans as InMemoryRepository).scans.size).toBe(0);
      expect(clearAssessments).toHaveBeenCalledTimes(1);
      expect(composed.apify).toBeNull();
      expect(supabase).not.toHaveBeenCalled();
    } else {
      // Supabase is never cleared by a debug reset.
      expect(tools.clearDurableMemory).toBeUndefined();
      expect(composed.apify).toBeInstanceOf(ApifyClient);
      expect(supabaseCalls()).toEqual(['PATCH https://x.supabase.co/rest/v1/scans']);
    }
  });

  it('composes production without debug tools, on the durable repositories, with no debug route', async () => {
    const composed = await compose(loadEnv({ ...base, ...live }));
    expect(createDebugTools).not.toHaveBeenCalled();
    const deps = appDeps();
    expect(deps.debug).toBeUndefined();
    // No webapp either: createApp answers 501 on its routes (DN-10 §10).
    expect(deps.webapp).toBeUndefined();
    expect(deps.repository).toBeInstanceOf(SupabaseRepository);
    expect(deps.assessmentRepository).toBeInstanceOf(SupabaseAssessmentRepository);
    expect(composed.repository).toBe(deps.repository);
    expect(composed.apify).toBeInstanceOf(ApifyClient);
    expect(composed.banner).toBe('[api] MODE=production sources=live storage=supabase');
    expect(supabaseCalls()).toEqual(['PATCH https://x.supabase.co/rest/v1/scans']);
    expect((await composed.app.request('/__debug/mode')).status).toBe(404);
    // The legacy CI combination stays production too.
    vi.clearAllMocks();
    const legacy = await compose(loadEnv({ ...base, SOURCE_MODE: 'mock', STORAGE_BACKEND: 'memory' }));
    expect(createDebugTools).not.toHaveBeenCalled();
    expect(appDeps().debug).toBeUndefined();
    expect(appDeps().webapp).toBeUndefined();
    expect(appDeps().repository).toBeInstanceOf(InMemoryRepository);
    expect(legacy.banner).toBe('[api] MODE=production sources=mock storage=memory');
  });

  it('banner names the mode, the loopback-only debug routes, a webapp kept apart from the storage, and only the overrides that happened', async () => {
    expect((await compose(loadEnv({ ...base, ...live, ARCA_MODE: 'mock' }))).banner).toBe('[api] MODE=mock sources=mock storage=memory '
      + '(debug routes on 127.0.0.1 only) overrides: SOURCE_MODE=live→mock, STORAGE_BACKEND=supabase→memory');
    // What scripts/with-mode.mjs sets for mock: nothing left to override.
    expect((await compose(loadEnv({ ...base, ...live, ARCA_MODE: 'mock', SOURCE_MODE: 'mock', STORAGE_BACKEND: 'memory' }))).banner)
      .toBe('[api] MODE=mock sources=mock storage=memory (debug routes on 127.0.0.1 only)');
    // live-debug pays real providers, so its line also says what guards the spend (DN-12 §5). Its scans are in Supabase and its
    // accounts, organizations and billing are not, so the line says that too (DN-12 §7).
    expect((await compose(loadEnv({ ...base, ...live, ARCA_MODE: 'live-debug' }))).banner)
      .toBe('[api] MODE=live-debug sources=live storage=supabase webapp=simulated-in-memory (debug routes on 127.0.0.1 only) '
        + 'spend guards: Apify ceiling USD 2 per 24 h, OpenAI cap 30 requests per scan');
    // A guard is named only where it acts: the rules provider calls no model.
    expect((await compose(loadEnv({ ...base, ...live, ARCA_MODE: 'live-debug', WEBSITE_EVIDENCE_PROVIDER: 'rules', APIFY_SPEND_CEILING_USD: '5' }))).banner)
      .toBe('[api] MODE=live-debug sources=live storage=supabase webapp=simulated-in-memory (debug routes on 127.0.0.1 only) '
        + 'spend guards: Apify ceiling USD 5 per 24 h');
  });

  // DN-12 §5: the ceiling and the cap reach the clients compose builds, and production builds them without either.
  it.each([
    { name: 'production', env: {}, ceiling: null, cap: undefined },
    { name: 'live-debug', env: { ARCA_MODE: 'live-debug' }, ceiling: 2, cap: 30 },
    { name: 'production with both set', env: { APIFY_SPEND_CEILING_USD: '25', OPENAI_MAX_REQUESTS_PER_SCAN: '40' }, ceiling: 25, cap: 40 },
  ])('$name builds its paid clients with spend ceiling $ceiling and request cap $cap', async ({ env, ceiling, cap }) => {
    const composed = await compose(loadEnv({ ...base, ...live, ...env }));
    // Private on purpose; read here only to check the wiring.
    expect((composed.apify as unknown as { options: { spendCeilingUsd: number | null } }).options.spendCeilingUsd).toBe(ceiling);
    const website = (appDeps().pipeline as unknown as { deps: { website: { provider: { options: { maxRequests?: number } } } } }).deps.website;
    expect(website.provider.options.maxRequests).toBe(cap);
    if (ceiling === null) expect(composed.banner).not.toContain('spend guards');
  });

  it('hands the Apify client one reservation per kind of lookup, and one of its own for Avvo', async () => {
    const composed = await compose(loadEnv({ ...base, ...live, APIFY_EXPECTED_COST_USD_PER_RUN: '1.5',
      APIFY_EXPECTED_COST_USD_PER_TARGETED_RUN: '0.05', APIFY_AVVO_EXPECTED_COST_USD_PER_TARGETED_RUN: '0.3' }));
    expect((composed.apify as unknown as { options: Record<string, unknown> }).options).toMatchObject({ expectedCostUsdPerRun: 1.5,
      expectedCostUsdPerTargetedRun: 0.05, expectedCostUsdPerTargetedRunByActor: { [AVVO_ACTOR]: 0.3 } });
  });

  // DN-09 4 and 7: the panel's 'Back mode' row must say what this process built, never which keys merely sit in the file.
  it.each([
    { name: 'every key present', keys: { ...live, WEBSITE_EVIDENCE_PROVIDER: 'openai', ASSESSMENT_PLANNER: 'agent', SIGNAL_LLM_MODEL: 'gpt-x' } },
    { name: 'no key at all', keys: {} },
  ])('/__debug/mode in mock reports no provider, no model and nothing in use ($name)', async ({ keys }) => {
    const { app } = await compose(loadEnv({ ...base, ...keys, ARCA_MODE: 'mock' }));
    const body = await (await app.request('/__debug/mode')).json();
    expect(DebugModeResponse.parse(body)).toEqual({ mode: 'mock', sourceMode: 'mock', storageBackend: 'memory',
      websiteEvidenceProvider: 'mock', assessmentPlanner: 'rules', signalLlmModel: null,
      inUse: { openai: false, apify: false, supabase: false } });
    for (const secret of ['sk-x', 'sb_secret_x', 'apify_x', 'x.supabase.co']) expect(JSON.stringify(body)).not.toContain(secret);
  });

  it.each([
    { name: 'rules extraction and rules planner', env: { WEBSITE_EVIDENCE_PROVIDER: 'rules', ASSESSMENT_PLANNER: 'rules' },
      provider: 'rules', planner: 'rules', model: null, openai: false },
    { name: 'the default agentic extraction', env: {},
      provider: 'agentic', planner: 'rules', model: DEFAULT_SIGNAL_LLM_MODEL, openai: true },
    { name: 'the agentic extraction on a chosen model', env: { SIGNAL_LLM_MODEL: 'gpt-x' },
      provider: 'agentic', planner: 'rules', model: 'gpt-x', openai: true },
    { name: 'the single-pass OpenAI extraction, which calls its own fixed model', env: { WEBSITE_EVIDENCE_PROVIDER: 'openai', SIGNAL_LLM_MODEL: 'gpt-x' },
      provider: 'openai', planner: 'rules', model: OPENAI_EVIDENCE_MODEL, openai: true },
    { name: 'rules extraction with the agent planner', env: { WEBSITE_EVIDENCE_PROVIDER: 'rules', ASSESSMENT_PLANNER: 'agent', SIGNAL_LLM_MODEL: 'gpt-x' },
      provider: 'rules', planner: 'agent', model: 'gpt-x', openai: true },
  ] as const)('/__debug/mode in live-debug reports what compose built: $name', async ({ env, provider, planner, model, openai }) => {
    const { app } = await compose(loadEnv({ ...base, ...live, ...env, ARCA_MODE: 'live-debug' }));
    const body = await (await app.request('/__debug/mode')).json();
    expect(DebugModeResponse.parse(body)).toEqual({ mode: 'live-debug', sourceMode: 'live', storageBackend: 'supabase',
      websiteEvidenceProvider: provider, assessmentPlanner: planner, signalLlmModel: model,
      inUse: { openai, apify: true, supabase: true } });
    for (const secret of ['sk-x', 'sb_secret_x', 'apify_x', 'x.supabase.co']) expect(JSON.stringify(body)).not.toContain(secret);
  });
});

// DN-13 §3.2 and §7.1: which webapp each mode builds. The real adapters arrive through the factory seam, so no test here reaches
// Supabase, Stripe or SES: the key set is served by an injected fetcher and the data lives in an in-memory repository.
describe('compose: the webapp providers', () => {
  const FROM = 'ARCA <no-reply@arcacover.com>';
  const stripeTest = { STRIPE_SECRET_KEY: 'rk_test_fixture', STRIPE_WEBHOOK_SECRET: 'whsec_fixture' };
  const launch = { ...base, ...live, STRIPE_SECRET_KEY: 'rk_live_fixture', STRIPE_WEBHOOK_SECRET: 'whsec_fixture', WEBAPP_ENABLED: 'true',
    APP_BASE_URL: 'https://arcacover.com', EMAIL_FROM: FROM };
  const realLiveDebug = { ...base, ...live, ...stripeTest, ARCA_MODE: 'live-debug', WEBAPP_PROVIDERS: 'real' };
  const USER_ID = '7b5e2f0e-3c1a-4d8e-9f00-1a2b3c4d5e6f';
  const debugPost = (app: { request: (path: string, init: RequestInit) => Response | Promise<Response> }, path: string,
    body: unknown = { email: 'owner@firm.com', sessionId: 'cs_x' }) => app.request(path, { method: 'POST', body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', [DEBUG_REQUEST_HEADER]: '1' } });

  /** A Supabase project of the test's own: its key set and the access tokens it would issue. */
  async function supabaseProject() {
    const { publicKey, privateKey } = await generateKeyPair('ES256');
    const keys: unknown[] = [{ ...(await exportJWK(publicKey)), kid: 'key-1', alg: 'ES256', use: 'sig' }];
    const state = { keys, fail: false };
    const fetchJwks = vi.fn(async (url: URL) => {
      if (state.fail) throw new Error('connect ECONNREFUSED');
      expect(url.href).toBe('https://x.supabase.co/auth/v1/.well-known/jwks.json');
      return { keys: state.keys };
    });
    const accessToken = (email = 'owner@firm.com') => new SignJWT({ email, role: 'authenticated', aal: 'aal1' })
      .setProtectedHeader({ alg: 'ES256', kid: 'key-1' }).setIssuer('https://x.supabase.co/auth/v1').setAudience('authenticated')
      .setSubject(USER_ID).setIssuedAt().setExpirationTime('1h').sign(privateKey);
    return { state, fetchJwks, accessToken };
  }
  // The plans as stripe:catalog leaves them in both modes (DN-13 §20): the test ids of development and the live ids of production.
  const PRICED_PLANS = DEFAULT_PLANS.map(plan => ({ ...plan, stripe_product_id: 'arca', stripe_price_id: `price_${plan.code}`,
    stripe_live_product_id: 'arca', stripe_live_price_id: `price_live_${plan.code}` }));
  function adapters(project: { fetchJwks: (url: URL) => Promise<unknown> }, plans: PlanRecord[] = PRICED_PLANS) {
    const repository = new InMemoryWebappRepository(plans);
    const billing = new MockBillingProvider('https://arcacover.com');
    const authAdmin = new InMemoryAuthAdmin();
    return { repository, billing, authAdmin, seam: { repository: vi.fn((_client: unknown) => repository),
      authAdmin: vi.fn((_client: unknown) => authAdmin), billing: vi.fn((_config: unknown) => billing),
      sesSendEmail: vi.fn(async (_input: unknown) => ({ MessageId: 'ses-1' })), fetchJwks: project.fetchJwks,
      resendFetch: vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ id: 'resend-1' }), { status: 200 })) } };
  }
  const me = async (app: { request: (path: string, init?: RequestInit) => Response | Promise<Response> }, token: string) =>
    app.request('/me', { headers: { Authorization: `Bearer ${token}` } });

  it.each(['mock', 'live-debug'] as const)('%s on the simulated providers keeps today\'s webapp and never touches the seam', async mode => {
    const project = await supabaseProject();
    const { seam } = adapters(project);
    const composed = await compose(loadEnv({ ...base, ...live, ARCA_MODE: mode }), undefined, seam);
    const deps = appDeps(), tools = toolOptions();
    expect(deps.webapp!.auth).toBeInstanceOf(MockAppAuth);
    expect(tools.webapp!.repository).toBeInstanceOf(InMemoryWebappRepository);
    // Invitations go to memory, for the tests and the debug panel; the response still carries the link.
    expect(tools.webapp!.mailer).toBeInstanceOf(MemoryMailer);
    expect(deps.webapp!.service).toBeInstanceOf(MailingWebappService);
    for (const factory of [seam.repository, seam.authAdmin, seam.billing, seam.sesSendEmail, seam.resendFetch, project.fetchJwks]) expect(factory).not.toHaveBeenCalled();
    expect(composed.banner).not.toContain('webapp=real');
    expect((await debugPost(composed.app, '/__debug/auth/login', { email: 'owner@firm.com' })).status).toBe(200);
    // A debug reset forgets the invitations held in memory with the rest of the simulated webapp.
    await tools.webapp!.mailer!.send({ from: 'ARCA <no-reply@arcacover.com>', to: 'new@firm.com', subject: 'x', text: 'x' });
    expect((await composed.app.request('/__debug/reset', { method: 'POST', headers: { [DEBUG_REQUEST_HEADER]: '1' } })).status).toBe(200);
    expect(tools.webapp!.mailer!.sent).toEqual([]);
    // The simulated issuer is the only one: a Supabase token is refused.
    expect((await me(composed.app, await project.accessToken())).status).toBe(401);
  });

  it('live-debug with WEBAPP_PROVIDERS=real verifies Supabase tokens, on the adapters of the seam, without the simulations', async () => {
    const project = await supabaseProject();
    const { repository, billing, seam } = adapters(project);
    const composed = await compose(loadEnv(realLiveDebug), undefined, seam);
    const deps = appDeps(), tools = toolOptions();
    expect(deps.webapp!.auth).toBeInstanceOf(SupabaseJwtAuth);
    expect(seam.repository).toHaveBeenCalledTimes(1);
    expect(seam.repository.mock.calls[0]![0]).toBeDefined();
    expect(seam.billing).toHaveBeenCalledWith({ secretKey: 'rk_test_fixture', webhookSecret: 'whsec_fixture', mode: 'test',
      appBaseUrl: 'http://localhost:3000' });
    const service = deps.webapp!.service as unknown as { deps: { repository: unknown; billing: unknown; scans: unknown; assessments: unknown } };
    expect(service.deps.repository).toBe(repository);
    expect(service.deps.billing).toBe(billing);
    // The scans it claims are the routed ones, as in the simulated live-debug.
    expect(service.deps.scans).toBe(deps.repository);
    expect(service.deps.assessments).toBe(deps.assessmentRepository);
    // No simulated login or payment: the debug tools know of no webapp, so those routes do not exist (DN-13 §3.2).
    expect(tools.webapp).toBeUndefined();
    for (const path of ['/__debug/auth/login', '/__debug/billing/pay', '/__debug/seed']) expect((await debugPost(composed.app, path)).status, path).toBe(404);
    expect((await composed.app.request('/__debug/reset', { method: 'POST', headers: { [DEBUG_REQUEST_HEADER]: '1' } })).status).toBe(200);
    expect(composed.banner).toBe('[api] MODE=live-debug sources=live storage=supabase webapp=real stripe=test email=memory '
      + '(debug routes on 127.0.0.1 only) spend guards: Apify ceiling USD 2 per 24 h, OpenAI cap 30 requests per scan');

    const signedIn = await me(composed.app, await project.accessToken('Owner@Firm.com'));
    expect(signedIn.status).toBe(200);
    expect(await signedIn.json()).toEqual({ user: { id: USER_ID, email: 'owner@firm.com' }, organizations: [], platformAdmin: false });
    // A token of the simulated issuer is refused here.
    const mockToken = (await new MockAppAuth(base.SESSION_TOKEN_SECRET).issue('owner@firm.com')).token;
    expect((await me(composed.app, mockToken)).status).toBe(401);
    // The key set was read once, at start, and kept.
    expect(project.fetchJwks).toHaveBeenCalledTimes(1);
  });

  it('production keeps answering 501 while WEBAPP_ENABLED is not true, and builds nothing of the seam', async () => {
    const project = await supabaseProject();
    const { seam } = adapters(project);
    const { WEBAPP_ENABLED: _on, ...off } = launch;
    for (const env of [off, { ...off, WEBAPP_ENABLED: 'false' }]) {
      vi.clearAllMocks();
      const composed = await compose(loadEnv(env), undefined, seam);
      expect(appDeps().webapp).toBeUndefined();
      expect(composed.banner).toBe('[api] MODE=production sources=live storage=supabase');
      const response = await me(composed.app, await project.accessToken());
      expect(response.status).toBe(501);
      expect(await response.json()).toEqual({ error: 'not_configured', message: expect.any(String) });
      for (const factory of [seam.repository, seam.authAdmin, seam.billing, seam.sesSendEmail, seam.resendFetch, project.fetchJwks]) expect(factory).not.toHaveBeenCalled();
      // The routes of DN-13 T7 and T11 too.
      for (const [method, path] of [['POST', '/auth/enroll'], ['DELETE', '/me']] as const) {
        const off = await composed.app.request(path, { method, body: method === 'POST' ? '{"claimId":"x"}' : undefined,
          headers: { Authorization: `Bearer ${await project.accessToken()}`, 'Content-Type': 'application/json' } });
        expect(off.status, `${method} ${path}`).toBe(501);
        expect(off.headers.get('Cache-Control')).toBe('no-store');
      }
    }
  });

  it('production with WEBAPP_ENABLED=true serves the real webapp on the durable repositories and sends invitations through SES', async () => {
    const project = await supabaseProject();
    const { repository, seam } = adapters(project);
    const composed = await compose(loadEnv(launch), undefined, seam);
    expect(createDebugTools).not.toHaveBeenCalled();
    const deps = appDeps();
    expect(deps.debug).toBeUndefined();
    expect(deps.webapp!.auth).toBeInstanceOf(SupabaseJwtAuth);
    const service = deps.webapp!.service as unknown as { deps: { scans: unknown; assessments: unknown; isDurableScan?: (id: string) => boolean } };
    expect(service.deps.scans).toBe(deps.repository);
    expect(deps.repository).toBeInstanceOf(SupabaseRepository);
    expect(service.deps.assessments).toBe(deps.assessmentRepository);
    expect(seam.billing).toHaveBeenCalledWith({ secretKey: 'rk_live_fixture', webhookSecret: 'whsec_fixture', mode: 'live',
      appBaseUrl: 'https://arcacover.com' });
    expect(composed.banner).toBe('[api] MODE=production sources=live storage=supabase webapp=real stripe=live email=ses');
    for (const path of ['/__debug/auth/login', '/__debug/billing/pay', '/__debug/mode']) expect((await debugPost(composed.app, path)).status, path).toBe(404);
    // CORS stays exact.
    const preflight = await composed.app.request('/orgs', { method: 'OPTIONS', headers: { Origin: 'http://localhost:3000',
      'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type, authorization' } });
    expect(preflight.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type,Authorization');

    const token = await project.accessToken();
    expect((await me(composed.app, token)).status).toBe(200);
    // A paid organization of this owner, written straight to the repository the seam handed in.
    const orgId = '0d9c1f9e-8b7a-4c6d-9e5f-4a3b2c1d0e0f', at = new Date().toISOString();
    await repository.createOrganization({ id: orgId, name: 'Robust Law LLP', domain: 'robust.example', billing_status: 'active', deleted_at: null,
      created_by: USER_ID, created_at: at }, { org_id: orgId, user_id: USER_ID, role: 'owner', invited_by: null, created_at: at }, null);
    const invited = await composed.app.request(`/orgs/${orgId}/invitations`, { method: 'POST', body: JSON.stringify({ email: 'new@firm.com', role: 'member' }),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
    expect(invited.status).toBe(201);
    const view = await invited.json() as { inviteUrl: string };
    expect(view.inviteUrl).toMatch(/^https:\/\/arcacover\.com\/app\/invite\//);
    expect(seam.sesSendEmail).toHaveBeenCalledTimes(1);
    expect(seam.sesSendEmail.mock.calls[0]![0]).toMatchObject({ FromEmailAddress: FROM, Destination: { ToAddresses: ['new@firm.com'] } });
    expect(JSON.stringify(seam.sesSendEmail.mock.calls[0]![0])).toContain(view.inviteUrl);
  });

  /** Signs in the project's owner, gives them a paid organization in the seam's repository and invites new@firm.com. */
  async function inviteThrough(composed: Awaited<ReturnType<typeof compose>>, repository: InMemoryWebappRepository,
    project: Awaited<ReturnType<typeof supabaseProject>>) {
    const token = await project.accessToken();
    const orgId = '0d9c1f9e-8b7a-4c6d-9e5f-4a3b2c1d0e0f', at = new Date().toISOString();
    await repository.createOrganization({ id: orgId, name: 'Robust Law LLP', domain: 'robust.example', billing_status: 'active', deleted_at: null,
      created_by: USER_ID, created_at: at }, { org_id: orgId, user_id: USER_ID, role: 'owner', invited_by: null, created_at: at }, null);
    const invited = await composed.app.request(`/orgs/${orgId}/invitations`, { method: 'POST', body: JSON.stringify({ email: 'new@firm.com', role: 'member' }),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
    expect(invited.status).toBe(201);
    return await invited.json() as { id: string; inviteUrl: string };
  }

  it('production with EMAIL_PROVIDER=resend sends invitations through Resend\'s API and needs no SES sender (F11)', async () => {
    const project = await supabaseProject();
    const { repository, seam } = adapters(project);
    const composed = await compose(loadEnv({ ...launch, EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_fixture_123' }), undefined,
      { ...seam, sesSendEmail: undefined });
    expect(composed.banner).toBe('[api] MODE=production sources=live storage=supabase webapp=real stripe=live email=resend');
    const view = await inviteThrough(composed, repository, project);
    expect(seam.resendFetch).toHaveBeenCalledTimes(1);
    const [url, init] = seam.resendFetch.mock.calls[0]!;
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer re_fixture_123', 'Idempotency-Key': `invitation-${view.id}` });
    const body = JSON.parse(init.body as string) as { from: string; to: string[]; subject: string; text: string };
    expect(body).toMatchObject({ from: FROM, to: ['new@firm.com'], subject: "You're invited to join Robust Law LLP on ARCA" });
    expect(body.text).toContain(view.inviteUrl);
  });

  it('live-debug on the real providers keeps invitations in memory unless it opts into Resend for a real test', async () => {
    const project = await supabaseProject();
    const { repository, seam } = adapters(project);
    const memory = await compose(loadEnv({ ...realLiveDebug, RESEND_API_KEY: 're_fixture_123' }), undefined, seam);
    expect(memory.banner).toContain('email=memory');
    await inviteThrough(memory, repository, project);
    expect(seam.resendFetch).not.toHaveBeenCalled();

    const { repository: second, seam: opted } = adapters(project);
    const resend = await compose(loadEnv({ ...realLiveDebug, EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_fixture_123' }), undefined, opted);
    expect(resend.banner).toContain('webapp=real stripe=test email=resend');
    const view = await inviteThrough(resend, second, project);
    expect(opted.resendFetch).toHaveBeenCalledTimes(1);
    expect(opted.resendFetch.mock.calls[0]![1].headers).toMatchObject({ 'Idempotency-Key': `invitation-${view.id}` });
    expect(opted.sesSendEmail).not.toHaveBeenCalled();
  });

  it('keeps the invitation when Resend fails, and answers as before', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const project = await supabaseProject();
    const { repository, seam } = adapters(project);
    const resendFetch = vi.fn(async (_url: string, _init: RequestInit) => { throw new TypeError('fetch failed'); });
    const composed = await compose(loadEnv({ ...launch, EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_fixture_123' }), undefined,
      { ...seam, resendFetch });
    const view = await inviteThrough(composed, repository, project);
    expect(view.inviteUrl).toMatch(/^https:\/\/arcacover\.com\/app\/invite\//);
    expect(resendFetch).toHaveBeenCalledTimes(2);
    expect(error.mock.calls.flat().map(String)).toContain(`[mail] invitation ${view.id} was created but its email was not sent (NetworkError)`);
  });

  it('refuses to start the real webapp while an adapter of the seam is missing', async () => {
    const project = await supabaseProject();
    const { seam } = adapters(project);
    await expect(compose(loadEnv(launch), undefined, { fetchJwks: project.fetchJwks }))
      .rejects.toThrow(/Supabase webapp repository.*Stripe billing provider.*SES sender/);
    await expect(compose(loadEnv(launch), undefined, { ...seam, sesSendEmail: undefined })).rejects.toThrow(/SES sender/);
    await expect(compose(loadEnv(realLiveDebug), undefined, { ...seam, repository: undefined })).rejects.toThrow(/Supabase webapp repository/);
    await expect(compose(loadEnv(realLiveDebug), undefined, { ...seam, authAdmin: undefined })).rejects.toThrow(/Supabase Auth admin/);
    // live-debug keeps the invitations in memory unless told otherwise, so it needs no SES sender.
    await expect(compose(loadEnv(realLiveDebug), undefined, { ...seam, sesSendEmail: undefined })).resolves.toBeDefined();
    await expect(compose(loadEnv(realLiveDebug), undefined, { ...seam, billing: undefined })).rejects.toThrow(/Stripe billing provider/);
    // What ships today has the Supabase repository (T4), the Auth admin (T7) and the Stripe provider (T14), but no SES sender:
    // production with the switch on still refuses to start rather than drop its emails, and names only what is missing.
    await expect(compose(loadEnv(launch))).rejects.toThrow(/SES sender/);
    await expect(compose(loadEnv(launch))).rejects.not.toThrow(/Supabase webapp repository|Stripe billing provider|Auth admin/);
  });

  it('ships the Stripe provider in the seam, built with the key and mode loadEnv resolved', () => {
    const provider = REAL_WEBAPP_ADAPTERS.billing!({ secretKey: 'rk_test_fixture', webhookSecret: 'whsec_fixture', mode: 'test',
      appBaseUrl: 'http://localhost:3000' });
    expect(provider).toBeInstanceOf(StripeBillingProvider);
    expect([provider.mode, provider.webhooks, provider.needsCatalogPrice]).toEqual(['test', true, true]);
  });

  it('refuses production while an active plan has no price in the mode of its key, and only warns in live-debug (DN-13 §5.3, §20)', async () => {
    const project = await supabaseProject();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(compose(loadEnv(launch), undefined, adapters(project, [...DEFAULT_PLANS]).seam))
      .rejects.toThrow(/monthly has no live price \(plans\.stripe_live_price_id\).*annual has no live price.*npm run stripe:catalog -- --apply/);
    // Test ids do not sell with a live key, nor live ids with a test key.
    const testOnly = PRICED_PLANS.map(plan => ({ ...plan, stripe_live_product_id: null, stripe_live_price_id: null }));
    await expect(compose(loadEnv(launch), undefined, adapters(project, testOnly).seam)).rejects.toThrow(/monthly has no live price/);
    const liveOnly = PRICED_PLANS.map(plan => ({ ...plan, stripe_product_id: null, stripe_price_id: null }));
    const composed = await compose(loadEnv(realLiveDebug), undefined, adapters(project, liveOnly).seam);
    expect(warn.mock.calls.flat().join(' ')).toMatch(/\[billing\] .*monthly has no test price \(plans\.stripe_price_id\).*annual has no test price/);
    // A plan taken off sale needs none.
    await expect(compose(loadEnv(launch), undefined, adapters(project, [PRICED_PLANS[0]!, { ...DEFAULT_PLANS[1]!, active: false }]).seam))
      .resolves.toBeDefined();
    expect(composed.reconcileBilling).toEqual(expect.any(Function));
    warn.mockRestore();
  });

  describe('the catalog prices, checked at Stripe at start (DN-13 §20)', () => {
    /** The real provider over a fake Stripe of the key's mode, holding the plans' prices of that mode. */
    function stripeSeam(project: { fetchJwks: (url: URL) => Promise<unknown> }, mode: 'test' | 'live') {
      const stripe = fakeStripe({ livemode: mode === 'live' });
      stripe.addProduct();
      for (const plan of PRICED_PLANS) {
        stripe.addPrice({ id: mode === 'live' ? plan.stripe_live_price_id : plan.stripe_price_id, lookupKey: `arca_${plan.code}`,
          amount: plan.amount_cents, interval: plan.interval, planCode: plan.code });
      }
      const { seam } = adapters(project);
      return { stripe, seam: { ...seam, billing: (config: ConstructorParameters<typeof StripeBillingProvider>[0]) =>
        new StripeBillingProvider(config, { fetch: stripe.fetch, maxNetworkRetries: 0 }) } };
    }
    const priceReads = (stripe: ReturnType<typeof fakeStripe>) => stripe.calls.filter(call => call.method === 'GET' && call.path.startsWith('/v1/prices/'))
      .map(call => call.path).sort();

    it('starts production when the live price of every active plan exists, is active and is live, reading each one once', async () => {
      const project = await supabaseProject();
      const { stripe, seam } = stripeSeam(project, 'live');
      await expect(compose(loadEnv(launch), undefined, seam)).resolves.toBeDefined();
      expect(priceReads(stripe)).toEqual(['/v1/prices/price_live_annual', '/v1/prices/price_live_monthly']);
      expect(stripe.writes()).toEqual([]);
    });

    it('refuses production with a price Stripe does not know, an archived one, or one of the other mode, naming the plan', async () => {
      const project = await supabaseProject();
      const missing = stripeSeam(project, 'live');
      missing.stripe.prices.delete('price_live_monthly');
      await expect(compose(loadEnv(launch), undefined, missing.seam))
        .rejects.toThrow(/monthly: its live price price_live_monthly does not exist in this Stripe account.*npm run stripe:catalog -- --apply/);
      const archived = stripeSeam(project, 'live');
      archived.stripe.prices.get('price_live_annual')!.active = false;
      await expect(compose(loadEnv(launch), undefined, archived.seam)).rejects.toThrow(/annual: its live price price_live_annual is archived/);
      const otherMode = stripeSeam(project, 'live');
      otherMode.stripe.prices.get('price_live_monthly')!.livemode = false;
      await expect(compose(loadEnv(launch), undefined, otherMode.seam)).rejects.toThrow(/monthly: its live price price_live_monthly is a test price/);
    });

    it('refuses production while Stripe cannot be asked; live-debug warns and starts in every case', async () => {
      const project = await supabaseProject();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const down = stripeSeam(project, 'live');
      down.stripe.failNext(call => call.path === '/v1/prices/price_live_monthly');
      await expect(compose(loadEnv(launch), undefined, down.seam)).rejects.toThrow(/monthly: Stripe could not be asked for its live price price_live_monthly/);
      const debug = stripeSeam(project, 'test');
      debug.stripe.prices.get('price_annual')!.active = false;
      debug.stripe.failNext(call => call.path === '/v1/prices/price_monthly');
      const composed = await compose(loadEnv(realLiveDebug), undefined, debug.seam);
      expect(composed.reconcileBilling).toEqual(expect.any(Function));
      const warned = warn.mock.calls.flat().join(' ');
      expect(warned).toMatch(/\[billing\] .*monthly: Stripe could not be asked.*annual: its test price price_annual is archived/);
      expect(warned).not.toMatch(/(sk|rk)_(test|live)_/);
      warn.mockRestore();
    });
  });

  it('serves POST /billing/webhook only with a provider that signs webhooks: the simulated webapp keeps the 501', async () => {
    const project = await supabaseProject();
    const simulated = await compose(loadEnv({ ...base, ...live, ARCA_MODE: 'live-debug' }), undefined, adapters(project).seam);
    expect((await simulated.app.request('/billing/webhook', { method: 'POST', body: '{}' })).status).toBe(501);
    expect(simulated.reconcileBilling).toBeNull();
    // The real webapp with the shipped provider verifies the signature: none is a 400, and nothing reaches Stripe.
    const { seam } = adapters(project);
    const real = await compose(loadEnv(realLiveDebug), undefined, { ...seam, billing: REAL_WEBAPP_ADAPTERS.billing });
    const refused = await real.app.request('/billing/webhook', { method: 'POST', body: '{"id":"evt_1"}' });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: 'invalid_signature', message: expect.any(String) });
    expect(refused.headers.get('Cache-Control')).toBe('no-store');
  });

  it('refuses to start against a project without asymmetric signing keys, and starts anyway while Supabase is unreachable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const project = await supabaseProject();
    const { seam } = adapters(project);
    const published = project.state.keys;
    project.state.keys = [];
    await expect(compose(loadEnv(realLiveDebug), undefined, seam)).rejects.toThrow(/asymmetric signing key/);
    project.state.keys = published;

    project.state.fail = true;
    const { app } = await compose(loadEnv(realLiveDebug), undefined, seam);
    expect(warn.mock.calls.flat().join(' ')).toContain('[auth]');
    // With no key at all, a signed-in request is answered 503, not 401: the front must not sign the user out over it.
    const unavailable = await me(app, await project.accessToken());
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({ error: 'auth_unavailable', message: expect.any(String) });
    // Without a token it is still a plain 401.
    expect((await app.request('/me')).status).toBe(401);
    // Once Supabase answers, the same process verifies again.
    project.state.fail = false;
    expect((await me(app, await project.accessToken())).status).toBe(200);
  });
  it('live-debug with WEBAPP_PROVIDERS=real enrolls and closes accounts through the Auth admin of the seam (DN-13 T7, T11)', async () => {
    const project = await supabaseProject();
    const { seam, authAdmin } = adapters(project);
    const composed = await compose(loadEnv(realLiveDebug), undefined, seam);
    expect(seam.authAdmin).toHaveBeenCalledTimes(1);
    // The same service-role client as the repository's.
    expect(seam.authAdmin.mock.calls[0]![0]).toBe(seam.repository.mock.calls[0]![0]);
    const enroll = await composed.app.request('/auth/enroll', { method: 'POST', body: JSON.stringify({ claimId: 'unknown' }),
      headers: { 'Content-Type': 'application/json' } });
    expect(enroll.status).toBe(410);
    const remove = vi.spyOn(authAdmin, 'deleteUser');
    const token = await project.accessToken();
    expect((await me(composed.app, token)).status).toBe(200);
    expect((await composed.app.request('/me', { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })).status).toBe(204);
    expect(remove).toHaveBeenCalledWith(USER_ID);
    // The token is still within its hour, but the account is closed.
    expect((await me(composed.app, token)).status).toBe(401);
  });

  it('mock enrolls in memory, and the simulated login refuses an email whose account was closed until a debug reset', async () => {
    const project = await supabaseProject();
    const { seam } = adapters(project);
    const composed = await compose(loadEnv({ ...base, ARCA_MODE: 'mock' }), undefined, seam);
    const login = async () => debugPost(composed.app, '/__debug/auth/login', { email: 'owner@firm.com' });
    const session = await (await login()).json() as { token: string };
    expect((await composed.app.request('/me', { method: 'DELETE', headers: { Authorization: `Bearer ${session.token}` } })).status).toBe(204);
    const refused = await login();
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: 'conflict', message: expect.stringMatching(/reset/) });
    expect((await composed.app.request('/__debug/reset', { method: 'POST', headers: { [DEBUG_REQUEST_HEADER]: '1' } })).status).toBe(200);
    expect((await login()).status).toBe(200);
    expect(seam.authAdmin).not.toHaveBeenCalled();
  });
});

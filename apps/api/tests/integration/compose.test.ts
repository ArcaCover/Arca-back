import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DebugModeResponse } from '@arca/contracts/debug';
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
import { MockAppAuth } from '../../src/webapp/auth.js';
import { InMemoryWebappRepository } from '../../src/webapp/in-memory.js';

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

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
import { DEFAULT_SIGNAL_LLM_MODEL } from '../../src/pipeline/llm-endpoint.js';

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
    expect(appDeps().repository).toBeInstanceOf(InMemoryRepository);
    expect(legacy.banner).toBe('[api] MODE=production sources=mock storage=memory');
  });

  it('banner names the mode, the loopback-only debug routes and only the overrides that happened', async () => {
    expect((await compose(loadEnv({ ...base, ...live, ARCA_MODE: 'mock' }))).banner).toBe('[api] MODE=mock sources=mock storage=memory '
      + '(debug routes on 127.0.0.1 only) overrides: SOURCE_MODE=live→mock, STORAGE_BACKEND=supabase→memory');
    // What scripts/with-mode.mjs sets for mock: nothing left to override.
    expect((await compose(loadEnv({ ...base, ...live, ARCA_MODE: 'mock', SOURCE_MODE: 'mock', STORAGE_BACKEND: 'memory' }))).banner)
      .toBe('[api] MODE=mock sources=mock storage=memory (debug routes on 127.0.0.1 only)');
    expect((await compose(loadEnv({ ...base, ...live, ARCA_MODE: 'live-debug' }))).banner)
      .toBe('[api] MODE=live-debug sources=live storage=supabase (debug routes on 127.0.0.1 only)');
  });

  it.each([
    { keys: live, configured: true },
    { keys: {}, configured: false },
  ])('/__debug/mode describes what mock resolved to, with keys as booleans only (configured: $configured)', async ({ keys, configured }) => {
    const { app } = await compose(loadEnv({ ...base, ...keys, ARCA_MODE: 'mock' }));
    const body = await (await app.request('/__debug/mode')).json();
    expect(DebugModeResponse.parse(body)).toEqual({ mode: 'mock', sourceMode: 'mock', storageBackend: 'memory',
      websiteEvidenceProvider: 'agentic', assessmentPlanner: 'rules', signalLlmModel: DEFAULT_SIGNAL_LLM_MODEL,
      configured: { openai: configured, apify: configured, supabase: configured } });
    for (const secret of ['sk-x', 'sb_secret_x', 'apify_x', 'x.supabase.co']) expect(JSON.stringify(body)).not.toContain(secret);
  });
});

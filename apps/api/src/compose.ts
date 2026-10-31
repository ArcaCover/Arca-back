import type { Hono } from 'hono';
import type { loadEnv } from './config/env.js';
import { listenHostname } from './config/mode.js';
import { createApp } from './http/app.js';
import { InMemoryRepository } from './repositories/in-memory.js';
import { SupabaseRepository, createStorageClient } from './repositories/supabase.js';
import type { ScanRepository } from './repositories/types.js';
import { InMemoryAssessmentRepository, SupabaseAssessmentRepository } from './assessment/repository.js';
import { InProcessPipeline } from './pipeline/in-process-pipeline.js';
import { WebsiteExtractionSource } from './pipeline/website-source.js';
import { OPENAI_EVIDENCE_MODEL, OpenAIEvidenceProvider, RuleBasedEvidenceProvider } from './pipeline/website-evidence-provider.js';
import { AgenticEvidenceProvider } from './pipeline/agentic-evidence-provider.js';
import { openAiEndpoint } from './pipeline/llm-endpoint.js';
import { ApifyClient } from './pipeline/apify-client.js';
import { ApifyDirectorySource } from './pipeline/directories.js';
import { PublicDomainResolver } from './pipeline/domain-resolution.js';
import { mockSources, MOCK_DOMAINS } from './pipeline/mock-sources.js';
import { RoutingAssessmentRepository, RoutingScanRepository } from './debug/isolation.js';
import { createDebugTools } from './debug/tools.js';
import { createOpenAIPlanner } from '@arca/questions';
import { renderPdf } from './report/pdf.js';

/** A scan still RUNNING past this point outlived its pipeline budget: a restart cut it short. */
export const interruptedBefore = (pipelineTimeoutMs: number) => new Date(Date.now() - pipelineTimeoutMs - 120_000).toISOString();

/**
 * Builds the API the environment describes: production exactly as configured, the debug modes with the same storage
 * behind the routing repositories plus the debug tools (DN-09 5.1). Reads only the resolved mode, sourceMode,
 * storageBackend and ASSESSMENT_PLANNER: under mock the raw SOURCE_MODE and STORAGE_BACKEND still say what the file said.
 * The server fills `clientIps` per request, from the socket and the trusted proxy hops.
 */
export async function compose(env: ReturnType<typeof loadEnv>): Promise<{ app: Hono; drain: () => Promise<void>;
  recoverAssessments: () => Promise<void>; repository: ScanRepository; apify: ApifyClient | null; banner: string;
  clientIps: WeakMap<Request, string> }> {
  const mode = env.mode;
  const storageClient = env.storageBackend === 'supabase' ? createStorageClient(env.SUPABASE_URL!, env.supabaseKey!) : null;
  const durable = storageClient ? new SupabaseRepository(storageClient) : new InMemoryRepository();
  const durableAssessments = storageClient ? new SupabaseAssessmentRepository(storageClient) : new InMemoryAssessmentRepository();
  // createApp and the debug tools must share these very instances: the tools isolate a scan in the router the app writes through.
  const scans = mode === 'production' ? null : new RoutingScanRepository(durable, new InMemoryRepository());
  const assessments = scans && new RoutingAssessmentRepository(durableAssessments, new InMemoryAssessmentRepository(), scans);
  const repository = scans ?? durable;
  const assessmentRepository = assessments ?? durableAssessments;
  await repository.recoverInterrupted(interruptedBefore(env.PIPELINE_TIMEOUT_MS));
  // The fixtures read the website in mock; otherwise the configured provider does. /__debug/mode reports this very value.
  const evidence = env.sourceMode === 'mock' ? 'mock' as const : env.WEBSITE_EVIDENCE_PROVIDER;
  const websiteEvidenceProvider = evidence === 'mock' ? null : evidence === 'openai'
    ? new OpenAIEvidenceProvider(env.OPENAI_API_KEY!) : evidence === 'rules'
      ? new RuleBasedEvidenceProvider() : new AgenticEvidenceProvider(env.OPENAI_API_KEY!, env.SIGNAL_LLM_MODEL, undefined,
        undefined, openAiEndpoint(env.SIGNAL_LLM_REASONING_EFFORT));
  const apify = env.sourceMode === 'live' ? new ApifyClient(env.APIFY_API_TOKEN!, fetch, env.MAX_APIFY_CONCURRENCY, {
    store: repository, build: env.APIFY_ACTOR_BUILD, expectedCostUsdPerRun: env.APIFY_EXPECTED_COST_USD_PER_RUN,
    cacheTtlMs: env.APIFY_QUERY_CACHE_TTL_MS, activeTtlMs: env.APIFY_ACTIVE_RUN_TTL_MS,
    runTimeoutSecs: env.APIFY_RUN_TIMEOUT_SECS,
    maxCachedItems: env.APIFY_MAX_CACHED_ITEMS,
  }) : null;
  const sources = env.sourceMode === 'mock' ? mockSources() : {
    website: new WebsiteExtractionSource(repository, websiteEvidenceProvider!),
    bar: new ApifyDirectorySource('bar', apify!, { targetedMaxLawyers: env.APIFY_BAR_TARGETED_MAX_RESULTS }),
    avvo: new ApifyDirectorySource('avvo', apify!, { targetedMaxLawyers: env.APIFY_AVVO_TARGETED_MAX_RESULTS }),
  };
  const domainResolver = env.sourceMode === 'mock' ? new PublicDomainResolver(async url => {
    if (!(MOCK_DOMAINS as readonly string[]).includes(new URL(url).hostname)) throw new Error('Unknown mock domain');
  }) : new PublicDomainResolver();
  const assessmentAgent = env.sourceMode === 'live' && env.ASSESSMENT_PLANNER === 'agent'
    ? createOpenAIPlanner({ apiKey: env.OPENAI_API_KEY!, model: env.SIGNAL_LLM_MODEL }) : undefined;
  // The model a built component calls: the extraction's first, then the planner's. Rules and fixtures call none.
  const signalLlmModel = evidence === 'agentic' ? env.SIGNAL_LLM_MODEL : evidence === 'openai' ? OPENAI_EVIDENCE_MODEL
    : assessmentAgent?.model ?? null;
  const debug = mode !== 'production' && scans && assessments ? createDebugTools({ mode, sources, scans, assessments,
    pipelineTimeoutMs: env.PIPELINE_TIMEOUT_MS,
    // What this process built, so the label cannot lie (DN-09 4): a key sitting in .env.local is not a service in use.
    // Enums, booleans and a model name only, never a key or a URL (DN-09 7).
    describe: { mode, sourceMode: env.sourceMode, storageBackend: env.storageBackend, websiteEvidenceProvider: evidence,
      assessmentPlanner: assessmentAgent ? 'agent' : 'rules', signalLlmModel,
      inUse: { openai: evidence === 'agentic' || evidence === 'openai' || assessmentAgent !== undefined, apify: apify !== null,
        supabase: storageClient !== null } },
    // Only mock keeps its durable side in memory. Supabase is never cleared by a reset.
    clearDurableMemory: durable instanceof InMemoryRepository && durableAssessments instanceof InMemoryAssessmentRepository
      ? () => { durable.clear(); durableAssessments.clear(); } : undefined }) : undefined;
  const clientIps = new WeakMap<Request, string>();
  const { app, drain, recoverAssessments } = createApp({ repository, assessmentRepository, domainResolver, debug, assessmentAgent,
    pipeline: new InProcessPipeline({ ...sources, repository, timeoutMs: env.PIPELINE_TIMEOUT_MS }),
    sessionSecret: env.SESSION_TOKEN_SECRET, corsOrigins: env.corsOrigins,
    renderReport: renderPdf,
    scanCacheTtlMs: env.SCAN_CACHE_TTL_MS, partialRepairCooldownMs: env.SCAN_PARTIAL_REPAIR_COOLDOWN_MS,
    clientIp: request => clientIps.get(request) ?? 'unknown' });
  // `overridden` also lists defaults mock replaced, so it says what changed, not what was set.
  const banner = `[api] MODE=${mode} sources=${env.sourceMode} storage=${env.storageBackend}`
    + (mode === 'production' ? '' : ` (debug routes on ${listenHostname(mode)} only)`)
    + (env.overridden.length ? ` overrides: ${env.overridden.join(', ')}` : '');
  return { app, drain, recoverAssessments, repository, apify, banner, clientIps };
}

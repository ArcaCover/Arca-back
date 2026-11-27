import type { Hono } from 'hono';
import type { loadEnv } from './config/env.js';
import { listenHostname } from './config/mode.js';
import { createApp } from './http/app.js';
import { InMemoryRepository } from './repositories/in-memory.js';
import { SupabaseRepository, createStorageClient } from './repositories/supabase.js';
import type { ScanRepository } from './repositories/types.js';
import { InMemoryAssessmentRepository, SupabaseAssessmentRepository, type AssessmentRepository } from './assessment/repository.js';
import { InProcessPipeline } from './pipeline/in-process-pipeline.js';
import { WebsiteExtractionSource } from './pipeline/website-source.js';
import { OPENAI_EVIDENCE_MODEL, OpenAIEvidenceProvider, RuleBasedEvidenceProvider } from './pipeline/website-evidence-provider.js';
import { AgenticEvidenceProvider } from './pipeline/agentic-evidence-provider.js';
import { openAiEndpoint } from './pipeline/llm-endpoint.js';
import { ApifyClient } from './pipeline/apify-client.js';
import { ApifyDirectorySource, AVVO_ACTOR } from './pipeline/directories.js';
import { PublicDomainResolver } from './pipeline/domain-resolution.js';
import { mockSources, MOCK_DOMAINS } from './pipeline/mock-sources.js';
import { RoutingAssessmentRepository, RoutingScanRepository } from './debug/isolation.js';
import { createDebugTools } from './debug/tools.js';
import { createOpenAIPlanner } from '@arca/questions';
import { renderPdf } from './report/pdf.js';
import { MockAppAuth, SupabaseJwtAuth, mockUserIdFor } from './webapp/auth.js';
import { InMemoryAuthAdmin } from './webapp/auth-admin.js';
import { MockBillingProvider, type BillingProvider } from './webapp/billing.js';
import { InMemoryWebappRepository } from './webapp/in-memory.js';
import { MailingWebappService } from './webapp/invitation-email.js';
import { MemoryMailer, ResendMailer, SesMailer } from './webapp/mailer.js';
import { DEFAULT_PLANS, catalogIdsOf, priceColumnOf } from './webapp/plans.js';
import { REAL_WEBAPP_ADAPTERS, type RealWebappAdapters, type StorageClient } from './webapp/real-adapters.js';
import type { ReconcileReport } from './webapp/billing-events.js';
import type { WebappRepository } from './webapp/types.js';

/**
 * The webapp of the debug modes: accounts, organizations and billing in memory, behind the simulated login and payment. Its
 * tokens are signed with a key derived from the scan session secret (DN-10 §4.1). It only reads the scans and assessments it
 * is given, which are mock's memory or, in live-debug, Supabase: a claim writes nothing there (DN-12 §7).
 */
function simulatedWebapp(env: ReturnType<typeof loadEnv>, scans: RoutingScanRepository, assessments: RoutingAssessmentRepository) {
  const repository = new InMemoryWebappRepository(DEFAULT_PLANS);
  const billing = new MockBillingProvider(env.APP_BASE_URL);
  // Invitations are kept in memory, for the tests and the debug panel; the response still carries the link (DN-13 §7.1).
  const mailer = new MemoryMailer();
  // Enrolling and closing accounts act on a simulated Auth whose users have the simulated login's ids (DN-13 T7, T11).
  const authAdmin = new InMemoryAuthAdmin(mockUserIdFor);
  const service = new MailingWebappService({ repository, scans, assessments, billing, sessionSecret: env.SESSION_TOKEN_SECRET,
    appBaseUrl: env.APP_BASE_URL, authAdmin,
    // A scan with an injected fault lives in memory only, so it can never belong to an organization.
    isDurableScan: scanId => !scans.isIsolated(scanId) }, { mailer, from: env.emailFrom });
  return { repository, billing, service, mailer, authAdmin, auth: new MockAppAuth(env.SESSION_TOKEN_SECRET) };
}

/**
 * The real webapp (DN-13 §7.1): production with WEBAPP_ENABLED=true, or live-debug with WEBAPP_PROVIDERS=real. Supabase Auth
 * verifies the tokens; the repository and the billing provider come from the seam, and without them the start is refused rather
 * than served by a simulated piece. It claims the scans and assessments it is given, the same ones the funnel writes.
 */
async function realWebapp(env: ReturnType<typeof loadEnv>, adapters: RealWebappAdapters, deps: { client: () => StorageClient;
  scans: ScanRepository; assessments: AssessmentRepository; isDurableScan?: (scanId: string) => boolean }) {
  const missing = [...(adapters.repository ? [] : ['the Supabase webapp repository (DN-13 T4)']),
    ...(adapters.authAdmin ? [] : ['the Supabase Auth admin (DN-13 T7)']),
    ...(adapters.billing ? [] : ['the Stripe billing provider (DN-13 T14)']),
    ...(env.emailProvider === 'ses' && !adapters.sesSendEmail ? ['the SES sender (see SesMailer)'] : [])];
  if (missing.length) {
    throw new Error(`The real webapp cannot start without ${missing.join(', ')}, handed to compose as RealWebappAdapters. `
      + 'Production keeps answering 501 with WEBAPP_ENABLED=false');
  }
  const auth = new SupabaseJwtAuth(env.SUPABASE_URL!, { fetchJwks: adapters.fetchJwks });
  await auth.checkSigningKeys();
  const billing = adapters.billing!({ secretKey: env.STRIPE_SECRET_KEY!, webhookSecret: env.STRIPE_WEBHOOK_SECRET!, mode: env.stripeMode!,
    appBaseUrl: env.APP_BASE_URL });
  const mailer = env.emailProvider === 'ses' ? new SesMailer(adapters.sesSendEmail!)
    : env.emailProvider === 'resend' ? new ResendMailer(env.RESEND_API_KEY!, { fetch: adapters.resendFetch }) : new MemoryMailer();
  // One service-role client for the data and the Auth admin API.
  const client = deps.client();
  const repository = adapters.repository!(client);
  await requireCatalogPrices(env, repository, billing);
  const service = new MailingWebappService({ repository, authAdmin: adapters.authAdmin!(client), scans: deps.scans,
    assessments: deps.assessments, billing, sessionSecret: env.SESSION_TOKEN_SECRET, appBaseUrl: env.APP_BASE_URL,
    isDurableScan: deps.isDurableScan }, { mailer, from: env.emailFrom });
  return { service, auth };
}

/**
 * Every active plan must charge a catalog price of the key's mode (DN-13 §5.3, §21), and Stripe must hold it: the price exists in the
 * account of the key, is active, and its livemode is the key's. One read per plan at start. Production with the webapp on refuses to
 * start otherwise (also when Stripe cannot be asked), rather than fail the first customer's checkout; live-debug says so and starts,
 * so the rest of the webapp can be tried before the catalog exists. A provider that charges no catalog price (the simulated one) is
 * asked nothing, but the ids must still be there.
 */
async function requireCatalogPrices(env: ReturnType<typeof loadEnv>, repository: WebappRepository, billing: BillingProvider) {
  const mode = env.stripeMode!;
  const problems = await Promise.all((await repository.listPlans()).filter(plan => plan.active).map(async plan => {
    const { priceId } = catalogIdsOf(plan, mode);
    if (!priceId) return `${plan.code} has no ${mode} price (plans.${priceColumnOf(mode)})`;
    if (!billing.needsCatalogPrice) return null;
    let state: Awaited<ReturnType<BillingProvider['priceState']>>;
    try {
      state = await billing.priceState(priceId);
    } catch (error) {
      return `${plan.code}: Stripe could not be asked for its ${mode} price ${priceId} (${error instanceof Error ? error.name : 'unknown error'})`;
    }
    if (!state) return `${plan.code}: its ${mode} price ${priceId} does not exist in this Stripe account`;
    if (state.livemode !== (mode === 'live')) return `${plan.code}: its ${mode} price ${priceId} is a ${state.livemode ? 'live' : 'test'} price`;
    if (!state.active) return `${plan.code}: its ${mode} price ${priceId} is archived`;
    return null;
  }));
  const found = problems.filter((problem): problem is string => problem !== null);
  if (!found.length) return;
  const message = `the Stripe catalog of this ${mode} key is not ready: ${found.join('; ')}. Run npm run stripe:catalog (a dry run), then `
    + `npm run stripe:catalog -- --apply${mode === 'live' ? ' --allow-live' : ''}, against this database with this key`;
  if (env.mode === 'production') throw new Error(`The real webapp cannot start: ${message}`);
  console.warn(`[billing] ${message}; until then those plans cannot be bought`);
}

/**
 * What /__debug/mode says of the webapp (DN-13 §8.4, T19): the simulated one bills through the simulated checkout, the real one
 * through Stripe in the key's mode. Only the mode word leaves, never the key. A live key never reaches a debug mode (loadEnv stops
 * it), and the debug contract cannot even say `live`: were one to get here, the start is refused rather than described.
 */
function debugWebapp(env: ReturnType<typeof loadEnv>): { webapp: 'simulated' | 'real'; billing: 'simulated' | 'test' } {
  if (env.webapp !== 'real') return { webapp: 'simulated', billing: 'simulated' };
  if (env.stripeMode !== 'test') throw new Error('A debug mode runs the real webapp on a Stripe test key only (DN-13 §3.2)');
  return { webapp: 'real', billing: 'test' };
}

/** A scan still RUNNING past this point outlived its pipeline budget: a restart cut it short. */
export const interruptedBefore = (pipelineTimeoutMs: number) => new Date(Date.now() - pipelineTimeoutMs - 120_000).toISOString();

/**
 * Builds the API the environment describes: production exactly as configured, the debug modes with the same storage
 * behind the routing repositories plus the debug tools (DN-09 5.1). Reads only the resolved mode, sourceMode,
 * storageBackend and ASSESSMENT_PLANNER: under mock the raw SOURCE_MODE and STORAGE_BACKEND still say what the file said.
 * The server fills `clientIps` per request, from the socket and the trusted proxy hops.
 * `storage` replaces the durable repositories the environment names. Only tests pass it, to stand in for Supabase.
 * `adapters` are the real webapp's pieces (DN-13 §7.1), read only when the environment asks for the real webapp.
 */
export async function compose(env: ReturnType<typeof loadEnv>,
  storage?: { scans: ScanRepository; assessments: AssessmentRepository },
  adapters: RealWebappAdapters = REAL_WEBAPP_ADAPTERS): Promise<{ app: Hono; drain: () => Promise<void>;
  recoverAssessments: () => Promise<void>; repository: ScanRepository; apify: ApifyClient | null; banner: string;
  clientIps: WeakMap<Request, string>;
  /** The real webapp's daily Stripe reconciliation (DN-13 §9.5), for the process to schedule; null without the real webapp. */
  reconcileBilling: (() => Promise<ReconcileReport>) | null }> {
  const mode = env.mode;
  const storageClient = !storage && env.storageBackend === 'supabase' ? createStorageClient(env.SUPABASE_URL!, env.supabaseKey!) : null;
  const durable = storage?.scans ?? (storageClient ? new SupabaseRepository(storageClient) : new InMemoryRepository());
  const durableAssessments = storage?.assessments
    ?? (storageClient ? new SupabaseAssessmentRepository(storageClient) : new InMemoryAssessmentRepository());
  // createApp and the debug tools must share these very instances: the tools isolate a scan in the router the app writes through.
  const scans = mode === 'production' ? null : new RoutingScanRepository(durable, new InMemoryRepository());
  const assessments = scans && new RoutingAssessmentRepository(durableAssessments, new InMemoryAssessmentRepository(), scans);
  const repository = scans ?? durable;
  const assessmentRepository = assessments ?? durableAssessments;
  // The private webapp (DN-10, DN-13 §3.2). Production builds none unless WEBAPP_ENABLED=true, and then the real one: by default
  // every webapp route answers 501. The debug modes run the simulated one, over the memory of mock or, in live-debug, over the
  // real scans (DN-12 §7), unless live-debug asks for the real providers. Built before anything reaches Supabase, so a missing
  // adapter stops the start first.
  const simulated = env.webapp === 'simulated' && scans && assessments ? simulatedWebapp(env, scans, assessments) : undefined;
  const webapp = simulated ?? (env.webapp === 'real' ? await realWebapp(env, adapters, {
    client: () => storageClient ?? createStorageClient(env.SUPABASE_URL!, env.supabaseKey!), scans: repository,
    assessments: assessmentRepository, isDurableScan: scans ? scanId => !scans.isIsolated(scanId) : undefined }) : undefined);
  await repository.recoverInterrupted(interruptedBefore(env.PIPELINE_TIMEOUT_MS));
  // The fixtures read the website in mock; otherwise the configured provider does. /__debug/mode reports this very value.
  const evidence = env.sourceMode === 'mock' ? 'mock' as const : env.WEBSITE_EVIDENCE_PROVIDER;
  const websiteEvidenceProvider = evidence === 'mock' ? null : evidence === 'openai'
    ? new OpenAIEvidenceProvider(env.OPENAI_API_KEY!) : evidence === 'rules'
      ? new RuleBasedEvidenceProvider() : new AgenticEvidenceProvider(env.OPENAI_API_KEY!, env.SIGNAL_LLM_MODEL, undefined,
        undefined, openAiEndpoint(env.SIGNAL_LLM_REASONING_EFFORT),
        env.openAiMaxRequestsPerScan === null ? {} : { maxRequests: env.openAiMaxRequestsPerScan });
  const apify = env.sourceMode === 'live' ? new ApifyClient(env.APIFY_API_TOKEN!, fetch, env.MAX_APIFY_CONCURRENCY, {
    store: repository, build: env.APIFY_ACTOR_BUILD, expectedCostUsdPerRun: env.APIFY_EXPECTED_COST_USD_PER_RUN,
    expectedCostUsdPerTargetedRun: env.APIFY_EXPECTED_COST_USD_PER_TARGETED_RUN,
    expectedCostUsdPerTargetedRunByActor: { [AVVO_ACTOR]: env.APIFY_AVVO_EXPECTED_COST_USD_PER_TARGETED_RUN },
    cacheTtlMs: env.APIFY_QUERY_CACHE_TTL_MS, activeTtlMs: env.APIFY_ACTIVE_RUN_TTL_MS,
    runTimeoutSecs: env.APIFY_RUN_TIMEOUT_SECS,
    maxCachedItems: env.APIFY_MAX_CACHED_ITEMS,
    // Null in production unless its environment sets one: spend is recorded there, not capped (DN-12 §5).
    spendCeilingUsd: env.apifySpendCeilingUsd,
  }) : null;
  const sources = env.sourceMode === 'mock' ? mockSources() : {
    website: new WebsiteExtractionSource(repository, websiteEvidenceProvider!, undefined,
      { reuseMaxAgeMs: env.WEBSITE_SIGNAL_REUSE_MAX_AGE_MS }),
    bar: new ApifyDirectorySource('bar', apify!, { targetedMaxLawyers: env.APIFY_BAR_TARGETED_MAX_RESULTS,
      officeSampleMaxLawyers: env.APIFY_BAR_OFFICE_SAMPLE_MAX_RESULTS }),
    avvo: new ApifyDirectorySource('avvo', apify!, { targetedMaxLawyers: env.APIFY_AVVO_TARGETED_MAX_RESULTS,
      officeSampleMaxLawyers: env.APIFY_AVVO_OFFICE_SAMPLE_MAX_RESULTS }),
  };
  const domainResolver = env.sourceMode === 'mock' ? new PublicDomainResolver(async url => {
    if (!(MOCK_DOMAINS as readonly string[]).includes(new URL(url).hostname)) throw new Error('Unknown mock domain');
  }) : new PublicDomainResolver();
  const assessmentAgent = env.sourceMode === 'live' && env.ASSESSMENT_PLANNER === 'agent'
    ? createOpenAIPlanner({ apiKey: env.OPENAI_API_KEY!, model: env.SIGNAL_LLM_MODEL }) : undefined;
  // The model a built component calls: the extraction's first, then the planner's. Rules and fixtures call none.
  const signalLlmModel = evidence === 'agentic' ? env.SIGNAL_LLM_MODEL : evidence === 'openai' ? OPENAI_EVIDENCE_MODEL
    : assessmentAgent?.model ?? null;
  // Only the simulated webapp reaches the debug tools: with the real providers there is no mock login or payment (404).
  const debug = mode !== 'production' && scans && assessments ? createDebugTools({ mode, sources, scans, assessments, webapp: simulated,
    pipelineTimeoutMs: env.PIPELINE_TIMEOUT_MS,
    // What this process built, so the label cannot lie (DN-09 4): a key sitting in .env.local is not a service in use.
    // Enums, booleans and a model name only, never a key or a URL (DN-09 7). storageBackend is where scans and assessments
    // live; webapp and billing say which webapp was built and what bills it (DN-13 §8.4, T19).
    describe: { mode, sourceMode: env.sourceMode, storageBackend: env.storageBackend, websiteEvidenceProvider: evidence,
      assessmentPlanner: assessmentAgent ? 'agent' : 'rules', signalLlmModel,
      inUse: { openai: evidence === 'agentic' || evidence === 'openai' || assessmentAgent !== undefined, apify: apify !== null,
        supabase: storageClient !== null },
      ...debugWebapp(env) },
    // Only mock keeps its durable side in memory. Supabase is never cleared by a reset.
    clearDurableMemory: durable instanceof InMemoryRepository && durableAssessments instanceof InMemoryAssessmentRepository
      ? () => { durable.clear(); durableAssessments.clear(); } : undefined }) : undefined;
  const clientIps = new WeakMap<Request, string>();
  const { app, drain, recoverAssessments } = createApp({ repository, assessmentRepository, domainResolver, debug, assessmentAgent,
    webapp: webapp && { service: webapp.service, auth: webapp.auth },
    pipeline: new InProcessPipeline({ ...sources, repository, timeoutMs: env.PIPELINE_TIMEOUT_MS }),
    sessionSecret: env.SESSION_TOKEN_SECRET, corsOrigins: env.corsOrigins,
    pilotAccessToken: env.ARCA_DEPLOYMENT === 'aws-pilot' ? env.PILOT_ACCESS_TOKEN?.trim() : undefined,
    renderReport: renderPdf,
    scanCacheTtlMs: env.SCAN_CACHE_TTL_MS, partialRepairCooldownMs: env.SCAN_PARTIAL_REPAIR_COOLDOWN_MS,
    clientIp: request => clientIps.get(request) ?? 'unknown' });
  // `overridden` also lists defaults mock replaced, so it says what changed, not what was set.
  // The spend guards are named only where they act: on a client this process built.
  const guards = [...(apify && env.apifySpendCeilingUsd !== null ? [`Apify ceiling USD ${env.apifySpendCeilingUsd} per 24 h`] : []),
    ...(evidence === 'agentic' && env.openAiMaxRequestsPerScan !== null ? [`OpenAI cap ${env.openAiMaxRequestsPerScan} requests per scan`] : [])];
  const banner = `[api] MODE=${mode} sources=${env.sourceMode} storage=${env.storageBackend}`
    // storage= is where the scans live. Where the webapp does not live there too, the line says so, and what the real one runs on.
    + (simulated && env.storageBackend !== 'memory' ? ' webapp=simulated-in-memory' : '')
    + (env.webapp === 'real' ? ` webapp=real stripe=${env.stripeMode} email=${env.emailProvider}` : '')
    + (mode === 'production' ? '' : ` (debug routes on ${listenHostname(mode)} only)`)
    + (guards.length ? ` spend guards: ${guards.join(', ')}` : '')
    + (env.overridden.length ? ` overrides: ${env.overridden.join(', ')}` : '');
  const reconcileBilling = env.webapp === 'real' && webapp ? () => webapp.service.reconcileBilling() : null;
  return { app, drain, recoverAssessments, repository, apify, banner, clientIps, reconcileBilling };
}

import { z } from 'zod';
import { DEFAULT_SIGNAL_LLM_MODEL } from '../pipeline/llm-endpoint.js';
import { ARCA_MODES } from './mode.js';
/** What live-debug guards its spend with unless the environment says otherwise (DN-12 §5). Production has neither. */
export const LIVE_DEBUG_APIFY_SPEND_CEILING_USD = 2;
export const LIVE_DEBUG_OPENAI_MAX_REQUESTS_PER_SCAN = 30;
// An empty line in an env file means "not set", never zero: a ceiling of 0 starts no run at all.
const blankAsUnset = (value: unknown) => typeof value === 'string' && value.trim() === '' ? undefined : value;
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  // Absent means production; an unknown value stops the start instead of falling into a mode (DN-09 §4).
  ARCA_MODE: z.enum(ARCA_MODES).default('production'),
  // Set by deploy/production.env, which ships inside the image. Any value refuses the debug modes.
  ARCA_DEPLOYMENT: z.string().optional(),
  // Pilot only (ARCA_DEPLOYMENT=aws-pilot): every request but /health must carry it in X-Arca-Pilot-Token.
  PILOT_ACCESS_TOKEN: z.string().optional(),
  SOURCE_MODE: z.enum(['mock', 'live']).optional(),
  STORAGE_BACKEND: z.enum(['memory', 'supabase']).optional(),
  // Layer 2 is rules-only by default; mock mode also disables the optional agent.
  ASSESSMENT_PLANNER: z.enum(['rules', 'agent']).default('rules'),
  // agentic: the multi-round extraction through OpenAI. openai: the earlier single-pass extraction.
  // rules: deterministic, no language model.
  WEBSITE_EVIDENCE_PROVIDER: z.enum(['agentic', 'rules', 'openai']).default('agentic'),
  // Backward-compatible defaults for existing environments. Explicit modes take precedence.
  MOCK_MODE: z.enum(['true', 'false']).optional(),
  SUPABASE_URL: z.string().optional(), SUPABASE_SECRET_KEY: z.string().optional(), SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  SESSION_TOKEN_SECRET: z.string().min(32), OPENAI_API_KEY: z.string().optional(), APIFY_API_TOKEN: z.string().optional(),
  // OpenAI model of the agentic extraction. An empty value falls back to the default.
  SIGNAL_LLM_MODEL: z.preprocess(value => typeof value === 'string' && value.trim() === '' ? undefined : value,
    z.string().trim().default(DEFAULT_SIGNAL_LLM_MODEL)),
  // Optional for OpenAI reasoning models; an empty value means not configured.
  SIGNAL_LLM_REASONING_EFFORT: z.preprocess(value => value === '' ? undefined : value,
    z.enum(['none', 'minimal', 'low', 'medium', 'high']).optional()),
  CORS_ALLOWED_ORIGINS: z.string().min(1),
  // Where the front serves the webapp: the base of the invitation links and the billing return URLs (DN-10 §4.8).
  // An empty value falls back to the default; only http and https, since every link built on it is sent to a browser.
  APP_BASE_URL: z.preprocess(value => typeof value === 'string' && value.trim() === '' ? undefined : value,
    z.string().trim().url().refine(url => /^https?:\/\//i.test(url), 'APP_BASE_URL must be an http or https URL')
      .default('http://localhost:3000')),
  // The private webapp (DN-13 §7.1). Production serves it only with WEBAPP_ENABLED=true, on the real providers; without it every
  // webapp route answers 501. The debug modes always serve it: simulated by default, real only in live-debug with
  // WEBAPP_PROVIDERS=real. Never a JWT secret: Supabase tokens verify against the project's JWKS, derived from SUPABASE_URL.
  WEBAPP_ENABLED: z.preprocess(blankAsUnset, z.enum(['true', 'false']).default('false')),
  WEBAPP_PROVIDERS: z.preprocess(blankAsUnset, z.enum(['simulated', 'real']).optional()),
  // Stripe's mode comes from the key's prefix (DN-13 §6.7); StripeBillingProvider (webapp/stripe.ts) uses both with the real webapp.
  STRIPE_SECRET_KEY: z.preprocess(blankAsUnset, z.string().trim().optional()),
  STRIPE_WEBHOOK_SECRET: z.preprocess(blankAsUnset, z.string().trim().optional()),
  // Lets production run on a test key, for a rehearsal on the host before the launch. It never lets a live key run elsewhere.
  STRIPE_ALLOW_TEST_MODE: z.preprocess(blankAsUnset, z.enum(['true', 'false']).default('false')),
  // How the back sends its own emails (invitations, DN-13 §4.6). memory keeps them in the process (the debug modes' default);
  // resend sends through Resend's API (production's, F11), ses through Amazon SES (the alternative, and production's default).
  EMAIL_PROVIDER: z.preprocess(blankAsUnset, z.enum(['memory', 'ses', 'resend']).optional()),
  EMAIL_FROM: z.preprocess(blankAsUnset, z.string().trim().optional()),
  // Resend's API key (re_…), read only with EMAIL_PROVIDER=resend. In production it lives in SSM, /arca/prod/RESEND_API_KEY.
  RESEND_API_KEY: z.preprocess(blankAsUnset, z.string().trim().optional()),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  // Actor runs in flight at once, across every scan. The account allows 32 jobs and 64 GB, and each
  // directory run takes 1 GB: 16 lets Bar and Avvo each run 8 lookups at once, half the account.
  MAX_APIFY_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(16),
  APIFY_ACTOR_BUILD: z.string().min(1).default('latest'),
  // Provisional figure the ledger reserves for a run until Apify reports what it really cost.
  // Accounting only unless a spend ceiling is set, which counts it for every run not settled yet.
  APIFY_EXPECTED_COST_USD_PER_RUN: z.coerce.number().positive().default(1),
  // What a targeted lookup (a few named lawyers) reserves instead. A Florida Bar lookup of one lawyer settled at USD 0.045.
  // The Avvo actor returns up to ten detailed lawyers per lookup and one such run settled at USD 0.385, so it reserves more.
  // Firm searches, whole-registry or one per Florida office city, keep APIFY_EXPECTED_COST_USD_PER_RUN (DN-06 §10).
  APIFY_EXPECTED_COST_USD_PER_TARGETED_RUN: z.coerce.number().positive().default(0.1),
  APIFY_AVVO_EXPECTED_COST_USD_PER_TARGETED_RUN: z.coerce.number().positive().default(0.4),
  // USD of Apify runs the ledger may hold over its last 24 hours before a new run is refused (DN-12 §5).
  // Unset means no ceiling: production records spend and never caps it. live-debug defaults to 2.
  // 0 starts no run at all and still serves the queries already cached.
  APIFY_SPEND_CEILING_USD: z.preprocess(blankAsUnset, z.coerce.number().finite().nonnegative().optional()),
  // Chat completions the website extraction of one scan may request. Unset means no cap (production);
  // live-debug defaults to 30. The largest recorded extraction (25 attorneys) made 12; it would have made
  // 26 had every one of its phases needed a repair.
  OPENAI_MAX_REQUESTS_PER_SCAN: z.preprocess(blankAsUnset, z.coerce.number().int().min(1).optional()),
  // Kept in step with SCAN_CACHE_TTL_MS. If this expires first, repairing a partial scan
  // re-pays the directory runs it was meant to reuse.
  APIFY_QUERY_CACHE_TTL_MS: z.coerce.number().int().positive().default(604_800_000),
  APIFY_ACTIVE_RUN_TTL_MS: z.coerce.number().int().positive().default(900_000),
  APIFY_RUN_TIMEOUT_SECS: z.coerce.number().int().min(60).max(86_400).default(300),
  APIFY_BAR_TARGETED_MAX_RESULTS: z.coerce.number().int().min(1).max(1000).default(25),
  APIFY_AVVO_TARGETED_MAX_RESULTS: z.coerce.number().int().min(1).max(1000).default(10),
  // Lawyers one office-city firm search of a large firm reads (DN-12 §13.9): a fixed sample, so the run ends on its own
  // limit, under its reservation, and stays reusable.
  APIFY_BAR_OFFICE_SAMPLE_MAX_RESULTS: z.coerce.number().int().min(1).max(1000).default(20),
  APIFY_AVVO_OFFICE_SAMPLE_MAX_RESULTS: z.coerce.number().int().min(1).max(1000).default(10),
  APIFY_MAX_CACHED_ITEMS: z.coerce.number().int().min(1).max(10_000).default(1000),
  PIPELINE_TIMEOUT_MS: z.coerce.number().int().min(10_000).max(3_600_000).default(600_000),
  // Domain scan cache window. Layer 1 evidence (a published AI policy, bar standing, an
  // Avvo rating) changes in weeks, not hours.
  SCAN_CACHE_TTL_MS: z.coerce.number().int().positive().default(604_800_000),
  // Only a PARTIAL scan with a passing failure (a deadline, a provider) is run again, at most once per
  // this window; inside it the last run is served. 0 repairs it on every request. A PARTIAL whose gaps a
  // second scan would find again is served for the whole cache window (DN-12 §4).
  SCAN_PARTIAL_REPAIR_COOLDOWN_MS: z.coerce.number().int().nonnegative().default(3_600_000),
  // How old a stored website analysis may be and still stand in for a new extraction of the same
  // evidence, counted from the day the model produced it: 30 days. 0 extracts on every scan.
  WEBSITE_SIGNAL_REUSE_MAX_AGE_MS: z.coerce.number().int().nonnegative().default(2_592_000_000),
});
export function loadEnv(source = process.env) {
  const env = EnvSchema.parse(source);
  const mode = env.ARCA_MODE;
  // A deployment runs production, with one exception: the pilot deployment (DN-14 §5), which runs live-debug and only behind
  // its access token. Any other value with a debug mode refuses to start, so a copied file cannot open a debug mode in AWS.
  if (env.ARCA_DEPLOYMENT === 'aws-pilot') {
    if (mode !== 'live-debug') throw new Error(`ARCA_DEPLOYMENT=aws-pilot runs only ARCA_MODE=live-debug, not ${mode}`);
    if ((env.PILOT_ACCESS_TOKEN?.trim().length ?? 0) < 32) {
      throw new Error('ARCA_DEPLOYMENT=aws-pilot requires PILOT_ACCESS_TOKEN of at least 32 characters');
    }
  } else if (mode !== 'production' && env.ARCA_DEPLOYMENT !== undefined) {
    throw new Error(`ARCA_MODE=${mode} cannot start while ARCA_DEPLOYMENT is set: a deployment only runs production`);
  }
  // What the configuration alone would run with, before a mode touches it.
  const inheritedSourceMode = env.SOURCE_MODE ?? (env.MOCK_MODE === 'true' ? 'mock' : 'live');
  const inheritedStorageBackend = env.STORAGE_BACKEND ?? (env.MOCK_MODE === 'true' ? 'memory' : 'supabase');
  // live-debug is the costly direction, so it forces nothing: it only checks that the real thing is configured.
  if (mode === 'live-debug') {
    if (inheritedSourceMode !== 'live') throw new Error(`ARCA_MODE=live-debug requires SOURCE_MODE=live, but it resolves to ${inheritedSourceMode}`);
    if (inheritedStorageBackend !== 'supabase') throw new Error(`ARCA_MODE=live-debug requires STORAGE_BACKEND=supabase, but it resolves to ${inheritedStorageBackend}`);
  }
  // mock is the safe direction: it wins over whatever the environment says, and loadEnv reports what it replaced.
  const sourceMode = mode === 'mock' ? 'mock' : inheritedSourceMode;
  const storageBackend = mode === 'mock' ? 'memory' : inheritedStorageBackend;
  const assessmentPlanner = mode === 'mock' ? 'rules' : env.ASSESSMENT_PLANNER;
  // live-debug is the mode that pays real providers from a developer's machine, so it brings its own guards.
  // An explicit value wins in every mode; production without one stays uncapped.
  const apifySpendCeilingUsd = env.APIFY_SPEND_CEILING_USD ?? (mode === 'live-debug' ? LIVE_DEBUG_APIFY_SPEND_CEILING_USD : null);
  const openAiMaxRequestsPerScan = env.OPENAI_MAX_REQUESTS_PER_SCAN
    ?? (mode === 'live-debug' ? LIVE_DEBUG_OPENAI_MAX_REQUESTS_PER_SCAN : null);
  // Every kind of run must fit under a ceiling on its own: one that only targeted lookups fit under would refuse every
  // firm search while looking like a budget, and the other way round.
  if (apifySpendCeilingUsd !== null && apifySpendCeilingUsd > 0) {
    for (const name of ['APIFY_EXPECTED_COST_USD_PER_RUN', 'APIFY_EXPECTED_COST_USD_PER_TARGETED_RUN', 'APIFY_AVVO_EXPECTED_COST_USD_PER_TARGETED_RUN'] as const) {
      if (apifySpendCeilingUsd < env[name]) {
        throw new Error(`APIFY_SPEND_CEILING_USD is below ${name}, so no such run could ever start; use 0 to serve cached queries only`);
      }
    }
  }
  const overridden = [['SOURCE_MODE', inheritedSourceMode, sourceMode], ['STORAGE_BACKEND', inheritedStorageBackend, storageBackend], ['ASSESSMENT_PLANNER', env.ASSESSMENT_PLANNER, assessmentPlanner]]
    .filter(([, was, now]) => was !== now).map(([name, was, now]) => `${name}=${was}→${now}`);
  const supabaseKey = env.SUPABASE_SECRET_KEY?.trim() || env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (storageBackend === 'supabase') {
    if (!env.SUPABASE_URL?.trim()) throw new Error('SUPABASE_URL is required for Supabase storage');
    if (!supabaseKey) throw new Error('SUPABASE_SECRET_KEY (or legacy SUPABASE_SERVICE_ROLE_KEY) is required for Supabase storage');
    if (supabaseKey.startsWith('sb_publishable_')) throw new Error('Supabase storage requires a server secret key, not a publishable key');
  }
  const { webapp, stripeMode, emailProvider, emailFrom } = webappProviders(env, mode, storageBackend);
  if (sourceMode === 'live' && !env.APIFY_API_TOKEN?.trim()) throw new Error('APIFY_API_TOKEN is required for live directory sources');
  if (sourceMode === 'live' && env.WEBSITE_EVIDENCE_PROVIDER !== 'rules' && !env.OPENAI_API_KEY?.trim()) {
    throw new Error(`OPENAI_API_KEY is required when WEBSITE_EVIDENCE_PROVIDER=${env.WEBSITE_EVIDENCE_PROVIDER}`);
  }
  if (sourceMode === 'live' && assessmentPlanner === 'agent' && !env.OPENAI_API_KEY?.trim()) {
    throw new Error('OPENAI_API_KEY is required when ASSESSMENT_PLANNER=agent');
  }
  const corsOrigins = env.CORS_ALLOWED_ORIGINS.split(',').map(value => value.trim()).filter(Boolean);
  for (const origin of corsOrigins) if (new URL(origin).origin !== origin) throw new Error('CORS entries must be exact origins');
  if (env.SUPABASE_URL) z.string().url().parse(env.SUPABASE_URL);
  if (env.SCAN_PARTIAL_REPAIR_COOLDOWN_MS > env.SCAN_CACHE_TTL_MS) {
    throw new Error('SCAN_PARTIAL_REPAIR_COOLDOWN_MS cannot exceed SCAN_CACHE_TTL_MS');
  }
  if (env.APIFY_ACTIVE_RUN_TTL_MS < (env.APIFY_RUN_TIMEOUT_SECS + 60) * 1000) {
    throw new Error('APIFY_ACTIVE_RUN_TTL_MS must exceed the remote run timeout by at least 60 seconds');
  }
  return { ...env, ASSESSMENT_PLANNER: assessmentPlanner, mode, overridden, sourceMode, storageBackend, supabaseKey, corsOrigins,
    apifySpendCeilingUsd, openAiMaxRequestsPerScan, webapp, stripeMode, emailProvider, emailFrom };
}

export const DEFAULT_EMAIL_FROM = 'ARCA <no-reply@arcacover.com>';
// A bare address, or a display name and one address in angle brackets: one sender, and nothing that could become a header.
const SENDER = /^(?:([^<>",;\u0000-\u001f\u007f]{1,64}) <([^<>\s,;]+)>|([^<>\s,;"]+))$/;

function emailSender(value: string): string {
  const match = SENDER.exec(value);
  const address = match?.[2] ?? match?.[3];
  if (!address || !z.string().email().safeParse(address).success) {
    throw new Error('EMAIL_FROM must be an address, or a name and an address in angle brackets (ARCA <no-reply@arcacover.com>)');
  }
  return value;
}

/** What the prefix of a Stripe secret or restricted key says (DN-13 §6.7). A publishable key, or anything else, is refused. */
export function stripeKeyMode(key: string): 'live' | 'test' {
  const prefix = /^(?:sk|rk)_(live|test)_\S+$/.exec(key);
  if (!prefix) throw new Error('STRIPE_SECRET_KEY must be a Stripe secret (sk_) or restricted (rk_) key, live or test');
  return prefix[1] as 'live' | 'test';
}

/**
 * Which webapp this process serves (DN-13 §3.2, §7.1): none (production's 501), the simulated one (memory, MockAppAuth,
 * MockBillingProvider) or the real one (Supabase, Stripe, a real mailer). Every combination that would mix them, or put a live
 * key where it does not belong, stops the start. SES also needs a sender in the seam, which compose checks (RealWebappAdapters).
 */
function webappProviders(env: z.infer<typeof EnvSchema>, mode: z.infer<typeof EnvSchema>['ARCA_MODE'], storageBackend: 'memory' | 'supabase') {
  const keyMode = env.STRIPE_SECRET_KEY === undefined ? null : stripeKeyMode(env.STRIPE_SECRET_KEY);
  // Checked in every debug mode, even one that never calls Stripe: a live key sitting in .env.local is refused, not ignored.
  if (mode !== 'production' && keyMode === 'live') {
    throw new Error('A live Stripe key (sk_live_ or rk_live_) never loads outside production: put a test key in STRIPE_SECRET_KEY');
  }
  if (mode === 'production' && env.WEBAPP_PROVIDERS !== undefined) {
    throw new Error(`WEBAPP_PROVIDERS=${env.WEBAPP_PROVIDERS} is for live-debug: production always runs the real providers, `
      + 'and switches the webapp on with WEBAPP_ENABLED=true');
  }
  if (mode === 'mock' && env.WEBAPP_PROVIDERS === 'real') {
    throw new Error('ARCA_MODE=mock never calls a real service: WEBAPP_PROVIDERS=real needs ARCA_MODE=live-debug');
  }
  // WEBAPP_ENABLED is production's switch; the debug modes always serve a webapp.
  const webapp = mode === 'production' ? (env.WEBAPP_ENABLED === 'true' ? 'real' : 'none') : env.WEBAPP_PROVIDERS ?? 'simulated';
  const emailProvider = webapp === 'none' ? null : env.EMAIL_PROVIDER ?? (mode === 'production' ? 'ses' : 'memory');
  const emailFrom = env.EMAIL_FROM === undefined ? DEFAULT_EMAIL_FROM : emailSender(env.EMAIL_FROM);
  if (webapp === 'simulated' && emailProvider !== 'memory') {
    throw new Error(`EMAIL_PROVIDER=${emailProvider} needs the real webapp: the simulated one keeps its emails in memory`);
  }
  if (emailProvider === 'resend') {
    if (!env.RESEND_API_KEY) throw new Error('RESEND_API_KEY is required with EMAIL_PROVIDER=resend');
    // Never echoes the value: a key typed into the wrong variable is still a secret.
    if (!/^re_[A-Za-z0-9_-]+$/.test(env.RESEND_API_KEY)) throw new Error('RESEND_API_KEY must be a Resend API key (re_…)');
  }
  if (webapp === 'real') {
    if (storageBackend !== 'supabase') {
      throw new Error('The real webapp keeps its data in Supabase, next to the scans it claims: it requires STORAGE_BACKEND=supabase');
    }
    if (!env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY is required for the real webapp');
    if (!env.STRIPE_WEBHOOK_SECRET) throw new Error('STRIPE_WEBHOOK_SECRET is required for the real webapp');
    if (!env.STRIPE_WEBHOOK_SECRET.startsWith('whsec_')) throw new Error('STRIPE_WEBHOOK_SECRET must be a Stripe webhook signing secret (whsec_)');
    if (mode === 'production') {
      if (keyMode === 'test' && env.STRIPE_ALLOW_TEST_MODE !== 'true') {
        throw new Error('Production refuses a Stripe test key: set STRIPE_ALLOW_TEST_MODE=true only for a rehearsal on the host');
      }
      if (emailProvider === 'memory') {
        throw new Error('EMAIL_PROVIDER=memory would drop every invitation email: production sends with resend (or ses)');
      }
      if (env.EMAIL_FROM === undefined) throw new Error('EMAIL_FROM is required when production switches the webapp on');
      // The default is the local front: invitation links and Stripe's return URLs would send customers to localhost.
      if (!/^https:\/\//i.test(env.APP_BASE_URL)) {
        throw new Error('APP_BASE_URL must be the https address of the front when production switches the webapp on');
      }
    }
  }
  return { webapp, stripeMode: webapp === 'real' ? keyMode : null, emailProvider, emailFrom } as const;
}

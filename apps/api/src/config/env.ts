import { z } from 'zod';
import { DEFAULT_SIGNAL_LLM_MODEL } from '../pipeline/llm-endpoint.js';
import { ARCA_MODES } from './mode.js';
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  // Absent means production; an unknown value stops the start instead of falling into a mode (DN-09 §4).
  ARCA_MODE: z.enum(ARCA_MODES).default('production'),
  // Set by deploy/production.env, which ships inside the image. Any value refuses the debug modes.
  ARCA_DEPLOYMENT: z.string().optional(),
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
  APP_BASE_URL: z.string().url().default('http://localhost:3000'),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  // Actor runs in flight at once, across every scan. The account allows 32 jobs and 64 GB, and each
  // directory run takes 1 GB: 16 lets Bar and Avvo each run 8 lookups at once, half the account.
  MAX_APIFY_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(16),
  APIFY_ACTOR_BUILD: z.string().min(1).default('latest'),
  // Provisional figure the ledger reserves while a run is in flight, before Apify reports
  // the real cost. Accounting only: spend is recorded, never capped.
  APIFY_EXPECTED_COST_USD_PER_RUN: z.coerce.number().positive().default(1),
  // Kept in step with SCAN_CACHE_TTL_MS. If this expires first, repairing a partial scan
  // re-pays the directory runs it was meant to reuse.
  APIFY_QUERY_CACHE_TTL_MS: z.coerce.number().int().positive().default(604_800_000),
  APIFY_ACTIVE_RUN_TTL_MS: z.coerce.number().int().positive().default(900_000),
  APIFY_RUN_TIMEOUT_SECS: z.coerce.number().int().min(60).max(86_400).default(300),
  APIFY_BAR_TARGETED_MAX_RESULTS: z.coerce.number().int().min(1).max(1000).default(25),
  APIFY_AVVO_TARGETED_MAX_RESULTS: z.coerce.number().int().min(1).max(1000).default(10),
  APIFY_MAX_CACHED_ITEMS: z.coerce.number().int().min(1).max(10_000).default(1000),
  PIPELINE_TIMEOUT_MS: z.coerce.number().int().min(10_000).max(3_600_000).default(600_000),
  // Domain scan cache window. Layer 1 evidence (a published AI policy, bar standing, an
  // Avvo rating) changes in weeks, not hours.
  SCAN_CACHE_TTL_MS: z.coerce.number().int().positive().default(604_800_000),
  // A PARTIAL scan is re-run to repair its missing evidence at most once per this window;
  // inside it the last repair is served. 0 repairs on every request.
  SCAN_PARTIAL_REPAIR_COOLDOWN_MS: z.coerce.number().int().nonnegative().default(3_600_000),
});
export function loadEnv(source = process.env) {
  const env = EnvSchema.parse(source);
  const mode = env.ARCA_MODE;
  if (mode !== 'production' && env.ARCA_DEPLOYMENT !== undefined) {
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
  const overridden = [['SOURCE_MODE', inheritedSourceMode, sourceMode], ['STORAGE_BACKEND', inheritedStorageBackend, storageBackend], ['ASSESSMENT_PLANNER', env.ASSESSMENT_PLANNER, assessmentPlanner]]
    .filter(([, was, now]) => was !== now).map(([name, was, now]) => `${name}=${was}→${now}`);
  const supabaseKey = env.SUPABASE_SECRET_KEY?.trim() || env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (storageBackend === 'supabase') {
    if (!env.SUPABASE_URL?.trim()) throw new Error('SUPABASE_URL is required for Supabase storage');
    if (!supabaseKey) throw new Error('SUPABASE_SECRET_KEY (or legacy SUPABASE_SERVICE_ROLE_KEY) is required for Supabase storage');
    if (supabaseKey.startsWith('sb_publishable_')) throw new Error('Supabase storage requires a server secret key, not a publishable key');
  }
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
  return { ...env, ASSESSMENT_PLANNER: assessmentPlanner, mode, overridden, sourceMode, storageBackend, supabaseKey, corsOrigins };
}

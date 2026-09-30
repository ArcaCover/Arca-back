import { z } from 'zod';
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  SOURCE_MODE: z.enum(['mock', 'live']).optional(),
  STORAGE_BACKEND: z.enum(['memory', 'supabase']).optional(),
  WEBSITE_EVIDENCE_PROVIDER: z.enum(['nvidia', 'rules', 'openai']).default('nvidia'),
  // Backward-compatible defaults for existing environments. Explicit modes take precedence.
  MOCK_MODE: z.enum(['true', 'false']).optional(),
  SUPABASE_URL: z.string().optional(), SUPABASE_SECRET_KEY: z.string().optional(), SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  SESSION_TOKEN_SECRET: z.string().min(32), OPENAI_API_KEY: z.string().optional(), APIFY_API_TOKEN: z.string().optional(),
  NVIDIA_NIM_API_KEY: z.string().optional(), NVIDIA_NIM_MODEL: z.string().optional(),
  // Endpoint and model of the agentic extraction (WEBSITE_EVIDENCE_PROVIDER=nvidia).
  SIGNAL_LLM_ENDPOINT: z.enum(['nvidia', 'openai']).default('nvidia'), SIGNAL_LLM_MODEL: z.string().optional(),
  // Optional for OpenAI reasoning models; an empty value means not configured.
  SIGNAL_LLM_REASONING_EFFORT: z.preprocess(value => value === '' ? undefined : value,
    z.enum(['none', 'minimal', 'low', 'medium', 'high']).optional()),
  CORS_ALLOWED_ORIGINS: z.string().min(1),
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
  const sourceMode = env.SOURCE_MODE ?? (env.MOCK_MODE === 'true' ? 'mock' : 'live');
  const storageBackend = env.STORAGE_BACKEND ?? (env.MOCK_MODE === 'true' ? 'memory' : 'supabase');
  const supabaseKey = env.SUPABASE_SECRET_KEY?.trim() || env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (storageBackend === 'supabase') {
    if (!env.SUPABASE_URL?.trim()) throw new Error('SUPABASE_URL is required for Supabase storage');
    if (!supabaseKey) throw new Error('SUPABASE_SECRET_KEY (or legacy SUPABASE_SERVICE_ROLE_KEY) is required for Supabase storage');
    if (supabaseKey.startsWith('sb_publishable_')) throw new Error('Supabase storage requires a server secret key, not a publishable key');
  }
  if (sourceMode === 'live' && !env.APIFY_API_TOKEN?.trim()) throw new Error('APIFY_API_TOKEN is required for live directory sources');
  if (sourceMode === 'live' && env.WEBSITE_EVIDENCE_PROVIDER === 'openai' && !env.OPENAI_API_KEY?.trim()) {
    throw new Error('OPENAI_API_KEY is required only when WEBSITE_EVIDENCE_PROVIDER=openai');
  }
  if (sourceMode === 'live' && env.WEBSITE_EVIDENCE_PROVIDER === 'nvidia') {
    const key = env.SIGNAL_LLM_ENDPOINT === 'openai' ? 'OPENAI_API_KEY' : 'NVIDIA_NIM_API_KEY';
    if (!env[key]?.trim()) throw new Error(`${key} is required when the agentic extraction uses SIGNAL_LLM_ENDPOINT=${env.SIGNAL_LLM_ENDPOINT}`);
    if (env.SIGNAL_LLM_ENDPOINT === 'openai' && !env.SIGNAL_LLM_MODEL?.trim()) throw new Error('SIGNAL_LLM_MODEL is required when SIGNAL_LLM_ENDPOINT=openai');
  }
  const corsOrigins = env.CORS_ALLOWED_ORIGINS.split(',').map(value => value.trim()).filter(Boolean);
  for (const origin of corsOrigins) if (new URL(origin).origin !== origin) throw new Error('CORS entries must be exact origins');
  if (env.SUPABASE_URL) z.string().url().parse(env.SUPABASE_URL);
  const signalModel = env.SIGNAL_LLM_MODEL?.trim() || (env.SIGNAL_LLM_ENDPOINT === 'nvidia' ? env.NVIDIA_NIM_MODEL?.trim() : undefined) || undefined;
  if (env.SCAN_PARTIAL_REPAIR_COOLDOWN_MS > env.SCAN_CACHE_TTL_MS) {
    throw new Error('SCAN_PARTIAL_REPAIR_COOLDOWN_MS cannot exceed SCAN_CACHE_TTL_MS');
  }
  if (env.APIFY_ACTIVE_RUN_TTL_MS < (env.APIFY_RUN_TIMEOUT_SECS + 60) * 1000) {
    throw new Error('APIFY_ACTIVE_RUN_TTL_MS must exceed the remote run timeout by at least 60 seconds');
  }
  return { ...env, NVIDIA_NIM_MODEL: env.NVIDIA_NIM_MODEL?.trim() || undefined, signalModel,
    sourceMode, storageBackend, supabaseKey, corsOrigins };
}

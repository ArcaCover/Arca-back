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
  CORS_ALLOWED_ORIGINS: z.string().min(1),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  MAX_APIFY_CONCURRENCY: z.coerce.number().int().min(1).max(2).default(2),
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
  if (sourceMode === 'live' && env.WEBSITE_EVIDENCE_PROVIDER === 'nvidia' && !env.NVIDIA_NIM_API_KEY?.trim()) {
    throw new Error('NVIDIA_NIM_API_KEY is required when WEBSITE_EVIDENCE_PROVIDER=nvidia');
  }
  const corsOrigins = env.CORS_ALLOWED_ORIGINS.split(',').map(value => value.trim()).filter(Boolean);
  for (const origin of corsOrigins) if (new URL(origin).origin !== origin) throw new Error('CORS entries must be exact origins');
  if (env.SUPABASE_URL) z.string().url().parse(env.SUPABASE_URL);
  return { ...env, NVIDIA_NIM_MODEL: env.NVIDIA_NIM_MODEL?.trim() || undefined,
    sourceMode, storageBackend, supabaseKey, corsOrigins };
}

import { z } from 'zod';
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  SOURCE_MODE: z.enum(['mock', 'live']).optional(),
  STORAGE_BACKEND: z.enum(['memory', 'supabase']).optional(),
  // Backward-compatible defaults for existing environments. Explicit modes take precedence.
  MOCK_MODE: z.enum(['true', 'false']).optional(),
  SUPABASE_URL: z.string().optional(), SUPABASE_SECRET_KEY: z.string().optional(), SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  SESSION_TOKEN_SECRET: z.string().min(32), OPENAI_API_KEY: z.string().optional(), APIFY_API_TOKEN: z.string().optional(),
  CORS_ALLOWED_ORIGINS: z.string().min(1),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
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
  if (sourceMode === 'live') for (const name of ['OPENAI_API_KEY', 'APIFY_API_TOKEN'] as const) {
    if (!env[name]?.trim()) throw new Error(`${name} is required for live sources`);
  }
  const corsOrigins = env.CORS_ALLOWED_ORIGINS.split(',').map(value => value.trim()).filter(Boolean);
  for (const origin of corsOrigins) if (new URL(origin).origin !== origin) throw new Error('CORS entries must be exact origins');
  if (env.SUPABASE_URL) z.string().url().parse(env.SUPABASE_URL);
  return { ...env, sourceMode, storageBackend, supabaseKey, corsOrigins };
}

import { z } from 'zod';

/** Longitud mínima del secreto de JWT: por debajo de esto HS256 es trivial de atacar. */
const MIN_SECRET_LENGTH = 32;

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  SESSION_TOKEN_SECRET: z.string().min(MIN_SECRET_LENGTH),
  /** Lista separada por comas; se soportan comodines de subdominio como https://*.vercel.app. */
  CORS_ALLOWED_ORIGINS: z.string().min(1),
});

export type Env = z.infer<typeof EnvSchema> & { corsOrigins: string[] };

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${details}`);
  }
  return {
    ...parsed.data,
    corsOrigins: parsed.data.CORS_ALLOWED_ORIGINS.split(',')
      .map((o) => o.trim())
      .filter(Boolean),
  };
}

/**
 * Matchea un origin contra la lista permitida, soportando un comodín de subdominio.
 * `https://*.vercel.app` habilita los previews sin abrir el resto del dominio.
 */
export function isOriginAllowed(origin: string, allowed: string[]): boolean {
  return allowed.some((pattern) => {
    if (pattern === origin) return true;
    if (!pattern.includes('*')) return false;
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^.]+');
    return new RegExp(`^${escaped}$`).test(origin);
  });
}

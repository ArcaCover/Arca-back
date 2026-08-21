import type { MiddlewareHandler } from 'hono';

export type RateLimitWindow = { limit: number; windowMs: number };

/** Límites de POST /scan: protegen al scraper y evitan llenar leads de basura. */
export const SCAN_RATE_LIMITS: RateLimitWindow[] = [
  { limit: 5, windowMs: 60_000 },
  { limit: 20, windowMs: 60 * 60_000 },
];

/**
 * Contador de ventana deslizante en memoria. Alcanza para una sola instancia; con varias
 * réplicas hay que moverlo a un store compartido (Redis) sin cambiar esta interfaz.
 */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly windows: RateLimitWindow[],
    private readonly now: () => number = Date.now,
  ) {}

  /** Registra un intento y devuelve los segundos de espera si se pasó de algún límite. */
  check(key: string): { allowed: boolean; retryAfterSeconds: number } {
    const now = this.now();
    const longestWindow = Math.max(...this.windows.map((w) => w.windowMs));
    const timestamps = (this.hits.get(key) ?? []).filter((t) => now - t < longestWindow);

    for (const window of this.windows) {
      const inWindow = timestamps.filter((t) => now - t < window.windowMs);
      if (inWindow.length >= window.limit) {
        this.hits.set(key, timestamps);
        const oldest = inWindow[0] ?? now;
        return {
          allowed: false,
          retryAfterSeconds: Math.max(1, Math.ceil((window.windowMs - (now - oldest)) / 1000)),
        };
      }
    }

    timestamps.push(now);
    this.hits.set(key, timestamps);
    return { allowed: true, retryAfterSeconds: 0 };
  }

  /** Descarta claves sin actividad reciente para que el mapa no crezca sin techo. */
  prune(): void {
    const now = this.now();
    const longestWindow = Math.max(...this.windows.map((w) => w.windowMs));
    for (const [key, timestamps] of this.hits) {
      const fresh = timestamps.filter((t) => now - t < longestWindow);
      if (fresh.length === 0) this.hits.delete(key);
      else this.hits.set(key, fresh);
    }
  }
}

/** Identifica al cliente por IP, respetando el proxy que tenga el deploy adelante. */
export function clientIp(headers: Headers, fallback = 'unknown'): string {
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]?.trim() || fallback;
  return headers.get('x-real-ip') ?? fallback;
}

export function rateLimit(limiter: SlidingWindowLimiter): MiddlewareHandler {
  return async (c, next) => {
    const { allowed, retryAfterSeconds } = limiter.check(clientIp(c.req.raw.headers));
    if (!allowed) {
      c.header('Retry-After', String(retryAfterSeconds));
      return c.json(
        {
          error: 'rate_limited',
          message: 'Too many scan requests from this IP. Try again shortly.',
          retry_after_seconds: retryAfterSeconds,
        },
        429,
      );
    }
    await next();
  };
}

import { describe, expect, it } from 'vitest';
import {
  bearerToken,
  issueSessionToken,
  SESSION_TTL_SECONDS,
  verifySessionToken,
} from '../../src/auth/session-token.js';
import { isOriginAllowed, loadEnv } from '../../src/config/env.js';
import { SlidingWindowLimiter, clientIp } from '../../src/http/rate-limit.js';
import { TEST_ORIGINS, TEST_SECRET } from '../fixtures/deps.js';

describe('session token', () => {
  it('emite un token verificable con el scan_id adentro', async () => {
    const token = await issueSessionToken('scan-123', TEST_SECRET);
    expect(await verifySessionToken(token, TEST_SECRET)).toEqual({ scan_id: 'scan-123' });
  });

  it('rechaza un token firmado con otro secreto', async () => {
    const token = await issueSessionToken('scan-123', TEST_SECRET);
    expect(await verifySessionToken(token, 'another-secret-long-enough-to-pass')).toBeNull();
  });

  it('rechaza basura sin lanzar excepción', async () => {
    expect(await verifySessionToken('not.a.token', TEST_SECRET)).toBeNull();
    expect(await verifySessionToken('', TEST_SECRET)).toBeNull();
  });

  it('el token expira en 24 horas', () => {
    expect(SESSION_TTL_SECONDS).toBe(86_400);
  });

  it('extrae el token del header Authorization', () => {
    expect(bearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi');
    expect(bearerToken('bearer abc')).toBe('abc');
    expect(bearerToken('Basic abc')).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
  });
});

describe('CORS', () => {
  it('permite los orígenes exactos configurados', () => {
    expect(isOriginAllowed('https://arcacover.com', TEST_ORIGINS)).toBe(true);
    expect(isOriginAllowed('http://localhost:3000', TEST_ORIGINS)).toBe(true);
  });

  it('el comodín cubre previews de Vercel pero no otros dominios', () => {
    expect(isOriginAllowed('https://arca-git-main.vercel.app', TEST_ORIGINS)).toBe(true);
    // Un solo nivel de subdominio: el comodín no habilita hosts anidados de terceros.
    expect(isOriginAllowed('https://evil.attacker.vercel.app.example.com', TEST_ORIGINS)).toBe(false);
    expect(isOriginAllowed('https://arcacover.com.evil.com', TEST_ORIGINS)).toBe(false);
    expect(isOriginAllowed('https://evil.com', TEST_ORIGINS)).toBe(false);
  });
});

describe('rate limiting', () => {
  it('permite hasta el límite y luego corta', () => {
    let now = 0;
    const limiter = new SlidingWindowLimiter([{ limit: 3, windowMs: 1000 }], () => now);

    expect(limiter.check('ip').allowed).toBe(true);
    expect(limiter.check('ip').allowed).toBe(true);
    expect(limiter.check('ip').allowed).toBe(true);

    const blocked = limiter.check('ip');
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('libera la ventana cuando pasa el tiempo', () => {
    let now = 0;
    const limiter = new SlidingWindowLimiter([{ limit: 1, windowMs: 1000 }], () => now);

    expect(limiter.check('ip').allowed).toBe(true);
    expect(limiter.check('ip').allowed).toBe(false);

    now = 1001;
    expect(limiter.check('ip').allowed).toBe(true);
  });

  it('aplica la ventana más restrictiva de las dos', () => {
    let now = 0;
    const limiter = new SlidingWindowLimiter(
      [
        { limit: 5, windowMs: 60_000 },
        { limit: 6, windowMs: 3_600_000 },
      ],
      () => now,
    );

    for (let i = 0; i < 5; i++) expect(limiter.check('ip').allowed).toBe(true);
    expect(limiter.check('ip').allowed).toBe(false);

    // Pasado el minuto queda una sola request antes del tope horario.
    now = 61_000;
    expect(limiter.check('ip').allowed).toBe(true);
    expect(limiter.check('ip').allowed).toBe(false);
  });

  it('cuenta cada IP por separado', () => {
    const limiter = new SlidingWindowLimiter([{ limit: 1, windowMs: 1000 }]);
    expect(limiter.check('a').allowed).toBe(true);
    expect(limiter.check('b').allowed).toBe(true);
    expect(limiter.check('a').allowed).toBe(false);
  });

  it('limpia las claves sin actividad reciente', () => {
    let now = 0;
    const limiter = new SlidingWindowLimiter([{ limit: 1, windowMs: 1000 }], () => now);
    limiter.check('ip');

    now = 5000;
    limiter.prune();
    expect(limiter.check('ip').allowed).toBe(true);
  });

  it('identifica al cliente detrás de un proxy', () => {
    const headers = new Headers({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' });
    expect(clientIp(headers)).toBe('203.0.113.7');
    expect(clientIp(new Headers({ 'x-real-ip': '198.51.100.2' }))).toBe('198.51.100.2');
    expect(clientIp(new Headers())).toBe('unknown');
  });
});

describe('configuración de entorno', () => {
  const validEnv = {
    SUPABASE_URL: 'https://project.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
    SESSION_TOKEN_SECRET: TEST_SECRET,
    CORS_ALLOWED_ORIGINS: 'https://arcacover.com, https://*.vercel.app',
  };

  it('parsea la lista de orígenes permitidos', () => {
    const env = loadEnv(validEnv as NodeJS.ProcessEnv);
    expect(env.corsOrigins).toEqual(['https://arcacover.com', 'https://*.vercel.app']);
    expect(env.PORT).toBe(8080);
  });

  it('falla si falta una variable requerida', () => {
    const { SUPABASE_URL: _omitted, ...incomplete } = validEnv;
    expect(() => loadEnv(incomplete as NodeJS.ProcessEnv)).toThrow(/SUPABASE_URL/);
  });

  it('rechaza un secreto de sesión demasiado corto', () => {
    expect(() =>
      loadEnv({ ...validEnv, SESSION_TOKEN_SECRET: 'short' } as NodeJS.ProcessEnv),
    ).toThrow(/SESSION_TOKEN_SECRET/);
  });
});

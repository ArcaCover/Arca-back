import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { swaggerUI } from '@hono/swagger-ui';
import { Layer1Result, DomainResolution, ScanRequest, type Layer1Pipeline, type DomainResolver, type PipelineResult } from '@arca/contracts';
import { issueSessionToken, verifySessionToken } from '../auth/session-token.js';
import type { ScanRepository, ScanRecord } from '../repositories/types.js';
import { ScanLimiter } from './rate-limit.js';
import { buildOpenApiDocument } from './openapi.js';

export type AppDeps = {
  pipeline: Layer1Pipeline; repository: ScanRepository; sessionSecret: string; corsOrigins: string[];
  domainResolver: DomainResolver;
  clientIp: (request: Request) => string;
  limiter?: ScanLimiter; now?: () => number; scanCacheTtlMs?: number; partialRepairCooldownMs?: number;
};
export function createApp(deps: AppDeps) {
  const app = new Hono();
  const now = deps.now ?? Date.now;
  const scanCacheTtlMs = deps.scanCacheTtlMs ?? 604_800_000;
  const partialRepairCooldownMs = deps.partialRepairCooldownMs ?? 3_600_000;
  const limiter = deps.limiter ?? new ScanLimiter(now);
  const jobs = new Set<Promise<void>>();
  const inFlightByDomain = new Map<string, Promise<PipelineResult>>();
  app.use('*', cors({ origin: origin => deps.corsOrigins.includes(origin) ? origin : null,
    allowMethods: ['GET', 'POST', 'OPTIONS'], allowHeaders: ['Content-Type', 'Authorization'],
    exposeHeaders: ['Retry-After'], maxAge: 86400 }));
  app.onError((error, c) => {
    console.error('[api] request failed', error.message);
    return c.json({ error: 'internal_error', message: 'Unexpected server error' }, 500);
  });
  app.get('/health', c => c.json({ status: 'ok' }));
  app.get('/openapi.json', c => c.json(buildOpenApiDocument()));
  app.get('/docs', swaggerUI({ url: '/openapi.json' }));
  app.post('/scan', async c => {
    const body = ScanRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'invalid_request', message: 'A valid email and a non-empty domain are required' }, 400);
    const { email, domain } = body.data;
    const limit = limiter.check(deps.clientIp(c.req.raw), email);
    if (!limit.allowed) {
      c.header('Retry-After', String(limit.retryAfter));
      return c.json({ error: 'rate_limited', message: 'Scan request limit exceeded' }, 429);
    }
    const domainResolution = DomainResolution.parse(await deps.domainResolver.resolve({ domain, email }));
    if (domainResolution.canonicalDomain === null) {
      return c.json({ error: 'invalid_domain', message: 'The domain could not be resolved' }, 400);
    }
    const canonicalDomain = domainResolution.canonicalDomain;
    const timestamp = now();
    const scanId = `sc_${randomUUID().replaceAll('-', '')}`;
    const sessionToken = await issueSessionToken(scanId, email, deps.sessionSecret);
    const cached = await deps.repository.cached(canonicalDomain, new Date(timestamp - scanCacheTtlMs).toISOString());
    // Completed scans are returned immediately. Partial scans warm the website and per-query caches,
    // then run again so only missing or expired external evidence is repaired.
    // A partial scan is repaired at most once per cooldown. Inside it, the last repair is served
    // as it stands: a source that is down for good would otherwise re-run the whole pipeline for
    // every visitor, all cache window long, and make each one wait for the same failure.
    const recentlyRepaired = cached?.status === 'PARTIAL' && cached.completed_at !== null &&
      Date.parse(cached.completed_at) > timestamp - partialRepairCooldownMs;
    const reusable = cached?.result && (cached.status === 'COMPLETED' || recentlyRepaired) ? cached : null;
    const cachedResult = reusable ? Layer1Result.parse({ ...reusable.result, scanId, domain: canonicalDomain, email,
      meta: { ...reusable.result!.meta, cached: true } }) : null;
    if (cachedResult && cachedResult.domain !== canonicalDomain) throw new Error('Cached domain identity mismatch');
    const cachedStatus = reusable?.status === 'PARTIAL' ? 'PARTIAL' as const : 'COMPLETED' as const;
    const scan: ScanRecord = {
      id: randomUUID(), scan_id: scanId, email, canonical_domain: canonicalDomain, domain_resolution: domainResolution,
      status: cachedResult ? cachedStatus : 'RUNNING', result: cachedResult,
      created_at: new Date(timestamp).toISOString(),
      completed_at: cachedResult ? new Date(timestamp).toISOString() : null,
      duration_ms: cachedResult ? 0 : null, cached: cachedResult !== null,
    };
    await deps.repository.create(scan);
    // The fast 200 carries COMPLETED only. A partial, even one served from cache, reaches the
    // caller through polling, where the PARTIAL status and its warning already live.
    if (cachedResult && cachedStatus === 'COMPLETED') {
      return c.json({ scanId, sessionToken, status: cachedStatus, cached: true, result: cachedResult }, 200);
    }
    if (cachedResult) return c.json({ scanId, sessionToken, status: 'RUNNING' as const }, 202);
    // Persist RUNNING before dispatch. Requests never wait for the scan's external I/O.
    const job = Promise.resolve().then(async () => {
      try {
        let shared = inFlightByDomain.get(canonicalDomain);
        const reusedEvidence = shared !== undefined;
        if (!shared) {
          shared = deps.pipeline.run({ scanId, canonicalDomain, email });
          inFlightByDomain.set(canonicalDomain, shared);
          void shared.then(() => { if (inFlightByDomain.get(canonicalDomain) === shared) inFlightByDomain.delete(canonicalDomain); },
            () => { if (inFlightByDomain.get(canonicalDomain) === shared) inFlightByDomain.delete(canonicalDomain); });
        }
        const outcome = await shared;
        const result = Layer1Result.parse({ ...outcome.result, scanId, domain: canonicalDomain, email,
          meta: { ...outcome.result.meta, reusedEvidence } });
        if (result.domain !== canonicalDomain) throw new Error('Assessment domain identity mismatch');
        // A failed scan carries no result, whichever way it failed. Every source was unusable,
        // so the assessment is an empty shell, and PollResponse has no room for one on FAILED.
        // Raw evidence still lands in scan_raw_data, so nothing diagnostic is lost.
        await deps.repository.complete(scanId, { status: outcome.status,
          result: outcome.status === 'FAILED' ? null : result,
          completed_at: result.meta.completedAt, duration_ms: result.meta.scanDurationMs });
      } catch (error) {
        console.error('[scan] scan failed', scanId, error instanceof Error ? error.message : 'Unknown error');
        await deps.repository.complete(scanId, { status: 'FAILED', result: null,
          completed_at: new Date(now()).toISOString(), duration_ms: Math.max(0, now() - timestamp) });
      }
    }).catch(error => console.error('[scan] persistence failed', scanId, error instanceof Error ? error.message : 'Unknown error'));
    jobs.add(job);
    void job.finally(() => jobs.delete(job));
    return c.json({ scanId, sessionToken, status: 'RUNNING' as const }, 202);
  });
  app.get('/scan/:scanId', async c => {
    const token = /^Bearer\s+(.+)$/i.exec(c.req.header('Authorization') ?? '')?.[1];
    const claims = token ? await verifySessionToken(token, deps.sessionSecret) : null;
    if (!claims || claims.scanId !== c.req.param('scanId')) return c.json({ error: 'unauthorized', message: 'Invalid or missing session token' }, 401);
    const scan = await deps.repository.get(claims.scanId);
    if (!scan) return c.json({ error: 'not_found', message: 'Scan not found' }, 404);
    if (scan.email !== claims.email) return c.json({ error: 'unauthorized', message: 'Invalid session token' }, 401);
    if (scan.status === 'RUNNING') return c.json({ scanId: scan.scan_id, status: scan.status,
      elapsed: Math.max(0, now() - Date.parse(scan.created_at)) });
    return c.json({ scanId: scan.scan_id, status: scan.status, cached: scan.cached, ...(scan.result ? { result: scan.result } : {}) });
  });
  return { app, drain: () => Promise.all([...jobs]) };
}

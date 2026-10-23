import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { swaggerUI } from '@hono/swagger-ui';
import { Layer1Result, DomainResolution, ScanRequest, type Layer1Pipeline, type DomainResolver, type PipelineResult } from '@arca/contracts';
import { DEBUG_SCENARIO_HEADER } from '@arca/contracts/debug';
import { issueSessionToken, verifySessionToken } from '../auth/session-token.js';
import type { DebugTools } from '../debug/tools.js';
import type { ScanRepository, ScanRecord } from '../repositories/types.js';
import { ScanLimiter } from './rate-limit.js';
import { buildOpenApiDocument } from './openapi.js';
import { renderQuickScanHtml, reportFilename } from '../report/quick-scan.js';
import { InMemoryRepository } from '../repositories/in-memory.js';
import { InMemoryAssessmentRepository, type AssessmentRepository } from '../assessment/repository.js';
import { AssessmentService, type AssessmentAgent } from '../assessment/service.js';
import { assessmentRoutes } from '../assessment/routes.js';

export type AppDeps = {
  pipeline: Layer1Pipeline; repository: ScanRepository; sessionSecret: string; corsOrigins: string[];
  domainResolver: DomainResolver;
  clientIp: (request: Request) => string;
  assessmentRepository?: AssessmentRepository; assessmentAgent?: AssessmentAgent; assessmentPlanningTimeoutMs?: number;
  assessmentMaxWritesPerMinute?: number;
  limiter?: ScanLimiter; now?: () => number; scanCacheTtlMs?: number; partialRepairCooldownMs?: number;
  /** Turns the report's HTML into a PDF. Without it the report endpoint answers 503. */
  renderReport?: (html: string) => Promise<Uint8Array<ArrayBuffer>>;
  /** Debug modes only. Without it there is no /__debug route, the scenario header is never read and CORS refuses it. */
  debug?: DebugTools;
};
export function createApp(deps: AppDeps) {
  const app = new Hono();
  const debug = deps.debug;
  const now = deps.now ?? Date.now;
  const scanCacheTtlMs = deps.scanCacheTtlMs ?? 604_800_000;
  const partialRepairCooldownMs = deps.partialRepairCooldownMs ?? 3_600_000;
  const limiter = deps.limiter ?? new ScanLimiter(now);
  const jobs = new Set<Promise<void>>();
  const inFlightByDomain = new Map<string, Promise<PipelineResult>>();
  app.use('*', cors({ origin: origin => deps.corsOrigins.includes(origin) ? origin : null,
    allowMethods: ['GET', 'POST', 'PUT', 'OPTIONS'],
    allowHeaders: debug ? ['Content-Type', 'Authorization', DEBUG_SCENARIO_HEADER] : ['Content-Type', 'Authorization'],
    exposeHeaders: ['Retry-After', 'Content-Disposition'], maxAge: 86400 }));
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
    // Without `debug` (production) the scenario header is never read, so the scan below is the normal one.
    const injection = debug?.parseScenario(c.req.header(DEBUG_SCENARIO_HEADER)) ?? { ok: true, scenario: null };
    if (!injection.ok) return c.json({ error: 'invalid_request', message: 'Invalid debug scenario' }, 400);
    const { scenario } = injection;
    // Injected start faults answer before the limiter: they spend no real attempt and create no scan.
    if (scenario?.http.start === 'rate_limited') {
      c.header('Retry-After', '120');
      return c.json({ error: 'rate_limited', message: 'Scan request limit exceeded' }, 429);
    }
    if (scenario?.http.start === 'server_error') return c.json({ error: 'internal_error', message: 'Unexpected server error' }, 500);
    const limit = limiter.check(deps.clientIp(c.req.raw), email);
    if (!limit.allowed) {
      c.header('Retry-After', String(limit.retryAfter));
      return c.json({ error: 'rate_limited', message: 'Scan request limit exceeded' }, 429);
    }
    const domainResolution = DomainResolution.parse(await deps.domainResolver.resolve({ domain, email }));
    if (domainResolution.reason === 'PERSONAL_EMAIL') {
      return c.json({ error: 'personal_email_domain', message: 'The domain belongs to an email provider, not a firm' }, 400);
    }
    if (domainResolution.canonicalDomain === null) {
      return c.json({ error: 'invalid_domain', message: 'The domain could not be resolved' }, 400);
    }
    const canonicalDomain = domainResolution.canonicalDomain;
    const timestamp = now();
    const scanId = `sc_${randomUUID().replaceAll('-', '')}`;
    const sessionToken = await issueSessionToken(scanId, email, deps.sessionSecret);
    // An injected scan never reads the domain cache, which would show the cached result instead of the fault.
    const cached = scenario ? null : await deps.repository.cached(canonicalDomain, new Date(timestamp - scanCacheTtlMs).toISOString());
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
    // Isolated before its first write, so an injected scan never reaches durable storage.
    if (scenario) debug?.beginScan(scanId, scenario);
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
        // An injected scan runs its own pipeline: it never joins a clean run of the domain, and none joins it.
        const own = scenario ? debug?.pipelineFor(scenario).run({ scanId, canonicalDomain, email }) : undefined;
        let shared = own ?? inFlightByDomain.get(canonicalDomain);
        const reusedEvidence = own === undefined && shared !== undefined;
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
        // The debug view keeps the per-source summary the record drops; it is set before a poll can see FAILED.
        if (outcome.status === 'FAILED') debug?.keepFailedSources(scanId, result.sources);
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
  // A scan is readable only with the capability token issued for it, and by the email it was issued to.
  async function authorizedScan(authorization: string | undefined, scanId: string) {
    const token = /^Bearer\s+(.+)$/i.exec(authorization ?? '')?.[1];
    const claims = token ? await verifySessionToken(token, deps.sessionSecret) : null;
    if (!claims || claims.scanId !== scanId) return { ok: false, error: 'unauthorized', message: 'Invalid or missing session token', status: 401 } as const;
    const scan = await deps.repository.get(claims.scanId);
    if (!scan) return { ok: false, error: 'not_found', message: 'Scan not found', status: 404 } as const;
    if (scan.email !== claims.email) return { ok: false, error: 'unauthorized', message: 'Invalid session token', status: 401 } as const;
    return { ok: true, scan } as const;
  }
  app.get('/scan/:scanId/report.pdf', async c => {
    const access = await authorizedScan(c.req.header('Authorization'), c.req.param('scanId'));
    if (!access.ok) return c.json({ error: access.error, message: access.message }, access.status);
    const { scan } = access;
    if (debug?.reportFault(scan.scan_id)) return c.json({ error: 'report_unavailable', message: 'Injected report failure' }, 503);
    if ((scan.status !== 'COMPLETED' && scan.status !== 'PARTIAL') || !scan.result) {
      return c.json({ error: 'report_unavailable', message: 'The report exists once the scan has a result' }, 409);
    }
    if (!deps.renderReport) return c.json({ error: 'report_unavailable', message: 'Report rendering is not configured' }, 503);
    const pdf = await deps.renderReport(renderQuickScanHtml(scan.result, scan.status));
    return c.body(pdf, 200, { 'Content-Type': 'application/pdf', 'Cache-Control': 'no-store',
      'Content-Disposition': `attachment; filename="${reportFilename(scan.result)}"` });
  });
  app.get('/scan/:scanId', async c => {
    const access = await authorizedScan(c.req.header('Authorization'), c.req.param('scanId'));
    if (!access.ok) return c.json({ error: access.error, message: access.message }, access.status);
    const { scan } = access;
    const fault = debug?.takePollFault(scan.scan_id) ?? null;
    if (fault === 'unauthorized') return c.json({ error: 'unauthorized', message: 'Invalid or missing session token' }, 401);
    if (fault === 'server_error') return c.json({ error: 'internal_error', message: 'Unexpected server error' }, 500);
    // Held past the front's 15 s request timeout, so the front sees a network failure.
    if (fault === 'hang') await new Promise(resolve => setTimeout(resolve, 16_000));
    if (scan.status === 'RUNNING') return c.json({ scanId: scan.scan_id, status: scan.status,
      elapsed: Math.max(0, now() - Date.parse(scan.created_at)) });
    return c.json({ scanId: scan.scan_id, status: scan.status, cached: scan.cached, ...(scan.result ? { result: scan.result } : {}) });
  });
  const assessmentRepository = deps.assessmentRepository ?? (deps.repository instanceof InMemoryRepository ? new InMemoryAssessmentRepository() : null);
  if (!assessmentRepository) throw new Error('An assessment repository is required with durable scan storage');
  const assessments = new AssessmentService({ repository: assessmentRepository, now, agent: deps.assessmentAgent,
    agentFor: debug ? scanId => debug.assessmentAgentFor(scanId) : undefined,
    planningTimeoutMs: deps.assessmentPlanningTimeoutMs, maxWritesPerMinute: deps.assessmentMaxWritesPerMinute });
  app.route('/', assessmentRoutes({ scans: deps.repository, repository: assessmentRepository, service: assessments, sessionSecret: deps.sessionSecret }));
  if (debug) app.route('/__debug', debug.routes({ limiter, sessionSecret: deps.sessionSecret }));
  return { app, drain: async () => { await Promise.all([...jobs]); await assessments.drain(); },
    recoverAssessments: () => assessments.recoverInterrupted() };
}

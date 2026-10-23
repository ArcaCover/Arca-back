import { Hono } from 'hono';
import type { DirectorySource, Layer1Pipeline, Layer1Result, WebsiteSource } from '@arca/contracts';
import { DebugModeResponse, DebugScanState, DebugScenario, isInjected } from '@arca/contracts/debug';
import { verifySessionToken } from '../auth/session-token.js';
import type { AssessmentAgent } from '../assessment/service.js';
import type { ScanLimiter } from '../http/rate-limit.js';
import { InProcessPipeline } from '../pipeline/in-process-pipeline.js';
import type { RoutingAssessmentRepository, RoutingScanRepository } from './isolation.js';
import { injectDirectory, injectWebsite } from './sources.js';

/** What createApp needs from the debug modes. Production never builds one, so none of it is reachable there (DN-09 5.1). */
export type DebugTools = {
  /** `null` when the header is absent or injects nothing; `ok: false` when it is not a valid scenario. */
  parseScenario(header: string | undefined): { ok: true; scenario: DebugScenario | null } | { ok: false };
  /** Moves the scan to in-memory storage before its first write and remembers its scenario. */
  beginScan(scanId: string, scenario: DebugScenario): void;
  pipelineFor(scenario: DebugScenario): Layer1Pipeline;
  /** A FAILED scan is stored without its result, so the debug view keeps the per-source diagnostics here (DN-09 5.2). */
  keepFailedSources(scanId: string, sources: Layer1Result['sources']): void;
  takePollFault(scanId: string): 'unauthorized' | 'server_error' | 'hang' | null;
  reportFault(scanId: string): boolean;
  assessmentAgentFor(scanId: string): AssessmentAgent | undefined;
  routes(context: { limiter: ScanLimiter; sessionSecret: string }): Hono;
};

// A server error or a hang spoils this many polls, then the scan answers again, so the front can be seen recovering.
const FAULTY_POLLS = 2;

// A planner that never answers, so the assessment falls back to its rules. It stops as soon as it is aborted:
// the planning deadline ends the job instead of leaving it pending.
const stalledPlanner: NonNullable<AssessmentAgent> = { model: 'debug-stalled-planner', plan: (_input, signal) =>
  new Promise((_resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }) };

export function createDebugTools(options: {
  mode: 'mock' | 'live-debug'; describe: DebugModeResponse;
  sources: { website: WebsiteSource; bar: DirectorySource; avvo: DirectorySource };
  scans: RoutingScanRepository; assessments: RoutingAssessmentRepository; pipelineTimeoutMs: number;
  clearDurableMemory?: () => void;
}): DebugTools {
  const { scans, assessments, sources } = options;
  // Checked once, here: the mode route can only ever serve enums and booleans, never a key or a URL (DN-09 7).
  const description = DebugModeResponse.parse(options.describe);
  const scenarios = new Map<string, DebugScenario>();
  const polls = new Map<string, number>();
  const failedSources = new Map<string, Layer1Result['sources']>();
  return {
    parseScenario(header) {
      if (header === undefined) return { ok: true, scenario: null };
      let value: unknown;
      try { value = JSON.parse(header); } catch { return { ok: false }; }
      const parsed = DebugScenario.safeParse(value);
      if (!parsed.success) return { ok: false };
      // A scenario that injects nothing is a normal scan: it keeps the domain cache and durable storage.
      return { ok: true, scenario: isInjected(parsed.data) ? parsed.data : null };
    },
    beginScan(scanId, scenario) {
      scans.isolate(scanId);
      scenarios.set(scanId, scenario);
    },
    pipelineFor(scenario) {
      // The configured budget, not the pipeline's 55 s default, which would cut the slow latency (70 s) short.
      return new InProcessPipeline({ website: injectWebsite(sources.website, scenario, { latency: options.mode === 'mock' }),
        bar: injectDirectory('bar', sources.bar, scenario), avvo: injectDirectory('avvo', sources.avvo, scenario),
        repository: scans, timeoutMs: options.pipelineTimeoutMs });
    },
    keepFailedSources(scanId, sources) { failedSources.set(scanId, sources); },
    takePollFault(scanId) {
      const fault = scenarios.get(scanId)?.http.poll ?? 'none';
      if (fault === 'none') return null;
      // An expired session stays expired.
      if (fault === 'unauthorized') return fault;
      const count = (polls.get(scanId) ?? 0) + 1;
      polls.set(scanId, count);
      return count <= FAULTY_POLLS ? fault : null;
    },
    reportFault: scanId => scenarios.get(scanId)?.http.report === 'unavailable',
    assessmentAgentFor: scanId => scenarios.get(scanId)?.planner === 'timeout' ? stalledPlanner : undefined,
    routes({ limiter, sessionSecret }) {
      const app = new Hono();
      app.use('*', async (c, next) => { c.header('Cache-Control', 'no-store'); await next(); });
      app.get('/mode', c => c.json(description));
      // The same capability as the poll: the token issued for this scan, held by the email it was issued to.
      app.get('/scan/:scanId', async c => {
        const scanId = c.req.param('scanId');
        const token = /^Bearer\s+(.+)$/i.exec(c.req.header('Authorization') ?? '')?.[1];
        const claims = token ? await verifySessionToken(token, sessionSecret) : null;
        if (!claims || claims.scanId !== scanId) return c.json({ error: 'unauthorized', message: 'Invalid or missing session token' }, 401);
        const scan = await scans.get(scanId);
        if (!scan) return c.json({ error: 'not_found', message: 'Scan not found' }, 404);
        if (scan.email !== claims.email) return c.json({ error: 'unauthorized', message: 'Invalid session token' }, 401);
        const scenario = scenarios.get(scanId) ?? null;
        // Parsed against the strict contract, which has no field for the email.
        return c.json(DebugScanState.parse({ scanId, status: scan.status, canonicalDomain: scan.canonical_domain,
          domainResolution: scan.domain_resolution, createdAt: scan.created_at, completedAt: scan.completed_at,
          durationMs: scan.duration_ms, cached: scan.cached,
          storage: scans.isIsolated(scanId) ? 'memory' : description.storageBackend, injected: scenario !== null, scenario,
          // Null while the scan runs, and for a failure no source reported on: a thrown pipeline, or one this process did not run.
          sources: scan.result?.sources ?? failedSources.get(scanId) ?? null }));
      });
      // Only the limiter and this process's memory. Supabase is never touched.
      app.post('/reset', c => {
        limiter.clear();
        scans.overlay.clear();
        assessments.overlay.clear();
        options.clearDurableMemory?.();
        return c.json({ ok: true });
      });
      return app;
    },
  };
}

import { extendZodWithOpenApi, OpenAPIRegistry, OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { CachedScanResponse, StartedScanResponse, PollResponse, ScanRequest } from '@arca/contracts';
extendZodWithOpenApi(z);
export function buildOpenApiDocument() {
  const registry = new OpenAPIRegistry();
  registry.registerComponent('securitySchemes', 'sessionToken', { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' });
  const error = z.object({ error: z.string(), message: z.string() }).strict();
  const json = (schema: z.ZodTypeAny, examples?: Record<string, { summary: string; value: unknown }>) =>
    ({ 'application/json': { schema, ...(examples ? { examples } : {}) } });
  const result = {
    scanId: 'sc_abc123', domain: 'smithlaw.com', email: 'contact@smithlaw.com',
    preScore: {
      total: 82,
      assessmentStatus: 'SUFFICIENT',
      categories: {
        aiGovernance: { score: 23, max: 35, status: 'KNOWN', rules: [] },
        professionalStanding: { score: 30, max: 30, status: 'KNOWN', rules: [] },
        reputation: { score: 14, max: 20, status: 'KNOWN', rules: [] },
        firmMaturity: { score: 15, max: 15, status: 'KNOWN', rules: [] },
      },
      tier: 'FORTRESS', decision: 'AUTO_BIND', confidence: 'HIGH', overrides: [], flags: [],
    },
    identity: { canonicalDomain: 'smithlaw.com', firmName: 'Smith Law', aliases: [], city: 'Miami', county: 'Miami-Dade',
      addressStreet: '100 Main St', phone: '305-555-0100', attorneyNames: ['Jane Smith'], status: 'VERIFIED', evidence: [] },
    signals: {
      website: {
        W1_aiPolicy: { found: true, depth: 'basic', points: 8 },
        W2_aiInServices: { found: true, tools: ['Harvey'], points: 10 },
        W3_aiDisclosure: { found: false, points: 0 }, W4_aiBlog: { found: true, count: 2, points: 5 },
        W5_teamSize: 5, W5a_teamPageQuality: 'detailed',
        W6_privacyPolicy: { found: true, mentionsClientData: true, points: 3 },
        W7_websiteQuality: 'robust', W8_firmEstablished: 2008, W9_practiceAreas: ['Immigration'],
      },
      bar: { B1_allActive: true, B2_worstDisciplinary: 'none', B3_consistency: 1, B4_avgExperience: 12, attorneys: [] },
      avvo: { A1_avgRating: 8.5, A1_ratingLevel: 'Excellent', A2_practiceAreas: ['Immigration'],
        A3_avgReviewRating: 4.5, A3_totalReviews: 20, A6_hasAwards: false, A6_awardsCount: 0,
        A6_topAward: null, A8_disciplined: false },
    },
    multipliers: {
      practiceArea: { area: 'Immigration', value: 1.8, known: true },
      jurisdiction: { state: 'FL', value: 1.25, known: true },
      size: { teamSize: 5, value: 1, known: true },
    },
    sources: {
      website: { status: 'ok', dataStatus: 'PRESENT', durationMs: 8420, pagesCrawled: 12 },
      bar: { status: 'ok', dataStatus: 'PRESENT', durationMs: 6100, attorneysSearched: 5, attorneysFound: 5 },
      avvo: { status: 'ok', dataStatus: 'PRESENT', durationMs: 5800, attorneysSearched: 5, attorneysFound: 4 },
    },
    meta: { scanDurationMs: 14520, cached: false, reusedEvidence: false, contractVersion: 'layer1-2026-09-12-v2',
      completedAt: '2026-09-11T14:32:10.000Z' },
  };
  const invalid = { invalidRequest: { summary: 'Invalid request', value: { error: 'invalid_request', message: 'A valid email and a non-empty domain are required' } } };
  registry.registerPath({ method: 'post', path: '/scan', summary: 'Start a domain scan or reuse a cached domain result',
    description: 'Cache identity is the normalized domain. A cache miss returns 202 RUNNING. A hit inside the cache window (SCAN_CACHE_TTL_MS, 7 days by default) returns 200 immediately with cached=true, a new scanId, a new sessionToken and status COMPLETED. A cached partial scan never gets the 200: it is repaired first, at most once per SCAN_PARTIAL_REPAIR_COOLDOWN_MS (1 hour by default), and inside that cooldown the last repair is served. Either way it returns 202 and arrives through polling, as PARTIAL.',
    request: { body: { required: true, content: json(ScanRequest, { lawFirm: { summary: 'Start a firm scan',
      value: { email: 'contact@smithlaw.com', domain: 'smithlaw.com' } } }) } },
    responses: {
      202: { description: 'Fresh scan started; poll GET /scan/{scanId}', content: json(StartedScanResponse, {
        started: { summary: 'Scan accepted', value: { scanId: 'sc_abc123', sessionToken: 'eyJhbGciOiJIUzI1NiIs...', status: 'RUNNING' } },
      }) },
      200: { description: 'Domain cache hit; the stored COMPLETED result is returned immediately with a new scan session', content: json(CachedScanResponse, {
        cacheHit: { summary: 'Cached domain result', value: { scanId: 'sc_abc123', sessionToken: 'eyJhbGciOiJIUzI1NiIs...', status: 'COMPLETED', cached: true,
          result: { ...result, meta: { ...result.meta, cached: true } } } },
      }) },
      400: { description: 'Invalid email, missing domain, or unresolvable domain', content: json(error, invalid) },
      429: { description: '10 requests per IP/hour or 3 per email/hour exceeded', content: json(error, {
        rateLimited: { summary: 'Rate limit exceeded', value: { error: 'rate_limited', message: 'Scan request limit exceeded' } },
      }), headers: { 'Retry-After': { schema: { type: 'integer' }, description: 'Seconds until retry' } } },
      500: { description: 'Persistence or internal failure', content: json(error) },
    } });
  registry.registerPath({ method: 'get', path: '/scan/{scanId}', summary: 'Poll scan status',
    security: [{ sessionToken: [] }], request: { params: z.object({ scanId: z.string() }) },
    responses: { 200: { description: 'RUNNING, COMPLETED, PARTIAL or FAILED. All but RUNNING are terminal.', content: json(PollResponse, {
      running: { summary: 'Scan still running', value: { scanId: 'sc_abc123', status: 'RUNNING', elapsed: 12400 } },
      completed: { summary: 'Completed scan', value: { scanId: 'sc_abc123', status: 'COMPLETED', cached: false, result } },
      partial: { summary: 'Partial scan: a source could not be repaired', value: { scanId: 'sc_abc123', status: 'PARTIAL', cached: false,
        result: { ...result, preScore: { ...result.preScore, assessmentStatus: 'INSUFFICIENT_EVIDENCE', decision: 'UNKNOWN', flags: ['INCOMPLETE_SOURCES'] } } } },
      failed: { summary: 'Terminal scan failure', value: { scanId: 'sc_abc123', status: 'FAILED', cached: false } },
    }) },
      401: { description: 'Missing or invalid session', content: json(error) },
      404: { description: 'Scan not found', content: json(error) },
      500: { description: 'Internal failure', content: json(error) } } });
  return new OpenApiGeneratorV31(registry.definitions).generateDocument({ openapi: '3.1.0',
    info: { title: 'ARCA Layer 1 API', version: '1.0.0', description: 'Domain evidence scoring. Unknown fields remain null while unavailable scoring rules contribute zero points. Tier and decision are separate.' } });
}

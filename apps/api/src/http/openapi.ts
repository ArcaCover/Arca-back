import { extendZodWithOpenApi, OpenAPIRegistry, OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { CachedScanResponse, StartedScanResponse, PollResponse, ScanRequest, StartedAssessmentResponse, AssessmentView, AssessmentResult, SaveAnswerRequest, CompleteRequest, AssessmentError } from '@arca/contracts';
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
      400: { description: 'Invalid email or missing domain (invalid_request), a domain that belongs to an email provider (personal_email_domain), or an unresolvable domain (invalid_domain)', content: json(error, invalid) },
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
  registry.registerPath({ method: 'get', path: '/scan/{scanId}/report.pdf', summary: 'Download the Quick Scan Report',
    description: 'One-page PDF of a COMPLETED or PARTIAL scan, with the same score, categories and findings /score shows. Content-Disposition names the file after the domain and the scan date.',
    security: [{ sessionToken: [] }], request: { params: z.object({ scanId: z.string() }) },
    responses: { 200: { description: 'The report', content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } } } },
      401: { description: 'Missing or invalid session', content: json(error) },
      404: { description: 'Scan not found', content: json(error) },
      409: { description: 'The scan is still running or failed, so there is no report (report_unavailable)', content: json(error) },
      503: { description: 'Report rendering is not configured on this server', content: json(error) } } });
  const assessmentErrors = {
    401: { description: 'Missing, invalid, expired, or wrong-scan capability token', content: json(AssessmentError) },
    404: { description: 'Assessment not found', content: json(AssessmentError) },
    409: { description: 'Invalid assessment state, incomplete answers, or concurrent write conflict', content: json(AssessmentError) },
    410: { description: 'The 24-hour assessment session expired', content: json(AssessmentError) },
    500: { description: 'Persistence or internal failure; the answer and audit event are atomic', content: json(AssessmentError) },
  };
  const assessmentParams = z.object({ assessmentId: z.string() });
  registry.registerPath({ method: 'post', path: '/scan/{scanId}/assessment', summary: 'Create or resume the scan’s single assessment',
    description: 'One assessment per scan, including completed assessments. First creation returns PLANNING and schedules a grounded agent plan only when explicitly enabled; rules are the default and fallback. All bank, Layer 1 and evidence snapshots are frozen. Repeated creation returns the existing identifier. Session expires 24 hours after scan creation.',
    security: [{ sessionToken: [] }], request: { params: z.object({ scanId: z.string() }) },
    responses: { ...assessmentErrors,
      202: { description: 'Planning asynchronously; poll GET /assessment/{assessmentId}', content: json(StartedAssessmentResponse) },
      200: { description: 'The assessment already exists and is no longer planning', content: json(StartedAssessmentResponse) } } });
  registry.registerPath({ method: 'get', path: '/assessment/{assessmentId}', summary: 'Read visible questions, saved answers and progress',
    security: [{ sessionToken: [] }], request: { params: assessmentParams },
    responses: { ...assessmentErrors, 200: { description: 'Assessment view; PLANNING can be polled until READY', content: json(AssessmentView) } } });
  registry.registerPath({ method: 'put', path: '/assessment/{assessmentId}/answers/{questionId}', summary: 'Atomically save an answer and audit event',
    description: 'Only currently visible questions accept answers. Answer changes invalidate newly hidden descendants in the same transaction, retaining invalidation history. No LLM is invoked. Limited to 120 requests per assessment per minute in one process and 1,000 accepted writes per assessment in shared storage.',
    security: [{ sessionToken: [] }], request: { params: z.object({ assessmentId: z.string(), questionId: z.string() }), body: { required: true, content: json(SaveAnswerRequest) } },
    responses: { ...assessmentErrors, 200: { description: 'Updated visible questions and progress', content: json(AssessmentView) },
      400: { description: 'Wrong answer kind, unknown option, or invalid numeric value', content: json(AssessmentError) },
      413: { description: 'Request exceeds 16 KiB', content: json(AssessmentError) },
      429: { description: 'Answer write limit exceeded', content: json(AssessmentError), headers: { 'Retry-After': { schema: { type: 'integer' } } } } } });
  registry.registerPath({ method: 'post', path: '/assessment/{assessmentId}/complete', summary: 'Attest and complete an assessment exactly once',
    description: 'All visible questions must be answered and attestation must be true. The deterministic demo result is persisted with the attestation in one CAS transaction. Repeated requests return the original immutable result. Demo scoring cannot authorize a commercial decision.',
    security: [{ sessionToken: [] }], request: { params: assessmentParams, body: { required: true, content: json(CompleteRequest) } },
    responses: { ...assessmentErrors, 200: { description: 'Immutable assessment result', content: json(AssessmentResult) },
      400: { description: 'Explicit truthfulness attestation is missing', content: json(AssessmentError) } } });
  registry.registerPath({ method: 'get', path: '/assessment/{assessmentId}/result', summary: 'Read the saved completed assessment result',
    security: [{ sessionToken: [] }], request: { params: assessmentParams },
    responses: { ...assessmentErrors, 200: { description: 'Immutable assessment result', content: json(AssessmentResult) } } });
  return new OpenApiGeneratorV31(registry.definitions).generateDocument({ openapi: '3.1.0',
    info: { title: 'ARCA Layer 1 + Layer 2 API', version: '2.0.0', description: 'Domain evidence scoring. Unknown fields remain null while unavailable scoring rules contribute zero points. Tier and decision are separate.' } });
}

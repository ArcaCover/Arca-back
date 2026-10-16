import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { CompleteRequest, SaveAnswerRequest, StartedAssessmentResponse } from '@arca/contracts';
import { verifySessionToken } from '../auth/session-token.js';
import type { ScanRepository } from '../repositories/types.js';
import type { AssessmentRepository } from './repository.js';
import { AssessmentFailure, type AssessmentService } from './service.js';

export function assessmentRoutes(deps: { scans: ScanRepository; repository: AssessmentRepository; service: AssessmentService; sessionSecret: string }) {
  const app = new Hono();
  app.use('*', async (c, next) => { c.header('Cache-Control', 'no-store'); await next(); });
  app.use('/assessment/*', bodyLimit({ maxSize: 16_384,
    onError: c => c.json({ error: 'invalid_request', message: 'Assessment request is too large' }, 413) }));
  app.onError((error, c) => {
    if (error instanceof AssessmentFailure) {
      if (error.status === 429) c.header('Retry-After', '60');
      return c.json({ error: error.code, message: error.message }, error.status);
    }
    console.error('[assessment] request failed', error.message);
    return c.json({ error: 'internal_error', message: 'Unable to save or load the assessment; try again' }, 500);
  });
  async function claims(authorization: string | undefined) {
    const token = /^Bearer\s+(.+)$/i.exec(authorization ?? '')?.[1];
    return token ? verifySessionToken(token, deps.sessionSecret) : null;
  }
  async function authorizeScan(authorization: string | undefined, scanId: string) {
    const session = await claims(authorization);
    if (!session || session.scanId !== scanId) return null;
    const scan = await deps.scans.get(scanId);
    return scan && scan.email === session.email ? scan : null;
  }
  async function authorizeAssessment(authorization: string | undefined, id: string) {
    const session = await claims(authorization);
    if (!session) return { ok: false as const, status: 401 as const, error: 'unauthorized' as const };
    const record = await deps.repository.get(id);
    if (!record) return { ok: false as const, status: 404 as const, error: 'not_found' as const };
    if (record.scan_id !== session.scanId) return { ok: false as const, status: 401 as const, error: 'unauthorized' as const };
    const scan = await deps.scans.get(record.scan_id);
    if (!scan || scan.email !== session.email) return { ok: false as const, status: 401 as const, error: 'unauthorized' as const };
    return { ok: true as const };
  }
  app.post('/scan/:scanId/assessment', async c => {
    const scan = await authorizeScan(c.req.header('Authorization'), c.req.param('scanId'));
    if (!scan) return c.json({ error: 'unauthorized', message: 'Invalid or missing scan session token' }, 401);
    const record = await deps.service.start(scan);
    return c.json(StartedAssessmentResponse.parse({ assessmentId: record.id, status: record.status }), record.status === 'PLANNING' ? 202 : 200);
  });
  app.use('/assessment/:assessmentId/*', async (c, next) => {
    const access = await authorizeAssessment(c.req.header('Authorization'), c.req.param('assessmentId')!);
    if (!access.ok) return c.json({ error: access.error, message: access.error === 'not_found' ? 'Assessment not found' : 'Invalid or missing scan session token' }, access.status);
    await next();
  });
  // Explicit base route guard: Hono's wildcard middleware intentionally does not include the bare path.
  app.get('/assessment/:assessmentId', async c => {
    const access = await authorizeAssessment(c.req.header('Authorization'), c.req.param('assessmentId'));
    if (!access.ok) return c.json({ error: access.error, message: access.error === 'not_found' ? 'Assessment not found' : 'Invalid or missing scan session token' }, access.status);
    return c.json(deps.service.view(await deps.service.get(c.req.param('assessmentId'))));
  });
  app.put('/assessment/:assessmentId/answers/:questionId', async c => {
    const body = SaveAnswerRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'invalid_answer', message: 'Provide a valid answer object' }, 400);
    const record = await deps.service.save(c.req.param('assessmentId'), c.req.param('questionId'), body.data.answer);
    return c.json(deps.service.view(record));
  });
  app.post('/assessment/:assessmentId/complete', async c => {
    const body = CompleteRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'invalid_request', message: 'An explicit attestation of truthfulness is required' }, 400);
    return c.json(await deps.service.complete(c.req.param('assessmentId')));
  });
  app.get('/assessment/:assessmentId/result', async c => c.json(await deps.service.result(c.req.param('assessmentId'))));
  return app;
}

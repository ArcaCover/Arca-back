import { randomUUID } from 'node:crypto';
import type { Layer1Pipeline } from '@arca/contracts';
import { selectQuestions } from '@arca/questions';
import { scoreAssessment } from '@arca/scoring';
import { Hono, type MiddlewareHandler } from 'hono';
import { cors } from 'hono/cors';
import { bearerToken, issueSessionToken, verifySessionToken } from '../auth/session-token.js';
import { isOriginAllowed } from '../config/env.js';
import type { Repositories } from '../repositories/types.js';
import { rateLimit, SCAN_RATE_LIMITS, SlidingWindowLimiter } from './rate-limit.js';
import { ScanIdParam, ScanRequest, SubmitRequest } from './schemas.js';

export type AppDeps = {
  /** Solo la interfaz: ningún handler sabe que existe Playwright, DNS ni fingerprinting. */
  pipeline: Layer1Pipeline;
  repositories: Repositories;
  sessionSecret: string;
  corsOrigins: string[];
  rateLimiter?: SlidingWindowLimiter;
};

/** Variables que el middleware de sesión deja disponibles para el handler. */
type Variables = { scanId: string };

export function createApp(deps: AppDeps) {
  const app = new Hono<{ Variables: Variables }>();
  const limiter = deps.rateLimiter ?? new SlidingWindowLimiter(SCAN_RATE_LIMITS);

  app.use(
    '*',
    cors({
      origin: (origin) => (isOriginAllowed(origin, deps.corsOrigins) ? origin : null),
      allowMethods: ['GET', 'POST', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization'],
      maxAge: 86_400,
    }),
  );

  app.onError((error, c) => {
    console.error('[api] unhandled error', error);
    return c.json({ error: 'internal_error', message: 'Unexpected server error' }, 500);
  });

  app.get('/health', (c) => c.json({ status: 'ok' }));

  /** El session_token autoriza un scan puntual: uno de otro scan no sirve acá. */
  const requireSession: MiddlewareHandler<{ Variables: Variables }> = async (c, next) => {
    const scanId = c.req.param('scan_id');
    const token = bearerToken(c.req.header('Authorization'));
    if (!token) {
      return c.json({ error: 'unauthorized', message: 'Missing session token' }, 401);
    }
    const claims = await verifySessionToken(token, deps.sessionSecret);
    if (!claims || claims.scan_id !== scanId) {
      return c.json({ error: 'unauthorized', message: 'Invalid session token for this scan' }, 401);
    }
    c.set('scanId', claims.scan_id);
    await next();
    return;
  };

  app.post('/api/v1/scan', rateLimit(limiter), async (c) => {
    const body = ScanRequest.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) {
      return c.json(
        { error: 'invalid_request', message: 'Invalid scan request', issues: body.error.issues },
        400,
      );
    }
    const { domain, email } = body.data;

    // El lead se guarda antes de escanear: si la persona abandona, el email ya quedó capturado.
    const lead = email
      ? await deps.repositories.leads.capture({
          email,
          domain,
          firm_id: null,
          source: body.data.broker_id ? 'broker_lead' : 'direct',
        })
      : null;

    // El scan_id se genera acá porque el pipeline lo necesita para etiquetar la evidencia.
    const scanId = randomUUID();
    const layer1 = await deps.pipeline.run({ domain, scan_id: scanId });

    const firm = await deps.repositories.firms.upsertByDomain({
      domain,
      name: layer1.firm.name,
      city: layer1.firm.city,
      state: layer1.firm.state,
      attorneys_count: layer1.firm.attorneys_count,
      practice_areas: layer1.firm.practice_areas,
      primary_practice: layer1.firm.primary_practice,
    });

    const scan = await deps.repositories.scans.create({
      id: scanId,
      firm_id: firm.id,
      pre_score: layer1.pre_score.value,
      tier: layer1.pre_score.tier,
      confidence: layer1.pre_score.confidence,
      signals: layer1.signals,
      layer1_result: layer1,
    });

    if (lead) {
      await deps.repositories.leads.updateProgress(lead.id, {
        status: 'pre_scored',
        firm_id: firm.id,
        pre_score: layer1.pre_score.value,
      });
    }

    return c.json({
      scan_id: scan.id,
      session_token: await issueSessionToken(scan.id, deps.sessionSecret),
      firm: { id: firm.id, ...layer1.firm },
      pre_score: layer1.pre_score,
      signals: layer1.signals,
      quick_report: layer1.quick_report,
      website_found: layer1.observations.website_found,
      bar_check: layer1.observations.bar_check,
      bar_verified: layer1.observations.bar_verified,
      duration_ms: layer1.duration_ms,
    });
  });

  app.get('/api/v1/scan/:scan_id', requireSession, async (c) => {
    const scan = await loadScan(c.req.param('scan_id'));
    if ('error' in scan) return c.json(scan.error, scan.status);
    const { layer1_result } = scan.record;

    return c.json({
      scan_id: scan.record.id,
      created_at: scan.record.created_at,
      firm: { id: scan.record.firm_id, ...layer1_result.firm },
      pre_score: layer1_result.pre_score,
      signals: layer1_result.signals,
      quick_report: layer1_result.quick_report,
      website_found: layer1_result.observations.website_found,
      bar_check: layer1_result.observations.bar_check,
      bar_verified: layer1_result.observations.bar_verified,
    });
  });

  app.get('/api/v1/assessment/:scan_id/questions', requireSession, async (c) => {
    const scan = await loadScan(c.req.param('scan_id'));
    if ('error' in scan) return c.json(scan.error, scan.status);

    const set = selectQuestions(scan.record.layer1_result);
    return c.json({ scan_id: scan.record.id, ...set });
  });

  app.post('/api/v1/assessment/:scan_id/submit', requireSession, async (c) => {
    const scan = await loadScan(c.req.param('scan_id'));
    if ('error' in scan) return c.json(scan.error, scan.status);

    const body = SubmitRequest.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) {
      return c.json(
        { error: 'invalid_request', message: 'Invalid responses', issues: body.error.issues },
        400,
      );
    }

    const { layer1_result } = scan.record;
    const result = scoreAssessment({
      pre_score: layer1_result.pre_score.value,
      confidence: layer1_result.pre_score.confidence,
      responses: body.data.responses,
      firm: {
        attorneys_count: layer1_result.firm.attorneys_count,
        practice_areas: layer1_result.firm.practice_areas,
        primary_practice: layer1_result.firm.primary_practice,
        state: layer1_result.firm.state,
      },
    });

    const assessment = await deps.repositories.assessments.create({
      scan_id: scan.record.id,
      responses: body.data.responses,
      domain_scores: result.domain_scores,
      composite_score: result.composite_score,
      tier: result.tier,
      decision: result.decision,
      pricing: result.pricing,
      override_rules_triggered: result.override_rules_triggered,
      action_plan: result.action_plan,
      path_to_insurability: result.path_to_insurability,
    });

    const lead = await deps.repositories.leads.findByDomain(layer1_result.domain);
    if (lead) {
      await deps.repositories.leads.updateProgress(lead.id, {
        status: 'assessment_completed',
        composite_score: result.composite_score,
      });
    }

    return c.json({
      assessment_id: assessment.id,
      scan_id: scan.record.id,
      firm: { id: scan.record.firm_id, ...layer1_result.firm },
      pre_score: result.pre_score,
      deep_score: result.deep_score,
      composite_score: result.composite_score,
      layer_weights: result.layer_weights,
      tier: result.tier,
      decision: result.decision,
      domain_scores: result.domain_scores,
      action_plan: result.action_plan,
      pricing: result.pricing,
      override_rules_triggered: result.override_rules_triggered,
      path_to_insurability: result.path_to_insurability,
    });
  });

  /** Carga y valida el scan de la ruta, devolviendo el error HTTP ya formado si no existe. */
  async function loadScan(rawId: string | undefined) {
    const parsed = ScanIdParam.safeParse(rawId);
    if (!parsed.success) {
      return { error: { error: 'invalid_request', message: 'Invalid scan id' }, status: 400 } as const;
    }
    const record = await deps.repositories.scans.findById(parsed.data);
    if (!record) {
      return { error: { error: 'not_found', message: 'Scan not found' }, status: 404 } as const;
    }
    return { record } as const;
  }

  return app;
}

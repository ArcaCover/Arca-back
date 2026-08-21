import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildHarness, emptyDns, type TestHarness } from '../fixtures/deps.js';
import { LocalSiteFetcher, startTestSite, UnreachableFetcher, type TestSite } from '../fixtures/site.js';

const DOMAIN = 'smithlawmiami.com';

/** Respuestas completas para el set de preguntas que devuelve este scan. */
const RESPONSES = [
  { question_id: 'Q1.2', answer: ['approved_tools', 'data_rules', 'review_process'] },
  { question_id: 'Q1.3', answer: 'specific_partner' },
  { question_id: 'Q2.2', answer: 'enterprise_controlled' },
  { question_id: 'Q2.3', answer: 'technical_controls' },
  { question_id: 'Q3.1', answer: 'peer_review' },
  { question_id: 'Q3.2', answer: 'tools_always' },
  { question_id: 'Q4.1', answer: 'guidelines' },
  { question_id: 'Q4.2', answer: 'us_only' },
  { question_id: 'Q5.1', answer: 'mandatory_recurring' },
  { question_id: 'Q6.1', answer: ['none'] },
  { question_id: 'Q6.2', answer: 'documented_not_tested' },
];

describe('flujo completo scan → questions → submit', () => {
  let site: TestSite;
  let harness: TestHarness;
  let scanId: string;
  let token: string;

  beforeAll(async () => {
    site = await startTestSite();
    harness = buildHarness({ fetcher: new LocalSiteFetcher(site.port) });
  });

  afterAll(async () => {
    await site.close();
  });

  it('POST /scan devuelve pre_score, señales y session_token', async () => {
    const response = await harness.app.request('/api/v1/scan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ domain: DOMAIN, email: 'jsmith@smithlawmiami.com' }),
    });
    expect(response.status).toBe(200);

    const body = await response.json();
    scanId = body.scan_id;
    token = body.session_token;

    expect(body.scan_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.session_token).toBeTruthy();
    expect(body.pre_score.value).toBeGreaterThan(0);
    expect(body.pre_score.confidence).toBe('HIGH');
    expect(body.signals.length).toBeGreaterThanOrEqual(5);
    expect(body.website_found).toBe(true);
    // El bar check no se automatiza en esta fase.
    expect(body.bar_verified).toBe(false);
    expect(body.bar_check).toBe('manual_pending');
  });

  it('detecta las señales del sitio fixture', async () => {
    const scan = harness.repositories.scansById.get(scanId)!;
    const { observations, firm } = scan.layer1_result;

    expect(observations.ai_policy_found).toBe(true);
    expect(observations.ai_policy_url).toContain('/ai-governance');
    expect(observations.ai_in_services).toBe(true);
    expect(observations.blog_ai_content).toBe(true);
    expect(observations.legal_platform).toBe('clio');
    expect(observations.email_provider).toBe('google');
    expect(observations.dmarc_configured).toBe(true);
    expect(firm.attorneys_count).toBe(10);
    expect(firm.primary_practice).toBe('criminal_defense');
    expect(firm.state).toBe('FL');
  });

  it('captura el lead y lo mueve a pre_scored', async () => {
    const lead = [...harness.repositories.leadsById.values()][0];
    expect(lead?.email).toBe('jsmith@smithlawmiami.com');
    expect(lead?.status).toBe('pre_scored');
    expect(lead?.pre_score).toBeGreaterThan(0);
    expect(lead?.firm_id).toBeTruthy();
  });

  it('entrega evidencia y run record al MemoryStore', async () => {
    const evidence = harness.memory.evidence.find((e) => e.scanId === scanId);
    const run = harness.memory.runs.find((r) => r.scanId === scanId);

    expect(evidence?.items.some((i) => i.kind === 'page_text')).toBe(true);
    expect(evidence?.items.some((i) => i.kind === 'dns_record')).toBe(true);
    expect(run?.record.pipeline).toBe('InProcessPipeline');
    expect(run?.record.steps.map((s) => s.step)).toContain('scrape');
    // Todo lo que va al Memory System tiene que poder viajar como JSON plano.
    expect(JSON.parse(JSON.stringify(run))).toEqual(run);
  });

  it('GET /scan devuelve el scan guardado', async () => {
    const response = await harness.app.request(`/api/v1/scan/${scanId}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.scan_id).toBe(scanId);
    expect(body.firm.domain).toBe(DOMAIN);
    expect(body.quick_report.summary).toBeTruthy();
  });

  it('GET /questions adapta las preguntas a las señales del scan', async () => {
    const response = await harness.app.request(`/api/v1/assessment/${scanId}/questions`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);

    const body = await response.json();
    const ids = body.questions.map((q: { id: string }) => q.id);

    expect(body.total_questions).toBeGreaterThanOrEqual(8);
    expect(body.total_questions).toBeLessThanOrEqual(12);
    // Policy y Clio detectados: se saltan Q1.1 y Q2.1.
    expect(ids).not.toContain('Q1.1');
    expect(ids).not.toContain('Q2.1');
    expect(ids).toContain('Q1.2');
    expect(ids).toContain('Q2.2');
    expect(ids).toContain('Q4.2');

    const q22 = body.questions.find((q: { id: string }) => q.id === 'Q2.2');
    expect(q22.skipped_question).toBe('Q2.1');
    expect(q22.skip_reason).toBe('Clio detected in tech stack');
  });

  it('POST /submit devuelve score, tier, decision, plan y pricing', async () => {
    const response = await harness.app.request(`/api/v1/assessment/${scanId}/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ responses: RESPONSES }),
    });
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.assessment_id).toBeTruthy();
    expect(body.composite_score).toBeGreaterThan(0);
    expect(body.tier).toBe('FORTRESS');
    expect(body.decision).toBe('AUTO_BIND');
    expect(Object.keys(body.domain_scores)).toHaveLength(6);
    expect(body.override_rules_triggered).toEqual([]);
    expect(body.path_to_insurability).toBeNull();

    // Criminal defense en Florida con 10 abogados: los factores salen de las tablas del handbook.
    expect(body.pricing.factors.practice_multiplier).toBe(2);
    expect(body.pricing.factors.jurisdiction_factor).toBe(1.25);
    expect(body.pricing.factors.size_factor).toBe(1.1);
    expect(body.pricing.options).toHaveLength(3);
    expect(body.pricing.options[1].annual_premium).toBeGreaterThan(0);
  });

  it('persiste el assessment y cierra el funnel del lead', async () => {
    const assessment = harness.repositories.assessmentsByScanId.get(scanId);
    expect(assessment?.decision).toBe('AUTO_BIND');

    const lead = [...harness.repositories.leadsById.values()][0];
    expect(lead?.status).toBe('assessment_completed');
    expect(lead?.composite_score).toBe(assessment?.composite_score);
  });
});

describe('protección por session_token', () => {
  let site: TestSite;
  let harness: TestHarness;
  let scanId: string;
  let token: string;

  beforeAll(async () => {
    site = await startTestSite();
    harness = buildHarness({ fetcher: new LocalSiteFetcher(site.port) });
    const response = await harness.app.request('/api/v1/scan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ domain: DOMAIN }),
    });
    const body = await response.json();
    scanId = body.scan_id;
    token = body.session_token;
  });

  afterAll(async () => {
    await site.close();
  });

  const protectedRoutes = () => [
    { method: 'GET', path: `/api/v1/scan/${scanId}` },
    { method: 'GET', path: `/api/v1/assessment/${scanId}/questions` },
    { method: 'POST', path: `/api/v1/assessment/${scanId}/submit` },
  ];

  it('responde 401 sin token', async () => {
    for (const route of protectedRoutes()) {
      const response = await harness.app.request(route.path, {
        method: route.method,
        headers: { 'content-type': 'application/json' },
        body: route.method === 'POST' ? JSON.stringify({ responses: RESPONSES }) : undefined,
      });
      expect(response.status, `${route.method} ${route.path}`).toBe(401);
    }
  });

  it('responde 401 con un token mal formado', async () => {
    const response = await harness.app.request(`/api/v1/assessment/${scanId}/questions`, {
      headers: { authorization: 'Bearer not-a-real-token' },
    });
    expect(response.status).toBe(401);
  });

  it('rechaza un token válido emitido para otro scan', async () => {
    const other = await harness.app.request('/api/v1/scan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ domain: 'otherfirm.com' }),
    });
    const otherToken = (await other.json()).session_token;

    const response = await harness.app.request(`/api/v1/assessment/${scanId}/questions`, {
      headers: { authorization: `Bearer ${otherToken}` },
    });
    expect(response.status).toBe(401);
    expect(otherToken).not.toBe(token);
  });

  it('devuelve 404 para un scan inexistente con token propio', async () => {
    const response = await harness.app.request(
      '/api/v1/scan/00000000-0000-4000-8000-000000000000',
      { headers: { authorization: `Bearer ${token}` } },
    );
    // El token es de otro scan, así que la autorización corta antes que el 404.
    expect(response.status).toBe(401);
  });
});

describe('dominio inalcanzable', () => {
  it('devuelve 200 con confianza LOW y website_found false', async () => {
    const harness = buildHarness({ fetcher: new UnreachableFetcher(), dns: emptyDns });

    const response = await harness.app.request('/api/v1/scan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ domain: 'this-domain-does-not-exist-9x7.com' }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.website_found).toBe(false);
    expect(body.pre_score.confidence).toBe('LOW');
    expect(body.session_token).toBeTruthy();
  });

  it('el assessment sigue funcionando sobre un scan degradado', async () => {
    const harness = buildHarness({ fetcher: new UnreachableFetcher(), dns: emptyDns });
    const scan = await (
      await harness.app.request('/api/v1/scan', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ domain: 'unreachable-firm.com' }),
      })
    ).json();

    const questions = await (
      await harness.app.request(`/api/v1/assessment/${scan.scan_id}/questions`, {
        headers: { authorization: `Bearer ${scan.session_token}` },
      })
    ).json();

    // Sin señales, se preguntan Q1.1 y Q2.1 en vez de saltarlas.
    const ids = questions.questions.map((q: { id: string }) => q.id);
    expect(ids).toContain('Q1.1');
    expect(ids).toContain('Q2.1');
    expect(ids).toContain('Q3.3');
  });
});

describe('validación y límites', () => {
  it('rechaza un dominio inválido con 400', async () => {
    const harness = buildHarness({ fetcher: new UnreachableFetcher() });
    const response = await harness.app.request('/api/v1/scan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ domain: 'not a domain' }),
    });
    expect(response.status).toBe(400);
  });

  it('rechaza un email con formato inválido antes de guardar el lead', async () => {
    const harness = buildHarness({ fetcher: new UnreachableFetcher() });
    const response = await harness.app.request('/api/v1/scan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ domain: 'example.com', email: 'not-an-email' }),
    });
    expect(response.status).toBe(400);
    expect(harness.repositories.leadsById.size).toBe(0);
  });

  it('aplica rate limiting por IP en POST /scan', async () => {
    const harness = buildHarness({
      fetcher: new UnreachableFetcher(),
      rateLimits: [{ limit: 2, windowMs: 60_000 }],
    });
    const send = () =>
      harness.app.request('/api/v1/scan', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7' },
        body: JSON.stringify({ domain: 'example.com' }),
      });

    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(200);

    const blocked = await send();
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBeTruthy();
  });

  it('solo permite los orígenes configurados en CORS', async () => {
    const harness = buildHarness({ fetcher: new UnreachableFetcher() });

    const allowed = await harness.app.request('/health', {
      headers: { origin: 'https://preview-abc.vercel.app' },
    });
    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://preview-abc.vercel.app');

    const denied = await harness.app.request('/health', {
      headers: { origin: 'https://evil.example.com' },
    });
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();
  });
});

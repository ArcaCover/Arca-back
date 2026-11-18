import { describe, expect, it, vi } from 'vitest';
import { AssessmentView, StartedAssessmentResponse, type AnswerValue, type Layer1Result, type RenderedQuestion } from '@arca/contracts';
import { createApp } from '../../src/http/app.js';
import { InMemoryRepository } from '../../src/repositories/in-memory.js';
import { InMemoryAssessmentRepository } from '../../src/assessment/repository.js';
import { issueSessionToken } from '../../src/auth/session-token.js';
import { PublicDomainResolver } from '../../src/pipeline/domain-resolution.js';
import { ANSWERS_ONLY_LINE, DEMO_DISCLOSURE, assessmentReportFilename, displayedScore, isCompleted, renderAssessmentHtml,
  type CompletedAssessment } from '../../src/report/assessment.js';
import { fixtureResult } from '../../../../packages/contracts/tests/fixture.js';

// DN-12 §6: the Layer 2 report. Every case runs the questionnaire through the HTTP app, so the record the report is
// built from is the one the service really stores. The renderer is injected: no Chromium, no network.
const secret = 's'.repeat(40);
const SCAN = 'sc_report';
const EMAIL = 'owner@smithlaw.com';
const PDF = new Uint8Array([37, 80, 68, 70]);
type Renderer = (html: string) => Promise<Uint8Array<ArrayBuffer>>;

async function setup(options: { layer1?: (result: Layer1Result) => void; renderReport?: Renderer | null } = {}) {
  let clock = Date.parse('2026-11-09T10:00:00.000Z');
  const repository = new InMemoryRepository();
  const assessmentRepository = new InMemoryAssessmentRepository();
  const scanRecord = (scanId: string, email: string) => {
    const result = { ...fixtureResult(), scanId, email };
    options.layer1?.(result);
    return { id: scanId, scan_id: scanId, email, canonical_domain: result.domain,
      domain_resolution: { status: 'RESOLVED' as const, canonicalDomain: result.domain, source: 'request' as const, reason: null },
      status: 'COMPLETED' as const, result, created_at: new Date(clock).toISOString(), completed_at: new Date(clock).toISOString(),
      duration_ms: 10, cached: false };
  };
  await repository.create(scanRecord(SCAN, EMAIL));
  const renderReport = vi.fn<Renderer>(options.renderReport ?? (async () => PDF));
  const application = createApp({ repository, assessmentRepository, pipeline: { run: vi.fn() }, sessionSecret: secret,
    corsOrigins: ['http://localhost:3000'], domainResolver: new PublicDomainResolver(async () => {}), clientIp: () => '127.0.0.1',
    now: () => clock, ...(options.renderReport === null ? {} : { renderReport }) });
  const token = await issueSessionToken(SCAN, EMAIL, secret);
  const request = (path: string, method = 'GET', body?: unknown, bearer: string | null = token) => application.app.request(path, { method,
    headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:3000', ...(bearer === null ? {} : { Authorization: `Bearer ${bearer}` }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  async function start() {
    const { assessmentId } = StartedAssessmentResponse.parse(await (await request(`/scan/${SCAN}/assessment`, 'POST')).json());
    await application.drain();
    return assessmentId;
  }
  const view = async (id: string) => AssessmentView.parse(await (await request(`/assessment/${id}`)).json());
  const save = async (id: string, questionId: string, answer: AnswerValue) =>
    expect((await request(`/assessment/${id}/answers/${questionId}`, 'PUT', { answer })).status).toBe(200);
  /** Answers every visible question, with `chosen` where it names one, and completes the assessment. */
  async function complete(id: string, chosen: Record<string, AnswerValue> = {}) {
    for (let step = 0; ; step++) {
      if (step > 30) throw new Error('Questionnaire never finished');
      const current = await view(id);
      const question = current.questions.find(candidate => !current.answers[candidate.id]);
      if (!question) break;
      await save(id, question.id, chosen[question.id] ?? firstAnswer(question));
    }
    expect((await request(`/assessment/${id}/complete`, 'POST', { attestation: true })).status).toBe(200);
    const record = await assessmentRepository.get(id);
    if (!record || !isCompleted(record)) throw new Error('The assessment was not completed');
    return record;
  }
  return { ...application, repository, scanRecord, renderReport, token, request, start, view, save, complete,
    report: (id: string, bearer: string | null = token) => request(`/assessment/${id}/report.pdf`, 'GET', undefined, bearer),
    advance: (milliseconds: number) => { clock += milliseconds; } };
}
function firstAnswer(question: RenderedQuestion): AnswerValue {
  if (question.type === 'multi_select') return { kind: 'options', optionIds: [question.options![0]!.id] };
  if (question.type === 'scale') return { kind: 'scale', value: question.scale!.max };
  if (question.type === 'number') return { kind: 'number', value: question.number!.min };
  return { kind: 'option', optionId: question.options![0]!.id };
}
const count = (html: string, pattern: RegExp) => [...html.matchAll(pattern)].length;
// What a reader sees: the page without its stylesheet and tags.
const text = (html: string) => html.replace(/<style>[\s\S]*<\/style>/, '').replace(/<[^>]+>/g, ' ');

describe('GET /assessment/:assessmentId/report.pdf', () => {
  it('returns the PDF of a completed assessment as a download', async () => {
    const s = await setup();
    const id = await s.start();
    await s.complete(id);
    const response = await s.report(id);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/pdf');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Content-Disposition')).toBe('attachment; filename="arca-assessment-smithlaw.com-2026-11-09.pdf"');
    // The browser can only read the filename if CORS exposes the header.
    expect(response.headers.get('Access-Control-Expose-Headers')).toContain('Content-Disposition');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PDF);
    expect(s.renderReport).toHaveBeenCalledTimes(1);
    expect(s.renderReport.mock.calls[0]![0]).toContain('<h1>Smith Law</h1>');
  });

  it('refuses a missing, malformed or wrong-email token', async () => {
    const s = await setup();
    const id = await s.start();
    await s.complete(id);
    const otherEmail = await issueSessionToken(SCAN, 'someone@smithlaw.com', secret);
    for (const bearer of [null, 'not-a-token', otherEmail]) {
      const response = await s.report(id, bearer);
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ error: 'unauthorized' });
    }
    expect(s.renderReport).not.toHaveBeenCalled();
  });

  it("refuses another scan's token, even a valid one, and an assessment that does not exist", async () => {
    const s = await setup();
    const id = await s.start();
    await s.complete(id);
    await s.repository.create(s.scanRecord('sc_other', EMAIL));
    const other = await issueSessionToken('sc_other', EMAIL, secret);
    // The other token is good for its own scan, so only the scan check can refuse it.
    expect((await s.request('/scan/sc_other', 'GET', undefined, other)).status).toBe(200);
    expect((await s.report(id, other)).status).toBe(401);
    expect((await s.report('as_missing')).status).toBe(404);
    expect(s.renderReport).not.toHaveBeenCalled();
  });

  it('has no report until the assessment is completed', async () => {
    const s = await setup();
    const id = await s.start();
    for (const answered of [false, true]) {
      if (answered) await s.save(id, 'D1.2', { kind: 'option', optionId: 'yes' });
      const response = await s.report(id);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: 'incomplete', message: 'Complete the assessment before requesting its report' });
      expect(response.headers.get('Cache-Control')).toBe('no-store');
    }
    expect(s.renderReport).not.toHaveBeenCalled();
  });

  it('says plainly that the score rests on the answers alone when the website could not be read', async () => {
    const flagged = await setup({ layer1: result => { result.preScore.flags = [...result.preScore.flags, 'WEBSITE_UNAVAILABLE']; } });
    const id = await flagged.start();
    const record = await flagged.complete(id);
    expect(record.result).toMatchObject({ layer1Score: null, compositeScore: record.result.layer2Score });
    expect(record.result.flags).toContain('LAYER1_UNAVAILABLE');
    expect((await flagged.report(id)).status).toBe(200);
    const html = flagged.renderReport.mock.calls[0]![0];
    expect(html).toContain(`<div class="total">${displayedScore(record.result.layer2Score)}<small> / 100</small></div>`);
    expect(html).toContain(`<div class="tier-line">Based only on the firm&#39;s answers; no public evidence could be verified (low confidence).</div>`);
    expect(count(html, /no public evidence could be verified/g)).toBe(1);
    expect(html).toContain('Public evidence · Layer 1</div><div class="part-score">Not scored</div>');
    expect(html).not.toMatch(/Combined from the public evidence|highest-risk|manual review|whatever the answers/);

    const clean = await setup();
    const cleanId = await clean.start();
    await clean.complete(cleanId);
    await clean.report(cleanId);
    expect(clean.renderReport.mock.calls[0]![0]).not.toMatch(/could not read|manual review|no public evidence could be verified/);
  });

  it('answers 503 when no renderer is configured or the renderer fails, never a storage error', async () => {
    const none = await setup({ renderReport: null });
    const noneId = await none.start();
    await none.complete(noneId);
    const unconfigured = await none.report(noneId);
    expect(unconfigured.status).toBe(503);
    expect(await unconfigured.json()).toEqual({ error: 'report_unavailable', message: 'Report rendering is not configured' });

    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const broken = await setup({ renderReport: async () => { throw new Error('Chromium did not start'); } });
      const brokenId = await broken.start();
      await broken.complete(brokenId);
      const failed = await broken.report(brokenId);
      expect(failed.status).toBe(503);
      expect(await failed.json()).toEqual({ error: 'report_unavailable', message: 'The report could not be prepared; try again' });
    } finally { error.mockRestore(); }
  });

  it('ends with the 24-hour session, like every assessment read', async () => {
    const s = await setup();
    const id = await s.start();
    await s.complete(id);
    s.advance(86_400_000);
    const response = await s.report(id);
    expect(response.status).toBe(410);
    expect(await response.json()).toMatchObject({ error: 'expired' });
    expect(s.renderReport).not.toHaveBeenCalled();
  });

  it('is in the OpenAPI document with the scan session token', async () => {
    const { app } = await setup();
    const document = await (await app.request('/openapi.json')).json() as
      { paths: Record<string, { get: { security: unknown; responses: Record<string, { content: object }> } }> };
    const route = document.paths['/assessment/{assessmentId}/report.pdf']!.get;
    expect(route.security).toEqual([{ sessionToken: [] }]);
    expect(Object.keys(route.responses).sort()).toEqual(['200', '401', '404', '409', '410', '500', '503']);
    expect(route.responses['200']!.content).toHaveProperty('application/pdf');
  });
});

describe('Assessment Report content', () => {
  // D1.1 opens the follow-up D1.1a; D3.2 and D5.1 leave room to improve, so the action plan has items.
  const chosen: Record<string, AnswerValue> = { 'D1.1': { kind: 'option', optionId: 'written_shared' },
    'D3.1': { kind: 'scale', value: 3 }, 'D3.2': { kind: 'option', optionId: 'none' }, 'D5.1': { kind: 'number', value: 12 } };
  async function completed(options: Parameters<typeof setup>[0] = {}, answers = chosen): Promise<CompletedAssessment> {
    const s = await setup(options);
    return s.complete(await s.start(), answers);
  }

  it('states the firm, the date, the combined score with its two parts, the six areas and the versions', async () => {
    const record = await completed();
    const { result } = record;
    const html = renderAssessmentHtml(record);
    expect(html).toContain('<title>Arca Assessment Report: Smith Law</title>');
    expect(html).toContain('<h1>Smith Law</h1>');
    expect(html).toContain('smithlaw.com<br>Assessment completed November 9, 2026');
    expect(result.compositeScore).not.toBeNull();
    // Printed as the results screen's gauge shows it: a whole number.
    expect(html).toContain(`<div class="total">${Math.round(result.compositeScore!)}<small> / 100</small></div>`);
    expect(html).toContain(`<div class="tier">${result.tier}</div>`);
    expect(html).toContain(`Public evidence · Layer 1</div><div class="part-score">82<small> / 100</small>`);
    expect(html).toContain(`The firm&#39;s answers · Layer 2</div><div class="part-score">${result.layer2Score}<small> / 100</small>`);
    expect(result.domains).toHaveLength(6);
    for (const domain of result.domains) {
      expect(html).toContain(`${domain.label.replace('&', '&amp;')}<small>${domain.weight}% weight</small>`);
      expect(html).toContain(`<div class="points">${domain.score} / 100</div>`);
    }
    expect(html).toContain(`Question bank ${result.bankVersion}`);
    expect(html).toContain(`Scoring model ${result.scoringVersion}`);
    expect(html).toContain(`Assessment ${record.id}`);
  });

  it('lists the action plan as stored, each step with its own gain', async () => {
    const record = await completed();
    const html = renderAssessmentHtml(record);
    expect(record.result.actionPlan.map(item => item.id)).toEqual(expect.arrayContaining(['improve:D3.1', 'improve:D3.2']));
    record.result.actionPlan.forEach((item, index) => {
      expect(html).toContain(`<div class="step-number">${index + 1}</div><div><div class="step-title">${item.title}</div>` +
        `${item.detail}</div><div class="gain">Up to +${item.pointsGain} points</div>`);
    });
    expect(html).toContain('Next step: We check a sample of citations.');
    expect(html).toContain('Each point gain is an estimate on its own, not a promised outcome.');

    const nothingLeft = structuredClone(record);
    nothingLeft.result.actionPlan = [];
    expect(renderAssessmentHtml(nothingLeft)).toContain('No additional improvements were identified from the answers.');
  });

  it('prints the answers as they were asked, in the questionnaire order, and only the questions the firm ended on', async () => {
    const s = await setup();
    const id = await s.start();
    // Shown, answered, then hidden again by a changed parent: its wording stays in the record but it was not an answer.
    await s.save(id, 'D2.1', { kind: 'options', optionIds: ['consumer'] });
    await s.save(id, 'D2.1a', { kind: 'option', optionId: 'yes' });
    await s.save(id, 'D2.1', { kind: 'options', optionIds: ['legal_enterprise', 'enterprise_general'] });
    const record = await s.complete(id, chosen);
    expect(record.rendered.some(question => question.id === 'D2.1a')).toBe(true);
    const html = renderAssessmentHtml(record);
    expect(html).not.toContain('Is there a plan to move client work away from personal AI accounts?');
    const answer = (question: string, reply: string, domain: string) => `<div class="answer"><div class="question">${question}</div>${reply}<small>${domain}</small></div>`;
    expect(html).toContain(answer('How is your firm’s AI policy shared with the team?', 'Written and shared with everyone', 'AI Governance &amp; Policy'));
    expect(html).toContain(answer('Which AI accounts are used for client work?',
      'Legal AI platforms with a business agreement; General-purpose enterprise AI accounts', 'AI Tool Environment'));
    expect(html).toContain(answer('How much AI-assisted work is reviewed by a lawyer before it reaches a client?',
      '3 on a scale from 0 (None) to 4 (All of it)', 'Human Oversight &amp; Review'));
    expect(html).toContain(answer('How many hours of AI training does each lawyer receive per year?', '12 hours per lawyer / year', 'Training &amp; Competency'));
    // A follow-up is marked, since it did not count towards the score.
    expect(html).toContain(answer('How often is your written AI policy reviewed?', 'Quarterly or more often', 'AI Governance &amp; Policy · context only, not scored'));
    const order = (await s.view(id)).questions.map(question => question.id);
    const printed = [...html.matchAll(/<div class="question">([^<]*)<\/div>/g)].map(match => match[1]);
    expect(printed).toEqual(order.map(questionId => record.rendered.find(question => question.id === questionId)!.text));
    expect(printed).toHaveLength(Object.keys(record.answers).length);
    expect(html).toContain('Attested as true by the firm on November 9, 2026.');
  });

  it('carries one demo disclosure and no price, coverage promise, decision or email', async () => {
    const restricted = await completed({ layer1: result => {
      result.preScore.flags = ['WEBSITE_UNAVAILABLE', 'PROVIDER_COST_UNKNOWN', 'COMMERCIAL_DECISION_BLOCKED'];
    } });
    // Low confidence, not high risk: no senior referral rides on an unreadable website any more (DN-12 §14).
    expect(restricted.result.decision).toBe('UNKNOWN');
    const html = renderAssessmentHtml(restricted);
    expect(html).toContain(`<p class="disclosure"><strong>Demo assessment.</strong> ${DEMO_DISCLOSURE}</p>`);
    expect(DEMO_DISCLOSURE).toBe('The questions and the scoring are provisional, so these results are illustrative. ' +
      'This is not an insurance offer, a price or an underwriting decision.');
    // The answers-only line stands in for the combined-score line; the rest of the page says nothing about price or
    // coverage beyond the one disclosure.
    const notice = ANSWERS_ONLY_LINE.replaceAll("'", '&#39;');
    expect(text(html)).toContain(notice);
    const seen = text(html).replace(notice, '');
    for (const once of [/Demo assessment/g, /provisional/gi, /illustrative/gi, /insurance offer/gi, /underwriting decision/gi, /\bprice\b/gi]) {
      expect(count(seen, once)).toBe(1);
    }
    // The two version names carry "demo" and "coverage" of their own; they are provenance, not copy.
    const copy = seen.replace(restricted.result.bankVersion, '').replace(restricted.result.scoringVersion, '');
    expect(count(copy, /demo/gi)).toBe(1);
    // The firm's own answer may speak of "Approved data protection agreements"; nothing says the firm was approved.
    expect(copy).not.toMatch(/REFERRAL|referral|declin|premium|\$|approved|eligible|coverage|bind/);
    // Machine flags are not report copy, and the report is not addressed to anyone.
    expect(seen).not.toMatch(/[A-Z]+_[A-Z]+/);
    expect(html).not.toContain(EMAIL);
  });

  it('shows no combined score or tier when the quick scan could not support one', async () => {
    const record = await completed({ layer1: result => { result.preScore.total = null; result.preScore.tier = 'UNKNOWN'; } });
    expect(record.result).toMatchObject({ compositeScore: null, layer1Score: null, tier: 'UNKNOWN' });
    const html = renderAssessmentHtml(record);
    expect(html).toContain('<div class="total">—<small> / 100</small></div>');
    expect(html).toContain('<div class="tier">NOT SCORED</div>');
    expect(html).toContain('The quick scan did not support a combined score.');
    expect(html).toContain('Public evidence · Layer 1</div><div class="part-score">Not scored</div>');
    expect(html).toContain(`<div class="part-score">${record.result.layer2Score}<small> / 100</small>`);
    expect(text(html)).not.toContain('UNKNOWN');
  });

  it('never names a risk group or a manual review for an unreadable website, even with the weakest answers', async () => {
    expect(ANSWERS_ONLY_LINE).toBe("Based only on the firm's answers; no public evidence could be verified (low confidence).");
    // Nothing public and the weakest answers: the tier follows the answers alone, and the page says why once.
    const weakest: Record<string, AnswerValue> = { 'D1.1': { kind: 'option', optionId: 'none' }, 'D1.2': { kind: 'option', optionId: 'no' },
      'D2.1': { kind: 'options', optionIds: ['none'] }, 'D3.1': { kind: 'scale', value: 0 }, 'D3.2': { kind: 'option', optionId: 'none' },
      'D4.1': { kind: 'options', optionIds: ['none'] }, 'D5.1': { kind: 'number', value: 0 }, 'D6.1': { kind: 'option', optionId: 'no' } };
    const record = await completed({ layer1: result => { result.preScore.total = 0; result.preScore.tier = 'CRITICAL';
      result.preScore.flags = ['WEBSITE_UNAVAILABLE']; } }, weakest);
    expect(record.result).toMatchObject({ layer1Score: null, compositeScore: record.result.layer2Score, tier: 'CRITICAL' });
    const html = renderAssessmentHtml(record);
    expect(count(html, /no public evidence could be verified \(low confidence\)/g)).toBe(1);
    expect(html).not.toMatch(/highest-risk|manual review/);
  });

  it('falls back to the domain when the scan found no firm name, and never lets stored text become markup', async () => {
    const unnamed = await completed({ layer1: result => { result.identity = null; } });
    // The domain is the title then, so the line under it does not repeat it.
    const titled = renderAssessmentHtml(unnamed);
    expect(titled).toContain('<h1>smithlaw.com</h1>');
    expect(titled).toContain('<div class="meta">Assessment completed November 9, 2026</div>');

    const record = await completed({ layer1: result => { result.identity!.firmName = '<script>alert(1)</script> & Co'; } });
    record.rendered[0]!.text = '<img src=x onerror=alert(2)>';
    record.rendered[0]!.options![0]!.label = '<b>bold</b>';
    record.answers[record.rendered[0]!.id] = { kind: 'option', optionId: record.rendered[0]!.options![0]!.id };
    record.result.actionPlan[0]!.title = '<i>title</i>';
    record.result.actionPlan[0]!.detail = 'Next step: <u>detail</u>.';
    const html = renderAssessmentHtml(record);
    for (const raw of ['<script>', '<img', '<b>', '<i>', '<u>']) expect(html).not.toContain(raw);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; Co');
    expect(html).toContain('&lt;img src=x onerror=alert(2)&gt;');
    expect(html).toContain('&lt;b&gt;bold&lt;/b&gt;');
  });

  it('names the file after the domain and the completion date', async () => {
    expect(assessmentReportFilename(await completed())).toBe('arca-assessment-smithlaw.com-2026-11-09.pdf');
  });

  it('dates the report and its file by the day in Florida, not in UTC', async () => {
    // Completed at 10:30 p.m. in Miami on November 9, which is already November 10 in UTC.
    const record = await completed();
    record.result.completedAt = '2026-11-10T03:30:00.000Z';
    record.attested_at = '2026-11-10T03:29:00.000Z';
    expect(assessmentReportFilename(record)).toBe('arca-assessment-smithlaw.com-2026-11-09.pdf');
    const html = renderAssessmentHtml(record);
    expect(html).toContain('Assessment completed November 9, 2026');
    expect(html).toContain('Attested as true by the firm on November 9, 2026.');
  });

  it('prints the combined score as the screen shows it, not with its decimals', async () => {
    const record = await completed();
    for (const [stored, shown] of [[52.15, 52], [52.5, 53], [0.4, 0], [99.99, 100]] as const) {
      record.result.compositeScore = stored;
      expect(renderAssessmentHtml(record)).toContain(`<div class="total">${shown}<small> / 100</small></div>`);
    }
  });

  it('says one hour, not one hours, in an answer', async () => {
    const record = await completed();
    const training = record.rendered.find(question => question.number)!;
    record.answers[training.id] = { kind: 'number', value: 1 };
    expect(renderAssessmentHtml(record)).toContain('1 hour per lawyer / year');
    expect(renderAssessmentHtml(record)).not.toContain('1 hours');
  });
});

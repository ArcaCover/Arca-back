import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { AssessmentResult, AssessmentView, Layer1Result, PollResponse, ScanResponse, StartedAssessmentResponse, type AnswerValue,
  type RenderedQuestion } from '@arca/contracts';
import { createApp } from '../../src/http/app.js';
import { InMemoryRepository } from '../../src/repositories/in-memory.js';
import { InProcessPipeline } from '../../src/pipeline/in-process-pipeline.js';
import { mockSources } from '../../src/pipeline/mock-sources.js';
import { PublicDomainResolver } from '../../src/pipeline/domain-resolution.js';

// DN-12: a website that refuses to be read no longer fails the scan. The whole path runs through the HTTP app as the
// front drives it, on the mock domains, and every response is parsed with the published schemas, which are strict.
const OVERRIDE = { id: 'WEBSITE_UNAVAILABLE', decision: 'REFERRAL_SENIOR', reason: 'The firm website could not be read' };

function setup() {
  const repository = new InMemoryRepository();
  const sources = mockSources();
  const directories = { bar: vi.fn(sources.bar.run), avvo: vi.fn(sources.avvo.run) };
  const renderReport = vi.fn(async (_html: string) => new Uint8Array([37, 80, 68, 70]));
  const { app, drain } = createApp({ repository, sessionSecret: 's'.repeat(40), corsOrigins: [], clientIp: () => '127.0.0.1',
    domainResolver: new PublicDomainResolver(async () => {}), renderReport,
    pipeline: new InProcessPipeline({ website: sources.website, bar: { ...sources.bar, run: directories.bar },
      avvo: { run: directories.avvo }, repository, timeoutMs: 30_000 }) });
  async function scan(domain: string, email = `owner@${domain}`) {
    const response = await app.request('/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, domain }) });
    const started = ScanResponse.parse(await response.json());
    await drain();
    const headers = { Authorization: `Bearer ${started.sessionToken}`, 'Content-Type': 'application/json' };
    const request = (path: string, method = 'GET', body?: unknown) =>
      app.request(path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const poll = PollResponse.parse(await (await request(`/scan/${started.scanId}`)).json());
    return { started, poll, request };
  }
  return { scan, drain, directories, renderReport, repository };
}

// The answer worth the most on every question, so the questionnaire gets every chance to lift the restriction.
function bestAnswer(question: RenderedQuestion): AnswerValue {
  if (question.type === 'multi_select') return { kind: 'options', optionIds: [question.options![0]!.id] };
  if (question.type === 'scale') return { kind: 'scale', value: question.scale!.max };
  if (question.type === 'number') return { kind: 'number', value: question.number!.min };
  return { kind: 'option', optionId: question.options![0]!.id };
}

describe('a firm whose website refuses to be read', () => {
  it('uses the contract the front has installed', () => {
    const contracts = JSON.parse(readFileSync(new URL('../../../../packages/contracts/package.json', import.meta.url), 'utf8'));
    expect(contracts.version).toBe('0.4.0');
  });

  it('ends PARTIAL with a full high-risk result, a report, and an assessment that keeps the restriction', async () => {
    const s = setup();
    const { started, poll, request } = await s.scan('blocked.arca.example');
    expect(started.status).toBe('RUNNING');
    expect(poll.status).toBe('PARTIAL');
    if (poll.status !== 'PARTIAL') throw new Error('unreachable');
    const result = poll.result;
    // Strict parsing: an unknown field or enum value anywhere in the result would throw here.
    expect(Layer1Result.parse(result)).toEqual(result);
    expect(result.preScore).toMatchObject({ total: 0, tier: 'CRITICAL', confidence: 'LOW', assessmentStatus: 'INSUFFICIENT_EVIDENCE',
      decision: 'REFERRAL_SENIOR', overrides: [OVERRIDE] });
    expect(result.preScore.flags).toEqual(['INCOMPLETE_SOURCES', 'WEBSITE_UNAVAILABLE', 'INCOMPLETE_EVIDENCE', 'COMMERCIAL_DECISION_BLOCKED']);
    expect(result.sources.website).toMatchObject({ status: 'error', dataStatus: 'UNKNOWN', code: 'ACCESS_BLOCKED',
      reason: 'robots.txt does not allow automated reading of the website' });
    expect(result.sources.bar).toMatchObject({ status: 'skipped', code: 'INSUFFICIENT_IDENTITY', costUsd: 0 });
    expect(result.sources.avvo).toMatchObject({ status: 'skipped', code: 'INSUFFICIENT_IDENTITY', costUsd: 0 });
    expect(result.identity).toMatchObject({ status: 'INSUFFICIENT', firmName: null });
    expect(s.directories.bar).not.toHaveBeenCalled();
    expect(s.directories.avvo).not.toHaveBeenCalled();

    const report = await request(`/scan/${started.scanId}/report.pdf`);
    expect(report.status).toBe(200);
    expect(report.headers.get('Content-Type')).toBe('application/pdf');
    expect(s.renderReport.mock.calls[0]![0]).toMatch(/website could not be read, so everything that could not be verified counts as unknown/);

    const startedAssessment = await request(`/scan/${started.scanId}/assessment`, 'POST');
    expect(startedAssessment.status).toBe(202);
    const { assessmentId } = StartedAssessmentResponse.parse(await startedAssessment.json());
    await s.drain();
    const view = async () => AssessmentView.parse(await (await request(`/assessment/${assessmentId}`)).json());
    expect((await view()).status).toBe('READY');
    for (let step = 0; ; step++) {
      if (step > 30) throw new Error('Questionnaire never finished');
      const current = await view();
      const question = current.questions.find(candidate => !current.answers[candidate.id]);
      if (!question) break;
      expect((await request(`/assessment/${assessmentId}/answers/${question.id}`, 'PUT', { answer: bestAnswer(question) })).status).toBe(200);
    }
    const completed = await request(`/assessment/${assessmentId}/complete`, 'POST', { attestation: true });
    expect(completed.status).toBe(200);
    const assessment = AssessmentResult.parse(await completed.json());
    // Nothing public was verified, so the composite can reach 70 at most (0 x 0.3 + 100 x 0.7), and no answer lifts the restriction.
    expect(assessment).toMatchObject({ layer1Score: 0, decision: 'REFERRAL_SENIOR', commercialDecisionBlocked: true });
    expect(assessment.compositeScore).toBeLessThanOrEqual(70);
    expect(assessment.flags).toEqual(expect.arrayContaining(['WEBSITE_UNAVAILABLE', 'INSUFFICIENT_EVIDENCE', 'COMMERCIAL_DECISION_BLOCKED']));
    expect(AssessmentResult.parse(await (await request(`/assessment/${assessmentId}/result`)).json())).toEqual(assessment);

    // The assessment report says it too. The answers lifted the tier out of CRITICAL, so the sentence names no risk group.
    expect(assessment.tier).not.toBe('CRITICAL');
    const assessmentReport = await request(`/assessment/${assessmentId}/report.pdf`);
    expect(assessmentReport.status).toBe(200);
    expect(assessmentReport.headers.get('Content-Disposition')).toBe(
      `attachment; filename="arca-assessment-blocked.arca.example-${assessment.completedAt.slice(0, 10)}.pdf"`);
    const assessmentHtml = s.renderReport.mock.calls[1]![0];
    expect(assessmentHtml).toContain('<h1>blocked.arca.example</h1>');
    expect(assessmentHtml).toMatch(/website could not be read during the scan\. Until it can be read, this result needs a manual review/);
    expect(assessmentHtml).not.toMatch(/REFERRAL|referral|declin|premium|\$|approved|eligible/);
  });

  it('serves the same marked result to the next requester inside the repair cooldown', async () => {
    const s = setup();
    const first = await s.scan('blocked.arca.example');
    const second = await s.scan('blocked.arca.example', 'partner@blocked.arca.example');
    expect(second.poll).toMatchObject({ status: 'PARTIAL', cached: true });
    if (first.poll.status !== 'PARTIAL' || second.poll.status !== 'PARTIAL') throw new Error('unreachable');
    expect(second.poll.result.preScore).toEqual(first.poll.result.preScore);
  });
});

describe('a firm whose website could not be reached', () => {
  it('still ends FAILED, with no result, no report and no assessment', async () => {
    const s = setup();
    const { started, poll, request } = await s.scan('failed.arca.example');
    expect(poll.status).toBe('FAILED');
    expect(poll).not.toHaveProperty('result');
    expect((await s.repository.get(started.scanId))?.result).toBeNull();
    expect((await request(`/scan/${started.scanId}/report.pdf`)).status).toBe(409);
    expect((await request(`/scan/${started.scanId}/assessment`, 'POST')).status).toBe(409);
    expect(s.directories.bar).not.toHaveBeenCalled();
    expect(s.renderReport).not.toHaveBeenCalled();
  });
});

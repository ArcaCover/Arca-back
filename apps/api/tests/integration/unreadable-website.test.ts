import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { AssessmentResult, AssessmentView, Layer1Result, PollResponse, ScanResponse, StartedAssessmentResponse, type AnswerValue,
  type RenderedQuestion } from '@arca/contracts';
import { createApp } from '../../src/http/app.js';
import { InMemoryRepository } from '../../src/repositories/in-memory.js';
import { InProcessPipeline } from '../../src/pipeline/in-process-pipeline.js';
import { mockSources } from '../../src/pipeline/mock-sources.js';
import { PublicDomainResolver } from '../../src/pipeline/domain-resolution.js';
import { isoDay } from '../../src/report/layout.js';

// DN-12 §14: a website that could not be read at all, for any cause on the site's side, no longer fails the scan. The
// whole path runs through the HTTP app as the front drives it, on the mock domains, and every response is parsed with
// the published schemas, which are strict.

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

// The answer worth the most on every question.
function bestAnswer(question: RenderedQuestion): AnswerValue {
  if (question.type === 'multi_select') return { kind: 'options', optionIds: [question.options![0]!.id] };
  if (question.type === 'scale') return { kind: 'scale', value: question.scale!.max };
  if (question.type === 'number') return { kind: 'number', value: question.number!.min };
  return { kind: 'option', optionId: question.options![0]!.id };
}

describe('a firm whose website could not be read', () => {
  it('uses the contract the front has installed', () => {
    const contracts = JSON.parse(readFileSync(new URL('../../../../packages/contracts/package.json', import.meta.url), 'utf8'));
    expect(contracts.version).toBe('0.6.0-dev.1');
  });

  it.each([
    ['refuses to be read (definitive)', 'blocked.arca.example', 'ACCESS_BLOCKED', 'robots.txt does not allow automated reading of the website'],
    ['could not be reached (transient)', 'down.arca.example', 'PROVIDER_ERROR', 'The website could not be reached'],
  ])('ends PARTIAL with low confidence when it %s, and the assessment scores the answers alone', async (_name, domain, code, reason) => {
    const s = setup();
    const { started, poll, request } = await s.scan(domain);
    expect(started.status).toBe('RUNNING');
    expect(poll.status).toBe('PARTIAL');
    if (poll.status !== 'PARTIAL') throw new Error('unreachable');
    const result = poll.result;
    // Strict parsing: an unknown field or enum value anywhere in the result would throw here.
    expect(Layer1Result.parse(result)).toEqual(result);
    expect(result.preScore).toMatchObject({ confidence: 'LOW', assessmentStatus: 'INSUFFICIENT_EVIDENCE', decision: 'UNKNOWN', overrides: [] });
    expect(result.preScore.flags).toEqual(['INCOMPLETE_SOURCES', 'WEBSITE_UNAVAILABLE', 'INCOMPLETE_EVIDENCE', 'COMMERCIAL_DECISION_BLOCKED']);
    expect(result.sources.website).toMatchObject({ status: 'error', dataStatus: 'UNKNOWN', code, pagesCrawled: 0, reason });
    expect(result.sources.bar).toMatchObject({ status: 'skipped', code: 'INSUFFICIENT_IDENTITY', costUsd: 0 });
    expect(result.sources.avvo).toMatchObject({ status: 'skipped', code: 'INSUFFICIENT_IDENTITY', costUsd: 0 });
    expect(result.identity).toMatchObject({ status: 'INSUFFICIENT', firmName: null });
    expect(s.directories.bar).not.toHaveBeenCalled();
    expect(s.directories.avvo).not.toHaveBeenCalled();

    const report = await request(`/scan/${started.scanId}/report.pdf`);
    expect(report.status).toBe(200);
    expect(report.headers.get('Content-Type')).toBe('application/pdf');
    const reportHtml = s.renderReport.mock.calls[0]![0];
    expect(reportHtml).toContain('No score from public evidence');
    expect(reportHtml).not.toMatch(/highest-risk|manual review|CRITICAL/);

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
    // Nothing public was verified, so the composite is the answers alone (DN-12 §14), with no restriction on top.
    expect(assessment).toMatchObject({ layer1Score: null, compositeScore: assessment.layer2Score, decision: 'UNKNOWN',
      commercialDecisionBlocked: true });
    expect(assessment.flags).toEqual(expect.arrayContaining(['LAYER1_UNAVAILABLE', 'WEBSITE_UNAVAILABLE', 'INSUFFICIENT_EVIDENCE',
      'COMMERCIAL_DECISION_BLOCKED']));
    expect(AssessmentResult.parse(await (await request(`/assessment/${assessmentId}/result`)).json())).toEqual(assessment);

    const assessmentReport = await request(`/assessment/${assessmentId}/report.pdf`);
    expect(assessmentReport.status).toBe(200);
    expect(assessmentReport.headers.get('Content-Disposition')).toBe(
      `attachment; filename="arca-assessment-${domain}-${isoDay(assessment.completedAt)}.pdf"`);
    const assessmentHtml = s.renderReport.mock.calls[1]![0];
    expect(assessmentHtml).toContain(`<h1>${domain}</h1>`);
    expect(assessmentHtml).toContain('Based only on the firm&#39;s answers; no public evidence could be verified (low confidence).');
    expect(assessmentHtml).not.toMatch(/REFERRAL|referral|declin|premium|\$|approved|eligible|highest-risk|manual review/);
  });

  it('serves the same result of a refusal to the next requester, and for the whole window', async () => {
    const s = setup();
    const first = await s.scan('blocked.arca.example');
    const second = await s.scan('blocked.arca.example', 'partner@blocked.arca.example');
    expect(second.poll).toMatchObject({ status: 'PARTIAL', cached: true });
    if (first.poll.status !== 'PARTIAL' || second.poll.status !== 'PARTIAL') throw new Error('unreachable');
    expect(second.poll.result.preScore).toEqual(first.poll.result.preScore);
  });
});

describe('a scan that failed on our side', () => {
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

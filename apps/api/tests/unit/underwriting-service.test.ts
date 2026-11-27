import { describe, expect, it } from 'vitest';
import { AssessmentView, isUnderwritingResult, type AnswerValue } from '@arca/contracts';
import { fixtureResult } from '../../../../packages/contracts/tests/fixture.js';
import { InMemoryAssessmentRepository } from '../../src/assessment/repository.js';
import { AssessmentService } from '../../src/assessment/service.js';
import { isCompleted, renderAssessmentHtml } from '../../src/report/assessment.js';
import type { ScanRecord } from '../../src/repositories/types.js';

const NOW = Date.parse('2026-11-27T12:00:00.000Z');
const one = (optionId: string): AnswerValue => ({ kind: 'option', optionId });
const many = (...optionIds: string[]): AnswerValue => ({ kind: 'options', optionIds });
function scan(): ScanRecord {
  return { id: 'id_1', scan_id: 'sc_fixture', email: 'contact@smithlaw.com', canonical_domain: 'smithlaw.com',
    domain_resolution: { status: 'RESOLVED', canonicalDomain: 'smithlaw.com', source: 'request', reason: null },
    status: 'COMPLETED', result: fixtureResult(), created_at: new Date(NOW - 60_000).toISOString(),
    completed_at: new Date(NOW - 30_000).toISOString(), duration_ms: 1000, cached: false };
}
function service(exposeAudit = false) {
  const repository = new InMemoryAssessmentRepository();
  return { repository, service: new AssessmentService({ repository, now: () => NOW, engine: 'underwriting', underwriting: { exposeAudit } }) };
}
async function answerAll(s: AssessmentService, id: string, answers: Record<string, AnswerValue>) {
  for (let i = 0; i < 20; i++) {
    const view = AssessmentView.parse(s.view(await s.get(id)));
    const pending = view.questions.find(q => !view.answers[q.id]);
    if (!pending) return view;
    const answer = answers[pending.id];
    if (!answer) throw new Error(`No answer for ${pending.id}`);
    await s.save(id, pending.id, answer);
  }
  throw new Error('Too many questions');
}
const legalWork = {
  G1: many('G1-legal-research', 'G1-case-software'), G2: many('G2-research'), C1: many('C1-none'), C2: one('C2-yes'),
  F1: one('F1-6-15'), C3: one('C3-never'), 'P3-1': one('P31-always'), 'P3-2': one('P32-always'), 'DG-1': one('DG1-anon'),
  'P3-3': one('P33-owner'), 'P1-1': one('P11-review-before'), 'P1-2': one('P12-isolated'), 'P1-4': one('P14-reviewed'),
};

describe('the assessment service on bank 4.0', () => {
  it('starts READY with the questions that come before the profile, then asks the profile’s', async () => {
    const { service: s } = service();
    const record = await s.start(scan());
    expect(record.status).toBe('READY');
    expect(s.view(record)).toMatchObject({ bankVersion: '4.0', bankStatus: 'PROVISIONAL' });
    expect(s.view(record).questions.map(q => q.id)).toEqual(['G1', 'G2', 'C1', 'C2', 'F1']);
    const view = await answerAll(s, record.id, legalWork);
    expect(view.questions.map(q => q.id)).toEqual(['G1', 'G2', 'C1', 'C2', 'F1', 'C3', 'P3-1', 'P3-2', 'DG-1', 'P3-3']);
  });
  it('invalidates, with an event each, the answers a profile change leaves unasked', async () => {
    const { service: s, repository } = service();
    const record = await s.start(scan());
    await answerAll(s, record.id, legalWork);
    await s.save(record.id, 'G2', many('G2-client-questions'));
    const view = s.view(await s.get(record.id));
    expect(view.questions.map(q => q.id)).toContain('P1-1');
    expect(view.answers['P3-1']).toBeUndefined();
    expect(repository.events.filter(e => e.kind === 'invalidated').map(e => e.question_id).sort()).toEqual(['P3-1', 'P3-2', 'P3-3']);
  });
  it('refuses an option of another question and a question not asked now', async () => {
    const { service: s } = service();
    const record = await s.start(scan());
    await expect(s.save(record.id, 'C2', one('C1-none'))).rejects.toMatchObject({ code: 'invalid_answer' });
    await expect(s.save(record.id, 'P3-1', one('P31-always'))).rejects.toMatchObject({ code: 'not_visible' });
  });
  it('completes to a quote, keeps the audit stored and sends the firm none of it', async () => {
    const { service: s, repository } = service();
    const record = await s.start(scan());
    await answerAll(s, record.id, legalWork);
    const result = await s.complete(record.id);
    if (!isUnderwritingResult(result)) throw new Error('expected a bank 4.0 result');
    expect(result.outcome.type).toBe('quote');
    expect(result.audit).toBeNull();
    expect(result.underwriterSummary).toBeNull();
    const stored = await repository.get(record.id);
    expect(stored?.result && 'audit' in stored.result && stored.result.audit?.decisionRuleFired).toBe('auto_bind');
    expect(await s.result(record.id)).toEqual(result);
  });
  it('keeps the audit in the result in the debug modes', async () => {
    const { service: s } = service(true);
    const record = await s.start(scan());
    await answerAll(s, record.id, legalWork);
    const result = await s.complete(record.id);
    expect(isUnderwritingResult(result) && result.audit?.decisionRuleFired).toBe('auto_bind');
  });
  it('prints a quote with its premiums, and a schedule with no number and no underwriter notes', async () => {
    for (const [answers, kind] of [[legalWork, 'quote'], [{ ...legalWork, 'P3-2': one('P32-trust') }, 'schedule']] as const) {
      const { service: s, repository } = service();
      const record = await s.start(scan());
      await answerAll(s, record.id, answers);
      await s.complete(record.id);
      const stored = (await repository.get(record.id))!;
      if (!isCompleted(stored)) throw new Error('not completed');
      const html = renderAssessmentHtml(stored);
      expect(html).toContain('Score by category');
      expect(html).not.toContain('usage profile');
      if (kind === 'quote') expect(html).toMatch(/Indicative quote[\s\S]*\$\d/);
      else { expect(html).toContain('Book a time'); expect(html).not.toMatch(/\$\d/); }
    }
  });
});

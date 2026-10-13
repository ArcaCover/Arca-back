import { randomUUID } from 'node:crypto';
import { AssessmentResult, AssessmentView, type AnswerValue } from '@arca/contracts';
import { DEMO_BANK, collectEvidence, planAssessment, reconcileAnswers, renderQuestions, rulesPlan, skippedQuestions,
  validateAnswer, visibleQuestions, type QuestionBank } from '@arca/questions';
import { scoreAssessment } from '@arca/scoring';
import type { ScanRecord } from '../repositories/types.js';
import type { AnswerEvent, AssessmentRecord, AssessmentRepository, AssessmentUpdate } from './repository.js';

export class AssessmentFailure extends Error {
  constructor(readonly code: 'scan_not_ready' | 'not_found' | 'invalid_answer' | 'not_visible' | 'incomplete' |
    'already_completed' | 'expired' | 'not_ready' | 'rate_limited' | 'conflict', message: string,
    readonly status: 400 | 404 | 409 | 410 | 429 = 409) { super(message); }
}
export type AssessmentAgent = Parameters<typeof planAssessment>[0]['agent'];
export type AssessmentServiceOptions = {
  repository: AssessmentRepository; now?: () => number; bank?: QuestionBank;
  agent?: AssessmentAgent; planningTimeoutMs?: number; maxWritesPerMinute?: number;
};
const SESSION_TTL_MS = 86_400_000;
const STALE_PLANNING_MS = 30_000;

export class AssessmentService {
  private readonly now: () => number;
  private readonly jobs = new Map<string, Promise<void>>();
  private readonly answerHits = new Map<string, number[]>();
  constructor(private readonly options: AssessmentServiceOptions) { this.now = options.now ?? Date.now; }
  private timestamp() { return new Date(this.now()).toISOString(); }
  async start(scan: ScanRecord) {
    if (!['COMPLETED', 'PARTIAL'].includes(scan.status) || !scan.result) {
      throw new AssessmentFailure('scan_not_ready', 'Complete the scan before starting an assessment');
    }
    const existing = await this.options.repository.getByScan(scan.scan_id);
    if (existing) {
      return this.active(existing);
    }
    const expiresAt = Date.parse(scan.created_at) + SESSION_TTL_MS;
    if (this.now() >= expiresAt) throw new AssessmentFailure('expired', 'This scan session has expired', 410);
    const bank = structuredClone(this.options.bank ?? DEMO_BANK);
    const layer1 = structuredClone(scan.result);
    const assessmentId = `as_${randomUUID().replaceAll('-', '')}`;
    const record = await this.options.repository.create({ id: assessmentId, scan_id: scan.scan_id,
      revision: 0, status: 'PLANNING', bank_version: bank.bankVersion, bank_snapshot: bank, layer1_snapshot: layer1,
      evidence_snapshot: collectEvidence(layer1), planner: 'rules', planner_model: null, prompt_version: null,
      plan: null, rendered: [], answers: {}, result: null, attested_at: null,
      created_at: this.timestamp(), updated_at: this.timestamp(), expires_at: new Date(expiresAt).toISOString(),
      completed_at: null, answer_write_count: 0 });
    // Only the winning creator dispatches the agent. Existing PLANNING records are repaired by
    // the bounded rules-only recovery, avoiding duplicate paid planning on repeated creates.
    if (record.id === assessmentId && record.status === 'PLANNING') this.schedule(record);
    return this.active(record);
  }
  async get(id: string) {
    const record = await this.options.repository.get(id);
    if (!record) throw new AssessmentFailure('not_found', 'Assessment not found', 404);
    return this.active(record);
  }
  private async active(record: AssessmentRecord): Promise<AssessmentRecord> {
    // Results are immutable after completion. Capability-token expiry still protects every HTTP read.
    if (record.status === 'EXPIRED') throw new AssessmentFailure('expired', 'This assessment session has expired', 410);
    if (this.now() >= Date.parse(record.expires_at)) {
      if (record.status === 'COMPLETED') throw new AssessmentFailure('expired', 'This assessment session has expired', 410);
      const expired = await this.options.repository.commit(record.id, record.revision, { status: 'EXPIRED', updated_at: this.timestamp() });
      if (!expired) {
        const fresh = await this.options.repository.get(record.id);
        if (fresh && fresh.revision !== record.revision) return this.active(fresh);
      }
      throw new AssessmentFailure('expired', 'This assessment session has expired', 410);
    }
    return record;
  }
  private schedule(record: AssessmentRecord, recovery = false) {
    if (this.jobs.has(record.id)) return;
    const job = Promise.resolve().then(() => this.prepare(record, recovery)).catch(error => {
      // Leave a persistence failure in PLANNING. Recovery can safely retry from the persisted snapshots.
      console.error('[assessment] planning failed', record.id, error instanceof Error ? error.message : 'Unknown error');
    });
    this.jobs.set(record.id, job);
    void job.finally(() => { if (this.jobs.get(record.id) === job) this.jobs.delete(record.id); });
  }
  private async prepare(record: AssessmentRecord, recovery: boolean) {
    if (this.now() >= Date.parse(record.expires_at)) { await this.active(record).catch(error => {
      if (!(error instanceof AssessmentFailure && error.code === 'expired')) throw error;
    }); return; }
    const { bank_snapshot: bank, layer1_snapshot: layer1, evidence_snapshot: evidence } = record;
    const fallback = () => ({ plan: rulesPlan(bank, layer1, evidence), planner: 'rules' as const, model: null, promptVersion: null });
    let planned: Awaited<ReturnType<typeof planAssessment>>;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      planned = recovery ? fallback() : await Promise.race([
        planAssessment({ bank, layer1, evidence, agent: this.options.agent, timeoutMs: this.options.planningTimeoutMs ?? 15_000 }),
        new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('Assessment planning timed out')),
          this.options.planningTimeoutMs ?? 15_000); timeout.unref(); }),
      ]);
    } catch { planned = fallback(); }
    finally { if (timeout) clearTimeout(timeout); }
    const fresh = await this.options.repository.get(record.id);
    if (!fresh || fresh.status !== 'PLANNING' || fresh.revision !== record.revision) return;
    if (this.now() >= Date.parse(fresh.expires_at)) { await this.active(fresh).catch(error => {
      if (!(error instanceof AssessmentFailure && error.code === 'expired')) throw error;
    }); return; }
    await this.options.repository.commit(record.id, record.revision, {
      status: 'READY', plan: planned.plan, planner: planned.planner, planner_model: planned.model,
      prompt_version: planned.promptVersion, rendered: renderQuestions(bank, planned.plan, layer1, {}, evidence), updated_at: this.timestamp(),
    });
  }
  async recoverInterrupted() {
    const records = await this.options.repository.planningBefore(new Date(this.now() - STALE_PLANNING_MS).toISOString());
    for (const record of records) this.schedule(record, true);
    await this.drain();
  }
  async drain() { while (this.jobs.size) await Promise.all([...this.jobs.values()]); }
  private currentQuestions(record: AssessmentRecord) {
    if (!record.plan) return [];
    const ids = visibleQuestions(record.bank_snapshot, record.plan, record.layer1_snapshot, record.answers).map(question => question.id);
    return ids.map(id => {
      const rendered = record.rendered.find(question => question.id === id);
      if (!rendered) throw new Error('Missing rendered assessment snapshot');
      return rendered;
    });
  }
  view(record: AssessmentRecord): AssessmentView {
    const questions = this.currentQuestions(record);
    const answered = questions.filter(question => record.answers[question.id] !== undefined).length;
    return AssessmentView.parse({ assessmentId: record.id, scanId: record.scan_id, status: record.status,
      bankVersion: record.bank_version, bankStatus: 'DEMO', planner: record.plan ? record.planner : null,
      intro: record.plan?.intro ?? null, expiresAt: new Date(record.expires_at).toISOString(), sessionScope: 'CURRENT_TAB_24H',
      questions, answers: record.answers, skipped: skippedQuestions(record.bank_snapshot, record.layer1_snapshot),
      progress: { answered, total: questions.length }, estimatedMinutes: Math.ceil(Math.max(0, questions.length - answered) / 2) });
  }
  private checkWriteLimit(id: string) {
    const now = this.now();
    for (const [key, hits] of this.answerHits) {
      const fresh = hits.filter(time => now - time < 60_000);
      if (fresh.length) this.answerHits.set(key, fresh); else this.answerHits.delete(key);
    }
    const hits = this.answerHits.get(id) ?? [];
    if (hits.length >= (this.options.maxWritesPerMinute ?? 120)) throw new AssessmentFailure('rate_limited', 'Too many answer updates; try again in a minute', 429);
    this.answerHits.set(id, [...hits, now]);
  }
  async save(id: string, questionId: string, answer: AnswerValue) {
    this.checkWriteLimit(id);
    return this.mutate(id, record => {
      if (record.status === 'COMPLETED') throw new AssessmentFailure('already_completed', 'This assessment is already complete');
      if (!record.plan || !['READY', 'IN_PROGRESS'].includes(record.status)) throw new AssessmentFailure('not_ready', 'The assessment is not ready');
      if (record.answer_write_count >= 1000) throw new AssessmentFailure('rate_limited', 'Assessment answer update limit reached', 429);
      const question = visibleQuestions(record.bank_snapshot, record.plan, record.layer1_snapshot, record.answers).find(item => item.id === questionId);
      if (!question) throw new AssessmentFailure('not_visible', 'This question is not currently visible');
      if (!validateAnswer(question, answer)) throw new AssessmentFailure('invalid_answer', 'The answer is not valid for this question', 400);
      const answers = reconcileAnswers(record.bank_snapshot, record.plan, record.layer1_snapshot, { ...record.answers, [questionId]: answer });
      const shown = renderQuestions(record.bank_snapshot, record.plan, record.layer1_snapshot, answers, record.evidence_snapshot);
      const rendered = [...record.rendered, ...shown.filter(item => !record.rendered.some(existing => existing.id === item.id))];
      const exact = record.rendered.find(item => item.id === questionId);
      if (!exact) throw new Error('Missing rendered answer snapshot');
      const events: AnswerEvent[] = [{ question_id: questionId, answer, kind: 'saved',
        suggested: sameAnswer(exact.suggestedAnswer, answer), rendered: exact, created_at: this.timestamp() }];
      for (const oldId of Object.keys(record.answers)) if (answers[oldId] === undefined) {
        const previous = record.rendered.find(item => item.id === oldId);
        if (!previous) throw new Error('Missing invalidated answer snapshot');
        events.push({ question_id: oldId, answer: null, kind: 'invalidated', suggested: false, rendered: previous, created_at: this.timestamp() });
      }
      return { update: { status: 'IN_PROGRESS', answers, rendered, answer_write_count: record.answer_write_count + 1,
        updated_at: this.timestamp() }, events };
    });
  }
  async complete(id: string): Promise<AssessmentResult> {
    const record = await this.mutate(id, current => {
      if (current.status === 'COMPLETED') return null;
      if (!current.plan || !['READY', 'IN_PROGRESS'].includes(current.status)) throw new AssessmentFailure('not_ready', 'The assessment is not ready');
      const visible = visibleQuestions(current.bank_snapshot, current.plan, current.layer1_snapshot, current.answers);
      if (visible.some(question => !current.answers[question.id] || !validateAnswer(question, current.answers[question.id]!))) {
        throw new AssessmentFailure('incomplete', 'Answer every visible question before completing');
      }
      const completedAt = this.timestamp();
      const result = AssessmentResult.parse(scoreAssessment({ assessmentId: current.id, layer1: current.layer1_snapshot,
        bank: current.bank_snapshot, answers: current.answers, completedAt }));
      return { update: { status: 'COMPLETED', result, attested_at: completedAt, completed_at: completedAt, updated_at: completedAt }, events: [] };
    });
    if (!record.result) throw new Error('Completed assessment is missing its result');
    return record.result;
  }
  async result(id: string) {
    const record = await this.get(id);
    if (record.status !== 'COMPLETED' || !record.result) throw new AssessmentFailure('incomplete', 'Complete the assessment before requesting its result');
    return record.result;
  }
  private async mutate(id: string, build: (record: AssessmentRecord) => { update: AssessmentUpdate; events: AnswerEvent[] } | null) {
    for (let attempt = 0; attempt < 12; attempt++) {
      const record = await this.get(id);
      const change = build(record);
      if (!change) return record;
      const committed = await this.options.repository.commit(id, record.revision, change.update, change.events);
      if (committed) return committed;
    }
    throw new AssessmentFailure('conflict', 'The assessment changed while saving; reload and retry');
  }
}
function sameAnswer(a: AnswerValue | null, b: AnswerValue) {
  if (!a || a.kind !== b.kind) return false;
  if (a.kind === 'options' && b.kind === 'options') return JSON.stringify([...a.optionIds].sort()) === JSON.stringify([...b.optionIds].sort());
  return JSON.stringify(a) === JSON.stringify(b);
}

import type { SupabaseClient } from '@supabase/supabase-js';
import type { AnswerValue, AssessmentEvidence, AssessmentResult, AssessmentStatus, Layer1Result, RenderedQuestion } from '@arca/contracts';
import type { QuestionBank, planAssessment } from '@arca/questions';

export type AssessmentPlan = Awaited<ReturnType<typeof planAssessment>>['plan'];
export type AssessmentRecord = {
  id: string; scan_id: string; revision: number; status: AssessmentStatus;
  bank_version: string; bank_snapshot: QuestionBank; layer1_snapshot: Layer1Result; evidence_snapshot: AssessmentEvidence[];
  planner: 'agent' | 'rules'; planner_model: string | null; prompt_version: string | null;
  plan: AssessmentPlan | null; rendered: RenderedQuestion[]; answers: Record<string, AnswerValue>;
  result: AssessmentResult | null; attested_at: string | null; created_at: string; updated_at: string;
  expires_at: string; completed_at: string | null; answer_write_count: number;
};
export type AnswerEvent = {
  question_id: string; answer: AnswerValue | null; kind: 'saved' | 'invalidated';
  suggested: boolean; rendered: RenderedQuestion; created_at: string;
};
export type AssessmentUpdate = Partial<Pick<AssessmentRecord,
  'status' | 'planner' | 'planner_model' | 'prompt_version' | 'plan' | 'rendered' | 'answers' |
  'result' | 'attested_at' | 'updated_at' | 'completed_at' | 'answer_write_count'>>;
export interface AssessmentRepository {
  /** Unique scan_id makes even simultaneous create requests return the same assessment. */
  create(record: AssessmentRecord): Promise<AssessmentRecord>;
  get(id: string): Promise<AssessmentRecord | null>;
  getByScan(scanId: string): Promise<AssessmentRecord | null>;
  /** A revision mismatch returns null. State changes and all audit events commit together. */
  commit(id: string, revision: number, update: AssessmentUpdate, events?: AnswerEvent[]): Promise<AssessmentRecord | null>;
  planningBefore(before: string): Promise<AssessmentRecord[]>;
}
const mutable = new Set(['status', 'planner', 'planner_model', 'prompt_version', 'plan', 'rendered', 'answers',
  'result', 'attested_at', 'updated_at', 'completed_at', 'answer_write_count']);

/** Deliberately ephemeral. Reusing this object survives an app recreation, never a process restart. */
export class InMemoryAssessmentRepository implements AssessmentRepository {
  private readonly records = new Map<string, AssessmentRecord>();
  private readonly byScan = new Map<string, string>();
  readonly events: Array<AnswerEvent & { assessment_id: string }> = [];
  /** Forgets everything. The debug reset uses it; production never calls it. */
  clear(): void { this.records.clear(); this.byScan.clear(); this.events.length = 0; }
  async create(record: AssessmentRecord) {
    const existing = this.byScan.get(record.scan_id);
    if (existing) return structuredClone(this.records.get(existing)!);
    if (this.records.has(record.id)) throw new Error('Duplicate assessment ID');
    if (record.revision !== 0 || record.answer_write_count !== 0 || Object.keys(record.answers).length) throw new Error('New assessment must have no answer history');
    this.records.set(record.id, structuredClone(record)); this.byScan.set(record.scan_id, record.id);
    return structuredClone(record);
  }
  async get(id: string) { return structuredClone(this.records.get(id) ?? null); }
  async getByScan(scanId: string) { return this.get(this.byScan.get(scanId) ?? ''); }
  async commit(id: string, revision: number, update: AssessmentUpdate, events: AnswerEvent[] = []) {
    const record = this.records.get(id);
    if (!record || record.revision !== revision || ['COMPLETED', 'EXPIRED', 'FAILED'].includes(record.status)) return null;
    if (Object.keys(update).some(key => !mutable.has(key))) throw new Error('Immutable assessment field');
    if (record.plan !== null && update.plan !== undefined && JSON.stringify(record.plan) !== JSON.stringify(update.plan)) {
      throw new Error('Assessment plan is immutable');
    }
    if (record.plan !== null && (update.planner !== undefined && update.planner !== record.planner ||
      update.planner_model !== undefined && update.planner_model !== record.planner_model ||
      update.prompt_version !== undefined && update.prompt_version !== record.prompt_version)) throw new Error('Planner audit is immutable');
    if (update.rendered && (JSON.stringify(update.rendered.slice(0, record.rendered.length)) !== JSON.stringify(record.rendered) ||
      new Set(update.rendered.map(question => question.id)).size !== update.rendered.length)) throw new Error('Rendered questions are immutable');
    const currentAnswers = update.answers ?? record.answers;
    const currentRendered = update.rendered ?? record.rendered;
    if (new Set(events.map(event => event.question_id)).size !== events.length) throw new Error('Duplicate answer event');
    for (const event of events) {
      if (JSON.stringify(currentRendered.find(question => question.id === event.question_id)) !== JSON.stringify(event.rendered)) {
        throw new Error('Answer event must retain the exact rendered question');
      }
      if (event.kind === 'saved' ? event.answer === null || JSON.stringify(currentAnswers[event.question_id]) !== JSON.stringify(event.answer)
        : event.answer !== null || currentAnswers[event.question_id] !== undefined || record.answers[event.question_id] === undefined) {
        throw new Error('Answer event must match the committed answer');
      }
    }
    for (const questionId of new Set([...Object.keys(record.answers), ...Object.keys(currentAnswers)])) {
      if (JSON.stringify(record.answers[questionId]) !== JSON.stringify(currentAnswers[questionId]) &&
        !events.some(event => event.question_id === questionId)) throw new Error('Every answer change requires an audit event');
    }
    if (update.status === 'COMPLETED' && (!record.plan || !update.result || !update.attested_at || !update.completed_at)) {
      throw new Error('Completed assessment requires a plan, result and attestation');
    }
    const saves = events.filter(event => event.kind === 'saved').length;
    const count = update.answer_write_count ?? record.answer_write_count;
    if (saves > 1 || count !== record.answer_write_count + saves || count > 1000) throw new Error('Invalid assessment answer write count');
    const next = structuredClone({ ...record, ...update, revision: revision + 1 });
    // No await between compare, record replacement and audit append: one atomic in-process operation.
    const audit = structuredClone(events).map(event => ({ ...event, assessment_id: id }));
    this.records.set(id, next);
    this.events.push(...audit);
    return structuredClone(next);
  }
  async planningBefore(before: string) {
    return structuredClone([...this.records.values()].filter(record => record.status === 'PLANNING' && record.updated_at < before));
  }
}

/** Durable writes use a PostgreSQL row lock/CAS and append audit events in the same RPC transaction. */
export class SupabaseAssessmentRepository implements AssessmentRepository {
  constructor(private readonly client: SupabaseClient) {}
  async create(record: AssessmentRecord): Promise<AssessmentRecord> {
    const { data, error } = await this.client.rpc('create_assessment', { p_record: record });
    if (error || !data) throw new Error('Unable to create assessment', { cause: error });
    return data as AssessmentRecord;
  }
  async get(id: string): Promise<AssessmentRecord | null> {
    const { data, error } = await this.client.from('assessments').select('*').eq('id', id).maybeSingle();
    if (error) throw new Error('Unable to read assessment', { cause: error });
    return data;
  }
  async getByScan(scanId: string): Promise<AssessmentRecord | null> {
    const { data, error } = await this.client.from('assessments').select('*').eq('scan_id', scanId).maybeSingle();
    if (error) throw new Error('Unable to read assessment', { cause: error });
    return data;
  }
  async commit(id: string, revision: number, update: AssessmentUpdate, events: AnswerEvent[] = []): Promise<AssessmentRecord | null> {
    const { data, error } = await this.client.rpc('update_assessment', { p_id: id, p_revision: revision, p_update: update, p_events: events });
    if (error) throw new Error('Unable to commit assessment', { cause: error });
    return data as AssessmentRecord | null;
  }
  async planningBefore(before: string): Promise<AssessmentRecord[]> {
    const { data, error } = await this.client.from('assessments').select('*').eq('status', 'PLANNING').lt('updated_at', before).limit(100);
    if (error) throw new Error('Unable to recover assessments', { cause: error });
    return data ?? [];
  }
}

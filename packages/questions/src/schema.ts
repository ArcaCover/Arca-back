import { z } from 'zod';
import { DomainKey, QuestionType } from '@arca/contracts';

export const SignalPath = z.enum(['website.W1_aiPolicy.found', 'website.W2_aiInServices.found',
  'website.W2_aiInServices.tools', 'website.W3_aiDisclosure.found', 'website.W5_teamSize',
  'website.W6_privacyPolicy.found', 'website.W6_privacyPolicy.mentionsClientData', 'avvo.A8_disciplined']);
export type SignalPath = z.infer<typeof SignalPath>;
export type Condition = { signal: SignalPath; op: 'eq'|'neq'|'in'|'gte'|'lte'|'known'|'unknown'; value?: unknown }
  | { answer: string; op: 'eq'|'neq'|'includes'|'excludes'|'gte'|'lte'; value: unknown }
  | { all: Condition[] } | { any: Condition[] } | { not: Condition };
export const Condition: z.ZodType<Condition> = z.lazy(() => z.union([
  z.object({ signal: SignalPath, op: z.enum(['eq','neq','in','gte','lte','known','unknown']), value: z.unknown().optional() }).strict(),
  z.object({ answer: z.string(), op: z.enum(['eq','neq','includes','excludes','gte','lte']), value: z.unknown() }).strict(),
  z.object({ all: z.array(Condition).min(1).max(20) }).strict(),
  z.object({ any: z.array(Condition).min(1).max(20) }).strict(), z.object({ not: Condition }).strict(),
])) as z.ZodType<Condition>;
export const Question = z.object({
  id: z.string().regex(/^D[1-6]\.\d+[a-z]?$/), domain: DomainKey, type: QuestionType,
  text: z.string().min(1).max(300), help: z.string().nullable(),
  scored: z.boolean(), mandatory: z.boolean(), priority: z.number().int().min(1).max(5),
  maxPoints: z.number().nonnegative(),
  options: z.array(z.object({ id: z.string().min(1), label: z.string().min(1), points: z.number().finite(),
    flag: z.string().optional(), exclusive: z.boolean().optional() }).strict()).min(2).optional(),
  scale: z.object({ min: z.number(), max: z.number(), step: z.number().positive(),
    minLabel: z.string(), maxLabel: z.string(), points: z.array(z.number().finite()) }).strict().optional(),
  number: z.object({ min: z.number(), max: z.number(), unit: z.string(),
    bands: z.array(z.object({ upTo: z.number(), points: z.number().finite() }).strict()).min(1) }).strict().optional(),
  showWhen: Condition.optional(),
  prefillFrom: z.array(z.object({ when: Condition, option: z.string(), evidenceSignal: SignalPath }).strict()).optional(),
  contradicts: z.array(z.object({ option: z.string(), when: Condition, flag: z.string() }).strict()).optional(),
  relevantSignals: z.array(SignalPath),
}).strict();
export type Question = z.infer<typeof Question>;
export const QuestionBank = z.object({
  bankVersion: z.string().regex(/^\d+\.\d+\.\d+-demo\.\d+$/), bankStatus: z.literal('DEMO'),
  domains: z.array(z.object({ key: DomainKey, label: z.string(), weight: z.number().positive(),
    minQuestions: z.number().int().positive() }).strict()).length(6),
  questions: z.array(Question).min(8).max(100),
  limits: z.object({ minQuestions: z.number().int().min(8), maxQuestions: z.number().int().max(12) }).strict(),
}).strict().superRefine((bank, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  if (new Set(bank.domains.map(d => d.key)).size !== 6 || bank.domains.reduce((s,d) => s+d.weight,0) !== 100) issue('Domains must be unique and weights total 100');
  if (new Set(bank.questions.map(q => q.id)).size !== bank.questions.length) issue('Duplicate question ID');
  const required = bank.questions.filter(q => q.mandatory || q.showWhen);
  if (bank.limits.minQuestions > bank.limits.maxQuestions || required.length > bank.limits.maxQuestions) issue('Invalid plan limits');
  for (const d of bank.domains) if (bank.questions.filter(q => q.domain === d.key && q.scored).length < d.minQuestions) issue(`Missing scored domain coverage: ${d.key}`);
  const dependencies = (c?: Condition): string[] => !c ? [] : 'answer' in c ? [c.answer] : 'all' in c ? c.all.flatMap(dependencies) : 'any' in c ? c.any.flatMap(dependencies) : 'not' in c ? dependencies(c.not) : [];
  for (const q of bank.questions) {
    if (q.scored && (!q.mandatory || q.showWhen || q.maxPoints <= 0)) issue(`Scored questions must have fixed unconditional coverage: ${q.id}`);
    if (!q.scored && q.maxPoints !== 0) issue(`Informational questions cannot affect points: ${q.id}`);
    const optionType = ['single_select','multi_select','yes_no'].includes(q.type);
    if (optionType !== !!q.options || (q.type === 'scale') !== !!q.scale || (q.type === 'number') !== !!q.number) issue(`Invalid answer shape: ${q.id}`);
    if (q.options && new Set(q.options.map(o => o.id)).size !== q.options.length) issue(`Duplicate option: ${q.id}`);
    if (q.type === 'yes_no' && q.options?.length !== 2) issue(`Yes/no requires two options: ${q.id}`);
    if (q.options?.some(o => !q.scored && o.points !== 0)) issue(`Informational points must be zero: ${q.id}`);
    if (q.scale && (q.scale.max <= q.scale.min || (q.scale.max-q.scale.min)%q.scale.step !== 0 || q.scale.points.length !== (q.scale.max-q.scale.min)/q.scale.step+1)) issue(`Invalid scale: ${q.id}`);
    if (q.number && (q.number.max <= q.number.min || q.number.bands.at(-1)!.upTo !== q.number.max || q.number.bands.some((b,i) => b.upTo < q.number!.min || (i>0 && b.upTo <= q.number!.bands[i-1]!.upTo)))) issue(`Invalid numeric bands: ${q.id}`);
    for (const ref of dependencies(q.showWhen)) if (!bank.questions.some(other => other.id === ref)) issue(`Unknown dependency: ${ref}`);
    for (const rule of [...(q.prefillFrom ?? []), ...(q.contradicts ?? [])]) if (!q.options?.some(o => o.id === rule.option)) issue(`Unknown option reference: ${q.id}`);
    const visit = (id: string, path: Set<string>): void => {
      if (path.has(id)) { issue(`Cyclic condition: ${q.id}`); return; }
      const item = bank.questions.find(other => other.id === id);
      for (const dep of dependencies(item?.showWhen)) visit(dep, new Set([...path,id]));
    };
    visit(q.id,new Set());
  }
});
export type QuestionBank = z.infer<typeof QuestionBank>;
export const PlannedItem = z.object({ questionId: z.string(), context: z.string().max(180).nullable(),
  evidenceIds: z.array(z.string()).max(3), suggestedOption: z.string().nullable() }).strict();
export const AgentPlan = z.object({ items: z.array(PlannedItem).min(8).max(12), intro: z.string().max(240) }).strict();
export type AgentPlan = z.infer<typeof AgentPlan>;

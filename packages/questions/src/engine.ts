import { AnswerValue, RenderedQuestion, type AssessmentEvidence, type Layer1Result } from '@arca/contracts';
import { type AgentPlan, type Condition, type Question, type QuestionBank, type SignalPath } from './schema.js';

export type Answers = Record<string, AnswerValue>;
export function signalValue(layer1: Layer1Result, path: SignalPath): unknown {
  return path.split('.').reduce<unknown>((value, key) => value && typeof value === 'object' ? (value as Record<string,unknown>)[key] : undefined, layer1.signals);
}
function answerValue(answer?: AnswerValue): unknown {
  return !answer ? undefined : answer.kind === 'option' ? answer.optionId : answer.kind === 'options' ? answer.optionIds : answer.value;
}
// Unknown is not false: in particular NOT(unanswered) must never show a follow-up.
function conditionValue(condition: Condition, layer1: Layer1Result, answers: Answers): boolean | null {
  if ('all' in condition) { const values = condition.all.map(c => conditionValue(c,layer1,answers)); return values.includes(false) ? false : values.includes(null) ? null : true; }
  if ('any' in condition) { const values = condition.any.map(c => conditionValue(c,layer1,answers)); return values.includes(true) ? true : values.includes(null) ? null : false; }
  if ('not' in condition) { const value = conditionValue(condition.not,layer1,answers); return value === null ? null : !value; }
  const actual = 'signal' in condition ? signalValue(layer1,condition.signal) : answerValue(answers[condition.answer]);
  const known = actual !== null && actual !== undefined;
  if (condition.op === 'known') return known;
  if (condition.op === 'unknown') return !known;
  if (!known) return null;
  switch(condition.op) {
    case 'eq': return JSON.stringify(actual) === JSON.stringify(condition.value);
    case 'neq': return JSON.stringify(actual) !== JSON.stringify(condition.value);
    case 'in': return Array.isArray(condition.value) && condition.value.includes(actual);
    case 'includes': return Array.isArray(actual) && actual.includes(condition.value);
    case 'excludes': return Array.isArray(actual) && !actual.includes(condition.value);
    case 'gte': return typeof actual === 'number' && typeof condition.value === 'number' && actual >= condition.value;
    case 'lte': return typeof actual === 'number' && typeof condition.value === 'number' && actual <= condition.value;
  }
}
export const evaluateCondition = (condition: Condition, layer1: Layer1Result, answers: Answers = {}): boolean => conditionValue(condition,layer1,answers) === true;

export function collectEvidence(layer1: Layer1Result): AssessmentEvidence[] {
  const facts: Array<[SignalPath, string]> = [
    ['website.W1_aiPolicy.found','The public scan detected an AI policy. Internal distribution still needs your confirmation.'],
    ['website.W2_aiInServices.found','The public scan detected a mention of AI in client services.'],
    ['website.W3_aiDisclosure.found','The public scan detected an AI disclosure.'],
    ['website.W6_privacyPolicy.found','The public scan detected a privacy policy.'],
    ['website.W6_privacyPolicy.mentionsClientData','The public scan detected a privacy policy mentioning client data.'],
  ];
  // IDs point to immutable scan signals, not invented source extracts. Layer1Result does not
  // expose field-level provenance, so sourceUrl stays null instead of fabricating citations.
  return facts.filter(([path]) => signalValue(layer1,path) === true).map(([path,text]) => ({
    id:`${layer1.scanId}:signal:${path}`,signal:path,value:true,text,sourceUrl:null,
  }));
}
export function validateAnswer(question: Question, value: unknown): value is AnswerValue {
  const parsed = AnswerValue.safeParse(value);
  if (!parsed.success) return false;
  const answer = parsed.data;
  if (question.type === 'single_select' || question.type === 'yes_no') return answer.kind === 'option' && !!question.options?.some(o => o.id === answer.optionId);
  if (question.type === 'multi_select') {
    if (answer.kind !== 'options' || new Set(answer.optionIds).size !== answer.optionIds.length) return false;
    const selected = answer.optionIds.map(id => question.options?.find(o => o.id === id));
    return selected.every(Boolean) && (!selected.some(o => o?.exclusive) || selected.length === 1);
  }
  if (question.type === 'scale') return answer.kind === 'scale' && !!question.scale && answer.value >= question.scale.min && answer.value <= question.scale.max && Math.abs((answer.value-question.scale.min)/question.scale.step-Math.round((answer.value-question.scale.min)/question.scale.step)) < 1e-9;
  return answer.kind === 'number' && !!question.number && Number.isInteger(answer.value) && answer.value >= question.number.min && answer.value <= question.number.max;
}
export function visibleQuestions(bank: QuestionBank, plan: AgentPlan, layer1: Layer1Result, answers: Answers): Question[] {
  return plan.items.map(item => bank.questions.find(q => q.id === item.questionId)).filter((q): q is Question => !!q && (!q.showWhen || evaluateCondition(q.showWhen,layer1,answers)));
}
export function reconcileAnswers(bank: QuestionBank, plan: AgentPlan, layer1: Layer1Result, answers: Answers): Answers {
  let current = {...answers};
  // Repeatedly invalidate descendants too; an answer to a now-hidden parent cannot keep
  // its own follow-up alive. The bank validator rejects cycles.
  for (let i=0;i<=bank.questions.length;i++) {
    const visible = new Map(visibleQuestions(bank,plan,layer1,current).map(q => [q.id,q]));
    const next = Object.fromEntries(Object.entries(current).filter(([id,a]) => visible.has(id) && validateAnswer(visible.get(id)!,a)));
    if (Object.keys(next).length === Object.keys(current).length) return next;
    current = next;
  }
  return current;
}
export function permittedSuggestion(question: Question, layer1: Layer1Result, evidence: AssessmentEvidence[]): string | null {
  return question.prefillFrom?.find(rule => evaluateCondition(rule.when,layer1) && evidence.some(e => e.signal === rule.evidenceSignal && e.value === true))?.option ?? null;
}
export function renderQuestions(bank: QuestionBank, plan: AgentPlan, layer1: Layer1Result, answers: Answers, evidence: AssessmentEvidence[]): RenderedQuestion[] {
  return visibleQuestions(bank,plan,layer1,answers).map(q => {
    const item = plan.items.find(i => i.questionId === q.id)!;
    const suggested = item.suggestedOption && item.suggestedOption === permittedSuggestion(q,layer1,evidence) ? item.suggestedOption : null;
    return RenderedQuestion.parse({id:q.id,domain:q.domain,domainLabel:bank.domains.find(d => d.key === q.domain)!.label,
      type:q.type,text:q.text,help:q.help,context:item.context,scored:q.scored,
      evidence:evidence.filter(e => item.evidenceIds.includes(e.id)),
      options:q.options?.map(o => ({id:o.id,label:o.label,exclusive:o.exclusive ?? false})) ?? null,
      scale:q.scale ? {min:q.scale.min,max:q.scale.max,step:q.scale.step,minLabel:q.scale.minLabel,maxLabel:q.scale.maxLabel} : null,
      number:q.number ? {min:q.number.min,max:q.number.max,unit:q.number.unit} : null,
      suggestedAnswer:suggested ? (q.type === 'multi_select' ? {kind:'options',optionIds:[suggested]} : {kind:'option',optionId:suggested}) : null});
  });
}
// Public presence is insufficient evidence for internal compliance: this fixture never
// awards implicit credit or silently answers a scored question.
export function skippedQuestions(_bank: QuestionBank, _layer1: Layer1Result): Array<{id:string;text:string;creditText:string}> { return []; }

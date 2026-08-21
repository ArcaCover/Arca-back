import { canonicalAnswer, QUESTION_SCORING } from './answer-scores.js';
import type { AssessmentResponse, Decision, OverrideRuleTriggered, ScoringFirm } from './types.js';

type RuleContext = {
  /** Respuestas canonicalizadas e indexadas por question_id, siempre como array. */
  answers: Record<string, string[]>;
  firm: ScoringFirm;
};

type OverrideRule = {
  id: string;
  decision: Decision;
  reason: string;
  matches: (ctx: RuleContext) => boolean;
};

const has = (ctx: RuleContext, question: string, value: string) =>
  ctx.answers[question]?.includes(value) ?? false;

/** Las 3 reglas del handbook. Ganan sobre el tier, pero solo endureciendo la decisión. */
export const OVERRIDE_RULES: OverrideRule[] = [
  {
    id: 'OR-001_real_data_in_public_tool',
    decision: 'REFERRAL',
    reason: 'Confidential client data entered into a free public AI tool',
    matches: (ctx) => has(ctx, 'Q2.3', 'real_data') && has(ctx, 'Q2.2', 'public_free'),
  },
  {
    id: 'OR-002_active_regulatory_investigation',
    decision: 'DECLINE',
    reason: 'Active regulatory investigation reported: not insurable',
    matches: (ctx) => has(ctx, 'Q6.1', 'regulatory_investigation'),
  },
  {
    id: 'OR-003_no_review_criminal_defense',
    decision: 'REFERRAL',
    reason: 'No AI output review process in a criminal defense practice',
    matches: (ctx) =>
      has(ctx, 'Q3.1', 'no_process') && ctx.firm.primary_practice === 'criminal_defense',
  },
];

/** Indexa respuestas normalizando alias, para que las reglas comparen ids canónicos. */
export function indexAnswers(responses: AssessmentResponse[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const r of responses) {
    const question = QUESTION_SCORING[r.question_id];
    const raw = Array.isArray(r.answer) ? r.answer : [r.answer];
    out[r.question_id] = question ? raw.map((a) => canonicalAnswer(question, a)) : raw;
  }
  return out;
}

export function evaluateOverrides(
  responses: AssessmentResponse[],
  firm: ScoringFirm,
): OverrideRuleTriggered[] {
  const ctx: RuleContext = { answers: indexAnswers(responses), firm };
  return OVERRIDE_RULES.filter((rule) => rule.matches(ctx)).map(({ id, reason, decision }) => ({
    id,
    reason,
    decision,
  }));
}

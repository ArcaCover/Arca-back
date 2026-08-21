import { buildActionPlan, rankImprovements } from './improvements.js';
import { buildPathToInsurability } from './path-to-insurability.js';
import { calculatePricing } from './pricing.js';
import { compositeScore, LAYER_WEIGHTS, scoreDomains } from './score.js';
import { evaluateOverrides } from './overrides.js';
import { bandForScore, moreRestrictive } from './tiers.js';
import { ScoringInput, type ScoringResult } from './types.js';

/** Cuántas acciones devuelve el plan de mejora. */
const ACTION_PLAN_SIZE = 3;

/**
 * Función pura del Score Engine: entra respuestas + señales, sale score/tier/decision/pricing.
 * Sin I/O, sin Date.now(), sin aleatoriedad — mismo input, mismo output, siempre.
 */
export function scoreAssessment(rawInput: ScoringInput): ScoringResult {
  const input = ScoringInput.parse(rawInput);

  const { domain_scores, deep_score } = scoreDomains(input.responses);
  const composite_score = compositeScore(input.pre_score, deep_score, input.confidence);
  const band = bandForScore(composite_score);

  // Las override rules solo pueden endurecer la decisión del tier, nunca ablandarla.
  const override_rules_triggered = evaluateOverrides(input.responses, input.firm);
  const decision = override_rules_triggered.reduce(
    (acc, rule) => moreRestrictive(acc, rule.decision),
    band.decision,
  );

  const pricing = calculatePricing(composite_score, input.firm, decision);
  const candidates = rankImprovements(
    input.responses,
    input.pre_score,
    input.confidence,
    ACTION_PLAN_SIZE,
  );

  return {
    pre_score: input.pre_score,
    deep_score,
    composite_score,
    layer_weights: LAYER_WEIGHTS[input.confidence],
    tier: band.tier,
    decision,
    domain_scores,
    override_rules_triggered,
    pricing,
    action_plan: buildActionPlan(candidates, composite_score),
    path_to_insurability:
      decision === 'AUTO_BIND' ? null : buildPathToInsurability(composite_score, candidates),
  };
}

export * from './types.js';
export {
  QUESTION_SCORING,
  DOMAIN_WEIGHTS,
  canonicalAnswer,
  type QuestionScoring,
} from './answer-scores.js';
export { LAYER_WEIGHTS, scoreDomains, scoreQuestion, compositeScore } from './score.js';
export { TIER_BANDS, bandForScore, tierForScore, decisionForScore, moreRestrictive } from './tiers.js';
export { OVERRIDE_RULES, evaluateOverrides, indexAnswers } from './overrides.js';
export {
  BASE_RATE,
  COVERAGE_OPTIONS,
  PRACTICE_MULTIPLIERS,
  calculatePricing,
  governanceFactor,
  jurisdictionFactor,
  practiceMultiplier,
  sizeFactor,
  basePremium,
} from './pricing.js';
export { IMPROVEMENT_ACTIONS, rankImprovements, buildActionPlan, bestAnswer } from './improvements.js';
export { buildPathToInsurability, nextBandUp, REASSESSMENT_DAYS } from './path-to-insurability.js';

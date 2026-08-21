import { bandForScore, TIER_BANDS } from './tiers.js';
import type { Candidate } from './improvements.js';
import type { PathToInsurability, RequiredImprovement } from './types.js';

/** Ventana antes de poder re-evaluar, para que las mejoras tengan tiempo de implementarse. */
export const REASSESSMENT_DAYS = 30;

/** Cuántas mejoras se listan como camino a la asegurabilidad. */
const MAX_IMPROVEMENTS = 3;

/** El objetivo es el piso de la banda inmediatamente superior a la actual. */
export function nextBandUp(score: number) {
  const current = bandForScore(score);
  const index = TIER_BANDS.findIndex((b) => b.tier === current.tier);
  return index > 0 ? TIER_BANDS[index - 1]! : current;
}

export function buildPathToInsurability(
  current_score: number,
  candidates: Candidate[],
): PathToInsurability | null {
  if (candidates.length === 0) return null;

  const target = nextBandUp(current_score);
  const selected = candidates.slice(0, MAX_IMPROVEMENTS);

  // Las mejoras son REQUIRED hasta que el score proyectado cruza el objetivo; el resto suma margen.
  let reachedTarget = false;
  const required_improvements: RequiredImprovement[] = selected.map((c) => {
    const priority = reachedTarget ? 'RECOMMENDED' : 'REQUIRED';
    if (c.composite_after >= target.min) reachedTarget = true;
    return {
      action: c.action,
      current_answer: c.current_answer,
      required_answer: c.required_answer,
      score_impact: c.score_impact,
      priority,
    };
  });

  const projected = selected[selected.length - 1]!.composite_after;
  const projectedTier = bandForScore(projected).tier;

  return {
    current_score,
    target_score: target.min,
    target_tier: target.tier,
    required_improvements,
    projected_score_after_improvements: projected,
    reassessment_available_in_days: REASSESSMENT_DAYS,
    message:
      `With these improvements, your estimated score would be ~${projected} (${projectedTier}), ` +
      `making you eligible for coverage. Once you have implemented the required measures, ` +
      `request a free re-assessment.`,
  };
}

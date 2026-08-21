import type { Decision, Tier } from './types.js';

/** Rango de score de cada tier, con el rango de governance_factor que le corresponde. */
export const TIER_BANDS = [
  { tier: 'FORTRESS', min: 85, max: 100, decision: 'AUTO_BIND', factor_min: 0.7, factor_max: 0.85 },
  { tier: 'FORTIFIED', min: 70, max: 84, decision: 'AUTO_BIND', factor_min: 0.9, factor_max: 1.0 },
  { tier: 'GUARDED', min: 50, max: 69, decision: 'REFERRAL', factor_min: 1.1, factor_max: 1.4 },
  { tier: 'EXPOSED', min: 30, max: 49, decision: 'REFERRAL_SENIOR', factor_min: 1.5, factor_max: 2.0 },
  { tier: 'CRITICAL', min: 0, max: 29, decision: 'DECLINE', factor_min: null, factor_max: null },
] as const satisfies ReadonlyArray<{
  tier: Tier;
  min: number;
  max: number;
  decision: Decision;
  factor_min: number | null;
  factor_max: number | null;
}>;

export type TierBand = (typeof TIER_BANDS)[number];

export function bandForScore(score: number): TierBand {
  // TIER_BANDS está ordenado de mayor a menor, así que el primer match es el correcto.
  return TIER_BANDS.find((b) => score >= b.min) ?? TIER_BANDS[TIER_BANDS.length - 1]!;
}

export function tierForScore(score: number): Tier {
  return bandForScore(score).tier;
}

export function decisionForScore(score: number): Decision {
  return bandForScore(score).decision;
}

/** Severidad creciente: se usa para que un override nunca ablande la decisión del tier. */
const DECISION_SEVERITY: Record<Decision, number> = {
  AUTO_BIND: 0,
  REFERRAL: 1,
  REFERRAL_SENIOR: 2,
  DECLINE: 3,
};

export function moreRestrictive(a: Decision, b: Decision): Decision {
  return DECISION_SEVERITY[a] >= DECISION_SEVERITY[b] ? a : b;
}

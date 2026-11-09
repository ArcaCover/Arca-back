import { Category, type PreScore } from '@arca/contracts';
import type { z } from 'zod';

export type RulePoints = { id: string; points: number | null; reason: string };
export function category(max: number, rules: RulePoints[]): z.infer<typeof Category> {
  const known = rules.filter((rule): rule is RulePoints & { points: number } => rule.points !== null);
  return { score: Math.max(0, Math.min(max, known.reduce((sum, rule) => sum + rule.points, 0))),
    max, status: known.length === 0 ? 'UNKNOWN' : known.length === rules.length ? 'KNOWN' : 'PARTIAL', rules };
}
export function observedBoolean(value: boolean | null, positive: number, negative = 0): number | null {
  return value === null ? null : value ? positive : negative;
}
/**
 * Averages are compared with band thresholds, so they must not carry floating-point noise:
 * 2.2, 9.1 and 9.7 average exactly 7, yet summed as 9.7 + 9.1 + 2.2 they gave 6.999999999999999
 * and fell into the band below. Adding in ascending order makes the sum independent of the input
 * order, and nine decimals is far finer than any real difference between two averages.
 */
export function mean(values: (number | null)[]): number | null {
  const known = values.filter((value): value is number => value !== null).sort((a, b) => a - b);
  if (!known.length) return null;
  return Math.round(known.reduce((sum, value) => sum + value, 0) / known.length * 1e9) / 1e9;
}
/** One decimal, for values shown to a reader. Rules keep reading the unrounded value. */
export function oneDecimal(value: number | null): number | null {
  return value === null ? null : Math.round(value * 10) / 10;
}
export function sum(values: (number | null)[]): number {
  const known = values.filter((value): value is number => value !== null);
  return known.reduce((sum, value) => sum + value, 0);
}
export function allKnownTrue(values: (boolean | null)[]): boolean | null {
  if (values.some(value => value === false)) return false;
  return values.length && values.every(value => value === true) ? true : null;
}
export function anyKnownTrue(values: (boolean | null)[]): boolean | null {
  if (values.some(value => value === true)) return true;
  return values.length && values.every(value => value === false) ? false : null;
}
export function tierForScore(score: number | null): PreScore['tier'] {
  if (score === null) return 'UNKNOWN';
  if (score >= 80) return 'FORTRESS';
  if (score >= 65) return 'FORTIFIED';
  if (score >= 45) return 'GUARDED';
  if (score >= 25) return 'EXPOSED';
  return 'CRITICAL';
}
export function decisionForTier(tier: PreScore['tier']): PreScore['decision'] {
  return ({ FORTRESS: 'AUTO_BIND', FORTIFIED: 'AUTO_BIND_CONDITIONAL', GUARDED: 'REFERRAL',
    EXPOSED: 'REFERRAL_SENIOR', CRITICAL: 'DECLINE', UNKNOWN: 'UNKNOWN' } as const)[tier];
}
export function restrictDecision(base: PreScore['decision'], restrictions: PreScore['overrides']): PreScore['decision'] {
  const rank = ['UNKNOWN', 'AUTO_BIND', 'AUTO_BIND_CONDITIONAL', 'REFERRAL', 'REFERRAL_SENIOR', 'DECLINE'];
  return restrictions.reduce((decision, override) => rank.indexOf(override.decision) > rank.indexOf(decision) ? override.decision : decision, base);
}

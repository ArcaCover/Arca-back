import { bandForScore } from './tiers.js';
import type { Decision, PracticeArea, Pricing, PricingOption, ScoringFirm } from './types.js';

/** Prima base por abogado por año. Único parámetro comercial ajustable de la fórmula. */
export const BASE_RATE = 420;

/** Cuando el scan no logra contar abogados asumimos solo practitioner, el caso más común. */
export const DEFAULT_ATTORNEYS = 1;

export const PRACTICE_MULTIPLIERS: Record<PracticeArea, number> = {
  criminal_defense: 2.0,
  immigration: 1.8,
  personal_injury: 1.6,
  family_law: 1.3,
  commercial_litigation: 1.2,
  employment_law: 1.15,
  corporate_ma: 1.0,
  real_estate: 0.85,
  tax_regulatory: 0.75,
};

const JURISDICTION_BANDS: Array<{ states: string[]; factor: number }> = [
  { states: ['FL', 'CA', 'TX', 'NY'], factor: 1.25 },
  { states: ['IL', 'GA', 'PA', 'NJ'], factor: 1.15 },
  { states: ['WY', 'VT', 'ND', 'SD', 'MT'], factor: 0.85 },
];

const SIZE_BANDS: Array<{ max: number; factor: number }> = [
  { max: 1, factor: 0.9 },
  { max: 5, factor: 1.0 },
  { max: 15, factor: 1.1 },
  { max: 30, factor: 1.2 },
  { max: 50, factor: 1.3 },
];

export const COVERAGE_OPTIONS = [
  { name: 'Essential', limit_per_claim: 50_000, limit_aggregate: 100_000, price_factor: 0.6 },
  { name: 'Professional', limit_per_claim: 250_000, limit_aggregate: 500_000, price_factor: 1.0 },
  { name: 'Complete', limit_per_claim: 1_000_000, limit_aggregate: 2_000_000, price_factor: 1.85 },
] as const;

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Interpola el factor dentro del tier: a mayor score dentro de la banda, menor factor.
 * governance_factor = min + (max - min) × (1 - posición_en_la_banda)
 */
export function governanceFactor(score: number): number | null {
  const band = bandForScore(score);
  if (band.factor_min === null || band.factor_max === null) return null; // CRITICAL: no se cotiza
  const span = band.max - band.min;
  const position = span === 0 ? 0 : (score - band.min) / span;
  return round3(band.factor_min + (band.factor_max - band.factor_min) * (1 - position));
}

/** Si la firma practica varias áreas, manda la más riesgosa. */
export function practiceMultiplier(firm: ScoringFirm): number {
  const areas: PracticeArea[] = [
    ...(firm.primary_practice ? [firm.primary_practice] : []),
    ...firm.practice_areas,
  ];
  if (areas.length === 0) return PRACTICE_MULTIPLIERS.corporate_ma; // baseline del handbook
  return Math.max(...areas.map((a) => PRACTICE_MULTIPLIERS[a]));
}

export function jurisdictionFactor(state: string | null): number {
  if (!state) return 1.0;
  const upper = state.toUpperCase();
  return JURISDICTION_BANDS.find((b) => b.states.includes(upper))?.factor ?? 1.0;
}

/** null para 51+ abogados: el handbook los manda a cotización custom. */
export function sizeFactor(attorneys: number): number | null {
  return SIZE_BANDS.find((b) => attorneys <= b.max)?.factor ?? null;
}

/** Prima anual base (opción Professional, factor 1.00) antes de aplicar límites de cobertura. */
export function basePremium(factors: {
  attorneys: number;
  governance_factor: number;
  practice_multiplier: number;
  jurisdiction_factor: number;
  size_factor: number;
}): number {
  return (
    BASE_RATE *
    factors.attorneys *
    factors.governance_factor *
    factors.practice_multiplier *
    factors.jurisdiction_factor *
    factors.size_factor
  );
}

export function calculatePricing(
  composite_score: number,
  firm: ScoringFirm,
  decision: Decision,
): Pricing | null {
  const governance_factor = governanceFactor(composite_score);
  if (governance_factor === null || decision === 'DECLINE') return null;

  const attorneys = firm.attorneys_count ?? DEFAULT_ATTORNEYS;
  const size_factor = sizeFactor(attorneys);
  const factors = {
    base_rate: BASE_RATE,
    attorneys,
    governance_factor,
    practice_multiplier: practiceMultiplier(firm),
    jurisdiction_factor: jurisdictionFactor(firm.state),
    size_factor,
  };

  if (size_factor === null) {
    return {
      factors,
      options: [],
      requires_custom_quote: true,
      unavailable_reason: 'Firms with 51 or more attorneys require a custom quote',
    };
  }

  const base = basePremium({ ...factors, size_factor });
  const options: PricingOption[] = COVERAGE_OPTIONS.map((opt) => {
    const annual_premium = Math.round(base * opt.price_factor);
    return {
      name: opt.name,
      limit_per_claim: opt.limit_per_claim,
      limit_aggregate: opt.limit_aggregate,
      annual_premium,
      monthly_premium: Math.round(annual_premium / 12),
    };
  });

  return { factors, options, requires_custom_quote: false, unavailable_reason: null };
}

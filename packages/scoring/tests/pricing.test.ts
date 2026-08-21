import { describe, expect, it } from 'vitest';
import {
  BASE_RATE,
  calculatePricing,
  governanceFactor,
  jurisdictionFactor,
  practiceMultiplier,
  scoreAssessment,
  sizeFactor,
} from '@arca/scoring';
import {
  bigFirm,
  criminalDefenseFirm,
  minimalResponses,
  perfectResponses,
  soloTaxFirm,
  unknownFirm,
} from './fixtures/responses.js';

describe('governance_factor: interpolación dentro de cada tier', () => {
  /** [score, factor esperado] — los extremos de cada banda más un punto intermedio. */
  const CASES: Array<[number, number]> = [
    [85, 0.85], [100, 0.7], [92, 0.78],
    [70, 1.0], [84, 0.9], [75, 0.964],
    [50, 1.4], [69, 1.1], [57, 1.289],
    [30, 2.0], [49, 1.5], [32, 1.947],
  ];

  it.each(CASES)('score %i produce factor %f', (score, expected) => {
    expect(governanceFactor(score)).toBe(expected);
  });

  it('el factor baja de forma monótona a medida que sube el score', () => {
    for (let score = 30; score < 100; score++) {
      const here = governanceFactor(score)!;
      const next = governanceFactor(score + 1)!;
      // Entre bandas hay un salto hacia abajo; dentro de la banda la caída es gradual.
      expect(next).toBeLessThanOrEqual(here);
    }
  });

  it('CRITICAL no tiene factor: la firma no se cotiza', () => {
    expect(governanceFactor(29)).toBeNull();
    expect(governanceFactor(0)).toBeNull();
  });
});

describe('factores de prima', () => {
  it('usa el multiplier más alto cuando la firma practica varias áreas', () => {
    expect(practiceMultiplier(criminalDefenseFirm)).toBe(2.0);
    expect(practiceMultiplier(soloTaxFirm)).toBe(0.75);
  });

  it('cae al baseline corporate_ma si no conocemos el área de práctica', () => {
    expect(practiceMultiplier(unknownFirm)).toBe(1.0);
  });

  it('mapea los estados a su banda de litigiosidad', () => {
    expect(jurisdictionFactor('FL')).toBe(1.25);
    expect(jurisdictionFactor('nj')).toBe(1.15);
    expect(jurisdictionFactor('OH')).toBe(1.0);
    expect(jurisdictionFactor('WY')).toBe(0.85);
    expect(jurisdictionFactor(null)).toBe(1.0);
  });

  it('mapea el tamaño de la firma a su factor', () => {
    expect(sizeFactor(1)).toBe(0.9);
    expect(sizeFactor(5)).toBe(1.0);
    expect(sizeFactor(15)).toBe(1.1);
    expect(sizeFactor(30)).toBe(1.2);
    expect(sizeFactor(50)).toBe(1.3);
    expect(sizeFactor(51)).toBeNull();
  });
});

describe('opciones de cobertura', () => {
  const pricing = calculatePricing(100, criminalDefenseFirm, 'AUTO_BIND')!;

  it('calcula la prima base con todos los factores del handbook', () => {
    expect(pricing.factors).toEqual({
      base_rate: BASE_RATE,
      attorneys: 10,
      governance_factor: 0.7,
      practice_multiplier: 2.0,
      jurisdiction_factor: 1.25,
      size_factor: 1.1,
    });
    // 420 × 10 × 0.70 × 2.00 × 1.25 × 1.10 = 8085
    expect(pricing.options[1]?.annual_premium).toBe(8085);
  });

  it('deriva las 3 opciones de la prima base con sus factores y límites', () => {
    expect(pricing.options.map((o) => o.name)).toEqual(['Essential', 'Professional', 'Complete']);
    expect(pricing.options[0]).toMatchObject({
      limit_per_claim: 50_000,
      limit_aggregate: 100_000,
      annual_premium: Math.round(8085 * 0.6),
    });
    expect(pricing.options[2]).toMatchObject({
      limit_per_claim: 1_000_000,
      limit_aggregate: 2_000_000,
      annual_premium: Math.round(8085 * 1.85),
    });
  });

  it('la prima mensual es la anual dividida en 12', () => {
    for (const option of pricing.options) {
      expect(option.monthly_premium).toBe(Math.round(option.annual_premium / 12));
    }
  });
});

describe('casos sin cotización automática', () => {
  it('DECLINE no devuelve pricing', () => {
    const result = scoreAssessment({
      pre_score: 10,
      confidence: 'LOW',
      responses: minimalResponses,
      firm: soloTaxFirm,
    });
    expect(result.decision).toBe('DECLINE');
    expect(result.pricing).toBeNull();
  });

  it('una firma de 51+ abogados queda marcada para cotización custom', () => {
    const pricing = calculatePricing(90, bigFirm, 'AUTO_BIND')!;
    expect(pricing.requires_custom_quote).toBe(true);
    expect(pricing.options).toEqual([]);
    expect(pricing.factors.size_factor).toBeNull();
  });

  it('sin conteo de abogados asume solo practitioner', () => {
    const pricing = calculatePricing(90, unknownFirm, 'AUTO_BIND')!;
    expect(pricing.factors.attorneys).toBe(1);
    expect(pricing.factors.size_factor).toBe(0.9);
  });
});

describe('el pricing responde al score', () => {
  it('mejor score produce prima más baja para la misma firma', () => {
    const good = calculatePricing(90, criminalDefenseFirm, 'AUTO_BIND')!;
    const worse = calculatePricing(60, criminalDefenseFirm, 'REFERRAL')!;
    expect(good.options[1]!.annual_premium).toBeLessThan(worse.options[1]!.annual_premium);
  });

  it('la firma perfecta obtiene el factor mínimo posible', () => {
    const result = scoreAssessment({
      pre_score: 100,
      confidence: 'HIGH',
      responses: perfectResponses,
      firm: criminalDefenseFirm,
    });
    expect(result.pricing?.factors.governance_factor).toBe(0.7);
  });
});

import { describe, expect, it } from 'vitest';
import {
  LAYER_WEIGHTS,
  compositeScore,
  scoreAssessment,
  scoreDomains,
  scoreQuestion,
  tierForScore,
  decisionForScore,
  QUESTION_SCORING,
} from '@arca/scoring';
import type { ScoringInput } from '@arca/scoring';
import {
  corporateFirm,
  criminalDefenseFirm,
  handbookExampleResponses,
  minimalResponses,
  moderateResponses,
  perfectResponses,
  soloTaxFirm,
  strongResponses,
  weakResponses,
} from './fixtures/responses.js';

/** Los 5 escenarios que anclan cada tier, con el input exacto que los produce. */
const TIER_CASES: Array<{ name: string; input: ScoringInput; composite: number; tier: string; decision: string }> = [
  {
    name: 'FORTRESS',
    input: { pre_score: 100, confidence: 'HIGH', responses: perfectResponses, firm: criminalDefenseFirm },
    composite: 100,
    tier: 'FORTRESS',
    decision: 'AUTO_BIND',
  },
  {
    name: 'FORTIFIED',
    input: { pre_score: 68, confidence: 'HIGH', responses: strongResponses, firm: criminalDefenseFirm },
    composite: 73,
    tier: 'FORTIFIED',
    decision: 'AUTO_BIND',
  },
  {
    name: 'GUARDED',
    input: { pre_score: 55, confidence: 'MEDIUM', responses: moderateResponses, firm: corporateFirm },
    composite: 57,
    tier: 'GUARDED',
    decision: 'REFERRAL',
  },
  {
    name: 'EXPOSED',
    input: { pre_score: 30, confidence: 'MEDIUM', responses: weakResponses, firm: corporateFirm },
    composite: 32,
    tier: 'EXPOSED',
    decision: 'REFERRAL_SENIOR',
  },
  {
    name: 'CRITICAL',
    input: { pre_score: 10, confidence: 'LOW', responses: minimalResponses, firm: soloTaxFirm },
    composite: 3,
    tier: 'CRITICAL',
    decision: 'DECLINE',
  },
];

describe('tiers y decisions', () => {
  it.each(TIER_CASES)('$name asigna tier y decision', ({ input, composite, tier, decision }) => {
    const result = scoreAssessment(input);
    expect(result.composite_score).toBe(composite);
    expect(result.tier).toBe(tier);
    expect(result.decision).toBe(decision);
  });

  it('respeta los límites exactos de cada banda', () => {
    const boundaries: Array<[number, string, string]> = [
      [100, 'FORTRESS', 'AUTO_BIND'],
      [85, 'FORTRESS', 'AUTO_BIND'],
      [84, 'FORTIFIED', 'AUTO_BIND'],
      [70, 'FORTIFIED', 'AUTO_BIND'],
      [69, 'GUARDED', 'REFERRAL'],
      [50, 'GUARDED', 'REFERRAL'],
      [49, 'EXPOSED', 'REFERRAL_SENIOR'],
      [30, 'EXPOSED', 'REFERRAL_SENIOR'],
      [29, 'CRITICAL', 'DECLINE'],
      [0, 'CRITICAL', 'DECLINE'],
    ];
    for (const [score, tier, decision] of boundaries) {
      expect(tierForScore(score)).toBe(tier);
      expect(decisionForScore(score)).toBe(decision);
    }
  });
});

describe('score por dominio', () => {
  it('todas las mejores respuestas dan 100 en cada dominio', () => {
    const { domain_scores, deep_score } = scoreDomains(perfectResponses);
    expect(deep_score).toBe(100);
    for (const domain of Object.values(domain_scores)) expect(domain.score).toBe(100);
  });

  it('excluye del denominador las preguntas que no se respondieron', () => {
    // weakResponses no incluye Q1.2, así que governance vale 18 puntos y no 30.
    const { domain_scores } = scoreDomains(weakResponses);
    expect(domain_scores.governance?.points_possible).toBe(18);
  });

  it('marca no aplicable la pregunta Q2.1 cuando la firma no usa IA', () => {
    const points = scoreQuestion(QUESTION_SCORING['Q2.1']!, 'none');
    expect(points.applicable).toBe(false);
    expect(points.possible).toBe(0);
  });

  it('Q1.2 acumula 2 puntos por aspecto y topea en 12', () => {
    const q = QUESTION_SCORING['Q1.2']!;
    expect(scoreQuestion(q, ['approved_tools', 'data_rules']).earned).toBe(4);
    expect(
      scoreQuestion(q, [
        'approved_tools',
        'data_rules',
        'review_process',
        'client_disclosure',
        'training',
        'incidents',
      ]).earned,
    ).toBe(12);
  });

  it('Q6.1 descuenta desde 10 por cada incidente y nunca baja de 0', () => {
    const q = QUESTION_SCORING['Q6.1']!;
    expect(scoreQuestion(q, ['none']).earned).toBe(10);
    expect(scoreQuestion(q, ['citation_error']).earned).toBe(7);
    expect(scoreQuestion(q, ['data_exposure', 'client_complaint', 'doc_error']).earned).toBe(0);
  });

  it('el status del dominio sigue los umbrales good/warning/critical', () => {
    const { domain_scores } = scoreDomains(moderateResponses);
    for (const domain of Object.values(domain_scores)) {
      const expected =
        domain.score >= 70 ? 'good' : domain.score >= 50 ? 'warning' : 'critical';
      expect(domain.status).toBe(expected);
    }
  });
});

describe('composite score', () => {
  it('aplica los pesos de capa según la confianza', () => {
    expect(LAYER_WEIGHTS.HIGH).toEqual({ layer1: 0.25, layer2: 0.75 });
    expect(LAYER_WEIGHTS.MEDIUM).toEqual({ layer1: 0.2, layer2: 0.8 });
    expect(LAYER_WEIGHTS.LOW).toEqual({ layer1: 0.1, layer2: 0.9 });
    expect(compositeScore(60, 80, 'HIGH')).toBe(75);
    expect(compositeScore(60, 80, 'MEDIUM')).toBe(76);
    expect(compositeScore(60, 80, 'LOW')).toBe(78);
  });

  it('una confianza baja hace que el pre_score casi no mueva el resultado', () => {
    const base = { responses: strongResponses, firm: criminalDefenseFirm } as const;
    const low = scoreAssessment({ ...base, pre_score: 0, confidence: 'LOW' });
    const high = scoreAssessment({ ...base, pre_score: 0, confidence: 'HIGH' });
    expect(low.composite_score).toBeGreaterThan(high.composite_score);
  });
});

describe('compatibilidad de ids de respuesta', () => {
  it('acepta los ids abreviados del ejemplo del handbook', () => {
    const result = scoreAssessment({
      pre_score: 68,
      confidence: 'HIGH',
      responses: handbookExampleResponses,
      firm: criminalDefenseFirm,
    });
    // Q2.2 "commercial" → commercial_accounts (5/10) y Q4.1 "guidelines_only" → guidelines (6/10).
    expect(result.domain_scores.tools?.points_earned).toBe(9);
    expect(result.domain_scores.data_protection?.points_earned).toBe(6);
  });

  it('ignora question_ids desconocidos en vez de romper', () => {
    const result = scoreAssessment({
      pre_score: 50,
      confidence: 'MEDIUM',
      responses: [...perfectResponses, { question_id: 'Q9.9', answer: 'whatever' }],
      firm: corporateFirm,
    });
    expect(result.deep_score).toBe(100);
  });
});

describe('serializabilidad', () => {
  it('el resultado sobrevive un round-trip JSON sin perder nada', () => {
    const result = scoreAssessment(TIER_CASES[1]!.input);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });
});

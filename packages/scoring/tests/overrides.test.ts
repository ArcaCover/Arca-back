import { describe, expect, it } from 'vitest';
import { evaluateOverrides, moreRestrictive, scoreAssessment } from '@arca/scoring';
import {
  corporateFirm,
  criminalDefenseFirm,
  noReviewProcessResponses,
  perfectResponses,
  realDataInPublicToolResponses,
  regulatoryInvestigationResponses,
} from './fixtures/responses.js';

describe('OR-001 · datos reales en herramienta pública', () => {
  it('degrada a REFERRAL una firma que de otro modo sería FORTRESS', () => {
    const result = scoreAssessment({
      pre_score: 100,
      confidence: 'HIGH',
      responses: realDataInPublicToolResponses,
      firm: corporateFirm,
    });
    expect(result.override_rules_triggered.map((r) => r.id)).toContain(
      'OR-001_real_data_in_public_tool',
    );
    expect(result.decision).toBe('REFERRAL');
  });

  it('no dispara si los datos están anonimizados', () => {
    const triggered = evaluateOverrides(perfectResponses, corporateFirm);
    expect(triggered).toEqual([]);
  });
});

describe('OR-002 · investigación regulatoria activa', () => {
  it('fuerza DECLINE aunque el resto del assessment sea perfecto', () => {
    const result = scoreAssessment({
      pre_score: 100,
      confidence: 'HIGH',
      responses: regulatoryInvestigationResponses,
      firm: corporateFirm,
    });
    expect(result.tier).toBe('FORTRESS');
    expect(result.decision).toBe('DECLINE');
    expect(result.pricing).toBeNull();
  });
});

describe('OR-003 · sin revisión en criminal defense', () => {
  it('dispara cuando la práctica principal es criminal defense', () => {
    const result = scoreAssessment({
      pre_score: 90,
      confidence: 'HIGH',
      responses: noReviewProcessResponses,
      firm: criminalDefenseFirm,
    });
    expect(result.override_rules_triggered.map((r) => r.id)).toContain(
      'OR-003_no_review_criminal_defense',
    );
    expect(result.decision).toBe('REFERRAL');
  });

  it('no dispara para la misma respuesta en una firma corporativa', () => {
    const result = scoreAssessment({
      pre_score: 90,
      confidence: 'HIGH',
      responses: noReviewProcessResponses,
      firm: corporateFirm,
    });
    expect(result.override_rules_triggered).toEqual([]);
    expect(result.decision).toBe('AUTO_BIND');
  });
});

describe('resolución entre reglas', () => {
  it('gana siempre la decisión más restrictiva', () => {
    expect(moreRestrictive('AUTO_BIND', 'REFERRAL')).toBe('REFERRAL');
    expect(moreRestrictive('DECLINE', 'REFERRAL')).toBe('DECLINE');
    expect(moreRestrictive('REFERRAL', 'REFERRAL_SENIOR')).toBe('REFERRAL_SENIOR');
  });

  it('un override nunca ablanda la decisión que dictó el tier', () => {
    // Score bajísimo (DECLINE por tier) más OR-003, que solo pide REFERRAL: se mantiene DECLINE.
    const result = scoreAssessment({
      pre_score: 0,
      confidence: 'LOW',
      responses: [{ question_id: 'Q3.1', answer: 'no_process' }],
      firm: criminalDefenseFirm,
    });
    expect(result.tier).toBe('CRITICAL');
    expect(result.override_rules_triggered).toHaveLength(1);
    expect(result.decision).toBe('DECLINE');
  });
});

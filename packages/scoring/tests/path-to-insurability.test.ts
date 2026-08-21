import { describe, expect, it } from 'vitest';
import { REASSESSMENT_DAYS, nextBandUp, scoreAssessment } from '@arca/scoring';
import {
  corporateFirm,
  criminalDefenseFirm,
  moderateResponses,
  perfectResponses,
  soloTaxFirm,
  strongResponses,
  weakResponses,
} from './fixtures/responses.js';

describe('path_to_insurability', () => {
  const result = scoreAssessment({
    pre_score: 30,
    confidence: 'MEDIUM',
    responses: weakResponses,
    firm: corporateFirm,
  });

  it('solo aparece cuando la decisión no es AUTO_BIND', () => {
    expect(result.decision).toBe('REFERRAL_SENIOR');
    expect(result.path_to_insurability).not.toBeNull();

    const bindable = scoreAssessment({
      pre_score: 100,
      confidence: 'HIGH',
      responses: perfectResponses,
      firm: corporateFirm,
    });
    expect(bindable.decision).toBe('AUTO_BIND');
    expect(bindable.path_to_insurability).toBeNull();
  });

  it('apunta al piso de la banda inmediatamente superior', () => {
    // EXPOSED (30-49) apunta a GUARDED, cuyo piso es 50.
    expect(result.path_to_insurability?.current_score).toBe(32);
    expect(result.path_to_insurability?.target_score).toBe(50);
    expect(result.path_to_insurability?.target_tier).toBe('GUARDED');
    expect(nextBandUp(20).tier).toBe('EXPOSED');
    expect(nextBandUp(57).tier).toBe('FORTIFIED');
  });

  it('marca REQUIRED las mejoras necesarias para cruzar el objetivo', () => {
    const improvements = result.path_to_insurability!.required_improvements;
    expect(improvements.length).toBeGreaterThan(0);
    expect(improvements[0]?.priority).toBe('REQUIRED');

    // Todo lo que viene después de alcanzar el target es RECOMMENDED.
    const crossing = improvements.findIndex((_, i) =>
      result.action_plan[i]!.projected_score >= 50,
    );
    if (crossing >= 0 && crossing + 1 < improvements.length) {
      expect(improvements[crossing + 1]?.priority).toBe('RECOMMENDED');
    }
  });

  it('proyecta el score que se alcanzaría y ofrece re-evaluación', () => {
    const path = result.path_to_insurability!;
    expect(path.projected_score_after_improvements).toBeGreaterThan(path.current_score);
    expect(path.reassessment_available_in_days).toBe(REASSESSMENT_DAYS);
    expect(path.message).toContain(String(path.projected_score_after_improvements));
  });

  it('cita la respuesta actual y la requerida de cada mejora', () => {
    for (const improvement of result.path_to_insurability!.required_improvements) {
      expect(improvement.current_answer).toMatch(/^Q\d\.\d = /);
      expect(improvement.required_answer).toMatch(/^Q\d\.\d = /);
      expect(improvement.score_impact).toBeGreaterThan(0);
    }
  });

  it('una firma sin nada que mejorar no recibe path', () => {
    // Perfecta en el assessment pero declinada por override: no hay mejora posible que listar.
    const perfect = scoreAssessment({
      pre_score: 100,
      confidence: 'HIGH',
      responses: perfectResponses,
      firm: soloTaxFirm,
    });
    expect(perfect.action_plan).toEqual([]);
    expect(perfect.path_to_insurability).toBeNull();
  });
});

describe('action_plan', () => {
  const result = scoreAssessment({
    pre_score: 68,
    confidence: 'HIGH',
    responses: strongResponses,
    firm: criminalDefenseFirm,
  });

  it('lista hasta 3 acciones ordenadas por impacto decreciente', () => {
    expect(result.action_plan.length).toBeLessThanOrEqual(3);
    const impacts = result.action_plan.map((a) => a.score_impact);
    expect([...impacts].sort((a, b) => b - a)).toEqual(impacts);
  });

  it('proyecta el score de forma acumulativa', () => {
    let running = result.composite_score;
    for (const item of result.action_plan) {
      running += item.score_impact;
      expect(item.projected_score).toBe(running);
    }
  });

  it('cada mejora reduce la prima', () => {
    for (const item of result.action_plan) {
      expect(item.premium_impact_percent).toBeLessThan(0);
    }
  });

  it('no propone mejoras para respuestas que ya son óptimas', () => {
    const moderate = scoreAssessment({
      pre_score: 55,
      confidence: 'MEDIUM',
      responses: moderateResponses,
      firm: corporateFirm,
    });
    const proposed = moderate.action_plan.map((a) => a.domain);
    expect(new Set(proposed).size).toBeGreaterThan(0);
    expect(moderate.action_plan.every((a) => a.score_impact > 0)).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { QUESTION_SCORING } from '@arca/scoring';
import {
  QUESTION_BANK,
  QUESTIONS_BY_ID,
  followUpQuestions,
  selectQuestions,
} from '@arca/questions';
import {
  firmWithAiPolicy,
  firmWithHighPreScore,
  firmWithLegalPlatform,
  firmWithLowPreScore,
  firmWithoutAiPolicy,
  firmWithoutWebsite,
  layer1Result,
} from './fixtures/layer1.js';

const idsOf = (result: ReturnType<typeof selectQuestions>) => result.questions.map((q) => q.id);

describe('dominio 1 · gobernanza', () => {
  it('con AI policy detectada salta Q1.1 y pregunta por el alcance', () => {
    const set = selectQuestions(firmWithAiPolicy);
    expect(idsOf(set)).toContain('Q1.2');
    expect(idsOf(set)).not.toContain('Q1.1');

    const q12 = set.questions.find((q) => q.id === 'Q1.2')!;
    expect(q12.skipped_question).toBe('Q1.1');
    expect(q12.skip_reason).toContain('/ai-governance');
    expect(q12.context).toBeTruthy();
  });

  it('sin policy pregunta Q1.1 y deja Q1.2 para el follow-up', () => {
    const set = selectQuestions(firmWithoutAiPolicy);
    expect(idsOf(set)).toContain('Q1.1');
    expect(idsOf(set)).not.toContain('Q1.2');
    expect(set.questions.find((q) => q.id === 'Q1.1')?.skipped_question).toBeNull();
  });

  it('Q1.3 se pregunta siempre', () => {
    for (const scan of [firmWithAiPolicy, firmWithoutAiPolicy, firmWithoutWebsite]) {
      expect(idsOf(selectQuestions(scan))).toContain('Q1.3');
    }
  });

  it('el follow-up agrega Q1.2 solo si la firma declara tener policy', () => {
    expect(followUpQuestions('formal_documented').map((q) => q.id)).toEqual(['Q1.2']);
    expect(followUpQuestions('informal').map((q) => q.id)).toEqual(['Q1.2']);
    expect(followUpQuestions('no_policy')).toEqual([]);
    expect(followUpQuestions('in_development')).toEqual([]);
  });
});

describe('dominio 2 · herramientas', () => {
  it('con plataforma legal detectada salta Q2.1 y nombra la plataforma', () => {
    const set = selectQuestions(firmWithLegalPlatform);
    expect(idsOf(set)).not.toContain('Q2.1');
    expect(idsOf(set)).toContain('Q2.2');

    const q22 = set.questions.find((q) => q.id === 'Q2.2')!;
    expect(q22.skipped_question).toBe('Q2.1');
    expect(q22.skip_reason).toBe('Clio detected in tech stack');
    expect(q22.context).toContain('Clio');
  });

  it('sin plataforma detectada pregunta Q2.1 y Q2.2', () => {
    const set = selectQuestions(firmWithoutAiPolicy);
    expect(idsOf(set)).toContain('Q2.1');
    expect(idsOf(set)).toContain('Q2.2');
  });

  it('Q2.3 es crítica de suscripción y se pregunta siempre', () => {
    for (const scan of [firmWithLegalPlatform, firmWithoutAiPolicy, firmWithoutWebsite]) {
      expect(idsOf(selectQuestions(scan))).toContain('Q2.3');
    }
  });
});

describe('dominio 3 · supervisión y umbral de pre-score', () => {
  it('pre_score < 50 agrega la pregunta de disclosure', () => {
    expect(idsOf(selectQuestions(firmWithLowPreScore))).toContain('Q3.3');
  });

  it('pre_score >= 50 no la agrega', () => {
    expect(idsOf(selectQuestions(layer1Result({ pre_score: 50 })))).not.toContain('Q3.3');
    expect(idsOf(selectQuestions(layer1Result({ pre_score: 49 })))).toContain('Q3.3');
  });

  it('Q3.1 y Q3.2 se preguntan siempre', () => {
    const set = selectQuestions(firmWithHighPreScore);
    expect(idsOf(set)).toEqual(expect.arrayContaining(['Q3.1', 'Q3.2']));
  });
});

describe('dominio 4 · datos en la nube', () => {
  it('agrega Q4.2 solo si se detectaron herramientas cloud', () => {
    expect(idsOf(selectQuestions(firmWithLegalPlatform))).toContain('Q4.2');
    expect(idsOf(selectQuestions(firmWithoutAiPolicy))).not.toContain('Q4.2');
  });
});

describe('dominio 5 · profundidad según el pre-score', () => {
  it('pre_score > 70 agrega la evaluación de competencia', () => {
    expect(idsOf(selectQuestions(firmWithHighPreScore))).toContain('Q5.2');
  });

  it('pre_score <= 70 no la agrega', () => {
    expect(idsOf(selectQuestions(layer1Result({ pre_score: 70 })))).not.toContain('Q5.2');
    expect(idsOf(selectQuestions(layer1Result({ pre_score: 71 })))).toContain('Q5.2');
  });
});

describe('forma del set devuelto', () => {
  const scenarios = [
    firmWithAiPolicy,
    firmWithoutAiPolicy,
    firmWithLegalPlatform,
    firmWithLowPreScore,
    firmWithHighPreScore,
    firmWithoutWebsite,
  ];

  it('siempre incluye las preguntas obligatorias de incidentes', () => {
    for (const scan of scenarios) {
      expect(idsOf(selectQuestions(scan))).toEqual(expect.arrayContaining(['Q6.1', 'Q6.2']));
    }
  });

  it('mantiene el rango de 8 a 12 preguntas en los escenarios reales', () => {
    for (const scan of scenarios) {
      const set = selectQuestions(scan);
      expect(set.total_questions).toBeGreaterThanOrEqual(8);
      expect(set.total_questions).toBeLessThanOrEqual(12);
      expect(set.questions).toHaveLength(set.total_questions);
    }
  });

  it('numera las preguntas de forma correlativa desde 1', () => {
    const set = selectQuestions(firmWithLegalPlatform);
    expect(set.questions.map((q) => q.order)).toEqual(
      set.questions.map((_, index) => index + 1),
    );
  });

  it('estima los minutos a partir de la cantidad de preguntas', () => {
    const set = selectQuestions(firmWithAiPolicy);
    expect(set.estimated_minutes).toBe(Math.round(set.total_questions * 0.4));
  });

  it('nunca repite una pregunta', () => {
    for (const scan of scenarios) {
      const ids = idsOf(selectQuestions(scan));
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});

describe('consistencia entre el banco y la tabla de puntaje', () => {
  it('cada pregunta del banco tiene su entrada de scoring', () => {
    for (const question of QUESTION_BANK) {
      expect(QUESTION_SCORING[question.id], `falta scoring para ${question.id}`).toBeDefined();
    }
  });

  it('cada opción tiene puntaje definido o es un alias conocido', () => {
    for (const question of QUESTION_BANK) {
      const scoring = QUESTION_SCORING[question.id]!;
      for (const option of question.options) {
        const known =
          scoring.scoring.kind === 'single'
            ? option.id in scoring.scoring.points
            : scoring.scoring.kind === 'accumulate'
              ? scoring.scoring.valid_options.includes(option.id)
              : option.id in scoring.scoring.penalties;
        const excluded = scoring.not_applicable_answers?.includes(option.id) ?? false;
        expect(known || excluded, `${question.id} → ${option.id} sin puntaje`).toBe(true);
      }
    }
  });

  it('todas las preguntas del banco son alcanzables desde alguna combinación de señales', () => {
    const reachable = new Set<string>();
    for (const scan of [
      firmWithAiPolicy,
      firmWithoutAiPolicy,
      firmWithLegalPlatform,
      firmWithLowPreScore,
      firmWithHighPreScore,
    ]) {
      for (const id of idsOf(selectQuestions(scan))) reachable.add(id);
    }
    // Q1.2 aparece por señal o por follow-up; el resto tiene que salir de la selección directa.
    for (const question of QUESTION_BANK) {
      expect(reachable.has(question.id), `${question.id} inalcanzable`).toBe(true);
    }
    expect(QUESTIONS_BY_ID['Q1.2']).toBeDefined();
  });
});

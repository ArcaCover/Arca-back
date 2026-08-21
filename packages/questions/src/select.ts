import type { Layer1Result, LegalPlatform } from '@arca/contracts';
import { QUESTIONS_BY_ID } from './question-bank.js';
import type { QuestionSet, SelectedQuestion } from './types.js';

/** Debajo de este pre-score preguntamos también por disclosure a clientes. */
export const LOW_SCORE_THRESHOLD = 50;
/** Encima de este pre-score profundizamos en evaluación de competencia. */
export const HIGH_SCORE_THRESHOLD = 70;

/** Minutos estimados por pregunta: 10 preguntas ≈ 4 minutos, como muestra el handbook. */
const MINUTES_PER_QUESTION = 0.4;

const PLATFORM_LABELS: Record<LegalPlatform, string> = {
  clio: 'Clio',
  practicepanther: 'PracticePanther',
  mycase: 'MyCase',
};

type Pick = {
  id: string;
  context?: string;
  skipped_question?: string;
  skip_reason?: string;
};

/**
 * Árbol de reglas de la sección "Lógica de selección de preguntas". Función pura: entra el
 * resultado de Capa 1, sale la lista ordenada. No toca red, DB ni reloj.
 */
export function selectQuestions(layer1: Layer1Result): QuestionSet {
  const { observations, pre_score } = layer1;
  const picks: Pick[] = [];

  // Dominio 1 — Gobernanza
  if (observations.ai_policy_found) {
    // Ya sabemos que la policy existe; lo que falta averiguar es qué tan completa es.
    picks.push({
      id: 'Q1.2',
      context:
        'We detected that your firm has an AI policy published on its website. We want to know how complete it is.',
      skipped_question: 'Q1.1',
      skip_reason: observations.ai_policy_url
        ? `AI policy detected during scan at ${observations.ai_policy_url}`
        : 'AI policy detected on website during scan',
    });
  } else {
    // Q1.2 solo aplica si la firma declara tener policy: se emite dinámicamente tras responder Q1.1.
    picks.push({ id: 'Q1.1' });
  }
  picks.push({ id: 'Q1.3' });

  // Dominio 2 — Herramientas
  if (observations.legal_platform) {
    const platform = PLATFORM_LABELS[observations.legal_platform];
    picks.push({
      id: 'Q2.2',
      context: `We detected that your firm uses ${platform}, which includes built-in AI features.`,
      skipped_question: 'Q2.1',
      skip_reason: `${platform} detected in tech stack`,
    });
  } else {
    picks.push({ id: 'Q2.1' });
    picks.push({ id: 'Q2.2' });
  }
  picks.push({ id: 'Q2.3' });

  // Dominio 3 — Supervisión
  picks.push({ id: 'Q3.1' });
  picks.push({ id: 'Q3.2' });
  if (pre_score.value < LOW_SCORE_THRESHOLD) {
    picks.push({
      id: 'Q3.3',
      context: 'Your pre-score indicates elevated exposure, so we need more detail on client disclosure.',
    });
  }

  // Dominio 4 — Datos
  picks.push({ id: 'Q4.1' });
  if (observations.cloud_tools_detected) {
    picks.push({
      id: 'Q4.2',
      context: 'We detected cloud-hosted tools in your stack, which may process data outside the US.',
    });
  }

  // Dominio 5 — Capacitación
  picks.push({ id: 'Q5.1' });
  if (pre_score.value > HIGH_SCORE_THRESHOLD) {
    picks.push({
      id: 'Q5.2',
      context: 'Your firm already shows mature AI governance signals, so we go one level deeper.',
    });
  }

  // Dominio 6 — Incidentes
  picks.push({ id: 'Q6.1' });
  picks.push({ id: 'Q6.2' });

  const questions: SelectedQuestion[] = picks.flatMap((pick, index) => {
    const question = QUESTIONS_BY_ID[pick.id];
    if (!question) return []; // el banco es la fuente de verdad: un id sin definición no se emite
    return [
      {
        ...question,
        order: index + 1,
        context: pick.context ?? null,
        skipped_question: pick.skipped_question ?? null,
        skip_reason: pick.skip_reason ?? null,
      },
    ];
  });

  return {
    total_questions: questions.length,
    estimated_minutes: Math.max(1, Math.round(questions.length * MINUTES_PER_QUESTION)),
    questions,
  };
}

/**
 * Q1.2 es la única pregunta dinámica: se agrega recién cuando la firma declara tener policy
 * en Q1.1. El handler la usa para completar el set antes de puntuar.
 */
export function followUpQuestions(answeredQ1_1: string): SelectedQuestion[] {
  if (answeredQ1_1 !== 'formal_documented' && answeredQ1_1 !== 'informal') return [];
  const question = QUESTIONS_BY_ID['Q1.2'];
  if (!question) return [];
  return [
    {
      ...question,
      order: 0,
      context: 'You indicated your firm has an AI policy. We want to know how complete it is.',
      skipped_question: null,
      skip_reason: null,
    },
  ];
}

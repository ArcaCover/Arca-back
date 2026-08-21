import { QUESTION_SCORING, DOMAIN_WEIGHTS, canonicalAnswer } from './answer-scores.js';
import type { QuestionScoring } from './answer-scores.js';
import type { AssessmentResponse, Confidence, DomainKey, DomainScore } from './types.js';

/** Pesos Capa 1 / Capa 2 según la confianza del scan. */
export const LAYER_WEIGHTS: Record<Confidence, { layer1: number; layer2: number }> = {
  HIGH: { layer1: 0.25, layer2: 0.75 },
  MEDIUM: { layer1: 0.2, layer2: 0.8 },
  LOW: { layer1: 0.1, layer2: 0.9 },
};

export type QuestionPoints = {
  question_id: string;
  domain: DomainKey;
  earned: number;
  possible: number;
  /** false cuando la respuesta saca la pregunta del cálculo (ej: Q2.1 = "none"). */
  applicable: boolean;
};

function toArray(answer: string | string[]): string[] {
  return Array.isArray(answer) ? answer : [answer];
}

/** Puntos de una sola respuesta según su tipo de scoring. Nunca devuelve negativos. */
export function scoreQuestion(question: QuestionScoring, answer: string | string[]): QuestionPoints {
  const answers = toArray(answer).map((a) => canonicalAnswer(question, a));
  const base = { question_id: question.id, domain: question.domain, possible: question.max_points };

  if (question.not_applicable_answers?.some((na) => answers.includes(na))) {
    return { ...base, earned: 0, possible: 0, applicable: false };
  }

  const s = question.scoring;
  if (s.kind === 'single') {
    const earned = s.points[answers[0] ?? ''] ?? 0;
    return { ...base, earned, applicable: true };
  }
  if (s.kind === 'accumulate') {
    const valid = answers.filter((a) => s.valid_options.includes(a));
    const earned = Math.min(valid.length * s.points_per_option, question.max_points);
    return { ...base, earned, applicable: true };
  }
  // penalty: parte del máximo y descuenta por cada incidente declarado.
  const deducted = answers.reduce((sum, a) => sum + (s.penalties[a] ?? 0), 0);
  return { ...base, earned: Math.max(0, s.base - deducted), applicable: true };
}

/** Umbrales de semáforo por dominio; el handbook solo muestra good/warning en sus ejemplos. */
function domainStatus(score: number): DomainScore['status'] {
  if (score >= 70) return 'good';
  if (score >= 50) return 'warning';
  return 'critical';
}

export type DomainBreakdown = {
  domain_scores: Record<DomainKey, DomainScore>;
  question_points: QuestionPoints[];
  deep_score: number;
};

/**
 * Score por dominio y deep_score. El denominador de cada dominio son solo las preguntas
 * efectivamente respondidas: saltar una pregunta no debe penalizar a la firma.
 */
export function scoreDomains(responses: AssessmentResponse[]): DomainBreakdown {
  const question_points: QuestionPoints[] = [];

  for (const response of responses) {
    const question = QUESTION_SCORING[response.question_id];
    if (!question) continue; // ids desconocidos se ignoran en vez de romper el cálculo
    question_points.push(scoreQuestion(question, response.answer));
  }

  const domain_scores = {} as Record<DomainKey, DomainScore>;
  let weighted_sum = 0;
  let weight_present = 0;

  for (const domain of Object.keys(DOMAIN_WEIGHTS) as DomainKey[]) {
    const inDomain = question_points.filter((p) => p.domain === domain && p.applicable);
    const possible = inDomain.reduce((sum, p) => sum + p.possible, 0);
    const earned = inDomain.reduce((sum, p) => sum + p.earned, 0);
    const weight = DOMAIN_WEIGHTS[domain];

    if (possible === 0) continue; // dominio sin preguntas aplicables: se excluye y su peso se reparte
    const score = Math.round((earned / possible) * 100);
    domain_scores[domain] = { score, status: domainStatus(score), points_earned: earned, points_possible: possible, weight };
    weighted_sum += score * weight;
    weight_present += weight;
  }

  // Renormaliza sobre los dominios presentes para que deep_score siga siendo 0-100.
  const deep_score = weight_present === 0 ? 0 : Math.round(weighted_sum / weight_present);
  return { domain_scores, question_points, deep_score };
}

/** composite = pre_score × peso_capa1 + deep_score × peso_capa2. */
export function compositeScore(pre_score: number, deep_score: number, confidence: Confidence): number {
  const w = LAYER_WEIGHTS[confidence];
  return Math.round(pre_score * w.layer1 + deep_score * w.layer2);
}

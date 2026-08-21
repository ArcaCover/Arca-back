import { QUESTION_SCORING } from './answer-scores.js';
import type { QuestionScoring } from './answer-scores.js';
import { compositeScore, scoreDomains } from './score.js';
import { governanceFactor } from './pricing.js';
import type { ActionPlanItem, AssessmentResponse, Confidence, DomainKey } from './types.js';

/** Texto de la acción correctiva por pregunta. Data versionada, no lógica. */
export const IMPROVEMENT_ACTIONS: Record<string, string> = {
  'Q1.1': 'Establish a formal, documented AI Use Policy',
  'Q1.2': 'Expand the AI policy to cover approved tools, data rules, review, disclosure, training and incidents',
  'Q1.3': 'Assign AI governance to a formal committee instead of an individual',
  'Q2.1': 'Migrate to an enterprise legal AI tool (CoCounsel, Harvey or Clio AI)',
  'Q2.2': 'Move AI usage into a firm-controlled enterprise instance',
  'Q2.3': 'Implement technical controls that block confidential data from reaching AI tools',
  'Q3.1': 'Implement mandatory review of AI outputs by a second attorney',
  'Q3.2': 'Verify every AI-produced citation with Westlaw or Lexis before filing',
  'Q3.3': 'Disclose AI usage to clients in the engagement letter',
  'Q4.1': 'Implement technical data protection controls (DLP) for privileged material',
  'Q4.2': 'Keep AI processing inside US jurisdiction or sign a DPA with the provider',
  'Q5.1': 'Run mandatory recurring training on responsible AI use',
  'Q5.2': 'Add a formal competency assessment after AI training',
  'Q6.1': 'Resolve and document outstanding AI-related incidents',
  'Q6.2': 'Document and rehearse the incident response plan',
};

/** La respuesta que da el máximo puntaje de cada pregunta, para proyectar la mejora. */
export function bestAnswer(question: QuestionScoring): string | string[] {
  const s = question.scoring;
  if (s.kind === 'accumulate') return [...s.valid_options];
  if (s.kind === 'penalty') return ['none'];
  const entries = Object.entries(s.points);
  const best = entries.reduce((a, b) => (b[1] > a[1] ? b : a));
  return best[0];
}

function describeAnswer(answer: string | string[]): string {
  return Array.isArray(answer) ? answer.join(', ') : answer;
}

export type Candidate = {
  question_id: string;
  domain: DomainKey;
  action: string;
  current_answer: string;
  required_answer: string;
  score_impact: number;
  composite_after: number;
};

/**
 * Mejoras posibles ordenadas por impacto real en el composite, aplicadas en cascada:
 * cada candidato se evalúa sobre el estado que dejaron los anteriores.
 */
export function rankImprovements(
  responses: AssessmentResponse[],
  pre_score: number,
  confidence: Confidence,
  limit: number,
): Candidate[] {
  let current = [...responses];
  let currentComposite = compositeScore(pre_score, scoreDomains(current).deep_score, confidence);
  const chosen: Candidate[] = [];
  const used = new Set<string>();

  for (let round = 0; round < limit; round++) {
    let best: Candidate | null = null;

    for (const response of current) {
      if (used.has(response.question_id)) continue;
      const question = QUESTION_SCORING[response.question_id];
      if (!question) continue;

      const upgraded = bestAnswer(question);
      const projected = current.map((r) =>
        r.question_id === response.question_id ? { ...r, answer: upgraded } : r,
      );
      const composite = compositeScore(pre_score, scoreDomains(projected).deep_score, confidence);
      const impact = composite - currentComposite;
      if (impact <= 0) continue;

      const candidate: Candidate = {
        question_id: response.question_id,
        domain: question.domain,
        action: IMPROVEMENT_ACTIONS[response.question_id] ?? `Improve ${response.question_id}`,
        current_answer: `${response.question_id} = ${describeAnswer(response.answer)}`,
        required_answer: `${response.question_id} = ${describeAnswer(upgraded)}`,
        score_impact: impact,
        composite_after: composite,
      };
      if (!best || candidate.score_impact > best.score_impact) best = candidate;
    }

    if (!best) break;
    const winner = best;
    const question = QUESTION_SCORING[winner.question_id]!;
    current = current.map((r) =>
      r.question_id === winner.question_id ? { ...r, answer: bestAnswer(question) } : r,
    );
    currentComposite = winner.composite_after;
    used.add(winner.question_id);
    chosen.push(winner);
  }

  return chosen;
}

/** Variación porcentual de la prima entre el score actual y el proyectado. */
export function premiumImpactPercent(current_score: number, projected_score: number): number {
  const now = governanceFactor(current_score);
  const then = governanceFactor(projected_score);
  if (now === null || then === null || now === 0) return 0; // sin prima base no hay comparación
  return Math.round(((then - now) / now) * 100);
}

export function buildActionPlan(candidates: Candidate[], current_score: number): ActionPlanItem[] {
  return candidates.map((c, i) => ({
    priority: i + 1,
    action: c.action,
    domain: c.domain,
    score_impact: c.score_impact,
    projected_score: c.composite_after,
    premium_impact_percent: premiumImpactPercent(current_score, c.composite_after),
  }));
}

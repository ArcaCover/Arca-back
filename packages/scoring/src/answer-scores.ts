import type { DomainKey } from './types.js';

/** Puntaje simple: cada opción vale sus puntos. */
type SingleScoring = { kind: 'single'; points: Record<string, number> };
/** Q1.2: acumula puntos por cada aspecto marcado, topeado en max_points. */
type AccumulateScoring = { kind: 'accumulate'; points_per_option: number; valid_options: string[] };
/** Q6.1: arranca en `base` y descuenta por cada incidente reportado. */
type PenaltyScoring = { kind: 'penalty'; base: number; penalties: Record<string, number> };

export type QuestionScoring = {
  id: string;
  domain: DomainKey;
  max_points: number;
  scoring: SingleScoring | AccumulateScoring | PenaltyScoring;
  /** Respuestas que sacan la pregunta del cálculo (no suman ni al numerador ni al máximo). */
  not_applicable_answers?: string[];
  /** Ids alternativos aceptados por request, mapeados al id canónico de la tabla. */
  answer_aliases?: Record<string, string>;
};

/** Tabla completa de la sección 5 del handbook. Es data, no lógica: no derivar valores acá. */
export const QUESTION_SCORING: Record<string, QuestionScoring> = {
  'Q1.1': {
    id: 'Q1.1',
    domain: 'governance',
    max_points: 10,
    scoring: {
      kind: 'single',
      points: { formal_documented: 10, informal: 5, in_development: 3, no_policy: 0 },
    },
  },
  'Q1.2': {
    id: 'Q1.2',
    domain: 'governance',
    max_points: 12,
    scoring: {
      kind: 'accumulate',
      points_per_option: 2,
      valid_options: [
        'approved_tools',
        'data_rules',
        'review_process',
        'client_disclosure',
        'training',
        'incidents',
      ],
    },
  },
  'Q1.3': {
    id: 'Q1.3',
    domain: 'governance',
    max_points: 8,
    scoring: {
      kind: 'single',
      points: { committee: 8, specific_partner: 6, it_department: 4, individual: 2, nobody: 0 },
    },
  },
  'Q2.1': {
    id: 'Q2.1',
    domain: 'tools',
    max_points: 10,
    scoring: {
      kind: 'single',
      points: { legal_enterprise: 10, enterprise_api: 7, commercial: 4, public_free: 1 },
    },
    // "none" = la firma no usa IA, así que no necesita seguro: la pregunta no puntúa.
    not_applicable_answers: ['none'],
  },
  'Q2.2': {
    id: 'Q2.2',
    domain: 'tools',
    max_points: 10,
    scoring: {
      kind: 'single',
      points: {
        enterprise_controlled: 10,
        api_controlled: 8,
        commercial_accounts: 5,
        public_free: 1,
        dont_know: 0,
      },
    },
    // El ejemplo de request del handbook usa ids abreviados; los aceptamos.
    answer_aliases: { enterprise: 'enterprise_controlled', commercial: 'commercial_accounts' },
  },
  'Q2.3': {
    id: 'Q2.3',
    domain: 'tools',
    max_points: 10,
    scoring: {
      kind: 'single',
      points: { technical_controls: 10, policy_only: 6, anonymized: 4, real_data: 1, no_visibility: 0 },
    },
  },
  'Q3.1': {
    id: 'Q3.1',
    domain: 'oversight',
    max_points: 10,
    scoring: {
      kind: 'single',
      points: {
        peer_review: 10,
        self_review_checklist: 7,
        informal: 3,
        depends_individual: 1,
        no_process: 0,
      },
    },
  },
  'Q3.2': {
    id: 'Q3.2',
    domain: 'oversight',
    max_points: 10,
    scoring: {
      kind: 'single',
      points: { tools_always: 10, manual_always: 8, generally: 4, rarely: 1, no_protocol: 0 },
    },
  },
  'Q3.3': {
    id: 'Q3.3',
    domain: 'oversight',
    max_points: 10,
    scoring: {
      kind: 'single',
      points: { always_engagement: 10, case_by_case: 6, only_if_asked: 2, never: 0 },
    },
  },
  'Q4.1': {
    id: 'Q4.1',
    domain: 'data_protection',
    max_points: 10,
    scoring: {
      kind: 'single',
      points: { technical_controls: 10, guidelines: 6, in_development: 3, none: 0 },
    },
    answer_aliases: { guidelines_only: 'guidelines' },
  },
  'Q4.2': {
    id: 'Q4.2',
    domain: 'data_protection',
    max_points: 8,
    scoring: {
      kind: 'single',
      points: { us_only: 8, dpa_signed: 6, no_agreement: 1, dont_know: 0 },
    },
  },
  'Q5.1': {
    id: 'Q5.1',
    domain: 'training',
    max_points: 10,
    scoring: {
      kind: 'single',
      points: { mandatory_recurring: 10, once: 6, optional: 3, planned: 1, none: 0 },
    },
    answer_aliases: { no_training: 'none' },
  },
  'Q5.2': {
    id: 'Q5.2',
    domain: 'training',
    max_points: 8,
    scoring: {
      kind: 'single',
      points: {
        formal_assessment: 8,
        supervision_onboarding: 5,
        individual_judgment: 2,
        no_evaluation: 0,
      },
    },
  },
  'Q6.1': {
    id: 'Q6.1',
    domain: 'incident_preparedness',
    max_points: 10,
    scoring: {
      kind: 'penalty',
      base: 10,
      // "regulatory_investigation" no descuenta puntos: dispara DECLINE vía override rule.
      penalties: {
        none: 0,
        doc_error: 2,
        citation_error: 3,
        data_exposure: 5,
        client_complaint: 3,
        regulatory_investigation: 0,
      },
    },
  },
  'Q6.2': {
    id: 'Q6.2',
    domain: 'incident_preparedness',
    max_points: 10,
    scoring: {
      kind: 'single',
      points: { documented_tested: 10, documented_not_tested: 7, informal: 3, none: 0 },
    },
  },
};

/** Pesos por dominio (suman 100). Sección "Cosa 2" del handbook. */
export const DOMAIN_WEIGHTS: Record<DomainKey, number> = {
  governance: 25,
  tools: 20,
  oversight: 20,
  data_protection: 15,
  training: 10,
  incident_preparedness: 10,
};

/** Normaliza un answer id a su forma canónica, si la pregunta declara alias. */
export function canonicalAnswer(question: QuestionScoring, answer: string): string {
  return question.answer_aliases?.[answer] ?? answer;
}

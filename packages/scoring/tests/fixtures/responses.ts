import type { AssessmentResponse, ScoringFirm } from '@arca/scoring';

/** Helper para escribir las fixtures como pares question_id → answer. */
function responses(map: Record<string, string | string[]>): AssessmentResponse[] {
  return Object.entries(map).map(([question_id, answer]) => ({ question_id, answer }));
}

const ALL_POLICY_ASPECTS = [
  'approved_tools',
  'data_rules',
  'review_process',
  'client_disclosure',
  'training',
  'incidents',
];

/** Todas las mejores respuestas: deep_score 100. */
export const perfectResponses = responses({
  'Q1.1': 'formal_documented',
  'Q1.2': ALL_POLICY_ASPECTS,
  'Q1.3': 'committee',
  'Q2.1': 'legal_enterprise',
  'Q2.2': 'enterprise_controlled',
  'Q2.3': 'technical_controls',
  'Q3.1': 'peer_review',
  'Q3.2': 'tools_always',
  'Q3.3': 'always_engagement',
  'Q4.1': 'technical_controls',
  'Q4.2': 'us_only',
  'Q5.1': 'mandatory_recurring',
  'Q5.2': 'formal_assessment',
  'Q6.1': ['none'],
  'Q6.2': 'documented_tested',
});

/** Firma sólida pero con huecos: cae en FORTIFIED. */
export const strongResponses = responses({
  'Q1.1': 'formal_documented',
  'Q1.2': ['approved_tools', 'data_rules', 'review_process'],
  'Q1.3': 'specific_partner',
  'Q2.1': 'enterprise_api',
  'Q2.2': 'api_controlled',
  'Q2.3': 'policy_only',
  'Q3.1': 'peer_review',
  'Q3.2': 'manual_always',
  'Q3.3': 'case_by_case',
  'Q4.1': 'guidelines',
  'Q4.2': 'dpa_signed',
  'Q5.1': 'mandatory_recurring',
  'Q5.2': 'supervision_onboarding',
  'Q6.1': ['none'],
  'Q6.2': 'documented_not_tested',
});

/** Gobernanza informal y herramientas comerciales: zona GUARDED. */
export const moderateResponses = responses({
  'Q1.1': 'informal',
  'Q1.2': ['approved_tools', 'data_rules', 'review_process', 'incidents'],
  'Q1.3': 'specific_partner',
  'Q2.1': 'commercial',
  'Q2.2': 'commercial_accounts',
  'Q2.3': 'policy_only',
  'Q3.1': 'self_review_checklist',
  'Q3.2': 'manual_always',
  'Q3.3': 'case_by_case',
  'Q4.1': 'guidelines',
  'Q4.2': 'no_agreement',
  'Q5.1': 'once',
  'Q5.2': 'individual_judgment',
  'Q6.1': ['doc_error'],
  'Q6.2': 'documented_not_tested',
});

/** Sin policy y con revisión informal: zona EXPOSED. */
export const weakResponses = responses({
  'Q1.1': 'in_development',
  'Q1.3': 'individual',
  'Q2.1': 'commercial',
  'Q2.2': 'commercial_accounts',
  'Q2.3': 'anonymized',
  'Q3.1': 'self_review_checklist',
  'Q3.2': 'generally',
  'Q3.3': 'only_if_asked',
  'Q4.1': 'in_development',
  'Q4.2': 'dont_know',
  'Q5.1': 'optional',
  'Q5.2': 'no_evaluation',
  'Q6.1': ['citation_error'],
  'Q6.2': 'informal',
});

/** Sin ningún control: zona CRITICAL. */
export const minimalResponses = responses({
  'Q1.1': 'no_policy',
  'Q1.3': 'nobody',
  'Q2.1': 'public_free',
  'Q2.2': 'public_free',
  'Q2.3': 'no_visibility',
  'Q3.1': 'no_process',
  'Q3.2': 'no_protocol',
  'Q3.3': 'never',
  'Q4.1': 'none',
  'Q4.2': 'dont_know',
  'Q5.1': 'none',
  'Q5.2': 'no_evaluation',
  'Q6.1': ['data_exposure', 'client_complaint'],
  'Q6.2': 'none',
});

/** OR-001: datos reales de clientes en una herramienta pública gratuita. */
export const realDataInPublicToolResponses = responses({
  ...Object.fromEntries(perfectResponses.map((r) => [r.question_id, r.answer])),
  'Q2.2': 'public_free',
  'Q2.3': 'real_data',
});

/** OR-002: investigación regulatoria activa sobre una firma por lo demás impecable. */
export const regulatoryInvestigationResponses = responses({
  ...Object.fromEntries(perfectResponses.map((r) => [r.question_id, r.answer])),
  'Q6.1': ['none', 'regulatory_investigation'],
});

/** OR-003: sin proceso de revisión; solo dispara si la firma es de criminal defense. */
export const noReviewProcessResponses = responses({
  ...Object.fromEntries(perfectResponses.map((r) => [r.question_id, r.answer])),
  'Q3.1': 'no_process',
});

/** Ids abreviados tal como aparecen en el request de ejemplo del handbook. */
export const handbookExampleResponses = responses({
  'Q1.2': ['approved_tools', 'data_rules', 'review_process'],
  'Q1.3': 'specific_partner',
  'Q2.2': 'commercial',
  'Q2.3': 'anonymized',
  'Q3.1': 'peer_review',
  'Q3.2': 'tools_always',
  'Q4.1': 'guidelines_only',
  'Q5.1': 'mandatory_recurring',
  'Q6.1': ['none'],
  'Q6.2': 'documented_not_tested',
});

export const criminalDefenseFirm: ScoringFirm = {
  attorneys_count: 10,
  practice_areas: ['criminal_defense', 'commercial_litigation'],
  primary_practice: 'criminal_defense',
  state: 'FL',
};

export const corporateFirm: ScoringFirm = {
  attorneys_count: 4,
  practice_areas: ['corporate_ma'],
  primary_practice: 'corporate_ma',
  state: 'OH',
};

export const soloTaxFirm: ScoringFirm = {
  attorneys_count: 1,
  practice_areas: ['tax_regulatory'],
  primary_practice: 'tax_regulatory',
  state: 'WY',
};

export const bigFirm: ScoringFirm = {
  attorneys_count: 60,
  practice_areas: ['commercial_litigation'],
  primary_practice: 'commercial_litigation',
  state: 'NY',
};

export const unknownFirm: ScoringFirm = {
  attorneys_count: null,
  practice_areas: [],
  primary_practice: null,
  state: null,
};

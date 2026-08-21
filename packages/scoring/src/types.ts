import { z } from 'zod';

/** Los 6 dominios del assessment. Las keys son las que viajan en la API. */
export const DomainKey = z.enum([
  'governance',
  'tools',
  'oversight',
  'data_protection',
  'training',
  'incident_preparedness',
]);
export type DomainKey = z.infer<typeof DomainKey>;

export const Tier = z.enum(['FORTRESS', 'FORTIFIED', 'GUARDED', 'EXPOSED', 'CRITICAL']);
export type Tier = z.infer<typeof Tier>;

export const Decision = z.enum(['AUTO_BIND', 'REFERRAL', 'REFERRAL_SENIOR', 'DECLINE']);
export type Decision = z.infer<typeof Decision>;

/** Confianza de Capa 1: define cuánto pesa el pre_score en el composite. */
export const Confidence = z.enum(['HIGH', 'MEDIUM', 'LOW']);
export type Confidence = z.infer<typeof Confidence>;

/** Las 9 categorías de práctica del handbook, cada una con su multiplier de prima. */
export const PracticeArea = z.enum([
  'criminal_defense',
  'immigration',
  'personal_injury',
  'family_law',
  'commercial_litigation',
  'employment_law',
  'corporate_ma',
  'real_estate',
  'tax_regulatory',
]);
export type PracticeArea = z.infer<typeof PracticeArea>;

/** Una respuesta del assessment: string para single_select, array para multi_select. */
export const AssessmentResponse = z.object({
  question_id: z.string(),
  answer: z.union([z.string(), z.array(z.string())]),
});
export type AssessmentResponse = z.infer<typeof AssessmentResponse>;

/** Datos de la firma que entran al pricing. Todo opcional salvo lo que no se puede estimar. */
export const ScoringFirm = z.object({
  attorneys_count: z.number().int().positive().nullable(),
  practice_areas: z.array(PracticeArea).default([]),
  primary_practice: PracticeArea.nullable(),
  state: z.string().length(2).nullable(),
});
export type ScoringFirm = z.infer<typeof ScoringFirm>;

/** Entrada única de la función pura: sin I/O, sin fechas, sin dependencias externas. */
export const ScoringInput = z.object({
  pre_score: z.number().min(0).max(100),
  confidence: Confidence,
  responses: z.array(AssessmentResponse),
  firm: ScoringFirm,
});
export type ScoringInput = z.infer<typeof ScoringInput>;

export const DomainScore = z.object({
  score: z.number(),
  status: z.enum(['good', 'warning', 'critical']),
  points_earned: z.number(),
  points_possible: z.number(),
  weight: z.number(),
});
export type DomainScore = z.infer<typeof DomainScore>;

export const PricingOption = z.object({
  name: z.enum(['Essential', 'Professional', 'Complete']),
  limit_per_claim: z.number().int(),
  limit_aggregate: z.number().int(),
  annual_premium: z.number().int(),
  monthly_premium: z.number().int(),
});
export type PricingOption = z.infer<typeof PricingOption>;

export const PricingFactors = z.object({
  base_rate: z.number(),
  attorneys: z.number().int(),
  governance_factor: z.number(),
  practice_multiplier: z.number(),
  jurisdiction_factor: z.number(),
  size_factor: z.number().nullable(),
});
export type PricingFactors = z.infer<typeof PricingFactors>;

export const Pricing = z.object({
  factors: PricingFactors,
  options: z.array(PricingOption),
  /** true cuando la firma cae fuera de las tablas (51+ abogados): requiere cotización manual. */
  requires_custom_quote: z.boolean(),
  /** Motivo por el que no hay opciones calculadas, si las hay. */
  unavailable_reason: z.string().nullable(),
});
export type Pricing = z.infer<typeof Pricing>;

export const ActionPlanItem = z.object({
  priority: z.number().int(),
  action: z.string(),
  domain: DomainKey,
  score_impact: z.number(),
  projected_score: z.number(),
  premium_impact_percent: z.number(),
});
export type ActionPlanItem = z.infer<typeof ActionPlanItem>;

export const RequiredImprovement = z.object({
  action: z.string(),
  current_answer: z.string(),
  required_answer: z.string(),
  score_impact: z.number(),
  priority: z.enum(['REQUIRED', 'RECOMMENDED']),
});
export type RequiredImprovement = z.infer<typeof RequiredImprovement>;

export const PathToInsurability = z.object({
  current_score: z.number(),
  target_score: z.number(),
  target_tier: Tier,
  required_improvements: z.array(RequiredImprovement),
  projected_score_after_improvements: z.number(),
  reassessment_available_in_days: z.number().int(),
  message: z.string(),
});
export type PathToInsurability = z.infer<typeof PathToInsurability>;

export const OverrideRuleTriggered = z.object({
  id: z.string(),
  reason: z.string(),
  decision: Decision,
});
export type OverrideRuleTriggered = z.infer<typeof OverrideRuleTriggered>;

/** Salida completa. 100% JSON-serializable: sin clases, sin Date, sin funciones. */
export const ScoringResult = z.object({
  pre_score: z.number(),
  deep_score: z.number(),
  composite_score: z.number(),
  layer_weights: z.object({ layer1: z.number(), layer2: z.number() }),
  tier: Tier,
  decision: Decision,
  domain_scores: z.record(DomainKey, DomainScore),
  override_rules_triggered: z.array(OverrideRuleTriggered),
  pricing: Pricing.nullable(),
  action_plan: z.array(ActionPlanItem),
  path_to_insurability: PathToInsurability.nullable(),
});
export type ScoringResult = z.infer<typeof ScoringResult>;

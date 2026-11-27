import { z } from 'zod';
import { Decision, Tier } from './layer1.js';

/**
 * The six domains of the demo bank, and since bank 4.0 the three scored categories plus 'firm_profile' for the questions
 * that classify the firm without scoring it. One enum, so an action item names either kind of origin.
 */
export const DomainKey = z.enum(['governance', 'tools', 'oversight', 'data_protection', 'training', 'incident_preparedness',
  'ai_data_governance', 'professional_standing', 'firm_maturity', 'firm_profile']);
export type DomainKey = z.infer<typeof DomainKey>;
/** How the assessment names each domain: one source for the demo bank and the webapp, so both name a domain alike. */
export const DOMAIN_LABELS: Readonly<Record<DomainKey, string>> = Object.freeze({
  governance: 'AI Governance & Policy',
  tools: 'AI Tool Environment',
  oversight: 'Human Oversight & Review',
  data_protection: 'Data Protection & Confidentiality',
  training: 'Training & Competency',
  incident_preparedness: 'Incident Preparedness',
  ai_data_governance: 'AI & Data Governance',
  professional_standing: 'Professional Standing',
  firm_maturity: 'Firm Maturity',
  firm_profile: 'About your firm',
});
/** The domains a new action can belong to today: bank 4.0's three scored categories. */
export const ACTION_DOMAINS = ['ai_data_governance', 'professional_standing', 'firm_maturity'] as const satisfies readonly DomainKey[];
export const QuestionType = z.enum(['single_select', 'multi_select', 'yes_no', 'scale', 'number', 'text']);
export const AnswerValue = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('option'), optionId: z.string().min(1).max(80) }).strict(),
  z.object({ kind: z.literal('options'), optionIds: z.array(z.string().min(1).max(80)).min(1).max(30) }).strict(),
  z.object({ kind: z.literal('scale'), value: z.number().finite() }).strict(),
  z.object({ kind: z.literal('number'), value: z.number().finite() }).strict(),
  // Bank 4.0's open question: recorded verbatim for the underwriter, never scored.
  z.object({ kind: z.literal('text'), value: z.string().trim().min(1).max(1000) }).strict(),
]);
export type AnswerValue = z.infer<typeof AnswerValue>;
export const AssessmentEvidence = z.object({
  id: z.string().min(1), signal: z.string().min(1),
  value: z.union([z.string(), z.number().finite(), z.boolean(), z.array(z.string())]).nullable(),
  text: z.string().min(1), sourceUrl: z.string().url().nullable(),
}).strict();
export type AssessmentEvidence = z.infer<typeof AssessmentEvidence>;
export const RenderedQuestion = z.object({
  id: z.string(), domain: DomainKey, domainLabel: z.string(), type: QuestionType,
  text: z.string(), help: z.string().nullable(), context: z.string().nullable(), scored: z.boolean(),
  evidence: z.array(AssessmentEvidence),
  options: z.array(z.object({ id: z.string(), label: z.string(), exclusive: z.boolean() }).strict()).nullable(),
  scale: z.object({ min: z.number(), max: z.number(), step: z.number().positive(), minLabel: z.string(), maxLabel: z.string() }).strict().nullable(),
  number: z.object({ min: z.number(), max: z.number(), unit: z.string() }).strict().nullable(),
  /** An open answer's limit; absent on the questions rendered before bank 4.0. */
  textInput: z.object({ maxLength: z.number().int().positive() }).strict().nullable().optional(),
  suggestedAnswer: AnswerValue.nullable(),
}).strict();
export type RenderedQuestion = z.infer<typeof RenderedQuestion>;
/** DEMO: the first fixture bank. PROVISIONAL: bank 4.0, the underwriting rules, uncalibrated until a carrier sets them. */
export const BankStatus = z.enum(['DEMO', 'PROVISIONAL']);
export type BankStatus = z.infer<typeof BankStatus>;
export const AssessmentStatus = z.enum(['PLANNING', 'READY', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'EXPIRED']);
export type AssessmentStatus = z.infer<typeof AssessmentStatus>;
export const StartedAssessmentResponse = z.object({ assessmentId: z.string(), status: AssessmentStatus }).strict();
export type StartedAssessmentResponse = z.infer<typeof StartedAssessmentResponse>;
export const AssessmentView = z.object({
  assessmentId: z.string(), scanId: z.string(), status: AssessmentStatus,
  bankVersion: z.string(), bankStatus: BankStatus,
  planner: z.enum(['agent', 'rules']).nullable(), intro: z.string().nullable(),
  expiresAt: z.string().datetime(), sessionScope: z.literal('CURRENT_TAB_24H'),
  questions: z.array(RenderedQuestion), answers: z.record(z.string(), AnswerValue),
  skipped: z.array(z.object({ id: z.string(), text: z.string(), creditText: z.string() }).strict()),
  progress: z.object({ answered: z.number().int().nonnegative(), total: z.number().int().nonnegative() }).strict(),
  estimatedMinutes: z.number().int().nonnegative(),
}).strict();
export type AssessmentView = z.infer<typeof AssessmentView>;
export const SaveAnswerRequest = z.object({ answer: AnswerValue }).strict();
export const CompleteRequest = z.object({ attestation: z.literal(true) }).strict();
export const DomainScore = z.object({
  key: DomainKey, label: z.string(), weight: z.number().positive(), score: z.number().min(0).max(100),
  status: z.enum(['KNOWN', 'PARTIAL']),
}).strict();
export const ActionItem = z.object({
  id: z.string(), domain: DomainKey, title: z.string(), detail: z.string(), pointsGain: z.number().nonnegative(),
}).strict();
/** The result of an assessment on the demo bank (before bank 4.0). Stored results keep this shape and stay readable. */
export const LegacyAssessmentResult = z.object({
  assessmentId: z.string(), scanId: z.string(), bankVersion: z.string(), bankStatus: z.literal('DEMO'),
  scoringVersion: z.string(), commercialDecisionBlocked: z.literal(true),
  layer1Score: z.number().min(0).max(100).nullable(), layer2Score: z.number().min(0).max(100),
  compositeScore: z.number().min(0).max(100).nullable(), tier: Tier, decision: Decision,
  domains: z.array(DomainScore).length(6), flags: z.array(z.string()), actionPlan: z.array(ActionItem),
  completedAt: z.string().datetime(),
}).strict();
export type LegacyAssessmentResult = z.infer<typeof LegacyAssessmentResult>;

// Bank 4.0: the underwriting rules (DN-14). Three scored categories, a usage profile, confidence that only moves down,
// an exposure band that sets how high the score must be, and one of three outcomes. Only a quote carries a price.
export const ScoreCategoryKey = z.enum(['ai_data_governance', 'professional_standing', 'firm_maturity']);
export type ScoreCategoryKey = z.infer<typeof ScoreCategoryKey>;
export const ConfidenceLevel = z.enum(['HIGH', 'MEDIUM', 'LOW']);
export const UsageProfile = z.enum(['P0', 'P1', 'P2', 'P3', 'P4']);
export const ExposureLevel = z.enum(['E1', 'E2', 'E3', 'E4']);
export const UnderwritingCategory = z.object({
  key: ScoreCategoryKey, label: z.string(), max: z.number().positive(),
  /** Layer 1's points rescaled to this maximum; 0 when Layer 1 could not evaluate it ("we do not know earns nothing"). */
  layer1: z.number(), layer2: z.number(), score: z.number().min(0),
}).strict();
export const QuoteCondition = z.object({
  what: z.string(), why: z.string(), dueDays: z.number().int().positive(), fromQuestion: z.string(),
}).strict();
export const PremiumBuildUp = z.object({
  attorneys: z.number().nonnegative(), supportStaff: z.number().nonnegative(), attorneyCountAssumed: z.boolean(),
  peopleCountLowerBound: z.boolean(), exposureUnits: z.number().nonnegative(), ratedUnits: z.number().nonnegative(),
  ratePerUnit: z.number().positive(), areaFactor: z.number().positive(), riskFactor: z.number().positive(),
  confidenceLoad: z.number().positive(), limitFactor: z.number().positive(), jurisdictionFactor: z.number().positive(),
  minimumApplied: z.boolean(),
}).strict();
export const UnderwritingOutcome = z.discriminatedUnion('type', [
  z.object({ type: z.literal('quote'), quote: z.object({
    currency: z.literal('USD'), indicative: z.literal(true),
    /** The limit the build-up below prices; the firm picks another from `limits`, never Arca. */
    defaultLimit: z.number().int().positive(),
    limits: z.array(z.object({ limit: z.number().int().positive(), annualPremium: z.number().int().positive() }).strict()).min(1),
    buildUp: PremiumBuildUp, conditions: z.array(QuoteCondition).max(3),
  }).strict() }).strict(),
  z.object({ type: z.literal('schedule'), schedule: z.object({
    message: z.string(), bookingUrl: z.string().url(), withWhom: z.enum(['underwriter', 'senior underwriter']),
  }).strict() }).strict(),
  z.object({ type: z.literal('declined'), declined: z.object({
    message: z.string(), bookingUrl: z.string().url(), reassessAfterDays: z.number().int().positive(),
  }).strict() }).strict(),
]);
export type UnderwritingOutcome = z.infer<typeof UnderwritingOutcome>;
export const UnderwritingAudit = z.object({
  decisionRuleFired: z.string(),
  knockoutsFired: z.array(z.object({ questionId: z.string(), optionId: z.string(), forced: z.enum(['REFERRAL', 'REFERRAL_SENIOR']) }).strict()),
  questionsAsked: z.array(z.object({ id: z.string(), optionIds: z.array(z.string()), questionTextAsAsked: z.string(),
    answerText: z.string(), pointsApplied: z.number(), category: ScoreCategoryKey.nullable() }).strict()),
  questionsDropped: z.array(z.object({ id: z.string(), reason: z.enum(['cap', 'not_triggered']) }).strict()),
  knockoutQuestionDropped: z.boolean(),
}).strict();
export const UnderwritingResult = z.object({
  assessmentId: z.string(), scanId: z.string(), bankVersion: z.string(), bankStatus: z.literal('PROVISIONAL'),
  configVersion: z.string(), scoringVersion: z.string(), completed: z.boolean(),
  /** Layer 1's total on the three scored categories, or null when the website could not be read. */
  layer1Score: z.number().min(0).max(100).nullable(),
  /** The definitive score, 0 to 100: Layer 1 plus the answers, category by category. */
  compositeScore: z.number().min(0).max(100), tier: Tier,
  categories: z.array(UnderwritingCategory).length(3),
  confidence: z.object({ level: ConfidenceLevel, startedAt: ConfidenceLevel,
    downgrades: z.array(z.object({ reason: z.string(), from: ConfidenceLevel, to: ConfidenceLevel }).strict()),
    contradictions: z.array(z.object({ layer1Said: z.string(), firmSaid: z.string() }).strict()) }).strict(),
  exposure: z.object({ usageProfile: UsageProfile, sizeBand: z.enum(['Small', 'Medium', 'Large']),
    areaBand: z.enum(['Low', 'Medium', 'High']), level: ExposureLevel,
    autoBindThreshold: z.number().nullable(), conditionsThreshold: z.number().nullable() }).strict(),
  outcome: UnderwritingOutcome,
  reputationContext: z.object({ avvoRating: z.number().nullable(), reviewCount: z.number().nullable(),
    awards: z.boolean().nullable() }).strict(),
  /** Improvement steps from the answers that lost points, biggest first. Feeds the webapp's action plan. */
  actionPlan: z.array(ActionItem), flags: z.array(z.string()),
  /** For Arca's underwriters only: present in the stored record and in the debug modes, null in what the firm receives. */
  audit: UnderwritingAudit.nullable(), underwriterSummary: z.string().nullable(),
  completedAt: z.string().datetime(),
}).strict();
export type UnderwritingResult = z.infer<typeof UnderwritingResult>;
export const AssessmentResult = z.union([UnderwritingResult, LegacyAssessmentResult]);
export type AssessmentResult = z.infer<typeof AssessmentResult>;
export const isUnderwritingResult = (result: AssessmentResult): result is UnderwritingResult => 'outcome' in result;
export const AssessmentError = z.object({ error: z.enum(['scan_not_ready', 'assessment_exists',
  'not_found', 'invalid_answer', 'not_visible', 'incomplete', 'already_completed', 'expired',
  'unauthorized', 'not_ready', 'rate_limited', 'conflict', 'invalid_request', 'internal_error']), message: z.string() }).strict();

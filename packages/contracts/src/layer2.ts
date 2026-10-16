import { z } from 'zod';
import { Decision, Tier } from './layer1.js';

export const DomainKey = z.enum(['governance', 'tools', 'oversight', 'data_protection', 'training', 'incident_preparedness']);
export type DomainKey = z.infer<typeof DomainKey>;
export const QuestionType = z.enum(['single_select', 'multi_select', 'yes_no', 'scale', 'number']);
export const AnswerValue = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('option'), optionId: z.string().min(1).max(80) }).strict(),
  z.object({ kind: z.literal('options'), optionIds: z.array(z.string().min(1).max(80)).min(1).max(30) }).strict(),
  z.object({ kind: z.literal('scale'), value: z.number().finite() }).strict(),
  z.object({ kind: z.literal('number'), value: z.number().finite() }).strict(),
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
  suggestedAnswer: AnswerValue.nullable(),
}).strict();
export type RenderedQuestion = z.infer<typeof RenderedQuestion>;
export const AssessmentStatus = z.enum(['PLANNING', 'READY', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'EXPIRED']);
export type AssessmentStatus = z.infer<typeof AssessmentStatus>;
export const StartedAssessmentResponse = z.object({ assessmentId: z.string(), status: AssessmentStatus }).strict();
export type StartedAssessmentResponse = z.infer<typeof StartedAssessmentResponse>;
export const AssessmentView = z.object({
  assessmentId: z.string(), scanId: z.string(), status: AssessmentStatus,
  bankVersion: z.string(), bankStatus: z.literal('DEMO'),
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
export const AssessmentResult = z.object({
  assessmentId: z.string(), scanId: z.string(), bankVersion: z.string(), bankStatus: z.literal('DEMO'),
  scoringVersion: z.string(), commercialDecisionBlocked: z.literal(true),
  layer1Score: z.number().min(0).max(100).nullable(), layer2Score: z.number().min(0).max(100),
  compositeScore: z.number().min(0).max(100).nullable(), tier: Tier, decision: Decision,
  domains: z.array(DomainScore).length(6), flags: z.array(z.string()), actionPlan: z.array(ActionItem),
  completedAt: z.string().datetime(),
}).strict();
export type AssessmentResult = z.infer<typeof AssessmentResult>;
export const AssessmentError = z.object({ error: z.enum(['scan_not_ready', 'assessment_exists',
  'not_found', 'invalid_answer', 'not_visible', 'incomplete', 'already_completed', 'expired',
  'unauthorized', 'not_ready', 'rate_limited', 'conflict', 'invalid_request', 'internal_error']), message: z.string() }).strict();

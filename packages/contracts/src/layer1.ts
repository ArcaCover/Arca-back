import { z } from 'zod';
import { SourceStatus, WebsiteData, AttorneyMatch } from './sources.js';

export const Tier = z.enum(['FORTRESS', 'FORTIFIED', 'GUARDED', 'EXPOSED', 'CRITICAL', 'UNKNOWN']);
export const Decision = z.enum(['AUTO_BIND', 'AUTO_BIND_CONDITIONAL', 'REFERRAL', 'REFERRAL_SENIOR', 'DECLINE', 'UNKNOWN']);
export const ScanStatus = z.enum(['RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED']);
export const LAYER1_CONTRACT_VERSION = 'layer1-2026-09-12-v2' as const;
const nullableNumber = z.number().finite().nullable();
export const Rule = z.object({ id: z.string(), points: nullableNumber, reason: z.string() }).strict();
export const Category = z.object({
  score: z.number().min(0).max(35).nullable(), max: z.number().positive(),
  status: z.enum(['KNOWN', 'PARTIAL', 'UNKNOWN']), rules: z.array(Rule),
}).strict();
export const PreScore = z.object({
  total: z.number().min(0).max(100).nullable(),
  categories: z.object({ aiGovernance: Category, professionalStanding: Category, reputation: Category, firmMaturity: Category }).strict(),
  tier: Tier, decision: Decision,
  confidence: z.enum(['HIGH', 'MEDIUM', 'LOW']),
  overrides: z.array(z.object({ id: z.string(), decision: Decision, reason: z.string() }).strict()),
  flags: z.array(z.string()),
  assessmentStatus: z.enum(['SUFFICIENT', 'INSUFFICIENT_EVIDENCE']),
}).strict();
export type PreScore = z.infer<typeof PreScore>;
export const Signals = z.object({
  website: z.object({
    W1_aiPolicy: z.object({ found: z.boolean().nullable(), depth: z.string().nullable(), points: nullableNumber }).strict(),
    W2_aiInServices: z.object({ found: z.boolean().nullable(), tools: z.array(z.string()).nullable(), points: nullableNumber }).strict(),
    W3_aiDisclosure: z.object({ found: z.boolean().nullable(), points: nullableNumber }).strict(),
    W4_aiBlog: z.object({ found: z.boolean().nullable(), count: nullableNumber, points: nullableNumber }).strict(),
    W5_teamSize: nullableNumber, W5a_teamPageQuality: z.string().nullable(),
    W6_privacyPolicy: z.object({ found: z.boolean().nullable(), mentionsClientData: z.boolean().nullable(), points: nullableNumber }).strict(),
    W7_websiteQuality: z.string().nullable(), W8_firmEstablished: nullableNumber,
    W9_practiceAreas: z.array(z.string()).nullable(),
  }).strict(),
  bar: z.object({
    B1_allActive: z.boolean().nullable(), B2_worstDisciplinary: z.string().nullable(),
    B3_consistency: nullableNumber, B4_avgExperience: nullableNumber,
    attorneys: z.array(AttorneyMatch).nullable(),
  }).strict(),
  avvo: z.object({
    A1_avgRating: nullableNumber, A1_ratingLevel: z.string().nullable(), A2_practiceAreas: z.array(z.string()).nullable(),
    A3_avgReviewRating: nullableNumber, A3_totalReviews: nullableNumber,
    A6_hasAwards: z.boolean().nullable(), A6_awardsCount: nullableNumber,
    A6_topAward: z.string().nullable(), A8_disciplined: z.boolean().nullable(),
  }).strict(),
}).strict();
export type Signals = z.infer<typeof Signals>;
const multiplier = z.object({ value: z.number().positive(), known: z.boolean() });
export const Multipliers = z.object({
  practiceArea: multiplier.extend({ area: z.string().nullable() }).strict(),
  jurisdiction: multiplier.extend({ state: z.string().nullable() }).strict(),
  size: multiplier.extend({ teamSize: nullableNumber }).strict(),
}).strict();
export const FirmIdentity = z.object({
  canonicalDomain: z.string().min(1), firmName: z.string().min(1).nullable(),
  aliases: z.array(z.string()), city: z.string().nullable(), county: z.string().nullable(),
  addressStreet: z.string().nullable(), phone: z.string().nullable(),
  attorneyNames: z.array(z.string()), status: z.enum(['VERIFIED', 'PARTIAL', 'INSUFFICIENT']),
  evidence: z.array(z.object({ sourceUrl: z.string().url(), excerpt: z.string().nullable(),
    method: z.enum(['json_ld', 'meta', 'page_text', 'provider', 'derived']) }).strict()),
}).strict();
export type FirmIdentity = z.infer<typeof FirmIdentity>;
export const Layer1Result = z.object({
  scanId: z.string().min(1), domain: z.string().min(1), email: z.string().email(), preScore: PreScore,
  identity: FirmIdentity.nullable().default(null),
  signals: Signals, multipliers: Multipliers,
  sources: z.object({ website: SourceStatus, bar: SourceStatus, avvo: SourceStatus }).strict(),
  meta: z.object({ scanDurationMs: z.number().int().nonnegative(), cached: z.boolean(),
    reusedEvidence: z.boolean().default(false), contractVersion: z.literal(LAYER1_CONTRACT_VERSION).default(LAYER1_CONTRACT_VERSION),
    completedAt: z.string().datetime() }).strict(),
}).strict();
export type Layer1Result = z.infer<typeof Layer1Result>;
export type ScanStatus = z.infer<typeof ScanStatus>;
export type PipelineResult = { status: Exclude<ScanStatus, 'RUNNING'>; result: Layer1Result };
export interface Layer1Pipeline {
  run(input: { scanId: string; canonicalDomain: string; email: string }): Promise<PipelineResult>;
}
export const DomainResolution = z.discriminatedUnion('status', [
  z.object({ status: z.literal('RESOLVED'), canonicalDomain: z.string().min(1),
    source: z.enum(['request', 'email']), reason: z.literal(null) }).strict(),
  z.object({ status: z.literal('UNRESOLVED'), canonicalDomain: z.literal(null),
    source: z.enum(['request', 'email']).nullable(), reason: z.enum(['INVALID_DOMAIN', 'PERSONAL_EMAIL', 'DOMAIN_UNAVAILABLE']) }).strict(),
]);
export type DomainResolution = z.infer<typeof DomainResolution>;
export interface DomainResolver {
  resolve(input: { domain?: string; email: string }): Promise<DomainResolution>;
}
export type ScoringInput = {
  website: z.infer<typeof WebsiteData> | null;
  bar: z.infer<typeof AttorneyMatch>[] | null;
  avvo: z.infer<typeof AttorneyMatch>[] | null;
  sources: Layer1Result['sources'];
  now: string;
  /** Two-letter state of the registry the Bar matches came from. Absent means unknown. */
  barJurisdiction?: string | null;
};

/** Structured, provider-agnostic input consumed by the deterministic Layer 1 core. */
export const Layer1Evidence = z.object({
  identity: FirmIdentity,
  website: WebsiteData.nullable(),
  bar: z.array(AttorneyMatch).nullable(),
  avvo: z.array(AttorneyMatch).nullable(),
  sources: z.object({ website: SourceStatus, bar: SourceStatus, avvo: SourceStatus }).strict(),
  observedAt: z.string().datetime(),
  // The state whose licensing registry the Bar source read. A match there certifies that licence.
  barJurisdiction: z.string().regex(/^[A-Z]{2}$/).nullable().optional(),
}).strict();
export type Layer1Evidence = z.infer<typeof Layer1Evidence>;

import { z } from 'zod';

const text = z.string().nullable();
const bool = z.boolean().nullable();
const count = z.number().int().nonnegative().nullable();
const strings = z.array(z.string()).nullable();
export const EvidenceReference = z.object({
  sourceUrl: z.string().url(),
  excerpt: z.string().min(1).nullable(),
  method: z.enum(['json_ld', 'meta', 'page_text', 'provider']),
}).strict();
export type EvidenceReference = z.infer<typeof EvidenceReference>;
export const WebsiteData = z.object({
  ai_policy: z.object({ found: bool, depth: z.enum(['comprehensive', 'basic', 'mention_only', 'none']).nullable(), text_excerpt: text }).strict(),
  ai_in_services: z.object({ found: bool, tools_mentioned: strings, integration_depth: z.enum(['core_service', 'supplementary', 'experimental', 'none_detected']).nullable() }).strict(),
  ai_disclosure: z.object({ found: bool, text_excerpt: text }).strict(),
  ai_blog_posts: z.object({ found: bool, count, titles: strings }).strict(),
  practice_areas: strings,
  team_members: z.array(z.object({ full_name: z.string().min(1), title: text }).strict()).nullable(),
  team_size: count,
  team_page_quality: z.enum(['detailed', 'names_only', 'no_team_page']).nullable(),
  office_count: count,
  privacy_policy: z.object({ found: bool, mentions_client_data: bool }).strict(),
  website_quality: z.enum(['robust', 'basic', 'minimal']).nullable(),
  firm_established_year: z.number().int().min(1000).max(9999).nullable(),
  firm_name: text,
  firm_aliases: strings.default(null),
  city: text.default(null),
  county: text.default(null),
  address_street: text.default(null),
  phone: text.default(null),
  provenance: z.record(z.string(), z.array(EvidenceReference)).default({}),
}).strict();
export type WebsiteData = z.infer<typeof WebsiteData>;

export const DisciplinaryAction = z.object({
  severity: z.string().nullable(),
  date: z.string().nullable(),
  description: text,
}).strict();
export type DisciplinaryAction = z.infer<typeof DisciplinaryAction>;

export const Attorney = z.object({
  name: z.string().min(1),
  city: text,
  county: text.default(null),
  firmName: text,
  barNumber: text,
  barStatus: z.enum(['active', 'inactive', 'suspended', 'disbarred', 'retired', 'deceased', 'UNKNOWN']).nullable(),
  admissionDate: text,
  hasDisciplinaryHistory: bool,
  disciplinaryActions: z.array(DisciplinaryAction).nullable(),
  activeInvestigation: bool,
  avvoRating: z.number().min(1).max(10).nullable(),
  avvoRatingLevel: text.default(null),
  practiceAreas: strings,
  reviewCount: count,
  averageReviewRating: z.number().min(0).max(5).nullable(),
  endorsementCount: count,
  awards: strings,
  awardsCount: count.default(null),
  topAward: text.default(null),
  phone: text.default(null),
  addressStreet: text.default(null),
  yearsLicensed: count.default(null),
  licensedSince: text.default(null),
  profileUrl: text,
}).strict();
export type Attorney = z.infer<typeof Attorney>;
export const MatchConfidence = z.enum(['exact', 'exact_name', 'cross_ref', 'county_match', 'fuzzy', 'firm_fallback', 'no_match']);
export const AttorneyMatch = z.object({
  searchedName: z.string(),
  matchConfidence: MatchConfidence,
  attorney: Attorney.nullable(),
  ambiguous: z.boolean(),
  candidates: z.array(Attorney).optional(),
}).strict();
export type AttorneyMatch = z.infer<typeof AttorneyMatch>;

export const SourceName = z.enum(['website', 'bar', 'avvo']);
export type SourceName = z.infer<typeof SourceName>;
export const SourceIssueCode = z.enum(['ACCESS_BLOCKED', 'NO_READABLE_EVIDENCE', 'INSUFFICIENT_IDENTITY',
  'NO_MATCH', 'PROVIDER_ERROR', 'PROVIDER_CONTRACT_ERROR', 'BUDGET_EXCEEDED', 'DEADLINE_REACHED']);
export const ProviderRun = z.object({
  provider: z.literal('apify'), actor: z.string(), runId: z.string(), status: z.string(),
  queryFingerprint: z.string(), itemCount: z.number().int().nonnegative(),
  acceptedCount: z.number().int().nonnegative(), costUsd: z.number().nonnegative().nullable(),
}).strict();
export const SourceStatus = z.object({
  status: z.enum(['ok', 'partial', 'timeout', 'error', 'skipped']),
  dataStatus: z.enum(['PRESENT', 'EMPTY', 'UNKNOWN']),
  durationMs: z.number().int().nonnegative(),
  pagesCrawled: count.optional(),
  attorneysSearched: count.optional(),
  attorneysFound: count.optional(),
  reason: text.optional(),
  code: SourceIssueCode.optional(),
  candidatesReceived: count.optional(),
  recordsValid: count.optional(),
  providerRuns: z.array(ProviderRun).optional(),
  costUsd: z.number().nonnegative().nullable().optional(),
}).strict();
export type SourceStatus = z.infer<typeof SourceStatus>;
export type SourceResult<T> = { data: T | null; rawContent: string | null; status: SourceStatus };
export type DirectoryQuery = { canonicalDomain: string; names: string[]; firmName: string | null;
  city: string | null; state: 'FL'; maxTargets?: number };
export interface WebsiteSource {
  run(domain: string, signal: AbortSignal): Promise<SourceResult<WebsiteData>>;
}
export interface DirectorySource {
  run(query: DirectoryQuery, signal: AbortSignal): Promise<SourceResult<AttorneyMatch[]>>;
}

export function unknownWebsite(): WebsiteData {
  return {
    ai_policy: { found: null, depth: null, text_excerpt: null },
    ai_in_services: { found: null, tools_mentioned: null, integration_depth: null },
    ai_disclosure: { found: null, text_excerpt: null },
    ai_blog_posts: { found: null, count: null, titles: null },
    practice_areas: null, team_members: null, team_size: null, team_page_quality: null,
    office_count: null, privacy_policy: { found: null, mentions_client_data: null },
    website_quality: null, firm_established_year: null, firm_name: null, firm_aliases: null,
    city: null, county: null, address_street: null, phone: null, provenance: {},
  };
}

export function unknownAttorney(name: string): Attorney {
  return { name, city: null, county: null, firmName: null, barNumber: null, barStatus: null,
    admissionDate: null, hasDisciplinaryHistory: null, disciplinaryActions: null,
    activeInvestigation: null, avvoRating: null, avvoRatingLevel: null, practiceAreas: null, reviewCount: null,
    averageReviewRating: null, endorsementCount: null, awards: null, awardsCount: null, topAward: null,
    phone: null, addressStreet: null, yearsLicensed: null, licensedSince: null, profileUrl: null };
}

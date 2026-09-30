import { z } from 'zod';

export const Citation = z.object({ segmentId: z.string().min(1).max(160), quote: z.string().trim().min(1).max(1600) }).strict();
const citations = z.array(Citation).max(24);

export const Claim = z.object({
  id: z.string().min(1).max(160),
  field: z.enum([
    'firm_name', 'firm_aliases', 'city', 'county', 'address_street', 'phone', 'office_count',
    'attorneys', 'attorney_count', 'team_page_quality', 'firm_established_year', 'practice_areas',
    'website_quality', 'ai_policy', 'ai_in_services', 'ai_disclosure', 'ai_blog_posts', 'privacy_policy',
  ]),
  value: z.unknown(),
  explanation: z.string().trim().min(1).max(800),
  citations,
}).strict();
export type Claim = z.infer<typeof Claim>;

// The action only steers the next round, and the loop never uses more than these. A longer list
// is trimmed rather than rejected: a rejection costs a full repair call to learn nothing.
const upTo = <T extends z.ZodTypeAny>(item: T, max: number) => z.array(item).min(1).transform(values => values.slice(0, max));
const targetFields = upTo(Claim.shape.field, 8);
const actionReason = z.string().trim().min(1).max(1600);
export const ExtractionAction = z.discriminatedUnion('type', [
  z.object({ type: z.literal('finish'), reason: actionReason }).strict(),
  z.object({ type: z.literal('fetch_pages'), linkIds: upTo(z.string().min(1), 4), targetFields, reason: actionReason }).strict(),
  z.object({ type: z.literal('read_document'), linkIds: upTo(z.string().min(1), 2), targetFields, reason: actionReason }).strict(),
  z.object({ type: z.literal('read_sitemap'), targetFields, reason: actionReason }).strict(),
  z.object({ type: z.literal('find_in_site'), terms: upTo(z.string().trim().min(2).max(60), 6), targetFields, reason: actionReason }).strict(),
]);
export type ExtractionAction = z.infer<typeof ExtractionAction>;
export const SignalExtraction = z.object({ claims: z.array(Claim).max(160), action: ExtractionAction }).strict();
export type SignalExtraction = z.infer<typeof SignalExtraction>;

export const ReviewVerdict = z.object({ claimId: z.string().min(1),
  verdict: z.enum(['supported', 'unsupported', 'uncertain']), reason: z.string().trim().min(1).max(600),
  citations: z.array(Citation).max(24) }).strict();
export const SignalReview = z.object({ verdicts: z.array(ReviewVerdict).max(160) }).strict();
export type SignalReview = z.infer<typeof SignalReview>;

export const GroundingReason = z.enum(['MISSING_CITATION', 'UNKNOWN_SEGMENT', 'QUOTE_NOT_IN_SOURCE',
  'VALUE_NOT_IN_QUOTE', 'UNSUPPORTED_CLAIM', 'UNCERTAIN_ATTRIBUTION', 'CONFLICT', 'INCOMPLETE_SCOPE',
  'INVALID_VALUE', 'DUPLICATE_ID', 'UNSUPPORTED_ABSENCE']);
export const GroundingItem = z.object({ claimId: z.string(), field: Claim.shape.field,
  status: z.enum(['accepted', 'rejected', 'unknown']), reason: GroundingReason.nullable(),
  // Subfields whose negative value was nulled because the citations did not establish the absence.
  degradedFields: z.array(z.string()).optional() }).strict();
export const GroundingReport = z.object({ items: z.array(GroundingItem), accepted: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(), unknown: z.number().int().nonnegative() }).strict();
export type GroundingReport = z.infer<typeof GroundingReport>;

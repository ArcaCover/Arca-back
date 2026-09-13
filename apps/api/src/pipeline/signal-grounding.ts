import { Claim, GroundingReport, WebsiteData, type SignalReview, unknownWebsite } from '@arca/contracts';
import { z } from 'zod';
import type { EvidenceCorpus } from './evidence-corpus.js';
import { normalizeForGrounding } from './evidence-corpus.js';

const nullableText = z.string().trim().min(1).nullable();
const nullableBool = z.boolean().nullable();
const valueSchemas: Record<Claim['field'], z.ZodTypeAny> = {
  firm_name: z.string().trim().min(2), firm_aliases: z.array(z.string().trim().min(2)).max(20),
  city: z.string().trim().min(2), county: z.string().trim().min(2), address_street: z.string().trim().min(3),
  phone: z.string().trim().min(7), office_count: z.number().int().nonnegative().max(1000),
  attorneys: z.array(z.object({ full_name: z.string().trim().min(2), title: nullableText,
    role: z.enum(['attorney', 'staff', 'unclear']), affiliation: z.enum(['current', 'former', 'unclear']) }).strict()).max(100),
  attorney_count: z.number().int().nonnegative().max(10000),
  team_page_quality: z.enum(['detailed', 'names_only', 'no_team_page']),
  firm_established_year: z.number().int().min(1000).max(new Date().getUTCFullYear()),
  practice_areas: z.array(z.enum(['Criminal Defense', 'Immigration', 'Medical Malpractice', 'Personal Injury',
    'IP/Patents', 'Family Law', 'Securities', 'Commercial Litigation', 'Employment Law', 'Bankruptcy',
    'Corporate/M&A', 'Real Estate', 'Tax/Regulatory'])).max(30),
  website_quality: z.enum(['robust', 'basic', 'minimal']),
  ai_policy: z.object({ found: nullableBool, depth: z.enum(['comprehensive', 'basic', 'mention_only', 'none']).nullable() }).strict(),
  ai_in_services: z.object({ found: nullableBool, tools_mentioned: z.array(z.string().trim().min(1)).max(30).nullable(),
    integration_depth: z.enum(['core_service', 'supplementary', 'experimental', 'none_detected']).nullable() }).strict(),
  ai_disclosure: z.object({ found: nullableBool }).strict(),
  ai_blog_posts: z.object({ found: nullableBool, count: z.number().int().nonnegative().max(10000).nullable(),
    titles: z.array(z.string().trim().min(1)).max(100).nullable() }).strict(),
  privacy_policy: z.object({ found: nullableBool, mentions_client_data: nullableBool }).strict(),
};

function quotedValue(claim: Claim, quotes: string[]): boolean {
  const joined = normalizeForGrounding(quotes.join(' ')).toLocaleLowerCase();
  if (['firm_name', 'city', 'county', 'address_street'].includes(claim.field)) {
    return joined.includes(normalizeForGrounding(String(claim.value)).toLocaleLowerCase());
  }
  if (claim.field === 'phone') return joined.replace(/\D/g, '').includes(String(claim.value).replace(/\D/g, ''));
  if (claim.field === 'firm_established_year') return new RegExp(`\\b${claim.value}\\b`).test(joined);
  if (claim.field === 'attorneys') return (claim.value as Array<{ full_name: string }>).every(person =>
    joined.includes(normalizeForGrounding(person.full_name).toLocaleLowerCase()));
  return true;
}

function semanticGuard(claim: Claim, quotes: string[]): GroundingReport['items'][number]['reason'] {
  const joined = normalizeForGrounding(quotes.join(' ')).toLocaleLowerCase();
  if (claim.field === 'firm_established_year' && !/\b(founded|established|fundad[ao]|constitu(?:ida|ido)|cread[ao])\b/.test(joined)) {
    return 'UNSUPPORTED_CLAIM';
  }
  if (claim.field === 'ai_in_services' && (claim.value as { found?: unknown })?.found === true &&
    /\b(no|not|never|does not|do not|sin)\b.{0,35}\b(ai|ia|chatgpt|copilot|harvey)\b/i.test(joined)) return 'CONFLICT';
  if (claim.field === 'attorney_count' && /\b(more than|over|más de|mas de|greater than)\s+\d+\b/i.test(joined)) {
    return 'INCOMPLETE_SCOPE';
  }
  return null;
}

const plain = (value: string) => normalizeForGrounding(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase();
const NEGATION = String.raw`(?:\bno\b|\bnot\b|\bnever\b|\bwithout\b|\bsin\b|\bnunca\b|\bningun[oa]?\b|\bjamas\b|\b(?:do|does|did)n'?t\b)`;
const AI_SUBJECT = String.raw`(?:\bai\b|\ba\.i\.|\bia\b|artificial intelligence|inteligencia artificial|machine learning|aprendizaje automatico|\bgenerativ[ae]\b|chatgpt|copilot|harvey|cocounsel|westlaw edge|lexis\+?\s?ai|\bclaude\b|\bgemini\b)`;
const EXPLICIT_AI_NEGATION = new RegExp(`${NEGATION}.{0,60}${AI_SUBJECT}`);

type AbsenceCheck = { value: unknown; degradedFields: string[]; informative: boolean };
const NEGATIVE_SUBFIELDS: Partial<Record<Claim['field'], Record<string, (value: unknown) => boolean>>> = {
  ai_policy: { found: value => value === false, depth: value => value === 'none' },
  ai_in_services: { found: value => value === false, integration_depth: value => value === 'none_detected',
    tools_mentioned: value => Array.isArray(value) && value.length === 0 },
  ai_disclosure: { found: value => value === false },
  ai_blog_posts: { found: value => value === false, count: value => value === 0,
    titles: value => Array.isArray(value) && value.length === 0 },
  privacy_policy: { found: value => value === false, mentions_client_data: value => value === false },
};

/**
 * A value that asserts absence needs support of its own. Silence in a crawled sample never establishes that a
 * firm lacks an AI policy, so an AI negative survives only with an explicit negation near an AI term. Absences
 * that depend on a whole page or site (no privacy policy, a policy that omits client data, no team page, a zero
 * count) cannot be shown by a quote at all. Unsupported negatives are nulled; positives in the same claim stay.
 * The negation test is necessary rather than sufficient: whose AI use is negated is left to semantic review.
 */
function checkAbsences(claim: Claim, quotes: string[]): AbsenceCheck {
  const unchanged = { value: claim.value, degradedFields: [], informative: true };
  if (claim.field === 'team_page_quality') return claim.value === 'no_team_page'
    ? { value: null, degradedFields: [claim.field], informative: false } : unchanged;
  if (claim.field === 'attorney_count' || claim.field === 'office_count') return claim.value === 0
    ? { value: null, degradedFields: [claim.field], informative: false } : unchanged;
  const negatives = NEGATIVE_SUBFIELDS[claim.field];
  if (!negatives) return unchanged;
  const established = claim.field !== 'privacy_policy' && EXPLICIT_AI_NEGATION.test(plain(quotes.join(' ')));
  const value = { ...(claim.value as Record<string, unknown>) };
  const degradedFields = established ? [] : Object.keys(negatives).filter(key => negatives[key]!(value[key]));
  for (const key of degradedFields) value[key] = null;
  return { value, degradedFields, informative: Object.values(value).some(item => item !== null) };
}

export function acceptClaims(claimsInput: Claim[], review: SignalReview, corpus: EvidenceCorpus): {
  accepted: Claim[]; report: GroundingReport;
} {
  const segments = new Map(corpus.segments.map(segment => [segment.id, segment]));
  const verdicts = new Map(review.verdicts.map(verdict => [verdict.claimId, verdict]));
  const seen = new Set<string>(), accepted: Claim[] = [], items: GroundingReport['items'] = [];
  for (const raw of claimsInput) {
    const parsed = Claim.safeParse(raw);
    if (!parsed.success) continue;
    let claim = parsed.data;
    let reason: GroundingReport['items'][number]['reason'] = null;
    if (seen.has(claim.id)) reason = 'DUPLICATE_ID';
    seen.add(claim.id);
    if (!reason && !valueSchemas[claim.field].safeParse(claim.value).success) reason = 'INVALID_VALUE';
    if (!reason && claim.citations.length === 0) reason = 'MISSING_CITATION';
    const quotes: string[] = [];
    if (!reason) for (const citation of claim.citations) {
      const segment = segments.get(citation.segmentId);
      if (!segment) { reason = 'UNKNOWN_SEGMENT'; break; }
      if (!normalizeForGrounding(segment.text).includes(normalizeForGrounding(citation.quote))) {
        reason = 'QUOTE_NOT_IN_SOURCE'; break;
      }
      quotes.push(citation.quote);
    }
    if (!reason && !quotedValue(claim, quotes)) reason = 'VALUE_NOT_IN_QUOTE';
    if (!reason) reason = semanticGuard(claim, quotes);
    let degradedFields: string[] = [];
    if (!reason) {
      const absence = checkAbsences(claim, quotes);
      if (!absence.informative) {
        items.push({ claimId: claim.id, field: claim.field, status: 'unknown', reason: 'UNSUPPORTED_ABSENCE',
          degradedFields: absence.degradedFields });
        continue;
      }
      claim = { ...claim, value: absence.value };
      degradedFields = absence.degradedFields;
    }
    const verdict = verdicts.get(claim.id);
    if (!reason && (!verdict || verdict.verdict === 'uncertain')) reason = 'UNCERTAIN_ATTRIBUTION';
    if (!reason && verdict?.verdict === 'unsupported') reason = 'UNSUPPORTED_CLAIM';
    if (!reason && verdict?.verdict === 'supported' && verdict.citations.length === 0) reason = 'MISSING_CITATION';
    if (!reason && verdict) for (const citation of verdict.citations) {
      const segment = segments.get(citation.segmentId);
      if (!segment || !normalizeForGrounding(segment.text).includes(normalizeForGrounding(citation.quote))) {
        reason = segment ? 'QUOTE_NOT_IN_SOURCE' : 'UNKNOWN_SEGMENT'; break;
      }
    }
    if (!reason) accepted.push(claim);
    items.push({ claimId: claim.id, field: claim.field, status: reason ? 'rejected' : 'accepted', reason,
      ...(degradedFields.length ? { degradedFields } : {}) });
  }
  const attorneyClaims = accepted.filter(claim => claim.field === 'attorneys');
  const countClaim = accepted.find(claim => claim.field === 'attorney_count');
  if (attorneyClaims.length && countClaim) {
    const observed = new Set(attorneyClaims.flatMap(claim => claim.value as Array<{ full_name: string; role: string; affiliation: string }>)
      .filter(person => person.role === 'attorney' && person.affiliation === 'current')
      .map(person => person.full_name.toLocaleLowerCase())).size;
    if (countClaim.value !== observed) {
      const item = items.find(value => value.claimId === countClaim.id)!;
      item.status = 'rejected'; item.reason = 'INCOMPLETE_SCOPE';
      accepted.splice(accepted.indexOf(countClaim), 1);
    }
  }
  return { accepted, report: GroundingReport.parse({ items, accepted: items.filter(item => item.status === 'accepted').length,
    rejected: items.filter(item => item.status === 'rejected').length,
    unknown: items.filter(item => item.status === 'unknown').length }) };
}

const first = (claims: Claim[], field: Claim['field']) => claims.find(claim => claim.field === field);
export function toWebsiteData(claims: Claim[], corpus: EvidenceCorpus): WebsiteData {
  const data = unknownWebsite();
  const set = <K extends keyof WebsiteData>(field: Claim['field'], target: K) => {
    const claim = first(claims, field); if (claim) data[target] = claim.value as WebsiteData[K];
  };
  set('firm_name', 'firm_name'); set('firm_aliases', 'firm_aliases'); set('city', 'city'); set('county', 'county');
  set('address_street', 'address_street'); set('phone', 'phone'); set('office_count', 'office_count');
  set('team_page_quality', 'team_page_quality'); set('firm_established_year', 'firm_established_year');
  set('practice_areas', 'practice_areas'); set('website_quality', 'website_quality');
  const attorneys = claims.filter(claim => claim.field === 'attorneys')
    .flatMap(claim => claim.value as Array<{ full_name: string; title: string | null; role: string; affiliation: string }>);
  if (attorneys.length) {
    const current = attorneys.filter(person => person.role === 'attorney' && person.affiliation === 'current')
      .map(({ full_name, title }) => ({ full_name, title }));
    if (current.length) data.team_members = current;
  }
  const count = first(claims, 'attorney_count'); if (count) data.team_size = count.value as number;
  const policy = first(claims, 'ai_policy'); if (policy) data.ai_policy = { ...(policy.value as WebsiteData['ai_policy']),
    text_excerpt: policy.citations[0]?.quote ?? null };
  const use = first(claims, 'ai_in_services'); if (use) data.ai_in_services = use.value as WebsiteData['ai_in_services'];
  const disclosure = first(claims, 'ai_disclosure'); if (disclosure) data.ai_disclosure = {
    ...(disclosure.value as { found: boolean | null }), text_excerpt: disclosure.citations[0]?.quote ?? null };
  const blog = first(claims, 'ai_blog_posts'); if (blog) data.ai_blog_posts = blog.value as WebsiteData['ai_blog_posts'];
  const privacy = first(claims, 'privacy_policy'); if (privacy) data.privacy_policy = privacy.value as WebsiteData['privacy_policy'];
  for (const claim of claims) for (const citation of claim.citations) {
    const segment = corpus.segments.find(item => item.id === citation.segmentId); if (!segment) continue;
    const references = data.provenance[claim.field] ??= [];
    if (!references.some(reference => reference.sourceUrl === segment.url && reference.excerpt === citation.quote)) {
      references.push({ sourceUrl: segment.url, excerpt: citation.quote, method: 'provider' });
    }
  }
  return WebsiteData.parse(data);
}

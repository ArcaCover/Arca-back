import type { WebsiteData } from '@arca/contracts';
import { category, observedBoolean } from './math.js';
const rule = (id: string, points: number | null) => ({ id, points, reason: points === null ? 'Evidence unavailable or ambiguous' : 'Evaluated from observed evidence' });

export function aiGovernance(website: WebsiteData) {
  const depth = website.ai_policy.depth;
  const policy = depth === null ? null : depth === 'comprehensive' || depth === 'basic';
  const usage = website.ai_in_services.found;
  const policyPoints = depth === null ? null : ({ comprehensive: 15, basic: 8, mention_only: 3, none: 0 })[depth];
  const usagePoints = usage === false ? 0 : usage === null || policy === null ? null : policy ? 10 : -10;
  return category(35, [rule('W1', policyPoints), rule('W2', usagePoints),
    rule('W3', observedBoolean(website.ai_disclosure.found, 5)), rule('W4', observedBoolean(website.ai_blog_posts.found, 5))]);
}
export type ReputationEvidence = {
  rating: number | null; reviewRating: number | null; reviewCount: number | null;
  awards: boolean | null;
};
export function reputation(data: ReputationEvidence) {
  const rating = data.rating === null ? null : data.rating >= 8 ? 9 : data.rating >= 7 ? 6 : data.rating >= 5 ? 2 : -5;
  const reviews = data.reviewRating === null || data.reviewCount === null ? null :
    data.reviewRating >= 4 ? (data.reviewCount >= 10 ? 5 : 3) : 0;
  return category(20, [rule('A1', rating), rule('A3', reviews), rule('A6', observedBoolean(data.awards, 6))]);
}

export function professionalStanding(data: { allActive: boolean | null; cleanRecord: boolean | null;
  consistency: number | null; experience: number | null; sanctionPenalty: number | null }) {
  return category(30, [rule('B1', observedBoolean(data.allActive, 12)),
    rule('B2_clean', observedBoolean(data.cleanRecord, 10)),
    rule('B3', data.consistency === null ? null : data.consistency > .8 ? 5 : data.consistency < .5 ? -5 : 0),
    rule('B4', data.experience === null ? null : data.experience > 10 ? 3 : data.experience < 3 ? -3 : 0),
    rule('B2_sanction', data.sanctionPenalty)]);
}

export function firmMaturity(website: WebsiteData, areaAgreement: number | null, now: string) {
  const quality = website.website_quality, team = website.team_page_quality;
  const year = website.firm_established_year;
  const currentYear = Number(now.slice(0, 4));
  // The source supplies only a year: evaluate only when the entire possible age interval agrees.
  const minimumAge = year !== null && year <= currentYear ? currentYear - year - 1 : null;
  const maximumAge = year !== null && year <= currentYear ? currentYear - year + 1 : null;
  const agePoints = minimumAge === null || maximumAge === null ? null :
    minimumAge >= 10 ? 3 : maximumAge <= 2 ? -2 : minimumAge >= 2 && maximumAge <= 10 ? 0 : null;
  const privacy = website.privacy_policy;
  const privacyPoints = privacy.found === false || privacy.mentions_client_data === false ? 0 :
    privacy.found === true && privacy.mentions_client_data === true ? 3 : null;
  return category(15, [rule('W7', quality === null ? null : quality === 'robust' ? 3 : quality === 'minimal' ? -3 : 0),
    rule('W6', privacyPoints), rule('W5a', team === null ? null : team === 'detailed' ? 3 : team === 'no_team_page' ? -2 : 0),
    rule('W8', agePoints), rule('W9_A2', areaAgreement === null ? null : areaAgreement >= .8 ? 3 : -3)]);
}

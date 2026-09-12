import { Layer1Result, unknownWebsite, type ScoringInput, type AttorneyMatch, type Signals, type PreScore } from '@arca/contracts';
import { aiGovernance, reputation, professionalStanding, firmMaturity } from './categories.js';
import { mean, sum, allKnownTrue, anyKnownTrue, tierForScore, decisionForTier, restrictDecision } from './math.js';
import { disciplinaryEvidence, yearsSince } from './discipline.js';
import { normalizeAreas, jaccard, PRACTICE_AREAS } from './areas.js';

function uniqueMatches(matches: AttorneyMatch[] | null): AttorneyMatch[] | null {
  if (matches === null) return null;
  const seen = new Set<string>();
  return matches.map(match => {
    if (!match.attorney) return match;
    const person = match.attorney;
    const key = person.barNumber ?? person.profileUrl ?? person.name.toLowerCase();
    if (seen.has(key)) return { ...match, attorney: null, matchConfidence: 'no_match' as const, ambiguous: true };
    seen.add(key); return match;
  });
}
export function scoreEvidence(input: ScoringInput): Pick<Layer1Result, 'preScore' | 'signals' | 'multipliers'> {
  const usable = (name: keyof ScoringInput['sources']) => ['ok', 'partial'].includes(input.sources[name].status);
  const website = (usable('website') ? input.website : null) ?? unknownWebsite();
  const bar = uniqueMatches(usable('bar') ? input.bar : null), avvo = uniqueMatches(usable('avvo') ? input.avvo : null);
  const barPeople = bar?.map(match => match.attorney) ?? [];
  const avvoPeople = avvo?.map(match => match.attorney) ?? [];
  const allActive = allKnownTrue(barPeople.map(person => !person || person.barStatus === null || person.barStatus === 'UNKNOWN' ? null : person.barStatus === 'active'));
  const searched = input.sources.bar.attorneysSearched;
  // Failed or ambiguous name lookups do not assert absence from the registry.
  const consistency = input.sources.bar.status === 'ok' && searched != null && searched > 0 &&
    bar !== null && bar.every(match => match.matchConfidence !== 'firm_fallback' && !match.ambiguous)
    ? barPeople.filter(Boolean).length / searched : null;
  const experience = mean(barPeople.map(person => yearsSince(person?.admissionDate ?? null, input.now)));
  const avvoAreasKnown = avvoPeople.some(person => person?.practiceAreas !== null && person?.practiceAreas !== undefined);
  const avvoAreas = avvoAreasKnown ? normalizeAreas(avvoPeople.flatMap(person => person?.practiceAreas ?? [])) : null;
  const agreement = jaccard(website.practice_areas, avvoAreas);
  const disciplinary = disciplinaryEvidence(bar, avvo, input.now);
  const rep = {
    rating: mean(avvoPeople.map(person => person?.avvoRating ?? null)),
    reviewRating: mean(avvoPeople.map(person => person?.reviewCount === 0 ? null : person?.averageReviewRating ?? null)),
    reviewCount: sum(avvoPeople.map(person => person?.reviewCount ?? null)),
    awards: anyKnownTrue(avvoPeople.map(person => !person ? null : person.awardsCount != null ? person.awardsCount > 0 :
      person.awards === null ? null : person.awards.length > 0)),
  };
  const awardCount = sum(avvoPeople.map(person => person?.awardsCount ?? (person?.awards?.length ?? null)));
  const topAward = avvoPeople.map(person => person?.topAward ?? person?.awards?.[0] ?? null).find(value => value !== null) ?? null;
  const ratingLevels = avvoPeople.map(person => person?.avvoRatingLevel ?? null).filter((value): value is string => value !== null);
  const ratingLevel = ratingLevels.length && new Set(ratingLevels).size === 1 ? ratingLevels[0]! : null;
  const disciplined = anyKnownTrue(avvoPeople.map(person => person?.hasDisciplinaryHistory ?? null));
  const categories = {
    aiGovernance: aiGovernance(website),
    professionalStanding: professionalStanding({ allActive, cleanRecord: disciplinary.cleanRecord, consistency,
      experience, sanctionPenalty: disciplinary.penalty }),
    reputation: reputation(rep), firmMaturity: firmMaturity(website, agreement, input.now),
  };
  const activeInvestigation = disciplinary.overrides.some(override => override.id === 'ACTIVE_INVESTIGATION');
  const total = activeInvestigation ? 0 : sum(Object.values(categories).map(category => category.score));
  const tier = tierForScore(total);
  const okSources = Object.values(input.sources).filter(source => source.status === 'ok').length;
  const flags: string[] = [];
  if (Object.values(input.sources).some(source => source.status !== 'ok')) flags.push('INCOMPLETE_SOURCES');
  if (barPeople.some(person => !person || person.admissionDate === null || person.barStatus === null || person.barStatus === 'UNKNOWN') ||
    avvoPeople.some(person => !person || [person.avvoRating, person.reviewCount, person.averageReviewRating,
      person.awardsCount ?? person.awards, person.practiceAreas].some(value => value === null))) flags.push('PARTIAL_ATTORNEY_DATA');
  if (consistency !== null && consistency < .5) flags.push('LOW_BAR_CONSISTENCY');
  if (Object.values(categories).some(category => category.status !== 'KNOWN')) flags.push('INCOMPLETE_EVIDENCE');
  if (disciplinary.uncertain) flags.push('DISCIPLINARY_DETAILS_UNKNOWN');
  if ([...(bar ?? []), ...(avvo ?? [])].some(match => match.ambiguous)) flags.push('AMBIGUOUS_IDENTITY_MATCH');
  if (barPeople.some(person => person && ['inactive', 'retired', 'deceased'].includes(person.barStatus ?? ''))) flags.push('NON_ACTIVE_ATTORNEY');
  const providerCost = Object.values(input.sources).reduce((total, source) => total + (source.costUsd ?? 0), 0);
  if (providerCost > 1) flags.push('PROVIDER_COST_OVER_BUDGET');
  const assessmentStatus = Object.values(categories).every(category => category.status === 'KNOWN') &&
    !flags.includes('AMBIGUOUS_IDENTITY_MATCH') ? 'SUFFICIENT' as const : 'INSUFFICIENT_EVIDENCE' as const;
  if (assessmentStatus === 'INSUFFICIENT_EVIDENCE') flags.push('COMMERCIAL_DECISION_BLOCKED');
  const decision = restrictDecision(assessmentStatus === 'SUFFICIENT' ? decisionForTier(tier) : 'UNKNOWN', disciplinary.overrides);
  const preScore: PreScore = { total, categories, tier, decision, assessmentStatus,
    confidence: okSources === 3 ? 'HIGH' : okSources === 2 ? 'MEDIUM' : 'LOW', overrides: disciplinary.overrides, flags };
  const points = (category: keyof typeof categories, id: string) => categories[category].rules.find(rule => rule.id === id)?.points ?? null;
  const signals: Signals = {
    website: {
      W1_aiPolicy: { found: website.ai_policy.depth === null ? null : ['comprehensive', 'basic'].includes(website.ai_policy.depth), depth: website.ai_policy.depth, points: points('aiGovernance', 'W1') },
      W2_aiInServices: { found: website.ai_in_services.found, tools: website.ai_in_services.tools_mentioned, points: points('aiGovernance', 'W2') },
      W3_aiDisclosure: { found: website.ai_disclosure.found, points: points('aiGovernance', 'W3') },
      W4_aiBlog: { found: website.ai_blog_posts.found, count: website.ai_blog_posts.count, points: points('aiGovernance', 'W4') },
      W5_teamSize: website.team_size, W5a_teamPageQuality: website.team_page_quality,
      W6_privacyPolicy: { found: website.privacy_policy.found, mentionsClientData: website.privacy_policy.mentions_client_data, points: points('firmMaturity', 'W6') },
      W7_websiteQuality: website.website_quality, W8_firmEstablished: website.firm_established_year, W9_practiceAreas: normalizeAreas(website.practice_areas),
    },
    bar: { B1_allActive: allActive, B2_worstDisciplinary: disciplinary.worstSeverity,
      B3_consistency: consistency, B4_avgExperience: experience, attorneys: bar },
    avvo: { A1_avgRating: rep.rating, A1_ratingLevel: ratingLevel, A2_practiceAreas: avvoAreas,
      A3_avgReviewRating: rep.reviewRating, A3_totalReviews: rep.reviewCount, A6_hasAwards: rep.awards,
      A6_awardsCount: awardCount, A6_topAward: topAward, A8_disciplined: disciplined },
  };
  // Avvo takes precedence on disagreement; all known labels remain in signals for audit.
  const areas = avvoAreas?.length ? avvoAreas : normalizeAreas(website.practice_areas);
  const candidates = PRACTICE_AREAS.filter(item => areas?.includes(item.area)).sort((a, b) => b.value - a.value || a.area.localeCompare(b.area));
  const selected = candidates[0];
  const size = website.team_size;
  const sizeKnown = size !== null && size >= 1;
  return { preScore, signals, multipliers: {
    practiceArea: { area: selected?.area ?? null, value: selected?.value ?? 1, known: selected !== undefined },
    jurisdiction: { state: barPeople.some(Boolean) ? 'FL' : null, value: barPeople.some(Boolean) ? 1.25 : 1, known: barPeople.some(Boolean) },
    size: { teamSize: size, known: sizeKnown, value: !sizeKnown ? 1 : size === 1 ? .9 : size <= 5 ? 1 : size <= 15 ? 1.1 : size <= 30 ? 1.2 : 1.3 },
  } };
}

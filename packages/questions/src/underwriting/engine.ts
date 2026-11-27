import { DOMAIN_LABELS, RenderedQuestion, UnderwritingResult, type AnswerValue, type Layer1Result, type ScoreCategoryKey } from '@arca/contracts';
import { BANK, OPEN_ANSWER_MAX_LENGTH, questionText, type Slots } from './bank.js';
import type { UnderwritingConfig } from './config.js';

/**
 * The bank 4.0 engine (arca-capa2-uw-rules.md §6–§15). Pure and deterministic: the same Layer 1 result, answers and
 * config always give the same questions and the same result. It reads option IDs only, so a form, a broker filling in
 * for a client or a future conversation all feed it the same way, and a stored assessment can be scored again under a
 * later config.
 */
export const UNDERWRITING_SCORING_VERSION = 'underwriting-4.0-engine-1';
export type Answers = Record<string, AnswerValue>;
export type Profile = 'P0' | 'P1' | 'P2' | 'P3' | 'P4';
type Category = 'aidg' | 'ps' | 'fm';
type Level = 'LOW' | 'MEDIUM' | 'HIGH';
const PROFILES: Profile[] = ['P0', 'P1', 'P2', 'P3', 'P4'];
const CATEGORY_KEY: Record<Category, ScoreCategoryKey> = { aidg: 'ai_data_governance', ps: 'professional_standing', fm: 'firm_maturity' };
const atLeast = (profile: Profile, floor: Profile) => PROFILES.indexOf(profile) >= PROFILES.indexOf(floor);
const round2 = (value: number) => Math.round(value * 100) / 100;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

// ---------------------------------------------------------------------------------------------------------------------
// What Layer 1 hands the assessment (§6)

export type Layer1Facts = {
  firmName: string | null;
  /** Area keys of the bands and factors, from Layer 1's practice areas. Empty when it found none. */
  areas: string[];
  websiteRead: boolean;
  /** Whether the website mentions AI in the firm's services: true, false, or null when it could not tell. */
  aiFound: boolean | null;
  aiPolicyFound: boolean;
  /** The tools Layer 1 named, with the G1 option each belongs to (null when no pattern matches). */
  detectedTools: Array<{ name: string; option: string | null }>;
  barVerified: boolean;
  attorneys: number | null;
  state: string | null;
  confidence: Level;
  /** Layer 1's points per category on the config's maximums. A category Layer 1 could not evaluate gives 0. */
  categories: Record<Category, number>;
  /** Layer 1's total on the three categories; null when the website could not be read (there is no public evidence). */
  total: number | null;
  restrictions: Array<{ id: string; decision: 'REFERRAL' | 'REFERRAL_SENIOR' | 'DECLINE' }>;
  reputation: { avvoRating: number | null; reviewCount: number | null; awards: boolean | null };
  flags: string[];
};

export function layer1Facts(layer1: Layer1Result, config: UnderwritingConfig): Layer1Facts {
  const { signals, sources, preScore } = layer1;
  const websiteRead = ['ok', 'partial'].includes(sources.website.status) && !preScore.flags.includes('WEBSITE_UNAVAILABLE');
  const names = [...new Set([...(signals.avvo.A2_practiceAreas ?? []), ...(signals.website.W9_practiceAreas ?? [])])];
  const areas = [...new Set(names.map(name => config.area_keys[name] ?? config.area_keys[name.toLowerCase()] ?? 'other'))].sort();
  const tools = (signals.website.W2_aiInServices.tools ?? []).map(name => ({ name, option: toolOption(name, config) }));
  const rescaled = (raw: { score: number | null; max: number }, max: number) => raw.score === null ? 0 : round2(raw.score / raw.max * max);
  const { categories: maxima } = config.scoring;
  const categories = {
    aidg: rescaled(preScore.categories.aiGovernance, maxima.aidg),
    ps: rescaled(preScore.categories.professionalStanding, maxima.ps),
    fm: rescaled(preScore.categories.firmMaturity, maxima.fm),
  };
  const team = signals.website.W5_teamSize;
  return {
    firmName: layer1.identity?.firmName ?? null, areas, websiteRead,
    aiFound: websiteRead ? signals.website.W2_aiInServices.found : null,
    aiPolicyFound: signals.website.W1_aiPolicy.found === true, detectedTools: websiteRead ? tools : [],
    barVerified: sources.bar.status === 'ok' && signals.bar.B1_allActive !== null,
    attorneys: team !== null && team >= 1 ? Math.round(team) : null,
    state: layer1.multipliers.jurisdiction.state, confidence: preScore.confidence, categories,
    total: websiteRead ? round2(categories.aidg + categories.ps + categories.fm) : null,
    restrictions: preScore.overrides.flatMap(o => o.decision === 'REFERRAL' || o.decision === 'REFERRAL_SENIOR' || o.decision === 'DECLINE'
      ? [{ id: o.id, decision: o.decision }] : []),
    reputation: { avvoRating: signals.avvo.A1_avgRating, reviewCount: signals.avvo.A3_totalReviews, awards: signals.avvo.A6_hasAwards },
    flags: preScore.flags,
  };
}
function toolOption(name: string, config: UnderwritingConfig): string | null {
  const text = name.toLowerCase();
  return Object.entries(config.tool_patterns).find(([, patterns]) => patterns.some(p => text.includes(p)))?.[0] ?? null;
}

// ---------------------------------------------------------------------------------------------------------------------
// The usage profile (§7)

const selected = (answer: AnswerValue | undefined): string[] =>
  !answer ? [] : answer.kind === 'option' ? [answer.optionId] : answer.kind === 'options' ? answer.optionIds : [];

export type Classification = {
  profile: Profile;
  setToLow: string[];
  contradictions: Array<{ layer1Said: string; firmSaid: string }>;
};
export function classify(config: UnderwritingConfig, facts: Layer1Facts, answers: Answers): Classification | null {
  if (!answers.G1 || !answers.G2) return null;
  const c = config.classification;
  const g1 = new Set(selected(answers.G1)), g2 = new Set(selected(answers.G2));
  const setToLow: string[] = [];
  const contradictions: Classification['contradictions'] = [];
  const unsureG1 = g1.has(c.not_sure.g1), unsureG2 = g2.has(c.not_sure.g2);
  // Layer 1's sighting, by G1 option. A mention of AI with no tool it could name still counts as a sighting.
  const sighted = facts.detectedTools.filter(tool => tool.option !== null);
  const sawAi = facts.aiFound === true || facts.detectedTools.length > 0;
  const fromSighting = (): Profile => sighted.map(tool => config.detected_tool_profile[tool.option!] ?? c.fallback)
    .reduce<Profile>((best, p) => atLeast(p, best) ? p : best, c.fallback);
  let profile: Profile;
  if (unsureG1 && unsureG2) {
    profile = c.both_not_sure; setToLow.push('not_sure_on_both_gates');
  } else if (g1.size === 1 && g1.has(c.p0_requires.g1) && g2.size === 1 && g2.has(c.p0_requires.g2)) {
    if (sawAi) {
      // Rule 4: Layer 1 saw tools the firm says it does not use. Not P0; classified from what was seen.
      profile = fromSighting(); setToLow.push('capa1_detected_tools_but_firm_claims_none');
      contradictions.push({ layer1Said: sightingText(facts), firmSaid: 'Uses none of the listed tools and automates nothing' });
    } else profile = 'P0';
  } else {
    const any = (ids: string[]) => ids.some(id => g2.has(id));
    const candidates: Profile[] = [];
    if (any(c.p4_if_g2_any)) candidates.push('P4');
    if (any(c.p3_if_g2_any)) candidates.push('P3');
    if (g2.has(c.drafting_option)) candidates.push(g1.has(c.case_platform_option) ? 'P2' : c.drafting_without_platform);
    if (any(c.p1_if_g2_any)) candidates.push('P1');
    profile = candidates.reduce<Profile>((best, p) => atLeast(p, best) ? p : best, candidates[0] ?? c.fallback);
  }
  // DN-14 §3 decision 13: a contradiction is a tool Layer 1 named that the firm does not tick.
  if (!unsureG1 && !setToLow.includes('capa1_detected_tools_but_firm_claims_none')) {
    for (const option of [...new Set(sighted.map(tool => tool.option!))].sort()) if (!g1.has(option)) {
      contradictions.push({ layer1Said: `The website mentions ${sighted.filter(t => t.option === option).map(t => t.name).join(', ')}`,
        firmSaid: `Did not select “${BANK.G1!.options[option]}”` });
    }
  }
  return { profile, setToLow, contradictions };
}
function sightingText(facts: Layer1Facts) {
  return facts.detectedTools.length ? `The website mentions ${facts.detectedTools.map(t => t.name).join(', ')}` : 'The website mentions AI in the firm’s services';
}

// ---------------------------------------------------------------------------------------------------------------------
// Selection (§8)

export type Selection = {
  profile: Profile | null;
  /** In the order they are asked. Before G1 and G2 are answered, only the questions that come before the profile. */
  asked: string[];
  dropped: Array<{ id: string; reason: 'cap' | 'not_triggered' }>;
  knockoutDropped: boolean;
  /** The question asked for the practice area, once known. */
  areaQuestion: string | null;
};
const PENDING_AREA = '@pending_area';

function areaKeysFromAnswers(config: UnderwritingConfig, facts: Layer1Facts, answers: Answers): string[] {
  if (facts.areas.length) return facts.areas;
  return [...new Set(selected(answers.F2).map(id => config.area_keys[id] ?? 'other'))].sort();
}
/** The primary area: Layer 1 names no primary, so it is the highest-factor area (§14 C), ties by key. */
export function primaryArea(config: UnderwritingConfig, areas: string[]): string {
  const factor = (key: string) => config.pricing.area_factors[key] ?? config.pricing.area_factors.other ?? 1;
  return [...areas].sort((a, b) => factor(b) - factor(a) || a.localeCompare(b))[0] ?? 'other';
}

export function select(config: UnderwritingConfig, facts: Layer1Facts, answers: Answers): Selection {
  const classification = classify(config, facts, answers);
  const profile = classification?.profile ?? null;
  const noAreas = facts.areas.length === 0;
  const f2Pending = noAreas && !answers.F2;
  const areaQuestion = f2Pending ? null : config.area_question[primaryArea(config, areaKeysFromAnswers(config, facts, answers))] ?? 'E-other';
  const ordered: string[] = [];
  const notTriggered: string[] = [];
  for (const entry of config.selection_priority) {
    const ids = entry.ids.flatMap(raw => {
      if (!raw.startsWith('@')) return [raw];
      if (!profile) return [];
      const primary = config.profile_primary[profile]!, knockouts = config.profile_knockouts[profile]!;
      if (raw === '@profile_primary') return [primary];
      if (raw === '@profile_knockouts') return knockouts;
      if (raw === '@profile_rest') return config.profiles[profile].questions.filter(id => id !== primary && !knockouts.includes(id));
      if (raw === '@practice_area') return [areaQuestion ?? PENDING_AREA];
      return [];
    });
    for (const id of ids) {
      const applies = entry.when === 'always' ? true
        : entry.when === 'capa1_no_areas' ? noAreas
        : entry.when === 'capa1_bar_failed' ? !facts.barVerified
        // A profile-dependent question waits for the gates; once they are answered it applies or it does not.
        : profile === null ? null
        : entry.when === 'profile_ge_P1' ? atLeast(profile, 'P1') : atLeast(profile, 'P3');
      if (applies === null) continue;
      if (!applies) { notTriggered.push(id); continue; }
      if (!ordered.includes(id)) ordered.push(id);
    }
  }
  const asked = ordered.slice(0, config.question_cap);
  const capped = profile ? ordered.slice(config.question_cap) : [];
  // DN-14 §3 decision 16: any question the cap drops that carries a knockout option counts as a dropped knockout.
  const knockoutDropped = capped.some(id => config.questions[id]?.options.some(o => o.ko));
  return {
    profile, asked: asked.filter(id => id !== PENDING_AREA), areaQuestion,
    dropped: [...capped.filter(id => id !== PENDING_AREA).map(id => ({ id, reason: 'cap' as const })),
      ...(profile ? notTriggered.filter(id => !ordered.includes(id)).map(id => ({ id, reason: 'not_triggered' as const })) : [])],
    knockoutDropped,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Rendering and validating one question

export function slots(config: UnderwritingConfig, facts: Layer1Facts, answers: Answers): Slots {
  const key = primaryArea(config, areaKeysFromAnswers(config, facts, answers));
  return { firmName: facts.firmName, primaryPracticeArea: key === 'other' ? null : AREA_LABELS[key] ?? null };
}
const AREA_LABELS: Record<string, string> = {
  criminal: 'criminal defense', immigration: 'immigration', medical_malpractice: 'medical malpractice',
  personal_injury: 'personal injury', ip_patents: 'intellectual property', family: 'family law', securities: 'securities',
  commercial_litigation: 'commercial litigation', employment: 'employment law', bankruptcy: 'bankruptcy',
  corporate_ma: 'corporate and M&A work', consumer: 'consumer law', real_estate: 'real estate', tax: 'tax',
};
/** The bank entry for a question as asked: P3-3 has two variants, chosen by whether Layer 1 found a policy. */
function bankEntry(id: string, facts: Layer1Facts) {
  return id === 'P3-3' ? BANK[facts.aiPolicyFound ? 'P3-3a' : 'P3-3b']! : BANK[id]!;
}
export function renderQuestion(config: UnderwritingConfig, facts: Layer1Facts, answers: Answers, id: string): RenderedQuestion {
  const entry = bankEntry(id, facts), question = config.questions[id]!;
  const domain = question.category ? CATEGORY_KEY[question.category] : 'firm_profile';
  return RenderedQuestion.parse({
    id, domain, domainLabel: DOMAIN_LABELS[domain], type: entry.type, text: questionText(entry, slots(config, facts, answers)),
    help: entry.help, context: null, scored: question.category !== null && !question.open, evidence: [],
    options: entry.type === 'text' ? null : question.options.map(o => ({ id: o.id, label: entry.options[o.id]!, exclusive: o.exclusive ?? false })),
    scale: null, number: null, textInput: entry.type === 'text' ? { maxLength: OPEN_ANSWER_MAX_LENGTH } : null, suggestedAnswer: null,
  });
}
export function validUnderwritingAnswer(config: UnderwritingConfig, id: string, answer: AnswerValue): boolean {
  const question = config.questions[id], entry = BANK[id === 'P3-3' ? 'P3-3a' : id];
  if (!question || !entry) return false;
  const known = (option: string) => question.options.some(o => o.id === option);
  if (entry.type === 'text') return answer.kind === 'text' && answer.value.length <= OPEN_ANSWER_MAX_LENGTH;
  if (entry.type === 'single_select') return answer.kind === 'option' && known(answer.optionId);
  if (answer.kind !== 'options' || new Set(answer.optionIds).size !== answer.optionIds.length || !answer.optionIds.every(known)) return false;
  return answer.optionIds.length === 1 || !answer.optionIds.some(option => question.options.find(o => o.id === option)!.exclusive);
}
/** The questions asked under these answers, and only the answers to them that are still valid. */
export function reconcile(config: UnderwritingConfig, facts: Layer1Facts, answers: Answers): { selection: Selection; answers: Answers } {
  let current = { ...answers };
  for (let i = 0; i < 4; i++) {
    const selection = select(config, facts, current);
    const next = Object.fromEntries(Object.entries(current).filter(([id, a]) => selection.asked.includes(id) && validUnderwritingAnswer(config, id, a)));
    if (Object.keys(next).length === Object.keys(current).length) return { selection, answers: next };
    current = next;
  }
  return { selection: select(config, facts, current), answers: current };
}

// ---------------------------------------------------------------------------------------------------------------------
// Points (§10)

/** One question's points. A checklist takes the worst box it ticks: its boxes overlap, so a sum counts one event twice. */
export function questionPoints(config: UnderwritingConfig, id: string, answer: AnswerValue | undefined): number {
  const question = config.questions[id];
  if (!question || question.category === null || !answer) return 0;
  const points = selected(answer).map(option => question.options.find(o => o.id === option)?.points ?? 0);
  return points.length ? Math.min(...points) : 0;
}
const bestOption = (config: UnderwritingConfig, id: string) =>
  [...(config.questions[id]?.options ?? [])].filter(o => typeof o.points === 'number').sort((a, b) => b.points! - a.points! || a.id.localeCompare(b.id))[0];

// ---------------------------------------------------------------------------------------------------------------------
// Pricing (§14)

export type PremiumInput = {
  attorneys: number; supportStaff: number; attorneyCountAssumed?: boolean; peopleCountLowerBound?: boolean;
  areas: string[]; primary?: string; score: number; confidence: 'HIGH' | 'MEDIUM'; limit: number; state: string | null;
};
export function premium(config: UnderwritingConfig, input: PremiumInput) {
  const p = config.pricing;
  const exposureUnits = input.attorneys + input.supportStaff * p.support_staff_weight;
  let ratedUnits = 0, floor = 0;
  for (const band of p.graduated_bands) {
    const top = band.up_to_units ?? Infinity;
    ratedUnits += Math.max(0, Math.min(exposureUnits, top) - floor) * band.weight;
    floor = top;
    if (exposureUnits <= top) break;
  }
  const factor = (key: string) => p.area_factors[key] ?? p.area_factors.other ?? 1;
  const primary = input.primary ?? primaryArea(config, input.areas);
  const others = input.areas.filter(area => area !== primary);
  const areaFactor = others.length
    ? p.area_factor_primary_weight * factor(primary) + p.area_factor_others_weight * (others.reduce((s, a) => s + factor(a), 0) / others.length)
    : factor(primary);
  const riskFactor = clamp(p.risk_factor.intercept - input.score / 100 * p.risk_factor.slope, p.risk_factor.min, p.risk_factor.max);
  const confidenceLoad = config.confidence.premium_load[input.confidence];
  const limitFactor = p.limit_factors[String(input.limit)];
  if (limitFactor === undefined) throw new Error(`No limit factor for ${input.limit}`);
  const jurisdictionFactor = (input.state ? p.jurisdiction_factors[input.state] : undefined) ?? p.jurisdiction_factors._default ?? 1;
  const raw = ratedUnits * p.rate_per_unit * areaFactor * riskFactor * confidenceLoad * limitFactor * jurisdictionFactor;
  const annualPremium = Math.round(Math.max(p.minimum_premium, raw));
  return { annualPremium, buildUp: {
    attorneys: input.attorneys, supportStaff: input.supportStaff, attorneyCountAssumed: input.attorneyCountAssumed ?? false,
    peopleCountLowerBound: input.peopleCountLowerBound ?? false, exposureUnits: round2(exposureUnits), ratedUnits: Math.round(ratedUnits * 1e4) / 1e4,
    ratePerUnit: p.rate_per_unit, areaFactor: Math.round(areaFactor * 1e4) / 1e4, riskFactor: Math.round(riskFactor * 1e4) / 1e4,
    confidenceLoad, limitFactor, jurisdictionFactor, minimumApplied: raw < p.minimum_premium,
  } };
}

// ---------------------------------------------------------------------------------------------------------------------
// The result (§10–§15)

type AskedQuestion = NonNullable<UnderwritingResult['audit']>['questionsAsked'][number];
export type ScoreInput = {
  config: UnderwritingConfig; layer1: Layer1Result; answers: Answers; assessmentId: string; completedAt: string;
  bookingUrl: string; completed?: boolean;
};
export function scoreUnderwriting({ config, layer1, answers: given, assessmentId, completedAt, bookingUrl, completed = true }: ScoreInput): UnderwritingResult {
  const facts = layer1Facts(layer1, config);
  const { selection, answers } = reconcile(config, facts, given);
  const classification = classify(config, facts, answers);
  // An assessment can only be scored once the gates classify it; without them it was abandoned before it began.
  const profile = selection.profile ?? config.classification.fallback;
  const textSlots = slots(config, facts, answers);
  const finished = completed && !!classification && selection.asked.every(id => answers[id] !== undefined);

  // Points per category: Layer 1 rescaled plus the answers, clamped (§10).
  const layer2: Record<Category, number> = { aidg: 0, ps: 0, fm: 0 };
  const asked: AskedQuestion[] = [];
  for (const id of selection.asked) {
    const answer = answers[id], question = config.questions[id]!;
    if (!answer) continue;
    const points = questionPoints(config, id, answer);
    if (question.category) layer2[question.category] += points;
    const entry = bankEntry(id, facts);
    asked.push({ id, optionIds: selected(answer), questionTextAsAsked: questionText(entry, textSlots),
      answerText: answer.kind === 'text' ? answer.value : selected(answer).map(o => entry.options[o] ?? o).join('; '),
      pointsApplied: points, category: question.category ? CATEGORY_KEY[question.category] : null });
  }
  const p0 = config.profiles.P0;
  const p0Verified = facts.websiteRead && facts.aiFound === false;
  if (profile === 'P0' && classification) layer2[p0.award_category] += p0Verified ? p0.award_verified : p0.award_unverified;
  const maxima = config.scoring.categories;
  const categories = (['aidg', 'ps', 'fm'] as const).map(key => ({
    key: CATEGORY_KEY[key], label: DOMAIN_LABELS[CATEGORY_KEY[key]], max: maxima[key],
    layer1: facts.categories[key], layer2: layer2[key], score: round2(clamp(facts.categories[key] + layer2[key], 0, maxima[key])),
  }));
  const score = round2(categories.reduce((sum, c) => sum + c.score, 0));
  const tier = config.tiers_display_only.find(t => score >= t.min)?.label ?? 'CRITICAL';

  // Confidence: starts at Layer 1's and only moves down (§11).
  const levels = config.confidence.levels;
  let level: Level = facts.confidence;
  const downgrades: Array<{ reason: string; from: Level; to: Level }> = [];
  const down = (reason: string) => { const to = levels[Math.max(0, levels.indexOf(level) - 1)]!; if (to !== level) downgrades.push({ reason, from: level, to }); level = to; };
  const toLow = (reason: string) => { if (level !== 'LOW') downgrades.push({ reason, from: level, to: 'LOW' }); level = 'LOW'; };
  const contradictions = [...(classification?.contradictions ?? [])];
  const f1 = selected(answers.F1)[0];
  const people = f1 ? config.f1_people[f1] : undefined;
  if (people?.max != null && facts.attorneys !== null && facts.attorneys > people.max) {
    contradictions.push({ layer1Said: `The website lists ${facts.attorneys} attorneys`, firmSaid: `${BANK.F1!.options[f1!]} people work at the firm` });
  }
  if (contradictions.length) down('answer_contradicts_capa1');
  const notSure = asked.filter(a => a.category !== null && a.optionIds.some(o => o.endsWith('-unsure'))).length;
  if (notSure >= config.confidence.not_sure_downgrade_count) down('three_or_more_not_sure_on_scored_questions');
  if (profile === 'P0' && classification && !p0Verified) down('p0_award_unverified');
  for (const reason of classification?.setToLow ?? []) toLow(reason);
  if (!people) toLow('f1_unanswered');

  // Exposure: size and area set how high the score must be (§13).
  const totalPeople = Math.max(people?.count ?? (facts.attorneys !== null ? Math.ceil(facts.attorneys / config.pricing.default_attorney_share) : 1), facts.attorneys ?? 0);
  const sizeBand = config.exposure.size_bands.find(b => b.max_people === null || totalPeople <= b.max_people)!.band;
  const areas = areaKeysFromAnswers(config, facts, answers);
  const primary = primaryArea(config, areas.length ? areas : ['other']);
  const bands = config.exposure.area_bands;
  const areaBand = bands.High.includes(primary) ? 'High' : bands.Medium.includes(primary) ? 'Medium' : 'Low';
  const exposureLevel = config.exposure.matrix[sizeBand]![areaBand]!;
  const thresholds = config.exposure.thresholds[exposureLevel]!;

  // Knockouts and routes to a person (§12, DN-14 §3 decisions 6, 9 and 12).
  const knockouts: Array<{ questionId: string; optionId: string; forced: 'REFERRAL' | 'REFERRAL_SENIOR' }> = [];
  let routeToHuman = false;
  const claims = selected(answers.C1).filter(o => o !== 'C1-none' && o !== 'C1-unsure');
  for (const id of selection.asked) for (const optionId of selected(answers[id])) {
    const option = config.questions[id]!.options.find(o => o.id === optionId);
    if (!option) continue;
    if (option.ko) knockouts.push({ questionId: id, optionId, forced: option.ko === 'referral_senior' ? 'REFERRAL_SENIOR' : 'REFERRAL' });
    if (option.ko_if_also === 'any_C1_claim' && claims.length) knockouts.push({ questionId: id, optionId, forced: 'REFERRAL' });
    if (option.route_human && config.route_human_effect[optionId] === 'schedule') routeToHuman = true;
  }
  if (answers['E-other'] && config.route_human_effect['EO-open'] === 'schedule') routeToHuman = true;
  for (const r of facts.restrictions) knockouts.push({ questionId: 'LAYER1', optionId: r.id, forced: r.decision === 'REFERRAL' ? 'REFERRAL' : 'REFERRAL_SENIOR' });

  // The decision order: the first rule that applies (§13).
  const senior = score < config.referral_senior_below_score;
  const refer = (rule: string, isSenior: boolean) => ({ rule, kind: isSenior ? 'REFERRAL_SENIOR' as const : 'REFERRAL' as const });
  const decision = knockouts.length ? refer('knockout', knockouts.some(k => k.forced === 'REFERRAL_SENIOR'))
    : selection.knockoutDropped ? refer('knockout_question_dropped', false)
    : routeToHuman ? refer('route_to_human', false)
    : !finished ? refer('abandoned', false)
    : score < config.decline_below_score ? { rule: 'below_decline_floor', kind: 'DECLINE' as const }
    : (level === 'LOW' && config.confidence.low_blocks_auto_bind) || !people ? refer('low_confidence', senior)
    : exposureLevel === 'E4' || thresholds.auto_bind === null ? refer('exposure_e4', senior)
    : score >= thresholds.auto_bind ? { rule: 'auto_bind', kind: 'AUTO_BIND' as const }
    : thresholds.conditions !== null && score >= thresholds.conditions ? { rule: 'bind_with_conditions', kind: 'CONDITIONS' as const }
    : refer(senior ? 'referral_senior_score' : 'referral_score', senior);

  // What each lost-points answer would gain: the action plan, and the conditions of a bind with conditions (§13).
  const losses = asked.flatMap(a => {
    const question = config.questions[a.id]!, best = bestOption(config, a.id);
    if (!question.category || question.open || !best) return [];
    const lost = best.points! - a.pointsApplied;
    if (lost <= 0) return [];
    const entry = bankEntry(a.id, facts);
    return [{ id: a.id, lost, category: question.category, why: a.questionTextAsAsked, what: entry.options[best.id] ?? best.id }];
  }).sort((x, y) => y.lost - x.lost || x.id.localeCompare(y.id));
  const actionPlan = losses.flatMap(loss => {
    const category = categories.find(c => c.key === CATEGORY_KEY[loss.category])!;
    const gain = round2(Math.min(loss.lost, category.max - category.score));
    return gain > 0 ? [{ id: `improve:${loss.id}`, domain: CATEGORY_KEY[loss.category], title: loss.why, detail: `Next step: ${loss.what}.`, pointsGain: gain }] : [];
  });

  let outcome: UnderwritingResult['outcome'];
  if (decision.kind === 'AUTO_BIND' || decision.kind === 'CONDITIONS') {
    const attorneys = facts.attorneys ?? Math.max(1, Math.round((people!.count) * config.pricing.default_attorney_share));
    const total = Math.max(people!.count, attorneys);
    const priceFor = (limit: number) => premium(config, { attorneys, supportStaff: total - attorneys,
      attorneyCountAssumed: facts.attorneys === null, peopleCountLowerBound: people!.max === null, areas: areas.length ? areas : ['other'],
      primary, score, confidence: level as 'HIGH' | 'MEDIUM', limit, state: facts.state });
    const limits = Object.keys(config.pricing.limit_factors).map(Number).sort((a, b) => a - b);
    outcome = { type: 'quote', quote: { currency: 'USD', indicative: true, defaultLimit: config.pricing.default_limit,
      limits: limits.map(limit => ({ limit, annualPremium: priceFor(limit).annualPremium })),
      buildUp: priceFor(config.pricing.default_limit).buildUp,
      conditions: decision.kind === 'CONDITIONS' ? losses.slice(0, config.conditions.max).map(loss => ({
        what: loss.what, why: loss.why, dueDays: config.conditions.due_days, fromQuestion: loss.id })) : [] } };
  } else if (decision.kind === 'DECLINE') {
    outcome = { type: 'declined', declined: { bookingUrl, reassessAfterDays: config.decline_reassess_days,
      message: `We can’t offer coverage on these answers today. The steps below show what would change that, and you can reassess in ${config.decline_reassess_days} days.` } };
  } else {
    const isSenior = decision.kind === 'REFERRAL_SENIOR';
    outcome = { type: 'schedule', schedule: { bookingUrl, withWhom: isSenior ? 'senior underwriter' : 'underwriter',
      message: `A ${isSenior ? 'senior underwriter' : 'member of our underwriting team'} will go through your answers with you. Pick a time that suits you.` } };
  }

  const audit = { decisionRuleFired: decision.rule, knockoutsFired: knockouts, questionsAsked: asked,
    questionsDropped: selection.dropped, knockoutQuestionDropped: selection.knockoutDropped };
  const flags = new Set<string>(['PROVISIONAL_RATES']);
  if (!facts.websiteRead) flags.add('LAYER1_UNAVAILABLE');
  if (outcome.type === 'quote' && outcome.quote.buildUp.attorneyCountAssumed) flags.add('ATTORNEY_COUNT_ASSUMED');
  if (contradictions.length) flags.add('LAYER1_CONTRADICTION');
  if (answers['E-other']) flags.add('OPEN_ANSWER_FOR_UNDERWRITER');
  return UnderwritingResult.parse({
    assessmentId, scanId: layer1.scanId, bankVersion: config.bank_version, bankStatus: 'PROVISIONAL', configVersion: config.config_version,
    scoringVersion: UNDERWRITING_SCORING_VERSION, completed: finished, layer1Score: facts.total, compositeScore: score, tier, categories,
    confidence: { level, startedAt: facts.confidence, downgrades, contradictions },
    exposure: { usageProfile: profile, sizeBand, areaBand, level: exposureLevel, autoBindThreshold: thresholds.auto_bind, conditionsThreshold: thresholds.conditions },
    outcome, reputationContext: facts.reputation, actionPlan, flags: [...flags].sort(), audit,
    underwriterSummary: summary({ facts, profile, score, level, exposureLevel, sizeBand, areaBand, decision: decision.rule, knockouts,
      contradictions, openAnswer: answers['E-other']?.kind === 'text' ? answers['E-other'].value : null, dropped: selection.dropped, outcome }),
    completedAt,
  });
}

/** The underwriter's summary, written from the audit alone: the same facts always give the same words (DN-14 §3 decision 3). */
function summary(s: { facts: Layer1Facts; profile: Profile; score: number; level: Level; exposureLevel: string; sizeBand: string;
  areaBand: string; decision: string; knockouts: Array<{ questionId: string; optionId: string; forced: string }>;
  contradictions: Array<{ layer1Said: string; firmSaid: string }>; openAnswer: string | null;
  dropped: Array<{ id: string; reason: string }>; outcome: UnderwritingResult['outcome'] }): string {
  const name = s.facts.firmName ?? 'The firm';
  const lines = [`${name}: usage profile ${s.profile}, score ${s.score}, confidence ${s.level}, exposure ${s.exposureLevel} (${s.sizeBand} firm, ${s.areaBand}-risk area).`];
  const rule: Record<string, string> = {
    knockout: 'Referred by a knockout answer.', knockout_question_dropped: 'Referred: the question cap dropped a question that can knock out, so the assessment is not complete.',
    route_to_human: 'Referred: the firm was not sure about its claims or its current policy.', abandoned: 'Referred: the assessment was not finished.',
    below_decline_floor: 'Declined: the score is below the floor.', low_confidence: 'Referred: confidence is LOW, so it cannot bind without a person.',
    exposure_e4: 'Referred: a large firm in a high-risk area never binds without a person, whatever the score.',
    auto_bind: 'Auto-bind: the score meets the threshold for this exposure.', bind_with_conditions: 'Bind with conditions: the score meets the conditions threshold for this exposure.',
    referral_score: 'Referred: the score is below the threshold for this exposure.', referral_senior_score: 'Senior referral: the score is between 25 and 44.',
  };
  lines.push(rule[s.decision] ?? s.decision);
  for (const k of s.knockouts) lines.push(k.questionId === 'LAYER1' ? `Layer 1 restriction: ${k.optionId}.` : `Knockout: ${k.questionId} answered ${k.optionId}.`);
  for (const c of s.contradictions) lines.push(`Differs from Layer 1 (recorded, not confronted): ${c.layer1Said}; the firm answered: ${c.firmSaid}.`);
  if (s.dropped.some(d => d.reason === 'cap')) lines.push(`Not asked because of the 10-question cap: ${s.dropped.filter(d => d.reason === 'cap').map(d => d.id).join(', ')}.`);
  if (s.openAnswer) lines.push(`Open answer for review: “${s.openAnswer}”`);
  if (!s.facts.websiteRead) lines.push('The website could not be read: Layer 1 contributed no public evidence.');
  if (s.outcome.type === 'quote' && s.outcome.quote.conditions.length) lines.push(`Conditions: ${s.outcome.quote.conditions.map(c => c.fromQuestion).join(', ')}.`);
  return lines.join('\n');
}

/** What the firm receives: the record without the underwriter's audit and summary. */
export function publicResult(result: UnderwritingResult): UnderwritingResult {
  return { ...result, audit: null, underwriterSummary: null };
}

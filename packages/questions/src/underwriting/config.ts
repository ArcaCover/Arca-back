import { z } from 'zod';

/**
 * Bank 4.0's underwriting configuration (arca-capa2-uw-rules.md). Every tunable number lives here and nowhere else in the
 * engine. Keys follow the published capa2_config.json, so the exported JSON runs through the founder's validate_capa2.py
 * unchanged (see tools/underwriting). A published version is never edited in place: a change is a new file and a new
 * `config_version`, and every assessment records the version it was scored with.
 */
const Category = z.enum(['aidg', 'ps', 'fm']);
const Ko = z.enum(['referral', 'referral_senior']).nullable();
const Option = z.object({
  id: z.string().min(1), points: z.number().finite().optional(), ko: Ko.optional(),
  /** Cannot be combined with another option of a checklist ("None of these", "Not sure"). */
  exclusive: z.boolean().optional(),
  route_human: z.boolean().optional(), ko_if_also: z.literal('any_C1_claim').optional(),
}).strict();
const Question = z.object({
  category: Category.nullable(), module: z.string(), type: z.enum(['single', 'checklist', 'open']).optional(),
  when: z.string().optional(), open: z.boolean().optional(), variants: z.array(z.string()).optional(),
  options: z.array(Option),
}).strict();
const When = z.enum(['always', 'capa1_no_areas', 'capa1_bar_failed', 'profile_ge_P1', 'profile_ge_P3']);
const ProfileKey = z.enum(['P0', 'P1', 'P2', 'P3', 'P4']);
const Level = z.enum(['LOW', 'MEDIUM', 'HIGH']);

export const UnderwritingConfig = z.object({
  _comment: z.string().optional(),
  config_version: z.string().regex(/^\d+\.\d+\.\d+$/), bank_version: z.string(),
  scoring: z.object({
    categories: z.object({ aidg: z.number().positive(), ps: z.number().positive(), fm: z.number().positive() }).strict(),
    reputation_scored: z.literal(false),
    capa1_rescale_from_original: z.object({ aidg: z.tuple([z.number(), z.number()]), ps: z.tuple([z.number(), z.number()]),
      fm: z.tuple([z.number(), z.number()]) }).strict(),
  }).strict(),
  question_cap: z.number().int().positive(),
  tiers_display_only: z.array(z.object({ min: z.number(), label: z.enum(['FORTRESS', 'FORTIFIED', 'GUARDED', 'EXPOSED', 'CRITICAL']) }).strict()),
  exposure: z.object({
    size_bands: z.array(z.object({ max_people: z.number().nullable(), band: z.enum(['Small', 'Medium', 'Large']) }).strict()),
    area_bands: z.object({ High: z.array(z.string()), Medium: z.array(z.string()), Low: z.array(z.string()) }).strict(),
    matrix: z.record(z.enum(['Small', 'Medium', 'Large']), z.record(z.enum(['Low', 'Medium', 'High']), z.enum(['E1', 'E2', 'E3', 'E4']))),
    thresholds: z.record(z.enum(['E1', 'E2', 'E3', 'E4']), z.object({ auto_bind: z.number().nullable(), conditions: z.number().nullable() }).strict()),
  }).strict(),
  decline_below_score: z.number(), referral_senior_below_score: z.number(),
  confidence: z.object({
    levels: z.tuple([z.literal('LOW'), z.literal('MEDIUM'), z.literal('HIGH')]),
    low_blocks_auto_bind: z.boolean(),
    premium_load: z.object({ HIGH: z.number().positive(), MEDIUM: z.number().positive(), LOW: z.null() }).strict(),
    downgrade_one_level: z.array(z.string()), set_to_low: z.array(z.string()),
    not_sure_downgrade_count: z.number().int().positive(),
  }).strict(),
  pricing: z.object({
    rate_per_unit: z.number().positive(), minimum_premium: z.number().positive(),
    support_staff_weight: z.number().nonnegative(), default_attorney_share: z.number().positive().max(1),
    graduated_bands: z.array(z.object({ up_to_units: z.number().nullable(), weight: z.number().positive() }).strict()),
    area_factor_primary_weight: z.number(), area_factor_others_weight: z.number(),
    area_factors: z.record(z.string(), z.number().positive()),
    risk_factor: z.object({ intercept: z.number(), slope: z.number(), min: z.number(), max: z.number() }).strict(),
    limit_factors: z.record(z.string().regex(/^\d+$/), z.number().positive()),
    default_limit: z.number().int().positive(),
    jurisdiction_factors: z.record(z.string(), z.number().positive()),
  }).strict(),
  profiles: z.object({
    P0: z.object({ questions: z.array(z.string()), award_verified: z.number(), award_unverified: z.number(), award_category: Category }).strict(),
    P1: z.object({ questions: z.array(z.string()) }).strict(), P2: z.object({ questions: z.array(z.string()) }).strict(),
    P3: z.object({ questions: z.array(z.string()) }).strict(), P4: z.object({ questions: z.array(z.string()) }).strict(),
  }).strict(),
  selection_priority: z.array(z.object({ rank: z.number().int(), ids: z.array(z.string()), when: When, protected: z.boolean() }).strict()),
  profile_primary: z.record(ProfileKey, z.string()),
  profile_knockouts: z.record(ProfileKey, z.array(z.string())),
  questions: z.record(z.string(), Question),

  // --- Added in 1.1.0: what 1.0.0 left to the engine's judgment (DN-14 §3). ---
  /** How G1 and G2 classify the firm. The highest profile whose rule matches wins; no match and not P0 is `fallback`. */
  classification: z.object({
    p4_if_g2_any: z.array(z.string()), p3_if_g2_any: z.array(z.string()),
    drafting_option: z.string(), case_platform_option: z.string(),
    /** Drafting inside a case platform is P2; drafting with any other tool is legal work done with it, so P3. */
    drafting_without_platform: ProfileKey,
    p1_if_g2_any: z.array(z.string()),
    p0_requires: z.object({ g1: z.string(), g2: z.string() }).strict(),
    not_sure: z.object({ g1: z.string(), g2: z.string() }).strict(),
    both_not_sure: ProfileKey, fallback: ProfileKey,
  }).strict(),
  /** F1's ranges: the size band comes from the range, the premium from `count` (its midpoint). */
  f1_people: z.record(z.string(), z.object({ min: z.number().int().positive(), max: z.number().int().positive().nullable(),
    count: z.number().int().positive() }).strict()),
  /** Layer 1's practice-area names and F2's options, mapped to the area keys of the bands and factors. */
  area_keys: z.record(z.string(), z.string()),
  /** The practice-area question each area key asks; a key without an entry asks E-other. */
  area_question: z.record(z.string(), z.string()),
  /** Which G1 option each tool Layer 1 named on the website belongs to, by case-insensitive pattern. */
  tool_patterns: z.record(z.string(), z.array(z.string())),
  /** The lowest profile a firm can be when Layer 1 saw a tool of that G1 option and the firm reports none. */
  detected_tool_profile: z.record(z.string(), ProfileKey),
  /** What a "route to human" option does: `schedule` sends the firm to an underwriter, `summary` only informs one. */
  route_human_effect: z.record(z.string(), z.enum(['schedule', 'summary'])),
  conditions: z.object({ max: z.number().int().positive(), due_days: z.number().int().positive() }).strict(),
  decline_reassess_days: z.number().int().positive(),
}).strict().superRefine((config, ctx) => {
  // The structural half of the founder's validator: what a TypeScript type cannot say. The full report, with the budget per
  // profile, the ceiling and the floor, is validateConfig() in validate.ts.
  const issue = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  for (const [id, q] of Object.entries(config.questions)) {
    if (new Set(q.options.map(o => o.id)).size !== q.options.length) issue(`Duplicate option in ${id}`);
    if (q.category !== null && q.options.some(o => typeof o.points !== 'number')) issue(`Scored question without points: ${id}`);
  }
  for (const id of Object.keys(config.route_human_effect)) {
    if (!Object.values(config.questions).some(q => q.options.some(o => o.id === id && o.route_human))) issue(`route_human_effect names ${id}, which does not route`);
  }
  for (const [key, question] of Object.entries(config.area_question)) {
    if (!(key in config.pricing.area_factors)) issue(`area_question names an unpriced area: ${key}`);
    if (!(question in config.questions)) issue(`area_question names an unknown question: ${question}`);
  }
  for (const key of new Set(Object.values(config.area_keys))) if (!(key in config.pricing.area_factors)) issue(`area_keys maps to an unpriced area: ${key}`);
  if (!(String(config.pricing.default_limit) in config.pricing.limit_factors)) issue('default_limit has no limit factor');
});
export type UnderwritingConfig = z.infer<typeof UnderwritingConfig>;

const scored = (category: 'aidg' | 'ps' | 'fm', module: string, options: Array<[string, number, ('referral' | 'referral_senior')?]>, extra: object = {}) =>
  ({ category, module, ...extra, options: options.map(([id, points, ko]) => ({ id, points, ko: ko ?? null })) });

/** Config 1.1.0: the founder's 1.0.0 with its gaps filled (DN-14 §3). Every number of 1.0.0 is unchanged. */
export const UNDERWRITING_CONFIG_1_1_0 = UnderwritingConfig.parse({
  _comment: 'Arca Capa 2 underwriting configuration. 1.1.0 = 1.0.0 plus the options of G1, G2, F1 and F2 and the mappings 1.0.0 left open (DN-14 §3).',
  config_version: '1.1.0', bank_version: '4.0',
  scoring: { categories: { aidg: 40, ps: 35, fm: 25 }, reputation_scored: false,
    capa1_rescale_from_original: { aidg: [40, 35], ps: [35, 30], fm: [25, 15] } },
  question_cap: 10,
  tiers_display_only: [{ min: 80, label: 'FORTRESS' }, { min: 65, label: 'FORTIFIED' }, { min: 45, label: 'GUARDED' },
    { min: 25, label: 'EXPOSED' }, { min: 0, label: 'CRITICAL' }],
  exposure: {
    size_bands: [{ max_people: 15, band: 'Small' }, { max_people: 75, band: 'Medium' }, { max_people: null, band: 'Large' }],
    area_bands: {
      High: ['criminal', 'immigration', 'medical_malpractice', 'personal_injury'],
      Medium: ['ip_patents', 'family', 'securities', 'commercial_litigation', 'employment', 'bankruptcy'],
      Low: ['corporate_ma', 'real_estate', 'tax', 'consumer', 'other'],
    },
    matrix: { Small: { Low: 'E1', Medium: 'E1', High: 'E2' }, Medium: { Low: 'E1', Medium: 'E2', High: 'E3' },
      Large: { Low: 'E2', Medium: 'E3', High: 'E4' } },
    thresholds: { E1: { auto_bind: 70, conditions: 55 }, E2: { auto_bind: 78, conditions: 62 },
      E3: { auto_bind: 85, conditions: 70 }, E4: { auto_bind: null, conditions: null } },
  },
  decline_below_score: 25, referral_senior_below_score: 45,
  confidence: { levels: ['LOW', 'MEDIUM', 'HIGH'], low_blocks_auto_bind: true,
    premium_load: { HIGH: 1.00, MEDIUM: 1.10, LOW: null },
    downgrade_one_level: ['answer_contradicts_capa1', 'three_or_more_not_sure_on_scored_questions', 'p0_award_unverified'],
    set_to_low: ['refused_a_protected_priority_question', 'not_sure_on_both_gates', 'f1_unanswered', 'capa1_detected_tools_but_firm_claims_none'],
    not_sure_downgrade_count: 3 },
  pricing: {
    rate_per_unit: 1200, minimum_premium: 1500, support_staff_weight: 0.25, default_attorney_share: 0.60,
    graduated_bands: [{ up_to_units: 5, weight: 1.00 }, { up_to_units: 20, weight: 0.85 }, { up_to_units: 75, weight: 0.70 },
      { up_to_units: null, weight: 0.55 }],
    area_factor_primary_weight: 0.70, area_factor_others_weight: 0.30,
    area_factors: { criminal: 2.00, immigration: 1.80, medical_malpractice: 1.70, personal_injury: 1.60, ip_patents: 1.40,
      family: 1.30, securities: 1.30, commercial_litigation: 1.20, employment: 1.15, bankruptcy: 1.10, corporate_ma: 1.00,
      consumer: 0.95, real_estate: 0.85, tax: 0.75, other: 1.00 },
    risk_factor: { intercept: 1.40, slope: 0.65, min: 0.75, max: 1.40 },
    limit_factors: { 250000: 0.70, 500000: 0.85, 1000000: 1.00, 2000000: 1.35, 5000000: 1.90 },
    default_limit: 1000000,
    jurisdiction_factors: { FL: 1.25, _default: 1.00 },
  },
  profiles: {
    P0: { questions: ['P0-1', 'P0-2'], award_verified: 32, award_unverified: 16, award_category: 'aidg' },
    P1: { questions: ['P1-1', 'P1-2', 'P1-4', 'P1-3'] },
    P2: { questions: ['P2-1', 'P2-2', 'P2-3'] },
    P3: { questions: ['P3-1', 'P3-2', 'P3-3', 'P3-4'] },
    P4: { questions: ['P3-1', 'P3-2', 'P4-1', 'P3-3', 'P3-4'] },
  },
  selection_priority: [
    { rank: 1, ids: ['G1', 'G2'], when: 'always', protected: true },
    { rank: 2, ids: ['C1', 'C2'], when: 'always', protected: true },
    { rank: 3, ids: ['F1'], when: 'always', protected: true },
    { rank: 4, ids: ['F2'], when: 'capa1_no_areas', protected: true },
    { rank: 5, ids: ['C3'], when: 'profile_ge_P1', protected: true },
    { rank: 6, ids: ['PS-1'], when: 'capa1_bar_failed', protected: false },
    { rank: 7, ids: ['@profile_primary'], when: 'always', protected: false },
    { rank: 8, ids: ['@profile_knockouts'], when: 'always', protected: false },
    { rank: 9, ids: ['DG-1'], when: 'profile_ge_P1', protected: false },
    { rank: 10, ids: ['@profile_rest'], when: 'always', protected: false },
    { rank: 11, ids: ['@practice_area'], when: 'profile_ge_P3', protected: false },
  ],
  profile_primary: { P0: 'P0-1', P1: 'P1-1', P2: 'P2-1', P3: 'P3-1', P4: 'P3-1' },
  profile_knockouts: { P0: [], P1: ['P1-2'], P2: [], P3: ['P3-2'], P4: ['P3-2', 'P4-1'] },
  questions: {
    G1: { category: null, module: 'gate', type: 'checklist', options: [
      { id: 'G1-case-software' }, { id: 'G1-chat-assistant' }, { id: 'G1-phone-text' }, { id: 'G1-general-ai' },
      { id: 'G1-legal-research' }, { id: 'G1-none', exclusive: true }, { id: 'G1-unsure', exclusive: true }] },
    G2: { category: null, module: 'gate', type: 'checklist', options: [
      { id: 'G2-client-questions' }, { id: 'G2-intake' }, { id: 'G2-scheduling' }, { id: 'G2-drafting' },
      { id: 'G2-research' }, { id: 'G2-review' }, { id: 'G2-filings' }, { id: 'G2-billing' }, { id: 'G2-marketing' },
      { id: 'G2-nowhere', exclusive: true }, { id: 'G2-unsure', exclusive: true }] },
    F1: { category: null, module: 'exposure', type: 'single', options: [
      { id: 'F1-1' }, { id: 'F1-2-5' }, { id: 'F1-6-15' }, { id: 'F1-16-30' }, { id: 'F1-31-75' }, { id: 'F1-76-150' },
      { id: 'F1-150-plus' }, { id: 'F1-unsure' }] },
    F2: { category: null, module: 'exposure', type: 'checklist', options: [
      { id: 'F2-criminal' }, { id: 'F2-immigration' }, { id: 'F2-personal-injury' }, { id: 'F2-medical-malpractice' },
      { id: 'F2-family' }, { id: 'F2-litigation' }, { id: 'F2-employment' }, { id: 'F2-ip' }, { id: 'F2-corporate' },
      { id: 'F2-real-estate' }, { id: 'F2-tax' }, { id: 'F2-consumer' }, { id: 'F2-other' }] },
    C1: { category: 'ps', module: 'core', type: 'checklist', options: [
      { id: 'C1-none', points: 10, ko: null, exclusive: true },
      { id: 'C1-claim-2y', points: -10, ko: 'referral' },
      { id: 'C1-claim-2to5y', points: -6, ko: null },
      { id: 'C1-claim-tech', points: -10, ko: 'referral' },
      { id: 'C1-claims-multi', points: -12, ko: 'referral' },
      { id: 'C1-declined', points: -10, ko: 'referral' },
      { id: 'C1-expected', points: -12, ko: 'referral_senior' },
      { id: 'C1-unsure', points: 0, ko: null, route_human: true, exclusive: true }] },
    C2: { category: 'fm', module: 'core', type: 'single', options: [
      { id: 'C2-yes', points: 6, ko: null }, { id: 'C2-renewing', points: 2, ko: null },
      { id: 'C2-no', points: -8, ko: null, ko_if_also: 'any_C1_claim' },
      { id: 'C2-unsure', points: 0, ko: null, route_human: true }] },
    C3: scored('aidg', 'core', [['C3-never', 8], ['C3-nearmiss', 2], ['C3-reached', -12, 'referral'], ['C3-unsure', 0]], { when: 'profile_ge_P1' }),
    'PS-1': scored('ps', 'licensing', [['PS1-all', 14], ['PS1-all-staff', 14], ['PS1-not-all', -10, 'referral'], ['PS1-unsure', 0]], { when: 'capa1_bar_failed' }),
    'P0-1': scored('aidg', 'P0', [['P01-no-plans', 7], ['P01-maybe', 4], ['P01-looking', 2], ['P01-rolling', 0]]),
    'P0-2': scored('aidg', 'P0', [['P02-own', 4], ['P02-cloud-ok', 3], ['P02-cloud-unchecked', -3], ['P02-unsure', 0]]),
    'P1-1': scored('aidg', 'P1', [['P11-review-before', 10], ['P11-review-after', 5], ['P11-no-check', -6], ['P11-unsure', 0]]),
    'P1-2': scored('aidg', 'P1', [['P12-isolated', 10], ['P12-untested', 3], ['P12-could', -12, 'referral'], ['P12-unsure', -2]]),
    'P1-3': scored('aidg', 'P1', [['P13-both', 5], ['P13-partial', 2], ['P13-neither', -4], ['P13-unsure', 0]]),
    'P1-4': scored('aidg', 'P1', [['P14-reviewed', 6], ['P14-reads', 3], ['P14-not', 0], ['P14-unsure', 0]]),
    'P2-1': scored('aidg', 'P2', [['P21-always', 14], ['P21-most', 7], ['P21-important', 0], ['P21-no-rule', -6]]),
    'P2-2': scored('aidg', 'P2', [['P22-know', 8], ['P22-sort-of', 4], ['P22-no', 0], ['P22-unsure', 0]]),
    'P2-3': scored('aidg', 'P2', [['P23-never', 7], ['P23-caught', 3], ['P23-yes', -6], ['P23-unsure', 0]]),
    'P3-1': scored('aidg', 'P3', [['P31-always', 12], ['P31-most', 5], ['P31-important', -2], ['P31-no-rule', -8]]),
    'P3-2': scored('aidg', 'P3', [['P32-always', 10], ['P32-most', 4], ['P32-time', 0], ['P32-trust', -10, 'referral']]),
    'P3-3': scored('aidg', 'P3', [['P33-owner', 8], ['P33-partner', 4], ['P33-none', 0], ['P33-unsure', 0]], { variants: ['P3-3a', 'P3-3b'] }),
    'P3-4': scored('aidg', 'P3', [['P34-rarely', 5], ['P34-sometimes', 3], ['P34-normal', 1], ['P34-almost-all', -2]]),
    'P4-1': scored('aidg', 'P4', [['P41-every', 12], ['P41-partner', 5], ['P41-spot', -4], ['P41-none', -12, 'referral']]),
    'DG-1': scored('aidg', 'data', [['DG1-anon', 6], ['DG1-agreement', 4], ['DG1-unchecked', -8, 'referral'], ['DG1-unsure', -2]], { when: 'profile_ge_P1' }),
    'E-criminal': scored('aidg', 'area', [['EC-always', 6], ['EC-most', 2], ['EC-none', -8]], { when: 'profile_ge_P3' }),
    'E-immigration': scored('aidg', 'area', [['EI-official', 6], ['EI-sometimes', 2], ['EI-trust', -6]], { when: 'profile_ge_P3' }),
    'E-litigation': scored('aidg', 'area', [['EL-verified', 6], ['EL-partner', 2], ['EL-none', -8]], { when: 'profile_ge_P3' }),
    'E-ip': scored('aidg', 'area', [['EP-always', 6], ['EP-most', 2], ['EP-none', -6]], { when: 'profile_ge_P3' }),
    'E-medmal-pi': scored('aidg', 'area', [['EM-no', 5], ['EM-expert', 3], ['EM-none', -8]], { when: 'profile_ge_P3' }),
    'E-family': scored('aidg', 'area', [['EF-never', 6], ['EF-approved', 3], ['EF-general', -8]], { when: 'profile_ge_P3' }),
    'E-other': { category: 'aidg', module: 'area', type: 'open', when: 'profile_ge_P3', open: true,
      options: [{ id: 'EO-open', points: 0, ko: null, route_human: true }] },
  },
  classification: {
    p4_if_g2_any: ['G2-filings'], p3_if_g2_any: ['G2-research', 'G2-review'],
    drafting_option: 'G2-drafting', case_platform_option: 'G1-case-software', drafting_without_platform: 'P3',
    p1_if_g2_any: ['G2-client-questions', 'G2-intake', 'G2-scheduling'],
    p0_requires: { g1: 'G1-none', g2: 'G2-nowhere' }, not_sure: { g1: 'G1-unsure', g2: 'G2-unsure' },
    both_not_sure: 'P2', fallback: 'P2',
  },
  f1_people: {
    'F1-1': { min: 1, max: 1, count: 1 }, 'F1-2-5': { min: 2, max: 5, count: 4 }, 'F1-6-15': { min: 6, max: 15, count: 11 },
    'F1-16-30': { min: 16, max: 30, count: 23 }, 'F1-31-75': { min: 31, max: 75, count: 53 },
    'F1-76-150': { min: 76, max: 150, count: 113 }, 'F1-150-plus': { min: 151, max: null, count: 150 },
  },
  area_keys: {
    // Layer 1's normalized names (packages/scoring/src/areas.ts).
    'Criminal Defense': 'criminal', 'Immigration': 'immigration', 'Medical Malpractice': 'medical_malpractice',
    'Personal Injury': 'personal_injury', 'IP/Patents': 'ip_patents', 'Family Law': 'family', 'Securities': 'securities',
    'Commercial Litigation': 'commercial_litigation', 'Employment Law': 'employment', 'Bankruptcy': 'bankruptcy',
    'Corporate/M&A': 'corporate_ma', 'Real Estate': 'real_estate', 'Tax/Regulatory': 'tax',
    'consumer': 'consumer', 'lemon law': 'consumer', 'consumer protection': 'consumer',
    // F2's options.
    'F2-criminal': 'criminal', 'F2-immigration': 'immigration', 'F2-personal-injury': 'personal_injury',
    'F2-medical-malpractice': 'medical_malpractice', 'F2-family': 'family', 'F2-litigation': 'commercial_litigation',
    'F2-employment': 'employment', 'F2-ip': 'ip_patents', 'F2-corporate': 'corporate_ma', 'F2-real-estate': 'real_estate',
    'F2-tax': 'tax', 'F2-consumer': 'consumer', 'F2-other': 'other',
  },
  area_question: {
    criminal: 'E-criminal', immigration: 'E-immigration', commercial_litigation: 'E-litigation', securities: 'E-litigation',
    employment: 'E-litigation', bankruptcy: 'E-litigation', ip_patents: 'E-ip', medical_malpractice: 'E-medmal-pi',
    personal_injury: 'E-medmal-pi', family: 'E-family',
  },
  tool_patterns: {
    'G1-case-software': ['clio', 'mycase', 'smokeball', 'practicepanther', 'filevine', 'lawmatics', 'litify', 'cosmolex', 'rocket matter', 'case management'],
    'G1-chat-assistant': ['chatbot', 'chat bot', 'chat assistant', 'live chat', 'virtual assistant', 'ngage', 'intaker', 'lawdroid'],
    'G1-phone-text': ['answering', 'ruby', 'smith.ai', 'receptionist', 'text message', 'sms'],
    'G1-general-ai': ['chatgpt', 'openai', 'gpt', 'claude', 'copilot', 'gemini', 'generative'],
    'G1-legal-research': ['harvey', 'cocounsel', 'casetext', 'lexis', 'westlaw', 'vlex', 'vincent', 'fastcase', 'spellbook'],
  },
  detected_tool_profile: {
    'G1-case-software': 'P2', 'G1-chat-assistant': 'P1', 'G1-phone-text': 'P1', 'G1-general-ai': 'P2', 'G1-legal-research': 'P3',
  },
  route_human_effect: { 'C1-unsure': 'schedule', 'C2-unsure': 'schedule', 'EO-open': 'summary' },
  conditions: { max: 3, due_days: 90 },
  decline_reassess_days: 90,
});

export const UNDERWRITING_CONFIG = UNDERWRITING_CONFIG_1_1_0;

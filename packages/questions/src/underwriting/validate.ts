import type { UnderwritingConfig } from './config.js';

/**
 * A TypeScript port of the founder's validate_capa2.py: the same invariants, the same budget, ceiling and floor, so the
 * back's tests fail a bad config before it can be merged. tools/underwriting keeps the Python original, and a test runs
 * both on the same config and compares their figures.
 */
const PROFILES = ['P0', 'P1', 'P2', 'P3', 'P4'] as const;
const CATEGORIES = ['aidg', 'ps', 'fm'] as const;
type Profile = typeof PROFILES[number];
const atLeast = (profile: Profile, floor: Profile) => PROFILES.indexOf(profile) >= PROFILES.indexOf(floor);

export type ValidationReport = {
  failures: Array<{ check: string; detail: string }>;
  warnings: Array<{ check: string; detail: string }>;
  budget: Record<Profile, { asked: number; dropped: number; knockoutsDropped: string[] }>;
  bestCase: Record<Profile, Record<'aidg' | 'ps' | 'fm', number>>;
  floor: Record<Profile, number>;
};

/** The validator's selection: the engine's priority order and cap, with one stand-in practice-area question. */
export function budgetSelection(config: UnderwritingConfig, profile: Profile, { hasAreas = true, barOk = true } = {}) {
  const primary = config.profile_primary[profile]!, knockouts = config.profile_knockouts[profile]!;
  const rest = config.profiles[profile].questions.filter(id => id !== primary && !knockouts.includes(id));
  const ordered: string[] = [];
  for (const entry of config.selection_priority) for (const raw of entry.ids) {
    const ids = raw === '@profile_primary' ? [primary] : raw === '@profile_knockouts' ? knockouts : raw === '@profile_rest' ? rest
      : raw === '@practice_area' ? ['E-criminal'] : [raw];
    for (const id of ids) {
      if (entry.when === 'profile_ge_P1' && !atLeast(profile, 'P1')) continue;
      if (entry.when === 'profile_ge_P3' && !atLeast(profile, 'P3')) continue;
      if (entry.when === 'capa1_no_areas' && hasAreas) continue;
      if (entry.when === 'capa1_bar_failed' && barOk) continue;
      if (!ordered.includes(id)) ordered.push(id);
    }
  }
  return { selected: ordered.slice(0, config.question_cap), dropped: ordered.slice(config.question_cap) };
}

function bestCase(config: UnderwritingConfig, selected: string[], profile: Profile, p0Verified: boolean) {
  const totals = { aidg: 0, ps: 0, fm: 0 };
  for (const id of selected) {
    const q = config.questions[id];
    if (!q?.category) continue;
    const best = Math.max(...q.options.map(o => o.points ?? -Infinity));
    if (best > 0) totals[q.category] += best;
  }
  if (profile === 'P0') totals[config.profiles.P0.award_category] += p0Verified ? config.profiles.P0.award_verified : config.profiles.P0.award_unverified;
  return totals;
}

export function validateConfig(config: UnderwritingConfig): ValidationReport {
  const failures: ValidationReport['failures'] = [], warnings: ValidationReport['warnings'] = [];
  const fail = (check: string, detail: string) => failures.push({ check, detail });
  const warn = (check: string, detail: string) => warnings.push({ check, detail });
  const cats = config.scoring.categories, cap = config.question_cap;

  const total = cats.aidg + cats.ps + cats.fm;
  if (total !== 100) fail('sum-100', `category maximums sum to ${total}, expected 100`);

  const referenced = new Set<string>();
  for (const entry of config.selection_priority) for (const raw of entry.ids) if (!raw.startsWith('@')) referenced.add(raw);
  for (const p of PROFILES) {
    referenced.add(config.profile_primary[p]!);
    config.profile_knockouts[p]!.forEach(id => referenced.add(id));
    config.profiles[p].questions.forEach(id => referenced.add(id));
  }
  for (const id of new Set(Object.values(config.area_question))) referenced.add(id);
  referenced.add('E-other');
  const missing = [...referenced].filter(id => !(id in config.questions)).sort();
  if (missing.length) fail('questions-exist', `referenced but not defined in the bank: ${missing.join(', ')}`);

  const budget = {} as ValidationReport['budget'], best = {} as ValidationReport['bestCase'], floor = {} as ValidationReport['floor'];
  for (const p of PROFILES) {
    for (const hasAreas of [true, false]) for (const barOk of [true, false]) {
      const { selected } = budgetSelection(config, p, { hasAreas, barOk });
      if (selected.length > cap) fail('cap', `${p} selected ${selected.length} questions, cap is ${cap}`);
    }
    const { selected, dropped } = budgetSelection(config, p);
    const knockoutsDropped = dropped.filter(id => config.questions[id]?.options.some(o => o.ko));
    if (knockoutsDropped.length) warn('knockout-dropped', `${p}: cap drops knockout question(s) ${knockoutsDropped.join(', ')} on the standard path. The engine must force REFERRAL in this case.`);
    budget[p] = { asked: selected.length, dropped: dropped.length, knockoutsDropped };
    best[p] = bestCase(config, selected, p, true);
    for (const c of CATEGORIES) if (Math.min(cats[c], cats[c] + best[p][c]) < cats[c]) fail('ceiling', `${p}/${c} cannot reach its maximum`);
    const empty = budgetSelection(config, p, { hasAreas: false, barOk: false }).selected;
    const worst = bestCase(config, empty, p, false);
    floor[p] = CATEGORIES.reduce((sum, c) => sum + Math.min(worst[c], cats[c]), 0);
    const e1 = config.exposure.thresholds.E1!.auto_bind;
    if (e1 !== null && floor[p] >= e1) warn('floor-reaches-autobind', `${p}: a firm Layer 1 could not read can still reach ${floor[p]}, at or above the E1 auto-bind threshold of ${e1}.`);
  }
  if (!config.confidence.low_blocks_auto_bind) fail('confidence-guard', 'low_blocks_auto_bind is false. The floor analysis depends on it being true.');

  let previous = 0;
  for (const level of ['E1', 'E2', 'E3', 'E4'] as const) {
    const t = config.exposure.thresholds[level]!;
    if (t.auto_bind === null) continue;
    if (t.conditions === null || t.conditions >= t.auto_bind) fail('threshold-order', `${level}: conditions must be below auto_bind`);
    if (t.auto_bind < previous) fail('threshold-monotonic', `${level}: auto_bind lower than the band below it`);
    previous = t.auto_bind;
    if (t.conditions !== null && t.conditions < config.referral_senior_below_score) warn('threshold-vs-senior', `${level}: conditions threshold sits below the senior-referral line`);
  }

  const banded = new Set(Object.values(config.exposure.area_bands).flat());
  const priced = new Set(Object.keys(config.pricing.area_factors));
  const unpriced = [...banded].filter(a => !priced.has(a)), unbanded = [...priced].filter(a => !banded.has(a));
  if (unpriced.length || unbanded.length) fail('area-coverage', `banded but not priced: ${unpriced.join(', ') || '-'}; priced but not banded: ${unbanded.join(', ') || '-'}`);

  const rf = config.pricing.risk_factor;
  if (Math.abs(rf.intercept - rf.slope - rf.min) > 1e-9 || Math.abs(rf.intercept - rf.max) > 1e-9) warn('risk-factor-bounds', 'declared min/max do not match the formula’s range');

  for (const [id, q] of Object.entries(config.questions)) {
    if (q.category === null) continue;
    for (const o of q.options) if (typeof o.points !== 'number') fail('option-points', `${id}/${o.id} has no numeric points`);
  }
  // Added for 1.1.0: what the engine reads beyond the founder's checks.
  for (const gate of ['G1', 'G2', 'F1']) if (!config.questions[gate]?.options.length) fail('gate-options', `${gate} has no options`);
  for (const id of config.questions.F1?.options.map(o => o.id) ?? []) if (id !== 'F1-unsure' && !config.f1_people[id]) fail('f1-people', `${id} has no people count`);
  return { failures, warnings, budget, bestCase: best, floor };
}

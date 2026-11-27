import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { UnderwritingResult, type AnswerValue } from '@arca/contracts';
import { fixtureResult } from '../../contracts/tests/fixture.js';
import { underwriting } from '../src/index.js';

const { UNDERWRITING_CONFIG: config, UnderwritingConfig, validateConfig, premium, select, layer1Facts, scoreUnderwriting, renderQuestion,
  validUnderwritingAnswer, publicResult, BANK } = underwriting;
const one = (optionId: string): AnswerValue => ({ kind: 'option', optionId });
const many = (...optionIds: string[]): AnswerValue => ({ kind: 'options', optionIds });
const BOOKING = 'https://calendly.com/arcacover/discovery';
const score = (answers: Record<string, AnswerValue>, layer1 = fixtureResult()) =>
  scoreUnderwriting({ config, layer1, answers, assessmentId: 'as_test', completedAt: '2026-11-27T12:00:00.000Z', bookingUrl: BOOKING });

// The fixture: Smith Law, 5 attorneys, Immigration, Florida, Harvey named on the website, every source answered (HIGH).
const legalWork = {
  G1: many('G1-legal-research', 'G1-case-software'), G2: many('G2-research'), C1: many('C1-none'), C2: one('C2-yes'),
  F1: one('F1-6-15'), C3: one('C3-never'), 'P3-1': one('P31-always'), 'P3-2': one('P32-always'), 'DG-1': one('DG1-anon'),
  'P3-3': one('P33-owner'),
};

describe('config 1.1.0 and its validator', () => {
  it('parses, and the TypeScript validator reproduces the figures of the rules document (§16)', () => {
    expect(UnderwritingConfig.safeParse(config).success).toBe(true);
    const report = validateConfig(config);
    expect(report.failures).toEqual([]);
    expect(Object.fromEntries(Object.entries(report.budget).map(([p, b]) => [p, b.asked]))).toEqual({ P0: 7, P1: 10, P2: 10, P3: 10, P4: 10 });
    expect(report.bestCase).toEqual({ P0: { aidg: 43, ps: 10, fm: 6 }, P1: { aidg: 40, ps: 10, fm: 6 }, P2: { aidg: 43, ps: 10, fm: 6 },
      P3: { aidg: 44, ps: 10, fm: 6 }, P4: { aidg: 48, ps: 10, fm: 6 } });
    expect(report.floor).toEqual({ P0: 57, P1: 58, P2: 58, P3: 60, P4: 60 });
    expect(Object.values(report.budget).flatMap(b => b.knockoutsDropped)).toEqual([]);
  });
  it('fails a config that breaks an invariant', () => {
    const broken = structuredClone(config);
    broken.scoring.categories.aidg = 45;
    broken.exposure.thresholds.E2!.conditions = 90;
    const report = validateConfig(broken);
    expect(report.failures.map(f => f.check).sort()).toEqual(['sum-100', 'threshold-order']);
  });
  it('passes the founder’s Python validator unchanged, when Python is installed', () => {
    let python: string | null = null;
    for (const candidate of ['python3', 'python']) {
      try { execFileSync(candidate, ['--version'], { stdio: 'ignore' }); python = candidate; break; } catch { /* next */ }
    }
    if (!python) return;
    const dir = mkdtempSync(join(tmpdir(), 'arca-uw-'));
    writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
    const output = execFileSync(python, [join(__dirname, '../../../tools/underwriting/validate_capa2.py'), join(dir, 'config.json')], { encoding: 'utf8' });
    expect(output).toContain('VALID: all invariants hold.');
    for (const [profile, floor] of Object.entries(validateConfig(config).floor)) expect(output).toMatch(new RegExp(`${profile} floor\\s+${floor} / 100`));
  });
});

describe('pricing (§14 worked examples)', () => {
  it('10 lawyers, 2 admin, real estate, score 80, HIGH, $1M, Florida: about $10,900, and about $12,000 at MEDIUM', () => {
    const base = { attorneys: 10, supportStaff: 2, areas: ['real_estate'], score: 80, limit: 1_000_000, state: 'FL' } as const;
    const high = premium(config, { ...base, confidence: 'HIGH' });
    expect(high.buildUp.ratedUnits).toBe(9.675);
    expect(high.annualPremium).toBe(10855);
    expect(premium(config, { ...base, confidence: 'MEDIUM' }).annualPremium).toBe(11941);
  });
  it('100 lawyers, 50 admin, criminal and real estate, score 85, HIGH, $2M, Florida: about $218,000', () => {
    const result = premium(config, { attorneys: 100, supportStaff: 50, areas: ['criminal', 'real_estate'], score: 85, confidence: 'HIGH', limit: 2_000_000, state: 'FL' });
    expect(result.buildUp.ratedUnits).toBe(76.875);
    expect(result.buildUp.areaFactor).toBe(1.655);
    expect(result.annualPremium).toBe(218347);
  });
  it('never quotes below the minimum premium', () => {
    const result = premium(config, { attorneys: 1, supportStaff: 0, areas: ['tax'], score: 100, confidence: 'HIGH', limit: 250_000, state: null });
    expect(result.annualPremium).toBe(1500);
    expect(result.buildUp.minimumApplied).toBe(true);
  });
});

describe('selection (§7, §8)', () => {
  const facts = layer1Facts(fixtureResult(), config);
  it('asks only the questions before the profile until G1 and G2 are answered', () => {
    expect(select(config, facts, {}).asked).toEqual(['G1', 'G2', 'C1', 'C2', 'F1']);
  });
  it('selects the P3 set, capped at 10, and drops the rest for the cap', () => {
    const selection = select(config, facts, legalWork);
    expect(selection.profile).toBe('P3');
    expect(selection.asked).toEqual(['G1', 'G2', 'C1', 'C2', 'F1', 'C3', 'P3-1', 'P3-2', 'DG-1', 'P3-3']);
    expect(selection.dropped.filter(d => d.reason === 'cap').map(d => d.id)).toEqual(['P3-4', 'E-immigration']);
    expect(selection.knockoutDropped).toBe(false);
  });
  it.each([
    [['G1-chat-assistant'], ['G2-client-questions'], 'P1'],
    [['G1-case-software'], ['G2-drafting'], 'P2'],
    [['G1-general-ai'], ['G2-drafting'], 'P3'],
    [['G1-general-ai'], ['G2-review', 'G2-intake'], 'P3'],
    [['G1-legal-research'], ['G2-filings'], 'P4'],
    [['G1-general-ai'], ['G2-billing'], 'P2'],
    [['G1-unsure'], ['G2-unsure'], 'P2'],
  ])('classifies G1 %j and G2 %j as %s', (g1, g2, profile) => {
    expect(select(config, facts, { G1: many(...g1), G2: many(...g2) }).profile).toBe(profile);
  });
  it('never classifies P0 when Layer 1 saw AI tools, and classifies from what it saw', () => {
    expect(select(config, facts, { G1: many('G1-none'), G2: many('G2-nowhere') }).profile).toBe('P3');
  });
  it('asks F2 and the matching area question when Layer 1 found no practice areas', () => {
    const layer1 = fixtureResult();
    layer1.signals.website.W9_practiceAreas = null; layer1.signals.avvo.A2_practiceAreas = null;
    const noAreas = layer1Facts(layer1, config);
    const answers = { G1: many('G1-legal-research'), G2: many('G2-filings'), F2: many('F2-litigation') };
    const selection = select(config, noAreas, answers);
    expect(selection.asked.slice(0, 6)).toEqual(['G1', 'G2', 'C1', 'C2', 'F1', 'F2']);
    expect(selection.areaQuestion).toBe('E-litigation');
  });
  it('refers a firm when the cap drops a question that can knock out (Bar lookup failed, P4)', () => {
    const layer1 = fixtureResult();
    layer1.signals.bar.B1_allActive = null;
    const selection = select(config, layer1Facts(layer1, config), { G1: many('G1-legal-research'), G2: many('G2-filings') });
    expect(selection.asked).toContain('PS-1');
    expect(selection.dropped).toContainEqual({ id: 'DG-1', reason: 'cap' });
    expect(selection.knockoutDropped).toBe(true);
  });
  it('renders each question from the bank, filling only known slots', () => {
    expect(renderQuestion(config, facts, legalWork, 'P3-3').text).toBe('We saw that Smith Law has written guidance on using these tools. Who makes sure the team follows it?');
    expect(renderQuestion(config, facts, {}, 'G1').options?.find(o => o.id === 'G1-none')?.exclusive).toBe(true);
    expect(renderQuestion(config, facts, {}, 'E-other')).toMatchObject({ type: 'text', options: null, textInput: { maxLength: 1000 } });
  });
  it('accepts only the question’s own option IDs and keeps exclusive options alone', () => {
    expect(validUnderwritingAnswer(config, 'C1', many('C1-claim-2y', 'C1-claim-tech'))).toBe(true);
    expect(validUnderwritingAnswer(config, 'C1', many('C1-none', 'C1-claim-2y'))).toBe(false);
    expect(validUnderwritingAnswer(config, 'C2', one('C1-none'))).toBe(false);
    expect(validUnderwritingAnswer(config, 'E-other', { kind: 'text', value: 'A missed deadline' })).toBe(true);
  });
  it('has wording for every question and option in the config', () => {
    for (const [id, question] of Object.entries(config.questions)) {
      const entries = id === 'P3-3' ? [BANK['P3-3a']!, BANK['P3-3b']!] : [BANK[id]!];
      for (const entry of entries) {
        expect(entry, id).toBeDefined();
        if (entry.type !== 'text') expect(Object.keys(entry.options).sort(), id).toEqual(question.options.map(o => o.id).sort());
      }
    }
  });
});

describe('the result (§10–§15)', () => {
  it('quotes a well-run small firm and prices it from the exposure base', () => {
    const result = score(legalWork);
    expect(UnderwritingResult.safeParse(result).success).toBe(true);
    expect(result.categories.map(c => [c.key, c.layer1, c.score])).toEqual([
      ['ai_data_governance', 26.29, 40], ['professional_standing', 35, 35], ['firm_maturity', 25, 25]]);
    expect(result.compositeScore).toBe(100);
    expect(result.exposure).toMatchObject({ usageProfile: 'P3', sizeBand: 'Small', areaBand: 'High', level: 'E2' });
    expect(result.audit?.decisionRuleFired).toBe('auto_bind');
    if (result.outcome.type !== 'quote') throw new Error('expected a quote');
    expect(result.outcome.quote.limits.find(l => l.limit === 1_000_000)?.annualPremium).toBe(12707);
    expect(result.outcome.quote.conditions).toEqual([]);
  });
  it('refers on a knockout and gives no price anywhere', () => {
    const result = score({ ...legalWork, 'P3-2': one('P32-trust') });
    expect(result.outcome.type).toBe('schedule');
    expect(result.audit?.knockoutsFired).toEqual([{ questionId: 'P3-2', optionId: 'P32-trust', forced: 'REFERRAL' }]);
    expect(JSON.stringify(result.outcome)).not.toMatch(/premium|\$/i);
  });
  it('sends an expected claim to a senior underwriter', () => {
    const result = score({ ...legalWork, C1: many('C1-expected') });
    expect(result.outcome).toMatchObject({ type: 'schedule', schedule: { withWhom: 'senior underwriter' } });
  });
  it('takes the worst box of the claims checklist, not the sum', () => {
    const result = score({ ...legalWork, C1: many('C1-claim-2to5y', 'C1-claims-multi') });
    expect(result.audit?.questionsAsked.find(q => q.id === 'C1')?.pointsApplied).toBe(-12);
  });
  it('makes no E&O policy plus a claim a knockout, but neither alone', () => {
    expect(score({ ...legalWork, C2: one('C2-no') }).outcome.type).toBe('quote');
    expect(score({ ...legalWork, C1: many('C1-claim-2to5y') }).outcome.type).toBe('quote');
    expect(score({ ...legalWork, C2: one('C2-no'), C1: many('C1-claim-2to5y') }).audit?.decisionRuleFired).toBe('knockout');
  });
  it('routes a firm unsure of its claims to an underwriter', () => {
    expect(score({ ...legalWork, C1: many('C1-unsure') }).audit?.decisionRuleFired).toBe('route_to_human');
  });
  it('never binds a large firm in a high-risk area, whatever the score', () => {
    const result = score({ ...legalWork, F1: one('F1-76-150') });
    expect(result.exposure.level).toBe('E4');
    expect(result.audit?.decisionRuleFired).toBe('exposure_e4');
    expect(result.outcome.type).toBe('schedule');
  });
  it('lowers confidence on a contradiction with Layer 1 and on a missing size', () => {
    const contradicted = score({ ...legalWork, G1: many('G1-case-software'), G2: many('G2-review') });
    expect(contradicted.confidence.level).toBe('MEDIUM');
    expect(contradicted.confidence.contradictions[0]?.layer1Said).toContain('Harvey');
    const unsized = score({ ...legalWork, F1: one('F1-unsure') });
    expect(unsized.confidence.level).toBe('LOW');
    expect(unsized.outcome.type).toBe('schedule');
  });
  it('treats a claim of no tools against Layer 1’s sighting as LOW, not P0', () => {
    const result = score({ G1: many('G1-none'), G2: many('G2-nowhere'), C1: many('C1-none'), C2: one('C2-yes'), F1: one('F1-2-5') });
    expect(result.exposure.usageProfile).toBe('P3');
    expect(result.confidence.level).toBe('LOW');
    expect(result.audit?.decisionRuleFired).toBe('abandoned');
  });
  it('awards the verified P0 points to a firm with no automation that the website confirms', () => {
    const layer1 = fixtureResult();
    layer1.signals.website.W2_aiInServices = { found: false, tools: [], points: 0 };
    const result = score({ G1: many('G1-none'), G2: many('G2-nowhere'), C1: many('C1-none'), C2: one('C2-yes'), F1: one('F1-2-5'),
      'P0-1': one('P01-no-plans'), 'P0-2': one('P02-own') }, layer1);
    expect(result.exposure.usageProfile).toBe('P0');
    expect(result.categories[0]?.layer2).toBe(43);
    expect(result.confidence.level).toBe('HIGH');
    expect(result.outcome.type).toBe('quote');
  });
  it('declines below the floor and still gives the booking link, never a number', () => {
    const layer1 = fixtureResult();
    for (const key of ['aiGovernance', 'professionalStanding', 'firmMaturity'] as const) layer1.preScore.categories[key].score = 0;
    const result = score({ ...legalWork, C1: many('C1-claim-2to5y'), C2: one('C2-no'), 'P3-1': one('P31-no-rule'), 'P3-2': one('P32-time'),
      'DG-1': one('DG1-unsure'), C3: one('C3-unsure'), 'P3-3': one('P33-none') }, layer1);
    // C2-no plus a claim is a knockout, which comes first; without it the score alone declines.
    expect(result.audit?.decisionRuleFired).toBe('knockout');
    const declined = score({ ...legalWork, C1: many('C1-claim-2to5y'), 'P3-1': one('P31-no-rule'), 'P3-2': one('P32-time'),
      'DG-1': one('DG1-unsure'), C3: one('C3-unsure'), 'P3-3': one('P33-none'), C2: one('C2-renewing') }, layer1);
    expect(declined.compositeScore).toBeLessThan(25);
    expect(declined.outcome).toMatchObject({ type: 'declined', declined: { bookingUrl: BOOKING, reassessAfterDays: 90 } });
  });
  it('binds with conditions in the band below auto-bind, listing at most three fixes from the answers', () => {
    const layer1 = fixtureResult();
    layer1.preScore.categories.aiGovernance.score = 0;
    layer1.preScore.categories.firmMaturity.score = 0;
    const result = score({ ...legalWork, 'P3-1': one('P31-most'), 'DG-1': one('DG1-agreement'), 'P3-3': one('P33-partner'), C3: one('C3-nearmiss') }, layer1);
    expect(result.compositeScore).toBeGreaterThanOrEqual(62);
    expect(result.compositeScore).toBeLessThan(78);
    if (result.outcome.type !== 'quote') throw new Error('expected a quote');
    expect(result.outcome.quote.conditions.map(c => c.fromQuestion)).toEqual(['P3-1', 'C3', 'P3-3']);
  });
  it('is deterministic and hides the underwriter’s notes from the firm', () => {
    expect(score(legalWork)).toEqual(score(legalWork));
    expect(publicResult(score(legalWork))).toMatchObject({ audit: null, underwriterSummary: null });
    expect(score(legalWork).underwriterSummary).toContain('Smith Law: usage profile P3');
  });
  it('scores a stored Layer 1 result of either contract version on the same scale', () => {
    const v3 = fixtureResult();
    v3.preScore.categories.aiGovernance = { ...v3.preScore.categories.aiGovernance, score: 26.29, max: 40 };
    v3.preScore.categories.professionalStanding = { ...v3.preScore.categories.professionalStanding, score: 35, max: 35 };
    v3.preScore.categories.firmMaturity = { ...v3.preScore.categories.firmMaturity, score: 25, max: 25 };
    expect(layer1Facts(v3, config).categories).toEqual(layer1Facts(fixtureResult(), config).categories);
  });
});

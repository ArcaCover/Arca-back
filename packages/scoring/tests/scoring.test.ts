import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { scoreEvidence, sanctionBucket, firmMaturity } from '../src/index.js';
import { unknownWebsite, type ScoringInput } from '@arca/contracts';
const NOW = '2026-09-05T12:00:00.000Z';
function robust(): ScoringInput {
  return { ...JSON.parse(readFileSync(new URL('../../../apps/api/mocks/robust.json', import.meta.url), 'utf8')), now: NOW };
}
describe('complete Layer 1 mathematics', () => {
  it('reaches 100 with all positive table conditions and no email input', () => {
    const input = robust();
    input.website!.ai_policy.depth = 'comprehensive'; input.website!.ai_disclosure.found = true;
    input.avvo![0]!.attorney!.awards = ['Award'];
    const { preScore, signals } = scoreEvidence(input);
    expect(preScore.total).toBe(100);
    expect(Object.values(preScore.categories).map(c => c.score)).toEqual([35, 30, 20, 15]);
    expect(preScore.tier).toBe('FORTRESS');
    expect(signals.website).not.toHaveProperty('W10_domainType');
  });
  it('takes the jurisdiction from the registry the Bar matches came from', () => {
    expect(scoreEvidence({ ...robust(), barJurisdiction: 'FL' }).multipliers.jurisdiction)
      .toEqual({ state: 'FL', value: 1.25, known: true });
    // A state with no configured factor is still reported, with a neutral, unknown multiplier.
    expect(scoreEvidence({ ...robust(), barJurisdiction: 'GA' }).multipliers.jurisdiction)
      .toEqual({ state: 'GA', value: 1, known: false });
    expect(scoreEvidence({ ...robust(), barJurisdiction: null }).multipliers.jurisdiction)
      .toEqual({ state: null, value: 1, known: false });
  });
  it('reports no jurisdiction when no Bar match certifies one', () => {
    const input = { ...robust(), barJurisdiction: 'FL' };
    input.bar = input.bar!.map(match => ({ ...match, attorney: null, matchConfidence: 'no_match' as const }));
    expect(scoreEvidence(input).multipliers.jurisdiction).toEqual({ state: null, value: 1, known: false });
  });
  it('scores the robust mock at 82 with the revised reputation table', () => { expect(scoreEvidence(robust()).preScore.total).toBe(82); });
  it('forces score zero after an active-investigation override', () => {
    const input = robust(), before = scoreEvidence(input);
    input.bar![0]!.attorney!.activeInvestigation = true;
    const after = scoreEvidence(input);
    expect(before.preScore.total).toBeGreaterThan(0);
    expect(after.preScore.total).toBe(0);
    expect(after.preScore.tier).toBe('CRITICAL');
    expect(after.preScore.decision).toBe('DECLINE');
  });
  it('applies a recent-sanction override after scoring', () => {
    const input = robust();
    input.bar![0]!.attorney!.hasDisciplinaryHistory = true;
    input.bar![0]!.attorney!.disciplinaryActions = [{ severity: 'public_reprimand', date: '2026-08-01', description: 'Confirmed' }];
    const result = scoreEvidence(input).preScore;
    expect(result.total).toBe(72);
    expect(result.tier).toBe('FORTIFIED');
    expect(result.decision).toBe('REFERRAL_SENIOR');
  });
  it('uses fixed severity before recency for the historical penalty', () => {
    const input = robust();
    input.bar![0]!.attorney!.hasDisciplinaryHistory = true;
    input.bar![0]!.attorney!.disciplinaryActions = [
      { severity: 'public_reprimand', date: '2024-01-01', description: null },
      { severity: 'suspension', date: '2019-01-01', description: null },
    ];
    const result = scoreEvidence(input);
    expect(result.signals.bar.B2_worstDisciplinary).toBe('suspension');
    expect(result.preScore.categories.professionalStanding.rules.find(r => r.id === 'B2_sanction')?.points).toBe(-2);
  });
  it('does not invent a date or severity for unknown sanctions', () => {
    const input = robust();
    input.bar![0]!.attorney!.hasDisciplinaryHistory = true;
    input.bar![0]!.attorney!.disciplinaryActions = [{ severity: null, date: null, description: 'Unspecified sanction' }];
    const score = scoreEvidence(input).preScore;
    expect(score.categories.professionalStanding.rules.find(r => r.id === 'B2_sanction')?.points).toBeNull();
    expect(score.flags).toContain('DISCIPLINARY_DETAILS_UNKNOWN');
    expect(score.overrides).toEqual([]);
  });
  it.each([['2025-09-06', 'recent'], ['2025-09-05', 'one_to_three'], ['2023-09-06', 'one_to_three'],
    ['2023-09-05', 'three_to_five'], ['2021-09-05', 'three_to_five'], ['2021-09-04', 'over_five'],
    ['2027-01-01', null], ['2026-02-30', null]] as const)('assigns exact calendar bucket for %s', (date, bucket) => {
    expect(sanctionBucket(date, NOW)).toBe(bucket);
  });
  it('handles leap-day anniversaries without inventing March 1', () => {
    expect(sanctionBucket('2024-02-29', '2025-02-28T00:00:00Z')).toBe('one_to_three');
  });
  it('scores all missing source evidence as zero with low confidence and neutral multipliers', () => {
    const input = robust(); input.website = null; input.bar = null; input.avvo = null;
    for (const source of Object.values(input.sources)) Object.assign(source, { status: 'error', dataStatus: 'UNKNOWN', attorneysSearched: null });
    const result = scoreEvidence(input);
    expect(result.preScore.total).toBe(0);
    expect(result.preScore.tier).toBe('CRITICAL');
    expect(result.preScore.decision).toBe('UNKNOWN');
    expect(result.preScore.assessmentStatus).toBe('INSUFFICIENT_EVIDENCE');
    expect(result.preScore.flags).toContain('COMMERCIAL_DECISION_BLOCKED');
    expect(result.preScore.confidence).toBe('LOW');
    expect(Object.values(result.multipliers).every(m => m.value === 1 && !m.known)).toBe(true);
  });
  it('separates technical source success from zero matches', () => {
    const input = robust(); input.bar = []; input.avvo = [];
    input.sources.bar.attorneysFound = 0;
    const result = scoreEvidence(input);
    expect(result.preScore.confidence).toBe('HIGH');
    expect(result.signals.bar.B1_allActive).toBeNull();
    expect(result.signals.bar.B2_worstDisciplinary).toBeNull();
    expect(result.signals.avvo.A1_avgRating).toBeNull();
  });
  it('keeps unknown provider accounting explicit', () => {
    const input = robust();
    Object.assign(input.sources.avvo, { accountingComplete: false, costUsd: null });
    const flags = scoreEvidence(input).preScore.flags;
    expect(flags).toContain('PROVIDER_COST_UNKNOWN');
    // Spend is no longer capped, so no run can be refused for budget and the flag is gone.
    expect(flags).not.toContain('PROVIDER_BUDGET_EXCEEDED');
  });
  it('does not fabricate an age at an ambiguous year boundary', () => {
    const website = unknownWebsite(); website.firm_established_year = 2016;
    expect(firmMaturity(website, null, NOW).rules.find(r => r.id === 'W8')?.points).toBeNull();
  });
  it('preserves a below-one practice multiplier rather than clamping it to one', () => {
    const input = robust(); input.website!.practice_areas = ['Tax']; input.avvo![0]!.attorney!.practiceAreas = ['Tax'];
    expect(scoreEvidence(input).multipliers.practiceArea).toEqual({ area: 'Tax/Regulatory', value: .75, known: true });
  });
});

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { PreScore, type ScoringInput, type SourceStatus } from '@arca/contracts';
import { DEMO_BANK, type Answers } from '@arca/questions';
import { fixtureResult } from '../../contracts/tests/fixture.js';
import { WEBSITE_UNAVAILABLE, scoreAssessment, scoreEvidence } from '../src/index.js';

const NOW = '2026-11-09T10:00:00.000Z';
const robust = (): ScoringInput =>
  ({ ...JSON.parse(readFileSync(new URL('../../../apps/api/mocks/robust.json', import.meta.url), 'utf8')), now: NOW });
const skipped: SourceStatus = { status: 'skipped', dataStatus: 'UNKNOWN', durationMs: 0, code: 'INSUFFICIENT_IDENTITY',
  reason: 'No verified firm name or attorney identity was extracted' };
const refused: SourceStatus = { status: 'error', dataStatus: 'UNKNOWN', durationMs: 0, pagesCrawled: 0, code: 'ACCESS_BLOCKED',
  reason: 'The website refused automated access (HTTP 403)' };
// What the pipeline hands over when the website gave nothing: no identity, so neither directory was asked.
const unread = (website: SourceStatus): ScoringInput =>
  ({ website: null, bar: null, avvo: null, sources: { website, bar: skipped, avvo: skipped }, now: NOW });
const OVERRIDE = { id: 'WEBSITE_UNAVAILABLE', decision: 'REFERRAL_SENIOR', reason: 'The firm website could not be read' };

describe('what a website that refuses to be read does to the pre-score', () => {
  it('marks the firm high risk with existing contract values only', () => {
    const { preScore } = scoreEvidence(unread(refused));
    expect(preScore).toMatchObject({ total: 0, tier: 'CRITICAL', confidence: 'LOW', assessmentStatus: 'INSUFFICIENT_EVIDENCE',
      decision: 'REFERRAL_SENIOR', overrides: [OVERRIDE] });
    expect(preScore.flags).toEqual(['INCOMPLETE_SOURCES', 'WEBSITE_UNAVAILABLE', 'INCOMPLETE_EVIDENCE', 'COMMERCIAL_DECISION_BLOCKED']);
    expect(Object.values(preScore.categories).map(category => category.status)).toEqual(['UNKNOWN', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN']);
    expect(WEBSITE_UNAVAILABLE).toBe('WEBSITE_UNAVAILABLE');
    expect(() => PreScore.parse(preScore)).not.toThrow();
  });

  it('marks it too when a directory happened to answer', () => {
    const input = { ...robust(), website: null };
    input.sources = { ...input.sources, website: refused };
    const { preScore } = scoreEvidence(input);
    expect(preScore.flags).toContain('WEBSITE_UNAVAILABLE');
    expect(preScore.overrides).toEqual([OVERRIDE]);
    expect(preScore.decision).toBe('REFERRAL_SENIOR');
    // The directories still count for what they showed.
    expect(preScore.total).toBeGreaterThan(0);
  });

  it.each<[string, SourceStatus]>([
    ['our own provider failing', { ...refused, code: 'PROVIDER_ERROR', reason: 'Website evidence extraction unavailable' }],
    ['the deadline', { ...refused, status: 'timeout', code: 'DEADLINE_REACHED', reason: 'Deadline reached' }],
    ['a page that came back empty', { ...refused, code: 'NO_READABLE_EVIDENCE', reason: 'The website returned a page with no readable text' }],
    ['a failure nobody named', { status: 'error', dataStatus: 'UNKNOWN', durationMs: 0 }],
  ])('concludes nothing about the firm from %s', (_name, website) => {
    const { preScore } = scoreEvidence(unread(website));
    expect(preScore.flags).not.toContain('WEBSITE_UNAVAILABLE');
    expect(preScore.overrides).toEqual([]);
    expect(preScore.decision).toBe('UNKNOWN');
  });

  it('leaves a website that was read alone', () => {
    for (const status of ['ok', 'partial'] as const) {
      const input = robust();
      // A code left on a readable source must not brand the firm either.
      input.sources = { ...input.sources, website: { ...input.sources.website, status, code: 'ACCESS_BLOCKED' } };
      const { preScore } = scoreEvidence(input);
      expect(preScore.flags).not.toContain('WEBSITE_UNAVAILABLE');
      expect(preScore.overrides).toEqual([]);
    }
  });

  it('never loosens a stricter disciplinary restriction', () => {
    const input = { ...robust(), website: null };
    input.sources = { ...input.sources, website: refused };
    input.bar![0]!.attorney!.activeInvestigation = true;
    const { preScore } = scoreEvidence(input);
    expect(preScore.decision).toBe('DECLINE');
    expect(preScore.overrides.map(override => override.id)).toEqual(['ACTIVE_INVESTIGATION', 'WEBSITE_UNAVAILABLE']);
  });

  it('gives the same result every time', () => {
    expect(JSON.stringify(scoreEvidence(unread(refused)))).toBe(JSON.stringify(scoreEvidence(structuredClone(unread(refused)))));
  });
});

describe('what the questionnaire can do about a website that could not be read', () => {
  // The best answer to every scored question of the demo bank.
  const best: Answers = {
    'D1.1': { kind: 'option', optionId: 'written_shared' }, 'D1.2': { kind: 'option', optionId: 'yes' },
    'D2.1': { kind: 'options', optionIds: ['legal_enterprise', 'enterprise_general'] },
    'D3.1': { kind: 'scale', value: 4 }, 'D3.2': { kind: 'option', optionId: 'primary_sources' },
    'D4.1': { kind: 'options', optionIds: ['redaction', 'agreements'] }, 'D5.1': { kind: 'number', value: 12 },
    'D6.1': { kind: 'option', optionId: 'yes' },
  };
  const layer1 = () => ({ ...fixtureResult(), ...scoreEvidence(unread(refused)),
    sources: { website: refused, bar: skipped, avvo: skipped } });
  const completedAt = '2026-11-09T11:00:00.000Z';

  it('cannot erase the restriction or the flag, even with perfect answers', () => {
    const result = scoreAssessment({ assessmentId: 'as_unread', layer1: layer1(), bank: DEMO_BANK, answers: best, completedAt });
    expect(result.layer2Score).toBe(100);
    // Nothing public was verified, so Layer 1 adds nothing to the composite: 0 x 0.3 + 100 x 0.7.
    expect(result).toMatchObject({ layer1Score: 0, compositeScore: 70, decision: 'REFERRAL_SENIOR', commercialDecisionBlocked: true });
    expect(result.flags).toEqual(expect.arrayContaining(['WEBSITE_UNAVAILABLE', 'INSUFFICIENT_EVIDENCE', 'COMMERCIAL_DECISION_BLOCKED']));
  });

  it('keeps both with no answers at all', () => {
    const result = scoreAssessment({ assessmentId: 'as_unread', layer1: layer1(), bank: DEMO_BANK, answers: {}, completedAt });
    expect(result.decision).toBe('REFERRAL_SENIOR');
    expect(result.flags).toContain('WEBSITE_UNAVAILABLE');
  });
});

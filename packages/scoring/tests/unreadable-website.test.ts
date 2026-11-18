import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { AssessmentResult, PreScore, type ScoringInput, type SourceStatus } from '@arca/contracts';
import { DEMO_BANK, type Answers } from '@arca/questions';
import { fixtureResult } from '../../contracts/tests/fixture.js';
import { DEMO_LAYER2_WEIGHT, LAYER1_UNAVAILABLE, WEBSITE_UNAVAILABLE, scoreAssessment, scoreEvidence } from '../src/index.js';

const NOW = '2026-11-09T10:00:00.000Z';
const robust = (): ScoringInput =>
  ({ ...JSON.parse(readFileSync(new URL('../../../apps/api/mocks/robust.json', import.meta.url), 'utf8')), now: NOW });
const skipped: SourceStatus = { status: 'skipped', dataStatus: 'UNKNOWN', durationMs: 0, code: 'INSUFFICIENT_IDENTITY',
  reason: 'No verified firm name or attorney identity was extracted' };
const refused: SourceStatus = { status: 'error', dataStatus: 'UNKNOWN', durationMs: 0, pagesCrawled: 0, code: 'ACCESS_BLOCKED',
  reason: 'The website refused automated access (HTTP 403)' };
const unreachable: SourceStatus = { status: 'error', dataStatus: 'UNKNOWN', durationMs: 0, pagesCrawled: 0, code: 'PROVIDER_ERROR',
  reason: 'The website could not be reached' };
// What the pipeline hands over when the website gave nothing: no identity, so neither directory was asked.
const unread = (website: SourceStatus): ScoringInput =>
  ({ website: null, bar: null, avvo: null, sources: { website, bar: skipped, avvo: skipped }, now: NOW });

describe('what a website the site kept us from reading does to the pre-score', () => {
  it.each<[string, SourceStatus]>([
    ['refuses to be read', refused],
    ['could not be reached', unreachable],
    ['answered 5xx', { ...unreachable, reason: 'The website did not serve its pages (HTTP 503)' }],
    ['kept robots.txt out of reach', { ...unreachable, reason: 'robots.txt could not be retrieved (HTTP 503), so the website was not read' }],
    ['came back empty', { ...unreachable, code: 'NO_READABLE_EVIDENCE', reason: 'The website returned a page with no readable text' }],
    ['did not answer before the crawl deadline', { ...unreachable, status: 'timeout', code: 'DEADLINE_REACHED',
      reason: 'The crawl deadline was reached before any page was read' }],
  ])('flags it, with low confidence and no override, when the site %s', (_name, website) => {
    const { preScore } = scoreEvidence(unread(website));
    expect(preScore).toMatchObject({ confidence: 'LOW', assessmentStatus: 'INSUFFICIENT_EVIDENCE', decision: 'UNKNOWN', overrides: [] });
    expect(preScore.flags).toEqual(['INCOMPLETE_SOURCES', 'WEBSITE_UNAVAILABLE', 'INCOMPLETE_EVIDENCE', 'COMMERCIAL_DECISION_BLOCKED']);
    expect(Object.values(preScore.categories).map(category => category.status)).toEqual(['UNKNOWN', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN']);
    expect(() => PreScore.parse(preScore)).not.toThrow();
  });

  it('no longer sends the firm to a senior underwriter (DN-12 §14 replaces D4)', () => {
    const { preScore } = scoreEvidence(unread(refused));
    expect(preScore.decision).not.toBe('REFERRAL_SENIOR');
    expect(preScore.overrides.map(override => override.id)).not.toContain(WEBSITE_UNAVAILABLE);
  });

  it('flags it too when a directory happened to answer, and the directories still count', () => {
    const input = { ...robust(), website: null };
    input.sources = { ...input.sources, website: refused };
    const { preScore } = scoreEvidence(input);
    expect(preScore.flags).toContain('WEBSITE_UNAVAILABLE');
    expect(preScore.overrides).toEqual([]);
    expect(preScore.total).toBeGreaterThan(0);
  });

  it.each<[string, SourceStatus]>([
    ['the extraction failing on pages that were read', { ...unreachable, pagesCrawled: 3, reason: 'Website evidence extraction unavailable' }],
    ['our deadline while pages were being read', { ...unreachable, status: 'timeout', code: 'DEADLINE_REACHED', pagesCrawled: 3 }],
    ['the pipeline deadline', { status: 'timeout', dataStatus: 'UNKNOWN', durationMs: 0, code: 'DEADLINE_REACHED', reason: 'Deadline reached' }],
    ['a source that threw', { status: 'error', dataStatus: 'UNKNOWN', durationMs: 0, code: 'PROVIDER_ERROR', reason: 'Source unavailable' }],
  ])('concludes nothing about the firm from %s', (_name, website) => {
    const { preScore } = scoreEvidence(unread(website));
    expect(preScore.flags).not.toContain('WEBSITE_UNAVAILABLE');
    expect(preScore.overrides).toEqual([]);
    expect(preScore.decision).toBe('UNKNOWN');
  });

  it('leaves a website that was read alone', () => {
    for (const status of ['ok', 'partial'] as const) {
      const input = robust();
      // A code left on a readable source must not flag the firm either.
      input.sources = { ...input.sources, website: { ...input.sources.website, status, code: 'ACCESS_BLOCKED', pagesCrawled: 0 } };
      const { preScore } = scoreEvidence(input);
      expect(preScore.flags).not.toContain('WEBSITE_UNAVAILABLE');
      expect(preScore.overrides).toEqual([]);
    }
  });

  it('keeps a disciplinary restriction, which comes from the directories', () => {
    const input = { ...robust(), website: null };
    input.sources = { ...input.sources, website: refused };
    input.bar![0]!.attorney!.activeInvestigation = true;
    const { preScore } = scoreEvidence(input);
    expect(preScore.decision).toBe('DECLINE');
    expect(preScore.overrides.map(override => override.id)).toEqual(['ACTIVE_INVESTIGATION']);
  });

  it('gives the same result every time', () => {
    expect(JSON.stringify(scoreEvidence(unread(refused)))).toBe(JSON.stringify(scoreEvidence(structuredClone(unread(refused)))));
  });
});

describe('the assessment of a firm whose website could not be read', () => {
  // The best answer to every scored question of the demo bank.
  const best: Answers = {
    'D1.1': { kind: 'option', optionId: 'written_shared' }, 'D1.2': { kind: 'option', optionId: 'yes' },
    'D2.1': { kind: 'options', optionIds: ['legal_enterprise', 'enterprise_general'] },
    'D3.1': { kind: 'scale', value: 4 }, 'D3.2': { kind: 'option', optionId: 'primary_sources' },
    'D4.1': { kind: 'options', optionIds: ['redaction', 'agreements'] }, 'D5.1': { kind: 'number', value: 12 },
    'D6.1': { kind: 'option', optionId: 'yes' },
  };
  const weak: Answers = { 'D1.1': { kind: 'option', optionId: 'written_shared' }, 'D3.1': { kind: 'scale', value: 1 } };
  const layer1 = (website: SourceStatus = refused) => ({ ...fixtureResult(), ...scoreEvidence(unread(website)),
    sources: { website, bar: skipped, avvo: skipped } });
  const completedAt = '2026-11-09T11:00:00.000Z';
  const score = (answers: Answers, website?: SourceStatus) =>
    scoreAssessment({ assessmentId: 'as_unread', layer1: layer1(website), bank: DEMO_BANK, answers, completedAt });

  it('scores on the answers alone: no Layer 1 score and the composite equals Layer 2', () => {
    for (const answers of [best, weak, {}]) {
      const result = score(answers);
      expect(result.layer1Score).toBeNull();
      expect(result.compositeScore).toBe(result.layer2Score);
      expect(() => AssessmentResult.parse(result)).not.toThrow();
    }
    expect(score(best)).toMatchObject({ layer2Score: 100, compositeScore: 100, tier: 'FORTRESS' });
  });

  it('marks the result LAYER1_UNAVAILABLE and keeps WEBSITE_UNAVAILABLE', () => {
    for (const website of [refused, unreachable]) {
      const result = score(best, website);
      expect(result.flags).toEqual(expect.arrayContaining([LAYER1_UNAVAILABLE, WEBSITE_UNAVAILABLE, 'INSUFFICIENT_EVIDENCE',
        'COMMERCIAL_DECISION_BLOCKED']));
    }
  });

  it('adds no senior referral, whatever the answers', () => {
    for (const answers of [best, weak, {}]) {
      const result = score(answers);
      expect(result.decision).toBe('UNKNOWN');
      expect(result.commercialDecisionBlocked).toBe(true);
    }
  });

  it('counts each step of the action plan at its full weight, as the composite is Layer 2 alone', () => {
    const answersOnly = score(weak);
    const step = answersOnly.actionPlan[0]!;
    // The same answers on a readable website: the composite carries Layer 2 at its demo weight.
    const read = scoreAssessment({ assessmentId: 'as_read', layer1: fixtureResult(), bank: DEMO_BANK, answers: weak, completedAt });
    const same = read.actionPlan.find(item => item.id === step.id)!;
    expect(step.pointsGain).toBeCloseTo(same.pointsGain / DEMO_LAYER2_WEIGHT, 1);
  });

  it('keeps the 30/70 composite for a website that was read', () => {
    const read = scoreAssessment({ assessmentId: 'as_read', layer1: fixtureResult(), bank: DEMO_BANK, answers: best, completedAt });
    expect(read.layer1Score).not.toBeNull();
    expect(read.flags).not.toContain(LAYER1_UNAVAILABLE);
    expect(read.compositeScore).toBe(Math.round((read.layer1Score! * 0.3 + read.layer2Score * 0.7) * 100) / 100);
  });
});

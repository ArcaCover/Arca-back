import { describe, expect, it } from 'vitest';
import { unknownWebsite } from '@arca/contracts';
import { aiGovernance, reputation, category, tierForScore, decisionForTier, restrictDecision, mean, sum, allKnownTrue, anyKnownTrue, jaccard } from '../src/index.js';

describe('evidence-aware scoring', () => {
  it('scores unavailable evidence as zero while preserving unknown rule state', () => {
    const score = aiGovernance(unknownWebsite());
    expect(score.score).toBe(0);
    expect(score.status).toBe('UNKNOWN');
    expect(score.rules.every(rule => rule.points === null)).toBe(true);
    expect(mean([null, null])).toBeNull();
    expect(sum([])).toBe(0);
    expect(allKnownTrue([])).toBeNull();
    expect(allKnownTrue([true, null])).toBeNull();
    expect(anyKnownTrue([false, null])).toBeNull();
    expect(tierForScore(null)).toBe('UNKNOWN');
  });
  it('distinguishes known zero, positive and missing observations', () => {
    expect(mean([0, null, 10])).toBe(5);
    expect(sum([0, null])).toBe(0);
    expect(allKnownTrue([true, false, null])).toBe(false);
    expect(anyKnownTrue([true, null])).toBe(true);
  });
  it('follows the 35 point AI table', () => {
    const website = unknownWebsite();
    website.ai_policy = { found: true, depth: 'comprehensive', text_excerpt: 'Our policy' };
    website.ai_in_services.found = true;
    website.ai_disclosure.found = true;
    website.ai_blog_posts.found = true;
    expect(aiGovernance(website).score).toBe(35);
  });
  it('a mention does not award the policy and usage combination', () => {
    const website = unknownWebsite();
    website.ai_policy.depth = 'mention_only';
    website.ai_in_services.found = true;
    const score = aiGovernance(website);
    expect(score.rules.find(rule => rule.id === 'W2')?.points).toBe(-10);
    expect(score.score).toBe(0);
    expect(score.status).toBe('PARTIAL');
  });
  it('an unknown policy does not trigger an AI use penalty', () => {
    const website = unknownWebsite();
    website.ai_in_services.found = true;
    expect(aiGovernance(website).rules.find(rule => rule.id === 'W2')?.points).toBeNull();
  });
  it('computes the supplied example AI signals as 23, not 28', () => {
    const website = unknownWebsite();
    website.ai_policy.depth = 'basic'; website.ai_in_services.found = true;
    website.ai_disclosure.found = false; website.ai_blog_posts.found = true;
    expect(aiGovernance(website).score).toBe(23);
  });
  it('keeps reputation rules unknown without manufacturing points', () => {
    expect(reputation({ rating: null, reviewRating: null, reviewCount: null, awards: null }).score).toBe(0);
  });
  it.each([[8, 9], [7.95, 6], [7, 6], [6.99, 2], [5, 2], [4.99, -5]])('rates %s as %s points without decimal gaps', (rating, points) => {
    const result = reputation({ rating, reviewRating: null, reviewCount: null, awards: null });
    expect(result.rules[0]?.points).toBe(points);
  });
  it('caps a category and preserves zero after observed penalties', () => {
    const r = (points: number) => ({ id: 'observed', points, reason: 'Known evidence' });
    expect(category(15, [r(30)]).score).toBe(15);
    expect(category(15, [r(-5)]).score).toBe(0);
  });
  it.each([[0, 'CRITICAL'], [24, 'CRITICAL'], [25, 'EXPOSED'], [44, 'EXPOSED'], [45, 'GUARDED'], [64, 'GUARDED'], [65, 'FORTIFIED'], [79, 'FORTIFIED'], [80, 'FORTRESS'], [100, 'FORTRESS']] as const)('assigns score %s to %s', (score, tier) => {
    expect(tierForScore(score)).toBe(tier);
  });
  it('overrides decisions without modifying quantitative tiers', () => {
    const score = 100, tier = tierForScore(score);
    const decision = restrictDecision(decisionForTier(tier), [{ id: 'active_investigation', decision: 'DECLINE', reason: 'Confirmed' }]);
    expect({ score, tier, decision }).toEqual({ score: 100, tier: 'FORTRESS', decision: 'DECLINE' });
    expect(restrictDecision('DECLINE', [{ id: 'suspended', decision: 'REFERRAL', reason: 'Confirmed' }])).toBe('DECLINE');
  });
  it('compares normalized areas without interpreting empty sets as agreement', () => {
    expect(jaccard(null, ['Immigration'])).toBeNull();
    expect(jaccard([], [])).toBeNull();
    expect(jaccard(['Immigration law', 'Criminal law'], ['criminal defense', 'immigration'])).toBe(1);
    expect(jaccard(['Tax', 'Family'], ['Tax'])).toBe(.5);
  });
});

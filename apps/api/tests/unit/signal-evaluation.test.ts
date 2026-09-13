import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { unknownWebsite } from '@arca/contracts';
import { GoldLabels, evaluateWebsiteData } from '../../src/pipeline/signal-evaluation.js';

const gold = GoldLabels.parse(JSON.parse(readFileSync('apps/api/tests/fixtures/gold/duqueimmigration.com.json', 'utf8')));

describe('signal precision evaluation', () => {
  it('counts verified values as correct regardless of accents and punctuation', () => {
    const data = { ...unknownWebsite(), firm_name: 'Duque Immigration Law PLLC', phone: '+1 305-436-0155',
      team_members: [{ full_name: 'Carlos Mauricio Duque', title: 'Abogado' }] };
    const result = evaluateWebsiteData(data, gold);
    expect(result.incorrect).toBe(0);
    expect(result.correct).toBe(3);
    expect(result.attorneyRecall).toBe(1);
  });

  it('flags staff accepted as attorneys and a career year accepted as founding', () => {
    const data = { ...unknownWebsite(), firm_established_year: 2007,
      team_members: [{ full_name: 'Diana Posada', title: 'Paralegal en inmigración' }] };
    const result = evaluateWebsiteData(data, gold);
    expect(result.incorrect).toBe(2);
    expect(result.outcomes.filter(item => item.verdict === 'incorrect').map(item => item.field).sort())
      .toEqual(['firm_established_year', 'team_members']);
  });

  it('rejects practice areas outside the verified set and ignores unverified fields', () => {
    const data = { ...unknownWebsite(), practice_areas: ['Immigration', 'Real Estate'],
      ai_policy: { found: false, depth: 'none' as const, text_excerpt: null } };
    const result = evaluateWebsiteData(data, gold);
    expect(result.outcomes.find(item => item.value === 'Real Estate')?.verdict).toBe('incorrect');
    expect(result.outcomes.find(item => item.field === 'ai_policy')?.verdict).toBe('unverified');
    expect(result.incorrect).toBe(1);
  });
});

import { expect, it } from 'vitest';
import { unknownWebsite, type WebsiteData } from '@arca/contracts';
import { measureConsistency } from '../../src/pipeline/signal-evaluation.js';

it('measures field agreement and score stability across runs', () => {
  const run = (patch: Partial<WebsiteData>): WebsiteData => ({ ...unknownWebsite(), firm_name: 'Duque Immigration Law', phone: '(305) 436-0155', ...patch });
  const result = measureConsistency([
    run({ city: 'Miami', team_members: [{ full_name: 'Ana Béjar', title: null }, { full_name: 'Carlos Duque', title: null }] }),
    run({ city: 'Miami', phone: '+1 305-436-0155', team_members: [{ full_name: 'Carlos Duque', title: 'Abogado' }, { full_name: 'ana bejar', title: null }] }),
    run({ city: null, team_members: [{ full_name: 'Ana Bejar', title: null }, { full_name: 'Carlos Duque', title: null }] }),
  ], [9, 9, 6]);
  const field = (name: string) => result.fields.find(item => item.field === name);
  expect(field('firm_name')?.agreed).toBe(true);
  expect(field('phone')?.agreed).toBe(true);
  expect(field('team_members')?.agreed).toBe(true);
  expect(field('city')).toMatchObject({ agreed: false, values: ['miami', 'miami', '—'] });
  expect(result.scoresAgree).toBe(false);
  expect(result.agreement).toBeCloseTo((result.fields.length - 1) / result.fields.length);
  expect(measureConsistency([run({})]).agreement).toBeNull();
});

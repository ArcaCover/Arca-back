import { z } from 'zod';
import type { WebsiteData } from '@arca/contracts';

const closed = <T extends z.ZodTypeAny>(item: T) => z.object({ correct: z.array(item) }).strict();
export const GoldLabels = z.object({
  domain: z.string().min(1),
  verifiedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  notes: z.string().min(1),
  fields: z.object({
    firm_name: closed(z.string()).optional(),
    city: closed(z.string()).optional(),
    phone: z.object({ digits: z.string().regex(/^\d{10}$/) }).strict().optional(),
    firm_established_year: closed(z.number().int()).optional(),
    team_size: closed(z.number().int()).optional(),
    practice_areas: z.object({ allowed: z.array(z.string()) }).strict().optional(),
    team_members: z.object({ attorneys: z.array(z.string()), notAttorneys: z.array(z.string()) }).strict().optional(),
  }).strict(),
  unverified: z.array(z.string()),
}).strict();
export type GoldLabels = z.infer<typeof GoldLabels>;
export type FieldOutcome = { field: string; value: unknown; verdict: 'correct' | 'incorrect' | 'unverified' | 'absent' };
export type Evaluation = { outcomes: FieldOutcome[]; correct: number; incorrect: number; attorneyRecall: number | null };

const key = (value: unknown) => String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLocaleLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const digits = (value: unknown) => String(value).replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');

/** Judges only what reached WebsiteData, because that is what scoring consumes. */
export function evaluateWebsiteData(data: WebsiteData, gold: GoldLabels): Evaluation {
  const outcomes: FieldOutcome[] = [];
  const push = (field: string, value: unknown, verdict: FieldOutcome['verdict']) => outcomes.push({ field, value, verdict });
  const labels = gold.fields;
  for (const field of ['firm_name', 'city', 'firm_established_year', 'team_size'] as const) {
    const value = data[field], label = labels[field];
    if (value === null) { push(field, value, 'absent'); continue; }
    if (!label) { push(field, value, 'unverified'); continue; }
    push(field, value, (label.correct as unknown[]).some(item => key(item) === key(value)) ? 'correct' : 'incorrect');
  }
  if (data.phone === null) push('phone', null, 'absent');
  else push('phone', data.phone, !labels.phone ? 'unverified' : digits(data.phone) === labels.phone.digits ? 'correct' : 'incorrect');
  for (const area of data.practice_areas ?? []) {
    push('practice_areas', area, !labels.practice_areas ? 'unverified'
      : labels.practice_areas.allowed.some(item => key(item) === key(area)) ? 'correct' : 'incorrect');
  }
  const roster = labels.team_members;
  const found = new Set<string>();
  for (const person of data.team_members ?? []) {
    const name = key(person.full_name);
    const verdict = !roster ? 'unverified' : roster.attorneys.some(item => key(item) === name) ? 'correct'
      : roster.notAttorneys.some(item => key(item) === name) ? 'incorrect' : 'unverified';
    if (verdict === 'correct') found.add(name);
    push('team_members', person.full_name, verdict);
  }
  for (const field of gold.unverified) {
    const value = (data as Record<string, unknown>)[field];
    const empty = value === null || (typeof value === 'object' && value !== null && Object.values(value).every(item => item === null));
    push(field, value, empty ? 'absent' : 'unverified');
  }
  return { outcomes, correct: outcomes.filter(item => item.verdict === 'correct').length,
    incorrect: outcomes.filter(item => item.verdict === 'incorrect').length,
    attorneyRecall: roster?.attorneys.length ? found.size / roster.attorneys.length : null };
}

export type ConsistencyField = { field: string; agreed: boolean; values: string[] };
export type Consistency = { runs: number; fields: ConsistencyField[]; agreement: number | null; scoresAgree: boolean | null };
const CONSISTENCY_FIELDS = ['firm_name', 'firm_aliases', 'city', 'county', 'address_street', 'phone', 'office_count',
  'firm_established_year', 'practice_areas', 'team_members', 'team_page_quality', 'website_quality', 'privacy_policy',
  'ai_policy', 'ai_in_services', 'ai_disclosure', 'ai_blog_posts'] as const;

function comparable(field: (typeof CONSISTENCY_FIELDS)[number], data: WebsiteData): string {
  const value = (data as Record<string, unknown>)[field];
  if (value === null || value === undefined) return '—';
  if (field === 'phone') return digits(value) || '—';
  if (field === 'team_members') return (value as Array<{ full_name: string }>).map(person => key(person.full_name)).sort().join(' | ') || '—';
  if (Array.isArray(value)) return value.map(key).sort().join(' | ') || '—';
  if (typeof value === 'object') {
    const parts = Object.entries(value).filter(([name]) => name !== 'text_excerpt' && name !== 'titles')
      .map(([name, item]) => `${name}=${item === null ? '—' : Array.isArray(item) ? item.map(key).sort().join(',') : key(item)}`);
    return parts.every(part => part.endsWith('=—')) ? '—' : parts.join(' ');
  }
  return key(value);
}

/** Same crawl, same version: every accepted value and the score should repeat across runs. */
export function measureConsistency(runs: WebsiteData[], scores: number[] = []): Consistency {
  const fields = CONSISTENCY_FIELDS.map(field => {
    const values = runs.map(run => comparable(field, run));
    return { field, agreed: values.every(value => value === values[0]), values };
  });
  return { runs: runs.length, fields, agreement: runs.length > 1 ? fields.filter(field => field.agreed).length / fields.length : null,
    scoresAgree: scores.length > 1 ? scores.every(score => score === scores[0]) : null };
}

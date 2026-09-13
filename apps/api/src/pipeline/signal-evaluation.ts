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

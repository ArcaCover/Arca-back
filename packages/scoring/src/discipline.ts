import type { AttorneyMatch, DisciplinaryAction, PreScore } from '@arca/contracts';
import { allKnownTrue, anyKnownTrue } from './math.js';

export const SEVERITY_RANK = { none: 0, admonishment: 1, public_reprimand: 2, suspension: 3, disbarment: 4 } as const;
export function validDate(value: string | null): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? date : null;
}
export function anniversary(date: Date, years: number): Date {
  const targetYear = date.getUTCFullYear() + years;
  const lastDay = new Date(Date.UTC(targetYear, date.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(targetYear, date.getUTCMonth(), Math.min(lastDay, date.getUTCDate())));
}
export type SanctionBucket = 'recent' | 'one_to_three' | 'three_to_five' | 'over_five';
export function sanctionBucket(value: string | null, now: string): SanctionBucket | null {
  const date = validDate(value), today = validDate(now.slice(0, 10));
  if (!date || !today || date > today) return null;
  if (today < anniversary(date, 1)) return 'recent';
  if (today < anniversary(date, 3)) return 'one_to_three';
  if (today <= anniversary(date, 5)) return 'three_to_five';
  return 'over_five';
}
export function yearsSince(value: string | null, now: string): number | null {
  const date = validDate(value), today = validDate(now.slice(0, 10));
  if (!date || !today || date > today) return null;
  let years = today.getUTCFullYear() - date.getUTCFullYear();
  if (today < anniversary(date, years)) years--;
  const start = anniversary(date, years), end = anniversary(date, years + 1);
  return years + (today.getTime() - start.getTime()) / (end.getTime() - start.getTime());
}
function severity(action: DisciplinaryAction): keyof typeof SEVERITY_RANK | null {
  return action.severity && action.severity in SEVERITY_RANK ? action.severity as keyof typeof SEVERITY_RANK : null;
}
export function disciplinaryEvidence(bar: AttorneyMatch[] | null, avvo: AttorneyMatch[] | null, now: string) {
  const all = [...(bar ?? []), ...(avvo ?? [])];
  const actions = all.flatMap(match => match.attorney?.disciplinaryActions ?? []);
  const clean = allKnownTrue((bar ?? []).map(match => {
    const person = match.attorney;
    if (!person || person.hasDisciplinaryHistory === null) return null;
    return !person.hasDisciplinaryHistory;
  }));
  const crossRef = anyKnownTrue(all.map(match => match.attorney?.hasDisciplinaryHistory ?? null));
  const cleanRecord = crossRef === true || actions.length > 0 ? false : clean;
  const unknownSeverity = actions.some(action => severity(action) === null);
  const ranked = actions.filter(action => severity(action) !== null && severity(action) !== 'none')
    .sort((a, b) => SEVERITY_RANK[severity(b)!] - SEVERITY_RANK[severity(a)!] || (b.date ?? '').localeCompare(a.date ?? ''));
  const worst = unknownSeverity ? null : ranked[0] ?? null;
  const worstSeverity = unknownSeverity ? null : worst?.severity ?? (cleanRecord === true ? 'none' : null);
  const bucket = worst ? sanctionBucket(worst.date, now) : null;
  const penalties = { recent: 0, one_to_three: -12, three_to_five: -6, over_five: -2 };
  const penalty = cleanRecord === true ? 0 : bucket ? penalties[bucket] : null;
  const overrides: PreScore['overrides'] = [];
  if ((bar ?? []).some(match => ['suspended', 'disbarred'].includes(match.attorney?.barStatus ?? ''))) {
    overrides.push({ id: 'SUSPENDED_OR_DISBARRED', decision: 'REFERRAL', reason: 'A matched attorney is suspended or disbarred' });
  }
  if (actions.some(action => severity(action) !== 'none' && sanctionBucket(action.date, now) === 'recent')) {
    overrides.push({ id: 'RECENT_SANCTION', decision: 'REFERRAL_SENIOR', reason: 'A confirmed sanction occurred within the last 12 calendar months' });
  }
  if (all.some(match => match.attorney?.activeInvestigation === true)) {
    overrides.push({ id: 'ACTIVE_INVESTIGATION', decision: 'DECLINE', reason: 'An active regulatory investigation is confirmed' });
  }
  return { cleanRecord, worstSeverity, penalty, overrides,
    uncertain: (crossRef === true && !ranked.length) || unknownSeverity || (worst !== null && bucket === null) };
}

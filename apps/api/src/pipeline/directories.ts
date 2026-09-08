import { unknownAttorney, Attorney, type AttorneyMatch, type DirectoryQuery, type DirectorySource, type SourceResult } from '@arca/contracts';
import { z } from 'zod';
import { ApifyClient } from './apify-client.js';
import { normalizeName, stableSample, matchAttorney } from './matching.js';
import { validDate } from '@arca/scoring';

export const BAR_ACTOR = 'scrapers_lat/florida-bar-lawyers-scraper';
export const AVVO_ACTOR = 'solidcode/avvo-scraper';
const record = z.record(z.unknown());
const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null;
const number = (value: unknown, min = 0, max = Infinity): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : null;
const strings = (value: unknown): string[] | null => Array.isArray(value) && value.every(item => typeof item === 'string') ? value : null;
const boolean = (value: unknown): boolean | null => typeof value === 'boolean' ? value : null;
function barStatus(value: unknown): Attorney['barStatus'] {
  const status = text(value)?.toLowerCase();
  if (!status) return null;
  if (/disbarred|disbarment/.test(status)) return 'disbarred';
  if (/suspend/.test(status)) return 'suspended';
  if (/inactive/.test(status)) return 'inactive';
  if (/retired/.test(status)) return 'retired';
  if (/deceased/.test(status)) return 'deceased';
  if (status === 'active' || status === 'member in good standing') return 'active';
  return 'UNKNOWN';
}
function admission(value: unknown): string | null {
  const date = text(value), parts = date?.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return parts ? `${parts[3]}-${parts[1]}-${parts[2]}` : null;
}
export function parseDisciplineSummary(summary: string): NonNullable<Attorney['disciplinaryActions']> {
  return summary.split(/[\n;]/).map(line => line.trim()).filter(Boolean).map(description => {
    const levels = [
      ['disbarment', /\bdisbar(?:ment|red)\b/i], ['suspension', /\bsuspen(?:sion|ded)\b/i],
      ['public_reprimand', /\bpublic reprimand\b/i], ['admonishment', /\badmonish(?:ment|ed)\b/i],
    ] as const;
    const severityMatches = levels.filter(([, regex]) => regex.test(description));
    const dates = [...description.matchAll(/\b(?:\d{4}-\d{2}-\d{2}|\d{2}\/\d{2}\/\d{4})\b/g)]
      .map(match => match[0].includes('/') ? admission(match[0]) : match[0]).filter(date => validDate(date));
    return { severity: severityMatches.length === 1 ? severityMatches[0]![0] : null,
      date: dates.length === 1 ? dates[0]! : null, description };
  });
}
export function parseBar(raw: unknown): Attorney | null {
  const row = record.parse(raw), name = text(row.name);
  if (row.error || !name) return null;
  const history = text(row.disciplineHistory10Year);
  // A ten-year 'None' does not establish a lifelong clean record.
  const positiveHistory = history !== null && /\b(disbar(?:ment|red)|suspen(?:sion|ded)|public reprimand|admonish(?:ment|ed)|disciplinary action|sanction)\b/i.test(history)
    && !/^(none|no\b|unknown|not available|n\/a)/i.test(history);
  const actions: Attorney['disciplinaryActions'] = positiveHistory ? parseDisciplineSummary(history!) : null;
  const pending = text(row.pendingDisciplineCases);
  // Pending cases are not silently classified as confirmed active regulatory investigations.
  return Attorney.parse({ ...unknownAttorney(name), city: text(row.physicalCity) ?? text(row.mailCity),
    firmName: text(row.firm), barNumber: text(row.barNumber), barStatus: barStatus(row.status),
    admissionDate: admission(row.admittedDate), hasDisciplinaryHistory: positiveHistory ? true : null,
    disciplinaryActions: actions, activeInvestigation: pending && /^no active regulatory investigation\b/i.test(pending) ? false :
      pending && /^active regulatory investigation\b/i.test(pending) ? true : null,
    practiceAreas: strings(row.practiceAreas), profileUrl: text(row.profileUrl) });
}
export function parseAvvo(raw: unknown): Attorney | null {
  const row = record.parse(raw), name = text(row.attorneyName);
  if (row.error || !name) return null;
  return Attorney.parse({ ...unknownAttorney(name), city: text(row.city), firmName: text(row.firmName),
    hasDisciplinaryHistory: boolean(row.disciplinaryAction),
    avvoRating: number(row.avvoRating, 1, 10), practiceAreas: strings(row.practiceAreas),
    reviewCount: Number.isInteger(row.reviewCount) ? number(row.reviewCount) : null,
    averageReviewRating: number(row.averageReviewRating, 0, 5),
    endorsementCount: Number.isInteger(row.peerEndorsementCount) ? number(row.peerEndorsementCount) : null,
    awards: strings(row.awards), profileUrl: text(row.profileUrl) });
}
function firmKey(value: string) { return value.toLowerCase().replace(/\b(p\.?\s*a\.?|llp|pllc|llc|inc)\b/g, '').replace(/[^a-z0-9]/g, ''); }
export class ApifyDirectorySource implements DirectorySource {
  constructor(private readonly source: 'bar' | 'avvo', private readonly client: Pick<ApifyClient, 'run'>) {}
  async run(query: DirectoryQuery, signal: AbortSignal): Promise<SourceResult<AttorneyMatch[]>> {
    const started = Date.now();
    const names = stableSample(query.names);
    const fallback = names.length === 0;
    const targets = fallback ? [query.firmName] : names;
    const rawResults: { target: string; items: unknown[] | null; error: string | null }[] = [];
    const matches: AttorneyMatch[] = [];
    let failed = 0, successfulQueries = 0;
    let cursor = 0;
    const worker = async () => {
      while (cursor < targets.length) {
        const target = targets[cursor++]!;
        if (signal.aborted) { failed++; continue; }
        try {
          const parts = normalizeName(target).split(' ');
          const input = this.source === 'bar' ? {
            lastNames: fallback ? [] : [parts.at(-1)!], firstName: fallback ? '' : parts[0]![0],
            ...(fallback ? { firm: target } : {}), maxLawyers: 30, withDetails: true,
            withLeadScore: false, withProfileSummary: false, eligibleOnly: false, includeDeceased: true,
          } : { lawyerSearch: [`${fallback ? target : `${parts[0]![0]} ${parts.at(-1)}`} attorney Florida`],
            states: ['FL'], includeReviews: true, maxReviewsPerAttorney: 10, maxItems: 15 };
          const items = await this.client.run(this.source === 'bar' ? BAR_ACTOR : AVVO_ACTOR, input, signal);
          rawResults.push({ target, items, error: null });
          const parse = this.source === 'bar' ? parseBar : parseAvvo;
          const candidates = items.map(item => parse(item));
          if (candidates.some(person => person === null)) failed++;
          const valid = candidates.filter((person): person is Attorney => person !== null);
          if (items.length === 0 || valid.length > 0) successfulQueries++;
          if (fallback) {
            const people = valid.filter(person => person.firmName && firmKey(person.firmName) === firmKey(target))
              .sort((a, b) => normalizeName(a.name).localeCompare(normalizeName(b.name))).slice(0, 15);
            matches.push(...people.map(attorney => ({ searchedName: target, matchConfidence: 'firm_fallback' as const, attorney, ambiguous: false })));
          } else matches.push(matchAttorney(target, valid));
          if (this.source === 'bar' && items.length >= 30) failed++;
        } catch {
          failed++;
          rawResults.push({ target, items: null, error: signal.aborted ? 'timeout' : 'source_error' });
          if (!fallback) matches.push({ searchedName: target, attorney: null, ambiguous: false, matchConfidence: 'no_match' });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(5, targets.length) }, worker));
    const successful = successfulQueries > 0;
    matches.sort((a, b) => a.searchedName.localeCompare(b.searchedName) || (a.attorney?.name ?? '').localeCompare(b.attorney?.name ?? ''));
    const found = matches.filter(match => match.attorney !== null).length;
    return { data: successful ? matches : null, rawContent: JSON.stringify(rawResults.sort((a, b) => a.target.localeCompare(b.target))),
      status: { status: failed ? successful ? 'partial' : signal.aborted ? 'timeout' : 'error' : 'ok',
        dataStatus: found ? 'PRESENT' : successful && !failed ? 'EMPTY' : 'UNKNOWN', durationMs: Date.now() - started,
        attorneysSearched: fallback ? null : names.length, attorneysFound: successful ? found : null,
        reason: failed ? 'One or more targeted lookups were incomplete; raw responses retained' : null } };
  }
}

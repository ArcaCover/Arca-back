import { unknownAttorney, Attorney, type AttorneyMatch, type DirectoryQuery, type DirectorySource, type SourceResult,
  type SourceStatus } from '@arca/contracts';
import { z } from 'zod';
import { ApifyClientError, type ApifyRunResult } from './apify-client.js';
import { normalizeName, stableSample, matchAttorney } from './matching.js';
import { validDate } from '@arca/scoring';

export const BAR_ACTOR = 'scrapers_lat/florida-bar-lawyers-scraper';
export const AVVO_ACTOR = 'scrapers_lat/avvo-lawyers-scraper';
// Actor-defined maxima, not application budgets. The Apify client paginates every completed dataset.
export const BAR_TECHNICAL_MAX_LAWYERS = 1_000_000;
export const AVVO_TECHNICAL_MAX_LAWYERS = 100_000;
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
  return Attorney.parse({ ...unknownAttorney(name), city: text(row.physicalCity) ?? text(row.mailCity), county: text(row.county),
    firmName: text(row.firm), barNumber: text(row.barNumber), barStatus: barStatus(row.status),
    admissionDate: admission(row.admittedDate), hasDisciplinaryHistory: positiveHistory ? true : null,
    disciplinaryActions: actions, activeInvestigation: pending && /^no active regulatory investigation\b/i.test(pending) ? false :
      pending && /^active regulatory investigation\b/i.test(pending) ? true : null,
    practiceAreas: strings(row.practiceAreas), phone: text(row.officePhone), addressStreet: text(row.mailAddress),
    profileUrl: text(row.profileUrl) });
}
export function parseAvvo(raw: unknown): Attorney | null {
  const row = record.parse(raw), name = text(row.name);
  if (row.error || !name) return null;
  return Attorney.parse({ ...unknownAttorney(name), city: text(row.city), firmName: text(row.firmName),
    hasDisciplinaryHistory: boolean(row.disciplined),
    avvoRating: number(row.avvoRating, 1, 10), practiceAreas: strings(row.practiceAreas),
    avvoRatingLevel: text(row.avvoRatingLevel),
    reviewCount: Number.isInteger(row.reviewsCount) ? number(row.reviewsCount) : null,
    averageReviewRating: number(row.reviewsRating, 0, 5),
    awardsCount: Number.isInteger(row.awardsCount) ? number(row.awardsCount) : null,
    topAward: text(row.topAward), phone: text(row.phone), addressStreet: text(row.addressStreet),
    yearsLicensed: Number.isInteger(row.yearsLicensed) ? number(row.yearsLicensed) : null,
    licensedSince: text(row.licensedSince), profileUrl: text(row.profileUrl) });
}
function firmKey(value: string) { return value.toLowerCase().replace(/\b(p\.?\s*a\.?|llp|pllc|llc|inc)\b/g, '').replace(/[^a-z0-9]/g, ''); }
const providerError = (item: unknown) => {
  const row = item !== null && typeof item === 'object' ? item as Record<string, unknown> : null;
  return typeof row?.error === 'string' ? row.error.trim() : null;
};
const isNoMatch = (item: unknown) => /^no lawyers? matched\b|^no results?\b/i.test(providerError(item) ?? '');
export type DirectoryInput = { target: string; actor: string; input: Record<string, unknown>; fallback: boolean };
export function buildDirectoryInputs(source: 'bar' | 'avvo', query: DirectoryQuery): DirectoryInput[] {
  const names = stableSample(query.names);
  const fallback = names.length === 0;
  const targets = fallback ? (query.firmName ? [query.firmName] : []) : names;
  return targets.map(target => {
    const parts = normalizeName(target).split(' ');
    // The Bar actor matches on the whole first name: an initial alone returns "No lawyers matched".
    const title = (word: string) => word.replace(/(^|[-'])([a-z])/g, (_match, lead: string, letter: string) => `${lead}${letter.toUpperCase()}`);
    const input = source === 'bar' ? {
      lastNames: fallback ? [] : [title(parts.at(-1)!)], firstName: fallback ? '' : title(parts[0]!),
      ...(fallback ? { firm: target } : {}), maxLawyers: BAR_TECHNICAL_MAX_LAWYERS, withDetails: true,
      withLeadScore: false, withProfileSummary: false, eligibleOnly: false, includeDeceased: true,
    } : { searchQueries: [target], ...(query.city ? { cities: [`${query.city}, FL`] } : {}),
      withDetails: true, maxLawyers: AVVO_TECHNICAL_MAX_LAWYERS };
    return { target, actor: source === 'bar' ? BAR_ACTOR : AVVO_ACTOR, input, fallback };
  });
}
type DirectoryClient = { run(actor: string, input: Record<string, unknown>, signal: AbortSignal): Promise<unknown[] | ApifyRunResult> };
export class ApifyDirectorySource implements DirectorySource {
  constructor(private readonly source: 'bar' | 'avvo', private readonly client: DirectoryClient) {}
  async run(query: DirectoryQuery, signal: AbortSignal): Promise<SourceResult<AttorneyMatch[]>> {
    const started = Date.now();
    const planned = buildDirectoryInputs(this.source, query);
    const names = stableSample(query.names);
    const fallback = names.length === 0;
    const targets = planned.map(item => item.target);
    if (!targets.length) return { data: null, rawContent: null, status: { status: 'skipped', dataStatus: 'UNKNOWN',
      durationMs: 0, code: 'INSUFFICIENT_IDENTITY', reason: 'No verified firm or attorney identity available',
      attorneysSearched: 0, attorneysFound: 0, candidatesReceived: 0, recordsValid: 0, providerRuns: [], costUsd: 0 } };
    const rawResults: { target: string; items: unknown[] | null; error: string | null }[] = [];
    const matches: AttorneyMatch[] = [];
    const providerRuns: NonNullable<SourceStatus['providerRuns']> = [];
    let failed = 0, successfulQueries = 0, candidatesReceived = 0, recordsValid = 0;
    let cursor = 0;
    const worker = async () => {
      while (cursor < targets.length) {
        const target = targets[cursor++]!;
        if (signal.aborted) { failed++; continue; }
        try {
          const plan = planned.find(item => item.target === target)!;
          const output = await this.client.run(plan.actor, plan.input, signal);
          const items = Array.isArray(output) ? output : output.items;
          rawResults.push({ target, items, error: null });
          const parse = this.source === 'bar' ? parseBar : parseAvvo;
          const noMatchRecords = items.filter(isNoMatch);
          const errorRecords = items.filter(item => providerError(item) && !isNoMatch(item));
          const candidateRecords = items.filter(item => !providerError(item));
          candidatesReceived += candidateRecords.length;
          const candidates = candidateRecords.map(item => parse(item));
          if (errorRecords.length || candidates.some(person => person === null)) failed++;
          const valid = candidates.filter((person): person is Attorney => person !== null);
          recordsValid += valid.length;
          if (items.length === 0 || noMatchRecords.length === items.length || valid.length > 0) successfulQueries++;
          let accepted = 0;
          if (fallback) {
            // A firm fallback is one run whose complete, paginated dataset is the roster. Do not
            // discard any attorney from it or score the firm on an alphabetical sample.
            const people = valid.filter(person => person.firmName && firmKey(person.firmName) === firmKey(target))
              .sort((a, b) => normalizeName(a.name).localeCompare(normalizeName(b.name)));
            accepted = people.length;
            matches.push(...people.map(attorney => ({ searchedName: target, matchConfidence: 'firm_fallback' as const, attorney, ambiguous: false })));
          } else {
            const match = matchAttorney(target, valid);
            accepted = match.attorney ? 1 : 0;
            matches.push(this.source === 'avvo' && match.matchConfidence === 'exact'
              ? { ...match, matchConfidence: 'exact_name' as const } : match);
          }
          if (!Array.isArray(output)) providerRuns.push({ ...output.metadata, acceptedCount: accepted });
        } catch (error) {
          failed++;
          if (error instanceof ApifyClientError && error.metadata) providerRuns.push(error.metadata);
          rawResults.push({ target, items: null, error: signal.aborted ? 'timeout' : 'source_error' });
          if (!fallback) matches.push({ searchedName: target, attorney: null, ambiguous: false, matchConfidence: 'no_match' });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(5, targets.length) }, worker));
    const successful = successfulQueries > 0;
    matches.sort((a, b) => a.searchedName.localeCompare(b.searchedName) || (a.attorney?.name ?? '').localeCompare(b.attorney?.name ?? ''));
    const found = matches.filter(match => match.attorney !== null).length;
    const costUsd = providerRuns.reduce((total, run) => total + (run.costUsd ?? 0), 0);
    const code = signal.aborted ? 'DEADLINE_REACHED' : !successful ? 'PROVIDER_ERROR' : failed ? 'PROVIDER_CONTRACT_ERROR' : found ? undefined : 'NO_MATCH';
    return { data: successful ? matches : null, rawContent: JSON.stringify({
      queries: rawResults.sort((a, b) => a.target.localeCompare(b.target)), providerRuns }),
      status: { status: failed ? successful ? 'partial' : signal.aborted ? 'timeout' : 'error' : 'ok',
        dataStatus: found ? 'PRESENT' : successful && !failed ? 'EMPTY' : 'UNKNOWN', durationMs: Date.now() - started,
        attorneysSearched: fallback ? null : names.length, attorneysFound: successful ? found : null,
        candidatesReceived, recordsValid, providerRuns, costUsd, ...(code ? { code } : {}),
        reason: failed ? 'One or more targeted lookups were incomplete; raw responses retained' :
          found ? null : 'Provider completed successfully with no accepted identity match' } };
  }
}

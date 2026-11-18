import { unknownAttorney, Attorney, type AttorneyMatch, type DirectoryQuery, type DirectorySource, type SourceResult,
  type SourceStatus } from '@arca/contracts';
import { z } from 'zod';
import { ApifyClientError, type ApifyRunKind, type ApifyRunMetadata, type ApifyRunResult } from './apify-client.js';
import { normalizeName, stableSample, matchAttorney } from './matching.js';
import { compareText, validDate } from '@arca/scoring';

export const BAR_ACTOR = 'scrapers_lat/florida-bar-lawyers-scraper';
export const AVVO_ACTOR = 'scrapers_lat/avvo-lawyers-scraper';
// The Bar actor reads the Florida Bar's registry, so a Bar match certifies a Florida licence.
export const BAR_JURISDICTION = 'FL';
// Actor-defined maxima, not application budgets. The Apify client paginates every completed dataset.
export const BAR_TECHNICAL_MAX_LAWYERS = 1_000_000;
export const AVVO_TECHNICAL_MAX_LAWYERS = 100_000;
export const BAR_TARGETED_MAX_LAWYERS = 25;
export const AVVO_TARGETED_MAX_LAWYERS = 10;
// City searches of one firm in the Florida Bar, one run each (DN-06 §10). Each is a firm search and reserves as one.
export const BAR_MAX_OFFICE_SEARCHES = 3;
// Lawyers one office-city search of a large firm reads (DN-12 §13.9). Uncapped city searches of hklaw.com were cut by
// the run's charge limit at USD 1 (24-50 lawyers each): a cut dataset is not reused, so every scan paid again and read
// a different roster. A run that stops at its own maxLawyers ends SUCCEEDED, stays in the query cache and reads the
// same lawyers next time; at ~USD 0.04 a lawyer with details, 20 stay under the USD 1 a firm run reserves.
export const BAR_OFFICE_SAMPLE_MAX_LAWYERS = 20;
// The same for an Avvo firm search scoped by an office city (no verified city): ~USD 0.0385 a profile.
export const AVVO_OFFICE_SAMPLE_MAX_LAWYERS = 10;
// Lookups one source keeps in flight. Bar and Avvo run side by side, so two sources fill the
// default MAX_APIFY_CONCURRENCY of 16; the Apify client queues anything beyond its limit.
export const DIRECTORY_LOOKUPS_IN_FLIGHT = 8;
// The reason of a directory stopped by the usage limit. The debug sources fabricate the same status, so it is shared.
export const APIFY_QUOTA_REASON = 'Apify usage limit reached for the current billing cycle; lookups after it were not started';
// The reason of a directory whose lookups our own spend ceiling refused (DN-12 §5.1). A passing cause, like the usage
// limit: the code stays PROVIDER_ERROR, so the scan cache repairs the result and nothing is concluded about the firm.
export const APIFY_SPEND_CEILING_REASON = 'Apify spend ceiling reached; lookups it had no room for were not started';
const record = z.record(z.unknown());
const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null;
const availableText = (value: unknown): string | null => {
  const parsed = text(value);
  return parsed && !/^(?:not available|unknown|n\/?a|none)$/i.test(parsed) ? parsed : null;
};
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
    practiceAreas: strings(row.practiceAreas), phone: availableText(row.officePhone),
    addressStreet: availableText(row.mailStreet) ?? availableText(row.mailAddress),
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
    topAward: text(row.topAward), phone: availableText(row.phone), addressStreet: availableText(row.addressStreet),
    yearsLicensed: Number.isInteger(row.yearsLicensed) ? number(row.yearsLicensed) : null,
    licensedSince: text(row.licensedSince), profileUrl: text(row.profileUrl) });
}
function firmKey(value: string) { return value.toLowerCase().replace(/\b(p\.?\s*a\.?|llp|pllc|llc|inc)\b/g, '').replace(/[^a-z0-9]/g, ''); }
const providerError = (item: unknown) => {
  const row = item !== null && typeof item === 'object' ? item as Record<string, unknown> : null;
  return typeof row?.error === 'string' ? row.error.trim() : null;
};
const isNoMatch = (item: unknown) => /^no lawyers? matched\b|^no results?\b/i.test(providerError(item) ?? '');
/**
 * One planned lookup. `fallback` marks a firm search, whose whole dataset is the firm's roster in its scope; `firm` is the
 * firm it searched, which a returned lawyer must belong to. `kind` is what the run reserves against the spend ceiling.
 */
export type DirectoryInput = { target: string; actor: string; input: Record<string, unknown>; fallback: boolean;
  resultLimit: number; kind: ApifyRunKind; firm: string | null };
function surname(name: string) {
  const parts = normalizeName(name).split(' ');
  let start = parts.length - 1;
  while (start > 1 && ['da', 'de', 'del', 'den', 'der', 'di', 'dos', 'la', 'las', 'los', 'van', 'von']
    .includes(parts[start - 1]!)) start--;
  return parts.slice(start).join(' ');
}
/** The Florida office cities a Bar firm search covers, in the order given, once each and at most BAR_MAX_OFFICE_SEARCHES. */
function officeSearchCities(query: DirectoryQuery): string[] {
  const seen = new Set<string>();
  return (query.officeCities ?? []).map(city => city.trim()).filter(city => {
    const key = city.toLocaleLowerCase();
    if (!city || seen.has(key)) return false;
    seen.add(key); return true;
  });
}
export function buildDirectoryInputs(source: 'bar' | 'avvo', query: DirectoryQuery, targetedMaxLawyers =
  source === 'bar' ? BAR_TARGETED_MAX_LAWYERS : AVVO_TARGETED_MAX_LAWYERS,
  officeSampleMaxLawyers = source === 'bar' ? BAR_OFFICE_SAMPLE_MAX_LAWYERS : AVVO_OFFICE_SAMPLE_MAX_LAWYERS): DirectoryInput[] {
  // DN-06 §10: a large firm, or one whose only names came from news pages, is looked up in the Bar by firm in each
  // of its Florida office cities. Each city search reads a fixed sample of the firm's lawyers there (DN-12 §13.9):
  // a large firm's whole Florida roster costs more than a scan may spend, and a search cut by its charge limit is
  // neither complete nor reusable. The search of a firm with no office city keeps the technical maximum (DN-06).
  const offices = source === 'bar' && query.firmName ? officeSearchCities(query) : [];
  if (offices.length) {
    const firm = query.firmName!;
    return offices.slice(0, BAR_MAX_OFFICE_SEARCHES).map(city => ({ target: `${firm} (${city})`, actor: BAR_ACTOR, fallback: true,
      kind: 'firm' as const, firm, resultLimit: officeSampleMaxLawyers,
      input: { lastNames: [], firstName: '', firm, locationType: 'city', locations: [city], maxLawyers: officeSampleMaxLawyers,
        withDetails: true, withLeadScore: false, withProfileSummary: false, eligibleOnly: false, includeDeceased: true } }));
  }
  const names = stableSample(query.names);
  const fallback = names.length === 0;
  // DN-06: without a verified city an Avvo firm search expands to the whole country with a
  // technical maximum of 100,000 lawyers. Nothing caps that spend any more (D8), so it is not run.
  // Named lookups stay: the targeted maximum bounds each one whether or not a city is known.
  // A Florida office city the website lists scopes it when no city was verified.
  const officeCity = query.city ? null : officeSearchCities(query)[0] ?? null;
  const city = query.city ?? officeCity;
  const location = city && query.state ? `${city}, ${query.state}` : null;
  const unscopedFirmSearch = fallback && source === 'avvo' && location === null;
  const targets = unscopedFirmSearch ? [] : fallback ? (query.firmName ? [query.firmName] : []) : names;
  return targets.map(target => {
    const parts = normalizeName(target).split(' ');
    // The Bar actor matches on the whole first name: an initial alone returns "No lawyers matched".
    const title = (word: string) => word.replace(/(^|[-'])([a-z])/g, (_match, lead: string, letter: string) => `${lead}${letter.toUpperCase()}`);
    // An Avvo firm search scoped by an office city is a large firm's: it reads a sample, as the Bar city searches do.
    const resultLimit = fallback ? (source === 'bar' ? BAR_TECHNICAL_MAX_LAWYERS
      : officeCity ? officeSampleMaxLawyers : AVVO_TECHNICAL_MAX_LAWYERS) : targetedMaxLawyers;
    const input = source === 'bar' ? {
      lastNames: fallback ? [] : [surname(target).split(' ').map(title).join(' ')], firstName: fallback ? '' : title(parts[0]!),
      ...(fallback ? { firm: target } : {}), maxLawyers: resultLimit, withDetails: true,
      withLeadScore: false, withProfileSummary: false, eligibleOnly: false, includeDeceased: true,
    } : { searchQueries: [target], ...(location ? { cities: [location] } : {}),
      withDetails: true, maxLawyers: resultLimit };
    return { target, actor: source === 'bar' ? BAR_ACTOR : AVVO_ACTOR, input, fallback, resultLimit,
      kind: fallback ? 'firm' as const : 'targeted' as const, firm: fallback ? target : null };
  });
}
// What a directory returns when its query yields no lookup target: Apify is never called. The debug sources reuse it
// so an injected quota error cannot claim a lookup that the real source would not have made.
export function nothingToLookUp(query: DirectoryQuery): SourceResult<AttorneyMatch[]> {
  const fallback = stableSample(query.names).length === 0;
  return { data: null, rawContent: null, status: { status: 'skipped', dataStatus: 'UNKNOWN',
    durationMs: 0, code: 'INSUFFICIENT_IDENTITY', reason: fallback && query.firmName
      ? 'A firm-wide search needs a verified city; a nationwide search is not run'
      : 'No verified firm or attorney identity available',
    attorneysSearched: 0, attorneysFound: 0, candidatesReceived: 0, recordsValid: 0, providerRuns: [], costUsd: 0 } };
}
type DirectoryClient = { run(actor: string, input: Record<string, unknown>, signal: AbortSignal,
  context?: { scanId?: string; kind?: ApifyRunKind }): Promise<unknown[] | ApifyRunResult>;
  recordAccepted?(metadata: ApifyRunMetadata, acceptedCount: number): Promise<void> };
export class ApifyDirectorySource implements DirectorySource {
  readonly jurisdiction?: string;
  constructor(private readonly source: 'bar' | 'avvo', private readonly client: DirectoryClient,
    private readonly options: { targetedMaxLawyers?: number; officeSampleMaxLawyers?: number } = {}) {
    if (source === 'bar') this.jurisdiction = BAR_JURISDICTION;
  }
  async run(query: DirectoryQuery, signal: AbortSignal): Promise<SourceResult<AttorneyMatch[]>> {
    const started = Date.now();
    const planned = buildDirectoryInputs(this.source, query, this.options.targetedMaxLawyers, this.options.officeSampleMaxLawyers);
    const names = stableSample(query.names);
    if (!planned.length) return nothingToLookUp(query);
    // Firm searches, whole-registry or one per Florida office city, or named lookups: a plan is never both.
    const fallback = planned.every(item => item.fallback);
    const targets = planned.map(item => item.target);
    const offices = this.source === 'bar' && fallback ? officeSearchCities(query) : [];
    const rawResults: { target: string; items: unknown[] | null; error: string | null }[] = [];
    const matches: AttorneyMatch[] = [];
    const providerRuns: NonNullable<SourceStatus['providerRuns']> = [];
    let failed = 0, successfulQueries = 0, candidatesReceived = 0, recordsValid = 0, truncations = 0;
    // Lookups that threw (the provider refused or vanished), as opposed to answers in the wrong shape.
    let providerFailures = 0, quotaReached = false, ceilingRefusals = 0;
    let cursor = 0;
    const worker = async () => {
      while (cursor < targets.length) {
        const target = targets[cursor++]!;
        if (signal.aborted) { failed++; continue; }
        if (quotaReached) {
          // Past the usage limit every start is refused; stop the queue instead of failing lookup by lookup.
          failed++; providerFailures++;
          rawResults.push({ target, items: null, error: 'provider_quota_exceeded' });
          if (!fallback) matches.push({ searchedName: target, attorney: null, ambiguous: false, matchConfidence: 'no_match' });
          continue;
        }
        try {
          const plan = planned.find(item => item.target === target)!;
          const output = await this.client.run(plan.actor, plan.input, signal, { scanId: query.scanId, kind: plan.kind });
          const items = Array.isArray(output) ? output : output.items;
          const metadata = Array.isArray(output) ? null : output.metadata;
          if (metadata) {
            const { ledgerId: _ledgerId, ...publicMetadata } = metadata;
            providerRuns.push({ ...publicMetadata, acceptedCount: 0 });
          }
          rawResults.push({ target, items, error: metadata?.partial ? 'partial_provider_run' : null });
          const parse = this.source === 'bar' ? parseBar : parseAvvo;
          const noMatchRecords = items.filter(isNoMatch);
          const errorRecords = items.filter(item => providerError(item) && !isNoMatch(item));
          const candidateRecords = items.filter(item => !providerError(item));
          candidatesReceived += candidateRecords.length;
          const candidates = candidateRecords.map(item => { try { return parse(item); } catch { return null; } });
          if (errorRecords.length || candidates.some(person => person === null) || metadata?.partial) failed++;
          const valid = candidates.filter((person): person is Attorney => person !== null);
          recordsValid += valid.length;
          if (!plan.fallback && items.length >= plan.resultLimit) { failed++; truncations++; }
          if (items.length === 0 || noMatchRecords.length === items.length || valid.length > 0) successfulQueries++;
          let accepted = 0;
          if (fallback) {
            // A firm fallback is one run whose complete, paginated dataset is the roster. Do not
            // discard any attorney from it or score the firm on an alphabetical sample.
            const firmKeys = [plan.firm ?? target, ...(query.aliases ?? [])].map(firmKey);
            // City searches of one firm do not overlap, but a lawyer listed in two of them is still one lawyer.
            const known = (person: Attorney) => matches.some(match => match.attorney && (person.barNumber
              ? match.attorney.barNumber === person.barNumber : normalizeName(match.attorney.name) === normalizeName(person.name)));
            const people = valid.filter(person => person.firmName && firmKeys.includes(firmKey(person.firmName)) && !known(person))
              .sort((a, b) => normalizeName(a.name).localeCompare(normalizeName(b.name)));
            accepted = people.length;
            matches.push(...people.map(attorney => ({ searchedName: target, matchConfidence: 'firm_fallback' as const, attorney, ambiguous: false })));
          } else {
            const match = matchAttorney(target, valid, false, query);
            accepted = match.attorney ? 1 : 0;
            matches.push(this.source === 'avvo' && match.matchConfidence === 'exact'
              ? { ...match, matchConfidence: 'exact_name' as const } : match);
          }
          if (metadata) {
            providerRuns[providerRuns.length - 1]!.acceptedCount = accepted;
            try { await this.client.recordAccepted?.(metadata, accepted); }
            catch { failed++; rawResults[rawResults.length - 1]!.error = 'ledger_update_failed'; }
          }
        } catch (error) {
          failed++; providerFailures++;
          const quota = error instanceof ApifyClientError && error.code === 'PROVIDER_QUOTA_EXCEEDED';
          if (quota) quotaReached = true;
          // Unlike the usage limit, the ceiling does not stop the queue: a lookup already in the query cache
          // costs nothing and is still answered, and one the ceiling has no room for is refused before any request.
          const ceiling = error instanceof ApifyClientError && error.code === 'SPEND_CEILING_REACHED';
          if (ceiling) ceilingRefusals++;
          if (error instanceof ApifyClientError && error.metadata) {
            const { ledgerId: _ledgerId, ...publicMetadata } = error.metadata; providerRuns.push(publicMetadata);
          }
          rawResults.push({ target, items: null, error: signal.aborted ? 'timeout' : quota ? 'provider_quota_exceeded'
            : ceiling ? 'spend_ceiling_reached' : 'source_error' });
          if (!fallback) matches.push({ searchedName: target, attorney: null, ambiguous: false, matchConfidence: 'no_match' });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(DIRECTORY_LOOKUPS_IN_FLIGHT, targets.length) }, worker));
    const successful = successfulQueries > 0;
    // Lookups finish in any order. The fingerprint is the same for the same query on every scan, so the
    // runs, and the raw evidence that lists them, read the same on a second scan.
    providerRuns.sort((a, b) => compareText(a.queryFingerprint, b.queryFingerprint) || compareText(a.runId, b.runId));
    matches.sort((a, b) => a.searchedName.localeCompare(b.searchedName) || (a.attorney?.name ?? '').localeCompare(b.attorney?.name ?? ''));
    const found = matches.filter(match => match.attorney !== null).length;
    const chargeableRuns = providerRuns.filter(run => run.chargedToScan !== false);
    const accountingComplete = chargeableRuns.every(run => run.accountingComplete !== false && run.costUsd !== null);
    const costUsd = accountingComplete ? chargeableRuns.reduce((total, run) => total + run.costUsd!, 0) : null;
    const costPerAcceptedAttorneyUsd = costUsd !== null && found > 0 ? costUsd / found : null;
    // TRUNCATED means a full result page was the only problem, so scoring may clear it once the
    // accepted attorneys are independently confirmed. Any other failure keeps its own code.
    const code = signal.aborted ? 'DEADLINE_REACHED' : quotaReached || ceilingRefusals ? 'PROVIDER_ERROR' :
      truncations > 0 && failed === truncations ? 'TRUNCATED' :
      !successful ? 'PROVIDER_ERROR' : failed > providerFailures ? 'PROVIDER_CONTRACT_ERROR' : failed ? 'PROVIDER_ERROR'
        : found ? undefined : 'NO_MATCH';
    // Which offices the roster covers: a firm with more Florida offices than the cap is not searched in all of them.
    const searched = offices.slice(0, BAR_MAX_OFFICE_SEARCHES);
    const sample = planned[0]?.resultLimit ?? BAR_OFFICE_SAMPLE_MAX_LAWYERS;
    const scope = !offices.length ? null : `${offices.length > searched.length
      ? `Firm searched in ${searched.length} of its ${offices.length} Florida office cities: ${searched.join(', ')}`
      : `Firm searched in its Florida office cities: ${searched.join(', ')}`}; up to ${sample} lawyers per city`;
    const noMatch = 'Provider completed successfully with no accepted identity match';
    return { data: successful ? matches : null, rawContent: JSON.stringify({
      queries: rawResults.sort((a, b) => a.target.localeCompare(b.target)), providerRuns }),
      status: { status: failed ? successful ? 'partial' : signal.aborted ? 'timeout' : 'error' : 'ok',
        dataStatus: found ? 'PRESENT' : successful && !failed ? 'EMPTY' : 'UNKNOWN', durationMs: Date.now() - started,
        attorneysSearched: fallback ? null : names.length, attorneysFound: successful ? found : null,
        candidatesReceived, recordsValid, providerRuns, costUsd, accountingComplete,
        cachedRuns: providerRuns.filter(run => run.cached).length, resumedRuns: providerRuns.filter(run => run.resumed).length,
        costPerAcceptedAttorneyUsd, ...(code ? { code } : {}),
        reason: quotaReached ? APIFY_QUOTA_REASON : ceilingRefusals ? APIFY_SPEND_CEILING_REASON :
          failed ? 'One or more targeted lookups were incomplete; raw responses retained' :
          found ? scope : scope ? `${noMatch}. ${scope}` : noMatch } };
  }
}

import type { Attorney, AttorneyMatch, DirectoryQuery, FirmIdentity } from '@arca/contracts';

/**
 * A name without the nickname a directory adds to it: `Mark Stephen Barnett "Marcus"` (straight or curly quotes),
 * `William 'Bill' Jones`, `Robert (Bob) Smith`. A single-quoted word counts only when the quotes stand on their own, so
 * the apostrophe of O'Neil or D'Angelo stays. A name that is nothing but quotes is kept as it is.
 */
function withoutNicknames(name: string): string {
  const stripped = name.replace(/"[^"]*"|\u201c[^\u201d]*\u201d|\u201e[^\u201c\u201d]*[\u201c\u201d]|\([^)]*\)/g, ' ')
    .replace(/(^|\s)['\u2018][^'\u2018\u2019\s][^'\u2018\u2019]*['\u2019](?=[\s,]|$)/g, '$1 ');
  return /[a-z]/i.test(stripped.normalize('NFKD')) ? stripped : name;
}

export function normalizeName(name: string): string {
  const normalized = withoutNicknames(name).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/\b(?:esq\.?|j\.?\s*d\.?|jr\.?|iii|ph\.?\s*d\.?)\b/g, '')
    .replace(/[^a-z\s'-]/g, ' ').replace(/\s+/g, ' ').trim();
  const parts = normalized.split(' ');
  const half = parts.length / 2;
  return Number.isInteger(half) && parts.slice(0, half).join(' ') === parts.slice(half).join(' ')
    ? parts.slice(0, half).join(' ') : normalized;
}

export function stableSample(names: string[]): string[] {
  const sorted = [...names].sort((a, b) => normalizeName(a).localeCompare(normalizeName(b)) || a.localeCompare(b));
  const unique = new Map<string, string>();
  for (const name of sorted) { const key = normalizeName(name); if (key && !unique.has(key)) unique.set(key, name); }
  // Keep a stable order for repeatable directory calls, but never sample the roster.
  return [...unique.values()];
}

function sameInitialAndLast(a: string, b: string) {
  const left = normalizeName(a).split(' '), right = normalizeName(b).split(' ');
  return left[0]?.[0] === right[0]?.[0] && left.at(-1) === right.at(-1);
}

function sameFirstAndLast(left: string, right: string) {
  const a = normalizeName(left).split(' '), b = normalizeName(right).split(' ');
  return a[0] === b[0] && a.at(-1) === b.at(-1);
}

function compatibleExpandedName(candidate: string, searched: string) {
  const full = normalizeName(candidate).split(' '), query = normalizeName(searched).split(' ');
  if (full.length < 2 || query.length < 2 || full[0] !== query[0]) return false;
  if (full.at(-1) === query.at(-1)) {
    const middle = full.slice(1, -1), expected = query.slice(1, -1);
    let cursor = 0;
    return expected.every(part => {
      while (cursor < middle.length && !middle[cursor]!.startsWith(part)) cursor++;
      return cursor++ < middle.length;
    });
  }
  // Hispanic compound surnames are commonly shortened on a firm website. They remain candidates,
  // but require independent firm/contact evidence before acceptance.
  return full.slice(1).some(part => part === query.at(-1) || part.startsWith(`${query.at(-1)}-`));
}

type IdentityContext = Pick<DirectoryQuery, 'firmName' | 'aliases' | 'city' | 'county' | 'addressStreet' | 'phone'> |
  Pick<FirmIdentity, 'firmName' | 'aliases' | 'city' | 'county' | 'addressStreet' | 'phone'>;
const clean = (value: string | null | undefined) => value?.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z0-9]/g, '') || null;
// A firm's name without what the same firm is written with or without: "The", "&" or "and", "Law Firm", P.A., P.L.,
// P.C., LLP and the like. "Fox & Lemon, LLP" and "Fox and Lemon Law Firm" are one firm.
const firmCore = (value: string | null | undefined) => value?.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/&/g, ' ')
  .replace(/\b(?:the|and|law|legal|firm|office|offices|attorney|attorneys|lawyer|lawyers|p\.?\s*[alc]\.?|llp|pllc|llc|inc|mr|ms)\b/g, ' ')
  .replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, '') || null;
const sameFirm = (left: string | null | undefined, right: string | null | undefined) => {
  const a = clean(left), b = clean(right), coreA = firmCore(left), coreB = firmCore(right);
  return a !== null && b !== null && (a === b || (coreA !== null && coreA === coreB));
};
function contextFit(candidate: Attorney, context?: IdentityContext) {
  if (!context) return { support: 0, contradictions: 0 };
  const firms = [context.firmName, ...(context.aliases ?? [])].filter((value): value is string => Boolean(value));
  const candidateFirm = sameFirm(candidate.firmName, candidate.name) ? null : candidate.firmName;
  const pairs = [
    { matches: candidateFirm ? firms.map(firm => sameFirm(candidateFirm, firm)) : [], observed: Boolean(candidateFirm), weight: 2, contradicts: true },
    { matches: [clean(candidate.phone), clean(context.phone)].every(Boolean)
      ? [clean(candidate.phone) === clean(context.phone)] : [], observed: Boolean(clean(candidate.phone)), weight: 2, contradicts: true },
    { matches: [clean(candidate.addressStreet), clean(context.addressStreet)].every(Boolean)
      ? [clean(candidate.addressStreet) === clean(context.addressStreet)] : [], observed: Boolean(clean(candidate.addressStreet)), weight: 2, contradicts: false },
    { matches: [clean(candidate.county), clean(context.county)].every(Boolean)
      ? [clean(candidate.county) === clean(context.county)] : [], observed: Boolean(clean(candidate.county)), weight: 1, contradicts: false },
    { matches: [clean(candidate.city), clean(context.city)].every(Boolean)
      ? [clean(candidate.city) === clean(context.city)] : [], observed: Boolean(clean(candidate.city)), weight: 1, contradicts: false },
  ];
  return pairs.reduce((result, pair) => {
    if (!pair.observed || !pair.matches.length) return result;
    if (pair.matches.some(Boolean)) result.support += pair.weight;
    else if (pair.contradicts) result.contradictions += pair.weight;
    return result;
  }, { support: 0, contradictions: 0 });
}

export function matchAttorney(name: string, candidates: Attorney[], firmFallback = false, context?: IdentityContext): AttorneyMatch {
  const normalizeFirm = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
  let matches = firmFallback ? candidates.filter(a => a.firmName && normalizeFirm(a.firmName) === normalizeFirm(name)) :
    candidates.filter(a => normalizeName(a.name) === normalizeName(name));
  let confidence: AttorneyMatch['matchConfidence'] = firmFallback ? 'firm_fallback' : 'exact';
  if (!matches.length && !firmFallback) {
    matches = candidates.filter(a => compatibleExpandedName(a.name, name) || sameInitialAndLast(a.name, name));
    confidence = 'fuzzy';
  }
  const nameCandidates = [...matches];
  if (!firmFallback && context && matches.length) {
    const fitted = matches.map(attorney => ({ attorney, ...contextFit(attorney, context) }));
    const firstToken = normalizeName(name).split(' ')[0] ?? '';
    const minimumSupport = confidence === 'fuzzy' && firstToken.length > 1 ? 2 : 1;
    const supported = fitted.filter(item => item.support >= minimumSupport && item.support >= item.contradictions);
    if (supported.length) matches = supported.map(item => item.attorney);
    else if (confidence === 'fuzzy' || fitted.every(item => item.contradictions > 0)) matches = [];
  }
  const identity = (a: Attorney) => a.barNumber ?? a.profileUrl ?? `${normalizeName(a.name)}:${a.city}:${a.firmName}`;
  matches = [...new Map(matches.map(a => [identity(a), a])).values()];
  if (matches.length !== 1) return { searchedName: name, attorney: null, matchConfidence: 'no_match',
    ambiguous: matches.length > 1 || nameCandidates.length > 1 ||
      (confidence === 'exact' && nameCandidates.length > 0 && matches.length === 0),
    ...(nameCandidates.length ? { candidates: [...new Map(nameCandidates.map(a => [identity(a), a])).values()] } : {}) };
  return { searchedName: name, attorney: matches[0]!, matchConfidence: confidence, ambiguous: false };
}

const normalizedText = (value: string | null) => value?.toLowerCase().replace(/[^a-z0-9]/g, '') || null;
const sameKnown = (left: string | null, right: string | null) => {
  const a = normalizedText(left), b = normalizedText(right);
  return a !== null && b !== null && a === b;
};
function candidatesForSupport(match: AttorneyMatch) {
  return (match.candidates ?? (match.attorney ? [match.attorney] : []))
    .filter(candidate => sameFirstAndLast(candidate.name, match.searchedName) ||
      compatibleExpandedName(candidate.name, match.searchedName));
}

function sameAdmissionYear(left: Attorney, right: Attorney) {
  const barYear = left.admissionDate?.slice(0, 4) ?? left.licensedSince;
  const directoryYear = right.admissionDate?.slice(0, 4) ?? right.licensedSince;
  return barYear !== null && directoryYear !== null && barYear === directoryYear;
}
function crossDirectoryIdentity(left: Attorney, right: Attorney) {
  if (normalizeName(left.name) !== normalizeName(right.name) && !sameFirstAndLast(left.name, right.name)) return false;
  return sameKnown(left.addressStreet, right.addressStreet) || sameKnown(left.phone, right.phone) ||
    sameAdmissionYear(left, right);
}

/**
 * True when an accepted directory match is pinned to the person by an identifier that a name
 * search cannot fake: the other directory agrees on address, phone or admission year, or the
 * firm's own phone or street matches. More candidates past a truncated result page cannot
 * displace such a match, which a name-only acceptance would not survive.
 */
export function independentlyConfirmed(match: AttorneyMatch, other: AttorneyMatch[] | null,
  identity: string | null | IdentityContext): boolean {
  if (!match.attorney) return false;
  const context = asContext(identity);
  const counterpart = other?.find(item => normalizeName(item.searchedName) === normalizeName(match.searchedName))?.attorney;
  return (counterpart ? crossDirectoryIdentity(match.attorney, counterpart) : false) ||
    sameKnown(match.attorney.phone, context.phone ?? null) || sameKnown(match.attorney.addressStreet, context.addressStreet ?? null);
}

const asContext = (value: string | null | IdentityContext): IdentityContext => typeof value === 'object' && value !== null
  ? value : { firmName: value, aliases: [], city: null, county: null, addressStreet: null, phone: null };

/**
 * What the scan knows that can tie a directory record to this firm beyond the person's name (DN-12 §15.5). Built from the
 * website data by `firmTies`; scoring never sees an email address, only the Bar profiles the pipeline found at the firm's
 * domain.
 * - `officeCities`: the cities the site lists offices in.
 * - `emailProfiles`: Bar profile URLs whose email is at the firm's own domain.
 * - `licensedElsewhere`: normalized names the site lists as licensed only outside the registry's state.
 */
export type FirmTies = { officeCities: ReadonlySet<string>; emailProfiles: ReadonlySet<string>; licensedElsewhere: ReadonlySet<string> };
export const NO_FIRM_TIES: FirmTies = { officeCities: new Set(), emailProfiles: new Set(), licensedElsewhere: new Set() };

const firmsOf = (context: IdentityContext) => [context.firmName, ...(context.aliases ?? [])];
/** Tied to the person at this firm: the record names the firm, its email is at the firm's domain, or it has the firm's phone or street. */
function strongTie(record: Attorney, context: IdentityContext, ties: FirmTies): boolean {
  return firmTie(record, context, ties) || sameKnown(record.phone, context.phone ?? null) ||
    sameKnown(record.addressStreet, context.addressStreet ?? null);
}
/** The record names this firm, or the Bar has its email at the firm's domain. */
const firmTie = (record: Attorney, context: IdentityContext, ties: FirmTies) =>
  firmsOf(context).some(firm => sameFirm(record.firmName, firm)) || (record.profileUrl !== null && ties.emailProfiles.has(record.profileUrl));
/** In the firm's verified city or county, or in a city the site lists an office in. */
const placed = (record: Attorney, context: IdentityContext, ties: FirmTies) => sameKnown(record.county, context.county ?? null) ||
  sameKnown(record.city, context.city ?? null) || [...ties.officeCities].some(city => sameKnown(record.city, city));
/**
 * Tied to this firm among the records a name fits: strongly, or by place when the place singles it out. A firm with
 * twenty offices has namesakes in several of them; then the city says nothing. `strongOnly` when the site contradicts.
 */
function tiedAmong(record: Attorney, among: Attorney[], context: IdentityContext, ties: FirmTies, strongOnly: boolean): boolean {
  if (strongTie(record, context, ties)) return true;
  return !strongOnly && placed(record, context, ties) && among.filter(other => placed(other, context, ties)).length === 1;
}

/**
 * Settles the Bar lookups that a name alone did not. Two directories agreeing on a name and an admission year place a
 * person, not a firm: when several Bar records fit the name, or the site lists the attorney only in other states, the
 * record accepted must be tied to this firm (`tiedAmong`), or the Avvo profile it agrees with must be at the firm. A site
 * that lists the attorney only elsewhere also takes back an exact match nothing ties to the firm. Without either, a
 * unique record is accepted as before.
 */
export function reconcileBarMatches(bar: AttorneyMatch[] | null, identity: string | null | IdentityContext,
  avvo: AttorneyMatch[] | null = null, ties: FirmTies = NO_FIRM_TIES): AttorneyMatch[] | null {
  if (bar === null) return null;
  const context = asContext(identity);
  return bar.map(match => {
    const elsewhere = ties.licensedElsewhere.has(normalizeName(match.searchedName));
    const avvoMatch = avvo?.find(item => normalizeName(item.searchedName) === normalizeName(match.searchedName));
    const counterpart = avvoMatch?.attorney ?? null;
    const atFirmOnAvvo = (record: Attorney) => counterpart !== null && crossDirectoryIdentity(record, counterpart) &&
      strongTie(counterpart, context, ties);
    if (match.attorney && ['exact', 'firm_fallback'].includes(match.matchConfidence)) {
      if (!elsewhere || match.matchConfidence === 'firm_fallback' || strongTie(match.attorney, context, ties) ||
        atFirmOnAvvo(match.attorney)) return match;
      return { searchedName: match.searchedName, attorney: null, matchConfidence: 'no_match', ambiguous: false,
        candidates: [match.attorney] };
    }
    const candidates = candidatesForSupport(match);
    const firmMatches = candidates.filter(candidate => firmTie(candidate, context, ties));
    if (firmMatches.length === 1) return { searchedName: match.searchedName, attorney: firmMatches[0]!,
      matchConfidence: 'cross_ref', ambiguous: false };
    const crossMatches = candidates.filter(candidate => (counterpart ? [counterpart] : [])
      .some(other => crossDirectoryIdentity(candidate, other)));
    const needsTie = elsewhere || candidates.length > 1;
    if (crossMatches.length === 1 && (!needsTie || tiedAmong(crossMatches[0]!, candidates, context, ties, elsewhere) ||
      atFirmOnAvvo(crossMatches[0]!))) {
      return { searchedName: match.searchedName, attorney: crossMatches[0]!, matchConfidence: 'cross_ref', ambiguous: false };
    }
    const countyMatches = candidates.filter(candidate => sameKnown(candidate.county, context.county ?? null) ||
      sameKnown(candidate.city, context.city ?? null));
    if (countyMatches.length === 1 && (!elsewhere || strongTie(countyMatches[0]!, context, ties))) {
      return { searchedName: match.searchedName, attorney: countyMatches[0]!, matchConfidence: 'county_match', ambiguous: false };
    }
    return { searchedName: match.searchedName, attorney: null, matchConfidence: 'no_match',
      ambiguous: candidates.length > 1 || firmMatches.length > 1 || crossMatches.length > 1 || countyMatches.length > 1,
      ...(candidates.length ? { candidates } : {}) };
  });
}

/**
 * Settles the Avvo lookups that a name alone did not. A profile at the firm (its name, street or phone) is confirmed. A
 * profile confirmed only because a Bar record agrees on name and year is, when several profiles fit the name or the site
 * lists the attorney only elsewhere, confirmed only if that Bar record is tied to this firm (`tiedAmong`).
 */
export function reconcileAvvoMatches(avvo: AttorneyMatch[] | null, bar: AttorneyMatch[] | null,
  identity: string | null | IdentityContext, ties: FirmTies = NO_FIRM_TIES): AttorneyMatch[] | null {
  if (avvo === null) return null;
  const context = asContext(identity);
  return avvo.map(match => {
    if (match.attorney && ['exact', 'exact_name'].includes(match.matchConfidence)) {
      return { ...match, matchConfidence: 'exact_name' as const, candidates: undefined };
    }
    const elsewhere = ties.licensedElsewhere.has(normalizeName(match.searchedName));
    const candidates = candidatesForSupport(match);
    const barMatch = bar?.find(item => normalizeName(item.searchedName) === normalizeName(match.searchedName));
    const barCandidates = barMatch ? candidatesForSupport(barMatch) : [];
    const needsTie = elsewhere || candidates.length > 1;
    const confirmed = candidates.filter(candidate => strongTie(candidate, context, ties) ||
      barCandidates.some(barCandidate => crossDirectoryIdentity(candidate, barCandidate) &&
        (!needsTie || tiedAmong(barCandidate, barCandidates, context, ties, elsewhere))));
    if (confirmed.length === 1) return { searchedName: match.searchedName, attorney: confirmed[0]!,
      matchConfidence: 'cross_ref', ambiguous: false };
    return { searchedName: match.searchedName, attorney: null, matchConfidence: 'no_match',
      ambiguous: candidates.length > 1 || confirmed.length > 1, ...(candidates.length ? { candidates } : {}) };
  });
}

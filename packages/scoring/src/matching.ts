import type { Attorney, AttorneyMatch, DirectoryQuery, FirmIdentity } from '@arca/contracts';

export function normalizeName(name: string): string {
  const normalized = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
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
const firmCore = (value: string | null | undefined) => value?.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/\b(?:law|legal|firm|office|offices|attorney|attorneys|lawyer|lawyers|p\.?a\.?|llp|pllc|llc|inc|mr|ms)\b/g, ' ')
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

const asContext = (value: string | null | IdentityContext): IdentityContext => typeof value === 'object' && value !== null
  ? value : { firmName: value, aliases: [], city: null, county: null, addressStreet: null, phone: null };
export function reconcileBarMatches(bar: AttorneyMatch[] | null, identity: string | null | IdentityContext,
  avvo: AttorneyMatch[] | null = null): AttorneyMatch[] | null {
  if (bar === null) return null;
  const context = asContext(identity);
  return bar.map(match => {
    if (match.attorney && ['exact', 'firm_fallback'].includes(match.matchConfidence)) return match;
    const candidates = candidatesForSupport(match);
    const firmMatches = candidates.filter(candidate => [context.firmName, ...(context.aliases ?? [])]
      .some(firm => sameFirm(candidate.firmName, firm)));
    if (firmMatches.length === 1) return { searchedName: match.searchedName, attorney: firmMatches[0]!,
      matchConfidence: 'cross_ref', ambiguous: false };
    const avvoMatch = avvo?.find(item => normalizeName(item.searchedName) === normalizeName(match.searchedName));
    const crossMatches = candidates.filter(candidate => (avvoMatch?.attorney ? [avvoMatch.attorney] : [])
      .some(other => crossDirectoryIdentity(candidate, other)));
    if (crossMatches.length === 1) return { searchedName: match.searchedName, attorney: crossMatches[0]!,
      matchConfidence: 'cross_ref', ambiguous: false };
    const countyMatches = candidates.filter(candidate => sameKnown(candidate.county, context.county ?? null) ||
      sameKnown(candidate.city, context.city ?? null));
    if (countyMatches.length === 1) return { searchedName: match.searchedName, attorney: countyMatches[0]!,
      matchConfidence: 'county_match', ambiguous: false };
    return { searchedName: match.searchedName, attorney: null, matchConfidence: 'no_match',
      ambiguous: candidates.length > 1 || firmMatches.length > 1 || crossMatches.length > 1 || countyMatches.length > 1,
      ...(candidates.length ? { candidates } : {}) };
  });
}

export function reconcileAvvoMatches(avvo: AttorneyMatch[] | null, bar: AttorneyMatch[] | null,
  identity: string | null | IdentityContext): AttorneyMatch[] | null {
  if (avvo === null) return null;
  const context = asContext(identity);
  return avvo.map(match => {
    if (match.attorney && ['exact', 'exact_name'].includes(match.matchConfidence)) {
      return { ...match, matchConfidence: 'exact_name' as const, candidates: undefined };
    }
    const candidates = candidatesForSupport(match);
    const barMatch = bar?.find(item => normalizeName(item.searchedName) === normalizeName(match.searchedName));
    const barCandidates = barMatch ? candidatesForSupport(barMatch) : [];
    const confirmed = candidates.filter(candidate =>
      barCandidates.some(barCandidate => crossDirectoryIdentity(candidate, barCandidate)) ||
      [context.firmName, ...(context.aliases ?? [])].some(firm => sameFirm(candidate.firmName, firm)) ||
      sameKnown(candidate.addressStreet, context.addressStreet ?? null) || sameKnown(candidate.phone, context.phone ?? null));
    if (confirmed.length === 1) return { searchedName: match.searchedName, attorney: confirmed[0]!,
      matchConfidence: 'cross_ref', ambiguous: false };
    return { searchedName: match.searchedName, attorney: null, matchConfidence: 'no_match',
      ambiguous: candidates.length > 1 || confirmed.length > 1, ...(candidates.length ? { candidates } : {}) };
  });
}

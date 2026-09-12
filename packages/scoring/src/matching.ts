import type { Attorney, AttorneyMatch } from '@arca/contracts';

export function normalizeName(name: string): string {
  return name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/\b(?:esq\.?|j\.?\s*d\.?|jr\.?|iii|ph\.?\s*d\.?)\b/g, '')
    .replace(/[^a-z\s'-]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function stableSample(names: string[]): string[] {
  const sorted = [...names].sort((a, b) => normalizeName(a).localeCompare(normalizeName(b)) || a.localeCompare(b));
  const unique = new Map<string, string>();
  for (const name of sorted) { const key = normalizeName(name); if (key && !unique.has(key)) unique.set(key, name); }
  return [...unique.values()].slice(0, 15);
}

function sameInitialAndLast(a: string, b: string) {
  const left = normalizeName(a).split(' '), right = normalizeName(b).split(' ');
  return left[0]?.[0] === right[0]?.[0] && left.at(-1) === right.at(-1);
}

export function matchAttorney(name: string, candidates: Attorney[], firmFallback = false): AttorneyMatch {
  const normalizeFirm = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
  let matches = firmFallback ? candidates.filter(a => a.firmName && normalizeFirm(a.firmName) === normalizeFirm(name)) :
    candidates.filter(a => normalizeName(a.name) === normalizeName(name));
  let confidence: AttorneyMatch['matchConfidence'] = firmFallback ? 'firm_fallback' : 'exact';
  if (!matches.length && !firmFallback) { matches = candidates.filter(a => sameInitialAndLast(a.name, name)); confidence = 'fuzzy'; }
  if (matches.length > 1) {
    const miami = matches.filter(a => a.city?.trim().toLowerCase() === 'miami');
    if (miami.length) matches = miami;
  }
  const identity = (a: Attorney) => a.barNumber ?? a.profileUrl ?? `${normalizeName(a.name)}:${a.city}:${a.firmName}`;
  matches = [...new Map(matches.map(a => [identity(a), a])).values()];
  if (matches.length !== 1) return { searchedName: name, attorney: null, matchConfidence: 'no_match',
    ambiguous: matches.length > 1, ...(matches.length ? { candidates: matches } : {}) };
  return { searchedName: name, attorney: matches[0]!, matchConfidence: confidence, ambiguous: false };
}

const normalizedText = (value: string | null) => value?.toLowerCase().replace(/[^a-z0-9]/g, '') || null;
const sameKnown = (left: string | null, right: string | null) => {
  const a = normalizedText(left), b = normalizedText(right);
  return a !== null && b !== null && a === b;
};
function sameFirstAndLast(left: string, right: string) {
  const a = normalizeName(left).split(' '), b = normalizeName(right).split(' ');
  return a[0] === b[0] && a.at(-1) === b.at(-1);
}
function candidatesForSupport(match: AttorneyMatch) {
  return (match.candidates ?? (match.attorney ? [match.attorney] : []))
    .filter(candidate => sameFirstAndLast(candidate.name, match.searchedName));
}

export function reconcileBarMatches(bar: AttorneyMatch[] | null, firmName: string | null): AttorneyMatch[] | null {
  if (bar === null) return null;
  return bar.map(match => {
    if (match.attorney && ['exact', 'firm_fallback'].includes(match.matchConfidence)) return match;
    const candidates = candidatesForSupport(match);
    const firmMatches = candidates.filter(candidate => sameKnown(candidate.firmName, firmName));
    if (firmMatches.length === 1) return { searchedName: match.searchedName, attorney: firmMatches[0]!,
      matchConfidence: 'cross_ref', ambiguous: false };
    const countyMatches = candidates.filter(candidate =>
      candidate.county?.trim().toLowerCase() === 'miami-dade' || candidate.city?.trim().toLowerCase() === 'miami');
    if (countyMatches.length === 1) return { searchedName: match.searchedName, attorney: countyMatches[0]!,
      matchConfidence: 'county_match', ambiguous: false };
    return { searchedName: match.searchedName, attorney: null, matchConfidence: 'no_match',
      ambiguous: candidates.length > 1 || firmMatches.length > 1 || countyMatches.length > 1 };
  });
}

export function reconcileAvvoMatches(avvo: AttorneyMatch[] | null, bar: AttorneyMatch[] | null, firmName: string | null): AttorneyMatch[] | null {
  if (avvo === null) return null;
  return avvo.map(match => {
    if (match.attorney && ['exact', 'exact_name'].includes(match.matchConfidence)) {
      return { ...match, matchConfidence: 'exact_name' as const, candidates: undefined };
    }
    const candidates = candidatesForSupport(match);
    const barAttorney = bar?.find(item => normalizeName(item.searchedName) === normalizeName(match.searchedName))?.attorney ?? null;
    const confirmed = candidates.filter(candidate =>
      sameKnown(candidate.addressStreet, barAttorney?.addressStreet ?? null) ||
      sameKnown(candidate.phone, barAttorney?.phone ?? null) ||
      sameKnown(candidate.firmName, barAttorney?.firmName ?? null) ||
      sameKnown(candidate.firmName, firmName));
    if (confirmed.length === 1) return { searchedName: match.searchedName, attorney: confirmed[0]!,
      matchConfidence: 'cross_ref', ambiguous: false };
    return { searchedName: match.searchedName, attorney: null, matchConfidence: 'no_match',
      ambiguous: candidates.length > 1 || confirmed.length > 1 };
  });
}

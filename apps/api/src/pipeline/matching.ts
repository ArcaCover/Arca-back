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
  if (matches.length !== 1) return { searchedName: name, attorney: null, matchConfidence: 'no_match', ambiguous: matches.length > 1 };
  return { searchedName: name, attorney: matches[0]!, matchConfidence: confidence, ambiguous: false };
}

import type { Attorney, AttorneyMatch, FirmIdentity, SourceStatus } from '@arca/contracts';
import { normalizeName } from './matching.js';

/** Code-unit order. Unlike localeCompare it cannot change with the locale or ICU data of the runtime. */
export const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

// Sorts on a list of keys compared in turn. Every caller ends its keys with the item itself or its
// serialized form, so only identical items can tie and any input order gives the same output order.
function ordered<T>(items: readonly T[], keys: (item: T) => string[]): T[] {
  return items.map(item => ({ item, keys: keys(item) })).sort((left, right) => {
    for (let index = 0; index < left.keys.length; index++) {
      const order = compareText(left.keys[index]!, right.keys[index] ?? '');
      if (order) return order;
    }
    return 0;
  }).map(entry => entry.item);
}
const personKeys = (person: Attorney | null) => person === null ? ['', '', '', '']
  : [person.barNumber ?? '', person.profileUrl ?? '', normalizeName(person.name), person.name];

/**
 * Directory answers in one fixed order: by searched name, then by the matched person. A provider
 * returns lookups and candidates in completion order, which says nothing about the firm, so the
 * result must not depend on it. The lists inside one person (awards, practice areas, disciplinary
 * actions) are that record's own order and are left alone.
 */
export function canonicalMatches(matches: AttorneyMatch[] | null): AttorneyMatch[] | null {
  if (matches === null) return null;
  return ordered(matches.map(match => match.candidates
    ? { ...match, candidates: ordered(match.candidates, person => [...personKeys(person), JSON.stringify(person)]) } : match),
  match => [normalizeName(match.searchedName), match.searchedName, ...personKeys(match.attorney), JSON.stringify(match)]);
}

export function canonicalIdentity(identity: FirmIdentity): FirmIdentity {
  return { ...identity, aliases: ordered(identity.aliases, alias => [alias]),
    attorneyNames: ordered(identity.attorneyNames, name => [normalizeName(name), name]),
    evidence: ordered(identity.evidence, reference => [reference.sourceUrl, reference.method, reference.excerpt ?? '',
      JSON.stringify(reference)]) };
}

/** Provider runs finish in any order; the query fingerprint is the same for the same lookup on every scan. */
export function canonicalSource(status: SourceStatus): SourceStatus {
  return status.providerRuns ? { ...status, providerRuns: ordered(status.providerRuns,
    run => [run.queryFingerprint, run.runId, JSON.stringify(run)]) } : status;
}

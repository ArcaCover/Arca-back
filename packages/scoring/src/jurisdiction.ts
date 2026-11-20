import type { AttorneyMatch, EvidenceReference, PreScore, WebsiteData } from '@arca/contracts';
import { compareText } from './canonical.js';
import { normalizeName } from './matching.js';

/**
 * Where each attorney is licensed, and so which of them the Bar registry can speak for (DN-12 §15).
 *
 * The facts travel in the website data's provenance, a free-form record, so the contract stays as it is (DN-12 D6):
 * - ATTORNEY_STATES_KEY: what the firm's own site shows. The website extraction writes one reference per attorney
 *   and page, the excerpt `Full Name: FL, GA` (the name as the site writes it, then two-letter codes).
 * - AVVO_ADMISSIONS_KEY: the bar admissions of an Avvo profile. The pipeline writes one reference per profile the Avvo
 *   lookups returned, after the directories answered: sourceUrl is the profile, the excerpt `FL, GA`. Scoring reads
 *   it only for the profile it accepted for an attorney.
 * Scoring reads both through `attorneyJurisdictions`; nothing else depends on the excerpt format.
 */
export const ATTORNEY_STATES_KEY = 'attorney_states';
export const AVVO_ADMISSIONS_KEY = 'avvo_bar_admissions';
/**
 * Flag: some of the firm's attorneys are licensed only outside the state of the Bar registry the scan reads (Florida,
 * the only one wired). They neither add to nor subtract from the Bar rules. The B3 rule's reason says how many.
 */
export const ATTORNEYS_OUTSIDE_FLORIDA = 'ATTORNEYS_OUTSIDE_FLORIDA';
/** Fewer attorneys expected in the registry's state than this leave B3 unknown once some are licensed elsewhere. */
export const MIN_IN_STATE_ATTORNEYS = 2;

const STATES: Readonly<Record<string, string>> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut',
  DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois',
  IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska',
  NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina',
  ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island',
  SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia',
  WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};
const fold = (value: string) => value.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim()
  // "Dist. of Columbia" (Avvo), "Washington, D.C." and "D.C." are the District, not Washington state.
  .replace(/\bdist\b/g, 'district').replace(/\b(?:washington )?d c\b/g, 'district of columbia');
const BY_NAME = new Map(Object.entries(STATES).map(([code, name]) => [fold(name), code]));
// Longest name first, so West Virginia is read before Virginia.
const NAMES = [...BY_NAME.keys()].sort((a, b) => b.length - a.length || compareText(a, b));

/** A US state (or DC) as its two-letter code, from its code or its full name ("Dist. of Columbia" too). Null otherwise. */
export function stateCode(value: string): string | null {
  const code = value.trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(code)) return code in STATES ? code : null;
  return BY_NAME.get(fold(value)) ?? null;
}

/** The states a piece of text names in full, as sorted codes. Two-letter codes are not read here: "IN" or "OK" is a word. */
export function statesIn(text: string): string[] {
  let rest = ` ${fold(text)} `;
  const found = new Set<string>();
  for (const name of NAMES) {
    const word = ` ${name} `;
    while (rest.includes(word)) { found.add(BY_NAME.get(name)!); rest = rest.replace(word, ' | '); }
  }
  return [...found].sort(compareText);
}

const codes = (states: Iterable<string>) => [...new Set(states)].sort(compareText).join(', ');

/** The reference the website extraction writes for one attorney: `Full Name: FL, GA`. */
export function attorneyStatesReference(name: string, states: Iterable<string>, sourceUrl: string,
  method: EvidenceReference['method'] = 'page_text'): EvidenceReference {
  return { sourceUrl, excerpt: `${name.trim()}: ${codes(states)}`, method };
}

/** The reference the pipeline writes for one Avvo profile: its bar admissions. */
export function admissionsReference(profileUrl: string, states: Iterable<string>): EvidenceReference {
  return { sourceUrl: profileUrl, excerpt: codes(states), method: 'provider' };
}

const stateList = (text: string): string[] | null => {
  const parts = text.split(',').map(part => part.trim());
  return parts.length && parts.every(part => /^[A-Z]{2}$/.test(part) && part in STATES) ? parts : null;
};

/** The states the firm's own site shows for each attorney, keyed by normalized name. A reference it cannot read is skipped. */
export function readAttorneyStates(website: Pick<WebsiteData, 'provenance'> | null): Map<string, Set<string>> {
  const states = new Map<string, Set<string>>();
  for (const reference of website?.provenance?.[ATTORNEY_STATES_KEY] ?? []) {
    const split = reference.excerpt?.lastIndexOf(': ') ?? -1;
    if (split <= 0) continue;
    const name = normalizeName(reference.excerpt!.slice(0, split)), list = stateList(reference.excerpt!.slice(split + 2));
    if (!name || !list) continue;
    const known = states.get(name) ?? new Set<string>();
    for (const code of list) known.add(code);
    states.set(name, known);
  }
  return states;
}

function readAdmissions(website: Pick<WebsiteData, 'provenance'> | null): Map<string, Set<string>> {
  const admissions = new Map<string, Set<string>>();
  for (const reference of website?.provenance?.[AVVO_ADMISSIONS_KEY] ?? []) {
    const list = reference.excerpt ? stateList(reference.excerpt) : null;
    if (!list) continue;
    admissions.set(reference.sourceUrl, new Set([...(admissions.get(reference.sourceUrl) ?? []), ...list]));
  }
  return admissions;
}

/** IN_STATE: licensed in the registry's state. OUT_OF_STATE: licensed only elsewhere. UNKNOWN: no evidence either way. */
export type Jurisdiction = 'IN_STATE' | 'OUT_OF_STATE' | 'UNKNOWN';

/**
 * Each of the firm's attorneys (the website's and the Bar's searched names, by normalized name) against the state of the
 * Bar registry: a Bar match proves the licence there; otherwise the states the site shows and those of the accepted Avvo
 * profile decide, and a list that names the state counts as in it. No evidence leaves the attorney UNKNOWN.
 */
export function attorneyJurisdictions(input: { website: Pick<WebsiteData, 'provenance' | 'team_members'> | null;
  bar: AttorneyMatch[] | null; avvo: AttorneyMatch[] | null; state: string }): Map<string, Jurisdiction> {
  const listed = readAttorneyStates(input.website), admissions = readAdmissions(input.website);
  const names = new Set([...(input.website?.team_members ?? []).map(person => normalizeName(person.full_name)),
    ...(input.bar ?? []).filter(match => match.matchConfidence !== 'firm_fallback').map(match => normalizeName(match.searchedName))]);
  const matched = new Set((input.bar ?? []).filter(match => match.attorney !== null).map(match => normalizeName(match.searchedName)));
  const result = new Map<string, Jurisdiction>();
  for (const name of [...names].filter(Boolean).sort(compareText)) {
    const states = new Set(listed.get(name) ?? []);
    for (const match of input.avvo ?? []) {
      const profile = match.attorney?.profileUrl;
      if (profile && normalizeName(match.searchedName) === name) for (const code of admissions.get(profile) ?? []) states.add(code);
    }
    result.set(name, matched.has(name) || states.has(input.state) ? 'IN_STATE' : states.size ? 'OUT_OF_STATE' : 'UNKNOWN');
  }
  return result;
}

/** A state's full name from its code; the code itself when it is not a state. */
export const stateName = (code: string): string => STATES[code] ?? code;

const OUTSIDE = /(\d+) of (\d+) website attorneys are licensed outside /;
/** The sentence the B3 rule's reason carries when some attorneys are licensed outside the registry's state. */
export function outsideSentence(outside: number, total: number, state: string): string {
  const name = stateName(state);
  return `${outside} of ${total} website attorneys are licensed outside ${name} and were not scored against the ${name} Bar`;
}
/** How many of the firm's attorneys the Bar rules left out as licensed elsewhere, read back from a result. Null when none. */
export function outsideBarState(preScore: Pick<PreScore, 'categories' | 'flags'>): { outside: number; total: number } | null {
  if (!preScore.flags.includes(ATTORNEYS_OUTSIDE_FLORIDA)) return null;
  const reason = preScore.categories.professionalStanding.rules.find(rule => rule.id === 'B3')?.reason ?? '';
  const found = OUTSIDE.exec(reason);
  return found ? { outside: Number(found[1]), total: Number(found[2]) } : null;
}

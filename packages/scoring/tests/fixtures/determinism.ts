import { readFileSync } from 'node:fs';
import { Layer1Evidence, unknownAttorney, unknownWebsite, type Attorney, type AttorneyMatch, type WebsiteData } from '@arca/contracts';
import { stableSample } from '../../src/index.js';

export const OBSERVED_AT = '2026-11-09T10:00:00.000Z';
type Sources = Layer1Evidence['sources'];
type Run = NonNullable<Sources['bar']['providerRuns']>[number];

function evidence(domain: string, website: WebsiteData | null, bar: AttorneyMatch[] | null, avvo: AttorneyMatch[] | null,
  sources: Sources, observedAt = OBSERVED_AT): Layer1Evidence {
  const firmName = website?.firm_name ?? null;
  const attorneyNames = stableSample(website?.team_members?.map(person => person.full_name) ?? []);
  const reference = (path: string) => ({ sourceUrl: `https://${domain}/${path}`, excerpt: path, method: 'page_text' as const });
  return Layer1Evidence.parse({ identity: { canonicalDomain: domain, firmName, aliases: website?.firm_aliases ?? [],
    city: website?.city ?? null, county: website?.county ?? null, addressStreet: website?.address_street ?? null,
    phone: website?.phone ?? null, attorneyNames,
    status: firmName && attorneyNames.length ? 'VERIFIED' : firmName || attorneyNames.length ? 'PARTIAL' : 'INSUFFICIENT',
    evidence: website ? [reference('contact'), reference('about'), reference('team')] : [] },
    website, bar, avvo, sources, observedAt, barJurisdiction: 'FL' });
}
const run = (fingerprint: string, fields: Partial<Run> = {}): Run => ({ provider: 'apify', actor: 'fixture/actor',
  runId: `run-${fingerprint}`, status: 'SUCCEEDED', queryFingerprint: fingerprint.repeat(64).slice(0, 64), itemCount: 1,
  acceptedCount: 1, costUsd: .01, ...fields });
const website = (fields: Partial<WebsiteData>): WebsiteData => ({ ...unknownWebsite(), ...fields });
const person = (name: string, fields: Partial<Attorney>): Attorney => ({ ...unknownAttorney(name), ...fields });

/** The mock scenarios the API serves, one attorney each. */
export function mockEvidence(name: 'robust' | 'minimal' | 'sanctioned' | 'partial', observedAt = OBSERVED_AT): Layer1Evidence {
  const raw = readFileSync(new URL(`../../../../apps/api/mocks/${name}.json`, import.meta.url), 'utf8')
    .replaceAll('$RECENT_SANCTION_DATE', '2026-10-10');
  const scenario = JSON.parse(raw);
  return evidence(`${name}.arca.example`, scenario.website, scenario.bar, scenario.avvo, scenario.sources, observedAt);
}

/**
 * Seven attorneys whose Avvo ratings average exactly 8.0, the edge of the top rating band. Summed in
 * input order the average came out just under or just over 8, and the firm moved between 81
 * (FORTRESS) and 78 (FORTIFIED) with the order of the directory answers.
 */
export function sevenAttorneys(observedAt = OBSERVED_AT): Layer1Evidence {
  const names = ['Ana Perez', 'Bruno Diaz', 'Carla Ruiz', 'Diego Soto', 'Elena Mora', 'Fabio Luna', 'Gina Vega'];
  const ratings = [8.1, 7.9, 9.3, 6.7, 8.8, 10, 5.2], reviews = [4.9, 3.7, 4.1, 4.6, 3.9, 5, 4.3];
  const status = { status: 'ok' as const, dataStatus: 'PRESENT' as const, durationMs: 1,
    attorneysSearched: names.length, attorneysFound: names.length };
  const bar = names.map((name, i): AttorneyMatch => ({ searchedName: name, matchConfidence: 'exact', ambiguous: false,
    attorney: person(name, { barNumber: `b${i}`, barStatus: 'active', admissionDate: `20${10 + i}-0${i + 1}-1${i}`,
      hasDisciplinaryHistory: i === 3, activeInvestigation: false, firmName: 'Perez Diaz Law', city: 'Miami',
      disciplinaryActions: i === 3 ? [{ severity: 'public_reprimand', date: '2024-03-01', description: 'x' },
        { severity: 'suspension', date: '2020-01-01', description: 'y' }] : [] }) }));
  const avvo = names.map((name, i): AttorneyMatch => ({ searchedName: name, matchConfidence: 'exact_name', ambiguous: false,
    attorney: person(name, { profileUrl: `https://avvo.example/${i}`, avvoRating: ratings[i]!, reviewCount: 3 + i,
      averageReviewRating: reviews[i]!, awardsCount: i === 3 ? 4 : i % 2, topAward: i % 2 ? `Award ${i}` : null,
      practiceAreas: i % 2 ? ['Immigration'] : ['Family', 'Real estate'], hasDisciplinaryHistory: false,
      avvoRatingLevel: i % 3 ? 'Excellent' : 'Superb', firmName: 'Perez Diaz Law', city: 'Miami' }) }));
  return evidence('perezdiaz.example', website({ firm_name: 'Perez Diaz Law', firm_aliases: ['Perez Diaz', 'PD Law', 'Perez & Diaz'],
    city: 'Miami', phone: '(305) 555-0100', practice_areas: ['Immigration', 'Family Law', 'Real Estate'],
    team_members: names.map(full_name => ({ full_name, title: 'Attorney' })), team_size: names.length,
    firm_established_year: 2012, team_page_quality: 'detailed', website_quality: 'robust',
    privacy_policy: { found: true, mentions_client_data: true }, ai_policy: { found: true, depth: 'basic', text_excerpt: null },
    ai_in_services: { found: true, tools_mentioned: ['Harvey', 'CoCounsel', 'Clio Duo'], integration_depth: 'supplementary' },
    ai_disclosure: { found: true, text_excerpt: null }, ai_blog_posts: { found: true, count: 2, titles: ['a', 'b'] } }),
  bar, avvo, { website: { status: 'ok', dataStatus: 'PRESENT', durationMs: 1, pagesCrawled: 5 },
    bar: { ...status, providerRuns: names.map((_, i) => run(String.fromCharCode(103 - i))) },
    avvo: { ...status, providerRuns: names.map((_, i) => run(String.fromCharCode(97 + i), { cached: i % 2 === 0 })) } }, observedAt);
}

/**
 * Three attorneys rated 2.2, 9.1 and 9.7: the average is exactly 7, which earns six points, yet
 * 9.7 + 9.1 + 2.2 gave 6.999999999999999 and two points. Their review ratings average exactly 4.
 */
export function ratingBoundary(observedAt = OBSERVED_AT): Layer1Evidence {
  const names = ['Hugo Ibarra', 'Irene Jara', 'Jorge Kuri'];
  const ratings = [2.2, 9.1, 9.7], reviews = [3.1, 4.1, 4.8];
  const status = { status: 'ok' as const, dataStatus: 'PRESENT' as const, durationMs: 1, attorneysSearched: 3, attorneysFound: 3 };
  // Admitted 5, 10 and 15 years before the observation day: an average of exactly ten years is not "more than ten".
  const admitted = ['2021-11-09', '2016-11-09', '2011-11-09'];
  return evidence('ibarrajara.example', website({ firm_name: 'Ibarra Jara', city: 'Tampa',
    team_members: names.map(full_name => ({ full_name, title: null })), team_size: 3, practice_areas: ['Tax', 'Bankruptcy'] }),
  names.map((name, i): AttorneyMatch => ({ searchedName: name, matchConfidence: 'exact', ambiguous: false,
    attorney: person(name, { barNumber: `k${i}`, barStatus: 'active', admissionDate: admitted[i]!, hasDisciplinaryHistory: false,
      disciplinaryActions: [], activeInvestigation: false }) })),
  names.map((name, i): AttorneyMatch => ({ searchedName: name, matchConfidence: 'exact_name', ambiguous: false,
    attorney: person(name, { profileUrl: `https://avvo.example/k${i}`, avvoRating: ratings[i]!, reviewCount: 4,
      averageReviewRating: reviews[i]!, awards: i === 1 ? ['Rising Star', 'Clients Choice'] : [], practiceAreas: ['Tax'],
      hasDisciplinaryHistory: false }) })),
  { website: { status: 'ok', dataStatus: 'PRESENT', durationMs: 1, pagesCrawled: 3 }, bar: status, avvo: status }, observedAt);
}

/**
 * Named lookups that need the cross-check: shortened names with several candidates, one person
 * answering two searched names, an ambiguous namesake, and a full Avvo result page.
 */
export function ambiguousDirectory(observedAt = OBSERVED_AT): Layer1Evidence {
  const firm = 'Mauri Ortega Law';
  const briana = person('Briana Nicole Mauri', { barNumber: '1071132', barStatus: 'active', admissionDate: '2015-10-30',
    addressStreet: '14561 SW 37th St', city: 'Miramar', firmName: firm, hasDisciplinaryHistory: false, disciplinaryActions: [] });
  const otherBriana = person('Briana Mauri Lopez', { barNumber: '2200001', barStatus: 'inactive', admissionDate: '2001-02-03',
    city: 'Orlando', firmName: 'Lopez Legal' });
  const thirdBriana = person('Briana N Mauri', { barNumber: '2200002', barStatus: 'active', admissionDate: '2019-06-01',
    city: 'Tampa', firmName: 'Bay Counsel' });
  const carlos = person('Carlos Ortega', { barNumber: '300300', barStatus: 'active', admissionDate: '2009-04-12',
    firmName: firm, city: 'Miramar', hasDisciplinaryHistory: true,
    disciplinaryActions: [{ severity: 'admonishment', date: '2019-05-05', description: 'first' },
      { severity: 'public_reprimand', date: '2021-07-07', description: 'second' }] });
  const namesakes = [person('Dana Reyes', { barNumber: '400401', barStatus: 'active', admissionDate: '2012-01-01', city: 'Miami' }),
    person('Dana Reyes', { barNumber: '400402', barStatus: 'active', admissionDate: '2018-01-01', city: 'Jacksonville' })];
  const avvoBriana = person('Briana Nicole Mauri', { licensedSince: '2015', addressStreet: '14561 SW 37th St', city: 'Miramar',
    profileUrl: 'https://www.avvo.com/briana-mauri', avvoRating: 7.4, reviewCount: 12, averageReviewRating: 4.6,
    awards: ['Clients Choice 2024', 'Rising Star'], practiceAreas: ['Immigration', 'Family'], hasDisciplinaryHistory: false });
  const avvoNamesake = person('Briana Mauri', { city: 'Naples', profileUrl: 'https://www.avvo.com/another-briana', avvoRating: 3.1,
    reviewCount: 2, averageReviewRating: 2.5, awardsCount: 0, practiceAreas: ['Tax'], hasDisciplinaryHistory: false });
  const avvoCarlos = person('Carlos Ortega', { firmName: firm, city: 'Miramar', profileUrl: 'https://www.avvo.com/carlos-ortega',
    avvoRating: 8.6, reviewCount: 30, averageReviewRating: 4.2, awardsCount: 3, topAward: 'Top Contributor',
    practiceAreas: ['Immigration'], hasDisciplinaryHistory: true });
  const noMatch = (searchedName: string, candidates: Attorney[]): AttorneyMatch =>
    ({ searchedName, matchConfidence: 'no_match', attorney: null, ambiguous: candidates.length > 1, candidates });
  const names = ['Briana Mauri', 'Carlos Ortega', 'C. Ortega', 'Dana Reyes', 'Evan Flores'];
  return evidence('mauriortega.example', website({ firm_name: firm, firm_aliases: ['Mauri Ortega', 'MO Law'], city: 'Miramar',
    address_street: '14561 SW 37th St', team_members: names.map(full_name => ({ full_name, title: 'Attorney' })), team_size: 5,
    practice_areas: ['Immigration law', 'Family', 'Criminal law'], firm_established_year: 2010, website_quality: 'basic',
    team_page_quality: 'names_only', ai_policy: { found: false, depth: 'none', text_excerpt: null },
    ai_in_services: { found: true, tools_mentioned: ['Lexis+ AI', 'ChatGPT', 'Casetext'], integration_depth: 'experimental' } }),
  [noMatch('Briana Mauri', [otherBriana, briana, thirdBriana]),
    { searchedName: 'Carlos Ortega', matchConfidence: 'exact', attorney: carlos, ambiguous: false },
    { searchedName: 'C. Ortega', matchConfidence: 'fuzzy', attorney: carlos, ambiguous: false },
    noMatch('Dana Reyes', namesakes),
    { searchedName: 'Evan Flores', matchConfidence: 'no_match', attorney: null, ambiguous: false }],
  [noMatch('Briana Mauri', [avvoNamesake, avvoBriana]),
    { searchedName: 'Carlos Ortega', matchConfidence: 'exact_name', attorney: avvoCarlos, ambiguous: false },
    { searchedName: 'C. Ortega', matchConfidence: 'exact_name', attorney: avvoCarlos, ambiguous: false },
    { searchedName: 'Dana Reyes', matchConfidence: 'no_match', attorney: null, ambiguous: false },
    { searchedName: 'Evan Flores', matchConfidence: 'no_match', attorney: null, ambiguous: false }],
  { website: { status: 'partial', dataStatus: 'PRESENT', durationMs: 1, pagesCrawled: 19 },
    bar: { status: 'ok', dataStatus: 'PRESENT', durationMs: 1, attorneysSearched: 5, attorneysFound: 2,
      providerRuns: ['e', 'c', 'a', 'd', 'b'].map(key => run(key)), costUsd: .05, accountingComplete: true },
    avvo: { status: 'partial', dataStatus: 'UNKNOWN', durationMs: 1, attorneysSearched: 5, attorneysFound: 2, code: 'TRUNCATED',
      reason: 'One or more targeted lookups were incomplete; raw responses retained',
      providerRuns: ['z', 'x', 'y'].map(key => run(key, { accountingComplete: false, costUsd: null })), costUsd: null,
      accountingComplete: false } }, observedAt);
}

/**
 * The shape of the founder's live scan: no attorney names on the site, so the Bar roster comes
 * from one firm-wide search (every match carries the firm as its searched name) and Avvo is skipped.
 */
export function firmFallback(observedAt = OBSERVED_AT): Layer1Evidence {
  const firm = 'Sunshine Immigration Law';
  const roster = [['Lucia Marin', '1999-09-26', 'active'], ['Mateo Nunez', '2004-02-29', 'active'], ['Nora Ochoa', '2013-07-04', 'inactive'],
    ['Oscar Pardo', '2020-12-31', 'active'], ['Lucia Marin', '2023-03-15', 'active'], ['Pilar Quiroga', '1987-05-17', 'active']] as const;
  return evidence('sunshineimmigration.example', website({ firm_name: firm, practice_areas: ['Immigration'], team_size: null,
    team_page_quality: 'no_team_page', website_quality: 'basic', firm_established_year: 1998 }),
  roster.map(([name, admissionDate, barStatus], i): AttorneyMatch => ({ searchedName: firm, matchConfidence: 'firm_fallback',
    ambiguous: false, attorney: person(name, { barNumber: `f${9 - i}`, barStatus, admissionDate, firmName: firm, city: 'Orlando',
      practiceAreas: ['Immigration', 'Appellate'] }) })),
  null,
  { website: { status: 'partial', dataStatus: 'PRESENT', durationMs: 1, pagesCrawled: 19 },
    bar: { status: 'ok', dataStatus: 'PRESENT', durationMs: 1, attorneysSearched: null, attorneysFound: roster.length,
      providerRuns: [run('c', { costUsd: null, accountingComplete: false, chargedToScan: true })], costUsd: null, accountingComplete: false },
    avvo: { status: 'skipped', dataStatus: 'UNKNOWN', durationMs: 0, code: 'INSUFFICIENT_IDENTITY',
      reason: 'A firm-wide search needs a verified city; a nationwide search is not run', attorneysSearched: 0, attorneysFound: 0,
      candidatesReceived: 0, recordsValid: 0, providerRuns: [], costUsd: 0 } }, observedAt);
}

/**
 * Two Avvo lookups whose searched names normalise to the same person ('Ana Perez Ana Perez', a name the site printed
 * twice, and 'Ana Pérez'), each confirmed by a different address, against one ambiguous Bar lookup ('Ana Perez Esq.')
 * with two namesakes. The Bar cross-check takes the first Avvo lookup for that name, so it accepts whichever namesake
 * the first lookup points to, and the two were admitted fifteen years apart. Only a fixed order of the lookups,
 * before the cross-check, keeps the result from following the order the provider answered in.
 */
export function sharedSearchedName(observedAt = OBSERVED_AT): Layer1Evidence {
  const bar = (barNumber: string, addressStreet: string, admissionDate: string) => person('Ana Perez', { barNumber, barStatus: 'active',
    admissionDate, addressStreet, city: null, firmName: null, hasDisciplinaryHistory: false, disciplinaryActions: [], activeInvestigation: false });
  const avvo = (slug: string, addressStreet: string, avvoRating: number) => person('Ana Perez', { addressStreet,
    profileUrl: `https://avvo.example/${slug}`, avvoRating, reviewCount: 5, averageReviewRating: 4.5, practiceAreas: ['Immigration'],
    hasDisciplinaryHistory: false });
  const status = { status: 'ok' as const, dataStatus: 'PRESENT' as const, durationMs: 1, attorneysSearched: 1, attorneysFound: 1 };
  return evidence('perezlegal.example', website({ firm_name: 'Perez Legal', city: 'Miami',
    team_members: [{ full_name: 'Ana Perez', title: 'Attorney' }], team_size: 1, practice_areas: ['Immigration'] }),
  [{ searchedName: 'Ana Perez Esq.', matchConfidence: 'no_match', attorney: null, ambiguous: true,
    candidates: [bar('500001', '1 Bay Street', '2005-03-01'), bar('500002', '9 Ocean Drive', '2020-03-01')] }],
  [{ searchedName: 'Ana Perez Ana Perez', matchConfidence: 'exact_name', ambiguous: false, attorney: avvo('ana-perez-1', '1 Bay Street', 9.1) },
    { searchedName: 'Ana Pérez', matchConfidence: 'exact_name', ambiguous: false, attorney: avvo('ana-perez-2', '9 Ocean Drive', 6.2) }],
  { website: { status: 'ok', dataStatus: 'PRESENT', durationMs: 1, pagesCrawled: 3 }, bar: status, avvo: { ...status, attorneysSearched: 2 } },
  observedAt);
}

/** A seeded generator, so a failing permutation can be reproduced from its seed. */
export function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; };
}
export function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

/** The same evidence with every list whose order carries no meaning put in another order. */
export function reorder(source: Layer1Evidence, random: () => number): Layer1Evidence {
  const copy = structuredClone(source);
  const list = <T>(items: T[] | null | undefined) => items ? shuffle(items, random) : items;
  const matches = (items: AttorneyMatch[] | null) => items === null ? null : shuffle(items, random)
    .map(match => match.candidates ? { ...match, candidates: shuffle(match.candidates, random) } : match);
  copy.bar = matches(copy.bar); copy.avvo = matches(copy.avvo);
  if (copy.website) {
    const site = copy.website;
    site.practice_areas = list(site.practice_areas) ?? null; site.team_members = list(site.team_members) ?? null;
    site.firm_aliases = list(site.firm_aliases) ?? null;
    site.ai_in_services.tools_mentioned = list(site.ai_in_services.tools_mentioned) ?? null;
    site.ai_blog_posts.titles = list(site.ai_blog_posts.titles) ?? null;
  }
  copy.identity.attorneyNames = shuffle(copy.identity.attorneyNames, random);
  copy.identity.aliases = shuffle(copy.identity.aliases, random);
  copy.identity.evidence = shuffle(copy.identity.evidence, random);
  for (const status of Object.values(copy.sources)) if (status.providerRuns) status.providerRuns = shuffle(status.providerRuns, random);
  return copy;
}

/** Additionally reorders the lists inside each person (practice areas, disciplinary actions). */
export function reorderPeople(source: Layer1Evidence, random: () => number): Layer1Evidence {
  const copy = reorder(source, random);
  for (const match of [...(copy.bar ?? []), ...(copy.avvo ?? [])]) {
    for (const attorney of [match.attorney, ...(match.candidates ?? [])]) {
      if (!attorney) continue;
      if (attorney.practiceAreas) attorney.practiceAreas = shuffle(attorney.practiceAreas, random);
      if (attorney.disciplinaryActions) attorney.disciplinaryActions = shuffle(attorney.disciplinaryActions, random);
    }
  }
  return copy;
}

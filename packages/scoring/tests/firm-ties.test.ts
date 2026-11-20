import { describe, expect, it } from 'vitest';
import { unknownAttorney, type Attorney, type AttorneyMatch, type WebsiteData } from '@arca/contracts';
import { ATTORNEY_STATES_KEY, BAR_FIRM_EMAIL_KEY, FIRM_OFFICE_CITIES_KEY, attorneyStatesReference, firmEmailReference, firmTies,
  matchAttorney, normalizeName, reconcileAvvoMatches, reconcileBarMatches } from '../src/index.js';

// The shape of lemonlawgrouppartners.com (scan sc_8bf75c9366254eda8558eb921178d552): the site lists "Matthew Foster" in New
// York and Connecticut; the Florida Bar has three namesakes and Avvo several, one of each admitted the same year at another
// firm in Tallahassee, which is also one of the firm's twenty Florida office cities. Synthetic names, same structure.
const FIRM = 'Harbor Lemon Partners';
const identity = { firmName: FIRM, aliases: [], city: 'North Miami Beach', county: null,
  addressStreet: '3323 NE 163rd St, Suite 301', phone: '(888) 555-0610' };
const offices = ['Miami Beach', 'Tallahassee', 'Tampa', 'Jacksonville', 'Orlando'];
const person = (name: string, fields: Partial<Attorney>): Attorney => ({ ...unknownAttorney(name), ...fields });
const barProfile = (barNumber: string) => `https://www.floridabar.org/directories/find-mbr/profile/?num=${barNumber}`;
const greenwich = person('Mason Hollister Fox', { barNumber: '800001', admissionDate: '2013-04-18', city: 'Greenwich', county: 'Non-Florida',
  firmName: 'Focus Partners Wealth', barStatus: 'active', profileUrl: barProfile('800001') });
const tampa = person('Mason James Fox', { barNumber: '800002', admissionDate: '1984-01-05', city: 'Tampa', county: 'Hillsborough',
  firmName: 'Allen Dell P A', barStatus: 'inactive', profileUrl: barProfile('800002') });
const tallahassee = person('Mason Kevin Fox', { barNumber: '800003', admissionDate: '1994-09-21', city: 'Tallahassee', county: 'Leon',
  firmName: 'Brooks, LeBoeuf, Fox, Gwartney, P.A.', barStatus: 'active', profileUrl: barProfile('800003') });
const avvoProfile = (name: string, licensedSince: string, city: string, fields: Partial<Attorney> = {}) => person(name,
  { licensedSince, city, firmName: name, profileUrl: `https://www.avvo.com/attorneys/${normalizeName(name).replaceAll(' ', '-')}.html`, ...fields });
const avvoFoxes = [avvoProfile('Mason Wallace Fox', '1992', 'Indianapolis'), avvoProfile('Mason Kevin Fox', '1994', 'Tallahassee'),
  avvoProfile('Mason Thomas Fox', '2008', 'New York'), avvoProfile('Mason Joseph Fox', '2018', 'New York')];

function website(states: Array<[string, string[]]> = [['Mason Fox', ['NY', 'CT']]], provenance: WebsiteData['provenance'] = {}) {
  return { provenance: { [FIRM_OFFICE_CITIES_KEY]: offices.map(city => ({ sourceUrl: `https://harborlemon.example/locations/`, excerpt: city,
    method: 'derived' as const })), [ATTORNEY_STATES_KEY]: states.map(([name, codes]) =>
    attorneyStatesReference(name, codes, 'https://harborlemon.example/attorneys/')), ...provenance } };
}
/** The directories' own answers, then the cross-check in the order evaluateLayer1Evidence runs it. */
function reconcile(bar: Attorney[], avvo: Attorney[], site = website(), name = 'Mason Fox') {
  const ties = firmTies(site, 'FL');
  const rawBar = [matchAttorney(name, bar, false, identity)], rawAvvo = [matchAttorney(name, avvo, false, identity)];
  const provisional = reconcileAvvoMatches(rawAvvo, rawBar, identity, ties);
  const settledBar = reconcileBarMatches(rawBar, identity, provisional, ties);
  return { rawBar: rawBar[0]!, bar: settledBar![0]!, avvo: reconcileAvvoMatches(rawAvvo, settledBar, identity, ties)![0]! };
}

describe('a Bar record needs a tie to this firm when the name alone does not settle it (DN-12 §15.5)', () => {
  it('rejects the namesake two directories agree on by name and year when nothing ties it to the firm', () => {
    const { rawBar, bar, avvo } = reconcile([greenwich, tampa, tallahassee], avvoFoxes);
    expect(rawBar).toMatchObject({ attorney: null, ambiguous: true });
    expect(bar).toMatchObject({ attorney: null, matchConfidence: 'no_match', ambiguous: true });
    expect(bar.candidates).toHaveLength(3);
    expect(avvo).toMatchObject({ attorney: null, matchConfidence: 'no_match', ambiguous: true });
  });

  it('rejects it as well when the site shows no states: two namesakes in office cities single out neither', () => {
    const { bar, avvo } = reconcile([greenwich, tampa, tallahassee], avvoFoxes, website([]));
    expect(bar).toMatchObject({ attorney: null, ambiguous: true });
    expect(avvo).toMatchObject({ attorney: null });
  });

  it('accepts the cross-check when one namesake alone sits in a firm office city and the site does not contradict it', () => {
    const elsewhere = { ...tampa, city: 'Greenwich', county: 'Non-Florida' };
    const { bar, avvo } = reconcile([greenwich, elsewhere, tallahassee], avvoFoxes, website([]));
    expect(bar).toMatchObject({ attorney: tallahassee, matchConfidence: 'cross_ref', ambiguous: false });
    expect(avvo).toMatchObject({ attorney: avvoFoxes[1], matchConfidence: 'cross_ref' });
  });

  it('does not let an office city outweigh a site that lists the attorney only in other states', () => {
    const elsewhere = { ...tampa, city: 'Greenwich', county: 'Non-Florida' };
    expect(reconcile([greenwich, elsewhere, tallahassee], avvoFoxes).bar).toMatchObject({ attorney: null });
  });

  it('accepts the namesake whose Bar firm is this firm, whatever "&", "and" or "P.A." it is written with', () => {
    const ours = { ...tallahassee, firmName: 'The Harbor Lemon Partners, P.A.' };
    expect(reconcile([greenwich, tampa, ours], avvoFoxes).bar).toMatchObject({ attorney: ours, matchConfidence: 'cross_ref' });
    const ampersand = (firmName: string, firm: string) => reconcileBarMatches([{ searchedName: 'Mason Fox', matchConfidence: 'no_match',
      ambiguous: true, attorney: null, candidates: [greenwich, { ...tallahassee, firmName }] }], { ...identity, firmName: firm }, null,
    firmTies(website(), 'FL'))![0]!;
    expect(ampersand('Fox and Lemon, LLP', 'Fox & Lemon').attorney?.barNumber).toBe('800003');
    expect(ampersand('Fox & Lemon P.L.', 'Fox and Lemon Law Firm').attorney?.barNumber).toBe('800003');
  });

  it('accepts the namesake whose Bar email is at the firm\'s domain, which the pipeline reports by profile', () => {
    const site = website([['Mason Fox', ['NY', 'CT']]], { [BAR_FIRM_EMAIL_KEY]: [firmEmailReference(tallahassee.profileUrl!, 'harborlemon.example')] });
    expect(reconcile([greenwich, tampa, tallahassee], avvoFoxes, site).bar)
      .toMatchObject({ attorney: tallahassee, matchConfidence: 'cross_ref', ambiguous: false });
  });

  it('accepts the cross-check when the Avvo profile it agrees with is at the firm\'s phone', () => {
    const atFirm = avvoFoxes.map(profile => profile.name === 'Mason Kevin Fox' ? { ...profile, phone: '888-555-0610' } : profile);
    const { bar, avvo } = reconcile([greenwich, tampa, tallahassee], atFirm);
    expect(avvo).toMatchObject({ attorney: { name: 'Mason Kevin Fox' } });
    expect(bar).toMatchObject({ attorney: tallahassee, matchConfidence: 'cross_ref' });
  });

  it('takes back an exact match the site contradicts unless something ties it to the firm', () => {
    const exact = (attorney: Attorney): AttorneyMatch[] => [{ searchedName: 'Mason Kevin Fox', matchConfidence: 'exact', ambiguous: false, attorney }];
    const site = website([['Mason Kevin Fox', ['NY', 'CT']]]);
    expect(reconcileBarMatches(exact(tallahassee), identity, null, firmTies(site, 'FL'))![0])
      .toMatchObject({ attorney: null, matchConfidence: 'no_match', ambiguous: false, candidates: [tallahassee] });
    const ours = { ...tallahassee, firmName: FIRM };
    expect(reconcileBarMatches(exact(ours), identity, null, firmTies(site, 'FL'))![0]).toMatchObject({ attorney: ours, matchConfidence: 'exact' });
    // Nothing contradicts it: a unique exact match stands as it always did, tied or not.
    expect(reconcileBarMatches(exact(tallahassee), identity, null, firmTies(website([['Mason Kevin Fox', ['FL', 'NY']]]), 'FL'))![0])
      .toMatchObject({ attorney: tallahassee, matchConfidence: 'exact' });
    expect(reconcileBarMatches(exact(tallahassee), identity, null, firmTies(website([]), 'FL'))![0]).toMatchObject({ attorney: tallahassee });
    // Without a registry state there is nothing to contradict.
    expect(reconcileBarMatches(exact(tallahassee), identity, null, firmTies(site, null))![0]).toMatchObject({ attorney: tallahassee });
  });

  it('keeps accepting a unique namesake through the other directory when the site says nothing against it', () => {
    const unique = person('Mason Kevin Fox', { ...tallahassee });
    const { bar, avvo } = reconcile([unique], [avvoFoxes[1]!], website([]));
    expect(bar).toMatchObject({ attorney: unique, matchConfidence: 'cross_ref' });
    expect(avvo).toMatchObject({ attorney: avvoFoxes[1], matchConfidence: 'cross_ref' });
  });

  it('reads the same in whatever order the directories listed the namesakes', () => {
    const forward = reconcile([greenwich, tampa, tallahassee], avvoFoxes, website([]));
    const backward = reconcile([tallahassee, tampa, greenwich], [...avvoFoxes].reverse(), website([]));
    expect(backward.bar.attorney).toEqual(forward.bar.attorney);
    expect(backward.avvo.attorney).toEqual(forward.avvo.attorney);
  });

  it('reads the ties from the website provenance', () => {
    const ties = firmTies(website([['Mason Fox', ['NY', 'CT']], ['Jordan Hale', ['FL', 'GA']], ['Unlisted Person', []]],
      { [BAR_FIRM_EMAIL_KEY]: [firmEmailReference(tallahassee.profileUrl!, 'harborlemon.example')] }), 'FL');
    expect([...ties.licensedElsewhere]).toEqual(['mason fox']);
    expect([...ties.emailProfiles]).toEqual([tallahassee.profileUrl]);
    expect([...ties.officeCities]).toEqual(offices);
    expect(firmTies(null, 'FL').licensedElsewhere.size).toBe(0);
    // The reference names the firm's domain, never an address.
    expect(firmEmailReference(tallahassee.profileUrl!, 'harborlemon.example'))
      .toEqual({ sourceUrl: tallahassee.profileUrl, excerpt: 'harborlemon.example', method: 'provider' });
  });
});

describe('quoted and parenthetical nicknames', () => {
  it.each([
    ['Mark Stephen Barnett "Marcus"', 'mark stephen barnett'],
    ['Katherine “Kate” Doe', 'katherine doe'],
    ['William \'Bill\' O\'Neil', 'william o\'neil'],
    ['William ‘Bill’ Jones', 'william jones'],
    ['Robert (Bob) Smith, Esq.', 'robert smith'],
    ['D\'Angelo Russo', 'd\'angelo russo'],
    ['"Jane Doe"', 'jane doe'],
  ])('reads %s as %s', (name, normalized) => {
    expect(normalizeName(name)).toBe(normalized);
  });

  it('matches a Bar record with a quoted nickname to the site\'s shorter name through the Avvo profile at the firm', () => {
    const bar = person('Morgan Stephen Barr "Marc"', { barNumber: '700004', admissionDate: '2007-06-21', city: 'Jacksonville',
      county: 'Duval', firmName: 'The Barr Law Firm, PLLC', barStatus: 'active' });
    const avvo = avvoProfile('Morgan Stephen Barr', '2007', 'North Miami Beach', { phone: '(888) 555-0610' });
    const { bar: settled, avvo: profile } = reconcile([bar], [avvo, avvoProfile('Morgan A. Barr', '2007', 'Boston')],
      website([['Morgan Barr', ['FL']]]), 'Morgan Barr');
    expect(profile).toMatchObject({ attorney: avvo });
    expect(settled).toMatchObject({ attorney: bar, matchConfidence: 'cross_ref', ambiguous: false });
  });
});

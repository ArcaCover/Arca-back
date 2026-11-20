import { describe, expect, it } from 'vitest';
import type { Layer1Evidence } from '@arca/contracts';
import { ATTORNEYS_OUTSIDE_FLORIDA, ATTORNEY_STATES_KEY, AVVO_ADMISSIONS_KEY, admissionsReference, attorneyStatesReference,
  evaluateLayer1Evidence, outsideBarState, readAttorneyStates, stateCode, statesIn } from '../src/index.js';
import { multiState } from './fixtures/determinism.js';

const rule = (result: ReturnType<typeof evaluateLayer1Evidence>, id: string) =>
  result.preScore.categories.professionalStanding.rules.find(item => item.id === id)!;
const withStates = (evidence: Layer1Evidence, listed: Array<[string, string[]]>) => {
  const copy = structuredClone(evidence);
  copy.website!.provenance[ATTORNEY_STATES_KEY] = listed.map(([name, states]) =>
    attorneyStatesReference(name, states, 'https://harborlemon.example/attorneys/'));
  return copy;
};

describe('attorneys licensed outside Florida (lemonlawgrouppartners.com, 2026-11-18)', () => {
  it('scores the Florida Bar rules on the attorneys expected in Florida only', () => {
    const result = evaluateLayer1Evidence(multiState());
    // Three attorneys the site lists in Florida, and one the Florida Bar matched although the site lists him elsewhere.
    expect(result.signals.bar.B3_consistency).toBe(.75);
    expect(rule(result, 'B3').points).toBe(0);
    expect(result.preScore.flags).toContain(ATTORNEYS_OUTSIDE_FLORIDA);
    expect(result.preScore.flags).not.toContain('LOW_BAR_CONSISTENCY');
    expect(rule(result, 'B3').reason).toContain('10 of 14 website attorneys are licensed outside Florida');
    expect(outsideBarState(result.preScore)).toEqual({ outside: 10, total: 14 });
  });

  it('keeps the real public reprimand of a Florida attorney', () => {
    const result = evaluateLayer1Evidence(multiState());
    expect(result.signals.bar.B2_worstDisciplinary).toBe('public_reprimand');
    expect(rule(result, 'B2_clean').points).toBe(0);
    // A Florida attorney the Bar did not match still leaves "every attorney active" unknown.
    expect(result.signals.bar.B1_allActive).toBeNull();
    expect(rule(result, 'B4').points).toBe(3);
    expect(result.preScore.categories.professionalStanding.score).toBe(3);
  });

  it('keeps the audit list of every lookup, the out-of-state ones included', () => {
    const result = evaluateLayer1Evidence(multiState());
    expect(result.signals.bar.attorneys).toHaveLength(14);
  });

  it('treats the attorneys of a site that shows no states as expected in Florida, as before', () => {
    const result = evaluateLayer1Evidence(multiState(undefined, { withStates: false }));
    expect(result.signals.bar.B3_consistency).toBeCloseTo(3 / 14);
    expect(rule(result, 'B3').points).toBe(-5);
    expect(rule(result, 'B3').reason).toBe('Evaluated from observed evidence');
    expect(result.preScore.flags).toContain('LOW_BAR_CONSISTENCY');
    expect(result.preScore.flags).not.toContain(ATTORNEYS_OUTSIDE_FLORIDA);
    expect(outsideBarState(result.preScore)).toBeNull();
  });

  it('leaves B3 unknown when most attorneys expected in Florida have no known state', () => {
    // Two Florida attorneys, both matched; five with no state; seven licensed elsewhere.
    const evidence = withStates(multiState(undefined, { withStates: false }), [['Jordan S. Hale', ['FL']], ['Blake R. Stone', ['FL']],
      ...['Sasha Mills', 'Steven Moray', 'Shawn Reed', 'Kathryn B. Adams', 'Jeff Chase', 'Jay Chandler', 'Adam Mott']
        .map((name): [string, string[]] => [name, ['GA']])]);
    const result = evaluateLayer1Evidence(evidence);
    // In scope: Hale, Stone, Fox (matched, so Florida) and Barr, Dale, Ewing, Garber (unknown): 3 known, 4 unknown.
    expect(result.signals.bar.B3_consistency).toBeNull();
    expect(rule(result, 'B3').points).toBeNull();
    expect(rule(result, 'B3').reason).toContain('7 of 14 website attorneys are licensed outside Florida');
    expect(result.preScore.flags).toContain(ATTORNEYS_OUTSIDE_FLORIDA);
    expect(result.preScore.flags).not.toContain('LOW_BAR_CONSISTENCY');
  });

  it('leaves B3 unknown when fewer than two attorneys are expected in Florida', () => {
    const evidence = multiState();
    evidence.bar = evidence.bar!.filter(match => ['Jordan S. Hale', 'Sasha Mills', 'Adam Mott'].includes(match.searchedName));
    evidence.sources.bar = { ...evidence.sources.bar, attorneysSearched: 3, attorneysFound: 1 };
    const listed = evidence.website!.provenance[ATTORNEY_STATES_KEY]!;
    evidence.website!.provenance[ATTORNEY_STATES_KEY] = listed.filter(reference => !/^(Blake|Morgan|Mason)/.test(reference.excerpt!));
    const result = evaluateLayer1Evidence(evidence);
    expect(result.signals.bar.B3_consistency).toBeNull();
    expect(result.preScore.flags).toContain(ATTORNEYS_OUTSIDE_FLORIDA);
  });

  it('counts an attorney the Florida Bar matched as a Florida attorney whatever the site lists', () => {
    const result = evaluateLayer1Evidence(multiState());
    expect(result.signals.bar.attorneys?.find(match => match.searchedName === 'Mason Fox')?.attorney?.barNumber).toBe('700003');
    // 3 matches over Hale, Stone, Barr and Fox: Fox stays in the denominator and in B4.
    expect(result.signals.bar.B3_consistency).toBe(.75);
    expect(result.signals.bar.B4_avgExperience).toBeGreaterThan(10);
  });

  it('does not let an out-of-state attorney\'s namesakes in the Florida Bar make the lookups ambiguous', () => {
    const evidence = multiState();
    const namesake = (barNumber: string, city: string) => ({ ...evidence.bar![0]!.attorney!, name: 'Adam Mott', barNumber, city,
      firmName: 'Other Firm', disciplinaryActions: null, hasDisciplinaryHistory: null });
    evidence.bar = evidence.bar!.map(match => match.searchedName === 'Adam Mott'
      ? { ...match, ambiguous: true, candidates: [namesake('800001', 'Miami'), namesake('800002', 'Tampa')] } : match);
    const result = evaluateLayer1Evidence(evidence);
    expect(result.signals.bar.B3_consistency).toBe(.75);
    expect(result.preScore.flags).not.toContain('AMBIGUOUS_IDENTITY_MATCH');
  });

  it('reads the bar admissions of an accepted Avvo profile when the site shows no states', () => {
    const evidence = multiState(undefined, { withStates: false });
    // Avvo matched Hale (Florida, Georgia, Michigan), Chandler (New Jersey, Pennsylvania) and Moray (Missouri).
    evidence.website!.provenance[AVVO_ADMISSIONS_KEY] = [admissionsReference('https://avvo.example/hale', ['FL', 'GA', 'MI']),
      admissionsReference('https://avvo.example/chandler', ['NJ', 'PA']), admissionsReference('https://avvo.example/moray', ['MO']),
      // A candidate nobody accepted says nothing about the firm.
      admissionsReference('https://avvo.example/unrelated', ['TX'])];
    const result = evaluateLayer1Evidence(evidence);
    expect(outsideBarState(result.preScore)).toEqual({ outside: 2, total: 14 });
    // In scope: 12, of which Hale, Stone and Fox are known Floridians and 9 are unknown: too unknown to compare.
    expect(result.signals.bar.B3_consistency).toBeNull();
    expect(result.preScore.flags).toContain(ATTORNEYS_OUTSIDE_FLORIDA);
  });

  it('counts an attorney in Florida when the site or Avvo names Florida among other states', () => {
    const evidence = multiState(undefined, { withStates: false });
    evidence.website!.provenance[AVVO_ADMISSIONS_KEY] = [admissionsReference('https://avvo.example/chandler', ['FL', 'NJ'])];
    const result = evaluateLayer1Evidence(evidence);
    expect(result.preScore.flags).not.toContain(ATTORNEYS_OUTSIDE_FLORIDA);
  });

  it('changes nothing for a Bar of no known state', () => {
    const evidence = { ...multiState(), barJurisdiction: null };
    const result = evaluateLayer1Evidence(evidence);
    expect(result.signals.bar.B3_consistency).toBeCloseTo(3 / 14);
    expect(result.preScore.flags).not.toContain(ATTORNEYS_OUTSIDE_FLORIDA);
  });

  it('does not flag attorneys outside Florida when the Bar gave nothing to score', () => {
    const evidence = multiState();
    evidence.sources.bar = { status: 'error', dataStatus: 'UNKNOWN', durationMs: 1, code: 'PROVIDER_ERROR' };
    expect(evaluateLayer1Evidence(evidence).preScore.flags).not.toContain(ATTORNEYS_OUTSIDE_FLORIDA);
  });
});

describe('state names and the references that carry them', () => {
  it.each([['Florida', 'FL'], ['FL', 'FL'], ['fl', 'FL'], ['Dist. of Columbia', 'DC'], ['District of Columbia', 'DC'],
    ['New York', 'NY'], ['West Virginia', 'WV'], ['Puerto Rico', null], ['Floridaa', null], ['', null]])('reads %s as %s', (value, code) => {
    expect(stateCode(value)).toBe(code);
  });

  it('finds every state named in a sentence, longest name first and once each', () => {
    expect(statesIn('licensed to practice law in Texas and Virginia')).toEqual(['TX', 'VA']);
    expect(statesIn('West Virginia, Virginia and Arkansas')).toEqual(['AR', 'VA', 'WV']);
    expect(statesIn('the District of Columbia and New York')).toEqual(['DC', 'NY']);
    expect(statesIn('Oklahoma since 1996')).toEqual(['OK']);
    expect(statesIn('a university degree')).toEqual([]);
  });

  it('writes and reads one reference per attorney, whatever order the states came in', () => {
    const reference = attorneyStatesReference('Jordan S. Hale', ['MI', 'FL', 'GA', 'FL'], 'https://harborlemon.example/team');
    expect(reference).toEqual({ sourceUrl: 'https://harborlemon.example/team', excerpt: 'Jordan S. Hale: FL, GA, MI', method: 'page_text' });
    const website = multiState().website!;
    const states = readAttorneyStates(website);
    expect(states.get('jordan s hale')).toEqual(new Set(['FL', 'GA', 'MI']));
    expect(states.get('edward l ewing')).toEqual(new Set(['MI']));
  });

  it('ignores a reference it cannot read', () => {
    const website = multiState().website!;
    website.provenance[ATTORNEY_STATES_KEY] = [{ sourceUrl: 'https://harborlemon.example/', excerpt: 'Jordan S. Hale: Florida', method: 'page_text' },
      { sourceUrl: 'https://harborlemon.example/', excerpt: null, method: 'page_text' }];
    expect(readAttorneyStates(website).size).toBe(0);
  });
});

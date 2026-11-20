import { describe, expect, it } from 'vitest';
import { unknownAttorney, unknownWebsite, type AttorneyMatch, type DirectorySource, type SourceResult } from '@arca/contracts';
import { ATTORNEYS_OUTSIDE_FLORIDA, outsideBarState } from '@arca/scoring';
import { avvoAdmissions } from '../../src/pipeline/directories.js';
import { InProcessPipeline } from '../../src/pipeline/in-process-pipeline.js';
import { InMemoryRepository } from '../../src/repositories/in-memory.js';

// Avvo actor rows as the actor returns them (fields trimmed to the ones read here). Synthetic people.
const row = (name: string, slug: string, admissions: Array<[string, string]>, extra: Record<string, unknown> = {}) => ({ name,
  profileUrl: `https://www.avvo.com/attorneys/${slug}.html`, firmName: 'Harbor Lemon Partners', avvoRating: 6.5, reviewsCount: 4,
  reviewsRating: 4.5, barAdmissions: admissions.map(([jurisdiction, since]) => ({ jurisdiction, since })), ...extra });
const raw = (queries: Array<{ target: string; items: unknown[] | null }>) => JSON.stringify({ queries, providerRuns: [] });
const accepted = (searchedName: string, slug: string): AttorneyMatch => ({ searchedName, matchConfidence: 'exact_name', ambiguous: false,
  attorney: { ...unknownAttorney(searchedName), profileUrl: `https://www.avvo.com/attorneys/${slug}.html` } });

describe('bar admissions of the Avvo profiles a lookup returned', () => {
  const content = raw([
    { target: 'Jay Chandler', items: [row('Jay W Chandler', '33160-fl-jay-chandler-1', [['New Jersey', '2013']]),
      row('Rebekah Chandler', '92679-ca-rebekah-chandler-2', [['California', '2023']])] },
    { target: 'Jordan Hale', items: [row('Jordan Hale', '33160-fl-jordan-hale-3', [['Florida', '2017'], ['Georgia', '2015'], ['Michigan', '1997']])] },
    { target: 'Gary Siegel', items: [row('Gary R Siegel', '20001-dc-gary-siegel-4', [['Dist. of Columbia', '1985'], ['Maryland', '1985']])] },
    { target: 'Nobody', items: null }]);

  it('keeps the admissions of the profiles the matches name, as state codes', () => {
    const matches = [accepted('Jay Chandler', '33160-fl-jay-chandler-1'), accepted('Jordan Hale', '33160-fl-jordan-hale-3'),
      { searchedName: 'Gary Siegel', matchConfidence: 'no_match' as const, ambiguous: false, attorney: null,
        candidates: [{ ...unknownAttorney('Gary R Siegel'), profileUrl: 'https://www.avvo.com/attorneys/20001-dc-gary-siegel-4.html' }] }];
    expect(avvoAdmissions(content, matches)).toEqual([
      { sourceUrl: 'https://www.avvo.com/attorneys/20001-dc-gary-siegel-4.html', excerpt: 'DC, MD', method: 'provider' },
      { sourceUrl: 'https://www.avvo.com/attorneys/33160-fl-jay-chandler-1.html', excerpt: 'NJ', method: 'provider' },
      { sourceUrl: 'https://www.avvo.com/attorneys/33160-fl-jordan-hale-3.html', excerpt: 'FL, GA, MI', method: 'provider' }]);
  });

  it('says nothing of a profile no match or candidate names, or without readable admissions', () => {
    expect(avvoAdmissions(content, [accepted('Someone Else', 'nowhere')])).toEqual([]);
    const odd = raw([{ target: 'Jay Chandler', items: [row('Jay W Chandler', 'jay', [['Puerto Rico', '2010']]),
      { name: 'No Admissions', profileUrl: 'https://www.avvo.com/attorneys/none.html' }, { error: 'No lawyers matched' }] }]);
    expect(avvoAdmissions(odd, [accepted('Jay Chandler', 'jay'), accepted('No Admissions', 'none')])).toEqual([]);
    expect(avvoAdmissions(null, [accepted('Jay Chandler', 'jay')])).toEqual([]);
    expect(avvoAdmissions('not json', [accepted('Jay Chandler', 'jay')])).toEqual([]);
    expect(avvoAdmissions(content, null)).toEqual([]);
  });
});

describe('the pipeline hands the Avvo admissions to scoring', () => {
  const names = ['Jordan Hale', 'Jay Chandler', 'Steven Moray', 'Ana Ruiz', 'Lee Park'];
  const website = { run: async () => ({ data: { ...unknownWebsite(), firm_name: 'Harbor Lemon Partners',
    team_members: names.map(full_name => ({ full_name, title: 'Attorney' })) }, rawContent: '{}',
    status: { status: 'ok' as const, dataStatus: 'PRESENT' as const, durationMs: 0, pagesCrawled: 3 } }) };
  const barMatch = (searchedName: string): AttorneyMatch => searchedName === 'Jordan Hale' || searchedName === 'Ana Ruiz' || searchedName === 'Lee Park'
    ? { searchedName, matchConfidence: 'exact', ambiguous: false, attorney: { ...unknownAttorney(searchedName), barNumber: searchedName,
      barStatus: 'active', admissionDate: '2010-01-01' } }
    : { searchedName, matchConfidence: 'no_match', ambiguous: false, attorney: null };
  const bar: DirectorySource = { jurisdiction: 'FL', run: async query => ({ data: query.names.map(barMatch), rawContent: null,
    status: { status: 'ok', dataStatus: 'PRESENT', durationMs: 0, attorneysSearched: query.names.length, attorneysFound: 3 } }) };
  const avvo = (content: string | null): DirectorySource => ({ run: async (): Promise<SourceResult<AttorneyMatch[]>> => ({
    data: [accepted('Jay Chandler', 'jay'), accepted('Steven Moray', 'moray')], rawContent: content,
    status: { status: 'ok', dataStatus: 'PRESENT', durationMs: 0, attorneysSearched: names.length, attorneysFound: 2 } }) });
  const scan = (content: string | null) => new InProcessPipeline({ repository: new InMemoryRepository(), website, bar, avvo: avvo(content) })
    .run({ scanId: 'sc_admissions', canonicalDomain: 'harborlemon.example', email: 'owner@harborlemon.example' });

  it('leaves out of the Bar rules the attorneys Avvo shows licensed only elsewhere', async () => {
    const result = (await scan(raw([{ target: 'Jay Chandler', items: [row('Jay W Chandler', 'jay', [['New Jersey', '2013'], ['Pennsylvania', '2014']])] },
      { target: 'Steven Moray', items: [row('Steven Moray', 'moray', [['Missouri', '2018']])] }]))).result;
    expect(result.preScore.flags).toContain(ATTORNEYS_OUTSIDE_FLORIDA);
    expect(outsideBarState(result.preScore)).toEqual({ outside: 2, total: 5 });
    expect(result.signals.bar.B3_consistency).toBe(1);
    expect(result.preScore.flags).not.toContain('LOW_BAR_CONSISTENCY');
  });

  it('scores every attorney as before when Avvo shows no admissions', async () => {
    const result = (await scan(null)).result;
    expect(result.preScore.flags).not.toContain(ATTORNEYS_OUTSIDE_FLORIDA);
    expect(result.signals.bar.B3_consistency).toBe(.6);
  });
});

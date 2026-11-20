import { describe, expect, it } from 'vitest';
import { attorneyStates } from '../../src/pipeline/attorney-states.js';
import type { CrawledPage } from '../../src/pipeline/crawler.js';

const ORIGIN = 'https://harborlemon.example';
const page = (path: string, text: string): CrawledPage => ({ url: `${ORIGIN}${path}`, html: '', text });
const team = (...names: string[]) => names.map(full_name => ({ full_name, title: 'Attorney' }));
const excerpts = (pages: CrawledPage[], names: string[]) => attorneyStates(pages, team(...names)).map(reference => reference.excerpt);

// The roster block of lemonlawgrouppartners.com as the crawler reads it: every card glued to the next one.
const ROSTER = 'Meet our attorneys\nJordan S. HaleManaging Partner FL · GA · MIMelinda MooreDirector of Litigation IL · NY · WI'
  + 'Mason FoxAttorney NY · CTMorgan BarrAttorney FLJeff ChaseAttorney OKJCJay ChandlerAttorney NJ · PA'
  + 'Edward L. Ewing Jr.Attorney MIBlake R. StoneAttorney FL · MN · MO · NM\nWho we are';

describe('the states the firm\'s own site shows for each attorney', () => {
  it('reads the states printed next to each name and title in a roster', () => {
    const names = ['Jordan S. Hale', 'Mason Fox', 'Morgan Barr', 'Jeff Chase', 'Jay Chandler', 'Edward L. Ewing Jr.', 'Blake R. Stone'];
    expect(excerpts([page('/attorney/jeff-chase/', ROSTER)], names)).toEqual(['Blake R. Stone: FL, MN, MO, NM',
      'Edward L. Ewing Jr.: MI', 'Jay Chandler: NJ, PA', 'Jeff Chase: OK', 'Jordan S. Hale: FL, GA, MI', 'Mason Fox: CT, NY',
      'Morgan Barr: FL']);
  });

  it('writes one reference per attorney, at the first page in a fixed order, whatever order the pages came in', () => {
    const pages = [page('/attorney/mason-fox/', ROSTER), page('/attorney/blake-stone/', ROSTER), page('/about/', 'About us')];
    const first = attorneyStates(pages, team('Mason Fox'));
    expect(first).toEqual([{ sourceUrl: `${ORIGIN}/attorney/blake-stone/`, excerpt: 'Mason Fox: CT, NY', method: 'page_text' }]);
    expect(attorneyStates([...pages].reverse(), team('Mason Fox'))).toEqual(first);
  });

  it('reads the licences an attorney\'s own profile page states in prose and as a list', () => {
    const profile = page('/attorney/adam-mott/', 'Adam Mott, Esq.\nMeet Adam\nAdam Mott is an associate attorney and is licensed '
      + 'to practice law in Texas and Virginia. He clerked for the Texas Attorney General.\n\nLicensed to Practice Law in:\n\n'
      + 'Texas — State Bar of Texas Card No. 24089038, admitted 2015\nVirginia — Virginia State Bar No. 99146, admitted 2023\n\n'
      + 'Directory profiles: Avvo');
    expect(excerpts([profile], ['Adam Mott'])).toEqual(['Adam Mott: TX, VA']);
    const list = page('/attorney/jeff-chase/', 'Jeff Chase\nLicensed to Practice Law in:\n\n'
      + 'Oklahoma — Oklahoma Bar Association No. 17195, admitted 1996 · OK bar record\n\nEducation: Oklahoma State University');
    expect(excerpts([list], ['Jeff Chase'])).toEqual(['Jeff Chase: OK']);
  });

  it.each([
    ['is a member of the Florida Bar and the State Bar of Georgia', 'FL, GA'],
    ['was admitted to the Florida Bar in 2009', 'FL'],
    ['Florida Bar No. 123456', 'FL'],
    ['Bar Admissions: New York, New Jersey and the District of Columbia', 'DC, NJ, NY'],
    ['admitted to practice in Florida and before the U.S. District Court for the Southern District of New York', 'FL'],
    ['is admitted in Ohio', 'OH'],
  ])('reads "%s" on the attorney\'s own page as %s', (sentence, states) => {
    expect(excerpts([page('/attorneys/dana-reyes', `Dana Reyes\n${sentence}.`)], ['Dana Reyes'])).toEqual([`Dana Reyes: ${states}`]);
  });

  it('reads nothing that only looks like a licence', () => {
    for (const sentence of ['admitted to practice before the United States District Court for the Middle District of Georgia',
      'is a member of the American Bar Association', 'graduated from the University of Florida', 'joined the firm in Tampa, FL',
      'admitted in 2011']) {
      expect(excerpts([page('/attorneys/dana-reyes', `Dana Reyes\n${sentence}.`)], ['Dana Reyes'])).toEqual([]);
    }
  });

  it('binds a profile\'s prose to the attorney its address names, not to anyone else on the page', () => {
    const profile = page('/attorney/adam-mott/', 'Adam Mott is licensed to practice law in Texas.\nAlso on our team: Dana Reyes.');
    expect(excerpts([profile], ['Adam Mott', 'Dana Reyes'])).toEqual(['Adam Mott: TX']);
    expect(excerpts([page('/our-team/', 'Adam Mott is licensed to practice law in Texas.')], ['Adam Mott'])).toEqual([]);
    expect(excerpts([page('/attorney/j-mason-dale-iii/', 'He is admitted in Alabama.')], ['J. Mason Dale III'])).toEqual(['J. Mason Dale III: AL']);
  });

  it('reads no state from a card without a role before it, or from words that are not states', () => {
    const pages = [page('/team/', 'Dana Reyes, PA\nMorgan Barr MD\nJeff ChaseParalegal and Office Manager ME\nMason FoxAttorney XY · NY')];
    expect(excerpts(pages, ['Dana Reyes', 'Morgan Barr', 'Jeff Chase', 'Mason Fox'])).toEqual([]);
  });

  it('reads nobody who is not on the firm\'s team', () => {
    expect(excerpts([page('/attorney/jeff-chase/', ROSTER)], ['Melinda Moore Jr.'])).toEqual([]);
    expect(attorneyStates([page('/attorney/jeff-chase/', ROSTER)], [])).toEqual([]);
  });
});

import type { CrawlResult } from '../../src/pipeline/crawler.js';

/**
 * Two live crawls of hklaw.com, ten minutes apart on 12 November 2026 (scans sc_182d1fef… and sc_06ae835f…), reduced
 * to what told them apart. Both read the same 20 URLs (the home page twice) with the same text, except one headline
 * in the site-wide "Latest News and Headlines" block, shown on the news index and on every press release: the site
 * retitled it between the two visits. The home page HTML also differed in a layout offset a script writes. Every
 * page keeps its real URL and title, the navigation every page shows and one line of its own; the full pages are
 * not committed.
 */
export const HKLAW_HEADLINE = {
  before: 'How Banks Can Prepare For Democrats Oversight Era',
  after: "How Banks Can Prepare for Democrats' Oversight Era",
};

const NAV = ['Skip to content', 'Practices', 'Professionals', 'Industries', 'Insights', 'Events', 'News', 'Offices', 'Careers'];
const FOOTER = ['© 2026 Holland & Knight LLP', 'Privacy Notice', 'Legal Information'];

type Page = { path: string; title: string; lines: string[]; latestNews?: boolean };
const PAGES: Page[] = [
  { path: '/en', title: 'Home | Holland & Knight', lines: ['2026 ELECTION INSIGHTS', 'Elections, Policy and What Comes Next'] },
  { path: '/en/careers', title: 'Careers | Holland & Knight', lines: ['Careers', 'Join a firm that invests in your growth.'] },
  { path: '/en/events', title: 'Events | Holland & Knight', lines: ['Events', 'Webinar: Year-End Tax Planning', 'NOVEMBER 18, 2026'] },
  { path: '/en/firm/client-payment-information', title: 'Client Payment Information | Holland & Knight',
    lines: ['Client Payment Information', 'Payments may be made by wire transfer or check.'] },
  { path: '/en/firm/legal', title: "Holland & Knight's Legal Information Portal | Holland & Knight",
    lines: ['Legal Information', 'Contact Information: hklegalinfo@hklaw.com'] },
  { path: '/en/firm/legal/privacy', title: 'Privacy | Holland & Knight',
    lines: ['Our Privacy Notice', 'GDPR Compliance', 'We process personal information of our clients to provide legal services.'] },
  { path: '/en/insights', title: 'Insights | Holland & Knight', lines: ['Insights', 'Embracing Statutes of Repose', 'NOVEMBER 12, 2026'] },
  { path: '/en/insights/publications/2026/03/2025-private-equity-year-in-review',
    title: '2025 Private Equity Year in Review | Insights | Holland & Knight', lines: ['MARCH 2026', '2025 Private Equity Year in Review'] },
  { path: '/en/insights/publications/2026/11/does-national-battery-leadership-strategy',
    title: "DOE's National Battery Leadership Strategy and the BattMan Accelerator: What You Need to Know | Insights | Holland & Knight",
    lines: ['NOVEMBER 12, 2026', "DOE's National Battery Leadership Strategy and the BattMan Accelerator: What You Need to Know"] },
  { path: '/en/insights/publications/2026/11/embracing-statutes-of-repose', title: 'Embracing Statutes of Repose | Insights | Holland & Knight',
    lines: ['NOVEMBER 12, 2026', 'Embracing Statutes of Repose'] },
  { path: '/en/insights/publications/2026/11/new-congress-new-scrutiny-oversight-risks',
    title: 'New Congress, New Scrutiny: Oversight Risks for Government Contractors – and How to Prepare | Insights | Holland & Knight',
    lines: ['NOVEMBER 12, 2026', 'New Congress, New Scrutiny: Oversight Risks for Government Contractors – and How to Prepare'] },
  { path: '/en/insights/publications/2026/11/private-equity-quarterly-report-third-quarter-2026-update',
    title: 'Private Equity Quarterly Report | Third Quarter 2026 Update | Insights | Holland & Knight',
    lines: ['THIRD QUARTER 2026', 'Private Equity Quarterly Report | Third Quarter 2026 Update'] },
  { path: '/en/news', title: 'News | Holland & Knight', latestNews: true,
    lines: ['News and Headlines', "Explore media coverage featuring Holland & Knight lawyers' legal insight and analysis."] },
  { path: '/en/news/pressreleases/2026/03/holland-knight-receives-outstanding-services-award-from-aba-military',
    title: 'Holland & Knight Receives Outstanding Services Award from the ABA Military Pro Bono Project for 14th Consecutive Year | News | Holland & Knight',
    latestNews: true, lines: ['PRESS RELEASE / MARCH 10, 2026'] },
  { path: '/en/news/pressreleases/2026/06/holland-knight-ranks-among-nations-leading-law-firms-chambers-usa-2026',
    title: "Holland & Knight Ranks Among Nation's Leading Law Firms in Chambers USA 2026 | News | Holland & Knight",
    latestNews: true, lines: ['PRESS RELEASE / JUNE 4, 2026'] },
  { path: '/en/news/pressreleases/2026/08/850-attorneys-recognized-by-the-best-lawyers-in-america-2027',
    title: 'More Than 850 Holland & Knight Attorneys Recognized by The Best Lawyers in America for 2027 | News | Holland & Knight',
    latestNews: true, lines: ['PRESS RELEASE / AUGUST 20, 2026'] },
  { path: '/en/news/pressreleases/2026/10/holland-and-knight-ranked-no-1-for-platform-strength-in-2026-law360',
    title: 'Holland & Knight Ranks No. 1 for Platform Strength in 2026 Law360 Pulse Leaderboard | News | Holland & Knight',
    latestNews: true, lines: ['PRESS RELEASE / OCTOBER 21, 2026'] },
  { path: '/en/services/industries', title: 'Industries | Holland & Knight',
    lines: ['Industries', "We are deeply engaged in our clients' industries, combining practical business insight."] },
  { path: '/en/services/practices', title: 'Practices | Holland & Knight',
    lines: ['Practices', "Explore Holland & Knight's comprehensive range of practices."] },
];

const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/'/g, '&#39;');

export type HklawVisit = { headline: string; heroOffset: string; edit?: (path: string, lines: string[]) => string[] };

/** One visit: the pages in the order the crawl stored them, the home page twice as it was. */
export function hklawCrawl(visit: HklawVisit): CrawlResult {
  const build = (page: Page) => {
    const own = visit.edit ? visit.edit(page.path, page.lines) : page.lines;
    const news = page.latestNews ? ['Latest News and Headlines', visit.headline, 'AMERICAN BANKER / IN THE HEADLINES / NOVEMBER 12, 2026'] : [];
    const html = `<html><head><title>${escape(page.title)}</title></head><body>` +
      `<nav>${NAV.slice(1).map(item => `<a href="/en/${item.toLowerCase()}">${item}</a>`).join('')}</nav>` +
      (page.path === '/en' ? `<div class="home-hero__wrapper" style="--home-hero-offset: ${visit.heroOffset};"></div>` : '') +
      own.map(line => `<p>${escape(line)}</p>`).join('') +
      (page.latestNews ? `<h2>Latest News and Headlines</h2><a href="/en/news/intheheadlines/2026/11/how-banks-can-prepare-for-democrats-oversight-era">` +
        `<h3>${escape(visit.headline)}</h3></a>` : '') +
      `<footer><a href="/en/firm/legal/privacy">Privacy Notice</a><a href="/en/firm/legal">Legal Information</a></footer></body></html>`;
    return { url: `https://hklaw.com${page.path}`, html, text: [...NAV, ...own, ...news, ...FOOTER].join('\n') };
  };
  return { partial: false, pages: [build(PAGES[0]!), ...PAGES.map(build)] };
}

/** The first visit, then the second, ten minutes later. */
export const HKLAW_VISITS: [HklawVisit, HklawVisit] = [
  { headline: HKLAW_HEADLINE.before, heroOffset: '145.414px' },
  { headline: HKLAW_HEADLINE.after, heroOffset: '147.435px' },
];

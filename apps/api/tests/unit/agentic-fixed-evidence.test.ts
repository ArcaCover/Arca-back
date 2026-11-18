import { describe, expect, it, vi } from 'vitest';
import { AgenticEvidenceProvider, FIXED_FETCH_LIMIT, fixedTargets, floridaOfficeCities } from '../../src/pipeline/agentic-evidence-provider.js';
import type { CrawledPage } from '../../src/pipeline/crawler.js';

// A synthetic large firm. URLs and short texts only, written for these tests.
const ORIGIN = 'https://bigfirm.com';
const reply = (body: unknown) => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(body) } }] });
const finish = { type: 'finish', reason: 'done' };
const segmentId = (user: string, url: string, text: string) => user.split('\n\n')
  .find(block => block.includes(`URL=${url} `) && block.includes(text))?.match(/^\[([^\]]+)\]/)?.[1] ?? 'missing';
const claim = (id: string, field: string, value: unknown, citations: Array<{ segmentId: string; quote: string }>) =>
  ({ id, field, value, explanation: 'stated on the page', citations });
const person = (name: string, title: string) => [{ full_name: name, title, role: 'attorney', affiliation: 'current' }];

const home: CrawledPage = { url: `${ORIGIN}/en`, text: 'Big Firm is a global law firm with approximately 2,200 attorneys.',
  html: ['<a href="/en/general-pages/firm-artificial-intelligence-navigator">Explore the Navigator</a>',
    '<a href="/en/professionals">Professionals</a>', '<a href="/en/offices">Offices</a>', '<a href="/en/offices/tampa">Tampa</a>',
    '<a href="/en/insights/2026/11/ten-ways-ai-labs-limit-risk">Ten ways AI labs limit risk</a>',
    '<a href="/en/services/practices/artificial-intelligence">AI practice</a>'].join('') };
const news: CrawledPage = { url: `${ORIGIN}/en/news/pressreleases/2026/03/award`, html: '',
  text: 'Partner Jane Doe and Partner John Roe received an award from the bar association.' };
const unread: Record<string, CrawledPage> = {
  [`${ORIGIN}/en/general-pages/firm-artificial-intelligence-navigator`]: { url: `${ORIGIN}/en/general-pages/firm-artificial-intelligence-navigator`,
    html: '', text: 'Big Firm uses generative AI tools for client work under an AI governance policy approved by the firm.' },
  [`${ORIGIN}/en/innovation`]: { url: `${ORIGIN}/en/innovation`, html: '', text: 'Innovation at Big Firm.' },
  [`${ORIGIN}/en/professionals`]: { url: `${ORIGIN}/en/professionals`, html: '', text: 'Search our professionals by name.' },
  [`${ORIGIN}/en/offices`]: { url: `${ORIGIN}/en/offices`,
    html: '<a href="/en/offices/miami">Miami</a><a href="/en/offices/tampa">Tampa</a><a href="/en/offices/london">London</a>',
    text: 'Miami\n701 Brickell Avenue, Miami, FL 33131\nTampa\nLondon\nOrlando, Florida' },
};
const sitemap = [{ url: `${ORIGIN}/en/innovation`, kind: 'page' as const },
  { url: `${ORIGIN}/en/events/2025/02/a-conversation-about-generative-ai`, kind: 'page' as const }];

const site = () => {
  const order: string[] = [];
  return { order, access: {
    readSitemap: vi.fn(async () => { order.push('read_sitemap'); return { links: sitemap,
      calls: [{ tool: 'read_sitemap' as const, target: `${ORIGIN}/`, status: 'read' as const, detail: `${sitemap.length} urls` }] }; }),
    fetchPages: vi.fn(async (urls: string[]) => { order.push(`fetch ${urls.join(',')}`);
      return { pages: urls.flatMap(url => unread[url] ? [unread[url]!] : []),
        calls: urls.map(target => ({ tool: 'fetch_pages' as const, target, status: unread[target] ? 'read' as const : 'failed' as const,
          detail: unread[target] ? null : 'HTTP_404' })) }; }),
    readDocuments: vi.fn(async () => ({ pages: [], calls: [] })),
  } };
};

/** A model that labels pages by URL, supports every claim on review and answers each extraction round with `round`. */
const model = (round: (user: string, index: number) => unknown, types: (url: string) => string = () => 'other',
  order: string[] = []) => {
  let rounds = 0;
  return vi.fn(async (request: Record<string, unknown>) => {
    const [system, user] = (request.messages as Array<{ content: string }>).map(message => message.content) as [string, string];
    if (system.startsWith('Classify pages')) {
      return reply({ pages: [...user.matchAll(/\[(C\d+)\] (?:PAGE|DOCUMENT) (?:READ|LINK) (\S+)/g)].map(([, id, url]) => ({ id, type: types(url!) })) });
    }
    if (user.startsWith('CANDIDATE CLAIMS')) {
      const claims = JSON.parse(user.slice('CANDIDATE CLAIMS\n'.length, user.indexOf('\n\nSNAPSHOT'))) as Array<{ id: string; citations: unknown[] }>;
      return reply({ verdicts: claims.map(item => ({ claimId: item.id, verdict: 'supported', reason: 'ok', citations: item.citations })) });
    }
    if (system.includes('This pass is only for attorneys')) return reply({ claims: [], action: finish });
    order.push('extract-round');
    return reply(round(user, rounds++));
  });
};

describe('fixed evidence steps before the claim rounds', () => {
  it('reads the sitemap, the AI, people and offices pages and searches them before the first round, without one model call more', async () => {
    const { access, order } = site();
    let firstRound = '';
    const create = model((user, index) => {
      if (index === 0) firstRound = user;
      return { claims: [claim('count', 'attorney_count', 2200, [{ segmentId: segmentId(user, `${ORIGIN}/en`, '2,200'), quote: 'approximately 2,200 attorneys' }])],
        action: finish };
    }, undefined, order);
    const provider = new AgenticEvidenceProvider('key', undefined, { chat: { completions: { create } } }, access as never);
    const result = await provider.extractDetailed({ pages: [home, news], partial: false }, new AbortController().signal);

    expect(order).toEqual(['read_sitemap', `fetch ${[`${ORIGIN}/en/innovation`, `${ORIGIN}/en/general-pages/firm-artificial-intelligence-navigator`,
      `${ORIGIN}/en/professionals`, `${ORIGIN}/en/offices`].join(',')}`, 'extract-round']);
    const fixed = result.diagnostics.toolCalls.filter(call => call.round === 0);
    expect(fixed.map(call => [call.tool, call.status])).toEqual([['read_sitemap', 'read'], ['fetch_pages', 'read'], ['fetch_pages', 'read'],
      ['fetch_pages', 'read'], ['fetch_pages', 'read'], ['find_in_site', 'read']]);
    // The firm's own AI page reaches the model, ahead of the passages news pages mention AI in.
    expect(firstRound).toContain('under an AI governance policy approved by the firm');
    expect(firstRound).toMatch(/KIND=search\nBig Firm uses generative AI tools/);
    expect(firstRound).toContain('TOOL HISTORY\nround 0 read_sitemap');
    // Only the calls the extraction always made: three votes, one round, the roster of the people page and one review.
    expect(result.diagnostics.attempts.map(attempt => attempt.phase).sort())
      .toEqual(['classify-pages-1', 'classify-pages-2', 'classify-pages-3', 'extract-roster', 'extract-round-1', 'review-general']);
    // What the backend read decides the directory scope, not the model.
    expect(result.websiteData.provenance.florida_office_cities?.map(item => item.excerpt).sort()).toEqual(['Miami', 'Orlando', 'Tampa']);
    expect(result.websiteData.provenance.large_firm).toEqual([{ sourceUrl: `${ORIGIN}/en`, excerpt: 'approximately 2,200 attorneys', method: 'provider' }]);
  });

  it('gathers the same evidence whatever tools the model asks for afterwards', async () => {
    const run = async (round: (user: string, index: number) => unknown) => {
      const { access } = site();
      const provider = new AgenticEvidenceProvider('key', undefined, { chat: { completions: { create: model(round) } } }, access as never);
      const result = await provider.extractDetailed({ pages: [home, news], partial: false }, new AbortController().signal);
      return { calls: result.diagnostics.toolCalls, access };
    };
    const quiet = await run(() => ({ claims: [], action: finish }));
    const curious = await run((_user, index) => index === 0 ? { claims: [], action: { type: 'read_sitemap', targetFields: ['attorneys'], reason: 'map' } }
      : { claims: [], action: finish });
    expect(curious.calls.filter(call => call.round === 0)).toEqual(quiet.calls.filter(call => call.round === 0));
    // The sitemap is read once per scan: the model's own request finds it done.
    expect(curious.access.readSitemap).toHaveBeenCalledTimes(1);
    expect(curious.calls.find(call => call.round === 1)).toMatchObject({ tool: 'read_sitemap', status: 'skipped', detail: 'ALREADY_READ' });
  });

  it('records the Florida offices and the stated size even when the page plan reads nothing', async () => {
    const { access } = site();
    const provider = new AgenticEvidenceProvider('key', undefined,
      { chat: { completions: { create: model(() => ({ claims: [], action: finish })) } } }, access as never);
    const result = await provider.extractDetailed({ pages: [home], partial: false }, new AbortController().signal);
    expect(result.websiteData.provenance.florida_office_cities?.map(item => item.excerpt).sort()).toEqual(['Miami', 'Orlando', 'Tampa']);
    expect(result.websiteData.provenance.large_firm).toBeUndefined();
  });
});

describe('fixed targets', () => {
  const links = (urls: string[]) => urls.map(url => ({ url, kind: 'page' as const }));
  it('takes the AI pages first, then one people directory and one offices page, within the limit', () => {
    expect(FIXED_FETCH_LIMIT).toBe(4);
    const targets = fixedTargets(links([`${ORIGIN}/en/offices`, `${ORIGIN}/en/offices/miami`, `${ORIGIN}/en/professionals/d/doe-jane`,
      `${ORIGIN}/en/people`, `${ORIGIN}/en/professionals`, `${ORIGIN}/ai`, `${ORIGIN}/en/responsible-ai-governance`,
      `${ORIGIN}/en/innovation`, `${ORIGIN}/en/services/artificial-intelligence`]), new Set());
    expect(targets).toEqual([`${ORIGIN}/ai`, `${ORIGIN}/en/innovation`, `${ORIGIN}/en/people`, `${ORIGIN}/en/offices`]);
  });
  it('skips news, events and corporate governance, and what was read or failed already', () => {
    expect(fixedTargets(links([`${ORIGIN}/en/news/2026/ai-award`, `${ORIGIN}/en/events/2025/02/generative-ai`,
      `${ORIGIN}/en/insights/publications/ai-rules`, `${ORIGIN}/en/services/corporate-governance`, `${ORIGIN}/blog/ai-tips`]), new Set())).toEqual([]);
    expect(fixedTargets(links([`${ORIGIN}/en/offices`, `${ORIGIN}/en/people/`, `${ORIGIN}/en/innovation`]),
      new Set([`${ORIGIN}/en/offices`, `${ORIGIN}/en/people`]))).toEqual([`${ORIGIN}/en/innovation`]);
  });
  it('never takes a careers page for the people directory', () => {
    expect(fixedTargets(links([`${ORIGIN}/en/careers/attorneys`, `${ORIGIN}/en/careers/professionals`]), new Set())).toEqual([]);
    expect(fixedTargets(links([`${ORIGIN}/careers/attorneys`, `${ORIGIN}/en/professionals`]), new Set()))
      .toEqual([`${ORIGIN}/en/professionals`]);
  });
  it('keeps a practice page about AI as the last resort for an AI slot', () => {
    expect(fixedTargets(links([`${ORIGIN}/en/services/artificial-intelligence`]), new Set())).toEqual([`${ORIGIN}/en/services/artificial-intelligence`]);
  });
});

describe('Florida office cities', () => {
  it('reads them from office links and from a city named with its state, and nothing abroad or in another state', () => {
    const offices: CrawledPage = { url: `${ORIGIN}/offices`, html: ['<a href="/offices/fort-lauderdale">Fort Lauderdale</a>',
      '<a href="/offices/london">London</a>', '<a href="/offices/melbourne">Melbourne</a>', '<a href="/offices/west-palm-beach">West Palm Beach</a>'].join(''),
      text: 'Atlanta, GA\nNaples, Florida 34102\nCoral Gables, FL' };
    const cities = floridaOfficeCities([offices], [{ url: `${ORIGIN}/offices/tampa`, kind: 'page' }]);
    expect(cities.map(item => item.city).sort()).toEqual(['Coral Gables', 'Fort Lauderdale', 'Naples', 'Tampa', 'West Palm Beach']);
    expect(cities.find(item => item.city === 'Tampa')).toMatchObject({ sourceUrl: `${ORIGIN}/offices/tampa`, method: 'derived' });
    expect(cities.find(item => item.city === 'Fort Lauderdale')).toMatchObject({ sourceUrl: `${ORIGIN}/offices/fort-lauderdale`, method: 'page_text' });
    expect(cities.find(item => item.city === 'Naples')).toMatchObject({ sourceUrl: `${ORIGIN}/offices`, method: 'page_text' });
  });
  it('reads no city from a page that is not about offices', () => {
    expect(floridaOfficeCities([{ url: `${ORIGIN}/news/2026/award`, html: '', text: 'The award was presented in Tampa, FL.' }], [])).toEqual([]);
  });
});

describe('where attorney names come from', () => {
  const profile: CrawledPage = { url: `${ORIGIN}/en/bio/jane-doe`, html: '', text: 'Jane Doe\nPartner\nJane Doe advises companies.' };
  const types = (url: string) => url.includes('/bio/') ? 'profile' : url.includes('/news/') ? 'blog' : 'other';
  const noFixed = { readSitemap: vi.fn(async () => ({ links: [], calls: [] })), fetchPages: vi.fn(async () => ({ pages: [], calls: [] })),
    readDocuments: vi.fn(async () => ({ pages: [], calls: [] })) };

  it('drops names cited only from news pages when a profile page names attorneys', async () => {
    const create = model(user => ({ claims: [
      claim('jane', 'attorneys', person('Jane Doe', 'Partner'), [{ segmentId: segmentId(user, profile.url, 'Jane Doe'), quote: 'Jane Doe\nPartner' }]),
      claim('john', 'attorneys', person('John Roe', 'Partner'), [{ segmentId: segmentId(user, news.url, 'John Roe'), quote: 'Partner John Roe' }]),
    ], action: finish }), types);
    const provider = new AgenticEvidenceProvider('key', undefined, { chat: { completions: { create } } }, noFixed as never);
    const result = await provider.extractDetailed({ pages: [home, news, profile], partial: false }, new AbortController().signal);
    expect(result.websiteData.team_members).toEqual([{ full_name: 'Jane Doe', title: 'Partner' }]);
    expect(result.websiteData.provenance.team_members_news_only).toBeUndefined();
    expect(result.diagnostics.attorneySource).toBe('roster');
  });

  it('keeps names cited only from news pages when nothing else names attorneys, and marks them', async () => {
    const create = model(user => ({ claims: [
      claim('jane', 'attorneys', person('Jane Doe', 'Partner'), [{ segmentId: segmentId(user, news.url, 'Jane Doe'), quote: 'Partner Jane Doe' }]),
    ], action: finish }), types);
    const provider = new AgenticEvidenceProvider('key', undefined, { chat: { completions: { create } } }, noFixed as never);
    const result = await provider.extractDetailed({ pages: [home, news], partial: false }, new AbortController().signal);
    expect(result.websiteData.team_members).toEqual([{ full_name: 'Jane Doe', title: 'Partner' }]);
    expect(result.websiteData.provenance.team_members_news_only).toEqual([{ sourceUrl: news.url, excerpt: 'Partner Jane Doe', method: 'provider' }]);
    expect(result.diagnostics.attorneySource).toBe('news_only');
  });

  it('never reads a press release as a team page, even when its address says attorneys', async () => {
    const release: CrawledPage = { url: `${ORIGIN}/en/news/pressreleases/2026/08/850-attorneys-recognized`, html: '',
      text: 'Partner Jane Doe was recognized.' };
    const create = model(() => ({ claims: [], action: finish }), types);
    const provider = new AgenticEvidenceProvider('key', undefined, { chat: { completions: { create } } }, noFixed as never);
    const result = await provider.extractDetailed({ pages: [home, release], partial: false }, new AbortController().signal);
    expect(result.diagnostics.attempts.some(attempt => attempt.phase.startsWith('extract-roster'))).toBe(false);
  });
});

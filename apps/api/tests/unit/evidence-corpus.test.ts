import { describe, expect, it } from 'vitest';
import { buildCorpus, corpusFingerprint, normalizeForGrounding } from '../../src/pipeline/evidence-corpus.js';
import type { CrawlResult } from '../../src/pipeline/crawler.js';
import { HKLAW_VISITS, hklawCrawl } from '../fixtures/hklaw-recrawl.js';

describe('evidence corpus', () => {
  const page = (url: string, text: string) => ({ url, text, html: `<title>Firm &amp; Co</title><body>${text}</body>` });
  it('keeps document-derived IDs stable when another page is inserted', () => {
    const a = buildCorpus({ pages: [page('https://firm.com/team', 'Jane Doe Attorney')], partial: false });
    const b = buildCorpus({ pages: [page('https://firm.com/about', 'About'), page('https://firm.com/team', 'Jane Doe Attorney')], partial: false });
    expect(b.segments.find(segment => segment.url.endsWith('/team'))?.id).toBe(a.segments.find(segment => segment.url.endsWith('/team'))?.id);
  });
  it('extracts metadata and same-domain link IDs while enforcing the budget', () => {
    const corpus = buildCorpus({ pages: [{ url: 'https://firm.com/', text: 'A'.repeat(200),
      html: '<title>Firm &amp; Co</title><a href="/team">Team</a><a href="https://other.com">Other</a>' }], partial: false }, 40);
    expect(corpus.segments.some(segment => segment.text === 'Firm & Co')).toBe(true);
    expect(corpus.links).toHaveLength(1);
    expect(corpus.truncated).toBe(true);
  });
  it('preserves accents and negation while normalizing presentation spaces', () => {
    expect(normalizeForGrounding('No   usamos  IA')).toBe('No usamos IA');
    expect(normalizeForGrounding('inmigración')).not.toBe(normalizeForGrounding('inmigracion'));
  });
  it('offers PDFs as documents and drops links the crawler cannot read', () => {
    const corpus = buildCorpus({ pages: [{ url: 'https://firm.com/', text: 'Home', html:
      '<a href="/team">Team</a><a href="/files/Policy.pdf">Privacy</a><a href="/logo.png">Logo</a><a href="mailto:a@firm.com">Mail</a>' }],
    partial: false });
    expect(corpus.links.map(link => [new URL(link.url).pathname, link.kind])).toEqual([['/team', 'page'], ['/files/Policy.pdf', 'document']]);
  });
  it('keeps a complete document whole and records its completeness', () => {
    const text = 'Privacy Policy\n' + 'Clause. '.repeat(1200);
    const corpus = buildCorpus({ pages: [{ url: 'https://firm.com/policy.pdf', html: '', text, kind: 'document', complete: true }], partial: false });
    expect(corpus.segments.every(segment => segment.kind === 'document')).toBe(true);
    expect(corpus.documents).toEqual([{ url: 'https://firm.com/policy.pdf', complete: true, chars: expect.any(Number) }]);
    // Segments are cut every 800 characters, sometimes mid-word, so compare content without whitespace.
    expect(corpus.segments.map(segment => segment.text).join('').replace(/\s+/g, '')).toBe(text.replace(/\s+/g, ''));
  });
  const longPage = (url: string, paragraphs: number) => ({ url, html: '',
    text: Array.from({ length: paragraphs }, (_, i) => `${url} paragraph ${i} ${'detail '.repeat(90)}`).join('\n\n') });
  it('keeps the about page ahead of a low-value page the agent requested', () => {
    const corpus = buildCorpus({ pages: [longPage('https://firm.com/about', 3), { ...longPage('https://firm.com/blog', 3), requested: true }],
      partial: false }, 2_100);
    expect(corpus.segments.some(segment => segment.url === 'https://firm.com/about')).toBe(true);
    expect(corpus.omittedUrls).toContain('https://firm.com/blog');
  });
  it('includes a page the agent requested before pages the crawler found', () => {
    const corpus = buildCorpus({ pages: [longPage('https://firm.com/practice-a', 3), longPage('https://firm.com/practice-b', 3),
      { url: 'https://firm.com/carmen-gallardo', html: '', text: `Carmen Gallardo, Esq. Founding Partner. ${'Biography '.repeat(70)}`, requested: true }],
    partial: false }, 2_000);
    expect(corpus.segments.some(segment => segment.url === 'https://firm.com/carmen-gallardo')).toBe(true);
  });
});

// DN-12 §4.3: the fingerprint names the evidence a stored analysis may stand in for. It must not move when only the
// site's furniture moves, and must move when the firm's own pages say something else.
describe('corpus fingerprint', () => {
  const [first, second] = HKLAW_VISITS;
  const edited = (edit: (path: string, lines: string[]) => string[]) => corpusFingerprint(hklawCrawl({ ...first, edit }));
  const base = corpusFingerprint(hklawCrawl(first));
  it('is the same for the two hklaw.com crawls that differed only in a retitled news headline', () => {
    expect(corpusFingerprint(hklawCrawl(second))).toBe(base);
  });
  it('does not depend on the order the crawl stored its pages in', () => {
    const crawl = hklawCrawl(first);
    expect(corpusFingerprint({ ...crawl, pages: [...crawl.pages].reverse() })).toBe(base);
  });
  it('changes when a page that is not news says something else', () => {
    expect(edited((path, lines) => path === '/en/firm/legal/privacy'
      ? [...lines, 'We use generative AI tools to review client documents.'] : lines)).not.toBe(base);
    expect(edited((path, lines) => path === '/en/services/practices'
      ? lines.map(line => line.replace('comprehensive', 'focused')) : lines)).not.toBe(base);
  });
  it('changes when a page is added or removed', () => {
    const crawl = hklawCrawl(first);
    const added = { ...crawl, pages: [...crawl.pages, { url: 'https://hklaw.com/en/firm/ai-policy', html: '<title>AI Policy</title>',
      text: 'Our policy on artificial intelligence.' }] };
    expect(corpusFingerprint(added)).not.toBe(base);
    const removed = { ...crawl, pages: crawl.pages.filter(page => !page.url.endsWith('/en/careers')) };
    expect(corpusFingerprint(removed)).not.toBe(base);
    // A news page counts too: its address and title are part of what the crawl read.
    const lessNews = { ...crawl, pages: crawl.pages.filter(page => !page.url.endsWith('-2026-law360')) };
    expect(corpusFingerprint(lessNews)).not.toBe(base);
  });
  it('reads only the title of a news, insight, event or blog page, never its body', () => {
    expect(edited((path, lines) => path.startsWith('/en/insights/publications/2026/11/embracing')
      ? [...lines, 'A paragraph the firm rewrote.'] : lines)).toBe(base);
    expect(edited((path, lines) => path === '/en/events' ? ['Events', 'Webinar: Q1 Outlook', 'JANUARY 8, 2027'] : lines)).toBe(base);
    const crawl = hklawCrawl(first), retitled = { ...crawl, pages: crawl.pages.map(page => page.url.endsWith('embracing-statutes-of-repose')
      ? { ...page, html: page.html.replace('Embracing Statutes of Repose |', 'Statutes of Repose, Revisited |') } : page) };
    expect(corpusFingerprint(retitled)).not.toBe(base);
  });
  const firm = (block: string[], on: string[]): CrawlResult => ({ partial: false, pages: ['/', '/about', '/team', '/contact'].map(path => ({
    url: `https://firm.com${path}`, html: `<title>Smith Law${path}</title>`,
    text: [`Smith Law ${path} page.`, ...(on.includes(path) ? block : [])].join('\n') })) });
  it('ignores a block every page repeats, and keeps one only two pages show', () => {
    const everywhere = ['/', '/about', '/team'], twice = ['/', '/about'];
    expect(corpusFingerprint(firm(['Latest: Firm wins award'], everywhere))).toBe(corpusFingerprint(firm(['Latest: Firm wins case'], everywhere)));
    expect(corpusFingerprint(firm(['Latest: Firm wins award'], twice))).not.toBe(corpusFingerprint(firm(['Latest: Firm wins case'], twice)));
  });
  it('reads quotes, apostrophes, case and spacing as the same text', () => {
    const page = (text: string): CrawlResult => ({ partial: false, pages: [{ url: 'https://firm.com/about', html: '', text }] });
    expect(corpusFingerprint(page('Smith’s  firm — “Trusted” since 2001'))).toBe(corpusFingerprint(page("smiths firm - 'trusted' since 2001")));
    expect(corpusFingerprint(page('Smith firm, trusted since 2001'))).not.toBe(corpusFingerprint(page('Smith firm, trusted since 2011')));
  });
});

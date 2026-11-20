import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { unknownWebsite } from '@arca/contracts';
import { buildCorpus, corpusFingerprint } from '../../src/pipeline/evidence-corpus.js';
import type { CrawledPage, CrawlResult } from '../../src/pipeline/crawler.js';
import { STORED_HTML_MAX_CHARS, STORED_PAGES_MAX_CHARS, STORED_PAGE_FORMAT, STORED_TEXT_MAX_CHARS, readableHtml, storedPages }
  from '../../src/pipeline/stored-pages.js';
import { WebsiteExtractionSource } from '../../src/pipeline/website-source.js';
import { InMemoryRepository } from '../../src/repositories/in-memory.js';

// The shape of lemonlawgrouppartners.com's pages (2026-11-18): ~700 KB of HTML each, nearly all of it inline scripts,
// styles, SVG icons and data URIs, around a mega menu of ~360 links every page repeats and ~12 KB of visible text. The
// raw record of the 19 pages crawled was 13.9 MB. Synthetic content, same proportions.
const DOMAIN = 'harborlemon.example';
const STATES = ['alabama', 'california', 'colorado', 'connecticut', 'florida', 'georgia', 'illinois', 'indiana', 'iowa'];
const menu = Array.from({ length: 360 }, (_, i) => `<li class="menu-item menu-item-type-post_type elementor-item-${i}">` +
  `<a class="elementor-item elementor-item-anchor" data-id="${i}" href="https://${DOMAIN}/${STATES[i % STATES.length]}-lemon-law-attorney/${i}/">` +
  `<span class="elementor-icon"><svg viewBox="0 0 10 10"><title>Arrow</title><path d="M0 0L10 5L0 10z"/></svg></span>` +
  `<span>${STATES[i % STATES.length]} lemon law ${i}</span></a></li>`).join('\n');
function heavyPage(path: string, index: number): CrawledPage {
  const text = Array.from({ length: 120 }, (_, line) => `Line ${line} of ${path}: our attorneys help drivers in ${STATES[line % STATES.length]}.`).join('\n');
  const faq = JSON.stringify({ '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: Array.from({ length: 30 }, (_, i) =>
    ({ '@type': 'Question', name: `Question ${i}?`, acceptedAnswer: { '@type': 'Answer', text: `Answer ${i} for ${path}.` } })) });
  const html = `<!DOCTYPE html><html lang="en-US"><head><meta charset="UTF-8"><title>${path} | Harbor Lemon Partners</title>
<meta name="description" content="Lemon law help for ${path}"><meta property="og:site_name" content="Harbor Lemon Partners">
<link rel="stylesheet" href="https://${DOMAIN}/style.css?v=${index}">
<style id="inline-css">${'.elementor-element{margin:0;padding:0;color:#123456}\n'.repeat(4_000)}</style>
<script>window.__data=${JSON.stringify({ nonce: index, blob: 'x'.repeat(300_000) })};</script>
<script type="application/ld+json">${faq}</script>
<!-- rendered ${new Date(Date.UTC(2026, 10, 18, 0, index)).toISOString()} -->
</head><body class="page-template">
<nav><ul>${menu}</ul></nav>
<img alt="logo" src="data:image/png;base64,${'iVBORw0KGgo'.repeat(5_000)}">
<svg class="divider">${'<path d="M0 0h100v1H0z"/>'.repeat(1_500)}</svg>
<main><h1>Lemon law attorneys: ${path}</h1><p>${text.replaceAll('\n', '</p><p>')}</p>
<a href="/attorney/jeff-chase/">Jeff Chase</a><a href="tel:+18885550610">Call</a><a href="#top">Top</a></main>
<noscript><img src="https://tracker.example/pixel.gif"></noscript></body></html>`;
  return { url: `https://${DOMAIN}${path}`, html, text };
}
const PATHS = ['/', '/about/', '/accessibility-statement/', ...STATES.map(state => `/${state}-lemon-law-attorney/`), '/contact/', '/faq/',
  '/locations/', '/privacy-policy/', '/your-privacy-choices/', '/attorney/jeff-chase/', '/attorney/adam-mott/'];
const heavyCrawl = (): CrawlResult => ({ pages: PATHS.map(heavyPage), partial: false });
const comparable = (crawl: CrawlResult) => {
  const corpus = buildCorpus(crawl);
  return { segments: corpus.segments.map(segment => [segment.url, segment.kind, segment.text]),
    links: corpus.links.map(link => [link.url, link.label, link.kind, link.sourceUrl]), truncated: corpus.truncated };
};
const bytes = (value: unknown) => Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value));

describe('website pages as the raw record stores them (DN-12 §15.5)', () => {
  it('keeps of the HTML only what the backend reads: title, first heading, metadata, JSON-LD and links', () => {
    const html = `<html><head><title>Smith &amp; Doe Law</title><meta name="description" content="Family law">
<script>var a = 1;</script><style>a{color:red}</style>
<script type="application/ld+json">{"@type":"LegalService","name":"Smith & Doe"}</script><!-- rendered at 10:10 --></head>
<body><svg><title>Icon</title></svg><h1>Welcome</h1><h1>Second</h1>
<a data-href="/not-this" href="/team" class="nav"><span>Our <b>team</b></span><svg><title>Arrow</title></svg></a>
<a href="/logo"><img src="data:image/png;base64,AAAA" alt="Logo"></a>
<a href="#top">Top</a><img src="data:image/png;base64,BBBB"><p>Body text</p></body></html>`;
    const read = readableHtml(html);
    expect(read).toContain('<title>Smith &amp; Doe Law</title>');
    expect(read).toContain('<h1>Welcome</h1>');
    expect(read).not.toContain('Second');
    expect(read).toContain('<meta name="description" content="Family law">');
    expect(read).toContain('<script type="application/ld+json">{"@type":"LegalService","name":"Smith & Doe"}</script>');
    expect(read).toContain('<a href="/team">');
    expect(read).toContain('<a href="/logo">');
    for (const gone of ['var a', 'color:red', 'rendered at', 'data:image', 'AAAA', 'Body text', 'class="nav"', '/not-this', '#top']) {
      expect(read).not.toContain(gone);
    }
    // The same reading: the corpus and the reuse key see the same title, metadata, JSON-LD and links.
    const page = { url: 'https://firm.example/', html, text: 'Body text' };
    const stored = { ...page, html: read };
    expect(comparable({ pages: [stored], partial: false })).toEqual(comparable({ pages: [page], partial: false }));
    expect(corpusFingerprint({ pages: [stored], partial: false })).toBe(corpusFingerprint({ pages: [page], partial: false }));
  });

  it('stores the lemonlaw-shaped crawl in well under 2 MB, read the same way as the full HTML', () => {
    const crawl = heavyCrawl();
    const full = bytes(crawl.pages);
    const stored = storedPages(crawl.pages);
    expect(full).toBeGreaterThan(12_000_000);
    expect(bytes(stored)).toBeLessThan(STORED_PAGES_MAX_CHARS);
    const read = { pages: stored.map(page => ({ url: page.url, html: page.html, text: page.text })), partial: false };
    expect(stored.every(page => !page.truncated)).toBe(true);
    expect(corpusFingerprint(read)).toBe(corpusFingerprint(crawl));
    expect(comparable(read)).toEqual(comparable(crawl));
    expect(stored[0]).toMatchObject({ url: `https://${DOMAIN}/`, text: crawl.pages[0]!.text, htmlChars: crawl.pages[0]!.html.length });
  });

  it('bounds each page and the whole record, cutting between whole fragments and saying so', () => {
    const links = Array.from({ length: 4_000 }, (_, i) => `<a href="/page-${i}">Page ${i}</a>`).join('');
    const big: CrawledPage = { url: 'https://firm.example/', html: `<title>Big</title>${links}`, text: 'T'.repeat(STORED_TEXT_MAX_CHARS + 10) };
    const [page] = storedPages([big]);
    expect(page!.html.length).toBeLessThanOrEqual(STORED_HTML_MAX_CHARS);
    expect(page!.html.startsWith('<title>Big</title>')).toBe(true);
    expect(page!.html.endsWith('</a>')).toBe(true);
    expect(page!.text).toHaveLength(STORED_TEXT_MAX_CHARS);
    expect(page!.truncated).toBe(true);
    const many = storedPages(Array.from({ length: 30 }, (_, i) => ({ ...big, url: `https://firm.example/${i}` })));
    expect(many.reduce((total, item) => total + item.html.length + item.text.length, 0)).toBeLessThanOrEqual(STORED_PAGES_MAX_CHARS);
    expect(many).toHaveLength(30);
    expect(many.at(-1)).toMatchObject({ url: 'https://firm.example/29', truncated: true });
    // A page that fits keeps every field the crawl gave it and no flag.
    const [small] = storedPages([{ url: 'https://firm.example/doc.pdf', html: '', text: 'PDF', kind: 'document', complete: false, requested: true }]);
    expect(small).toEqual({ url: 'https://firm.example/doc.pdf', kind: 'document', complete: false, requested: true, text: 'PDF', html: '', htmlChars: 0 });
  });
});

describe('the website source stores the compact pages and extracts from the full ones', () => {
  it('hands the provider the crawl as read, stores the compact pages, and keeps the reuse key of the full crawl', async () => {
    const crawl = heavyCrawl();
    const extract = vi.fn(async (_input: CrawlResult) => ({ ...unknownWebsite(), firm_name: 'Harbor Lemon Partners' }));
    const source = new WebsiteExtractionSource(new InMemoryRepository(), { id: 'fixture', version: '1', extract }, async () => crawl);
    const result = await source.run(DOMAIN, new AbortController().signal);
    expect(extract.mock.calls[0]![0].pages.map(page => page.html)).toEqual(crawl.pages.map(page => page.html));
    const record = JSON.parse(result.rawContent!);
    expect(bytes(result.rawContent)).toBeLessThan(1_500_000);
    expect(record.pageFormat).toBe(STORED_PAGE_FORMAT);
    const version = JSON.stringify(['fixture', '1']);
    expect(record.reuse.key).toBe(`wsk2-${createHash('sha256').update(`${version}\n${corpusFingerprint(crawl)}`).digest('hex')}`);
    // The stored pages give the same key again: a replay from the record reads what the extraction read.
    expect(corpusFingerprint({ pages: record.pages, partial: false })).toBe(corpusFingerprint(crawl));
  });
});

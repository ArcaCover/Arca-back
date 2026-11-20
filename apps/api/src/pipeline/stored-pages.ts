import type { CrawledPage } from './crawler.js';

/**
 * How a website raw record stores the pages it was read from (DN-12 §15.5). Nothing downstream reads a page back from the
 * record: the extraction reads the crawl as it came, the reuse key is computed from that crawl, and a reused analysis is
 * read from the record's `analysis`. The pages are kept to audit a result and to replay it offline. The full HTML of a
 * page is mostly scripts, styles, icons and data URIs (lemonlawgrouppartners.com: 19 pages, 13.9 MB, of which ~0.24 MB of
 * visible text), and a record that size outlasted the storage client's timeout. So each page keeps:
 * - its visible text, as the crawler read it;
 * - of its HTML, only the parts the backend reads, in document order (`readableHtml`): the first title, the first
 *   heading, every meta tag, every JSON-LD block and every link, a link reduced to its address and its words;
 * - `htmlChars`, the length of the full HTML, and `truncated` when a bound below cut it.
 * Read through the corpus, the stored pages give the same segments, links and reuse key as the full HTML. A record
 * written before this has no `pageFormat` and the full HTML; both are read the same way.
 */
export const STORED_PAGE_FORMAT = 'readable-html-v1';
/** Bounds of one page's stored HTML and text, and of all the pages of one record together. */
export const STORED_HTML_MAX_CHARS = 100_000;
export const STORED_TEXT_MAX_CHARS = 100_000;
export const STORED_PAGES_MAX_CHARS = 1_500_000;

export type StoredPage = Pick<CrawledPage, 'url' | 'kind' | 'complete' | 'requested'> & {
  text: string; html: string; htmlChars: number; truncated?: true };

// The patterns the readers use (evidence-corpus.ts, website-evidence-provider.ts, page-types.ts, ai-publications.ts,
// derived-signals.ts, agentic-evidence-provider.ts). Each fragment kept is a whole match of one of them.
const FIRST = [/<title[^>]*>[\s\S]*?<\/title>/i, /<h1\b[^>]*>[\s\S]*?<\/h1>/i];
const EVERY = [/<meta\b[^>]*>/gi, /<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi];
const LINK = /<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
// A data URI is no address any reader follows; its payload can be most of a page.
const withoutPayload = (href: string) => /^\s*data:/i.test(href) ? 'data:,' : href;

/**
 * The parts of a page's HTML the backend reads, one per line in document order. A link keeps the address its readers
 * take (the last `href` of the tag that has a value, as the pattern finds it) and its words with every tag between them
 * made a space, which is how each reader reads the words. A fragment that overlaps another is kept whole, as written.
 */
export function readableHtml(html: string): string {
  const spans: Array<{ start: number; end: number; text: string | null }> = [];
  for (const pattern of FIRST) {
    const match = pattern.exec(html);
    if (match) spans.push({ start: match.index, end: match.index + match[0].length, text: null });
  }
  for (const pattern of EVERY) for (const match of html.matchAll(pattern)) {
    spans.push({ start: match.index!, end: match.index! + match[0].length, text: null });
  }
  for (const match of html.matchAll(LINK)) spans.push({ start: match.index!, end: match.index! + match[0].length,
    text: `<a href="${withoutPayload(match[1]!)}">${match[2]!.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')}</a>` });
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: typeof spans = [];
  for (const span of spans) {
    const last = kept.at(-1);
    if (last && span.start < last.end) {
      if (span.end > last.end) last.end = span.end;
      last.text = null;
    } else kept.push({ ...span });
  }
  return kept.map(span => span.text ?? html.slice(span.start, span.end)).join('\n');
}

/** Whole lines of `value` up to `max` characters: a cut never splits a fragment. */
function upTo(value: string, max: number): string {
  if (value.length <= max) return value;
  const cut = value.lastIndexOf('\n', max);
  return cut > 0 ? value.slice(0, cut) : '';
}

/** The pages a website raw record stores, in crawl order, within the bounds above. */
export function storedPages(pages: CrawledPage[]): StoredPage[] {
  let room = STORED_PAGES_MAX_CHARS;
  return pages.map(page => {
    const readable = readableHtml(page.html);
    const html = upTo(readable, Math.min(STORED_HTML_MAX_CHARS, room));
    room -= html.length;
    const text = page.text.slice(0, Math.max(0, Math.min(STORED_TEXT_MAX_CHARS, room)));
    room -= text.length;
    return { url: page.url, ...(page.kind ? { kind: page.kind } : {}), ...(page.complete !== undefined ? { complete: page.complete } : {}),
      ...(page.requested !== undefined ? { requested: page.requested } : {}), text, html, htmlChars: page.html.length,
      ...(html.length < readable.length || text.length < page.text.length ? { truncated: true as const } : {}) };
  });
}

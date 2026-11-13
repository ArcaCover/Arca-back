import { fetchPublicResponse } from './network.js';
import { createRobotsCache, fetchRobotsText, robotsPolicy, type RobotsCache, type RobotsFetch } from './robots.js';
import { classifyLink } from './evidence-corpus.js';
import { pagePriority } from './crawl-order.js';

export const MAX_SITEMAP_URLS = 400;
/** A sitemap file larger than this fails the sitemap read, as it always has. */
export const MAX_SITEMAP_BYTES = 1_000_000;
/** Redirects followed for one sitemap file, each checked before it is fetched. */
export const MAX_SITEMAP_REDIRECTS = 5;
/** Links one sitemap file may add, so every child of an index gets a share of MAX_SITEMAP_URLS. */
export const MAX_URLS_PER_SITEMAP = 60;
/** Child sitemaps of an index that are read. hklaw.com lists 11. */
export const MAX_INDEX_CHILDREN = 16;
/** Sitemap files fetched at once. Read sequentially, hklaw.com's 12 files took 7-8 s. */
export const SITEMAP_FETCHES_IN_FLIGHT = 4;
// Child sitemaps named for listings of dated items (news, events, publications, jobs) are read last.
const LISTING_SITEMAP = /(news|events?|insights?|blogs?|press|publications?|media|podcasts?|webinars?|careers?|jobs|case-?studies|archive|posts?)/;
// Those named for the firm itself, its people, offices or practices first.
const FIRM_SITEMAP = /(professionals?|people|attorneys?|lawyers?|team|offices?|locations?|contact|firm|about|services?|practices?|general|pages?|innovation|artificial-intelligence)/;
/** 0 for a firm sitemap, 2 for a listing of dated items, 1 for anything else; ties keep the index order. */
export function sitemapRank(url: string): number {
  const path = URL.canParse(url) ? new URL(url).pathname.toLowerCase() : '';
  return LISTING_SITEMAP.test(path) && !FIRM_SITEMAP.test(path.replace(/.*\//, '')) ? 2 : FIRM_SITEMAP.test(path) ? 0 : 1;
}
const host = (url: string) => new URL(url).hostname.replace(/^www\./, '');
const locations = (xml: string) => [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)]
  .map(match => match[1]!.replace(/&amp;/g, '&'));

/** One request per call: the reader follows redirects itself, so it can check every hop. */
export type SitemapTransport = { response: typeof fetchPublicResponse; robots: RobotsFetch };
export const sitemapTransport: SitemapTransport = { response: fetchPublicResponse, robots: fetchRobotsText };

/** Discovers URLs the site declares about itself. Nothing is fetched here except robots.txt and the sitemap files it allows. */
export async function readSitemap(domain: string, signal: AbortSignal, transport: SitemapTransport = sitemapTransport,
  robots?: RobotsCache): Promise<{ links: Array<{ url: string; kind: 'page' | 'document' }>; detail: string | null }> {
  const origin = `https://${domain}`, base = `${origin}/`;
  const options = { fetchText: transport.robots, cache: robots ?? createRobotsCache() };
  // A sitemap on the www host is fetched from there, so the rules of that origin are the ones that apply to it.
  const fetchable = async (url: string) => (await robotsPolicy(new URL(url).origin, signal, options)).allows(url);
  // A redirect is followed one hop at a time, as the document reader does: every hop must stay on the firm's host and
  // be allowed by the rules of its own origin, or the sitemap is skipped. A redirect into a path robots.txt excludes
  // is never fetched, and neither is one to another host.
  const fetchSitemap = async (url: string): Promise<string | null> => {
    let next = url;
    for (let hop = 0; hop <= MAX_SITEMAP_REDIRECTS; hop++) {
      signal.throwIfAborted();
      if (hop > 0 && (!['https:', 'http:'].includes(new URL(next).protocol) || host(next) !== domain || !await fetchable(next))) return null;
      const response = await transport.response(next, signal, 'GET', null, { maxBytes: MAX_SITEMAP_BYTES });
      const location = response.status >= 300 && response.status < 400 ? response.headers['location'] : undefined;
      if (location !== undefined) {
        if (!URL.canParse(location, next)) return null;
        next = new URL(location, next).href;
        continue;
      }
      return response.status === 200 ? response.body.toString('utf8') : null;
    }
    return null;
  };
  try {
    const rules = await robotsPolicy(origin, signal, options);
    if (rules.state === 'unreachable') return { links: [], detail: 'ROBOTS_UNAVAILABLE' };
    const queue: string[] = [];
    for (const url of new Set([...rules.sitemaps(), `${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`, `${origin}/wp-sitemap.xml`])) {
      if (host(url) === domain && await fetchable(url)) queue.push(url);
    }
    const seen = new Set<string>(), links = new Map<string, 'page' | 'document'>();
    let indexChildren = 0;
    // Files are fetched a few at a time and read in queue order, whatever order they answer in, so the links are the
    // same on every read. An index's children are queued by how useful they are (people, offices and the firm's own
    // pages before news and events) and each file adds at most MAX_URLS_PER_SITEMAP links, so a news sitemap of
    // thousands of URLs cannot fill the cap before the offices or the people are read (hklaw.com, DN-12 §13.10).
    while (queue.length && seen.size < 20 && links.size < MAX_SITEMAP_URLS) {
      signal.throwIfAborted();
      const batch: string[] = [];
      while (queue.length && batch.length < SITEMAP_FETCHES_IN_FLIGHT && seen.size < 20) {
        const sitemap = queue.shift()!;
        if (seen.has(sitemap)) continue;
        seen.add(sitemap); batch.push(sitemap);
      }
      const texts = await Promise.all(batch.map(fetchSitemap));
      const children: string[] = [];
      for (const text of texts) {
        if (text === null || links.size >= MAX_SITEMAP_URLS) continue;
        const isIndex = /<sitemapindex\b/i.test(text);
        let added = 0;
        for (const loc of locations(text)) {
          if (isIndex) {
            if (indexChildren < MAX_INDEX_CHILDREN && host(loc) === domain && await fetchable(loc)) { children.push(loc); indexChildren++; }
            continue;
          }
          if (added >= MAX_URLS_PER_SITEMAP || links.size >= MAX_SITEMAP_URLS) break;
          const target = classifyLink(loc, base);
          if (target && rules.allows(target.url) && !links.has(target.url)) { links.set(target.url, target.kind); added++; }
        }
      }
      queue.push(...children.map((url, index) => ({ url, index })).sort((a, b) => sitemapRank(a.url) - sitemapRank(b.url) || a.index - b.index)
        .map(child => child.url));
    }
    const ordered = [...links].map(([url, kind]) => ({ url, kind }))
      .sort((a, b) => (a.kind === b.kind ? pagePriority(a.url) - pagePriority(b.url) : a.kind === 'page' ? -1 : 1) || a.url.localeCompare(b.url))
      .slice(0, MAX_SITEMAP_URLS);
    return { links: ordered, detail: ordered.length ? null : 'NO_SITEMAP_URLS' };
  } catch (error) {
    return { links: [], detail: error instanceof Error ? error.message.slice(0, 200) : 'SITEMAP_READ_FAILED' };
  }
}

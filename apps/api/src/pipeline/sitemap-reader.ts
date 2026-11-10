import { fetchPublicText } from './network.js';
import { createRobotsCache, fetchRobotsText, robotsPolicy, type RobotsCache, type RobotsFetch } from './robots.js';
import { classifyLink } from './evidence-corpus.js';
import { pagePriority } from './crawler.js';

export const MAX_SITEMAP_URLS = 400;
const host = (url: string) => new URL(url).hostname.replace(/^www\./, '');
const locations = (xml: string) => [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)]
  .map(match => match[1]!.replace(/&amp;/g, '&'));

export type SitemapTransport = { text: typeof fetchPublicText; robots: RobotsFetch };
export const sitemapTransport: SitemapTransport = { text: fetchPublicText, robots: fetchRobotsText };

/** Discovers URLs the site declares about itself. Nothing is fetched here except robots.txt and the sitemap files it allows. */
export async function readSitemap(domain: string, signal: AbortSignal, transport: SitemapTransport = sitemapTransport,
  robots?: RobotsCache): Promise<{ links: Array<{ url: string; kind: 'page' | 'document' }>; detail: string | null }> {
  const origin = `https://${domain}`, base = `${origin}/`;
  const options = { fetchText: transport.robots, cache: robots ?? createRobotsCache() };
  // A sitemap on the www host is fetched from there, so the rules of that origin are the ones that apply to it.
  const fetchable = async (url: string) => (await robotsPolicy(new URL(url).origin, signal, options)).allows(url);
  try {
    const rules = await robotsPolicy(origin, signal, options);
    if (rules.state === 'unreachable') return { links: [], detail: 'ROBOTS_UNAVAILABLE' };
    const queue: string[] = [];
    for (const url of new Set([...rules.sitemaps(), `${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`, `${origin}/wp-sitemap.xml`])) {
      if (host(url) === domain && await fetchable(url)) queue.push(url);
    }
    const seen = new Set<string>(), links = new Map<string, 'page' | 'document'>();
    let indexChildren = 0;
    while (queue.length && seen.size < 20 && links.size < MAX_SITEMAP_URLS) {
      signal.throwIfAborted();
      const sitemap = queue.shift()!;
      if (seen.has(sitemap)) continue;
      seen.add(sitemap);
      const response = await transport.text(sitemap, signal);
      if (response.status !== 200) continue;
      const isIndex = /<sitemapindex\b/i.test(response.text);
      for (const loc of locations(response.text)) {
        if (isIndex) { if (indexChildren < 10 && host(loc) === domain && await fetchable(loc)) { queue.push(loc); indexChildren++; } continue; }
        const target = classifyLink(loc, base);
        if (target && rules.allows(target.url)) links.set(target.url, target.kind);
      }
    }
    const ordered = [...links].map(([url, kind]) => ({ url, kind }))
      .sort((a, b) => (a.kind === b.kind ? pagePriority(a.url) - pagePriority(b.url) : a.kind === 'page' ? -1 : 1) || a.url.localeCompare(b.url))
      .slice(0, MAX_SITEMAP_URLS);
    return { links: ordered, detail: ordered.length ? null : 'NO_SITEMAP_URLS' };
  } catch (error) {
    return { links: [], detail: error instanceof Error ? error.message.slice(0, 200) : 'SITEMAP_READ_FAILED' };
  }
}

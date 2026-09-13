import { fetchPublicText } from './network.js';
import { robotsRules } from './robots.js';
import { classifyLink } from './evidence-corpus.js';
import { pagePriority } from './crawler.js';

export const MAX_SITEMAP_URLS = 400;
const host = (url: string) => new URL(url).hostname.replace(/^www\./, '');
const locations = (xml: string) => [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)]
  .map(match => match[1]!.replace(/&amp;/g, '&'));

/** Discovers URLs the site declares about itself. Nothing is fetched here except sitemap files. */
export async function readSitemap(domain: string, signal: AbortSignal, fetchText = fetchPublicText):
  Promise<{ links: Array<{ url: string; kind: 'page' | 'document' }>; detail: string | null }> {
  const origin = `https://${domain}`, base = `${origin}/`;
  try {
    const rules = await robotsRules(origin, signal, fetchText);
    const queue = [...new Set([...rules.getSitemaps(), `${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`, `${origin}/wp-sitemap.xml`])]
      .filter(url => host(url) === domain);
    const seen = new Set<string>(), links = new Map<string, 'page' | 'document'>();
    let indexChildren = 0;
    while (queue.length && seen.size < 20 && links.size < MAX_SITEMAP_URLS) {
      signal.throwIfAborted();
      const sitemap = queue.shift()!;
      if (seen.has(sitemap)) continue;
      seen.add(sitemap);
      const response = await fetchText(sitemap, signal);
      if (response.status !== 200) continue;
      const isIndex = /<sitemapindex\b/i.test(response.text);
      for (const loc of locations(response.text)) {
        if (isIndex) { if (indexChildren < 10 && host(loc) === domain) { queue.push(loc); indexChildren++; } continue; }
        const target = classifyLink(loc, base);
        if (target && rules.isAllowed(target.url, 'ArcaBot/1.0') !== false) links.set(target.url, target.kind);
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

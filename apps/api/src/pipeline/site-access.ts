import { crawlWebsite, type CrawledPage, type CrawlTransport } from './crawler.js';
import { documentTransport, readDocument, type DocumentTransport } from './document-reader.js';
import type { RobotsCache } from './robots.js';
import { readSitemap as readSitemapUrls, sitemapTransport } from './sitemap-reader.js';

export type ToolName = 'fetch_pages' | 'read_document' | 'read_sitemap' | 'find_in_site';
export type ToolCall = { round: number; tool: ToolName; target: string; status: 'read' | 'failed' | 'skipped'; detail: string | null };
export type ToolResult = { calls: Omit<ToolCall, 'round'>[] };

/** Backend-side reading tools. The model chooses among observed targets; this layer enforces what may be read. */
export interface SiteAccess {
  fetchPages(urls: string[], signal: AbortSignal): Promise<ToolResult & { pages: CrawledPage[] }>;
  readDocuments(urls: string[], signal: AbortSignal): Promise<ToolResult & { pages: CrawledPage[] }>;
  readSitemap(domain: string, signal: AbortSignal): Promise<ToolResult & { links: Array<{ url: string; kind: 'page' | 'document' }> }>;
  /** The same tools reading through one scan's robots cache, so every tool call shares one robots.txt download per origin. */
  withRobots?(robots: RobotsCache): SiteAccess;
}
/** The crawler's transport serves every reader: one request per call, so each reader checks every redirect hop itself. */
export type SiteTransport = CrawlTransport & Partial<Pick<DocumentTransport, 'extract'>>;

// No cache by default: this object outlives a scan, and a robots answer must not.
export function createSiteAccess(transport?: SiteTransport, robots?: RobotsCache): SiteAccess {
  return {
    withRobots: cache => createSiteAccess(transport, cache),
    async fetchPages(urls, signal) {
      const pages: CrawledPage[] = [], calls: ToolResult['calls'] = [];
      for (const url of urls) {
        signal.throwIfAborted();
        try {
          const crawl = await crawlWebsite(url, signal, transport && { response: transport.response, robots: transport.robots },
            { timeoutMs: 30_000, maxPages: 1, maxDepth: 0, seedOnly: true, robots });
          pages.push(...crawl.pages);
          calls.push({ tool: 'fetch_pages', target: url, status: crawl.pages.length ? 'read' : 'failed',
            // The page's own outcome, not a subresource's or the robots fetch behind it.
            detail: crawl.pages.length ? null : crawl.issues?.find(issue => (issue.scope ?? 'page') === 'page')?.code ?? 'NO_READABLE_CONTENT' });
        } catch (error) {
          calls.push({ tool: 'fetch_pages', target: url, status: 'failed', detail: error instanceof Error ? error.message.slice(0, 200) : 'failed' });
        }
      }
      return { pages, calls };
    },
    async readDocuments(urls, signal) {
      const pages: CrawledPage[] = [], calls: ToolResult['calls'] = [];
      for (const url of urls) {
        const { page, detail } = await readDocument(url, signal, transport ? { ...documentTransport, ...transport } : undefined, robots);
        if (page) pages.push(page);
        calls.push({ tool: 'read_document', target: url, status: page ? 'read' : 'failed',
          detail: page ? (page.complete ? 'complete' : 'truncated') : detail });
      }
      return { pages, calls };
    },
    async readSitemap(domain, signal) {
      const { links, detail } = await readSitemapUrls(domain, signal, transport ? { ...sitemapTransport, ...transport } : undefined, robots);
      return { links, calls: [{ tool: 'read_sitemap', target: `https://${domain}/`, status: links.length ? 'read' : 'failed',
        detail: links.length ? `${links.length} urls` : detail }] };
    },
  };
}

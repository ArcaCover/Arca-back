import { crawlWebsite, type CrawledPage } from './crawler.js';

export type ToolName = 'fetch_pages' | 'read_document' | 'read_sitemap' | 'find_in_site';
export type ToolCall = { round: number; tool: ToolName; target: string; status: 'read' | 'failed' | 'skipped'; detail: string | null };
export type ToolResult = { calls: Omit<ToolCall, 'round'>[] };

/** Backend-side reading tools. The model chooses among observed targets; this layer enforces what may be read. */
export interface SiteAccess {
  fetchPages(urls: string[], signal: AbortSignal): Promise<ToolResult & { pages: CrawledPage[] }>;
}

export function createSiteAccess(): SiteAccess {
  return {
    async fetchPages(urls, signal) {
      const pages: CrawledPage[] = [], calls: ToolResult['calls'] = [];
      for (const url of urls) {
        signal.throwIfAborted();
        try {
          const crawl = await crawlWebsite(url, signal, undefined, { timeoutMs: 30_000, maxPages: 1, maxDepth: 0 });
          pages.push(...crawl.pages);
          calls.push({ tool: 'fetch_pages', target: url, status: crawl.pages.length ? 'read' : 'failed',
            detail: crawl.pages.length ? null : crawl.issues?.[0]?.code ?? 'NO_READABLE_CONTENT' });
        } catch (error) {
          calls.push({ tool: 'fetch_pages', target: url, status: 'failed', detail: error instanceof Error ? error.message.slice(0, 200) : 'failed' });
        }
      }
      return { pages, calls };
    },
  };
}

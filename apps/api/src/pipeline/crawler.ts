import { chromium } from 'playwright';
import { createRequire } from 'node:module';
import { fetchPublicResponse, fetchPublicText } from './network.js';

/** `requested` marks a page the extraction agent asked for, so the corpus never drops it for crawled pages. */
export type CrawledPage = { url: string; html: string; text: string; kind?: 'page' | 'document'; complete?: boolean; requested?: boolean };
export type CrawlIssue = { url: string; code: 'ACCESS_BLOCKED' | 'ROBOTS_UNAVAILABLE' | 'ROBOTS_DISALLOWED' |
  'HTTP_ERROR' | 'NO_READABLE_CONTENT' | 'REQUEST_FAILED'; status: number | null; detail?: string };
export type CrawlResult = { pages: CrawledPage[]; partial: boolean; issues?: CrawlIssue[] };
const USER_AGENT = 'ArcaBot/1.0';
/** Attempts allowed per page, the first one included. */
export const MAX_PAGE_ATTEMPTS = 3;
/**
 * A page is worth another attempt only while the crawl is alive and the failure could plausibly
 * differ next time. Robots rules, missing pages and unreadable content are decided, so retrying
 * them only spends the crawl deadline that a recoverable page still needs.
 */
export function shouldRetryPage(issue: CrawlIssue, attempt: number, aborted: boolean,
  max = MAX_PAGE_ATTEMPTS): boolean {
  if (aborted || attempt + 1 >= max) return false;
  if (issue.code === 'REQUEST_FAILED') return true;
  if (issue.code === 'HTTP_ERROR') return issue.status === null || issue.status >= 500;
  if (issue.code === 'ACCESS_BLOCKED') return issue.status === 429;
  return false;
}
type RobotsRules = { isAllowed(url: string, agent: string): boolean | undefined };
const robotsParser = createRequire(import.meta.url)('robots-parser') as (url: string, text: string) => RobotsRules;
export function pagePriority(raw: string): number {
  const path = new URL(raw).pathname.toLowerCase();
  if (path === '/') return 0;
  // Spanish stems carry the same weight as their English equivalents. Without them a Spanish site
  // has no ranked page at all, the whole crawl ties at the lowest priority and the budget goes to
  // whatever sorts first alphabetically, which is usually the blog.
  const groups = [
    /about|nosotros|quienes-somos|acerca|la-firma/,
    /team|attorney|lawyer|people|abogad|equipo|socios/,
    /service|practice|servicio|practica/,
    /privacy|privacidad|aviso-legal/,
    /blog|insight|news|noticias/,
  ];
  const index = groups.findIndex(group => group.test(path));
  return index < 0 ? 6 : index + 1;
}
export function canonicalUrl(raw: string, base: string): string | null {
  try {
    const url = new URL(raw, base);
    const host = new URL(base).hostname.replace(/^www\./, '');
    if (!['https:', 'http:'].includes(url.protocol) || url.hostname.replace(/^www\./, '') !== host ||
      url.username || url.password || url.port || /\.(pdf|jpg|jpeg|png|gif|webp|zip|svg|mp4|css|js)$/i.test(url.pathname)) return null;
    url.hash = ''; url.search = '';
    // The same page reached with and without "www." must canonicalize to one identical string, or a
    // self-link in the other form (common on real sites: muscalaw.com's own home link) gets queued
    // and crawled a second time, spending a page of budget on content already read.
    url.hostname = host;
    return url.href;
  } catch { return null; }
}
export async function crawlWebsite(domainOrUrl: string, parent: AbortSignal, transport: {
  response: typeof fetchPublicResponse; robots: typeof fetchPublicText;
} = { response: fetchPublicResponse, robots: fetchPublicText }, options: {
  timeoutMs?: number; maxPages?: number; maxDepth?: number;
  /** Start from the requested URL only. Without it the root page is queued first and wins a one-page budget. */
  seedOnly?: boolean;
} = {}): Promise<CrawlResult> {
  const supplied = /^[a-z]+:\/\//i.test(domainOrUrl) ? new URL(domainOrUrl) : new URL(`https://${domainOrUrl}/`);
  const domain = supplied.hostname.replace(/^www\./, '');
  if (!domain) throw new Error('A website domain is required');
  supplied.hash = '';
  const rootUrl = `https://${domain}/`;
  const seedUrl = canonicalUrl(supplied.href, rootUrl);
  if (!seedUrl) throw new Error('The requested website URL is outside the canonical domain');
  const maxPages = options.maxPages ?? 20, maxDepth = options.maxDepth ?? 2;
  const signal = AbortSignal.any([parent, AbortSignal.timeout(options.timeoutMs ?? 30_000)]);
  const pages: CrawledPage[] = [];
  const issues: CrawlIssue[] = [];
  let partial = false;
  const browser = await chromium.launch({ headless: true, timeout: 10_000 });
  const abort = () => { void browser.close().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    const context = await browser.newContext({ userAgent: USER_AGENT, serviceWorkers: 'block' });
    const robots = new Map<string, Promise<ReturnType<typeof robotsParser>>>();
    async function allowed(raw: string): Promise<boolean> {
      const url = new URL(raw);
      let entry = robots.get(url.origin);
      if (!entry) {
        entry = (async () => {
          const robotsUrl = `${url.origin}/robots.txt`;
          const response = await transport.robots(robotsUrl, signal);
          if (response.status === 404 || response.status === 410) return robotsParser(robotsUrl, '');
          if (response.status < 200 || response.status >= 300) {
            issues.push({ url: robotsUrl, code: 'ROBOTS_UNAVAILABLE', status: response.status });
            throw new Error('Robots rules unavailable');
          }
          return robotsParser(robotsUrl, response.text);
        })();
        robots.set(url.origin, entry);
      }
      return (await entry).isAllowed(raw, USER_AGENT) !== false;
    }
    await context.route('**/*', async route => {
      try {
        signal.throwIfAborted();
        const request = route.request();
        if (['image', 'media', 'font'].includes(request.resourceType())) { await route.abort(); return; }
        if (request.isNavigationRequest() && (!canonicalUrl(request.url(), `https://${domain}`) || !(await allowed(request.url())))) {
          await route.abort(); return;
        }
        const response = await transport.response(request.url(), signal, request.method(), request.postDataBuffer());
        if ([401, 403, 429].includes(response.status)) issues.push({ url: request.url(), code: 'ACCESS_BLOCKED', status: response.status });
        const headers = { ...response.headers };
        for (const name of ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer',
          'transfer-encoding', 'upgrade', 'content-length']) delete headers[name];
        await route.fulfill({ status: response.status, headers, body: response.body });
      } catch (error) {
        issues.push({ url: route.request().url(), code: 'REQUEST_FAILED', status: null,
          detail: error instanceof Error ? error.message.slice(0, 200) : 'Unknown transport error' });
        await route.abort().catch(() => {});
      }
    });
    await context.routeWebSocket('**/*', socket => socket.close());
    let queue = [...new Set(options.seedOnly ? [seedUrl] : [rootUrl, seedUrl])].map(url => ({ url, depth: 0, attempt: 0 }));
    const visited = new Set<string>();
    // Requeued pages leave `visited`, so a retry costs another attempt but never another page budget.
    const fail = (item: { url: string; depth: number; attempt: number }, issue: CrawlIssue) => {
      if (shouldRetryPage(issue, item.attempt, signal.aborted)) {
        visited.delete(item.url);
        queue.push({ ...item, attempt: item.attempt + 1 });
        return;
      }
      issues.push(issue);
      partial = true;
    };
    while (queue.length && visited.size < maxPages && !signal.aborted) {
      queue.sort((a, b) => a.depth - b.depth || pagePriority(a.url) - pagePriority(b.url) || a.url.localeCompare(b.url));
      const batch = queue.splice(0, Math.min(3, maxPages - visited.size)).filter(item => !visited.has(item.url));
      for (const item of batch) visited.add(item.url);
      await Promise.all(batch.map(async item => {
        let page: import('playwright').Page | undefined;
        try {
          page = await context.newPage();
          if (!(await allowed(item.url))) { fail(item, { url: item.url, code: 'ROBOTS_DISALLOWED', status: null }); return; }
          const response = await page.goto(item.url, { timeout: 8000, waitUntil: 'domcontentloaded' });
          if (!response || response.status() >= 400 || !/text\/html|application\/xhtml/i.test(response.headers()['content-type'] ?? '')) {
            const status = response?.status() ?? null;
            fail(item, { url: item.url, code: status !== null && [401, 403, 429].includes(status) ? 'ACCESS_BLOCKED' : 'HTTP_ERROR', status });
            return;
          }
          await page.waitForLoadState('networkidle', { timeout: 1500 }).catch(() => {});
          const html = await page.content();
          const links = await page.locator('a[href]').evaluateAll(anchors => anchors.map(a => a.getAttribute('href') ?? ''));
          await page.locator('nav, footer, script, style, noscript, template, [aria-hidden="true"]').evaluateAll(elements => elements.forEach(element => element.remove()));
          const text = (await page.locator('body').innerText({ timeout: 1000 })).trim();
          if (!text || /^(checking your browser|just a moment|access denied|verify you are human)/i.test(text)) {
            fail(item, { url: item.url, code: /^(checking your browser|just a moment|access denied|verify you are human)/i.test(text)
              ? 'ACCESS_BLOCKED' : 'NO_READABLE_CONTENT', status: response.status() });
            return;
          }
          pages.push({ url: page.url(), html, text });
          if (item.depth < maxDepth) for (const link of links) {
            const url = canonicalUrl(link, page.url());
            if (url && !visited.has(url) && !queue.some(item => item.url === url)) queue.push({ url, depth: item.depth + 1, attempt: 0 });
          }
        } catch (error) { fail(item, { url: item.url, code: 'REQUEST_FAILED', status: null,
          detail: error instanceof Error ? error.message.slice(0, 200) : 'Unknown navigation error' }); }
        finally { await page?.close().catch(() => {}); }
      }));
    }
    // A page that only failed on an earlier attempt is not an issue of the finished crawl.
    const read = new Set(pages.map(page => page.url));
    return { pages: pages.sort((a, b) => a.url.localeCompare(b.url)), partial: partial || signal.aborted,
      issues: [...new Map(issues.filter(issue => !read.has(issue.url))
        .map(issue => [`${issue.url}:${issue.code}:${issue.status}`, issue])).values()] };
  } finally {
    signal.removeEventListener('abort', abort);
    await browser.close().catch(() => {});
  }
}

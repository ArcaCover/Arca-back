import { chromium } from 'playwright';
import { createRequire } from 'node:module';
import { fetchPublicResponse, fetchPublicText } from './network.js';

export type CrawledPage = { url: string; html: string; text: string };
export type CrawlResult = { pages: CrawledPage[]; partial: boolean };
const USER_AGENT = 'ArcaBot/1.0';
type RobotsRules = { isAllowed(url: string, agent: string): boolean | undefined };
const robotsParser = createRequire(import.meta.url)('robots-parser') as (url: string, text: string) => RobotsRules;
export function pagePriority(raw: string): number {
  const path = new URL(raw).pathname.toLowerCase();
  if (path === '/') return 0;
  const groups = [/about/, /team|attorney|lawyer|people/, /service|practice/, /privacy/, /blog|insight|news/];
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
    return url.href;
  } catch { return null; }
}
export async function crawlWebsite(domain: string, parent: AbortSignal, transport: {
  response: typeof fetchPublicResponse; robots: typeof fetchPublicText;
} = { response: fetchPublicResponse, robots: fetchPublicText }): Promise<CrawlResult> {
  const signal = AbortSignal.any([parent, AbortSignal.timeout(20_000)]);
  const pages: CrawledPage[] = [];
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
          if (response.status < 200 || response.status >= 300) throw new Error('Robots rules unavailable');
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
        await route.fulfill({ status: response.status, headers: response.headers, body: response.body });
      } catch { await route.abort().catch(() => {}); }
    });
    await context.routeWebSocket('**/*', socket => socket.close());
    let queue = [{ url: `https://${domain}/`, depth: 0 }];
    const visited = new Set<string>();
    while (queue.length && visited.size < 20 && !signal.aborted) {
      queue.sort((a, b) => a.depth - b.depth || pagePriority(a.url) - pagePriority(b.url) || a.url.localeCompare(b.url));
      const batch = queue.splice(0, Math.min(3, 20 - visited.size)).filter(item => !visited.has(item.url));
      for (const item of batch) visited.add(item.url);
      await Promise.all(batch.map(async item => {
        let page: import('playwright').Page | undefined;
        try {
          page = await context.newPage();
          if (!(await allowed(item.url))) { partial = true; return; }
          const response = await page.goto(item.url, { timeout: 8000, waitUntil: 'domcontentloaded' });
          if (!response || response.status() >= 400 || !/text\/html|application\/xhtml/i.test(response.headers()['content-type'] ?? '')) {
            partial = true; return;
          }
          await page.waitForLoadState('networkidle', { timeout: 1500 }).catch(() => {});
          const html = await page.content();
          const links = await page.locator('a[href]').evaluateAll(anchors => anchors.map(a => a.getAttribute('href') ?? ''));
          await page.locator('nav, footer, script, style, noscript, template, [aria-hidden="true"]').evaluateAll(elements => elements.forEach(element => element.remove()));
          const text = (await page.locator('body').innerText({ timeout: 1000 })).trim();
          if (!text || /^(checking your browser|just a moment|access denied|verify you are human)/i.test(text)) { partial = true; return; }
          pages.push({ url: page.url(), html, text });
          if (item.depth < 2) for (const link of links) {
            const url = canonicalUrl(link, page.url());
            if (url && !visited.has(url) && !queue.some(item => item.url === url)) queue.push({ url, depth: item.depth + 1 });
          }
        } catch { partial = true; }
        finally { await page?.close().catch(() => {}); }
      }));
    }
    return { pages: pages.sort((a, b) => a.url.localeCompare(b.url)), partial: partial || signal.aborted };
  } finally {
    signal.removeEventListener('abort', abort);
    await browser.close().catch(() => {});
  }
}

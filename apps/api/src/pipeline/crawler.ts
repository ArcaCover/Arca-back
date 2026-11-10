import { chromium } from 'playwright';
import { setTimeout as sleep } from 'node:timers/promises';
import { fetchPublicResponse } from './network.js';
import { USER_AGENT, createRobotsCache, fetchRobotsText, robotsPolicy, type RobotsCache, type RobotsFetch,
  type RobotsPolicy } from './robots.js';

/** `requested` marks a page the extraction agent asked for, so the corpus never drops it for crawled pages. */
export type CrawledPage = { url: string; html: string; text: string; kind?: 'page' | 'document'; complete?: boolean; requested?: boolean };
/** `OFF_SITE_REDIRECT`: a link of the site that redirects to another host; `detail` names that host. */
export type CrawlIssue = { url: string; code: 'ACCESS_BLOCKED' | 'ROBOTS_UNAVAILABLE' | 'ROBOTS_DISALLOWED' |
  'HTTP_ERROR' | 'NOT_HTML' | 'NO_READABLE_CONTENT' | 'REQUEST_FAILED' | 'OFF_SITE_REDIRECT'; status: number | null; detail?: string;
  /**
   * `page`: how a page of the crawl ended; only these decide `partial` and why a site could not be read.
   * `request`: one request the browser made for a page (a redirect hop or a subresource, on any host).
   * `robots`: the /robots.txt of an origin could not be read. The last two are kept for audit.
   * Evidence stored before this field existed has none: read it as `page`.
   */
  scope?: 'page' | 'request' | 'robots' };
/** `aborted`: the crawl deadline or the caller ended the crawl before the queue was done. */
export type CrawlResult = { pages: CrawledPage[]; partial: boolean; issues?: CrawlIssue[]; aborted?: boolean };
export type CrawlTransport = { response: typeof fetchPublicResponse; robots: RobotsFetch };
/** Attempts allowed per page, the first one included. */
export const MAX_PAGE_ATTEMPTS = 3;
/**
 * The `detail` of an `ACCESS_BLOCKED` page that answered with a bot challenge. A challenge is the site refusing to be
 * read whatever status carries it (Cloudflare serves its own with 403, 429 or 503), so it is told apart from a plain
 * 429 or 5xx, which are passing. Issues stored before this marker existed carry a challenge only with a status below 400.
 */
export const CHALLENGE_PAGE = 'challenge page';
export const isChallenge = (issue: Pick<CrawlIssue, 'code' | 'detail'>) => issue.code === 'ACCESS_BLOCKED' && issue.detail === CHALLENGE_PAGE;
const CHALLENGE_TEXT = /^(checking your browser|just a moment|access denied|verify you are human)/i;
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
  if (issue.code === 'ACCESS_BLOCKED') return issue.status === 429 && !isChallenge(issue);
  return false;
}
/**
 * Whether a page that ended with this issue leaves the crawl incomplete. A link robots.txt excludes, a dead link
 * (404/410), a link to something that is not HTML and a link that leads off the site are answers, not failures:
 * the site was read as it asked to be and nothing a second crawl could recover is missing. They stay in `issues`
 * for audit.
 */
export function leavesCrawlPartial(issue: CrawlIssue): boolean {
  if (issue.code === 'ROBOTS_DISALLOWED' || issue.code === 'NOT_HTML' || issue.code === 'OFF_SITE_REDIRECT') return false;
  if (issue.code === 'HTTP_ERROR') return issue.status !== 404 && issue.status !== 410;
  return true;
}
/** The share of the crawl deadline that Crawl-delay may add to a crawl, at most: a quarter, 7.5 s of 30 s. */
export const pacingBudgetMs = (timeoutMs: number) => Math.floor(timeoutMs / 4);
/**
 * Crawl-delay is honoured as spacing between page starts: no two pages of the site start closer together than the
 * pause, while pages already started keep loading side by side. Reading one page at a time instead runs any real
 * site into the deadline (a page takes seconds to load and settle), and a crawl that ends on its deadline is partial
 * on every scan, retried as a passing failure and a different number of pages each time. So the pause is capped at
 * the pacing budget spread over the page budget: 375 ms under the defaults, whatever the site asks for.
 */
export function crawlPacing(crawlDelayMs: number | null, limits: { timeoutMs: number; maxPages: number }): number {
  if (crawlDelayMs === null) return 0;
  return Math.min(crawlDelayMs, Math.floor(pacingBudgetMs(limits.timeoutMs) / limits.maxPages));
}
/**
 * Hands out page starts in call order: each one at least `delayMs` after the previous one, and returns how long
 * the caller waits for its start. Only the time the spacing adds to the crawl is counted against `budgetMs`, and
 * once that is spent nobody waits, so a retried page or a long crawl cannot let the pacing grow past it.
 */
export function createPacer(budgetMs: number, now: () => number = Date.now): (delayMs: number) => number {
  let last = -Infinity, spent = 0;
  return delayMs => {
    const at = now(), floor = Math.max(at, last);
    const added = Math.max(0, Math.min(Math.max(at, last + delayMs) - floor, budgetMs - spent));
    spent += added;
    last = floor + added;
    return last - at;
  };
}
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
/** Caps how many pages of one priority group a single crawl will visit. Without it a firm with many
    attorney bios (priority group 2, muscalaw.com had 15) fills the whole page budget before privacy
    or blog — lower-priority groups that settle real signals — ever get a turn. Only group 2 is capped:
    it is the one observed to explode in page count; the others stay uncapped as before. */
const GROUP_PAGE_LIMITS: Partial<Record<number, number>> = { 2: 3 };
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
const HTML = /text\/html|application\/xhtml/i;
/**
 * The request handler stops a link that answers with a file, but it never sees what comes after a redirect (the
 * browser follows it by itself), and on a site that redirects its bare domain to www that is every link. There the
 * file reaches the browser, which ends the navigation with this error: the same answer, not a failure to retry.
 */
const startedDownload = (error: unknown) => error instanceof Error && /Download is starting/i.test(error.message);
// Measured on gallardolawyers.com: 3 pages at once took 21-25 s, 6 took 14 s for the same 19 pages.
export const CRAWL_CONCURRENCY = 6;
export async function crawlWebsite(domainOrUrl: string, parent: AbortSignal,
  transport: CrawlTransport = { response: fetchPublicResponse, robots: fetchRobotsText }, options: {
  timeoutMs?: number; maxPages?: number; maxDepth?: number;
  /** Pages fetched at once. */
  concurrency?: number;
  /** Start from the requested URL only. Without it the root page is queued first and wins a one-page budget. */
  seedOnly?: boolean;
  /** The scan's robots cache. Without one the rules are fetched for this crawl alone. */
  robots?: RobotsCache;
  /**
   * Tests only: Chromium's --host-resolver-rules. The browser follows a redirect with its own network stack, so a
   * test maps the fixture's www host to a loopback server to stand for the site behind the redirect.
   */
  hostResolverRules?: string;
} = {}): Promise<CrawlResult> {
  const supplied = /^[a-z]+:\/\//i.test(domainOrUrl) ? new URL(domainOrUrl) : new URL(`https://${domainOrUrl}/`);
  const domain = supplied.hostname.replace(/^www\./, '');
  if (!domain) throw new Error('A website domain is required');
  supplied.hash = '';
  const rootUrl = `https://${domain}/`;
  const seedUrl = canonicalUrl(supplied.href, rootUrl);
  if (!seedUrl) throw new Error('The requested website URL is outside the canonical domain');
  const maxPages = options.maxPages ?? 20, maxDepth = options.maxDepth ?? 2, timeoutMs = options.timeoutMs ?? 30_000;
  const signal = AbortSignal.any([parent, AbortSignal.timeout(timeoutMs)]);
  const pages: CrawledPage[] = [];
  const issues: CrawlIssue[] = [];
  let partial = false;
  const browser = await chromium.launch({ headless: true, timeout: 10_000,
    args: options.hostResolverRules ? [`--host-resolver-rules=${options.hostResolverRules}`] : [] });
  const abort = () => { void browser.close().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    // Nothing is ever saved: a link that turns out to be a file is refused, not downloaded in the background.
    const context = await browser.newContext({ userAgent: USER_AGENT, serviceWorkers: 'block', acceptDownloads: false });
    const robotsCache = options.robots ?? createRobotsCache();
    const sameSite = (raw: string) => new URL(raw).hostname.replace(/^www\./, '') === domain;
    // Where a link of the site may lead: the site itself, never another host, port or scheme.
    const onSite = (raw: string) => {
      const url = URL.canParse(raw) ? new URL(raw) : null;
      return !!url && ['https:', 'http:'].includes(url.protocol) && sameSite(url.href) && !url.port && !url.username && !url.password;
    };
    let crawlDelayMs: number | null = null;
    const unreachableReported = new Set<string>();
    async function robotsFor(raw: string): Promise<RobotsPolicy> {
      const policy = await robotsPolicy(new URL(raw).origin, signal, { fetchText: transport.robots, cache: robotsCache });
      if (policy.state === 'unreachable' && !unreachableReported.has(policy.url)) {
        unreachableReported.add(policy.url);
        issues.push({ url: policy.url, code: 'ROBOTS_UNAVAILABLE', status: policy.status, detail: policy.detail ?? undefined, scope: 'robots' });
      }
      if (policy.crawlDelayMs !== null && sameSite(raw)) crawlDelayMs = Math.max(crawlDelayMs ?? 0, policy.crawlDelayMs);
      return policy;
    }
    const robotsIssue = (policy: RobotsPolicy): Omit<CrawlIssue, 'url'> => policy.state === 'unreachable'
      ? { code: 'ROBOTS_UNAVAILABLE', status: policy.status, detail: policy.detail ?? undefined }
      : { code: 'ROBOTS_DISALLOWED', status: null };
    // What the request handler already knows about a page's own navigation when it stops it: robots refused it
    // after a redirect (bare domain to www, or to another path), or the answer is not HTML. The browser only
    // reports a failed navigation, which would be retried and counted as a failure of ours.
    const decided = new WeakMap<import('playwright').Page, Omit<CrawlIssue, 'url'>>();
    const ownPage = (request: import('playwright').Request) => {
      try { const frame = request.frame(); return frame.parentFrame() ? null : frame.page(); }
      catch { return null; /* No frame yet for this navigation: the page loop reports the failed navigation instead. */ }
    };
    await context.route('**/*', async route => {
      const request = route.request();
      try {
        signal.throwIfAborted();
        if (['image', 'media', 'font'].includes(request.resourceType())) { await route.abort(); return; }
        const url = request.url(), navigation = request.isNavigationRequest();
        if (navigation && !canonicalUrl(url, `https://${domain}`)) { await route.abort(); return; }
        // robots.txt speaks for its own host. What a page loads from the firm's host (scripts, XHR, fetch) is the
        // crawler reading that host, so it obeys the rules like a page does. Other hosts are not being crawled, and
        // no navigation reaches another host: the checks above and below stop it first.
        const refusedByRobots = async (target: string) => {
          if (!sameSite(target)) return false;
          const policy = await robotsFor(target);
          if (policy.allows(target)) return false;
          const page = navigation ? ownPage(request) : null;
          if (page) decided.set(page, robotsIssue(policy));
          // A script's request or a frame inside a page: no page of the crawl ends on it, so it is recorded here.
          else issues.push({ url: target, ...robotsIssue(policy), scope: 'request' });
          return true;
        };
        if (await refusedByRobots(url)) { await route.abort(); return; }
        const response = await transport.response(url, signal, request.method(), request.postDataBuffer());
        // Kept for audit, and to say what failed behind a page that then rendered no text.
        if ([401, 403, 429].includes(response.status)) issues.push({ url, code: 'ACCESS_BLOCKED', status: response.status, scope: 'request' });
        else if (response.status >= 500) issues.push({ url, code: 'HTTP_ERROR', status: response.status, scope: 'request' });
        const headers = { ...response.headers };
        // The browser follows a redirect by itself and never shows the next hop to this handler, so where it leads
        // is checked before the redirect is handed over.
        const location = response.status >= 300 && response.status < 400 ? headers['location'] : undefined;
        const target = location && URL.canParse(location, url) ? new URL(location, url) : null;
        // A link that leads off the site (a payment portal, a booking page, a review site) is the site's answer, not
        // a page of the firm. Handed over, the browser would fetch it outside the transport and its public-address
        // check, and keep what it found as the firm's page.
        if (target && navigation && !onSite(target.href)) {
          const away: Omit<CrawlIssue, 'url'> = { code: 'OFF_SITE_REDIRECT', status: response.status, detail: target.hostname };
          const page = ownPage(request);
          if (page) decided.set(page, away); else issues.push({ url, ...away, scope: 'request' });
          await route.abort(); return;
        }
        if (target && ['https:', 'http:'].includes(target.protocol) && await refusedByRobots(target.href)) { await route.abort(); return; }
        // A page link that answers with a file (a .docx, a feed) is not handed to the browser, which would start a download.
        const page = navigation && response.status >= 200 && response.status < 300 && !HTML.test(headers['content-type'] ?? '')
          ? ownPage(request) : null;
        if (page) { decided.set(page, { code: 'NOT_HTML', status: response.status }); await route.abort(); return; }
        for (const name of ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer',
          'transfer-encoding', 'upgrade', 'content-length']) delete headers[name];
        await route.fulfill({ status: response.status, headers, body: response.body });
      } catch (error) {
        issues.push({ url: request.url(), code: 'REQUEST_FAILED', status: null, scope: 'request',
          detail: error instanceof Error ? error.message.slice(0, 200) : 'Unknown transport error' });
        await route.abort().catch(() => {});
      }
    });
    await context.routeWebSocket('**/*', socket => socket.close());
    let queue = [...new Set(options.seedOnly ? [seedUrl] : [rootUrl, seedUrl])].map(url => ({ url, depth: 0, attempt: 0 }));
    const visited = new Set<string>();
    // Links robots.txt excludes. Settled before a batch is picked: they cost no request, so they take no page of the budget.
    const excluded = new Set<string>();
    // Requeued pages leave `visited`, so a retry costs another attempt but never another page budget.
    const fail = (item: { url: string; depth: number; attempt: number }, issue: CrawlIssue) => {
      if (shouldRetryPage(issue, item.attempt, signal.aborted)) {
        visited.delete(item.url);
        queue.push({ ...item, attempt: item.attempt + 1 });
        return;
      }
      issues.push({ ...issue, scope: 'page' });
      if (leavesCrawlPartial(issue)) partial = true;
    };
    const groupCounts = new Map<number, number>();
    const pace = createPacer(pacingBudgetMs(timeoutMs));
    while (queue.length && visited.size < maxPages && !signal.aborted) {
      const allowed: typeof queue = [];
      for (const item of queue) {
        // Only an aborted crawl rejects here, and the loop ends on it.
        const policy = await robotsFor(item.url).catch(() => null);
        if (!policy) break;
        if (policy.allows(item.url)) { allowed.push(item); continue; }
        excluded.add(item.url);
        fail(item, { url: item.url, ...robotsIssue(policy) });
      }
      queue = allowed;
      if (!queue.length || signal.aborted) break;
      // Read per batch: the rules of the site were fetched just above, and the www origin may add its own delay later.
      const delayMs = crawlPacing(crawlDelayMs, { timeoutMs, maxPages });
      queue.sort((a, b) => a.depth - b.depth || pagePriority(a.url) - pagePriority(b.url) || a.url.localeCompare(b.url));
      const capacity = Math.min(options.concurrency ?? CRAWL_CONCURRENCY, maxPages - visited.size);
      // Group limits count the pages picked for this batch too: with a wide batch, counting only pages
      // already read would let one batch fill up with attorney bios.
      const picked = new Map<number, number>();
      const batch: typeof queue = [];
      for (const item of queue) {
        if (batch.length >= capacity) break;
        if (visited.has(item.url)) continue;
        const group = pagePriority(item.url), limit = GROUP_PAGE_LIMITS[group];
        if (limit !== undefined && (groupCounts.get(group) ?? 0) + (picked.get(group) ?? 0) >= limit) continue;
        batch.push(item); picked.set(group, (picked.get(group) ?? 0) + 1);
      }
      // Falling back to over-limit items only once nothing else is queued keeps the reservation from
      // wasting budget: a site with no blog or privacy page should not leave slots unused.
      if (!batch.length) batch.push(...queue.filter(item => !visited.has(item.url)).slice(0, capacity));
      for (const item of batch) queue.splice(queue.indexOf(item), 1);
      for (const item of batch) {
        visited.add(item.url);
        groupCounts.set(pagePriority(item.url), (groupCounts.get(pagePriority(item.url)) ?? 0) + 1);
      }
      await Promise.all(batch.map(async item => {
        // Taken in batch order before anything is awaited, so which page starts first never depends on timing.
        const wait = pace(delayMs);
        // Only the deadline or the caller ends the wait early, and that ends the crawl: the page is not a failure.
        if (wait > 0 && await sleep(wait, false, { signal }).catch(() => true)) return;
        let page: import('playwright').Page | undefined;
        try {
          page = await context.newPage();
          const current = page;
          // Every answer the main frame navigated on: the goto, and any navigation the page starts by itself later (a
          // meta refresh, a script). An aborted request has no answer, so a navigation the handler stopped is not here.
          const navigations: import('playwright').Response[] = [];
          current.on('response', answer => {
            try { if (answer.request().isNavigationRequest() && answer.frame() === current.mainFrame()) navigations.push(answer); }
            catch { /* A request with no frame (a service worker's) is no navigation of this page. */ }
          });
          const response = await current.goto(item.url, { timeout: 8000, waitUntil: 'domcontentloaded' });
          const status = response?.status() ?? null;
          // Only the first hop of each navigation passes the request handler; the browser follows the later ones by
          // itself. So every hop of every navigation of the page, and the URL it is on now, are checked here. A chain
          // that reached another host is not the firm's page, and one that passed a URL robots.txt excludes is not kept,
          // whatever it shows. The browser has already fetched them; this keeps their content out of the evidence
          // (DN-07 §6, known limit). Run before the status (another host's challenge is not the firm refusing) and
          // again after the content is read (the page may have navigated away while the network settled).
          const leftTheSite = async (): Promise<Omit<CrawlIssue, 'url'> | null> => {
            const hops: string[] = [];
            for (const answer of response ? [response, ...navigations] : navigations) {
              const chain: string[] = [];
              for (let hop: import('playwright').Request | null = answer.request(); hop; hop = hop.redirectedFrom()) chain.push(hop.url());
              hops.push(...chain.reverse());
            }
            // Only web addresses: an error page the browser shows for a stopped navigation is not a hop.
            const web = [...new Set([...hops, current.url()])].filter(url => /^https?:/i.test(url));
            const away = web.find(url => !onSite(url));
            if (away) return { code: 'OFF_SITE_REDIRECT', status, detail: URL.canParse(away) ? new URL(away).hostname : undefined };
            for (const hop of web) {
              const policy = await robotsFor(hop);
              if (!policy.allows(hop)) return robotsIssue(policy);
            }
            return null;
          };
          // The page as the reader sees it: no menus, footers or scripts.
          const visibleText = async (target: import('playwright').Page) => {
            await target.locator('nav, footer, script, style, noscript, template, [aria-hidden="true"]').evaluateAll(elements => elements.forEach(element => element.remove()));
            return (await target.locator('body').innerText({ timeout: 1000 })).trim();
          };
          const away = await leftTheSite();
          if (away) { fail(item, { url: item.url, ...away }); return; }
          if (!response || status === null || status >= 400) {
            // Checked before the status: a challenge is a refusal whatever status carries it, never a 503 to retry.
            const challenge = !!response && (status === 403 || status === 429 || (status ?? 0) >= 500) &&
              (response.headers()['cf-mitigated'] === 'challenge' || CHALLENGE_TEXT.test(await visibleText(page).catch(() => '')));
            fail(item, challenge ? { url: item.url, code: 'ACCESS_BLOCKED', status, detail: CHALLENGE_PAGE }
              : { url: item.url, code: status !== null && [401, 403, 429].includes(status) ? 'ACCESS_BLOCKED' : 'HTTP_ERROR', status });
            return;
          }
          if (!HTML.test(response.headers()['content-type'] ?? '')) {
            fail(item, { url: item.url, code: 'NOT_HTML', status });
            return;
          }
          await page.waitForLoadState('networkidle', { timeout: 1500 }).catch(() => {});
          const html = await page.content();
          const links = await page.locator('a[href]').evaluateAll(anchors => anchors.map(a => a.getAttribute('href') ?? ''));
          const text = await visibleText(page);
          // Read first, checked after: a navigation answers before its document replaces the page, so whatever was read
          // came from an answer already in `navigations`.
          const leftLater = await leftTheSite();
          if (leftLater) { fail(item, { url: item.url, ...leftLater }); return; }
          const challenge = CHALLENGE_TEXT.test(text);
          if (!text || challenge) {
            // An empty shell whose script redirect was stopped for a known reason ends for that reason.
            const known = challenge ? undefined : decided.get(page);
            fail(item, known ? { url: item.url, ...known }
              : challenge ? { url: item.url, code: 'ACCESS_BLOCKED', status, detail: CHALLENGE_PAGE }
                : { url: item.url, code: 'NO_READABLE_CONTENT', status });
            return;
          }
          // Store under the canonical (www-stripped) identity, not the raw post-navigation url: a
          // site that redirects the bare domain to www (muscalaw.com does) would otherwise leave this
          // page indexed under a different string than the one every discovered link to it
          // canonicalizes to, so it would look unread the next time such a link surfaces.
          pages.push({ url: canonicalUrl(page.url(), rootUrl) ?? page.url(), html, text });
          if (item.depth < maxDepth) for (const link of links) {
            const url = canonicalUrl(link, page.url());
            if (url && !visited.has(url) && !excluded.has(url) && !queue.some(item => item.url === url)) queue.push({ url, depth: item.depth + 1, attempt: 0 });
          }
        } catch (error) {
          const known = (page && decided.get(page)) ?? (startedDownload(error) ? { code: 'NOT_HTML' as const, status: null } : undefined);
          fail(item, known ? { url: item.url, ...known } : { url: item.url, code: 'REQUEST_FAILED', status: null,
            detail: error instanceof Error ? error.message.slice(0, 200) : 'Unknown navigation error' });
        }
        finally { await page?.close().catch(() => {}); }
      }));
    }
    // A page that only failed on an earlier attempt is not an issue of the finished crawl.
    const read = new Set(pages.map(page => page.url));
    return { pages: pages.sort((a, b) => a.url.localeCompare(b.url)), partial: partial || signal.aborted,
      issues: [...new Map(issues.filter(issue => !read.has(issue.url))
        .map(issue => [`${issue.scope}:${issue.url}:${issue.code}:${issue.status}`, issue])).values()],
      aborted: signal.aborted };
  } finally {
    signal.removeEventListener('abort', abort);
    await browser.close().catch(() => {});
  }
}

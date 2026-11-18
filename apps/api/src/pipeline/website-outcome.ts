import type { SourceStatus } from '@arca/contracts';
import { classifyUnreadableWebsite, type UnreadableWebsite } from '@arca/scoring';
import { isChallenge, leavesCrawlPartial, shouldRetryPage, type CrawlIssue, type CrawlResult } from './crawler.js';

type Cause = { status: 'error' | 'timeout'; code: NonNullable<SourceStatus['code']>; reason: string };
export type UnreadableOutcome = Cause & { classification: UnreadableWebsite };

const pageIssues = (crawl: CrawlResult) => (crawl.issues ?? []).filter(issue => (issue.scope ?? 'page') === 'page');
const http = (status: number | null) => status === null ? 'no answer' : `HTTP ${status}`;

// What the browser could not load for a page that came out empty: the usual reason a client-rendered page has no text.
function behindEmptyPage(crawl: CrawlResult): string {
  const pages = new Set(pageIssues(crawl).map(issue => issue.url));
  const requests = (crawl.issues ?? []).filter(issue => issue.scope === 'request' && !pages.has(issue.url));
  const excluded = requests.filter(issue => issue.code === 'ROBOTS_DISALLOWED').length;
  // A frame sent off the site was stopped by the crawler, not lost to a failure.
  const failed = requests.filter(issue => issue.code !== 'ROBOTS_DISALLOWED' && issue.code !== 'OFF_SITE_REDIRECT').length;
  const notes = [...(failed ? [`${failed} of its requests failed`] : []), ...(excluded ? [`${excluded} excluded by robots.txt`] : [])];
  return notes.length ? ` (${notes.join('; ')})` : '';
}

// The reason is returned by the API: a status code is fine, a raw transport message is not.
function cause(issue: CrawlIssue, crawl: CrawlResult): Cause {
  const error = (code: Cause['code'], reason: string): Cause => ({ status: 'error', code, reason });
  switch (issue.code) {
    case 'ROBOTS_DISALLOWED': return error('ACCESS_BLOCKED', 'robots.txt does not allow automated reading of the website');
    case 'ROBOTS_UNAVAILABLE':
      return error('PROVIDER_ERROR', `robots.txt could not be retrieved (${http(issue.status)}), so the website was not read`);
    case 'ACCESS_BLOCKED':
      // A challenge is the site's refusal whatever status carries it, a 429 included.
      if (isChallenge(issue)) return error('ACCESS_BLOCKED', 'The website answered with a bot challenge page');
      if (issue.status === 429) return error('PROVIDER_ERROR', 'The website is rate limiting requests (HTTP 429)');
      return error('ACCESS_BLOCKED', issue.status === 401 || issue.status === 403
        ? `The website refused automated access (HTTP ${issue.status})` : 'The website answered with a bot challenge page');
    case 'HTTP_ERROR':
      return issue.status === null || issue.status >= 500
        ? error('PROVIDER_ERROR', `The website did not serve its pages (${http(issue.status)})`)
        : error('NO_READABLE_EVIDENCE', `The website has no page to read (HTTP ${issue.status})`);
    case 'NOT_HTML': return error('NO_READABLE_EVIDENCE', 'The website did not return an HTML page');
    // Another domain is not this firm's website, and nothing says the firm's own site will not come back.
    case 'OFF_SITE_REDIRECT':
      return error('NO_READABLE_EVIDENCE', `The website redirects to another domain${issue.detail ? ` (${issue.detail})` : ''}`);
    case 'NO_READABLE_CONTENT':
      return error('NO_READABLE_EVIDENCE', `The website returned a page with no readable text${behindEmptyPage(crawl)}`);
    case 'REQUEST_FAILED': return error('PROVIDER_ERROR', 'The website could not be reached');
  }
}

/**
 * Why a crawl read no page at all, as the website source reports it: the cause picks the code and the reason,
 * and the code alone says whether the outcome is definitive or transient (`classifyUnreadableWebsite`).
 * Only a refusal is definitive: robots.txt excluding the site, or its pages answering 401/403 or a challenge page
 * (whatever status carries the challenge).
 * One passing failure is enough to call the whole outcome transient, and so is a page that came back missing or
 * empty: a result is never kept for the whole cache window while a second scan could still read the site.
 * Either way the scan ends PARTIAL with WEBSITE_UNAVAILABLE (`pagesCrawled: 0` marks it as the site's doing, DN-12 §14);
 * the class only decides how long the scan cache serves it.
 */
export function unreadableWebsite(crawl: CrawlResult): UnreadableOutcome {
  const causes = pageIssues(crawl).map(issue => cause(issue, crawl));
  const chosen: Cause = crawl.aborted
    ? { status: 'timeout', code: 'DEADLINE_REACHED', reason: 'The crawl deadline was reached before any page was read' }
    : causes.find(item => classifyUnreadableWebsite(item) === 'TRANSIENT') ?? causes[0]
      ?? { status: 'error', code: 'PROVIDER_ERROR', reason: 'No page of the website could be read' };
  return { ...chosen, classification: classifyUnreadableWebsite(chosen)! };
}

/**
 * Why a crawl that read pages is still partial, as the code its source reports. The scan cache reads it: a crawl
 * the deadline cut, or one with a page that failed for a passing reason (the kind the crawler itself retries,
 * robots.txt unreachable, or a page that came back empty), is worth another scan. An empty page is transient here
 * for the same reason as in a crawl that read nothing (`unreadableWebsite`): it is what a script that failed to load
 * once leaves behind. No code means every missing page is the site's own answer (a page that refuses: 401/403, a
 * challenge, another 4xx), which a second scan would get again.
 */
export function partialCrawlCode(crawl: CrawlResult): 'DEADLINE_REACHED' | 'PROVIDER_ERROR' | undefined {
  if (crawl.aborted) return 'DEADLINE_REACHED';
  const passing = (issue: CrawlIssue) => issue.code === 'ROBOTS_UNAVAILABLE' || issue.code === 'NO_READABLE_CONTENT' ||
    shouldRetryPage(issue, 0, false);
  return pageIssues(crawl).some(issue => leavesCrawlPartial(issue) && passing(issue)) ? 'PROVIDER_ERROR' : undefined;
}

/** What the crawl left out of a site it did read, for the source's reason text. Null when it left nothing out. */
export function crawlNotes(crawl: CrawlResult): string | null {
  const issues = pageIssues(crawl);
  const count = (label: [string, string], test: (issue: CrawlIssue) => boolean) => {
    const found = issues.filter(test).length;
    return found ? [`${found} ${found === 1 ? label[0] : label[1]}`] : [];
  };
  const notes = [
    ...(crawl.aborted ? ['Crawl deadline reached'] : []),
    ...count(['page could not be read', 'pages could not be read'], leavesCrawlPartial),
    ...count(['page excluded by robots.txt', 'pages excluded by robots.txt'], issue => issue.code === 'ROBOTS_DISALLOWED'),
    ...count(['dead link (HTTP 404/410)', 'dead links (HTTP 404/410)'], issue => issue.code === 'HTTP_ERROR' && !leavesCrawlPartial(issue)),
    ...count(['link to non-HTML content', 'links to non-HTML content'], issue => issue.code === 'NOT_HTML'),
    ...count(['link redirecting to another site', 'links redirecting to another site'], issue => issue.code === 'OFF_SITE_REDIRECT'),
  ];
  return notes.length ? notes.join('; ') : null;
}

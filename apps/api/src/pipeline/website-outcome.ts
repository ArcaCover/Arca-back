import type { SourceStatus } from '@arca/contracts';
import { classifyUnreadableWebsite, type UnreadableWebsite } from '@arca/scoring';
import { leavesCrawlPartial, type CrawlIssue, type CrawlResult } from './crawler.js';

type Cause = { status: 'error' | 'timeout'; code: NonNullable<SourceStatus['code']>; reason: string };
export type UnreadableOutcome = Cause & { classification: UnreadableWebsite };

const pageIssues = (crawl: CrawlResult) => (crawl.issues ?? []).filter(issue => (issue.scope ?? 'page') === 'page');
const http = (status: number | null) => status === null ? 'no answer' : `HTTP ${status}`;

// What the browser could not load for a page that came out empty: the usual reason a client-rendered page has no text.
function behindEmptyPage(crawl: CrawlResult): string {
  const pages = new Set(pageIssues(crawl).map(issue => issue.url));
  const requests = (crawl.issues ?? []).filter(issue => issue.scope === 'request' && !pages.has(issue.url));
  const excluded = requests.filter(issue => issue.code === 'ROBOTS_DISALLOWED').length, failed = requests.length - excluded;
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
      if (issue.status === 429) return error('PROVIDER_ERROR', 'The website is rate limiting requests (HTTP 429)');
      return error('ACCESS_BLOCKED', issue.status === 401 || issue.status === 403
        ? `The website refused automated access (HTTP ${issue.status})` : 'The website answered with a bot challenge page');
    case 'HTTP_ERROR':
      return issue.status === null || issue.status >= 500
        ? error('PROVIDER_ERROR', `The website did not serve its pages (${http(issue.status)})`)
        : error('NO_READABLE_EVIDENCE', `The website has no page to read (HTTP ${issue.status})`);
    case 'NOT_HTML': return error('NO_READABLE_EVIDENCE', 'The website did not return an HTML page');
    case 'NO_READABLE_CONTENT':
      return error('NO_READABLE_EVIDENCE', `The website returned a page with no readable text${behindEmptyPage(crawl)}`);
    case 'REQUEST_FAILED': return error('PROVIDER_ERROR', 'The website could not be reached');
  }
}

/**
 * Why a crawl read no page at all, as the website source reports it: the cause picks the code and the reason,
 * and the code alone says whether the outcome is definitive or transient (`classifyUnreadableWebsite`).
 * Only a refusal is definitive: robots.txt excluding the site, or its pages answering 401/403 or a challenge page.
 * One passing failure is enough to call the whole outcome transient, and so is a page that came back missing or
 * empty: a firm is never branded unreadable while a second scan could still read it.
 */
export function unreadableWebsite(crawl: CrawlResult): UnreadableOutcome {
  const causes = pageIssues(crawl).map(issue => cause(issue, crawl));
  const chosen: Cause = crawl.aborted
    ? { status: 'timeout', code: 'DEADLINE_REACHED', reason: 'The crawl deadline was reached before any page was read' }
    : causes.find(item => classifyUnreadableWebsite(item) === 'TRANSIENT') ?? causes[0]
      ?? { status: 'error', code: 'PROVIDER_ERROR', reason: 'No page of the website could be read' };
  return { ...chosen, classification: classifyUnreadableWebsite(chosen)! };
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
  ];
  return notes.length ? notes.join('; ') : null;
}

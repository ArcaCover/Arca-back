import { describe, expect, it } from 'vitest';
import { SourceStatus } from '@arca/contracts';
import { classifyUnreadableWebsite } from '@arca/scoring';
import type { CrawlIssue, CrawlResult } from '../../src/pipeline/crawler.js';
import { crawlNotes, unreadableWebsite } from '../../src/pipeline/website-outcome.js';

const home = 'https://firm.com/';
const page = (code: CrawlIssue['code'], status: number | null = null, url = home): CrawlIssue => ({ url, code, status, scope: 'page' });
const request = (code: CrawlIssue['code'], status: number | null, url: string): CrawlIssue => ({ url, code, status, scope: 'request' });
const unread = (issues: CrawlIssue[], aborted = false): CrawlResult => ({ pages: [], partial: true, issues, aborted });

describe('why a website could not be read', () => {
  // Every way a crawl can end without a page, with the code and the class the source must report for it.
  const outcomes: Array<[string, CrawlResult, 'DEFINITIVE' | 'TRANSIENT', 'error' | 'timeout', string, RegExp]> = [
    ['robots.txt disallows the site', unread([page('ROBOTS_DISALLOWED')]), 'DEFINITIVE', 'error', 'ACCESS_BLOCKED', /robots\.txt does not allow/],
    ['the pages answer 401', unread([page('ACCESS_BLOCKED', 401)]), 'DEFINITIVE', 'error', 'ACCESS_BLOCKED', /HTTP 401/],
    ['the pages answer 403', unread([page('ACCESS_BLOCKED', 403)]), 'DEFINITIVE', 'error', 'ACCESS_BLOCKED', /HTTP 403/],
    ['a challenge page', unread([page('ACCESS_BLOCKED', 200)]), 'DEFINITIVE', 'error', 'ACCESS_BLOCKED', /challenge page/],
    // Not on the definitive list: none of these is the site refusing to be read, and an empty page is what a
    // script that failed to load once leaves behind.
    ['the home page does not exist', unread([page('HTTP_ERROR', 404)]), 'TRANSIENT', 'error', 'NO_READABLE_EVIDENCE', /HTTP 404/],
    ['the home page is gone', unread([page('HTTP_ERROR', 410)]), 'TRANSIENT', 'error', 'NO_READABLE_EVIDENCE', /HTTP 410/],
    ['the home page is not HTML', unread([page('NOT_HTML', 200)]), 'TRANSIENT', 'error', 'NO_READABLE_EVIDENCE', /HTML/],
    ['the home page has no text', unread([page('NO_READABLE_CONTENT', 200)]), 'TRANSIENT', 'error', 'NO_READABLE_EVIDENCE', /no readable text$/],
    ['the home page has no text after its own script answered 503', unread([page('NO_READABLE_CONTENT', 200), request('HTTP_ERROR', 503, 'https://firm.com/app.js')]),
      'TRANSIENT', 'error', 'NO_READABLE_EVIDENCE', /no readable text \(1 of its requests failed\)/],
    ['the home page has no text after a third-party script failed', unread([request('REQUEST_FAILED', null, 'https://cdn.example/app.js'), page('NO_READABLE_CONTENT', 200)]),
      'TRANSIENT', 'error', 'NO_READABLE_EVIDENCE', /no readable text \(1 of its requests failed\)/],
    ['the home page has no text and robots.txt excludes what it loads', unread([page('NO_READABLE_CONTENT', 200),
      request('ROBOTS_DISALLOWED', null, 'https://firm.com/assets/app.js'), request('ROBOTS_DISALLOWED', null, 'https://firm.com/assets/data.json'),
      request('ACCESS_BLOCKED', 429, 'https://firm.com/api')]),
      'TRANSIENT', 'error', 'NO_READABLE_EVIDENCE', /no readable text \(1 of its requests failed; 2 excluded by robots\.txt\)/],
    ['the crawl deadline', unread([], true), 'TRANSIENT', 'timeout', 'DEADLINE_REACHED', /deadline/],
    ['an abort after a definitive answer', unread([page('ACCESS_BLOCKED', 403)], true), 'TRANSIENT', 'timeout', 'DEADLINE_REACHED', /deadline/],
    ['a network error', unread([page('REQUEST_FAILED')]), 'TRANSIENT', 'error', 'PROVIDER_ERROR', /could not be reached/],
    ['robots.txt answers 503', unread([page('ROBOTS_UNAVAILABLE', 503)]), 'TRANSIENT', 'error', 'PROVIDER_ERROR', /robots\.txt could not be retrieved \(HTTP 503\)/],
    ['robots.txt answers 429', unread([page('ROBOTS_UNAVAILABLE', 429)]), 'TRANSIENT', 'error', 'PROVIDER_ERROR', /robots\.txt could not be retrieved \(HTTP 429\)/],
    ['robots.txt does not answer', unread([page('ROBOTS_UNAVAILABLE')]), 'TRANSIENT', 'error', 'PROVIDER_ERROR', /robots\.txt could not be retrieved \(no answer\)/],
    ['the pages answer 429', unread([page('ACCESS_BLOCKED', 429)]), 'TRANSIENT', 'error', 'PROVIDER_ERROR', /rate limiting/],
    ['the pages answer 500', unread([page('HTTP_ERROR', 500)]), 'TRANSIENT', 'error', 'PROVIDER_ERROR', /HTTP 500/],
    ['the pages answer 503', unread([page('HTTP_ERROR', 503)]), 'TRANSIENT', 'error', 'PROVIDER_ERROR', /HTTP 503/],
    ['no answer at all', unread([page('HTTP_ERROR')]), 'TRANSIENT', 'error', 'PROVIDER_ERROR', /no answer/],
    ['no cause on record', unread([]), 'TRANSIENT', 'error', 'PROVIDER_ERROR', /No page/],
  ];

  it.each(outcomes)('%s', (_name, crawl, classification, status, code, reason) => {
    const outcome = unreadableWebsite(crawl);
    expect(outcome).toMatchObject({ classification, status, code });
    expect(outcome.reason).toMatch(reason);
    // The code alone carries the class: the pipeline and the scan cache only ever see the status.
    expect(classifyUnreadableWebsite(outcome)).toBe(classification);
    // Existing contract values only.
    expect(() => SourceStatus.parse({ status, code, reason: outcome.reason, dataStatus: 'UNKNOWN', durationMs: 0, pagesCrawled: 0 })).not.toThrow();
  });

  it('is transient as soon as one page failed for a passing reason', () => {
    const crawl = unread([page('ACCESS_BLOCKED', 403), page('REQUEST_FAILED', null, 'https://firm.com/about')]);
    expect(unreadableWebsite(crawl)).toMatchObject({ classification: 'TRANSIENT', code: 'PROVIDER_ERROR' });
  });

  it('judges a refusal by the page, not by the requests behind it', () => {
    // A third-party widget that failed and the firm's own robots.txt failing for the www origin only:
    // neither changes that the page itself answered 403.
    const crawl = unread([
      request('REQUEST_FAILED', null, 'https://widgets.example/w.js'),
      { url: 'https://www.firm.com/robots.txt', code: 'ROBOTS_UNAVAILABLE', status: 503, scope: 'robots' },
      page('ACCESS_BLOCKED', 403),
    ]);
    expect(unreadableWebsite(crawl)).toMatchObject({ classification: 'DEFINITIVE', code: 'ACCESS_BLOCKED' });
  });

  it('does not count the failed navigation of another page among the requests behind an empty page', () => {
    const crawl = unread([page('NO_READABLE_CONTENT', 200), page('HTTP_ERROR', 500, 'https://firm.com/start'),
      request('HTTP_ERROR', 500, 'https://firm.com/start')]);
    expect(unreadableWebsite(crawl).reason).toBe('The website returned a page with no readable text');
  });

  it('reads an issue stored without a scope as a page issue', () => {
    expect(unreadableWebsite(unread([{ url: home, code: 'ACCESS_BLOCKED', status: 403 }])))
      .toMatchObject({ classification: 'DEFINITIVE', code: 'ACCESS_BLOCKED' });
  });

  it('never puts a transport message in the reason the API returns', () => {
    const outcome = unreadableWebsite(unread([{ ...page('REQUEST_FAILED'), detail: 'getaddrinfo ENOTFOUND internal-host' }]));
    expect(outcome.reason).not.toContain('ENOTFOUND');
  });
});

describe('what a crawl left out of a site it read', () => {
  const read = (issues: CrawlIssue[], aborted = false): CrawlResult =>
    ({ pages: [{ url: home, html: '', text: 'Firm' }], partial: aborted, issues, aborted });

  it('says nothing about a clean crawl', () => {
    expect(crawlNotes(read([]))).toBeNull();
    expect(crawlNotes({ pages: [{ url: home, html: '', text: 'Firm' }], partial: false })).toBeNull();
  });

  it('counts what was excluded, dead or not HTML', () => {
    expect(crawlNotes(read([page('ROBOTS_DISALLOWED', null, 'https://firm.com/wp-admin/'), page('ROBOTS_DISALLOWED', null, 'https://firm.com/portal'),
      page('HTTP_ERROR', 404, 'https://firm.com/old'), page('NOT_HTML', 200, 'https://firm.com/feed')])))
      .toBe('2 pages excluded by robots.txt; 1 dead link (HTTP 404/410); 1 link to non-HTML content');
  });

  it('names the failures and the deadline that make a crawl partial', () => {
    expect(crawlNotes(read([page('HTTP_ERROR', 500, 'https://firm.com/team'), page('ROBOTS_DISALLOWED', null, 'https://firm.com/x')], true)))
      .toBe('Crawl deadline reached; 1 page could not be read; 1 page excluded by robots.txt');
  });

  it('leaves subresources out of the counts', () => {
    expect(crawlNotes(read([{ url: 'https://cdn.example/w.js', code: 'REQUEST_FAILED', status: null, scope: 'request' },
      { url: 'https://firm.com/wp-json/x', code: 'ROBOTS_DISALLOWED', status: null, scope: 'request' }]))).toBeNull();
  });
});

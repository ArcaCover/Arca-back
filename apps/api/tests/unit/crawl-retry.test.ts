import { describe, it, expect } from 'vitest';
import { CRAWL_CONCURRENCY, MAX_PAGE_ATTEMPTS, crawlPacing, leavesCrawlPartial, shouldRetryPage } from '../../src/pipeline/crawler.js';

const issue = (code: Parameters<typeof shouldRetryPage>[0]['code'], status: number | null = null) =>
  ({ url: 'https://firm.com/about', code, status });

describe('crawl page retries', () => {
  it('retries a transient navigation failure until the attempt cap', () => {
    expect(shouldRetryPage(issue('REQUEST_FAILED'), 0, false)).toBe(true);
    expect(shouldRetryPage(issue('REQUEST_FAILED'), 1, false)).toBe(true);
  });

  it('stops once the page has used every allowed attempt', () => {
    expect(shouldRetryPage(issue('REQUEST_FAILED'), MAX_PAGE_ATTEMPTS - 1, false)).toBe(false);
    expect(shouldRetryPage(issue('REQUEST_FAILED'), MAX_PAGE_ATTEMPTS, false)).toBe(false);
  });

  it('never retries after the crawl deadline has aborted the browser', () => {
    expect(shouldRetryPage(issue('REQUEST_FAILED'), 0, true)).toBe(false);
  });

  it('retries server errors and rate limiting but not deterministic rejections', () => {
    expect(shouldRetryPage(issue('HTTP_ERROR', 503), 0, false)).toBe(true);
    expect(shouldRetryPage(issue('ACCESS_BLOCKED', 429), 0, false)).toBe(true);
    expect(shouldRetryPage(issue('HTTP_ERROR', 404), 0, false)).toBe(false);
    expect(shouldRetryPage(issue('ACCESS_BLOCKED', 403), 0, false)).toBe(false);
    expect(shouldRetryPage(issue('ROBOTS_DISALLOWED'), 0, false)).toBe(false);
    expect(shouldRetryPage(issue('NO_READABLE_CONTENT', 200), 0, false)).toBe(false);
    expect(shouldRetryPage(issue('NOT_HTML', 200), 0, false)).toBe(false);
    // The scan keeps one robots answer per origin, so asking again cannot change it.
    expect(shouldRetryPage(issue('ROBOTS_UNAVAILABLE', 503), 0, false)).toBe(false);
  });

  it('allows three attempts per page by default', () => {
    expect(MAX_PAGE_ATTEMPTS).toBe(3);
  });
});

describe('what leaves a crawl partial', () => {
  it('does not count a page the site decided or that does not exist', () => {
    expect(leavesCrawlPartial(issue('ROBOTS_DISALLOWED'))).toBe(false);
    expect(leavesCrawlPartial(issue('HTTP_ERROR', 404))).toBe(false);
    expect(leavesCrawlPartial(issue('HTTP_ERROR', 410))).toBe(false);
    expect(leavesCrawlPartial(issue('NOT_HTML', 200))).toBe(false);
  });

  it('counts a page of the site that failed', () => {
    expect(leavesCrawlPartial(issue('REQUEST_FAILED'))).toBe(true);
    expect(leavesCrawlPartial(issue('HTTP_ERROR', 500))).toBe(true);
    expect(leavesCrawlPartial(issue('HTTP_ERROR', null))).toBe(true);
    expect(leavesCrawlPartial(issue('HTTP_ERROR', 400))).toBe(true);
    expect(leavesCrawlPartial(issue('ACCESS_BLOCKED', 403))).toBe(true);
    expect(leavesCrawlPartial(issue('ACCESS_BLOCKED', 429))).toBe(true);
    expect(leavesCrawlPartial(issue('NO_READABLE_CONTENT', 200))).toBe(true);
    expect(leavesCrawlPartial(issue('ROBOTS_UNAVAILABLE', 503))).toBe(true);
  });
});

describe('crawl pacing under Crawl-delay', () => {
  const limits = { timeoutMs: 30_000, maxPages: 20, concurrency: CRAWL_CONCURRENCY };

  it('crawls at full width when the site declares no delay', () => {
    expect(crawlPacing(null, limits)).toEqual({ concurrency: CRAWL_CONCURRENCY, delayMs: 0 });
  });

  it('reads one page at a time with the declared pause', () => {
    expect(crawlPacing(500, limits)).toEqual({ concurrency: 1, delayMs: 500 });
  });

  it('caps the pause so that waiting alone cannot use up the crawl deadline', () => {
    const paced = crawlPacing(10_000, limits);
    expect(paced).toEqual({ concurrency: 1, delayMs: 1_500 });
    expect(paced.delayMs * (limits.maxPages - 1)).toBeLessThan(limits.timeoutMs);
  });
});

import { describe, it, expect } from 'vitest';
import { CRAWL_CONCURRENCY, MAX_PAGE_ATTEMPTS, crawlPacing, createPacer, leavesCrawlPartial, pacingBudgetMs, shouldRetryPage }
  from '../../src/pipeline/crawler.js';

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
    expect(shouldRetryPage(issue('OFF_SITE_REDIRECT', 302), 0, false)).toBe(false);
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
    expect(leavesCrawlPartial(issue('OFF_SITE_REDIRECT', 302))).toBe(false);
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
  const limits = { timeoutMs: 30_000, maxPages: 20 };

  it('does not pace a site that declares no delay', () => {
    expect(crawlPacing(null, limits)).toBe(0);
  });

  it('keeps a short declared pause as it is', () => {
    expect(crawlPacing(200, limits)).toBe(200);
  });

  it('caps the pause so that the whole page budget waits at most a quarter of the deadline', () => {
    expect(pacingBudgetMs(limits.timeoutMs)).toBe(7_500);
    expect(crawlPacing(10_000, limits)).toBe(375);
    expect(crawlPacing(10_000, limits) * limits.maxPages).toBeLessThanOrEqual(limits.timeoutMs / 4);
  });

  it('spaces the starts of one batch by the pause, in call order', () => {
    const pace = createPacer(7_500, () => 1_000);
    expect([pace(375), pace(375), pace(375), pace(375)]).toEqual([0, 375, 750, 1_125]);
  });

  it('does not make a later batch wait when the pages took longer than the pause', () => {
    let now = 0;
    const pace = createPacer(7_500, () => now);
    expect([pace(375), pace(375)]).toEqual([0, 375]);
    // The batch took 3 s to load: the last start is far enough behind.
    now = 3_000;
    expect([pace(375), pace(375)]).toEqual([0, 375]);
  });

  it('stops waiting once the time the spacing added reaches its budget', () => {
    let now = 0;
    const pace = createPacer(1_000, () => now);
    const waits = Array.from({ length: 6 }, () => pace(375));
    // 375 + 375 + 250: the budget is spent, and every later start goes with the last one, adding nothing.
    expect(waits).toEqual([0, 375, 750, 1_000, 1_000, 1_000]);
    now = 5_000;
    expect([pace(375), pace(375)]).toEqual([0, 0]);
  });

  it('never makes a crawl at the defaults wait past the budget, however many attempts it makes', () => {
    let now = 0;
    const pace = createPacer(pacingBudgetMs(30_000), () => now);
    let latest = 0;
    // Three attempts for each of 20 pages, six at a time, with no load time at all: the worst case for the spacing.
    for (let batch = 0; batch < 10; batch++) {
      const waits = Array.from({ length: CRAWL_CONCURRENCY }, () => pace(crawlPacing(10_000, limits)));
      latest = now + Math.max(...waits);
      now = latest;
    }
    expect(latest).toBeLessThanOrEqual(7_500);
  });
});

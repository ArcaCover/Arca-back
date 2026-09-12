import { describe, it, expect } from 'vitest';
import { MAX_PAGE_ATTEMPTS, shouldRetryPage } from '../../src/pipeline/crawler.js';

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
  });

  it('allows three attempts per page by default', () => {
    expect(MAX_PAGE_ATTEMPTS).toBe(3);
  });
});

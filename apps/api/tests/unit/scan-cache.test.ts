import { describe, expect, it } from 'vitest';
import type { SourceStatus } from '@arca/contracts';
import type { CrawlIssue, CrawlResult } from '../../src/pipeline/crawler.js';
import { unreadableWebsite } from '../../src/pipeline/website-outcome.js';
import { answersFromCache, directoryDegradation, resultDegradation, websiteDegradation,
  type Degradation } from '../../src/http/scan-cache.js';

type Cause = Pick<SourceStatus, 'status' | 'code'>;
const ok: Cause = { status: 'ok' };

describe('why a stored source is degraded (DN-12 §4.2)', () => {
  const website: Array<[string, Cause, Degradation]> = [
    ['read in full', { status: 'ok' }, 'NONE'],
    ['read as far as the site allows, or stored before the code existed', { status: 'partial' }, 'STRUCTURAL'],
    ['a crawl cut by the deadline', { status: 'partial', code: 'DEADLINE_REACHED' }, 'TRANSIENT'],
    ['a page that failed for a passing reason or came back empty', { status: 'partial', code: 'PROVIDER_ERROR' }, 'TRANSIENT'],
    ['the site refuses to be read (WEBSITE_UNAVAILABLE)', { status: 'error', code: 'ACCESS_BLOCKED' }, 'STRUCTURAL'],
    ['no page had readable text', { status: 'error', code: 'NO_READABLE_EVIDENCE' }, 'TRANSIENT'],
    ['the site or the extraction failed', { status: 'error', code: 'PROVIDER_ERROR' }, 'TRANSIENT'],
    ['the deadline came before any page', { status: 'timeout', code: 'DEADLINE_REACHED' }, 'TRANSIENT'],
    ['a refusal reported as a timeout', { status: 'timeout', code: 'ACCESS_BLOCKED' }, 'TRANSIENT'],
    ['an error nobody named', { status: 'error' }, 'TRANSIENT'],
  ];
  it.each(website)('website: %s', (_name, status, expected) => {
    expect(websiteDegradation(status)).toBe(expected);
  });

  const directory: Array<[string, Cause, Degradation]> = [
    ['answered in full', { status: 'ok' }, 'NONE'],
    ['answered, nobody matched', { status: 'ok', code: 'NO_MATCH' }, 'NONE'],
    ['skipped: the website shows no attorney or city', { status: 'skipped', code: 'INSUFFICIENT_IDENTITY' }, 'STRUCTURAL'],
    ['nobody matched, on a status that is not ok', { status: 'partial', code: 'NO_MATCH' }, 'STRUCTURAL'],
    ['a full result page', { status: 'partial', code: 'TRUNCATED' }, 'STRUCTURAL'],
    ['some lookups cut by the deadline', { status: 'partial', code: 'DEADLINE_REACHED' }, 'TRANSIENT'],
    ['every lookup cut by the deadline', { status: 'timeout', code: 'DEADLINE_REACHED' }, 'TRANSIENT'],
    ['a timeout whatever its code', { status: 'timeout', code: 'TRUNCATED' }, 'TRANSIENT'],
    ['some lookups failed, or the usage limit was reached', { status: 'partial', code: 'PROVIDER_ERROR' }, 'TRANSIENT'],
    ['the provider was down', { status: 'error', code: 'PROVIDER_ERROR' }, 'TRANSIENT'],
    ['the provider answered in another shape', { status: 'partial', code: 'PROVIDER_CONTRACT_ERROR' }, 'TRANSIENT'],
    ['an error nobody named', { status: 'error' }, 'TRANSIENT'],
    ['skipped without a code', { status: 'skipped' }, 'TRANSIENT'],
  ];
  it.each(directory)('directory: %s', (_name, status, expected) => {
    expect(directoryDegradation(status)).toBe(expected);
  });

  it('takes the worst of the three sources', () => {
    expect(resultDegradation({ website: ok, bar: ok, avvo: ok })).toBe('NONE');
    expect(resultDegradation({ website: ok, bar: ok, avvo: { status: 'skipped', code: 'INSUFFICIENT_IDENTITY' } })).toBe('STRUCTURAL');
    expect(resultDegradation({ website: { status: 'partial' }, bar: { status: 'error', code: 'PROVIDER_ERROR' },
      avvo: { status: 'skipped', code: 'INSUFFICIENT_IDENTITY' } })).toBe('TRANSIENT');
  });
});

describe('whether a stored scan answers a new request', () => {
  const HOUR = 3_600_000, now = Date.parse('2026-11-09T12:00:00.000Z');
  const ago = (ms: number) => new Date(now - ms).toISOString();
  const skipped: Cause = { status: 'skipped', code: 'INSUFFICIENT_IDENTITY' };
  const stored = (status: 'COMPLETED' | 'PARTIAL' | 'FAILED' | 'RUNNING', sources: { website: Cause; bar: Cause; avvo: Cause } | null,
    completedAgo: number) => ({ status, result: sources && { sources: sources as never }, completed_at: ago(completedAgo) });

  it('serves a completed scan and a structural partial for the whole window', () => {
    expect(answersFromCache(stored('COMPLETED', { website: ok, bar: ok, avvo: ok }, 6 * 24 * HOUR), now, HOUR)).toBe(true);
    expect(answersFromCache(stored('PARTIAL', { website: ok, bar: ok, avvo: skipped }, 6 * 24 * HOUR), now, HOUR)).toBe(true);
    // The blocked-site outcome (DN-12 §14): the website refuses and no directory was asked.
    expect(answersFromCache(stored('PARTIAL', { website: { status: 'error', code: 'ACCESS_BLOCKED' }, bar: skipped, avvo: skipped },
      6 * 24 * HOUR), now, HOUR)).toBe(true);
  });
  it('serves the scan of 2026-11-06 as it was stored: nothing passing is recorded in it', () => {
    // immigrationlawfla.com: website partial with data and no code, Avvo skipped for identity, Bar ok.
    expect(answersFromCache(stored('PARTIAL', { website: { status: 'partial' }, bar: ok, avvo: skipped }, 3 * 24 * HOUR), now, HOUR)).toBe(true);
  });
  it('serves a partial with a passing failure only until the repair cooldown ends', () => {
    const transient = { website: ok, bar: ok, avvo: { status: 'error', code: 'PROVIDER_ERROR' } as Cause };
    expect(answersFromCache(stored('PARTIAL', transient, 10 * 60_000), now, HOUR)).toBe(true);
    expect(answersFromCache(stored('PARTIAL', transient, HOUR), now, HOUR)).toBe(false);
    // A cooldown of 0 repairs on every request.
    expect(answersFromCache(stored('PARTIAL', transient, 1), now, 0)).toBe(false);
    expect(answersFromCache({ ...stored('PARTIAL', transient, 0), completed_at: null }, now, HOUR)).toBe(false);
  });
  it('never serves a scan without a result, or one that is not finished', () => {
    expect(answersFromCache(stored('FAILED', null, 0), now, HOUR)).toBe(false);
    expect(answersFromCache(stored('COMPLETED', null, 0), now, HOUR)).toBe(false);
    expect(answersFromCache(stored('RUNNING', { website: ok, bar: ok, avvo: ok }, 0), now, HOUR)).toBe(false);
  });
});

describe('a PARTIAL whose website could not be read at all (WEBSITE_UNAVAILABLE, DN-12 §14)', () => {
  const HOUR = 3_600_000, now = Date.parse('2026-11-17T12:00:00.000Z');
  const home = 'https://firm.com/';
  const page = (code: CrawlIssue['code'], status: number | null = null): CrawlIssue => ({ url: home, code, status, scope: 'page' });
  const skipped: Cause = { status: 'skipped', code: 'INSUFFICIENT_IDENTITY' };
  // The website status the real outcome table gives for each cause, so the cache is tested on what the pipeline stores.
  const website = (crawl: Partial<CrawlResult>) => {
    const { classification: _classification, ...status } = unreadableWebsite({ pages: [], partial: true, issues: [], ...crawl });
    return status;
  };
  const stored = (crawl: Partial<CrawlResult>, completedAgo: number) => ({ status: 'PARTIAL' as const,
    result: { sources: { website: website(crawl), bar: skipped, avvo: skipped } as never },
    completed_at: new Date(now - completedAgo).toISOString() });

  it.each<[string, Partial<CrawlResult>]>([
    ['robots.txt disallows the site', { issues: [page('ROBOTS_DISALLOWED')] }],
    ['its pages answer 401', { issues: [page('ACCESS_BLOCKED', 401)] }],
    ['its pages answer 403', { issues: [page('ACCESS_BLOCKED', 403)] }],
    ['it answers with a challenge page', { issues: [page('ACCESS_BLOCKED', 503)] }],
  ])('keeps a definitive refusal for the whole window: %s', (_name, crawl) => {
    expect(websiteDegradation(website(crawl))).toBe('STRUCTURAL');
    expect(answersFromCache(stored(crawl, 10 * 60_000), now, HOUR)).toBe(true);
    expect(answersFromCache(stored(crawl, 6 * 24 * HOUR), now, HOUR)).toBe(true);
  });

  it.each<[string, Partial<CrawlResult>]>([
    ['the host name does not resolve or the connection fails', { issues: [page('REQUEST_FAILED')] }],
    ['the crawl deadline passed before any page', { aborted: true }],
    ['its pages answer 503', { issues: [page('HTTP_ERROR', 503)] }],
    ['its pages answer 429', { issues: [page('ACCESS_BLOCKED', 429)] }],
    ['robots.txt answered 503', { issues: [page('ROBOTS_UNAVAILABLE', 503)] }],
    ['robots.txt answered 429', { issues: [page('ROBOTS_UNAVAILABLE', 429)] }],
    ['robots.txt could not be reached', { issues: [page('ROBOTS_UNAVAILABLE', null)] }],
    ['the home page came back empty', { issues: [page('NO_READABLE_CONTENT', 200)] }],
  ])('repairs a transient cause after the cooldown: %s', (_name, crawl) => {
    expect(websiteDegradation(website(crawl))).toBe('TRANSIENT');
    expect(answersFromCache(stored(crawl, 10 * 60_000), now, HOUR)).toBe(true);
    expect(answersFromCache(stored(crawl, HOUR + 1), now, HOUR)).toBe(false);
  });
});

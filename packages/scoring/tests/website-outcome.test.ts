import { describe, expect, it } from 'vitest';
import { SourceIssueCode } from '@arca/contracts';
import { DEFINITIVE_UNREADABLE_CODES, LAYER1_UNAVAILABLE, WEBSITE_UNAVAILABLE, classifyUnreadableWebsite,
  isWebsiteUnavailable } from '../src/index.js';

describe('unreadable website classification', () => {
  it('has nothing to say about a website that was read', () => {
    expect(classifyUnreadableWebsite({ status: 'ok' })).toBeNull();
    expect(classifyUnreadableWebsite({ status: 'partial' })).toBeNull();
  });

  it('calls the refusal of the site definitive', () => {
    expect(classifyUnreadableWebsite({ status: 'error', code: 'ACCESS_BLOCKED' })).toBe('DEFINITIVE');
  });

  it('does not call a page that came back empty or missing definitive', () => {
    // A script that failed to load once leaves the same empty page as a site with nothing on it.
    expect(classifyUnreadableWebsite({ status: 'error', code: 'NO_READABLE_EVIDENCE' })).toBe('TRANSIENT');
  });

  it('calls every other code transient', () => {
    for (const code of SourceIssueCode.options.filter(option => !DEFINITIVE_UNREADABLE_CODES.has(option))) {
      expect([code, classifyUnreadableWebsite({ status: 'error', code })]).toEqual([code, 'TRANSIENT']);
    }
    expect([...DEFINITIVE_UNREADABLE_CODES].sort()).toEqual(['ACCESS_BLOCKED']);
  });

  it('never calls a timeout or an unexplained failure definitive', () => {
    expect(classifyUnreadableWebsite({ status: 'timeout', code: 'DEADLINE_REACHED' })).toBe('TRANSIENT');
    expect(classifyUnreadableWebsite({ status: 'timeout', code: 'ACCESS_BLOCKED' })).toBe('TRANSIENT');
    expect(classifyUnreadableWebsite({ status: 'error' })).toBe('TRANSIENT');
    expect(classifyUnreadableWebsite({ status: 'skipped' })).toBe('TRANSIENT');
  });
});

describe('a website the site itself kept us from reading (WEBSITE_UNAVAILABLE)', () => {
  // The line between the site and us (DN-12 §14): the website source reports `pagesCrawled: 0` only for a crawl that read
  // no page, whatever the site did. Our own failures report no count (the pipeline's deadline, a source that threw) or
  // the pages that were read (the extraction failing on them).
  it.each<[string, Parameters<typeof isWebsiteUnavailable>[0]]>([
    ['robots.txt excludes the site', { status: 'error', code: 'ACCESS_BLOCKED', pagesCrawled: 0 }],
    ['the site could not be reached, answered 5xx or rate limited us', { status: 'error', code: 'PROVIDER_ERROR', pagesCrawled: 0 }],
    ['the home page came back empty, missing or redirected away', { status: 'error', code: 'NO_READABLE_EVIDENCE', pagesCrawled: 0 }],
    ['the crawl deadline came before any page', { status: 'timeout', code: 'DEADLINE_REACHED', pagesCrawled: 0 }],
    ['a site-side failure with no code', { status: 'error', pagesCrawled: 0 }],
  ])('is the site when %s', (_name, status) => {
    expect(isWebsiteUnavailable(status)).toBe(true);
  });

  it.each<[string, Parameters<typeof isWebsiteUnavailable>[0]]>([
    ['the extraction failed on pages that were read', { status: 'error', code: 'PROVIDER_ERROR', pagesCrawled: 4 }],
    ['our deadline cut the extraction of pages that were read', { status: 'timeout', code: 'DEADLINE_REACHED', pagesCrawled: 4 }],
    ['the pipeline deadline cut the source', { status: 'timeout', code: 'DEADLINE_REACHED' }],
    ['the source threw', { status: 'error', code: 'PROVIDER_ERROR' }],
    ['the website was read', { status: 'ok', pagesCrawled: 0 }],
    ['the website was read in part', { status: 'partial', code: 'PROVIDER_ERROR', pagesCrawled: 0 }],
    ['the website was skipped', { status: 'skipped', pagesCrawled: 0 }],
  ])('is not when %s', (_name, status) => {
    expect(isWebsiteUnavailable(status)).toBe(false);
  });

  it('names the flags as free strings', () => {
    expect([WEBSITE_UNAVAILABLE, LAYER1_UNAVAILABLE]).toEqual(['WEBSITE_UNAVAILABLE', 'LAYER1_UNAVAILABLE']);
  });
});

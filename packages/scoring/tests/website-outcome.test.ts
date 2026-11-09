import { describe, expect, it } from 'vitest';
import { SourceIssueCode } from '@arca/contracts';
import { DEFINITIVE_UNREADABLE_CODES, classifyUnreadableWebsite } from '../src/index.js';

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

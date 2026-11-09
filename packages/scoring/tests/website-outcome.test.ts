import { describe, expect, it } from 'vitest';
import { SourceIssueCode } from '@arca/contracts';
import { DEFINITIVE_UNREADABLE_CODES, classifyUnreadableWebsite } from '../src/index.js';

describe('unreadable website classification', () => {
  it('has nothing to say about a website that was read', () => {
    expect(classifyUnreadableWebsite({ status: 'ok' })).toBeNull();
    expect(classifyUnreadableWebsite({ status: 'partial' })).toBeNull();
  });

  it('calls the site\'s own standing answer definitive', () => {
    expect(classifyUnreadableWebsite({ status: 'error', code: 'ACCESS_BLOCKED' })).toBe('DEFINITIVE');
    expect(classifyUnreadableWebsite({ status: 'error', code: 'NO_READABLE_EVIDENCE' })).toBe('DEFINITIVE');
  });

  it('calls every other code transient', () => {
    for (const code of SourceIssueCode.options.filter(option => !DEFINITIVE_UNREADABLE_CODES.has(option))) {
      expect([code, classifyUnreadableWebsite({ status: 'error', code })]).toEqual([code, 'TRANSIENT']);
    }
    expect([...DEFINITIVE_UNREADABLE_CODES].sort()).toEqual(['ACCESS_BLOCKED', 'NO_READABLE_EVIDENCE']);
  });

  it('never calls a timeout or an unexplained failure definitive', () => {
    expect(classifyUnreadableWebsite({ status: 'timeout', code: 'DEADLINE_REACHED' })).toBe('TRANSIENT');
    expect(classifyUnreadableWebsite({ status: 'timeout', code: 'ACCESS_BLOCKED' })).toBe('TRANSIENT');
    expect(classifyUnreadableWebsite({ status: 'error' })).toBe('TRANSIENT');
    expect(classifyUnreadableWebsite({ status: 'skipped' })).toBe('TRANSIENT');
  });
});

import type { SourceStatus } from '@arca/contracts';

/**
 * A website that gave no evidence, sorted by what a second scan would find.
 * DEFINITIVE: the site's own standing answer (robots.txt disallows it, it refuses with 401/403 or a challenge
 * page, or it has nothing readable). Scanning again returns the same thing.
 * TRANSIENT: something that can pass (a deadline, a network error, robots.txt unreachable, rate limiting, a 5xx,
 * our own providers). Scanning again can return real evidence, so nothing may be concluded about the firm.
 */
export type UnreadableWebsite = 'DEFINITIVE' | 'TRANSIENT';

/**
 * The codes a source reports only for the site's standing answer. This list is the whole rule: whoever builds
 * a website status picks the code by cause, and every reader (pipeline, scoring, scan cache) asks here.
 */
export const DEFINITIVE_UNREADABLE_CODES: ReadonlySet<NonNullable<SourceStatus['code']>> =
  new Set(['ACCESS_BLOCKED', 'NO_READABLE_EVIDENCE']);

/** Null when the website was read (ok or partial). Otherwise which kind of unreadable it is. */
export function classifyUnreadableWebsite(status: Pick<SourceStatus, 'status' | 'code'>): UnreadableWebsite | null {
  if (status.status === 'ok' || status.status === 'partial') return null;
  // Unknown causes stay transient: branding a firm on a failure nobody can name would be the worse mistake.
  return status.status === 'error' && status.code !== undefined && DEFINITIVE_UNREADABLE_CODES.has(status.code)
    ? 'DEFINITIVE' : 'TRANSIENT';
}

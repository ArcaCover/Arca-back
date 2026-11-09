import type { PreScore, SourceStatus } from '@arca/contracts';

/**
 * A website that gave no evidence, sorted by what a second scan would find.
 * DEFINITIVE: the site refuses to be read (robots.txt disallows it, or its pages answer 401/403 or a challenge
 * page). Scanning again returns the same thing.
 * TRANSIENT: everything else (a deadline, a network error, robots.txt unreachable, rate limiting, a 5xx, our own
 * providers, a page that came back missing or empty). Scanning again can return real evidence, so nothing may be
 * concluded about the firm.
 */
export type UnreadableWebsite = 'DEFINITIVE' | 'TRANSIENT';

/**
 * The codes a source reports only for the site's refusal. This list is the whole rule: whoever builds a website
 * status picks the code by cause, and every reader (pipeline, scoring, scan cache) asks here.
 * NO_READABLE_EVIDENCE is not on it: an empty page is also what a script that failed to load once, or content
 * that had not arrived when the page was read, leaves behind, and the two cannot be told apart afterwards.
 */
export const DEFINITIVE_UNREADABLE_CODES: ReadonlySet<NonNullable<SourceStatus['code']>> = new Set(['ACCESS_BLOCKED']);

/** Null when the website was read (ok or partial). Otherwise which kind of unreadable it is. */
export function classifyUnreadableWebsite(status: Pick<SourceStatus, 'status' | 'code'>): UnreadableWebsite | null {
  if (status.status === 'ok' || status.status === 'partial') return null;
  // Unknown causes stay transient: branding a firm on a failure nobody can name would be the worse mistake.
  return status.status === 'error' && status.code !== undefined && DEFINITIVE_UNREADABLE_CODES.has(status.code)
    ? 'DEFINITIVE' : 'TRANSIENT';
}

/**
 * The flag, and the id of the override, of a firm whose website refuses to be read. Nothing the website would have
 * shown could be verified, so the firm goes to a senior underwriter whatever the directories or the questionnaire say.
 * Both are free strings of the contract: no schema value was added for them.
 */
export const WEBSITE_UNAVAILABLE = 'WEBSITE_UNAVAILABLE';
export const WEBSITE_UNAVAILABLE_OVERRIDE: PreScore['overrides'][number] = { id: WEBSITE_UNAVAILABLE,
  decision: 'REFERRAL_SENIOR', reason: 'The firm website could not be read' };

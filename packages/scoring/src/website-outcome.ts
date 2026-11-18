import type { SourceStatus } from '@arca/contracts';

/**
 * A website that gave no evidence, sorted by what a second scan would find.
 * DEFINITIVE: the site refuses to be read (robots.txt disallows it, or its pages answer 401/403 or a challenge
 * page). Scanning again returns the same thing.
 * TRANSIENT: everything else (a deadline, a network error, robots.txt unreachable, rate limiting, a 5xx, our own
 * providers, a page that came back missing or empty). Scanning again can return real evidence, so the scan cache
 * repairs such a result once its cooldown is over.
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
 * Whether the website gave no evidence because of the site, the WEBSITE_UNAVAILABLE outcome (DN-12 §14). The website source
 * reports `pagesCrawled: 0` only for a crawl that read no page at all, whatever the site did: robots.txt excluding it,
 * 401/403 or a challenge page, DNS, a refused or reset connection, a 5xx, rate limiting, robots.txt out of reach, a home
 * page that came back empty, missing or sent elsewhere, or the crawl's own deadline with nothing read. Such a scan ends
 * PARTIAL with low confidence and the assessment scores the answers alone.
 * Our own failures never report that count, so they stay out: the pipeline's deadline and a source that threw report no
 * count, and an extraction that failed (or ran out of time) on pages that were read reports those pages. They end FAILED.
 * Definitive or transient is a separate question, asked of the code (`classifyUnreadableWebsite`): it decides only how
 * long the scan cache keeps the result.
 */
export function isWebsiteUnavailable(status: Pick<SourceStatus, 'status' | 'pagesCrawled'>): boolean {
  return (status.status === 'error' || status.status === 'timeout') && status.pagesCrawled === 0;
}

/** The Layer 1 flag of a firm whose website could not be read at all. A free string of the contract. */
export const WEBSITE_UNAVAILABLE = 'WEBSITE_UNAVAILABLE';
/**
 * The assessment flag of a result scored on the answers alone, because Layer 1 had no public evidence: `layer1Score` is
 * null and the composite is the Layer 2 score. A free string of the contract.
 */
export const LAYER1_UNAVAILABLE = 'LAYER1_UNAVAILABLE';

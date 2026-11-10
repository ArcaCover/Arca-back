import type { Layer1Result, ScanStatus, SourceStatus } from '@arca/contracts';
import { classifyUnreadableWebsite } from '@arca/scoring';

/**
 * Why a stored source is not `ok`, sorted by what scanning the firm again would change.
 * NONE: the source answered in full.
 * STRUCTURAL: the gap belongs to the firm or to the answer itself, so a second scan would find the same. Such a
 * result is the answer of record for the whole cache window.
 * TRANSIENT: something passing got in the way (a deadline, a provider), so a second scan could fill the gap. Only
 * these results are repaired, once per cooldown.
 */
export type Degradation = 'NONE' | 'STRUCTURAL' | 'TRANSIENT';
type Cause = Pick<SourceStatus, 'status' | 'code'>;
type Code = NonNullable<SourceStatus['code']>;

// The cause table (DN-12 §4.2). A status is read by its code, which whoever built the status picked by cause.
/** A website that was read in part: the crawl deadline cut it, or a page failed for a passing reason. */
const PASSING_WEBSITE_CODES: ReadonlySet<Code> = new Set(['DEADLINE_REACHED', 'PROVIDER_ERROR']);
/**
 * A directory gap a second lookup would repeat: nothing to look up (the website shows no attorney or city), nobody
 * matched, or a full result page. Every other code is a deadline or a provider failure, the usage limit included.
 */
const STRUCTURAL_DIRECTORY_CODES: ReadonlySet<Code> = new Set(['INSUFFICIENT_IDENTITY', 'NO_MATCH', 'TRUNCATED']);

export function websiteDegradation(status: Cause): Degradation {
  if (status.status === 'ok') return 'NONE';
  // A partial website without a code was read as far as the site allows (a page that refuses or stays empty). A
  // result stored before the code existed looks the same: it cannot say what cut it, and it is served as it stands.
  if (status.status === 'partial') return status.code !== undefined && PASSING_WEBSITE_CODES.has(status.code) ? 'TRANSIENT' : 'STRUCTURAL';
  // No page at all: only the site's refusal (the WEBSITE_UNAVAILABLE outcome) is an answer about the firm.
  return classifyUnreadableWebsite(status) === 'DEFINITIVE' ? 'STRUCTURAL' : 'TRANSIENT';
}

export function directoryDegradation(status: Cause): Degradation {
  if (status.status === 'ok') return 'NONE';
  if (status.status === 'timeout') return 'TRANSIENT';
  // An unknown or missing code stays transient: repairing is what every partial used to get.
  return status.code !== undefined && STRUCTURAL_DIRECTORY_CODES.has(status.code) ? 'STRUCTURAL' : 'TRANSIENT';
}

/** The worst of the three sources: one passing failure is enough to make the result worth repairing. */
export function resultDegradation(sources: { website: Cause; bar: Cause; avvo: Cause }): Degradation {
  const found = [websiteDegradation(sources.website), directoryDegradation(sources.bar), directoryDegradation(sources.avvo)];
  return found.includes('TRANSIENT') ? 'TRANSIENT' : found.includes('STRUCTURAL') ? 'STRUCTURAL' : 'NONE';
}

/**
 * Whether a scan found inside the cache window answers a new request for its domain, or the pipeline runs again.
 * Same firm, same score: a COMPLETED result always answers, and so does a PARTIAL whose every gap is structural.
 * A PARTIAL with a passing failure answers only until the repair cooldown ends, counted from when it completed.
 */
export function answersFromCache(scan: { status: ScanStatus; result: Pick<Layer1Result, 'sources'> | null;
  completed_at: string | null }, now: number, repairCooldownMs: number): boolean {
  if (!scan.result) return false;
  if (scan.status === 'COMPLETED') return true;
  if (scan.status !== 'PARTIAL') return false;
  if (resultDegradation(scan.result.sources) !== 'TRANSIENT') return true;
  return scan.completed_at !== null && Date.parse(scan.completed_at) > now - repairCooldownMs;
}

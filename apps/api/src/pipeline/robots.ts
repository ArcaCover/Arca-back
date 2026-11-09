import { createRequire } from 'node:module';
import { fetchPublicText, USER_AGENT } from './network.js';

export { USER_AGENT };
/** RFC 9309 2.5 asks for at least 500 kibibytes to be parsed. Whatever follows is ignored, never an error. */
export const ROBOTS_MAX_BYTES = 512_000;
/** Its own deadline, so a robots.txt that hangs costs this much and not the whole crawl deadline. */
export const ROBOTS_TIMEOUT_MS = 6_000;

type ParsedRules = { isAllowed(url: string, agent: string): boolean | undefined; getSitemaps(): string[];
  getCrawlDelay(agent: string): number | undefined };
const robotsParser = createRequire(import.meta.url)('robots-parser') as (url: string, text: string) => ParsedRules;

export type RobotsFetch = (url: string, signal: AbortSignal) => Promise<{ status: number; text: string }>;
/**
 * `rules`: the file was read and is obeyed. `none`: the site has no rules for crawlers, so reading is allowed.
 * `unreachable`: the rules exist or may exist but could not be read, so nothing on that origin is read.
 */
export type RobotsState = 'rules' | 'none' | 'unreachable';
export type RobotsPolicy = {
  url: string; state: RobotsState;
  /** HTTP status of /robots.txt after redirects, or null when no answer arrived. */
  status: number | null;
  /** Why the rules are unreachable. Null otherwise. */
  detail: string | null;
  /** Meant for URLs on the policy's own origin; another origin has its own robots.txt and its own policy. */
  allows(url: string): boolean;
  sitemaps(): string[];
  /** Crawl-delay declared for this crawler (or for `*`), in milliseconds. */
  crawlDelayMs: number | null;
};
/** One per scan, keyed by origin: every reader of the scan shares it, so /robots.txt is downloaded once per origin. */
export type RobotsCache = Map<string, Promise<RobotsPolicy>>;
export const createRobotsCache = (): RobotsCache => new Map();
export type RobotsOptions = { fetchText?: RobotsFetch; cache?: RobotsCache; timeoutMs?: number };

/** The network fetch for /robots.txt: redirects followed up to five hops, the body cut at the cap instead of refused. */
export const fetchRobotsText: RobotsFetch = (url, signal) =>
  // One byte over the cap, so the policy can tell a file that was cut from one that just fits.
  fetchPublicText(url, signal, { maxBytes: ROBOTS_MAX_BYTES + 1, truncate: true });

/**
 * RFC 9309 2.3.1: a 2xx is parsed; a 4xx means the site publishes no rules ("unavailable"), so crawling is
 * allowed; anything else means the rules could not be read ("unreachable"), so everything is disallowed.
 * 429 is the one 4xx kept on the unreachable side: it is the site asking us to slow down, not saying it has no rules.
 */
export function robotsStateForStatus(status: number): RobotsState {
  if (status >= 200 && status < 300) return 'rules';
  if (status >= 400 && status < 500 && status !== 429) return 'none';
  return 'unreachable';
}

function clip(text: string): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.byteLength <= ROBOTS_MAX_BYTES) return text;
  // The cut can land in the middle of a rule, and half a path is a different rule: drop the broken last line.
  // A line ends with LF, CRLF or a lone CR (RFC 9309 2.2).
  const kept = bytes.subarray(0, ROBOTS_MAX_BYTES);
  return kept.subarray(0, Math.max(kept.lastIndexOf(0x0a), kept.lastIndexOf(0x0d)) + 1).toString('utf8');
}

function policy(url: string, state: RobotsState, status: number | null, detail: string | null, text = ''): RobotsPolicy {
  const rules = robotsParser(url, state === 'rules' ? clip(text) : '');
  const delay = rules.getCrawlDelay(USER_AGENT);
  return { url, state, status, detail,
    // The parser answers undefined for a URL of another origin; this policy has nothing to say about it.
    allows: target => state !== 'unreachable' && rules.isAllowed(target, USER_AGENT) !== false,
    sitemaps: () => rules.getSitemaps(),
    crawlDelayMs: typeof delay === 'number' && Number.isFinite(delay) && delay > 0 ? Math.round(delay * 1000) : null };
}

async function load(origin: string, signal: AbortSignal, fetchText: RobotsFetch, timeoutMs: number): Promise<RobotsPolicy> {
  const url = `${origin}/robots.txt`;
  signal.throwIfAborted();
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new Error('robots.txt timed out')), timeoutMs);
  const combined = AbortSignal.any([signal, deadline.signal]);
  let onAbort: (() => void) | undefined;
  try {
    // Raced, not only signalled: a transport that ignores the signal must not be able to hold the crawl either.
    const response = await Promise.race([fetchText(url, combined), new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(combined.reason);
      combined.addEventListener('abort', onAbort, { once: true });
    })]);
    const state = robotsStateForStatus(response.status);
    return policy(url, state, response.status, state === 'unreachable' ? `HTTP ${response.status}` : null, response.text);
  } catch (error) {
    // The caller giving up says nothing about the site: let it surface as the caller's abort, not as a robots verdict.
    if (signal.aborted) throw error;
    return policy(url, 'unreachable', null, deadline.signal.aborted ? 'robots.txt timed out'
      : (error instanceof Error ? error.message : 'robots.txt request failed').slice(0, 200));
  } finally {
    clearTimeout(timer);
    if (onAbort) combined.removeEventListener('abort', onAbort);
  }
}

/**
 * The robots policy of one origin (scheme and host). With a cache, the file is fetched once and the answer shared.
 * A fetch still in flight belongs to the caller that started it: if that caller aborts, whoever else is waiting on
 * it is rejected too. The readers of one scan run under one signal or one after another, so that is the same abort.
 */
export function robotsPolicy(origin: string, signal: AbortSignal, options: RobotsOptions = {}): Promise<RobotsPolicy> {
  const cached = options.cache?.get(origin);
  if (cached) return cached;
  const entry = load(origin, signal, options.fetchText ?? fetchRobotsText, options.timeoutMs ?? ROBOTS_TIMEOUT_MS);
  if (options.cache) {
    const cache = options.cache;
    cache.set(origin, entry);
    // Only an aborted caller rejects. That is not the origin's answer, so the next reader of the scan asks again.
    entry.catch(() => { if (cache.get(origin) === entry) cache.delete(origin); });
  }
  return entry;
}

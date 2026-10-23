import { unknownWebsite, type AttorneyMatch, type DirectoryQuery, type DirectorySource, type SourceResult, type WebsiteData,
  type WebsiteSource } from '@arca/contracts';
import type { DebugScenario } from '@arca/contracts/debug';
import { APIFY_QUOTA_REASON, buildDirectoryInputs } from '../pipeline/directories.js';
import { stableSample } from '../pipeline/matching.js';

// How long a scan appears to take. `slow` crosses the 60 s the front waits before saying the scan is slower than usual.
export const LATENCY_MS = { instant: 0, normal: 8_000, slow: 70_000 } as const;

const injected = (value: string) => JSON.stringify({ injected: value });
// The shape InProcessPipeline's own unavailable('timeout') produces, so an injected timeout reads like a real one.
const timedOut = <T>(): SourceResult<T> => ({ data: null, rawContent: injected('timeout'),
  status: { status: 'timeout', dataStatus: 'UNKNOWN', durationMs: 0, code: 'DEADLINE_REACHED', reason: 'Deadline reached' } });

function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Wraps the website source. `latency` is true only where the mode simulates how long a scan takes. */
export function injectWebsite(real: WebsiteSource, scenario: DebugScenario, options: { latency: boolean }): WebsiteSource {
  return { async run(domain, signal) {
    switch (scenario.website) {
      case 'default':
        if (options.latency) await wait(LATENCY_MS[scenario.latency], signal);
        return real.run(domain, signal);
      case 'no_identity':
        // The site was read but names no firm and no attorney, so the identity comes out INSUFFICIENT. The status is
        // 'error' because the pipeline counts an 'ok' source as a success, and one success makes the scan PARTIAL
        // where the "no firm identity" scenario is meant to end FAILED (DN-09 5.3).
        return { data: unknownWebsite(), rawContent: injected('no_identity'), status: { status: 'error', dataStatus: 'EMPTY',
          durationMs: 0, pagesCrawled: 1, reason: null } };
      case 'blocked':
        return { data: null, rawContent: injected('blocked'), status: { status: 'error', dataStatus: 'UNKNOWN', durationMs: 0,
          pagesCrawled: 0, code: 'ACCESS_BLOCKED', reason: 'Website access was blocked' } };
      case 'error':
        // A throw, not a result: the pipeline's bounded() turns it into its own "source unavailable".
        throw new Error('Injected website failure');
      case 'timeout':
        return timedOut<WebsiteData>();
    }
  } };
}

// ApifyDirectorySource's result when every lookup is refused for lack of usage. It is fabricated here because the
// ApifyClient's quota breaker is shared by the whole process and would also block clean scans.
// A test compares it with the real source, so the two cannot drift apart.
function quotaExceeded(name: 'bar' | 'avvo', query: DirectoryQuery): SourceResult<AttorneyMatch[]> {
  const targets = buildDirectoryInputs(name, query).map(item => item.target).sort((a, b) => a.localeCompare(b));
  const names = stableSample(query.names);
  return { data: null, rawContent: JSON.stringify({
    queries: targets.map(target => ({ target, items: null, error: 'provider_quota_exceeded' })), providerRuns: [] }),
    status: { status: 'error', dataStatus: 'UNKNOWN', durationMs: 0, attorneysSearched: names.length ? names.length : null,
      attorneysFound: null, candidatesReceived: 0, recordsValid: 0, providerRuns: [], costUsd: 0, accountingComplete: true,
      cachedRuns: 0, resumedRuns: 0, costPerAcceptedAttorneyUsd: null, code: 'PROVIDER_ERROR', reason: APIFY_QUOTA_REASON } };
}

/** Wraps one directory source. Keeps the jurisdiction, which the pipeline reads before it runs anything. */
export function injectDirectory(name: 'bar' | 'avvo', real: DirectorySource, scenario: DebugScenario): DirectorySource {
  const run: DirectorySource['run'] = async (query, signal) => {
    switch (scenario[name]) {
      case 'default':
        // A scan that lives in memory has no row in `scans`, so the Apify ledger must not be handed its id (DN-09 5.5).
        return real.run({ ...query, scanId: undefined }, signal);
      case 'empty':
        return { data: [], rawContent: injected('empty'), status: { status: 'ok', dataStatus: 'EMPTY', durationMs: 0,
          code: 'NO_MATCH', attorneysSearched: query.names.length, attorneysFound: 0, providerRuns: [], costUsd: 0,
          reason: 'Provider completed successfully with no accepted identity match' } };
      case 'apify_quota':
        return quotaExceeded(name, query);
      case 'error':
        throw new Error('Injected directory failure');
      case 'timeout':
        return timedOut<AttorneyMatch[]>();
    }
  };
  return real.jurisdiction === undefined ? { run } : { jurisdiction: real.jurisdiction, run };
}

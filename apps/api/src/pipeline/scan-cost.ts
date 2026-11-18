import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * What one pipeline run spent on paid providers, as far as this process can tell when the run ends (DN-12 §5.4).
 * `apify.chargedUsd` is what Apify had reported for the runs this scan started: charges settle minutes after a run
 * ends, so it is a floor, and `reservedUsd` is what the ledger holds for those runs until then. `cachedUsd` is what
 * the answers served from the query cache cost the scan that paid for them; this scan paid nothing for those.
 */
export type ScanCost = {
  apify: { started: number; refused: number; resumed: number; chargedUsd: number; reservedUsd: number; cachedUsd: number };
  /** Chat completions requested by the website extraction. Tokens are null when no response reported its usage. */
  openai: { requests: number; inputTokens: number | null; outputTokens: number | null };
  cacheHits: { apifyRuns: number; websiteAnalysis: boolean };
};

const usd = (value: number) => Math.round(value * 1e6) / 1e6;
const tokens = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

/** Counts what a scan spends while it runs. The providers' clients report to it; the pipeline reads it once, at the end. */
export class ScanMeter {
  private readonly apify = { started: 0, refused: 0, resumed: 0, chargedUsd: 0, reservedUsd: 0, cachedUsd: 0, cached: 0 };
  private readonly openai = { requests: 0, inputTokens: null as number | null, outputTokens: null as number | null };
  private websiteAnalysis = false;
  apifyStarted(reservedUsd: number) { this.apify.started++; this.apify.reservedUsd += reservedUsd; }
  apifyCharged(costUsd: number | null | undefined) { this.apify.chargedUsd += costUsd ?? 0; }
  apifyCached(costUsd: number | null) { this.apify.cached++; this.apify.cachedUsd += costUsd ?? 0; }
  apifyResumed() { this.apify.resumed++; }
  apifyRefused() { this.apify.refused++; }
  openAiRequested() { this.openai.requests++; }
  /** `response` is a chat completion as the provider returned it; one without a usage block adds nothing. */
  openAiAnswered(response: unknown) {
    const usage = (response as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } } | null)?.usage;
    const input = tokens(usage?.prompt_tokens), output = tokens(usage?.completion_tokens);
    if (input !== null) this.openai.inputTokens = (this.openai.inputTokens ?? 0) + input;
    if (output !== null) this.openai.outputTokens = (this.openai.outputTokens ?? 0) + output;
  }
  websiteAnalysisReused() { this.websiteAnalysis = true; }
  cost(): ScanCost {
    const { cached, ...apify } = this.apify;
    return { apify: { ...apify, chargedUsd: usd(apify.chargedUsd), reservedUsd: usd(apify.reservedUsd), cachedUsd: usd(apify.cachedUsd) },
      openai: { ...this.openai }, cacheHits: { apifyRuns: cached, websiteAnalysis: this.websiteAnalysis } };
  }
}

// The sources reach their providers through the contract's interfaces, which carry no room for a meter, and a
// source the deadline cut off never returns its own account. So the meter rides the async context of the scan:
// whatever a pipeline run awaits, directly or not, reports to that run's meter and to no other.
const meters = new AsyncLocalStorage<ScanMeter>();
export const meterScan = <T>(meter: ScanMeter, work: () => Promise<T>): Promise<T> => meters.run(meter, work);
/** The meter of the scan this code is running for. Undefined outside a pipeline run (a script, a cost reconciliation). */
export const scanMeter = (): ScanMeter | undefined => meters.getStore();

/**
 * The one log line a finished pipeline run leaves about its cost. JSON after a fixed tag, so a log search can
 * find and parse it. It names the scan by its id only: no email, no domain, no key.
 */
export function scanCostLine(scan: { scanId: string; status: string; durationMs: number }, cost: ScanCost): string {
  return `[scan-cost] ${JSON.stringify({ scanId: scan.scanId, status: scan.status, durationMs: scan.durationMs, ...cost })}`;
}

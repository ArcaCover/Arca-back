import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ACTIVE_APIFY_STATUSES, type ApifyRunRecord, type ApifyRunReservation, type ApifyRunUpdate,
  type ApifySpendRecord, type ReserveApifyRun } from '../repositories/types.js';
import { InMemoryRepository } from '../repositories/in-memory.js';
import { scanMeter } from './scan-cost.js';

const Run = z.object({ id: z.string(), status: z.string(), defaultDatasetId: z.string().nullish(),
  usageTotalUsd: z.number().nonnegative().nullish(), statusMessage: z.string().nullish(),
  buildId: z.string().nullish(), buildNumber: z.string().nullish(), finishedAt: z.string().nullish() });
type RunState = z.infer<typeof Run>;
type RunStore = {
  reserveApifyRun(request: ReserveApifyRun): Promise<ApifyRunReservation>;
  getApifyRun(id: string): Promise<ApifyRunRecord | null>;
  updateApifyRun(id: string, update: ApifyRunUpdate): Promise<void>;
  pendingApifyAccounting(limit: number): Promise<ApifyRunRecord[]>;
  recentApifyRuns(since: string, limit: number): Promise<ApifySpendRecord[]>;
};
export type ApifyRunMetadata = { provider: 'apify'; actor: string; runId: string; status: string;
  queryFingerprint: string; itemCount: number; acceptedCount: number; costUsd: number | null;
  build?: string; buildId?: string | null; buildNumber?: string | null; datasetId?: string | null;
  partial?: boolean; cached?: boolean; resumed?: boolean;
  accountingComplete?: boolean; chargedToScan?: boolean; ledgerId?: string };
export type ApifyRunResult = { items: unknown[]; metadata: ApifyRunMetadata };
export type ApifyRunContext = { scanId?: string };
export type ApifyClientOptions = { store?: RunStore; build?: string; expectedCostUsdPerRun?: number;
  cacheTtlMs?: number; activeTtlMs?: number;
  runTimeoutSecs?: number; pollWaitSecs?: number; maxCachedItems?: number;
  /** How long no new run is started after Apify reports the account's usage limit. */
  quotaCooldownMs?: number; now?: () => number;
  /**
   * USD the ledger may hold over SPEND_WINDOW_MS before a new run is refused, and the reason each run is started
   * with a charge limit. Null, the default, is no ceiling and no limit: spend is recorded and never capped.
   */
  spendCeilingUsd?: number | null };

const canonical = (value: unknown): string => value !== null && typeof value === 'object'
  ? Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
    : `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  : JSON.stringify(value);
const terminal = (status: string) => !['RESERVED', 'READY', 'RUNNING', 'TIMING-OUT', 'ABORTING'].includes(status);

export class ApifyClientError extends Error {
  constructor(readonly code: 'PROVIDER_ERROR' | 'PROVIDER_QUOTA_EXCEEDED' | 'SPEND_CEILING_REACHED', message: string,
    readonly metadata: ApifyRunMetadata | null = null) { super(message); }
}
class ApifyHttpError extends Error {
  constructor(readonly status: number, readonly detail: string) { super(`Apify request failed (${status})`); }
}
// Apify states an exhausted account in the run's status message ("You've reached the maximum usage
// for your current billing cycle") or refuses the start with 402 and a usage error type.
const USAGE_LIMIT = /maximum usage|usage (hard )?limit|billing cycle|not-enough-usage|insufficient (credit|funds|usage)/i;
const QUOTA_REASON = 'Apify usage limit reached for the current billing cycle';
// Apify books pay-per-event charges after a run ends: the cost read at that moment understated one
// live scan eightfold. A run's cost is final only this long after it finished.
const CHARGES_SETTLE_MS = 120_000;
/** The spend ceiling adds up the ledger rows created in this long, whoever started them: this process, an earlier one, another one. */
export const SPEND_WINDOW_MS = 86_400_000;
// Rows read to add the window up. At this many the sum can no longer be trusted, so the start is refused.
const SPEND_WINDOW_ROWS = 1000;
const SPEND_CEILING_REASON = 'Apify spend ceiling reached';
const CHARGE_LIMIT_REASON = 'Charge limit reached; the dataset may be incomplete';
const CENT = 0.01;

/**
 * What a ledger row counts for against the spend ceiling.
 * A settled run counts what Apify charged. A started run keeps its whole reservation until then: charges are
 * booked minutes after the run ends and the figure read before that understates them (a run of the Florida Bar
 * actor reads 0). A run that never started counts only while it still may.
 */
export function committedUsd(row: ApifySpendRecord, now: number): number {
  if (row.accounting_complete) return row.cost_usd ?? 0;
  if (row.run_id !== null) return Math.max(row.cost_usd ?? 0, row.reserved_usd);
  return ACTIVE_APIFY_STATUSES.includes(row.status) && Date.parse(row.expires_at) > now ? row.reserved_usd : 0;
}
const reachedLimit = (costUsd: number | null | undefined, limitUsd: number | undefined) =>
  limitUsd !== undefined && costUsd !== null && costUsd !== undefined && costUsd >= limitUsd - CENT / 2;

export class ApifyClient {
  private active = 0;
  // Shared by every source and scan using this client: once Apify reports the usage limit, no run
  // is started until the cooldown ends, so a scan stops at the limit instead of failing one by one.
  private quotaBlockedUntil = 0;
  // Under a spend ceiling, reserving a run and checking the ceiling is one step at a time: two runs that reserved
  // together would each miss the other's reservation.
  private admissions: Promise<unknown> = Promise.resolve();
  private ceilingLoggedAt = -Infinity;
  /** The charge limit each run of this process was started with, by ledger id, until its cost settles. */
  private readonly chargeLimits = new Map<string, number>();
  private readonly waiters: Array<() => void> = [];
  private readonly store: RunStore;
  private readonly options: Required<Omit<ApifyClientOptions, 'store'>>;
  constructor(private readonly token: string, private readonly request: typeof fetch = fetch,
    private readonly maxConcurrency = 2, options: ApifyClientOptions = {}) {
    this.store = options.store ?? new InMemoryRepository();
    this.options = { build: options.build ?? 'latest', expectedCostUsdPerRun: options.expectedCostUsdPerRun ?? 1,
      cacheTtlMs: options.cacheTtlMs ?? 604_800_000, activeTtlMs: options.activeTtlMs ?? 900_000,
      runTimeoutSecs: options.runTimeoutSecs ?? 300, pollWaitSecs: options.pollWaitSecs ?? 10,
      maxCachedItems: options.maxCachedItems ?? 1000, quotaCooldownMs: options.quotaCooldownMs ?? 300_000,
      now: options.now ?? Date.now, spendCeilingUsd: options.spendCeilingUsd ?? null };
  }
  private async acquire(signal: AbortSignal) {
    signal.throwIfAborted();
    while (this.active >= this.maxConcurrency) {
      await new Promise<void>((resolve, reject) => {
        const wake = () => { signal.removeEventListener('abort', abort); resolve(); };
        const abort = () => { const index = this.waiters.indexOf(wake); if (index >= 0) this.waiters.splice(index, 1); reject(signal.reason); };
        this.waiters.push(wake); signal.addEventListener('abort', abort, { once: true });
      });
    }
    signal.throwIfAborted(); this.active++;
  }
  private release() { this.active--; this.waiters.shift()?.(); }
  private async json(path: string, signal: AbortSignal, init: RequestInit = {}) {
    const response = await this.request(`https://api.apify.com/v2/${path}`, { ...init, signal,
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' } });
    if (!response.ok) throw new ApifyHttpError(response.status, await response.text().catch(() => ''));
    return response.json();
  }
  private metadata(record: ApifyRunRecord, overrides: Partial<ApifyRunMetadata> = {}): ApifyRunMetadata {
    return { provider: 'apify', actor: record.actor, runId: record.run_id ?? '', status: record.status,
      queryFingerprint: record.query_fingerprint, itemCount: record.item_count, acceptedCount: record.accepted_count,
      costUsd: record.cost_usd, build: record.build, buildId: record.build_id, buildNumber: record.build_number,
      datasetId: record.dataset_id, partial: record.partial,
      accountingComplete: record.accounting_complete, ledgerId: record.id, ...overrides };
  }
  private async readDataset(datasetId: string, signal: AbortSignal) {
    const items: unknown[] = [];
    for (let offset = 0; ; offset += 100) {
      const page = await this.json(`datasets/${encodeURIComponent(datasetId)}/items?format=json&clean=true&offset=${offset}&limit=100`, signal);
      if (!Array.isArray(page)) throw new Error('Invalid Apify dataset');
      items.push(...page);
      if (page.length < 100) return items;
    }
  }
  private async waitForRunId(record: ApifyRunRecord, signal: AbortSignal) {
    const deadline = Date.now() + 2000;
    let current = record;
    while (!current.run_id && Date.now() < deadline) {
      await delay(100, undefined, { signal });
      current = await this.store.getApifyRun(record.id) ?? current;
    }
    return current;
  }
  private async quotaExceeded(record: ApifyRunRecord, update: ApifyRunUpdate = {},
    metadata: ApifyRunMetadata | null = null): Promise<never> {
    if (this.options.now() >= this.quotaBlockedUntil) {
      console.error(`[apify] ${QUOTA_REASON}; no new run starts for ${Math.round(this.options.quotaCooldownMs / 1000)}s`);
    }
    this.quotaBlockedUntil = this.options.now() + this.options.quotaCooldownMs;
    // Expired at once: the cut says nothing about the query, so it is neither reused nor held in cooldown.
    await this.store.updateApifyRun(record.id, { ...update, status: 'QUOTA_EXCEEDED', partial: false,
      expires_at: new Date(this.options.now()).toISOString(), last_error: QUOTA_REASON });
    throw new ApifyClientError('PROVIDER_QUOTA_EXCEEDED', QUOTA_REASON, metadata);
  }
  /**
   * Refuses a new run the spend ceiling has no room for. The ledger row is expired at once: the refusal says
   * nothing about the query, so it is neither reused nor held in a retry cooldown.
   */
  private async ceilingReached(record: ApifyRunRecord, committed: number | null): Promise<never> {
    const now = this.options.now();
    // Once a minute at most: a scan with a long roster is refused lookup by lookup.
    if (now - this.ceilingLoggedAt >= 60_000) {
      this.ceilingLoggedAt = now;
      console.error(`[apify] ${SPEND_CEILING_REASON}: ${committed === null ? `more than ${SPEND_WINDOW_ROWS} runs` : `USD ${committed.toFixed(2)}`}`
        + ` held by the ledger over the last 24 hours, the ceiling is USD ${this.options.spendCeilingUsd!.toFixed(2)} and a run reserves`
        + ` USD ${record.reserved_usd.toFixed(2)} (APIFY_SPEND_CEILING_USD, APIFY_EXPECTED_COST_USD_PER_RUN).`
        + ' No new run starts; cached queries are still served.');
    }
    scanMeter()?.apifyRefused();
    await this.store.updateApifyRun(record.id, { status: 'SPEND_CEILING_REACHED', expires_at: new Date(now).toISOString(),
      last_error: SPEND_CEILING_REASON });
    throw new ApifyClientError('SPEND_CEILING_REACHED', SPEND_CEILING_REASON);
  }
  /**
   * The most the reserved run may charge: what the ceiling leaves once every other run of the window is counted.
   * Throws when that is less than the run reserves.
   */
  private async admit(record: ApifyRunRecord): Promise<number> {
    const now = this.options.now();
    let rows: ApifySpendRecord[];
    try { rows = await this.store.recentApifyRuns(new Date(now - SPEND_WINDOW_MS).toISOString(), SPEND_WINDOW_ROWS); }
    catch {
      // Without the sum the ceiling cannot be checked, and it exists to refuse when in doubt. Nothing was started.
      await this.store.updateApifyRun(record.id, { status: 'UNAVAILABLE', expires_at: new Date(now).toISOString(),
        last_error: 'Recorded Apify spend unavailable; run not started' }).catch(() => {});
      throw new ApifyClientError('PROVIDER_ERROR', 'Recorded Apify spend unavailable; run not started');
    }
    if (rows.length >= SPEND_WINDOW_ROWS) return this.ceilingReached(record, null);
    const committed = rows.filter(row => row.id !== record.id).reduce((total, row) => total + committedUsd(row, now), 0);
    const remaining = this.options.spendCeilingUsd! - committed;
    if (remaining < record.reserved_usd - CENT / 2) return this.ceilingReached(record, committed);
    return remaining;
  }
  private async reserve(request: ReserveApifyRun): Promise<{ reservation: ApifyRunReservation; chargeLimitUsd: number | null }> {
    if (this.options.spendCeilingUsd === null) return { reservation: await this.store.reserveApifyRun(request), chargeLimitUsd: null };
    const step = async () => {
      const reservation = await this.store.reserveApifyRun(request);
      // Only a run about to start is checked: a cached answer, a resumed run and a cooldown cost nothing new.
      return { reservation, chargeLimitUsd: reservation.decision === 'start' ? await this.admit(reservation.record!) : null };
    };
    const turn = this.admissions.then(step, step);
    this.admissions = turn.catch(() => {});
    return turn;
  }
  async run(actor: string, input: Record<string, unknown>, signal: AbortSignal,
    context: ApifyRunContext = {}): Promise<ApifyRunResult> {
    const queryFingerprint = createHash('sha256').update(canonical({ actor, build: this.options.build, input })).digest('hex');
    await this.acquire(signal);
    let reservation: ApifyRunReservation, chargeLimitUsd: number | null;
    try {
      ({ reservation, chargeLimitUsd } = await this.reserve({ scanId: context.scanId, queryFingerprint, actor,
        build: this.options.build, input, expectedCostUsd: this.options.expectedCostUsdPerRun,
        expiresAt: new Date(Date.now() + this.options.activeTtlMs).toISOString() }));
    } catch (error) { this.release(); throw error; }
    let record = reservation.record!;
    if (reservation.decision === 'failed') {
      this.release(); throw new ApifyClientError('PROVIDER_ERROR', 'Previous Apify run failed; retry cooldown active',
        record.run_id ? this.metadata(record, { cached: true, chargedToScan: false }) : null);
    }
    if (reservation.decision === 'reuse') {
      try {
        const items = record.items ?? (record.dataset_id ? await this.readDataset(record.dataset_id, signal) : []);
        scanMeter()?.apifyCached(record.cost_usd);
        return { items, metadata: this.metadata(record, { cached: true, chargedToScan: false }) };
      } finally { this.release(); }
    }
    let run: RunState | null = null;
    try {
      if (reservation.decision === 'resume') record = await this.waitForRunId(record, signal);
      if (record.run_id) {
        const state = await this.json(`actor-runs/${encodeURIComponent(record.run_id)}?waitForFinish=${this.options.pollWaitSecs}`, signal);
        run = z.object({ data: Run }).parse(state).data;
      } else if (reservation.decision === 'start') {
        if (this.options.now() < this.quotaBlockedUntil) await this.quotaExceeded(record);
        // Without a ceiling there is no maxTotalChargeUsd: spend is recorded in the ledger, not capped at the
        // provider, and the run timeout is what bounds a single run. Under a ceiling the run may charge what the
        // ceiling has left, which is what bounds a firm-wide search that asks for every lawyer of a firm. The limit
        // travels in the URL: the stored input and the query fingerprint are the same with or without it.
        const parameters = new URLSearchParams({ waitForFinish: '60', timeout: String(this.options.runTimeoutSecs),
          build: this.options.build });
        if (chargeLimitUsd !== null) {
          // Whole cents, rounded down; the hair added first keeps a sum such as 1.91 from landing on 1.90.
          const limit = Math.max(CENT, Math.floor(chargeLimitUsd * 100 + 1e-6) / 100);
          parameters.set('maxTotalChargeUsd', String(limit));
          this.chargeLimits.set(record.id, limit);
        }
        let start: unknown;
        try {
          start = await this.json(`acts/${encodeURIComponent(actor.replace('/', '~'))}/runs?${parameters}`, signal,
            { method: 'POST', body: JSON.stringify(input) });
        } catch (error) {
          // An HTTP refusal proves the run never started; only a lost response leaves it uncertain.
          if (error instanceof ApifyHttpError) this.chargeLimits.delete(record.id);
          if (error instanceof ApifyHttpError && (error.status === 402 || USAGE_LIMIT.test(error.detail))) await this.quotaExceeded(record);
          await this.store.updateApifyRun(record.id, { status: 'START_UNCERTAIN', last_error: 'Actor start response unavailable' });
          throw error;
        }
        run = z.object({ data: Run }).parse(start).data;
        scanMeter()?.apifyStarted(record.reserved_usd);
        await this.store.updateApifyRun(record.id, { run_id: run.id, dataset_id: run.defaultDatasetId ?? null,
          build_id: run.buildId ?? null, build_number: run.buildNumber ?? null,
          status: run.status, cost_usd: run.usageTotalUsd ?? null, last_error: null });
        record = await this.store.getApifyRun(record.id) ?? record;
      } else {
        throw new Error('Apify run reservation cannot be resumed yet');
      }
      if (reservation.decision === 'resume') scanMeter()?.apifyResumed();
      while (!terminal(run.status)) {
        await delay(250, undefined, { signal });
        const state = await this.json(`actor-runs/${encodeURIComponent(run.id)}?waitForFinish=${this.options.pollWaitSecs}`, signal);
        run = z.object({ data: Run }).parse(state).data;
        await this.store.updateApifyRun(record.id, { run_id: run.id, dataset_id: run.defaultDatasetId ?? null,
          build_id: run.buildId ?? null, build_number: run.buildNumber ?? null,
          status: run.status, cost_usd: run.usageTotalUsd ?? null });
      }
      const datasetId = run.defaultDatasetId ?? record.dataset_id;
      const items = datasetId ? await this.readDataset(datasetId, signal) : [];
      if (reservation.chargedToScan) scanMeter()?.apifyCharged(run.usageTotalUsd);
      if (run.status !== 'SUCCEEDED' && USAGE_LIMIT.test(run.statusMessage ?? '')) {
        const cut: ApifyRunUpdate = { run_id: run.id, dataset_id: datasetId ?? null, item_count: items.length,
          items: items.length <= this.options.maxCachedItems ? items : null,
          cost_usd: run.usageTotalUsd ?? null, accounting_complete: false };
        await this.quotaExceeded(record, cut, this.metadata({ ...record, ...cut, status: 'QUOTA_EXCEEDED', partial: false },
          { chargedToScan: reservation.chargedToScan }));
      }
      // A run that spent its whole charge limit may have stopped before it had every row. Its rows are kept as
      // partial evidence for this scan and the query is not cached: the cut says nothing about the firm.
      const chargeLimit = this.chargeLimits.get(record.id);
      const limitReached = reachedLimit(run.usageTotalUsd, chargeLimit);
      if (limitReached) console.error(`[apify] run ${run.id} reached its charge limit of USD ${chargeLimit}; its dataset may be incomplete and is not reused`);
      const partial = (run.status !== 'SUCCEEDED' && items.length > 0) || limitReached;
      // Provisional: reconcileCosts books the settled figure once the charges are in.
      const accountingComplete = false;
      const update: ApifyRunUpdate = { run_id: run.id, dataset_id: datasetId ?? null, status: run.status,
        build_id: run.buildId ?? null, build_number: run.buildNumber ?? null,
        items: items.length <= this.options.maxCachedItems ? items : null, item_count: items.length,
        cost_usd: run.usageTotalUsd ?? null, accounting_complete: accountingComplete,
        partial, expires_at: new Date(limitReached ? this.options.now() : Date.now() + (run.status === 'SUCCEEDED' || partial
          ? this.options.cacheTtlMs : this.options.activeTtlMs)).toISOString(),
        last_error: limitReached ? CHARGE_LIMIT_REASON : run.status === 'SUCCEEDED' ? null : run.statusMessage ?? `Apify run ${run.status}` };
      await this.store.updateApifyRun(record.id, update);
      record = await this.store.getApifyRun(record.id) ?? { ...record, ...update };
      const metadata = this.metadata(record, { resumed: reservation.decision === 'resume',
        chargedToScan: reservation.chargedToScan });
      if (run.status !== 'SUCCEEDED' && !partial) throw new ApifyClientError('PROVIDER_ERROR', `Apify run ${run.status}`, metadata);
      return { items, metadata };
    } catch (error) {
      if (error instanceof ApifyClientError) throw error;
      const status = signal.aborted ? (run?.status ?? record.status) : (run?.status ?? 'UNAVAILABLE');
      await this.store.updateApifyRun(record.id, { status, run_id: run?.id ?? record.run_id,
        dataset_id: run?.defaultDatasetId ?? record.dataset_id, cost_usd: run?.usageTotalUsd ?? record.cost_usd,
        last_error: signal.aborted ? 'Caller deadline reached; remote run retained for recovery' : 'Apify run unavailable' }).catch(() => {});
      record = await this.store.getApifyRun(record.id) ?? record;
      throw new ApifyClientError('PROVIDER_ERROR', signal.aborted ? 'Apify run retained for recovery' : 'Apify run unavailable',
        record.run_id ? this.metadata(record, { resumed: reservation.decision === 'resume',
          chargedToScan: reservation.chargedToScan }) : null);
    } finally { this.release(); }
  }
  /** Books the settled cost of finished runs. The server calls it every minute; a run that finished
   *  too recently, or that Apify cannot report yet, is left for the next pass. */
  async reconcileCosts(limit = 50): Promise<number> {
    let settled = 0;
    for (const record of await this.store.pendingApifyAccounting(limit)) {
      try {
        const state = await this.json(`actor-runs/${encodeURIComponent(record.run_id!)}`, AbortSignal.timeout(15_000));
        const run = z.object({ data: Run }).parse(state).data;
        if (!terminal(run.status) || !run.finishedAt || this.options.now() - Date.parse(run.finishedAt) < CHARGES_SETTLE_MS) continue;
        if (run.usageTotalUsd === null || run.usageTotalUsd === undefined) continue;
        // The figure read when the run ended can hide a run that spent its whole charge limit. The settled one cannot.
        const chargeLimit = this.chargeLimits.get(record.id);
        const limitReached = !record.partial && reachedLimit(run.usageTotalUsd, chargeLimit);
        if (limitReached) console.error(`[apify] run ${run.id} settled at its charge limit of USD ${chargeLimit}; its dataset may be incomplete and is no longer reused`);
        await this.store.updateApifyRun(record.id, { cost_usd: run.usageTotalUsd, accounting_complete: true,
          ...(limitReached ? { partial: true, expires_at: new Date(this.options.now()).toISOString(), last_error: CHARGE_LIMIT_REASON } : {}) });
        this.chargeLimits.delete(record.id);
        settled++;
      } catch { /* Apify or the store is unavailable: the next pass tries again. */ }
    }
    return settled;
  }
  async recordAccepted(metadata: ApifyRunMetadata, acceptedCount: number) {
    if (metadata.ledgerId) await this.store.updateApifyRun(metadata.ledgerId, { accepted_count: acceptedCount });
  }
}

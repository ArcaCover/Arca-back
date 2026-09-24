import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ApifyRunRecord, ApifyRunReservation, ApifyRunUpdate, ReserveApifyRun } from '../repositories/types.js';
import { InMemoryRepository } from '../repositories/in-memory.js';

const Run = z.object({ id: z.string(), status: z.string(), defaultDatasetId: z.string().nullish(),
  usageTotalUsd: z.number().nonnegative().nullish(), statusMessage: z.string().nullish(),
  buildId: z.string().nullish(), buildNumber: z.string().nullish() });
type RunState = z.infer<typeof Run>;
type RunStore = {
  reserveApifyRun(request: ReserveApifyRun): Promise<ApifyRunReservation>;
  getApifyRun(id: string): Promise<ApifyRunRecord | null>;
  updateApifyRun(id: string, update: ApifyRunUpdate): Promise<void>;
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
  runTimeoutSecs?: number; pollWaitSecs?: number; maxCachedItems?: number };

const canonical = (value: unknown): string => value !== null && typeof value === 'object'
  ? Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
    : `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  : JSON.stringify(value);
const terminal = (status: string) => !['RESERVED', 'READY', 'RUNNING', 'TIMING-OUT', 'ABORTING'].includes(status);

export class ApifyClientError extends Error {
  constructor(readonly code: 'PROVIDER_ERROR', message: string,
    readonly metadata: ApifyRunMetadata | null = null) { super(message); }
}

export class ApifyClient {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  private readonly store: RunStore;
  private readonly options: Required<Omit<ApifyClientOptions, 'store'>>;
  constructor(private readonly token: string, private readonly request: typeof fetch = fetch,
    private readonly maxConcurrency = 2, options: ApifyClientOptions = {}) {
    this.store = options.store ?? new InMemoryRepository();
    this.options = { build: options.build ?? 'latest', expectedCostUsdPerRun: options.expectedCostUsdPerRun ?? 1,
      cacheTtlMs: options.cacheTtlMs ?? 604_800_000, activeTtlMs: options.activeTtlMs ?? 900_000,
      runTimeoutSecs: options.runTimeoutSecs ?? 300, pollWaitSecs: options.pollWaitSecs ?? 10,
      maxCachedItems: options.maxCachedItems ?? 1000 };
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
    if (!response.ok) throw new Error(`Apify request failed (${response.status})`);
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
  async run(actor: string, input: Record<string, unknown>, signal: AbortSignal,
    context: ApifyRunContext = {}): Promise<ApifyRunResult> {
    const queryFingerprint = createHash('sha256').update(canonical({ actor, build: this.options.build, input })).digest('hex');
    await this.acquire(signal);
    let reservation: ApifyRunReservation;
    try {
      reservation = await this.store.reserveApifyRun({ scanId: context.scanId, queryFingerprint, actor,
        build: this.options.build, input, expectedCostUsd: this.options.expectedCostUsdPerRun,
        expiresAt: new Date(Date.now() + this.options.activeTtlMs).toISOString() });
    } catch (error) { this.release(); throw error; }
    let record = reservation.record!;
    if (reservation.decision === 'failed') {
      this.release(); throw new ApifyClientError('PROVIDER_ERROR', 'Previous Apify run failed; retry cooldown active',
        record.run_id ? this.metadata(record, { cached: true, chargedToScan: false }) : null);
    }
    if (reservation.decision === 'reuse') {
      try {
        const items = record.items ?? (record.dataset_id ? await this.readDataset(record.dataset_id, signal) : []);
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
        // No maxTotalChargeUsd: spend is recorded in the ledger, not capped at the provider.
        // The run timeout is what bounds a single run.
        const parameters = new URLSearchParams({ waitForFinish: '60', timeout: String(this.options.runTimeoutSecs),
          build: this.options.build });
        let start: unknown;
        try {
          start = await this.json(`acts/${encodeURIComponent(actor.replace('/', '~'))}/runs?${parameters}`, signal,
            { method: 'POST', body: JSON.stringify(input) });
        } catch (error) {
          await this.store.updateApifyRun(record.id, { status: 'START_UNCERTAIN', last_error: 'Actor start response unavailable' });
          throw error;
        }
        run = z.object({ data: Run }).parse(start).data;
        await this.store.updateApifyRun(record.id, { run_id: run.id, dataset_id: run.defaultDatasetId ?? null,
          build_id: run.buildId ?? null, build_number: run.buildNumber ?? null,
          status: run.status, cost_usd: run.usageTotalUsd ?? null, last_error: null });
        record = await this.store.getApifyRun(record.id) ?? record;
      } else {
        throw new Error('Apify run reservation cannot be resumed yet');
      }
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
      const partial = run.status !== 'SUCCEEDED' && items.length > 0;
      const accountingComplete = run.usageTotalUsd !== null && run.usageTotalUsd !== undefined;
      const update: ApifyRunUpdate = { run_id: run.id, dataset_id: datasetId ?? null, status: run.status,
        build_id: run.buildId ?? null, build_number: run.buildNumber ?? null,
        items: items.length <= this.options.maxCachedItems ? items : null, item_count: items.length,
        cost_usd: run.usageTotalUsd ?? null, accounting_complete: accountingComplete,
        partial, expires_at: new Date(Date.now() + (run.status === 'SUCCEEDED' || partial
          ? this.options.cacheTtlMs : this.options.activeTtlMs)).toISOString(),
        last_error: run.status === 'SUCCEEDED' ? null : run.statusMessage ?? `Apify run ${run.status}` };
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
  async recordAccepted(metadata: ApifyRunMetadata, acceptedCount: number) {
    if (metadata.ledgerId) await this.store.updateApifyRun(metadata.ledgerId, { accepted_count: acceptedCount });
  }
}

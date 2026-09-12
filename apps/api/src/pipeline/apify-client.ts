import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { z } from 'zod';
const Run = z.object({ id: z.string(), status: z.string(), defaultDatasetId: z.string(),
  usageTotalUsd: z.number().nonnegative().nullish(), statusMessage: z.string().nullish() });
export type ApifyRunResult = { items: unknown[]; metadata: { provider: 'apify'; actor: string; runId: string;
  status: string; queryFingerprint: string; itemCount: number; acceptedCount: number; costUsd: number | null } };
export class ApifyClientError extends Error {
  constructor(readonly code: 'PROVIDER_ERROR' | 'BUDGET_EXCEEDED', message: string,
    readonly metadata: ApifyRunResult['metadata'] | null = null) { super(message); }
}
export class ApifyClient {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  constructor(private readonly token: string, private readonly request: typeof fetch = fetch,
    private readonly maxConcurrency = 2) {}
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
  async run(actor: string, input: Record<string, unknown>, signal: AbortSignal): Promise<ApifyRunResult> {
    await this.acquire(signal);
    let runId: string | null = null;
    let lastRun: z.infer<typeof Run> | null = null;
    let finished = false;
    const queryFingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    try {
      const start = await this.json(`acts/${encodeURIComponent(actor.replace('/', '~'))}/runs?timeout=55`, signal,
        { method: 'POST', body: JSON.stringify(input) });
      let run = z.object({ data: Run }).parse(start).data;
      lastRun = run;
      runId = run.id;
      while (['READY', 'RUNNING', 'TIMING-OUT', 'ABORTING'].includes(run.status)) {
        await delay(500, undefined, { signal });
        const state = await this.json(`actor-runs/${encodeURIComponent(runId)}?waitForFinish=1`, signal);
        run = z.object({ data: Run }).parse(state).data;
        lastRun = run;
      }
      finished = true;
      if (run.status !== 'SUCCEEDED') throw new ApifyClientError('PROVIDER_ERROR', `Apify run ${run.status}`,
        { provider: 'apify', actor, runId, status: run.status, queryFingerprint, itemCount: 0,
          acceptedCount: 0, costUsd: run.usageTotalUsd ?? null });
      const items: unknown[] = [];
      for (let offset = 0; ; offset += 100) {
        const page = await this.json(`datasets/${encodeURIComponent(run.defaultDatasetId)}/items?format=json&clean=true&offset=${offset}&limit=100`, signal);
        if (!Array.isArray(page)) throw new Error('Invalid Apify dataset');
        items.push(...page);
        if (page.length < 100) return { items, metadata: { provider: 'apify', actor, runId, status: run.status,
          queryFingerprint,
          itemCount: items.length, acceptedCount: 0, costUsd: run.usageTotalUsd ?? null } };
        if (items.length >= 1000) throw new Error('Unexpectedly large targeted dataset');
      }
    } catch (error) {
      if (error instanceof ApifyClientError) throw error;
      if (runId) throw new ApifyClientError('PROVIDER_ERROR', signal.aborted ? 'Apify run aborted' : 'Apify run unavailable',
        { provider: 'apify', actor, runId, status: lastRun?.status ?? 'UNKNOWN', queryFingerprint,
          itemCount: 0, acceptedCount: 0, costUsd: lastRun?.usageTotalUsd ?? null });
      throw error;
    } finally {
      if (runId && !finished) {
        await this.json(`actor-runs/${encodeURIComponent(runId)}/abort`, AbortSignal.timeout(2000), { method: 'POST' }).catch(() => {});
      }
      this.release();
    }
  }
}

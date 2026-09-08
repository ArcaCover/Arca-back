import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
const Run = z.object({ id: z.string(), status: z.string(), defaultDatasetId: z.string() });
export class ApifyClient {
  constructor(private readonly token: string, private readonly request: typeof fetch = fetch) {}
  private async json(path: string, signal: AbortSignal, init: RequestInit = {}) {
    const response = await this.request(`https://api.apify.com/v2/${path}`, { ...init, signal,
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' } });
    if (!response.ok) throw new Error(`Apify request failed (${response.status})`);
    return response.json();
  }
  async run(actor: string, input: Record<string, unknown>, signal: AbortSignal): Promise<unknown[]> {
    let runId: string | null = null;
    let finished = false;
    try {
      const start = await this.json(`acts/${encodeURIComponent(actor.replace('/', '~'))}/runs?timeout=55`, signal,
        { method: 'POST', body: JSON.stringify(input) });
      let run = z.object({ data: Run }).parse(start).data;
      runId = run.id;
      while (['READY', 'RUNNING', 'TIMING-OUT', 'ABORTING'].includes(run.status)) {
        await delay(500, undefined, { signal });
        const state = await this.json(`actor-runs/${encodeURIComponent(runId)}?waitForFinish=1`, signal);
        run = z.object({ data: Run }).parse(state).data;
      }
      finished = true;
      if (run.status !== 'SUCCEEDED') throw new Error(`Apify run ${run.status}`);
      const items: unknown[] = [];
      for (let offset = 0; ; offset += 100) {
        const page = await this.json(`datasets/${encodeURIComponent(run.defaultDatasetId)}/items?format=json&clean=true&offset=${offset}&limit=100`, signal);
        if (!Array.isArray(page)) throw new Error('Invalid Apify dataset');
        items.push(...page);
        if (page.length < 100) return items;
        if (items.length >= 1000) throw new Error('Unexpectedly large targeted dataset');
      }
    } finally {
      if (runId && !finished) {
        await this.json(`actor-runs/${encodeURIComponent(runId)}/abort`, AbortSignal.timeout(2000), { method: 'POST' }).catch(() => {});
      }
    }
  }
}

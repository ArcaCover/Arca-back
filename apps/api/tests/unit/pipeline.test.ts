import { describe, expect, it } from 'vitest';
import { InProcessPipeline } from '../../src/pipeline/in-process-pipeline.js';
import type { FetchedPage, PageFetcher } from '../../src/pipeline/page-fetcher.js';
import type { DnsLookup } from '../../src/pipeline/steps/dns.js';
import { RecordingMemoryStore, healthyDns } from '../fixtures/deps.js';
import { LocalSiteFetcher, startTestSite, UnreachableFetcher } from '../fixtures/site.js';

/** Fetcher que nunca resuelve: sirve para verificar que el timeout del paso corta. */
class HangingFetcher implements PageFetcher {
  async fetch(): Promise<FetchedPage> {
    return new Promise(() => {});
  }
  async close(): Promise<void> {}
}

const failingDns: DnsLookup = {
  resolveMx: async () => {
    throw new Error('SERVFAIL');
  },
  resolveTxt: async () => {
    throw new Error('SERVFAIL');
  },
};

describe('resiliencia del pipeline', () => {
  it('un paso que falla baja la confianza pero no aborta el scan', async () => {
    const site = await startTestSite();
    try {
      const pipeline = new InProcessPipeline({
        fetcher: new LocalSiteFetcher(site.port),
        dns: failingDns,
        memoryStore: new RecordingMemoryStore(),
      });

      const result = await pipeline.run({ domain: 'firm.com', scan_id: 'scan-1' });

      // DNS falló, pero las señales del sitio siguen contando.
      expect(result.observations.ai_policy_found).toBe(true);
      expect(result.observations.email_provider).toBeNull();
      expect(result.signals.some((s) => s.id === 'dmarc')).toBe(false);
      expect(result.pre_score.value).toBeGreaterThan(0);
    } finally {
      await site.close();
    }
  });

  it('un sitio caído deja website_found en false y sigue con DNS', async () => {
    const pipeline = new InProcessPipeline({
      fetcher: new UnreachableFetcher(),
      dns: healthyDns,
      memoryStore: new RecordingMemoryStore(),
    });

    const result = await pipeline.run({ domain: 'down.com', scan_id: 'scan-2' });

    expect(result.observations.website_found).toBe(false);
    expect(result.observations.email_provider).toBe('google');
    expect(result.pre_score.confidence).toBe('LOW');
    expect(result.steps.find((s) => s.step === 'scrape')?.status).toBe('ok');
  });

  it('corta un paso colgado por timeout y lo registra', async () => {
    const pipeline = new InProcessPipeline({
      fetcher: new HangingFetcher(),
      dns: healthyDns,
      memoryStore: new RecordingMemoryStore(),
      stepTimeoutMs: 50,
    });

    const result = await pipeline.run({ domain: 'slow.com', scan_id: 'scan-3' });

    expect(result.steps.find((s) => s.step === 'scrape')?.status).toBe('timeout');
    expect(result.observations.website_found).toBe(false);
    expect(result.pre_score.confidence).toBe('LOW');
  });

  it('salta los pasos restantes cuando se agota el presupuesto global', async () => {
    let clock = 0;
    const pipeline = new InProcessPipeline({
      fetcher: new UnreachableFetcher(),
      dns: healthyDns,
      memoryStore: new RecordingMemoryStore(),
      globalBudgetMs: 10,
      // Cada lectura del reloj avanza 100ms: el presupuesto se agota tras la primera fase.
      now: () => (clock += 100),
    });

    const result = await pipeline.run({ domain: 'budget.com', scan_id: 'scan-4' });
    const skipped = result.steps.filter((s) => s.status === 'skipped').map((s) => s.step);

    expect(skipped).toContain('nlp');
    expect(skipped).toContain('tech_stack');
  });
});

describe('contrato de salida', () => {
  it('el Layer1Result serializa a JSON sin pérdida', async () => {
    const site = await startTestSite();
    try {
      const pipeline = new InProcessPipeline({
        fetcher: new LocalSiteFetcher(site.port),
        dns: healthyDns,
        memoryStore: new RecordingMemoryStore(),
      });
      const result = await pipeline.run({ domain: 'firm.com', scan_id: 'scan-5' });
      expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    } finally {
      await site.close();
    }
  });

  it('el bar check queda pendiente de revisión manual', async () => {
    const pipeline = new InProcessPipeline({
      fetcher: new UnreachableFetcher(),
      dns: healthyDns,
      memoryStore: new RecordingMemoryStore(),
    });
    const result = await pipeline.run({ domain: 'firm.com' });

    expect(result.observations.bar_verified).toBe(false);
    expect(result.observations.bar_check).toBe('manual_pending');
    expect(result.steps.find((s) => s.step === 'bar_check')?.status).toBe('skipped');
  });

  it('entrega evidencia y run record aun cuando el scan sale degradado', async () => {
    const memory = new RecordingMemoryStore();
    const pipeline = new InProcessPipeline({
      fetcher: new UnreachableFetcher(),
      dns: failingDns,
      memoryStore: memory,
    });

    await pipeline.run({ domain: 'firm.com', scan_id: 'scan-6' });

    expect(memory.runs).toHaveLength(1);
    expect(memory.runs[0]?.record.confidence).toBe('LOW');
    expect(memory.evidence[0]?.scanId).toBe('scan-6');
  });
});

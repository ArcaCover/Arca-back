import type { EvidenceItem, MemoryStore, RunRecord } from '@arca/contracts';
import { createApp } from '../../src/http/app.js';
import { NoopMemoryStore } from '../../src/memory/noop-memory-store.js';
import { InProcessPipeline } from '../../src/pipeline/in-process-pipeline.js';
import type { PageFetcher } from '../../src/pipeline/page-fetcher.js';
import type { DnsLookup } from '../../src/pipeline/steps/dns.js';
import { InMemoryRepositories } from '../../src/repositories/in-memory.js';
import { SlidingWindowLimiter, type RateLimitWindow } from '../../src/http/rate-limit.js';

/** Secreto de test: solo tiene que superar el mínimo de longitud del validador de env. */
export const TEST_SECRET = 'test-session-secret-that-is-long-enough';

export const TEST_ORIGINS = ['https://arcacover.com', 'https://*.vercel.app', 'http://localhost:3000'];

/** DNS falso: devuelve MX de Google Workspace y un DMARC publicado. */
export const healthyDns: DnsLookup = {
  resolveMx: async () => [{ exchange: 'aspmx.l.google.com' }],
  resolveTxt: async () => [['v=DMARC1; p=quarantine; rua=mailto:dmarc@example.com']],
};

/** DNS sin registros: el dominio existe pero no tiene correo ni DMARC configurados. */
export const emptyDns: DnsLookup = {
  resolveMx: async () => [],
  resolveTxt: async () => {
    throw new Error('ENOTFOUND');
  },
};

/** Registra lo que el pipeline entrega al Memory System, para poder afirmar sobre ello. */
export class RecordingMemoryStore implements MemoryStore {
  readonly evidence: Array<{ scanId: string; items: EvidenceItem[] }> = [];
  readonly runs: Array<{ scanId: string; record: RunRecord }> = [];
  private readonly inner = new NoopMemoryStore();

  async saveEvidence(scanId: string, items: EvidenceItem[]): Promise<void> {
    this.evidence.push({ scanId, items });
    await this.inner.saveEvidence(scanId, items);
  }

  async saveRunRecord(scanId: string, record: RunRecord): Promise<void> {
    this.runs.push({ scanId, record });
    await this.inner.saveRunRecord(scanId, record);
  }
}

export type TestHarness = {
  app: ReturnType<typeof createApp>;
  repositories: InMemoryRepositories;
  memory: RecordingMemoryStore;
};

/** Arma la app completa con puertos de test: sin Supabase, sin Playwright, sin red externa. */
export function buildHarness(options: {
  fetcher: PageFetcher;
  dns?: DnsLookup;
  rateLimits?: RateLimitWindow[];
}): TestHarness {
  const repositories = new InMemoryRepositories();
  const memory = new RecordingMemoryStore();

  const pipeline = new InProcessPipeline({
    fetcher: options.fetcher,
    dns: options.dns ?? healthyDns,
    memoryStore: memory,
    stepTimeoutMs: 5_000,
    globalBudgetMs: 20_000,
  });

  const app = createApp({
    pipeline,
    repositories,
    sessionSecret: TEST_SECRET,
    corsOrigins: TEST_ORIGINS,
    rateLimiter: options.rateLimits ? new SlidingWindowLimiter(options.rateLimits) : undefined,
  });

  return { app, repositories, memory };
}

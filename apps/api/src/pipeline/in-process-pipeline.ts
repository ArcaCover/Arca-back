import { createHash } from 'node:crypto';
import { Layer1Result, type Layer1Pipeline, type WebsiteSource, type DirectorySource, type SourceResult,
  type SourceName, type PipelineResult, type WebsiteData, type AttorneyMatch } from '@arca/contracts';
import { scoreEvidence } from '@arca/scoring';
import { stableSample } from './matching.js';
import { normalizeDomain } from './domain-resolution.js';
import type { ScanRepository } from '../repositories/types.js';

export class InProcessPipeline implements Layer1Pipeline {
  constructor(private readonly deps: {
    website: WebsiteSource; bar: DirectorySource; avvo: DirectorySource; repository: ScanRepository;
    timeoutMs?: number; now?: () => number;
  }) {}
  async run(input: { scanId: string; canonicalDomain: string }): Promise<PipelineResult> {
    if (!input.canonicalDomain || normalizeDomain(input.canonicalDomain) !== input.canonicalDomain) {
      throw new Error('A normalized canonical domain is required before assessment');
    }
    const now = this.deps.now ?? Date.now, start = now();
    const controller = new AbortController();
    const budget = this.deps.timeoutMs ?? 55_000;
    const timer = setTimeout(() => controller.abort(new Error('Source deadline reached')), budget - Math.min(5000, budget * 0.1));
    const signal = controller.signal;
    const unavailable = <T>(status: 'timeout' | 'error', started: number): SourceResult<T> => ({
      data: null, rawContent: null, status: { status, dataStatus: 'UNKNOWN', durationMs: Math.max(0, now() - started), reason: `${status === 'timeout' ? 'Deadline reached' : 'Source unavailable'}` },
    });
    async function bounded<T>(work: () => Promise<SourceResult<T>>): Promise<SourceResult<T>> {
      const started = now();
      if (signal.aborted) return unavailable('timeout', started);
      let listener: (() => void) | undefined;
      try {
        return await Promise.race([Promise.resolve().then(work), new Promise<SourceResult<T>>(resolve => {
          listener = () => resolve(unavailable('timeout', started)); signal.addEventListener('abort', listener, { once: true });
        })]);
      } catch { return unavailable(signal.aborted ? 'timeout' : 'error', started); }
      finally { if (listener) signal.removeEventListener('abort', listener); }
    }
    try {
      const website = await bounded<WebsiteData>(() => this.deps.website.run(input.canonicalDomain, signal));
      const query = { canonicalDomain: input.canonicalDomain, names: stableSample(website.data?.team_members?.map(person => person.full_name) ?? []),
        firmName: website.data?.firm_name ?? input.canonicalDomain.split('.')[0]!, state: 'FL' as const };
      const [bar, avvo] = await Promise.all([
        bounded<AttorneyMatch[]>(() => this.deps.bar.run(query, signal)),
        bounded<AttorneyMatch[]>(() => this.deps.avvo.run(query, signal)),
      ]);
      // External work is over. Raw evidence persistence remains mandatory before returning a result.
      const fetchedAt = new Date(now()).toISOString();
      let persistenceTimer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([Promise.all(Object.entries({ website, bar, avvo }).map(async ([source, response]) => {
        if (response.rawContent !== null) await this.deps.repository.saveRaw({ scan_id: input.scanId,
          source: source as SourceName, raw_content: response.rawContent,
          content_hash: createHash('sha256').update(response.rawContent).digest('hex'), fetched_at: fetchedAt });
      })), new Promise<never>((_resolve, reject) => {
        persistenceTimer = setTimeout(() => reject(new Error('Raw evidence persistence deadline reached')), Math.max(1, budget - (now() - start)));
      })]); } finally { clearTimeout(persistenceTimer); }
      const sources = { website: website.status, bar: bar.status, avvo: avvo.status };
      const result = Layer1Result.parse({ canonicalDomain: input.canonicalDomain,
        ...scoreEvidence({ website: website.data, bar: bar.data, avvo: avvo.data, sources, now: fetchedAt }), sources,
        meta: { scanDurationMs: Math.max(0, now() - start), cached: false, completedAt: new Date(now()).toISOString() } });
      const successful = Object.values(sources).filter(source => source.status === 'ok' || source.status === 'partial').length;
      return { status: successful === 0 ? 'FAILED' : Object.values(sources).every(source => source.status === 'ok') ? 'COMPLETED' : 'PARTIAL', result };
    } finally { clearTimeout(timer); }
  }
}

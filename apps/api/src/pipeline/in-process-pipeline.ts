import { createHash } from 'node:crypto';
import { Layer1Evidence, Layer1Result, type Layer1Pipeline, type WebsiteSource, type DirectorySource, type SourceResult,
  type SourceName, type PipelineResult, type WebsiteData, type AttorneyMatch } from '@arca/contracts';
import { evaluateLayer1Evidence } from '@arca/scoring';
import { normalizeDomain } from './domain-resolution.js';
import { buildFirmIdentity } from './firm-identity.js';
import type { ScanRepository } from '../repositories/types.js';

export class InProcessPipeline implements Layer1Pipeline {
  constructor(private readonly deps: {
    website: WebsiteSource; bar: DirectorySource; avvo: DirectorySource; repository: ScanRepository;
    timeoutMs?: number; now?: () => number;
  }) {}
  async run(input: { scanId: string; canonicalDomain: string; email: string }): Promise<PipelineResult> {
    if (!input.canonicalDomain || normalizeDomain(input.canonicalDomain) !== input.canonicalDomain) {
      throw new Error('A normalized canonical domain is required before assessment');
    }
    const now = this.deps.now ?? Date.now, start = now();
    const controller = new AbortController();
    const budget = this.deps.timeoutMs ?? 55_000;
    const timer = setTimeout(() => controller.abort(new Error('Source deadline reached')), budget - Math.min(5000, budget * 0.1));
    const signal = controller.signal;
    const unavailable = <T>(status: 'timeout' | 'error', started: number): SourceResult<T> => ({
      data: null, rawContent: null, status: { status, dataStatus: 'UNKNOWN', durationMs: Math.max(0, now() - started),
        code: status === 'timeout' ? 'DEADLINE_REACHED' : 'PROVIDER_ERROR', reason: `${status === 'timeout' ? 'Deadline reached' : 'Source unavailable'}` },
    });
    const insufficientIdentity = (): SourceResult<AttorneyMatch[]> => ({ data: null, rawContent: null,
      status: { status: 'skipped', dataStatus: 'UNKNOWN', durationMs: 0, code: 'INSUFFICIENT_IDENTITY',
        reason: 'No verified firm name or attorney identity was extracted', attorneysSearched: 0, attorneysFound: 0,
        candidatesReceived: 0, recordsValid: 0, providerRuns: [], costUsd: 0 } });
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
      const identity = buildFirmIdentity(input.canonicalDomain, website.data);
      const query = { canonicalDomain: input.canonicalDomain, names: identity.attorneyNames,
        firmName: identity.firmName, aliases: identity.aliases, city: identity.city, county: identity.county,
        addressStreet: identity.addressStreet, phone: identity.phone, state: 'FL' as const, scanId: input.scanId };
      const [bar, avvo] = identity.status === 'INSUFFICIENT' ? [insufficientIdentity(), insufficientIdentity()] : await Promise.all([
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
      const evidence = Layer1Evidence.parse({ identity, website: website.data, bar: bar.data, avvo: avvo.data,
        sources: { website: website.status, bar: bar.status, avvo: avvo.status }, observedAt: fetchedAt });
      // From this boundary onward Layer 1 is a pure transformation of structured evidence.
      const assessment = evaluateLayer1Evidence(evidence);
      const sources = assessment.sources;
      const result = Layer1Result.parse({ scanId: input.scanId, domain: input.canonicalDomain, email: input.email,
        ...assessment,
        meta: { scanDurationMs: Math.max(0, now() - start), cached: false, completedAt: new Date(now()).toISOString() } });
      const successful = Object.values(sources).filter(source => source.status === 'ok' || source.status === 'partial').length;
      return { status: successful === 0 ? 'FAILED' : Object.values(sources).every(source => source.status === 'ok') ? 'COMPLETED' : 'PARTIAL', result };
    } finally { clearTimeout(timer); }
  }
}

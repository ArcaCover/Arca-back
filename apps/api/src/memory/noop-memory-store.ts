import type { EvidenceItem, MemoryStore, RunRecord } from '@arca/contracts';

/**
 * Implementación única de esta fase: no persiste nada. Cuando el diseño de MongoDB esté
 * definido se agrega MongoMemoryStore junto a esta y no cambia nada más en el pipeline.
 */
export class NoopMemoryStore implements MemoryStore {
  constructor(private readonly log: (message: string) => void = () => {}) {}

  async saveEvidence(scanId: string, items: EvidenceItem[]): Promise<void> {
    const bytes = items.reduce((sum, item) => sum + item.content.length, 0);
    this.log(`[memory] evidence discarded scan=${scanId} items=${items.length} chars=${bytes}`);
  }

  async saveRunRecord(scanId: string, record: RunRecord): Promise<void> {
    const failed = record.steps.filter((s) => s.status !== 'ok').map((s) => s.step);
    this.log(
      `[memory] run record discarded scan=${scanId} domain=${record.domain} ` +
        `duration=${record.duration_ms}ms confidence=${record.confidence}` +
        (failed.length > 0 ? ` degraded=[${failed.join(',')}]` : ''),
    );
  }
}

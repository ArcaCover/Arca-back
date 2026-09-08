import type { ScanRepository, ScanRecord, RawRecord } from './types.js';
import type { SourceName } from '@arca/contracts';

export class InMemoryRepository implements ScanRepository {
  readonly scans = new Map<string, ScanRecord>();
  readonly raw: RawRecord[] = [];
  async create(scan: ScanRecord) {
    if (this.scans.has(scan.scan_id)) throw new Error('Duplicate scan');
    this.scans.set(scan.scan_id, structuredClone(scan));
  }
  async get(scanId: string) { return structuredClone(this.scans.get(scanId) ?? null); }
  async complete(scanId: string, update: Pick<ScanRecord, 'status' | 'result' | 'completed_at' | 'duration_ms'>) {
    const scan = this.scans.get(scanId);
    if (!scan) throw new Error('Scan not found');
    Object.assign(scan, structuredClone(update));
  }
  async cached(domain: string, since: string) {
    return structuredClone([...this.scans.values()].filter(s => s.canonical_domain === domain && !s.cached &&
      s.status === 'COMPLETED' && s.completed_at !== null && s.completed_at >= since)
      .sort((a, b) => b.completed_at!.localeCompare(a.completed_at!))[0] ?? null);
  }
  async saveRaw(record: RawRecord) { this.raw.push(structuredClone(record)); }
  async latestRaw(domain: string, source: SourceName) {
    return structuredClone(this.raw.filter(r => r.source === source && this.scans.get(r.scan_id)?.canonical_domain === domain)
      .sort((a, b) => b.fetched_at.localeCompare(a.fetched_at))[0] ?? null);
  }
  async recoverInterrupted(before: string) {
    for (const scan of this.scans.values()) if (scan.status === 'RUNNING' && scan.created_at < before) {
      scan.status = 'FAILED'; scan.completed_at = new Date().toISOString();
    }
  }
}

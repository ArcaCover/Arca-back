import type { Layer1Result, ScanStatus, SourceName, DomainResolution } from '@arca/contracts';

export type ScanRecord = {
  id: string; scan_id: string; email: string; canonical_domain: string; domain_resolution: DomainResolution; status: ScanStatus;
  result: Layer1Result | null; created_at: string; completed_at: string | null;
  duration_ms: number | null; cached: boolean;
};
export type RawRecord = {
  scan_id: string; source: SourceName; raw_content: string; content_hash: string; fetched_at: string;
};
export interface ScanRepository {
  create(scan: ScanRecord): Promise<void>;
  get(scanId: string): Promise<ScanRecord | null>;
  complete(scanId: string, update: Pick<ScanRecord, 'status' | 'result' | 'completed_at' | 'duration_ms'>): Promise<void>;
  cached(domain: string, since: string): Promise<ScanRecord | null>;
  saveRaw(record: RawRecord): Promise<void>;
  latestRaw(domain: string, source: SourceName): Promise<RawRecord | null>;
  recoverInterrupted(before: string): Promise<void>;
}

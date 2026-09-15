import type { Layer1Result, ScanStatus, SourceName, DomainResolution } from '@arca/contracts';

export type ScanRecord = {
  id: string; scan_id: string; email: string; canonical_domain: string; domain_resolution: DomainResolution; status: ScanStatus;
  result: Layer1Result | null; created_at: string; completed_at: string | null;
  duration_ms: number | null; cached: boolean;
};
export type RawRecord = {
  scan_id: string; source: SourceName; raw_content: string; content_hash: string; fetched_at: string;
};
export type ApifyRunRecord = {
  id: string; query_fingerprint: string; actor: string; build: string; build_id: string | null;
  build_number: string | null; input_json: Record<string, unknown>;
  run_id: string | null; dataset_id: string | null; status: string; items: unknown[] | null;
  item_count: number; accepted_count: number; cost_usd: number | null; reserved_usd: number;
  accounting_complete: boolean; partial: boolean; created_at: string; updated_at: string;
  expires_at: string; last_error: string | null;
};
export type ApifyRunReservation = { decision: 'start' | 'reuse' | 'resume' | 'failed' | 'budget_exceeded';
  record: ApifyRunRecord | null; chargedToScan: boolean };
export type ReserveApifyRun = {
  scanId?: string; queryFingerprint: string; actor: string; build: string; input: Record<string, unknown>;
  maxCostUsd: number; maxScanCostUsd: number; maxDailyCostUsd: number; expiresAt: string;
};
export type ApifyRunUpdate = Partial<Pick<ApifyRunRecord, 'run_id' | 'dataset_id' | 'build_id' | 'build_number' | 'status' | 'items' |
  'item_count' | 'accepted_count' | 'cost_usd' | 'accounting_complete' | 'partial' | 'expires_at' | 'last_error'>>;
export interface ScanRepository {
  create(scan: ScanRecord): Promise<void>;
  get(scanId: string): Promise<ScanRecord | null>;
  complete(scanId: string, update: Pick<ScanRecord, 'status' | 'result' | 'completed_at' | 'duration_ms'>): Promise<void>;
  cached(domain: string, since: string): Promise<ScanRecord | null>;
  saveRaw(record: RawRecord): Promise<void>;
  latestRaw(domain: string, source: SourceName): Promise<RawRecord | null>;
  recoverInterrupted(before: string): Promise<void>;
  reserveApifyRun(request: ReserveApifyRun): Promise<ApifyRunReservation>;
  getApifyRun(id: string): Promise<ApifyRunRecord | null>;
  updateApifyRun(id: string, update: ApifyRunUpdate): Promise<void>;
}

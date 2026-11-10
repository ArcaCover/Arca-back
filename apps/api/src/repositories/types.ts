import type { Layer1Result, ScanStatus, SourceName, DomainResolution } from '@arca/contracts';

// Ledger statuses of a run that may still start, run or be resumed.
export const ACTIVE_APIFY_STATUSES = ['RESERVED', 'READY', 'RUNNING', 'TIMING-OUT', 'ABORTING', 'START_UNCERTAIN'];
// Ledger status of a run the spend ceiling refused. Nothing was sent to Apify, so the ceiling's sum leaves it out.
export const SPEND_CEILING_STATUS = 'SPEND_CEILING_REACHED';

export type ScanRecord = {
  id: string; scan_id: string; email: string; canonical_domain: string; domain_resolution: DomainResolution; status: ScanStatus;
  result: Layer1Result | null; created_at: string; completed_at: string | null;
  duration_ms: number | null; cached: boolean;
};
export type RawRecord = {
  scan_id: string; source: SourceName; raw_content: string; content_hash: string; fetched_at: string;
};
export type RawReference = Omit<RawRecord, 'raw_content'>;
/** What a marker searched in stored content may be made of: nothing a LIKE pattern or a query string reads as syntax. */
export const RAW_MARKER = /^[a-z0-9-]{8,}$/;
export type ApifyRunRecord = {
  id: string; query_fingerprint: string; actor: string; build: string; build_id: string | null;
  build_number: string | null; input_json: Record<string, unknown>;
  run_id: string | null; dataset_id: string | null; status: string; items: unknown[] | null;
  item_count: number; accepted_count: number; cost_usd: number | null; reserved_usd: number;
  accounting_complete: boolean; partial: boolean; created_at: string; updated_at: string;
  expires_at: string; last_error: string | null;
};
/** What the spend ceiling reads of a ledger row: enough to tell what the run cost, or may still cost. */
export type ApifySpendRecord = Pick<ApifyRunRecord, 'id' | 'run_id' | 'status' | 'cost_usd' | 'reserved_usd' |
  'accounting_complete' | 'created_at' | 'expires_at'>;
export type ApifyRunReservation = { decision: 'start' | 'reuse' | 'resume' | 'failed';
  record: ApifyRunRecord | null; chargedToScan: boolean };
export type ReserveApifyRun = {
  scanId?: string; queryFingerprint: string; actor: string; build: string; input: Record<string, unknown>;
  // Provisional cost booked against the run until its charges settle. Accounting: the cap, when there is one,
  // is the Apify client's spend ceiling, which adds these up.
  expectedCostUsd: number; expiresAt: string;
};
export type ApifyRunUpdate = Partial<Pick<ApifyRunRecord, 'run_id' | 'dataset_id' | 'build_id' | 'build_number' | 'status' | 'items' |
  'item_count' | 'accepted_count' | 'cost_usd' | 'accounting_complete' | 'partial' | 'expires_at' | 'last_error'>>;
export interface ScanRepository {
  create(scan: ScanRecord): Promise<void>;
  get(scanId: string): Promise<ScanRecord | null>;
  complete(scanId: string, update: Pick<ScanRecord, 'status' | 'result' | 'completed_at' | 'duration_ms'>): Promise<void>;
  cached(domain: string, since: string): Promise<ScanRecord | null>;
  saveRaw(record: RawRecord): Promise<void>;
  /**
   * Which stored raw records of a domain's source carry `marker` in their content, newest first: fetched since
   * `since`, at most `limit`. It returns no content, which is megabytes for a website: read one record with `rawOf`.
   * The marker is lowercase letters, digits and hyphens.
   */
  findRaw(domain: string, source: SourceName, marker: string, since: string, limit: number): Promise<RawReference[]>;
  /** The raw record a scan stored for a source. */
  rawOf(scanId: string, source: SourceName): Promise<RawRecord | null>;
  recoverInterrupted(before: string): Promise<void>;
  reserveApifyRun(request: ReserveApifyRun): Promise<ApifyRunReservation>;
  getApifyRun(id: string): Promise<ApifyRunRecord | null>;
  /** Finished runs whose charges are not booked yet: started (a run id exists) and no longer active. */
  pendingApifyAccounting(limit: number): Promise<ApifyRunRecord[]>;
  updateApifyRun(id: string, update: ApifyRunUpdate): Promise<void>;
  /**
   * Ledger rows created since `since`, newest first, at most `limit`, without their datasets and without the starts
   * the spend ceiling refused. The spend ceiling adds them up.
   */
  recentApifyRuns(since: string, limit: number): Promise<ApifySpendRecord[]>;
}

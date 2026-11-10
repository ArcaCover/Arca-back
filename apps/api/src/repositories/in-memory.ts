import { randomUUID } from 'node:crypto';
import type { ScanRepository, ScanRecord, RawRecord, ApifyRunRecord, ReserveApifyRun, ApifyRunReservation,
  ApifyRunUpdate, ApifySpendRecord } from './types.js';
import { RAW_MARKER } from './types.js';
import { LAYER1_CONTRACT_VERSION, type SourceName } from '@arca/contracts';
import { ACTIVE_APIFY_STATUSES, SPEND_CEILING_STATUS } from './types.js';

export class InMemoryRepository implements ScanRepository {
  readonly scans = new Map<string, ScanRecord>();
  readonly raw: RawRecord[] = [];
  readonly apifyRuns = new Map<string, ApifyRunRecord>();
  readonly scanApifyRuns = new Map<string, Map<string, boolean>>();
  /** Forgets everything. The debug reset uses it; production never calls it. */
  clear(): void {
    this.scans.clear(); this.raw.length = 0; this.apifyRuns.clear(); this.scanApifyRuns.clear();
  }
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
      s.result?.meta.contractVersion === LAYER1_CONTRACT_VERSION &&
      (s.status === 'COMPLETED' || s.status === 'PARTIAL') && s.completed_at !== null && s.completed_at >= since)
      .sort((a, b) => b.completed_at!.localeCompare(a.completed_at!))[0] ?? null);
  }
  async saveRaw(record: RawRecord) { this.raw.push(structuredClone(record)); }
  async latestRaw(domain: string, source: SourceName) {
    return structuredClone(this.raw.filter(r => r.source === source && this.scans.get(r.scan_id)?.canonical_domain === domain)
      .sort((a, b) => b.fetched_at.localeCompare(a.fetched_at))[0] ?? null);
  }
  async findRaw(domain: string, source: SourceName, marker: string, since: string, limit: number) {
    if (!RAW_MARKER.test(marker)) throw new Error('Invalid raw evidence marker');
    return this.raw.filter(r => r.source === source && this.scans.get(r.scan_id)?.canonical_domain === domain &&
      r.fetched_at >= since && r.raw_content.includes(marker))
      .sort((a, b) => b.fetched_at.localeCompare(a.fetched_at)).slice(0, limit)
      .map(({ scan_id, source, content_hash, fetched_at }) => ({ scan_id, source, content_hash, fetched_at }));
  }
  async rawOf(scanId: string, source: SourceName) {
    return structuredClone(this.raw.filter(r => r.scan_id === scanId && r.source === source)
      .sort((a, b) => b.fetched_at.localeCompare(a.fetched_at))[0] ?? null);
  }
  async recoverInterrupted(before: string) {
    for (const scan of this.scans.values()) if (scan.status === 'RUNNING' && scan.created_at < before) {
      scan.status = 'FAILED'; scan.completed_at = new Date().toISOString();
    }
  }
  async reserveApifyRun(request: ReserveApifyRun): Promise<ApifyRunReservation> {
    const now = new Date().toISOString();
    const existing = [...this.apifyRuns.values()].filter(run => run.query_fingerprint === request.queryFingerprint)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
    const attach = (id: string, charged: boolean) => {
      if (!request.scanId) return;
      const runs = this.scanApifyRuns.get(request.scanId) ?? new Map<string, boolean>();
      if (!runs.has(id)) runs.set(id, charged); this.scanApifyRuns.set(request.scanId, runs);
    };
    if (existing && existing.expires_at > now && (existing.items !== null || existing.dataset_id !== null) &&
      (existing.status === 'SUCCEEDED' || existing.partial)) {
      attach(existing.id, false); return { decision: 'reuse', record: structuredClone(existing), chargedToScan: false };
    }
    if (existing && ACTIVE_APIFY_STATUSES.includes(existing.status)
      && existing.expires_at > now) {
      attach(existing.id, false); return { decision: 'resume', record: structuredClone(existing), chargedToScan: false };
    }
    if (existing && existing.expires_at > now) {
      attach(existing.id, false); return { decision: 'failed', record: structuredClone(existing), chargedToScan: false };
    }
    // The ledger records spend and refuses nothing. A spend ceiling, where one is set, is the Apify client's.
    const record: ApifyRunRecord = { id: randomUUID(), query_fingerprint: request.queryFingerprint,
      actor: request.actor, build: request.build, build_id: null, build_number: null,
      input_json: structuredClone(request.input), run_id: null,
      dataset_id: null, status: 'RESERVED', items: null, item_count: 0, accepted_count: 0, cost_usd: null,
      reserved_usd: request.expectedCostUsd, accounting_complete: false, partial: false, created_at: now,
      updated_at: now, expires_at: request.expiresAt, last_error: null };
    this.apifyRuns.set(record.id, record); attach(record.id, true);
    return { decision: 'start', record: structuredClone(record), chargedToScan: true };
  }
  async pendingApifyAccounting(limit: number) {
    return structuredClone([...this.apifyRuns.values()].filter(run => run.run_id !== null && !run.accounting_complete &&
      !ACTIVE_APIFY_STATUSES.includes(run.status)).slice(0, limit));
  }
  async getApifyRun(id: string) { return structuredClone(this.apifyRuns.get(id) ?? null); }
  async updateApifyRun(id: string, update: ApifyRunUpdate) {
    const record = this.apifyRuns.get(id); if (!record) throw new Error('Apify run not found');
    Object.assign(record, structuredClone(update), { updated_at: new Date().toISOString() });
  }
  async recentApifyRuns(since: string, limit: number): Promise<ApifySpendRecord[]> {
    return [...this.apifyRuns.values()].filter(run => run.created_at >= since && run.status !== SPEND_CEILING_STATUS)
      .sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit)
      .map(({ id, run_id, status, cost_usd, reserved_usd, accounting_complete, created_at, expires_at }) =>
        ({ id, run_id, status, cost_usd, reserved_usd, accounting_complete, created_at, expires_at }));
  }
}

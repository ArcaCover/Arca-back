import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { LAYER1_CONTRACT_VERSION, type SourceName } from '@arca/contracts';
import { ACTIVE_APIFY_STATUSES, RAW_MARKER, SPEND_CEILING_STATUS } from './types.js';
import type { ScanRepository, ScanRecord, RawRecord, RawReference, ReserveApifyRun, ApifyRunReservation, ApifyRunRecord,
  ApifyRunUpdate, ApifySpendRecord } from './types.js';

/** How long the storage client waits for one request. */
export const STORAGE_TIMEOUT_MS = 5_000;
/**
 * How long it waits for a raw evidence write (DN-12 §15.5). A website record used to be megabytes and took longer than
 * STORAGE_TIMEOUT_MS to upload from a slow link: the client gave up after the database had stored it, and the scan ended
 * FAILED. Records are smaller now, but the upload still depends on the link.
 */
export const RAW_EVIDENCE_WRITE_TIMEOUT_MS = 60_000;
/** Writes of one raw record at most: the first, and one more when the row is not there after a lost answer. */
const RAW_WRITE_ATTEMPTS = 2;
/** How long to wait, after a lost answer, before looking again whether the row arrived. */
const RAW_RECHECK_DELAY_MS = 2_000;

/** The time a storage request may take: a raw evidence write gets RAW_EVIDENCE_WRITE_TIMEOUT_MS, anything else STORAGE_TIMEOUT_MS. */
export function storageTimeoutMs(input: string | URL | Request, init?: RequestInit): number {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')).toUpperCase();
  let path = '';
  try { path = new URL(url).pathname; } catch { /* not a URL the client builds */ }
  return method === 'POST' && path.endsWith('/rest/v1/scan_raw_data') ? RAW_EVIDENCE_WRITE_TIMEOUT_MS : STORAGE_TIMEOUT_MS;
}

export class SupabaseRepository implements ScanRepository {
  private readonly rawRecheckDelayMs: number;
  constructor(private readonly client: SupabaseClient, options: { rawRecheckDelayMs?: number } = {}) {
    this.rawRecheckDelayMs = options.rawRecheckDelayMs ?? RAW_RECHECK_DELAY_MS;
  }
  async create(scan: ScanRecord) {
    const { error } = await this.client.from('scans').insert(scan);
    if (error) throw new Error('Unable to create scan', { cause: error });
  }
  async get(scanId: string): Promise<ScanRecord | null> {
    const { data, error } = await this.client.from('scans').select('*').eq('scan_id', scanId).maybeSingle();
    if (error) throw new Error('Unable to read scan', { cause: error });
    return data;
  }
  async complete(scanId: string, update: Pick<ScanRecord, 'status' | 'result' | 'completed_at' | 'duration_ms'>) {
    const { data, error } = await this.client.from('scans').update(update).eq('scan_id', scanId).select('scan_id').single();
    if (error || !data) throw new Error('Unable to complete scan', { cause: error });
  }
  async cached(domain: string, since: string): Promise<ScanRecord | null> {
    const { data, error } = await this.client.from('scans').select('*').eq('canonical_domain', domain)
      .eq('cached', false).in('status', ['COMPLETED', 'PARTIAL']).gte('completed_at', since)
      .eq('result->meta->>contractVersion', LAYER1_CONTRACT_VERSION)
      .order('completed_at', { ascending: false }).limit(1).maybeSingle();
    if (error) throw new Error('Unable to read cache', { cause: error });
    return data;
  }
  /**
   * Stores a raw record once. A write whose answer is lost (the client stopped waiting, the link dropped, a 5xx) may
   * still have been stored: the row is looked for by scan, source and content hash, now and once more after a pause,
   * and a row found is the write done. Only then is it written again, once. A write the database refused (4xx) is not
   * repeated. The table has no unique key on (scan_id, source), so the look comes before any second write.
   */
  async saveRaw(record: RawRecord) {
    let failure: unknown = null;
    for (let attempt = 1; attempt <= RAW_WRITE_ATTEMPTS; attempt++) {
      const { error, status } = await this.client.from('scan_raw_data').insert(record);
      if (!error) return;
      failure = error;
      if (await this.rawStored(record)) return;
      if (status > 0 && status < 500) break;
      await new Promise(resolve => setTimeout(resolve, this.rawRecheckDelayMs));
      if (await this.rawStored(record)) return;
    }
    throw new Error('Unable to save evidence', { cause: failure });
  }
  /** Whether the raw record is stored. A look that fails says no. */
  private async rawStored(record: RawRecord): Promise<boolean> {
    const { data, error } = await this.client.from('scan_raw_data').select('scan_id').eq('scan_id', record.scan_id)
      .eq('source', record.source).eq('content_hash', record.content_hash).limit(1);
    return !error && (data?.length ?? 0) > 0;
  }
  // The database searches the content and returns ids only: a website record is large (megabytes before DN-12 §15.5),
  // and the storage client gives every read STORAGE_TIMEOUT_MS.
  async findRaw(domain: string, source: SourceName, marker: string, since: string, limit: number): Promise<RawReference[]> {
    if (!RAW_MARKER.test(marker)) throw new Error('Invalid raw evidence marker');
    const { data, error } = await this.client.from('scan_raw_data')
      .select('scan_id, source, content_hash, fetched_at, scans!inner(canonical_domain)')
      .eq('scans.canonical_domain', domain).eq('source', source).gte('fetched_at', since).like('raw_content', `%${marker}%`)
      .order('fetched_at', { ascending: false }).limit(limit);
    if (error) throw new Error('Unable to search evidence', { cause: error });
    return (data ?? []).map(({ scan_id, source, content_hash, fetched_at }) => ({ scan_id, source, content_hash, fetched_at }));
  }
  async rawOf(scanId: string, source: SourceName): Promise<RawRecord | null> {
    const { data, error } = await this.client.from('scan_raw_data').select('scan_id, source, raw_content, content_hash, fetched_at')
      .eq('scan_id', scanId).eq('source', source).order('fetched_at', { ascending: false }).limit(1).maybeSingle();
    if (error) throw new Error('Unable to read evidence', { cause: error });
    return data;
  }
  async recoverInterrupted(before: string) {
    const { error } = await this.client.from('scans').update({ status: 'FAILED', completed_at: new Date().toISOString() })
      .eq('status', 'RUNNING').lt('created_at', before);
    if (error) throw new Error('Unable to recover interrupted scans', { cause: error });
  }
  async reserveApifyRun(request: ReserveApifyRun): Promise<ApifyRunReservation> {
    const { data, error } = await this.client.rpc('reserve_apify_run', { p_scan_id: request.scanId ?? null,
      p_query_fingerprint: request.queryFingerprint, p_actor: request.actor, p_build: request.build,
      p_input_json: request.input, p_expected_cost_usd: request.expectedCostUsd,
      p_expires_at: request.expiresAt });
    if (error || !data) throw new Error('Unable to reserve Apify run', { cause: error });
    return data as ApifyRunReservation;
  }
  async getApifyRun(id: string): Promise<ApifyRunRecord | null> {
    const { data, error } = await this.client.from('apify_runs').select('*').eq('id', id).maybeSingle();
    if (error) throw new Error('Unable to read Apify run', { cause: error });
    return data;
  }
  async pendingApifyAccounting(limit: number): Promise<ApifyRunRecord[]> {
    const { data, error } = await this.client.from('apify_runs').select('*').eq('accounting_complete', false)
      .not('run_id', 'is', null).not('status', 'in', `(${ACTIVE_APIFY_STATUSES.join(',')})`)
      .order('updated_at', { ascending: true }).limit(limit);
    if (error) throw new Error('Unable to read unbooked Apify runs', { cause: error });
    return (data ?? []) as ApifyRunRecord[];
  }
  async updateApifyRun(id: string, update: ApifyRunUpdate) {
    const { data, error } = await this.client.from('apify_runs').update({ ...update, updated_at: new Date().toISOString() })
      .eq('id', id).select('id').single();
    if (error || !data) throw new Error('Unable to update Apify run', { cause: error });
  }
  async recentApifyRuns(since: string, limit: number): Promise<ApifySpendRecord[]> {
    // Never `*`: `items` holds whole datasets. Refused starts count nothing, and a roster refused scan after scan
    // must not fill the rows the sum can read.
    const { data, error } = await this.client.from('apify_runs')
      .select('id,run_id,status,cost_usd,reserved_usd,accounting_complete,created_at,expires_at')
      .gte('created_at', since).neq('status', SPEND_CEILING_STATUS).order('created_at', { ascending: false }).limit(limit);
    if (error) throw new Error('Unable to read recent Apify runs', { cause: error });
    return (data ?? []) as ApifySpendRecord[];
  }
}
export function createStorageClient(url: string, key: string) {
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (input, init) => {
      const timeout = AbortSignal.timeout(storageTimeoutMs(input, init));
      return fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
    } } });
}
export function createRepository(url: string, key: string) {
  return new SupabaseRepository(createStorageClient(url, key));
}

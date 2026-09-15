import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { LAYER1_CONTRACT_VERSION, type SourceName } from '@arca/contracts';
import type { ScanRepository, ScanRecord, RawRecord, ReserveApifyRun, ApifyRunReservation, ApifyRunRecord,
  ApifyRunUpdate } from './types.js';

export class SupabaseRepository implements ScanRepository {
  constructor(private readonly client: SupabaseClient) {}
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
  async saveRaw(record: RawRecord) {
    const { error } = await this.client.from('scan_raw_data').insert(record);
    if (error) throw new Error('Unable to save evidence', { cause: error });
  }
  async latestRaw(domain: string, source: SourceName): Promise<RawRecord | null> {
    const { data, error } = await this.client.from('scan_raw_data').select('*, scans!inner(canonical_domain)')
      .eq('scans.canonical_domain', domain).eq('source', source).order('fetched_at', { ascending: false }).limit(1).maybeSingle();
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
      p_input_json: request.input, p_max_cost_usd: request.maxCostUsd,
      p_max_scan_cost_usd: request.maxScanCostUsd, p_max_daily_cost_usd: request.maxDailyCostUsd,
      p_expires_at: request.expiresAt });
    if (error || !data) throw new Error('Unable to reserve Apify run', { cause: error });
    return data as ApifyRunReservation;
  }
  async getApifyRun(id: string): Promise<ApifyRunRecord | null> {
    const { data, error } = await this.client.from('apify_runs').select('*').eq('id', id).maybeSingle();
    if (error) throw new Error('Unable to read Apify run', { cause: error });
    return data;
  }
  async updateApifyRun(id: string, update: ApifyRunUpdate) {
    const { data, error } = await this.client.from('apify_runs').update({ ...update, updated_at: new Date().toISOString() })
      .eq('id', id).select('id').single();
    if (error || !data) throw new Error('Unable to update Apify run', { cause: error });
  }
}
export function createRepository(url: string, key: string) {
  return new SupabaseRepository(createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (input, init) => fetch(input, { ...init,
      signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000) }) } }));
}

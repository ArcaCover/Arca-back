import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type {
  AssessmentRecord,
  AssessmentRepository,
  FirmRecord,
  FirmRepository,
  FirmUpsert,
  LeadRecord,
  LeadRepository,
  Repositories,
  ScanRecord,
  ScanRepository,
} from './types.js';

/** Cliente con SERVICE_ROLE_KEY: el backend es el único que toca las tablas en Fase 1. */
export function createSupabaseClient(url: string, serviceRoleKey: string): SupabaseClient {
  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Convierte un error de PostgREST en algo que se pueda leer en un log. */
function fail(operation: string, error: { message: string; code?: string }): never {
  throw new Error(`supabase ${operation} failed: ${error.message}${error.code ? ` (${error.code})` : ''}`);
}

class SupabaseFirmRepository implements FirmRepository {
  constructor(private readonly client: SupabaseClient) {}

  async upsertByDomain(firm: FirmUpsert): Promise<FirmRecord> {
    // onConflict en domain: reescanear una firma actualiza sus datos en vez de duplicarla.
    const { data, error } = await this.client
      .from('firms')
      .upsert({ ...firm, updated_at: new Date().toISOString() }, { onConflict: 'domain' })
      .select()
      .single();
    if (error) fail('firms.upsert', error);
    return data as FirmRecord;
  }
}

class SupabaseLeadRepository implements LeadRepository {
  constructor(private readonly client: SupabaseClient) {}

  async capture(lead: Pick<LeadRecord, 'email' | 'domain' | 'firm_id' | 'source'>): Promise<LeadRecord> {
    const { data, error } = await this.client
      .from('leads')
      .upsert(
        { ...lead, status: 'email_captured', last_activity_at: new Date().toISOString() },
        { onConflict: 'email,domain' },
      )
      .select()
      .single();
    if (error) fail('leads.capture', error);
    return data as LeadRecord;
  }

  async updateProgress(
    id: string,
    changes: Partial<Pick<LeadRecord, 'status' | 'firm_id' | 'pre_score' | 'composite_score'>>,
  ): Promise<void> {
    const { error } = await this.client
      .from('leads')
      .update({ ...changes, last_activity_at: new Date().toISOString() })
      .eq('id', id);
    if (error) fail('leads.updateProgress', error);
  }

  async findByDomain(domain: string): Promise<LeadRecord | null> {
    const { data, error } = await this.client
      .from('leads')
      .select()
      .ilike('domain', domain)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) fail('leads.findByDomain', error);
    return (data as LeadRecord | null) ?? null;
  }
}

class SupabaseScanRepository implements ScanRepository {
  constructor(private readonly client: SupabaseClient) {}

  async create(scan: Omit<ScanRecord, 'created_at'>): Promise<ScanRecord> {
    const { data, error } = await this.client.from('scans').insert(scan).select().single();
    if (error) fail('scans.create', error);
    return data as ScanRecord;
  }

  async findById(id: string): Promise<ScanRecord | null> {
    const { data, error } = await this.client.from('scans').select().eq('id', id).maybeSingle();
    if (error) fail('scans.findById', error);
    return (data as ScanRecord | null) ?? null;
  }
}

class SupabaseAssessmentRepository implements AssessmentRepository {
  constructor(private readonly client: SupabaseClient) {}

  async create(assessment: Omit<AssessmentRecord, 'id' | 'created_at'>): Promise<AssessmentRecord> {
    const { data, error } = await this.client
      .from('assessments')
      .insert(assessment)
      .select()
      .single();
    if (error) fail('assessments.create', error);
    return data as AssessmentRecord;
  }

  async findByScanId(scanId: string): Promise<AssessmentRecord | null> {
    const { data, error } = await this.client
      .from('assessments')
      .select()
      .eq('scan_id', scanId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) fail('assessments.findByScanId', error);
    return (data as AssessmentRecord | null) ?? null;
  }
}

export function createSupabaseRepositories(client: SupabaseClient): Repositories {
  return {
    firms: new SupabaseFirmRepository(client),
    leads: new SupabaseLeadRepository(client),
    scans: new SupabaseScanRepository(client),
    assessments: new SupabaseAssessmentRepository(client),
  };
}

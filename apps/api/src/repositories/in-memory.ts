import { randomUUID } from 'node:crypto';
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

/**
 * Implementación en memoria de los mismos puertos. Existe para el test de integración: permite
 * ejercitar los handlers completos sin una instancia de Supabase corriendo.
 */
export class InMemoryRepositories implements Repositories {
  readonly firmsByDomain = new Map<string, FirmRecord>();
  readonly leadsById = new Map<string, LeadRecord>();
  readonly scansById = new Map<string, ScanRecord>();
  readonly assessmentsByScanId = new Map<string, AssessmentRecord>();

  readonly firms: FirmRepository = {
    upsertByDomain: async (firm: FirmUpsert) => {
      const existing = this.firmsByDomain.get(firm.domain);
      const record: FirmRecord = { id: existing?.id ?? randomUUID(), ...firm };
      this.firmsByDomain.set(firm.domain, record);
      return record;
    },
  };

  readonly leads: LeadRepository = {
    capture: async (lead) => {
      const key = `${lead.email.toLowerCase()}|${lead.domain.toLowerCase()}`;
      const existing = [...this.leadsById.values()].find(
        (l) => `${l.email.toLowerCase()}|${l.domain.toLowerCase()}` === key,
      );
      const record: LeadRecord = existing ?? {
        id: randomUUID(),
        ...lead,
        status: 'email_captured',
        pre_score: null,
        composite_score: null,
      };
      this.leadsById.set(record.id, { ...record, firm_id: lead.firm_id });
      return this.leadsById.get(record.id)!;
    },
    updateProgress: async (id, changes) => {
      const existing = this.leadsById.get(id);
      if (existing) this.leadsById.set(id, { ...existing, ...changes });
    },
    findByDomain: async (domain) =>
      [...this.leadsById.values()].find(
        (l) => l.domain.toLowerCase() === domain.toLowerCase(),
      ) ?? null,
  };

  readonly scans: ScanRepository = {
    create: async (scan) => {
      const record: ScanRecord = { ...scan, created_at: new Date().toISOString() };
      this.scansById.set(record.id, record);
      return record;
    },
    findById: async (id) => this.scansById.get(id) ?? null,
  };

  readonly assessments: AssessmentRepository = {
    create: async (assessment) => {
      const record: AssessmentRecord = {
        id: randomUUID(),
        ...assessment,
        created_at: new Date().toISOString(),
      };
      this.assessmentsByScanId.set(record.scan_id, record);
      return record;
    },
    findByScanId: async (scanId) => this.assessmentsByScanId.get(scanId) ?? null,
  };
}

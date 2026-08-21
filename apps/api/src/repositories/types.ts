import type { Layer1Result, Signal } from '@arca/contracts';
import type {
  ActionPlanItem,
  AssessmentResponse,
  Decision,
  DomainKey,
  DomainScore,
  OverrideRuleTriggered,
  PathToInsurability,
  PracticeArea,
  Pricing,
  Tier,
} from '@arca/scoring';

export type FirmRecord = {
  id: string;
  domain: string;
  name: string | null;
  city: string | null;
  state: string | null;
  attorneys_count: number | null;
  practice_areas: PracticeArea[];
  primary_practice: PracticeArea | null;
};

export type FirmUpsert = Omit<FirmRecord, 'id'>;

export type LeadStatus =
  | 'email_captured'
  | 'pre_scored'
  | 'assessment_started'
  | 'assessment_completed'
  | 'broker_requested'
  | 'checkout_started'
  | 'converted'
  | 'lost';

export type LeadRecord = {
  id: string;
  email: string;
  domain: string;
  firm_id: string | null;
  source: 'direct' | 'broker_invite' | 'broker_lead';
  status: LeadStatus;
  pre_score: number | null;
  composite_score: number | null;
};

export type ScanRecord = {
  id: string;
  firm_id: string;
  pre_score: number;
  tier: Tier;
  confidence: Layer1Result['pre_score']['confidence'];
  signals: Signal[];
  layer1_result: Layer1Result;
  created_at: string;
};

export type AssessmentRecord = {
  id: string;
  scan_id: string;
  responses: AssessmentResponse[];
  domain_scores: Partial<Record<DomainKey, DomainScore>>;
  composite_score: number;
  tier: Tier;
  decision: Decision;
  pricing: Pricing | null;
  override_rules_triggered: OverrideRuleTriggered[];
  action_plan: ActionPlanItem[];
  path_to_insurability: PathToInsurability | null;
  created_at: string;
};

/**
 * Puertos de persistencia. Los handlers dependen de estas interfaces, no de Supabase, para
 * que el test de integración pueda correr contra una implementación en memoria.
 */
export interface FirmRepository {
  upsertByDomain(firm: FirmUpsert): Promise<FirmRecord>;
}

export interface LeadRepository {
  capture(lead: Pick<LeadRecord, 'email' | 'domain' | 'firm_id' | 'source'>): Promise<LeadRecord>;
  updateProgress(
    id: string,
    changes: Partial<Pick<LeadRecord, 'status' | 'firm_id' | 'pre_score' | 'composite_score'>>,
  ): Promise<void>;
  /** Para avanzar el funnel cuando el request solo trae el scan, no el lead. */
  findByDomain(domain: string): Promise<LeadRecord | null>;
}

export interface ScanRepository {
  create(scan: Omit<ScanRecord, 'created_at'>): Promise<ScanRecord>;
  findById(id: string): Promise<ScanRecord | null>;
}

export interface AssessmentRepository {
  create(assessment: Omit<AssessmentRecord, 'id' | 'created_at'>): Promise<AssessmentRecord>;
  findByScanId(scanId: string): Promise<AssessmentRecord | null>;
}

export type Repositories = {
  firms: FirmRepository;
  leads: LeadRepository;
  scans: ScanRepository;
  assessments: AssessmentRepository;
};

import type { BillingStatus, Role } from '@arca/contracts';

// Records of the private webapp (DN-10 §4.2), in snake_case like the rows they map to.
export type ProfileRecord = {
  user_id: string; email: string; full_name: string | null; last_org_id: string | null; created_at: string;
};
export type OrganizationRecord = {
  id: string; name: string; domain: string | null; billing_status: BillingStatus; deleted_at: string | null;
  created_by: string; created_at: string;
};
export type MembershipRecord = {
  org_id: string; user_id: string; role: Role; invited_by: string | null; created_at: string;
};
export type InvitationRecord = {
  id: string; org_id: string; email: string; role: Exclude<Role, 'owner'>; token_hash: string; invited_by: string;
  expires_at: string; accepted_at: string | null; revoked_at: string | null; created_at: string;
};
export type OrgAnalysisRecord = {
  org_id: string; scan_id: string; assessment_id: string | null; claimed_by: string; claimed_at: string;
};
export type ClaimTicketRecord = {
  id_hash: string; scan_id: string; email: string; expires_at: string; used_at: string | null;
};
export type PlanRecord = {
  code: string; name: string; amount_cents: number; currency: string; interval: 'month' | 'year'; active: boolean;
};
export type SubscriptionRecord = {
  org_id: string; plan_code: string; customer_id: string | null; subscription_id: string | null; status: BillingStatus;
  current_period_end: string | null; updated_at: string;
};
export type DeletionRequestRecord = {
  id: string; org_id: string; requested_by: string; reason: string; status: 'pending' | 'approved' | 'rejected';
  reviewed_by: string | null; reviewed_at: string | null; review_note: string | null; created_at: string;
};
export type AuditRecord = {
  id: string; actor_user_id: string | null; org_id: string | null; action: string; target: string | null;
  data: Record<string, unknown>; created_at: string;
};

export type WebappConflictReason = 'scan_claimed' | 'last_owner' | 'already_member' | 'deletion_pending';
/** A rule of the data model that the write would break. The routes turn it into a 409. */
export class WebappConflict extends Error {
  constructor(readonly reason: WebappConflictReason) {
    super(`Webapp conflict: ${reason}`);
    this.name = 'WebappConflict';
  }
}

/**
 * Storage of the webapp. Reads return null (or an empty list) for what does not exist; a write that names a record
 * that does not exist throws a plain Error, so the caller looks it up first. The rules of the data model throw
 * WebappConflict and leave nothing half written.
 */
export interface WebappRepository {
  upsertProfile(profile: ProfileRecord): Promise<void>;
  getProfile(userId: string): Promise<ProfileRecord | null>;
  /** Atomic: the organization, its first owner and the claimed analysis go in together or not at all (`scan_claimed`). */
  createOrganization(org: OrganizationRecord, owner: MembershipRecord, analysis: OrgAnalysisRecord | null): Promise<void>;
  getOrganization(id: string): Promise<OrganizationRecord | null>;
  /** Includes deleted organizations (`deleted_at` set): the caller decides what to show. */
  listOrganizationsForUser(userId: string): Promise<Array<{ org: OrganizationRecord; role: Role }>>;
  /** Every organization, deleted ones included. */
  listOrganizations(): Promise<OrganizationRecord[]>;

  getMembership(orgId: string, userId: string): Promise<MembershipRecord | null>;
  listMembers(orgId: string): Promise<MembershipRecord[]>;
  /** `already_member` when the user already belongs to the organization. */
  addMember(member: MembershipRecord): Promise<void>;
  /** `last_owner` when it would leave the organization without an owner. */
  setRole(orgId: string, userId: string, role: Role): Promise<void>;
  /** `last_owner` when it would leave the organization without an owner. */
  removeMember(orgId: string, userId: string): Promise<void>;

  createInvitation(invitation: InvitationRecord): Promise<void>;
  /** Finds it whatever its state, so the caller can tell an accepted or revoked invitation from an unknown one. */
  findInvitationByHash(tokenHash: string): Promise<InvitationRecord | null>;
  /** Not accepted and not revoked. Expiry is the caller's call: it compares `expires_at` with its own clock. */
  listInvitations(orgId: string): Promise<InvitationRecord[]>;
  updateInvitation(id: string, patch: Partial<Pick<InvitationRecord, 'accepted_at' | 'revoked_at'>>): Promise<void>;

  /** `scan_claimed` when any organization already holds the scan. */
  claimAnalysis(analysis: OrgAnalysisRecord): Promise<void>;
  listAnalyses(orgId: string): Promise<OrgAnalysisRecord[]>;
  /** The claim of a scan, in whichever organization holds it, so a claim can be refused before any ticket is issued. */
  getAnalysisByScan(scanId: string): Promise<OrgAnalysisRecord | null>;

  createClaimTicket(ticket: ClaimTicketRecord): Promise<void>;
  getClaimTicket(idHash: string): Promise<ClaimTicketRecord | null>;
  /** True only for the call that spends it; false when it was already used or does not exist. */
  markClaimTicketUsed(idHash: string, at: string): Promise<boolean>;

  /** Every plan, inactive ones included: the public list filters on `active`. */
  listPlans(): Promise<PlanRecord[]>;
  getPlan(code: string): Promise<PlanRecord | null>;
  updatePlan(code: string, patch: Partial<Omit<PlanRecord, 'code'>>): Promise<void>;

  getSubscription(orgId: string): Promise<SubscriptionRecord | null>;
  upsertSubscription(subscription: SubscriptionRecord): Promise<void>;
  /** Moves `organizations.billing_status`, the value that gates access. The subscription row is written by upsertSubscription. */
  setBillingStatus(orgId: string, status: BillingStatus): Promise<void>;
  /** True for the first time an event id is seen, false for every repeat. */
  recordBillingEvent(id: string, type: string): Promise<boolean>;

  /** `deletion_pending` when the organization already has a pending request. */
  createDeletionRequest(request: DeletionRequestRecord): Promise<void>;
  getPendingDeletionRequest(orgId: string): Promise<DeletionRequestRecord | null>;
  listDeletionRequests(): Promise<DeletionRequestRecord[]>;
  getDeletionRequest(id: string): Promise<DeletionRequestRecord | null>;
  /** Only a pending request can be reviewed. */
  reviewDeletionRequest(id: string, status: 'approved' | 'rejected', reviewedBy: string, note: string | null, at: string): Promise<void>;
  /** Idempotent: the first deletion time stays. */
  markOrganizationDeleted(orgId: string, at: string): Promise<void>;

  isPlatformAdmin(userId: string): Promise<boolean>;
  grantPlatformAdmin(userId: string, grantedBy: string): Promise<void>;
  /** Append-only. */
  appendAudit(record: AuditRecord): Promise<void>;
  listAudit(orgId: string): Promise<AuditRecord[]>;
}

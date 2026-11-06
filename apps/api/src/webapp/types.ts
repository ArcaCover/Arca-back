import type { ActionStatus, AuditActorKind, BillingStatus, DomainKey, Role } from '@arca/contracts';

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
/** `seq` is numbered by the store on append (an identity column in SQL) and gives a strict order (DN-11 §4.3). */
export type AuditRecord = {
  id: string; seq: number; actor_kind: AuditActorKind; actor_user_id: string | null; org_id: string | null; action: string;
  target: string | null; data: Record<string, unknown>; created_at: string;
};
/** What appendAudit takes. The actor kind is required, as the column has no default: a row never passes as a member's by omission. */
export type NewAuditRecord = Omit<AuditRecord, 'seq'>;
/**
 * A page of the audit log, newest first (`created_at desc, seq desc`). `before` is the seq of the last row of the previous
 * page and the page goes on after that row in this order. The row is looked up within the same filter, so a seq that names no
 * row, or a row of another organization, gives an empty page.
 */
export type AuditPageQuery = { before?: number; limit: number };

// The action plan (DN-11 §4.2). An action of the assessment gets its row the first time something changes, and takes its
// title, detail and domain from the assessment; an action the organization wrote itself carries them in the row.
type ActionRecordBase = {
  id: string; org_id: string; status: ActionStatus; assignee_user_id: string | null; due_date: string | null;
  created_by: string; created_at: string; updated_by: string; updated_at: string;
};
export type AssessmentActionRecord = ActionRecordBase & {
  source: 'assessment'; scan_id: string; action_key: string; title: null; detail: null; domain: null;
};
export type CustomActionRecord = ActionRecordBase & {
  source: 'custom'; scan_id: null; action_key: null; title: string; detail: string | null; domain: DomainKey | null;
};
export type OrgActionRecord = AssessmentActionRecord | CustomActionRecord;
/**
 * What a change to the plan moves: only the fields it names, so a change made meanwhile to another field stays. Who changed it and
 * when are always written.
 */
export type ActionPatch = Partial<Pick<ActionRecordBase, 'status' | 'assignee_user_id' | 'due_date'>>
  & Pick<ActionRecordBase, 'updated_by' | 'updated_at'>;
/** How many actions of its own an organization keeps (DN-11 §4.2); the repository refuses the next with `action_limit`. */
export const MAX_CUSTOM_ACTIONS = 100;

/**
 * `already_invited` is what a SQL repository maps the unique index `invitations_pending_email_idx` to: one pending
 * invitation per email and organization. The service revokes the old one before inviting again, so it only shows up in a race.
 */
export type WebappConflictReason = 'scan_claimed' | 'last_owner' | 'already_member' | 'already_invited' | 'deletion_pending'
  | 'action_limit';
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
  updateOrganizationName(orgId: string, name: string): Promise<void>;
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

  /** Every row of the organization, from both sources and every plan, oldest first: the caller picks the current plan. */
  listActions(orgId: string): Promise<OrgActionRecord[]>;
  /** Null for an id of another organization too: the organization is part of the lookup. */
  getCustomAction(orgId: string, id: string): Promise<CustomActionRecord | null>;
  getAssessmentAction(orgId: string, scanId: string, actionKey: string): Promise<AssessmentActionRecord | null>;
  /**
   * Unique by (org_id, scan_id, action_key). The first write creates the row as given; on a row that exists, whoever created it,
   * only the fields of `patch` change (in SQL, the conflict branch sets only those columns). Returns the row as written. The scan
   * must be one this organization claimed.
   */
  upsertAssessmentAction(action: AssessmentActionRecord, patch: ActionPatch): Promise<AssessmentActionRecord>;
  /**
   * `action_limit` when the organization already keeps MAX_CUSTOM_ACTIONS of its own. The count and the insert are one step, so two
   * creations at 99 cannot both pass: a SQL repository locks the organization row (`select ... from organizations where id = $1 for
   * update`), then counts and inserts in that same transaction.
   */
  createCustomAction(action: CustomActionRecord): Promise<void>;
  countCustomActions(orgId: string): Promise<number>;
  /** An action of either source, by its id within the organization. Only the fields of `patch` change; returns the row as written. */
  updateAction(orgId: string, id: string, patch: ActionPatch): Promise<OrgActionRecord>;
  /** Only an action the organization wrote itself; the assessment's are never deleted (DN-11 D13). */
  deleteCustomAction(orgId: string, id: string): Promise<void>;
  /** Unassigns every action of the organization held by this user (DN-11 D15). Nothing else on the rows changes. */
  clearAssignee(orgId: string, userId: string): Promise<void>;

  /** Append-only. */
  appendAudit(record: NewAuditRecord): Promise<void>;
  listAudit(orgId: string, page: AuditPageQuery): Promise<AuditRecord[]>;
  /** Across organizations, or only one with `orgId`; rows with no organization appear only without it. */
  listAllAudit(page: AuditPageQuery & { orgId?: string }): Promise<AuditRecord[]>;
}

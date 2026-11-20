import type { ActionStatus, AuditActorKind, BillingStatus, DomainKey, Role } from '@arca/contracts';

// Records of the private webapp (DN-10 §4.2), in snake_case like the rows they map to.
/**
 * `user_id` is the Supabase Auth user's id, the `sub` of its tokens (DN-13 §4.5). A closed account (DELETE /me, §4.8) stays as a
 * tombstone: `deleted_at` set, and no email, name or last organization.
 */
export type ProfileRecord = {
  user_id: string; email: string | null; full_name: string | null; last_org_id: string | null; created_at: string;
  deleted_at: string | null;
};
/** What upsertProfile writes: a live profile. Only deleteAccount closes one. */
export type ProfileWrite = Omit<ProfileRecord, 'email' | 'deleted_at'> & { email: string };
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
/**
 * `stripe_price_id` is the catalog Price a checkout of the plan charges, and `stripe_product_id` its Product (DN-13 §6.1). Both are
 * null until `npm run stripe:catalog -- --apply` (or a price change from /admin) writes them; the amount, currency and interval mirror
 * that Price for display.
 */
export type PlanRecord = {
  code: string; name: string; amount_cents: number; currency: string; interval: 'month' | 'year'; active: boolean;
  stripe_product_id: string | null; stripe_price_id: string | null;
};
/**
 * The subscription an organization holds, one row per organization (DN-10 §4.2). `status` is the mapped billing status (§6.6);
 * `provider_status` and the rest are what Stripe last said, raw, for support and the reconciliation (§5.3).
 */
export type SubscriptionRecord = {
  org_id: string; plan_code: string; customer_id: string | null; subscription_id: string | null; status: BillingStatus;
  current_period_end: string | null; updated_at: string; provider_status: string | null; price_id: string | null;
  cancel_at_period_end: boolean; current_period_start: string | null; livemode: boolean | null;
};
/** The Stripe customer of an organization (DN-13 §6.2): one per organization, created by the back on the first checkout. */
export type BillingCustomerRecord = { org_id: string; customer_id: string; livemode: boolean; created_at: string };
/** A Stripe Checkout Session the back opened (DN-13 §6.2). At most one `open` per organization. */
export type CheckoutSessionRecord = {
  id: string; org_id: string; plan_code: string; url: string; status: 'open' | 'complete' | 'expired'; created_by: string; expires_at: string;
  created_at: string;
};
/**
 * How closeBillingEvent leaves an event that moves no subscription: why it was not applied (`unknown_org`), and the audit row, as the
 * system, that it leaves in its organization.
 */
export type BillingEventClosing = { error: string | null; audit: { action: string; data: Record<string, unknown> } | null };
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
 * Who the audit rows a store writes itself name, as part of an atomic write (DN-13 §5.4). The service decides it (a member, ARCA
 * staff, or the system for the mock seed); the store only copies it.
 */
export type AuditActor = Pick<AuditRecord, 'actor_kind' | 'actor_user_id'>;
/**
 * What the service checked before asking for a member change, so the store can check it again against the rows as it locks them
 * (DN-13 §4.6): the acting member and the role it found them in, who the audit row names, and when.
 */
export type MemberChange = { actorUserId: string; actorRole: Role; audit: AuditActor; at: string };
/** The subscription state a provider event leads to, already mapped to a billing status (DN-13 §6.6). A null field keeps what is stored. */
export type BillingStateRecord = {
  status: BillingStatus; plan_code: string | null; customer_id: string | null; subscription_id: string | null;
  current_period_end: string | null; provider_status?: string | null; price_id?: string | null; cancel_at_period_end?: boolean | null;
  current_period_start?: string | null; livemode?: boolean | null;
};
/**
 * `duplicate`: the event was already processed. `duplicate_subscription`: it belongs to another subscription that pays while the
 * stored one is live, so it is audited and not applied (a double charge for a person to undo). `stale_subscription`: it belongs to
 * another subscription that gives no access, so it is only marked processed.
 */
export type BillingApplyOutcome = 'applied' | 'duplicate' | 'duplicate_subscription' | 'stale_subscription';
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
  | 'action_limit' | 'already_reviewed' | 'invitation_closed' | 'sole_owner';
/** A rule of the data model that the write would break. The routes turn it into a 409. */
export class WebappConflict extends Error {
  constructor(readonly reason: WebappConflictReason) {
    super(`Webapp conflict: ${reason}`);
    this.name = 'WebappConflict';
  }
}

/**
 * The assignee a write names may not hold an action (DN-11 D11): when the write runs, they are not a member of the organization,
 * or their role cannot update actions. The service answers it with the same 400 as its own earlier check.
 */
export class IneligibleAssignee extends Error {
  constructor() {
    super('The assignee cannot hold an action of this organization');
    this.name = 'IneligibleAssignee';
  }
}

/**
 * The actor's right over the member no longer holds when the store checks it again under its lock: the actor's role changed, or
 * the target's role did (an admin acting on someone just made owner). Nothing was written; the service answers 403.
 */
export class MemberChangeRefused extends Error {
  constructor() {
    super('The actor can no longer change this member');
    this.name = 'MemberChangeRefused';
  }
}

/**
 * Storage of the webapp. Reads return null (or an empty list) for what does not exist; a write that names a record
 * that does not exist throws a plain Error, so the caller looks it up first, except for a membership or an action, which another
 * request may delete between that lookup and the write: setRole, removeMember, updateAction and deleteCustomAction say so in
 * what they return. The rules of the data model throw WebappConflict or IneligibleAssignee and leave nothing half written.
 *
 * Who holds an action (DN-11 D11, D15) is a rule of the writes, not of an earlier read: every write that names an assignee checks
 * them, and the change that takes a user's right to hold actions away releases theirs in the same call. A SQL repository runs
 * each of these as one transaction:
 * - a write that names an assignee first takes `select role from memberships where org_id = $1 and user_id = $2 for share`
 *   and refuses unless the role can update actions, then writes;
 * - setRole and removeMember first take `select role from memberships where org_id = $1 and user_id = $2 for update` (no row:
 *   return false and write nothing), then change or delete the row. Only when the user is removed, or their new role cannot
 *   update actions (a viewer), do they also run `update org_actions set assignee_user_id = null where org_id = $1 and
 *   assignee_user_id = $2`; a change to a role that can (member, admin or owner) keeps the user's actions.
 * The two locks conflict, so a change to viewer or a removal waits for an assignment in flight and then releases it, or the
 * assignment waits for the change and then reads the new role.
 *
 * The actor's right over the target (canManageMember) is checked again by setRole and removeMember (DN-13 §4.6): the service passes
 * what it checked (MemberChange), and the store compares it with the actor's and the target's roles as it locks them, changing or
 * deleting nothing (MemberChangeRefused) when it no longer holds. The audit row of the change names the role the store found.
 *
 * The writes DN-13 §5.4 makes atomic write their own audit rows in the same step, naming the AuditActor they are given: setRole,
 * removeMember, acceptInvitation, revokeInvitation, reviewDeletionRequest, applyBillingState and, when asked, grantPlatformAdmin
 * and revokePlatformAdmin. The Supabase repository runs each as one RPC function (supabase/migrations/*_real_accounts_billing.sql).
 */
export interface WebappRepository {
  /**
   * One profile per email, in any case, among the live ones: another user's email is refused with a plain Error. A closed account's
   * profile is never brought back: writing it is refused with a plain Error, so a request that raced DELETE /me fails instead.
   */
  upsertProfile(profile: ProfileWrite): Promise<void>;
  getProfile(userId: string): Promise<ProfileRecord | null>;
  /** The live profile of an email, in any case. A user has one once they signed in (ensureProfile); a closed account has none. */
  findProfileByEmail(email: string): Promise<ProfileRecord | null>;
  /**
   * Closes an account in one step (DN-13 §4.8, the delete_account RPC): `sole_owner`, with nothing written, while the user is the
   * only owner of an organization that is not deleted. Otherwise their memberships of organizations that are not deleted go (a
   * deleted one keeps its history), with the actions they held there released and `account.deleted` audited in each, every
   * pending invitation to their email is revoked (`invitation.revoked`, reason `account_deleted`), and the profile, if any,
   * becomes a tombstone. The audit rows name the user as a member. Returns the organizations that lost the member; a second call
   * finds nothing left to do and keeps the first deletion time.
   */
  deleteAccount(userId: string, at: string): Promise<{ orgIds: string[] }>;
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
  /**
   * `last_owner` when it would leave the organization without an owner; MemberChangeRefused when the change no longer holds. A
   * role that cannot update actions (a viewer) holds none: the same call unassigns every action of the organization the user held,
   * and nothing else on those rows changes. Audits `member.role_changed` with the role it found, unless that is already the new
   * one. Returns the role the user had, or null when they are not a member, as when another request removed them after the caller
   * read it: then nothing is written.
   */
  setRole(orgId: string, userId: string, role: Role, change: MemberChange): Promise<Role | null>;
  /**
   * `last_owner` and MemberChangeRefused as setRole. The same call unassigns every action of the organization the user held
   * (DN-11 D15), and they stay unassigned if the user comes back, and revokes the pending invitations of their email there, or a
   * link would let them back in. Audits `member.removed`, then each `invitation.revoked`. Returns the role the user had, or null
   * when there was none to remove, as for the second of two removals that race.
   */
  removeMember(orgId: string, userId: string, change: MemberChange): Promise<Role | null>;

  createInvitation(invitation: InvitationRecord): Promise<void>;
  /** Finds it whatever its state, so the caller can tell an accepted or revoked invitation from an unknown one. */
  findInvitationByHash(tokenHash: string): Promise<InvitationRecord | null>;
  /** Not accepted and not revoked. Expiry is the caller's call: it compares `expires_at` with its own clock. */
  listInvitations(orgId: string): Promise<InvitationRecord[]>;
  updateInvitation(id: string, patch: Partial<Pick<InvitationRecord, 'accepted_at' | 'revoked_at'>>): Promise<void>;
  /**
   * In one step: the membership (someone who already belongs keeps their role), the acceptance, every other pending invitation of
   * that email in the organization revoked (`invitation.revoked`, reason `accepted`) and `member.joined` when they joined.
   * `invitation_closed` when it was accepted or revoked by then, as for the second of two accepts that race; a plain Error when it
   * does not exist. Expiry is the caller's.
   */
  acceptInvitation(invitationId: string, userId: string, at: string, actor: AuditActor): Promise<{ joined: boolean; role: Role }>;
  /**
   * Revokes a pending invitation of this organization and audits `invitation.revoked`, with the reason when given. True only for
   * the call that revoked it: the second of two revokes, or an invitation of another organization, writes nothing.
   */
  revokeInvitation(orgId: string, invitationId: string, at: string, actor: AuditActor, reason: 'reinvited' | null): Promise<boolean>;

  /** `scan_claimed` when any organization already holds the scan. */
  claimAnalysis(analysis: OrgAnalysisRecord): Promise<void>;
  listAnalyses(orgId: string): Promise<OrgAnalysisRecord[]>;
  /** The claim of a scan, in whichever organization holds it, so a claim can be refused before any ticket is issued. */
  getAnalysisByScan(scanId: string): Promise<OrgAnalysisRecord | null>;

  createClaimTicket(ticket: ClaimTicketRecord): Promise<void>;
  getClaimTicket(idHash: string): Promise<ClaimTicketRecord | null>;
  /** True only for the call that spends it; false when it was already used or does not exist. */
  markClaimTicketUsed(idHash: string, at: string): Promise<boolean>;

  /** Every plan, inactive ones included: the public list filters on `active`. A Stripe price id belongs to one plan at most. */
  listPlans(): Promise<PlanRecord[]>;
  getPlan(code: string): Promise<PlanRecord | null>;
  updatePlan(code: string, patch: Partial<Omit<PlanRecord, 'code'>>): Promise<void>;

  getSubscription(orgId: string): Promise<SubscriptionRecord | null>;
  upsertSubscription(subscription: SubscriptionRecord): Promise<void>;
  /** Moves `organizations.billing_status`, the value that gates access. The subscription row is written by upsertSubscription. */
  setBillingStatus(orgId: string, status: BillingStatus): Promise<void>;
  /** True for the first time an event id is seen, false for every repeat. Seeing an event is not processing it. */
  recordBillingEvent(id: string, type: string): Promise<boolean>;
  /**
   * Records the event and applies the state in one step (DN-13 §6.5): the subscription, billing_status and `billing.event_applied`
   * (as the system), or nothing. An event already processed is a duplicate whatever its state. An organization that does not exist
   * throws a plain Error and records nothing.
   */
  applyBillingState(event: { id: string; type: string; livemode?: boolean | null }, orgId: string, state: BillingStateRecord,
    at: string): Promise<BillingApplyOutcome>;
  /** True once an event was processed (applied or closed), not when it was only seen. */
  isBillingEventProcessed(id: string): Promise<boolean>;
  /**
   * Marks an event that moves no subscription as processed, in one step with its audit row (as the system) when it names one and
   * an organization (DN-13 §6.5): a refund, a dispute, an expired checkout, or an event of no organization (`error`). `duplicate`
   * when it was processed already, and then nothing is written.
   */
  closeBillingEvent(event: { id: string; type: string; livemode?: boolean | null }, orgId: string | null, closing: BillingEventClosing,
    at: string): Promise<'recorded' | 'duplicate'>;

  getBillingCustomer(orgId: string): Promise<BillingCustomerRecord | null>;
  /** The organization of a Stripe customer, through the customer the back created for it. */
  findBillingCustomer(customerId: string): Promise<BillingCustomerRecord | null>;
  /**
   * Keeps the first customer of an organization: returns the one stored, which is this one unless another request stored its own
   * first. A customer id already stored for another organization is refused with a plain Error.
   */
  addBillingCustomer(customer: BillingCustomerRecord): Promise<BillingCustomerRecord>;
  /** The organization's open session that has not expired by `at`, if any. */
  getOpenCheckoutSession(orgId: string, at: string): Promise<CheckoutSessionRecord | null>;
  getCheckoutSession(id: string): Promise<CheckoutSessionRecord | null>;
  /**
   * Stores an open session (DN-13 §6.2): the organization's open sessions whose time passed by `at` become `expired` first. Returns
   * the open session the organization holds afterwards: this one, or the one another request stored first, and then this one is
   * not kept (checkout_sessions_open_idx).
   */
  addCheckoutSession(session: CheckoutSessionRecord, at: string): Promise<CheckoutSessionRecord>;
  /** Open or expired to complete, or open to expired. True when it changed the row; a completed session never changes again. */
  closeCheckoutSession(id: string, status: 'complete' | 'expired'): Promise<boolean>;

  /** `deletion_pending` when the organization already has a pending request. */
  createDeletionRequest(request: DeletionRequestRecord): Promise<void>;
  getPendingDeletionRequest(orgId: string): Promise<DeletionRequestRecord | null>;
  listDeletionRequests(): Promise<DeletionRequestRecord[]>;
  getDeletionRequest(id: string): Promise<DeletionRequestRecord | null>;
  /**
   * Only a pending request can be reviewed: `already_reviewed` otherwise, as for the second of two reviews that race. In one step
   * with the review, an approval marks the organization deleted (the first deletion time stays), and `org.deletion_<status>` is
   * audited.
   */
  reviewDeletionRequest(id: string, status: 'approved' | 'rejected', reviewedBy: string, note: string | null, at: string,
    actor: AuditActor): Promise<void>;
  /** Idempotent: the first deletion time stays. */
  markOrganizationDeleted(orgId: string, at: string): Promise<void>;

  isPlatformAdmin(userId: string): Promise<boolean>;
  /**
   * True when it granted the role, false when the user already had it. With `audit`, `platform_admin.granted` is written in the
   * same step, and only when it changed. `grantedBy` is null for the `admin:grant` script.
   */
  grantPlatformAdmin(userId: string, grantedBy: string | null, audit?: { actor: AuditActor; at: string }): Promise<boolean>;
  /** True when it took the role away; `platform_admin.revoked` as grantPlatformAdmin. */
  revokePlatformAdmin(userId: string, audit?: { actor: AuditActor; at: string }): Promise<boolean>;

  /** Every row of the organization, from both sources and every plan, oldest first: the caller picks the current plan. */
  listActions(orgId: string): Promise<OrgActionRecord[]>;
  /** Null for an id of another organization too: the organization is part of the lookup. */
  getCustomAction(orgId: string, id: string): Promise<CustomActionRecord | null>;
  getAssessmentAction(orgId: string, scanId: string, actionKey: string): Promise<AssessmentActionRecord | null>;
  /**
   * Unique by (org_id, scan_id, action_key). The first write creates the row as given; on a row that exists, whoever created it,
   * only the fields of `patch` change (in SQL, the conflict branch sets only those columns). Returns the row as written. The scan
   * must be one this organization claimed. IneligibleAssignee when the row would name an assignee who cannot hold it.
   */
  upsertAssessmentAction(action: AssessmentActionRecord, patch: ActionPatch): Promise<AssessmentActionRecord>;
  /**
   * `action_limit` when the organization already keeps MAX_CUSTOM_ACTIONS of its own. The count and the insert are one step, so two
   * creations at 99 cannot both pass: a SQL repository locks the organization row (`select ... from organizations where id = $1 for
   * update`), then counts and inserts in that same transaction. IneligibleAssignee when it names an assignee who cannot hold it.
   */
  createCustomAction(action: CustomActionRecord): Promise<void>;
  countCustomActions(orgId: string): Promise<number>;
  /**
   * An action of either source, by its id within the organization. Only the fields of `patch` change; returns the row as written,
   * or null when the organization has no action with this id, as when another request deleted it after the caller read it (in
   * SQL, an `update ... returning` that returns no row). IneligibleAssignee when the patch names an assignee who cannot hold it.
   */
  updateAction(orgId: string, id: string, patch: ActionPatch): Promise<OrgActionRecord | null>;
  /**
   * Only an action the organization wrote itself; the assessment's are never deleted (DN-11 D13). True when it deleted the row,
   * false when there was none to delete, as for the second of two deletions that race (in SQL, a delete whose rowCount is 0).
   */
  deleteCustomAction(orgId: string, id: string): Promise<boolean>;

  /** Append-only. */
  appendAudit(record: NewAuditRecord): Promise<void>;
  listAudit(orgId: string, page: AuditPageQuery): Promise<AuditRecord[]>;
  /** Across organizations, or only one with `orgId`; rows with no organization appear only without it. */
  listAllAudit(page: AuditPageQuery & { orgId?: string }): Promise<AuditRecord[]>;
}

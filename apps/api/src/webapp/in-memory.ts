import { randomUUID } from 'node:crypto';
import { AUDIT_ACTOR_KINDS, can, canManageMember, type BillingStatus, type Role } from '@arca/contracts';
import { IneligibleAssignee, MAX_CUSTOM_ACTIONS, MemberChangeRefused, WebappConflict } from './types.js';
import type { ActionPatch, AssessmentActionRecord, AuditActor, AuditPageQuery, AuditRecord, BillingApplyOutcome, BillingCustomerRecord,
  BillingEventClosing, BillingStateRecord, CheckoutSessionRecord, ClaimTicketRecord, CustomActionRecord, DeletionRequestRecord, InvitationRecord, MemberChange, MembershipRecord, NewAuditRecord,
  OrgActionRecord, OrgAnalysisRecord, OrganizationRecord, PlanRecord, ProfileRecord, ProfileWrite, SubscriptionRecord, WebappRepository } from './types.js';

// updatePlan can change these and nothing else; the code is the identity of the plan.
const PLAN_FIELDS = ['name', 'amount_cents', 'currency', 'interval', 'active', 'stripe_product_id', 'stripe_price_id'] as const;
// What upsertAssessmentAction and updateAction may move on an existing row: the fields a patch names, nothing else.
const TRACKED_FIELDS = ['status', 'assignee_user_id', 'due_date', 'updated_by', 'updated_at'] as const;
const applyPatch = <T extends OrgActionRecord>(action: T, patch: ActionPatch): T =>
  Object.assign(action, Object.fromEntries(TRACKED_FIELDS.filter(field => patch[field] !== undefined).map(field => [field, patch[field]])));

// The audit order, created_at desc then seq desc: negative when `a` comes first.
const newestFirst = (a: AuditRecord, b: AuditRecord) => (Date.parse(b.created_at) - Date.parse(a.created_at)) || b.seq - a.seq;
const sameEmail = (a: string | null, b: string) => a !== null && a.toLowerCase() === b.toLowerCase();
const pending = (invitation: InvitationRecord) => invitation.accepted_at === null && invitation.revoked_at === null;

/** Deliberately ephemeral, like the other in-memory repositories: reusing the object survives an app recreation, never a restart. */
export class InMemoryWebappRepository implements WebappRepository {
  private readonly seedPlans: readonly PlanRecord[];
  private readonly profiles = new Map<string, ProfileRecord>();
  private readonly organizations = new Map<string, OrganizationRecord>();
  private readonly memberships: MembershipRecord[] = [];
  private readonly invitations = new Map<string, InvitationRecord>();
  // Keyed by scan_id: the table's UNIQUE (scan_id) is what makes a scan claimable once.
  private readonly analyses = new Map<string, OrgAnalysisRecord>();
  private readonly tickets = new Map<string, ClaimTicketRecord>();
  private readonly plans = new Map<string, PlanRecord>();
  private readonly subscriptions = new Map<string, SubscriptionRecord>();
  // Seen events, and whether they were processed: only a processed one is a duplicate for applyBillingState (DN-13 §6.5).
  private readonly billingEvents = new Map<string, { type: string; processed: boolean }>();
  private readonly billingCustomers = new Map<string, BillingCustomerRecord>();
  private readonly checkoutSessions = new Map<string, CheckoutSessionRecord>();
  private readonly deletionRequests = new Map<string, DeletionRequestRecord>();
  private readonly platformAdmins = new Map<string, string | null>();
  private readonly actions: OrgActionRecord[] = [];
  private readonly auditLog: AuditRecord[] = [];
  // Like the identity column, it is never reset: a page cursor from before a clear() names no row instead of a new one.
  private auditSeq = 0;

  constructor(plans: readonly PlanRecord[]) {
    this.seedPlans = structuredClone(plans);
    this.clear();
  }

  /** Forgets everything and seeds the plans again, for the debug reset; production never calls it. */
  clear(): void {
    this.profiles.clear(); this.organizations.clear(); this.memberships.length = 0; this.invitations.clear();
    this.analyses.clear(); this.tickets.clear(); this.subscriptions.clear(); this.billingEvents.clear();
    this.billingCustomers.clear(); this.checkoutSessions.clear();
    this.deletionRequests.clear(); this.platformAdmins.clear(); this.actions.length = 0; this.auditLog.length = 0;
    this.plans.clear();
    for (const plan of this.seedPlans) this.plans.set(plan.code, structuredClone(plan));
  }

  async upsertProfile(profile: ProfileWrite) {
    // Like profiles_email_idx: one profile per email, in any case, among the live ones (a tombstone has no email).
    if ([...this.profiles.values()].some(p => p.user_id !== profile.user_id && sameEmail(p.email, profile.email))) {
      throw new Error('Duplicate profile email');
    }
    // Like profiles_email_unless_deleted: a closed account never gets an email back.
    if (this.profiles.get(profile.user_id)?.deleted_at) throw new Error('Deleted profile');
    this.profiles.set(profile.user_id, { ...structuredClone(profile), deleted_at: null });
  }
  async getProfile(userId: string) { return structuredClone(this.profiles.get(userId) ?? null); }
  async findProfileByEmail(email: string) {
    return structuredClone([...this.profiles.values()].find(p => sameEmail(p.email, email)) ?? null);
  }
  async deleteAccount(userId: string, at: string) {
    // What delete_account does, with every check before the first write and no await in between.
    const live = this.memberships.filter(m => m.user_id === userId && this.organizations.get(m.org_id)?.deleted_at === null)
      .sort((a, b) => a.org_id.localeCompare(b.org_id));
    if (live.some(m => m.role === 'owner' && this.ownerCount(m.org_id) === 1)) throw new WebappConflict('sole_owner');
    const actor: AuditActor = { actor_kind: 'member', actor_user_id: userId };
    for (const membership of live) {
      this.memberships.splice(this.memberships.indexOf(membership), 1);
      this.release(membership.org_id, userId);
      this.audit(actor, membership.org_id, 'account.deleted', userId, { role: membership.role }, at);
    }
    const profile = this.profiles.get(userId);
    if (profile?.email) {
      const links = [...this.invitations.values()].filter(i => pending(i) && sameEmail(i.email, profile.email!))
        .sort((a, b) => a.id.localeCompare(b.id));
      for (const invitation of links) {
        invitation.revoked_at = at;
        this.audit(actor, invitation.org_id, 'invitation.revoked', invitation.email, { invitationId: invitation.id, reason: 'account_deleted' }, at);
      }
    }
    if (profile) Object.assign(profile, { deleted_at: profile.deleted_at ?? at, email: null, full_name: null, last_org_id: null });
    return { orgIds: live.map(m => m.org_id) };
  }

  async createOrganization(org: OrganizationRecord, owner: MembershipRecord, analysis: OrgAnalysisRecord | null) {
    // Every check comes before the first write, so a refusal leaves nothing behind.
    if (owner.role !== 'owner' || owner.org_id !== org.id || (analysis && analysis.org_id !== org.id)) throw new Error('Invalid organization');
    if (this.organizations.has(org.id)) throw new Error('Duplicate organization');
    if (analysis && this.analyses.has(analysis.scan_id)) throw new WebappConflict('scan_claimed');
    const copy = structuredClone({ org, owner, analysis });
    this.organizations.set(org.id, copy.org);
    this.memberships.push(copy.owner);
    if (copy.analysis) this.analyses.set(copy.analysis.scan_id, copy.analysis);
  }
  async getOrganization(id: string) { return structuredClone(this.organizations.get(id) ?? null); }
  async updateOrganizationName(orgId: string, name: string) { this.requireOrganization(orgId).name = name; }
  async listOrganizationsForUser(userId: string) {
    return structuredClone([...this.organizations.values()].flatMap(org => {
      const membership = this.membership(org.id, userId);
      return membership ? [{ org, role: membership.role }] : [];
    }));
  }
  async listOrganizations() { return structuredClone([...this.organizations.values()]); }

  async getMembership(orgId: string, userId: string) { return structuredClone(this.membership(orgId, userId) ?? null); }
  async listMembers(orgId: string) { return structuredClone(this.memberships.filter(m => m.org_id === orgId)); }
  async addMember(member: MembershipRecord) {
    if (this.membership(member.org_id, member.user_id)) throw new WebappConflict('already_member');
    this.memberships.push(structuredClone(member));
  }
  async setRole(orgId: string, userId: string, role: Role, change: MemberChange) {
    const membership = this.checkedChange(orgId, userId, role, change);
    if (!membership) return null;
    const before = membership.role;
    if (before === role) return before;
    membership.role = role;
    if (!can(role, 'actions.update')) this.release(orgId, userId);
    this.audit(change.audit, orgId, 'member.role_changed', userId, { from: before, to: role }, change.at);
    return before;
  }
  async removeMember(orgId: string, userId: string, change: MemberChange) {
    const membership = this.checkedChange(orgId, userId, null, change);
    if (!membership) return null;
    this.memberships.splice(this.memberships.indexOf(membership), 1);
    this.release(orgId, userId);
    this.audit(change.audit, orgId, 'member.removed', userId, { role: membership.role }, change.at);
    // A link still pending for their email would let the removed member back in.
    const email = this.profiles.get(userId)?.email;
    for (const invitation of this.invitations.values()) {
      if (email && invitation.org_id === orgId && pending(invitation) && sameEmail(invitation.email, email)) {
        invitation.revoked_at = change.at;
        this.audit(change.audit, orgId, 'invitation.revoked', invitation.email, { invitationId: invitation.id, reason: 'member_removed' }, change.at);
      }
    }
    return membership.role;
  }

  async createInvitation(invitation: InvitationRecord) {
    if ([...this.invitations.values()].some(i => i.id === invitation.id || i.token_hash === invitation.token_hash)) throw new Error('Duplicate invitation');
    // Like invitations_pending_email_idx: one pending invitation per email and organization.
    if (pending(invitation) && [...this.invitations.values()].some(i => i.org_id === invitation.org_id && pending(i)
      && sameEmail(i.email, invitation.email))) throw new WebappConflict('already_invited');
    this.invitations.set(invitation.id, structuredClone(invitation));
  }
  async findInvitationByHash(tokenHash: string) {
    return structuredClone([...this.invitations.values()].find(i => i.token_hash === tokenHash) ?? null);
  }
  async listInvitations(orgId: string) {
    return structuredClone([...this.invitations.values()].filter(i => i.org_id === orgId && i.accepted_at === null && i.revoked_at === null));
  }
  async updateInvitation(id: string, patch: Partial<Pick<InvitationRecord, 'accepted_at' | 'revoked_at'>>) {
    const invitation = this.invitations.get(id);
    if (!invitation) throw new Error('Invitation not found');
    if (patch.accepted_at !== undefined) invitation.accepted_at = patch.accepted_at;
    if (patch.revoked_at !== undefined) invitation.revoked_at = patch.revoked_at;
  }
  async acceptInvitation(invitationId: string, userId: string, at: string, actor: AuditActor) {
    const invitation = this.invitations.get(invitationId);
    if (!invitation) throw new Error('Invitation not found');
    if (!pending(invitation)) throw new WebappConflict('invitation_closed');
    const existing = this.membership(invitation.org_id, userId);
    if (!existing) this.memberships.push({ org_id: invitation.org_id, user_id: userId, role: invitation.role, invited_by: invitation.invited_by, created_at: at });
    invitation.accepted_at = at;
    for (const other of this.invitations.values()) {
      if (other.org_id === invitation.org_id && other.id !== invitation.id && pending(other) && sameEmail(other.email, invitation.email)) {
        other.revoked_at = at;
        this.audit(actor, invitation.org_id, 'invitation.revoked', other.email, { invitationId: other.id, reason: 'accepted' }, at);
      }
    }
    if (!existing) this.audit(actor, invitation.org_id, 'member.joined', userId, { role: invitation.role, invitationId: invitation.id }, at);
    return { joined: !existing, role: existing?.role ?? invitation.role };
  }
  async revokeInvitation(orgId: string, invitationId: string, at: string, actor: AuditActor, reason: 'reinvited' | null) {
    const invitation = this.invitations.get(invitationId);
    if (!invitation || invitation.org_id !== orgId || !pending(invitation)) return false;
    invitation.revoked_at = at;
    this.audit(actor, orgId, 'invitation.revoked', invitation.email, reason === null ? { invitationId } : { invitationId, reason }, at);
    return true;
  }

  async claimAnalysis(analysis: OrgAnalysisRecord) {
    if (this.analyses.has(analysis.scan_id)) throw new WebappConflict('scan_claimed');
    this.analyses.set(analysis.scan_id, structuredClone(analysis));
  }
  async listAnalyses(orgId: string) { return structuredClone([...this.analyses.values()].filter(a => a.org_id === orgId)); }
  async getAnalysisByScan(scanId: string) { return structuredClone(this.analyses.get(scanId) ?? null); }

  async createClaimTicket(ticket: ClaimTicketRecord) {
    if (this.tickets.has(ticket.id_hash)) throw new Error('Duplicate claim ticket');
    this.tickets.set(ticket.id_hash, structuredClone(ticket));
  }
  async getClaimTicket(idHash: string) { return structuredClone(this.tickets.get(idHash) ?? null); }
  async markClaimTicketUsed(idHash: string, at: string) {
    const ticket = this.tickets.get(idHash);
    if (!ticket || ticket.used_at !== null) return false;
    ticket.used_at = at;
    return true;
  }

  async listPlans() { return structuredClone([...this.plans.values()]); }
  async getPlan(code: string) { return structuredClone(this.plans.get(code) ?? null); }
  async updatePlan(code: string, patch: Partial<Omit<PlanRecord, 'code'>>) {
    const plan = this.plans.get(code);
    if (!plan) throw new Error('Plan not found');
    // Like plans.stripe_price_id unique.
    if (patch.stripe_price_id && [...this.plans.values()].some(other => other.code !== code && other.stripe_price_id === patch.stripe_price_id)) {
      throw new Error('Duplicate plan price');
    }
    Object.assign(plan, Object.fromEntries(PLAN_FIELDS.filter(field => patch[field] !== undefined).map(field => [field, patch[field]])));
  }

  async getSubscription(orgId: string) { return structuredClone(this.subscriptions.get(orgId) ?? null); }
  async upsertSubscription(subscription: SubscriptionRecord) { this.putSubscription(subscription); }
  async setBillingStatus(orgId: string, status: BillingStatus) { this.requireOrganization(orgId).billing_status = status; }
  async recordBillingEvent(id: string, type: string) {
    if (this.billingEvents.has(id)) return false;
    this.billingEvents.set(id, { type, processed: false });
    return true;
  }
  async applyBillingState(event: { id: string; type: string }, orgId: string, state: BillingStateRecord, at: string): Promise<BillingApplyOutcome> {
    this.requireOrganization(orgId);
    const seen = this.billingEvents.get(event.id) ?? { type: event.type, processed: false };
    this.billingEvents.set(event.id, seen);
    if (seen.processed) return 'duplicate';
    const current = this.subscriptions.get(orgId);
    // An old subscription never overwrites the stored one; a new one takes its place once the stored one is canceled.
    if (current?.subscription_id && state.subscription_id && state.subscription_id !== current.subscription_id && current.status !== 'canceled') {
      seen.processed = true;
      if (state.status !== 'active' && state.status !== 'past_due') return 'stale_subscription';
      this.audit({ actor_kind: 'system', actor_user_id: null }, orgId, 'billing.duplicate_subscription', event.id,
        { type: event.type, subscriptionId: state.subscription_id, current: current.subscription_id }, at);
      return 'duplicate_subscription';
    }
    const planCode = state.plan_code ?? current?.plan_code ?? null;
    if (planCode) {
      // No await from the check of the event to here, so two deliveries that race cannot both apply. A null keeps what is stored.
      this.putSubscription({ org_id: orgId, plan_code: planCode, customer_id: state.customer_id ?? current?.customer_id ?? null,
        subscription_id: state.subscription_id ?? current?.subscription_id ?? null, status: state.status,
        current_period_end: state.current_period_end ?? current?.current_period_end ?? null, updated_at: at,
        provider_status: state.provider_status ?? current?.provider_status ?? null, price_id: state.price_id ?? current?.price_id ?? null,
        cancel_at_period_end: state.cancel_at_period_end ?? current?.cancel_at_period_end ?? false,
        current_period_start: state.current_period_start ?? current?.current_period_start ?? null,
        livemode: state.livemode ?? current?.livemode ?? null });
    }
    this.requireOrganization(orgId).billing_status = state.status;
    seen.processed = true;
    this.audit({ actor_kind: 'system', actor_user_id: null }, orgId, 'billing.event_applied', event.id,
      { type: event.type, status: state.status, planCode }, at);
    return 'applied';
  }

  async isBillingEventProcessed(id: string) { return this.billingEvents.get(id)?.processed === true; }
  async closeBillingEvent(event: { id: string; type: string }, orgId: string | null, closing: BillingEventClosing, at: string) {
    if (orgId !== null) this.requireOrganization(orgId);
    const seen = this.billingEvents.get(event.id) ?? { type: event.type, processed: false };
    this.billingEvents.set(event.id, seen);
    if (seen.processed) return 'duplicate' as const;
    seen.processed = true;
    if (orgId !== null && closing.audit) {
      this.audit({ actor_kind: 'system', actor_user_id: null }, orgId, closing.audit.action, event.id, structuredClone(closing.audit.data), at);
    }
    return 'recorded' as const;
  }

  async getBillingCustomer(orgId: string) { return structuredClone(this.billingCustomers.get(orgId) ?? null); }
  async findBillingCustomer(customerId: string) {
    return structuredClone([...this.billingCustomers.values()].find(customer => customer.customer_id === customerId) ?? null);
  }
  async addBillingCustomer(customer: BillingCustomerRecord) {
    this.requireOrganization(customer.org_id);
    const stored = this.billingCustomers.get(customer.org_id);
    if (stored) return structuredClone(stored);
    // Like billing_customers.customer_id unique.
    if ([...this.billingCustomers.values()].some(other => other.customer_id === customer.customer_id)) throw new Error('Duplicate billing customer');
    this.billingCustomers.set(customer.org_id, structuredClone(customer));
    return structuredClone(customer);
  }
  async getOpenCheckoutSession(orgId: string, at: string) {
    return structuredClone([...this.checkoutSessions.values()].find(session => session.org_id === orgId && session.status === 'open'
      && Date.parse(session.expires_at) > Date.parse(at)) ?? null);
  }
  async getCheckoutSession(id: string) { return structuredClone(this.checkoutSessions.get(id) ?? null); }
  async addCheckoutSession(session: CheckoutSessionRecord, at: string) {
    this.requireOrganization(session.org_id);
    for (const stored of this.checkoutSessions.values()) {
      if (stored.org_id === session.org_id && stored.status === 'open' && Date.parse(stored.expires_at) <= Date.parse(at)) stored.status = 'expired';
    }
    // Like checkout_sessions_open_idx: one open session per organization, whatever its expiry.
    const open = [...this.checkoutSessions.values()].find(stored => stored.org_id === session.org_id && stored.status === 'open');
    if (open) return structuredClone(open);
    if (this.checkoutSessions.has(session.id)) throw new Error('Duplicate checkout session');
    this.checkoutSessions.set(session.id, structuredClone(session));
    return structuredClone(session);
  }
  async closeCheckoutSession(id: string, status: 'complete' | 'expired') {
    const session = this.checkoutSessions.get(id);
    if (!session || session.status === 'complete' || (status === 'expired' && session.status !== 'open')) return false;
    session.status = status;
    return true;
  }

  async createDeletionRequest(request: DeletionRequestRecord) {
    if (this.deletionRequests.has(request.id)) throw new Error('Duplicate deletion request');
    if (this.pendingDeletion(request.org_id)) throw new WebappConflict('deletion_pending');
    this.deletionRequests.set(request.id, structuredClone(request));
  }
  async getPendingDeletionRequest(orgId: string) { return structuredClone(this.pendingDeletion(orgId) ?? null); }
  async listDeletionRequests() { return structuredClone([...this.deletionRequests.values()]); }
  async getDeletionRequest(id: string) { return structuredClone(this.deletionRequests.get(id) ?? null); }
  async reviewDeletionRequest(id: string, status: 'approved' | 'rejected', reviewedBy: string, note: string | null, at: string,
    actor: AuditActor) {
    const request = this.deletionRequests.get(id);
    if (!request) throw new Error('Deletion request not found');
    if (request.status !== 'pending') throw new WebappConflict('already_reviewed');
    Object.assign(request, { status, reviewed_by: reviewedBy, reviewed_at: at, review_note: note });
    if (status === 'approved') this.requireOrganization(request.org_id).deleted_at ??= at;
    this.audit(actor, request.org_id, `org.deletion_${status}`, id, { note }, at);
  }
  async markOrganizationDeleted(orgId: string, at: string) {
    const org = this.requireOrganization(orgId);
    org.deleted_at ??= at;
  }

  async isPlatformAdmin(userId: string) { return this.platformAdmins.has(userId); }
  async grantPlatformAdmin(userId: string, grantedBy: string | null, audit?: { actor: AuditActor; at: string }) {
    if (this.platformAdmins.has(userId)) return false;
    this.platformAdmins.set(userId, grantedBy);
    if (audit) this.audit(audit.actor, null, 'platform_admin.granted', userId, {}, audit.at);
    return true;
  }
  async revokePlatformAdmin(userId: string, audit?: { actor: AuditActor; at: string }) {
    if (!this.platformAdmins.delete(userId)) return false;
    if (audit) this.audit(audit.actor, null, 'platform_admin.revoked', userId, {}, audit.at);
    return true;
  }

  async listActions(orgId: string) { return structuredClone(this.actions.filter(a => a.org_id === orgId)); }
  async getCustomAction(orgId: string, id: string) { return structuredClone(this.customAction(orgId, id) ?? null); }
  async getAssessmentAction(orgId: string, scanId: string, actionKey: string) {
    return structuredClone(this.assessmentAction(orgId, scanId, actionKey) ?? null);
  }
  async upsertAssessmentAction(action: AssessmentActionRecord, patch: ActionPatch) {
    // The composite foreign key to org_analyses: only a scan this organization claimed has actions.
    if (this.analyses.get(action.scan_id)?.org_id !== action.org_id) throw new Error('Analysis not found');
    const existing = this.assessmentAction(action.org_id, action.scan_id, action.action_key);
    this.requireEligible(action.org_id, existing ? patch.assignee_user_id : action.assignee_user_id);
    if (existing) return structuredClone(applyPatch(existing, patch));
    if (this.actions.some(a => a.id === action.id)) throw new Error('Duplicate action');
    this.actions.push(structuredClone(action));
    return structuredClone(action);
  }
  async createCustomAction(action: CustomActionRecord) {
    this.requireOrganization(action.org_id);
    if (this.actions.some(a => a.id === action.id)) throw new Error('Duplicate action');
    // Counted here, with no await before the insert, so creations that race cannot pass the cap together.
    if (this.customCount(action.org_id) >= MAX_CUSTOM_ACTIONS) throw new WebappConflict('action_limit');
    this.requireEligible(action.org_id, action.assignee_user_id);
    this.actions.push(structuredClone(action));
  }
  async countCustomActions(orgId: string) { return this.customCount(orgId); }
  async updateAction(orgId: string, id: string, patch: ActionPatch) {
    const action = this.actions.find(a => a.org_id === orgId && a.id === id);
    if (!action) return null;
    this.requireEligible(orgId, patch.assignee_user_id);
    return structuredClone(applyPatch(action, patch));
  }
  async deleteCustomAction(orgId: string, id: string) {
    const action = this.customAction(orgId, id);
    if (!action) return false;
    this.actions.splice(this.actions.indexOf(action), 1);
    return true;
  }

  async appendAudit(record: NewAuditRecord) {
    // Like the column, which is not null, has no default and checks its values.
    if (!(AUDIT_ACTOR_KINDS as readonly unknown[]).includes(record.actor_kind)) throw new Error('An audit row names its actor kind');
    this.auditLog.push({ ...structuredClone(record), seq: ++this.auditSeq });
  }
  async listAudit(orgId: string, page: AuditPageQuery) { return this.auditPage(r => r.org_id === orgId, page); }
  async listAllAudit({ orgId, ...page }: AuditPageQuery & { orgId?: string }) {
    return this.auditPage(r => orgId === undefined || r.org_id === orgId, page);
  }

  /**
   * Keyset pagination on (created_at, seq), so rows whose clock disagrees with the insertion order are neither skipped nor repeated.
   * The cursor row is looked up within the same filter: a seq of another organization gives an empty page, not a place in its log.
   */
  private auditPage(include: (row: AuditRecord) => boolean, { before, limit }: AuditPageQuery) {
    const cursor = before === undefined ? null : this.auditLog.find(r => r.seq === before && include(r));
    if (cursor === undefined) return [];
    const rows = this.auditLog.filter(r => include(r) && (cursor === null || newestFirst(cursor, r) < 0));
    return structuredClone(rows.sort(newestFirst).slice(0, limit));
  }
  /**
   * Who holds an action is checked and written with no await in between, as setRole and removeMember change the role and release
   * in one step: whichever runs first, the other sees its result, so a viewer or a former member never ends up holding one
   * (DN-11 D11, D15).
   */
  private requireEligible(orgId: string, assignee: string | null | undefined) {
    if (typeof assignee !== 'string') return;
    const membership = this.membership(orgId, assignee);
    if (!membership || !can(membership.role, 'actions.update')) throw new IneligibleAssignee();
  }
  /**
   * What set_member_role and remove_member check under their locks (DN-13 §4.6), with no await in between: the actor still holds
   * the role the service read, the target is a member, the actor's role can still act on the target's role, and an owner is left.
   */
  private checkedChange(orgId: string, userId: string, next: Role | null, change: MemberChange) {
    if (this.membership(orgId, change.actorUserId)?.role !== change.actorRole) throw new MemberChangeRefused();
    const membership = this.membership(orgId, userId);
    if (!membership) return null;
    if (!canManageMember(change.actorRole, membership.role, next ?? undefined)) throw new MemberChangeRefused();
    if (membership.role === 'owner' && next !== 'owner' && this.ownerCount(orgId) === 1) throw new WebappConflict('last_owner');
    return membership;
  }
  /** Like subscriptions_subscription_idx: a provider subscription belongs to one organization. */
  private putSubscription(subscription: SubscriptionRecord) {
    if (subscription.subscription_id !== null && [...this.subscriptions.values()].some(s => s.org_id !== subscription.org_id
      && s.subscription_id === subscription.subscription_id)) throw new Error('Duplicate subscription');
    this.subscriptions.set(subscription.org_id, structuredClone(subscription));
  }
  /** An audit row the store writes itself, as part of the write that names it. */
  private audit(actor: AuditActor, orgId: string | null, action: string, target: string, data: Record<string, unknown>, at: string) {
    this.auditLog.push({ id: randomUUID(), seq: ++this.auditSeq, actor_kind: actor.actor_kind, actor_user_id: actor.actor_user_id, org_id: orgId,
      action, target, data, created_at: at });
  }
  /** Nothing else on the rows changes. */
  private release(orgId: string, userId: string) {
    for (const action of this.actions) if (action.org_id === orgId && action.assignee_user_id === userId) action.assignee_user_id = null;
  }
  private customCount(orgId: string) { return this.actions.filter(a => a.org_id === orgId && a.source === 'custom').length; }
  private customAction(orgId: string, id: string) {
    return this.actions.find((a): a is CustomActionRecord => a.org_id === orgId && a.id === id && a.source === 'custom');
  }
  private assessmentAction(orgId: string, scanId: string, actionKey: string) {
    return this.actions.find((a): a is AssessmentActionRecord => a.org_id === orgId && a.source === 'assessment' && a.scan_id === scanId
      && a.action_key === actionKey);
  }
  private membership(orgId: string, userId: string) { return this.memberships.find(m => m.org_id === orgId && m.user_id === userId); }
  private ownerCount(orgId: string) { return this.memberships.filter(m => m.org_id === orgId && m.role === 'owner').length; }
  private pendingDeletion(orgId: string) {
    return [...this.deletionRequests.values()].find(r => r.org_id === orgId && r.status === 'pending');
  }
  private requireOrganization(orgId: string) {
    const org = this.organizations.get(orgId);
    if (!org) throw new Error('Organization not found');
    return org;
  }
}

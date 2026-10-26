import type { BillingStatus, Role } from '@arca/contracts';
import { WebappConflict } from './types.js';
import type { AuditRecord, ClaimTicketRecord, DeletionRequestRecord, InvitationRecord, MembershipRecord, OrgAnalysisRecord,
  OrganizationRecord, PlanRecord, ProfileRecord, SubscriptionRecord, WebappRepository } from './types.js';

// updatePlan can change these and nothing else; the code is the identity of the plan.
const PLAN_FIELDS = ['name', 'amount_cents', 'currency', 'interval', 'active'] as const;

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
  private readonly billingEvents = new Map<string, string>();
  private readonly deletionRequests = new Map<string, DeletionRequestRecord>();
  private readonly platformAdmins = new Map<string, string>();
  private readonly auditLog: AuditRecord[] = [];

  constructor(plans: readonly PlanRecord[]) {
    this.seedPlans = structuredClone(plans);
    this.clear();
  }

  /** Forgets everything and seeds the plans again, for the debug reset; production never calls it. */
  clear(): void {
    this.profiles.clear(); this.organizations.clear(); this.memberships.length = 0; this.invitations.clear();
    this.analyses.clear(); this.tickets.clear(); this.subscriptions.clear(); this.billingEvents.clear();
    this.deletionRequests.clear(); this.platformAdmins.clear(); this.auditLog.length = 0;
    this.plans.clear();
    for (const plan of this.seedPlans) this.plans.set(plan.code, structuredClone(plan));
  }

  async upsertProfile(profile: ProfileRecord) { this.profiles.set(profile.user_id, structuredClone(profile)); }
  async getProfile(userId: string) { return structuredClone(this.profiles.get(userId) ?? null); }

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
  async setRole(orgId: string, userId: string, role: Role) {
    const membership = this.membership(orgId, userId);
    if (!membership) throw new Error('Member not found');
    if (membership.role === 'owner' && role !== 'owner' && this.ownerCount(orgId) === 1) throw new WebappConflict('last_owner');
    membership.role = role;
  }
  async removeMember(orgId: string, userId: string) {
    const membership = this.membership(orgId, userId);
    if (!membership) throw new Error('Member not found');
    if (membership.role === 'owner' && this.ownerCount(orgId) === 1) throw new WebappConflict('last_owner');
    this.memberships.splice(this.memberships.indexOf(membership), 1);
  }

  async createInvitation(invitation: InvitationRecord) {
    if ([...this.invitations.values()].some(i => i.id === invitation.id || i.token_hash === invitation.token_hash)) throw new Error('Duplicate invitation');
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

  async claimAnalysis(analysis: OrgAnalysisRecord) {
    if (this.analyses.has(analysis.scan_id)) throw new WebappConflict('scan_claimed');
    this.analyses.set(analysis.scan_id, structuredClone(analysis));
  }
  async listAnalyses(orgId: string) { return structuredClone([...this.analyses.values()].filter(a => a.org_id === orgId)); }

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
    Object.assign(plan, Object.fromEntries(PLAN_FIELDS.filter(field => patch[field] !== undefined).map(field => [field, patch[field]])));
  }

  async getSubscription(orgId: string) { return structuredClone(this.subscriptions.get(orgId) ?? null); }
  async upsertSubscription(subscription: SubscriptionRecord) { this.subscriptions.set(subscription.org_id, structuredClone(subscription)); }
  async setBillingStatus(orgId: string, status: BillingStatus) { this.requireOrganization(orgId).billing_status = status; }
  async recordBillingEvent(id: string, type: string) {
    if (this.billingEvents.has(id)) return false;
    this.billingEvents.set(id, type);
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
  async reviewDeletionRequest(id: string, status: 'approved' | 'rejected', reviewedBy: string, note: string | null, at: string) {
    const request = this.deletionRequests.get(id);
    if (!request) throw new Error('Deletion request not found');
    if (request.status !== 'pending') throw new Error('Deletion request already reviewed');
    Object.assign(request, { status, reviewed_by: reviewedBy, reviewed_at: at, review_note: note });
  }
  async markOrganizationDeleted(orgId: string, at: string) {
    const org = this.requireOrganization(orgId);
    org.deleted_at ??= at;
  }

  async isPlatformAdmin(userId: string) { return this.platformAdmins.has(userId); }
  async grantPlatformAdmin(userId: string, grantedBy: string) {
    if (!this.platformAdmins.has(userId)) this.platformAdmins.set(userId, grantedBy);
  }
  async appendAudit(record: AuditRecord) { this.auditLog.push(structuredClone(record)); }
  async listAudit(orgId: string) { return structuredClone(this.auditLog.filter(r => r.org_id === orgId)); }

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

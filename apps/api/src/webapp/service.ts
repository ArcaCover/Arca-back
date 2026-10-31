import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { can, canManageMember, hasPaidAccess, type AdminOrgView, type AnalysisView, type ClaimResponse, type CreateOrgRequest,
  type DeletionRequestView, type InvitationView, type InviteRequest, type Layer1Result, type MeResponse, type MemberView, type OrgView,
  type Permission, type PlanView, type Role, type UpdatePlanRequest } from '@arca/contracts';
import type { AssessmentRepository } from '../assessment/repository.js';
import { verifySessionToken } from '../auth/session-token.js';
import type { ScanRecord, ScanRepository } from '../repositories/types.js';
import type { AppUser } from './auth.js';
import type { BillingEvent, BillingProvider } from './billing.js';
import { WebappConflict, type DeletionRequestRecord, type InvitationRecord, type MembershipRecord, type OrgAnalysisRecord,
  type OrganizationRecord, type PlanRecord, type WebappConflictReason, type WebappRepository } from './types.js';

const STATUS = { invalid_request: 400, unauthorized: 401, payment_required: 402, forbidden: 403, not_found: 404, conflict: 409, gone: 410 } as const;
type FailureCode = keyof typeof STATUS;

export class WebappFailure extends Error {
  constructor(readonly code: FailureCode, message: string, readonly status: (typeof STATUS)[FailureCode]) {
    super(message);
    this.name = 'WebappFailure';
  }
}
const fail = (code: FailureCode, message: string) => new WebappFailure(code, message, STATUS[code]);

const CONFLICTS: Record<WebappConflictReason, string> = {
  scan_claimed: 'This analysis already belongs to an organization',
  last_owner: 'An organization always keeps at least one owner',
  already_member: 'This user already belongs to the organization',
  already_invited: 'This email already has a pending invitation',
  deletion_pending: 'A deletion request is already pending',
};
/** The rules the repository enforces atomically come back as a 409. */
async function orConflict<T>(write: Promise<T>): Promise<T> {
  try { return await write; } catch (error) {
    if (error instanceof WebappConflict) throw fail('conflict', CONFLICTS[error.reason]);
    throw error;
  }
}

const CLAIM_TTL_MS = 24 * 60 * 60 * 1000;
const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// Claim ids and invitation tokens are bearer secrets: 256 random bits, and only their hash is stored.
const secretToken = () => randomBytes(32).toString('base64url');
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const sameEmail = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

type FinishedScan = ScanRecord & { status: 'COMPLETED' | 'PARTIAL'; result: Layer1Result };
const isFinished = (scan: ScanRecord): scan is FinishedScan => (scan.status === 'COMPLETED' || scan.status === 'PARTIAL') && scan.result !== null;

// The store may print a timestamp its own way (Postgres: '2026-10-25 12:00:00+00'); the contract wants ISO with Z.
const iso = (value: string) => new Date(value).toISOString();
const planView = (plan: PlanRecord): PlanView => ({ code: plan.code, name: plan.name, amountCents: plan.amount_cents, currency: plan.currency,
  interval: plan.interval });
const invitationView = (invitation: InvitationRecord): InvitationView => ({ id: invitation.id, email: invitation.email, role: invitation.role,
  expiresAt: iso(invitation.expires_at) });
const deletionView = (request: DeletionRequestRecord): DeletionRequestView => ({ id: request.id, orgId: request.org_id, reason: request.reason,
  status: request.status, requestedAt: iso(request.created_at), reviewedAt: request.reviewed_at && iso(request.reviewed_at),
  reviewNote: request.review_note });

export type WebappServiceDeps = {
  repository: WebappRepository; scans: ScanRepository; assessments: AssessmentRepository; billing: BillingProvider;
  sessionSecret: string; appBaseUrl: string;
  /** False for a scan that lives only in memory (an injected fault, DN-09 §5.5): it can never be claimed. */
  isDurableScan?: (scanId: string) => boolean;
  now?: () => number;
};

/**
 * Every rule of the private webapp (DN-10). The methods that receive the acting user check its permission and the payment
 * themselves; listAnalyses and listMembers receive only the organization, so their caller runs `authorize` first.
 */
export class WebappService {
  private readonly repo: WebappRepository;
  private readonly appBaseUrl: string;
  private readonly now: () => number;

  constructor(private readonly deps: WebappServiceDeps) {
    this.repo = deps.repository;
    this.appBaseUrl = deps.appBaseUrl.replace(/\/+$/, '');
    this.now = deps.now ?? Date.now;
  }

  /** In this order, so an outsider learns nothing: not a member 404, deleted 410, role 403, unpaid 402. */
  async authorize(user: AppUser, orgId: string, permission: Permission | null,
    opts: { payment: boolean }): Promise<{ org: OrganizationRecord; role: Role }> {
    const membership = await this.repo.getMembership(orgId, user.userId);
    const org = membership && await this.repo.getOrganization(orgId);
    if (!membership || !org) throw fail('not_found', 'Organization not found');
    if (org.deleted_at !== null) throw fail('gone', 'This organization was deleted');
    if (permission && !can(membership.role, permission)) throw fail('forbidden', 'Your role does not allow this');
    if (opts.payment && !hasPaidAccess(org.billing_status)) throw fail('payment_required', 'This organization has no active subscription');
    return { org, role: membership.role };
  }

  async requirePlatformAdmin(user: AppUser): Promise<void> {
    if (!(await this.repo.isPlatformAdmin(user.userId))) throw fail('forbidden', 'Only ARCA platform admins can do this');
  }

  /** Step 1 of the claim (DN-10 §4.7): the results page trades its scan session token for a one-use ticket that outlives the magic link. */
  async issueClaim(scanToken: string): Promise<ClaimResponse> {
    const session = await verifySessionToken(scanToken, this.deps.sessionSecret);
    const scan = session && await this.deps.scans.get(session.scanId);
    if (!session || !scan || scan.email !== session.email) throw fail('unauthorized', 'Invalid or missing scan session token');
    this.requireClaimable(scan);
    if (await this.repo.getAnalysisByScan(scan.scan_id)) throw fail('conflict', CONFLICTS.scan_claimed);
    const claimId = secretToken();
    const ticket = { id_hash: sha256(claimId), scan_id: scan.scan_id, email: scan.email.toLowerCase(), expires_at: this.at(CLAIM_TTL_MS),
      used_at: null };
    await this.repo.createClaimTicket(ticket);
    return { claimId, email: ticket.email, expiresAt: ticket.expires_at };
  }

  async me(user: AppUser): Promise<MeResponse> {
    await this.ensureProfile(user);
    const memberships = (await this.repo.listOrganizationsForUser(user.userId)).filter(({ org }) => org.deleted_at === null);
    return { user: { id: user.userId, email: user.email }, organizations: await Promise.all(memberships.map(({ org, role }) => this.view(org, role))),
      platformAdmin: await this.repo.isPlatformAdmin(user.userId) };
  }

  /** Step 2 of the claim: the organization, its owner and the analysis are written together, or nothing is. */
  async createOrganization(user: AppUser, req: CreateOrgRequest): Promise<OrgView> {
    const { idHash, scan, assessmentId } = await this.redeemable(user, req.claimId);
    const at = this.timestamp();
    const org: OrganizationRecord = { id: randomUUID(), name: req.name, domain: scan.canonical_domain, billing_status: 'pending_payment',
      deleted_at: null, created_by: user.userId, created_at: at };
    await this.ensureProfile(user);
    await orConflict(this.repo.createOrganization(org, { org_id: org.id, user_id: user.userId, role: 'owner', invited_by: null, created_at: at },
      { org_id: org.id, scan_id: scan.scan_id, assessment_id: assessmentId, claimed_by: user.userId, claimed_at: at }));
    // Spent only once the organization exists: a creation that fails does not burn the ticket.
    await this.repo.markClaimTicketUsed(idHash, at);
    await this.audit(user.userId, org.id, 'org.created', org.id, { name: org.name, scanId: scan.scan_id });
    return this.view(org, 'owner');
  }

  async attachAnalysis(user: AppUser, orgId: string, claimId: string): Promise<AnalysisView> {
    await this.authorize(user, orgId, 'analysis.create', { payment: true });
    const { idHash, scan, assessmentId } = await this.redeemable(user, claimId);
    const analysis: OrgAnalysisRecord = { org_id: orgId, scan_id: scan.scan_id, assessment_id: assessmentId, claimed_by: user.userId,
      claimed_at: this.timestamp() };
    await orConflict(this.repo.claimAnalysis(analysis));
    await this.repo.markClaimTicketUsed(idHash, analysis.claimed_at);
    await this.audit(user.userId, orgId, 'analysis.claimed', scan.scan_id, {});
    return this.analysisView(analysis, scan);
  }

  async orgView(user: AppUser, orgId: string): Promise<OrgView> {
    const { org, role } = await this.authorize(user, orgId, null, { payment: false });
    return this.view(org, role);
  }

  async listAnalyses(orgId: string): Promise<AnalysisView[]> {
    const views: AnalysisView[] = [];
    for (const analysis of await this.repo.listAnalyses(orgId)) {
      // Straight from the scan store, by membership: claimed results outlive the 24 h scan session (DN-10 §4.2).
      const scan = await this.deps.scans.get(analysis.scan_id);
      if (scan && isFinished(scan)) views.push(await this.analysisView(analysis, scan));
    }
    return views;
  }

  async listMembers(orgId: string): Promise<{ members: MemberView[]; invitations: InvitationView[] }> {
    const members = await Promise.all((await this.repo.listMembers(orgId)).map(member => this.memberView(member)));
    const invitations = (await this.repo.listInvitations(orgId)).filter(invitation => !this.expired(invitation.expires_at)).map(invitationView);
    return { members, invitations };
  }

  async invite(actor: AppUser, orgId: string, req: InviteRequest): Promise<InvitationView> {
    await this.authorize(actor, orgId, 'members.invite', { payment: true });
    const email = req.email.toLowerCase();
    for (const member of await this.repo.listMembers(orgId)) {
      if (sameEmail((await this.repo.getProfile(member.user_id))?.email ?? '', email)) throw fail('conflict', CONFLICTS.already_member);
    }
    // One pending invitation per email (invitations_pending_email_idx): the new link replaces the old one, expired or not.
    await this.revokePending(actor.userId, orgId, email, 'reinvited');
    const token = secretToken();
    const invitation: InvitationRecord = { id: randomUUID(), org_id: orgId, email, role: req.role, token_hash: sha256(token),
      invited_by: actor.userId, expires_at: this.at(INVITATION_TTL_MS), accepted_at: null, revoked_at: null, created_at: this.timestamp() };
    await orConflict(this.repo.createInvitation(invitation));
    await this.audit(actor.userId, orgId, 'member.invited', invitation.email, { role: invitation.role, invitationId: invitation.id });
    // The only time the token exists in clear.
    return { ...invitationView(invitation), inviteUrl: `${this.appBaseUrl}/app/invite/${token}` };
  }

  async revokeInvitation(actor: AppUser, orgId: string, invitationId: string): Promise<void> {
    await this.authorize(actor, orgId, 'members.invite', { payment: true });
    // Looked up among this organization's pending invitations only: another organization's id is not found.
    const invitation = (await this.repo.listInvitations(orgId)).find(pending => pending.id === invitationId);
    if (!invitation) throw fail('not_found', 'Invitation not found');
    await this.repo.updateInvitation(invitation.id, { revoked_at: this.timestamp() });
    await this.audit(actor.userId, orgId, 'invitation.revoked', invitation.email, { invitationId });
  }

  async acceptInvitation(user: AppUser, token: string): Promise<OrgView> {
    const invitation = await this.repo.findInvitationByHash(sha256(token));
    if (!invitation) throw fail('not_found', 'Invitation not found');
    if (invitation.accepted_at || invitation.revoked_at || this.expired(invitation.expires_at)) {
      throw fail('gone', 'This invitation is no longer valid');
    }
    if (!sameEmail(invitation.email, user.email)) throw fail('forbidden', 'This invitation was sent to another email');
    const org = await this.repo.getOrganization(invitation.org_id);
    if (!org) throw fail('not_found', 'Invitation not found');
    if (org.deleted_at !== null) throw fail('gone', 'This organization was deleted');
    const at = this.timestamp();
    const existing = await this.repo.getMembership(org.id, user.userId);
    if (existing) {
      // Someone who already belongs keeps their role; the invitation is only closed, and so are the other links of that email.
      await this.repo.updateInvitation(invitation.id, { accepted_at: at });
      await this.revokePending(user.userId, org.id, invitation.email, 'accepted');
      return this.view(org, existing.role);
    }
    await this.ensureProfile(user);
    await orConflict(this.repo.addMember({ org_id: org.id, user_id: user.userId, role: invitation.role, invited_by: invitation.invited_by,
      created_at: at }));
    await this.repo.updateInvitation(invitation.id, { accepted_at: at });
    // No other link stays live, or a member removed later could use it to come back.
    await this.revokePending(user.userId, org.id, invitation.email, 'accepted');
    await this.audit(user.userId, org.id, 'member.joined', user.userId, { role: invitation.role, invitationId: invitation.id });
    return this.view(org, invitation.role);
  }

  async setRole(actor: AppUser, orgId: string, targetUserId: string, role: Role): Promise<MemberView> {
    const { role: actorRole } = await this.authorize(actor, orgId, 'members.set_role', { payment: true });
    const target = await this.member(orgId, targetUserId);
    if (!canManageMember(actorRole, target.role, role)) throw fail('forbidden', 'Your role cannot give this role to this member');
    if (target.role !== role) {
      await orConflict(this.repo.setRole(orgId, targetUserId, role));
      await this.audit(actor.userId, orgId, 'member.role_changed', targetUserId, { from: target.role, to: role });
    }
    return this.memberView({ ...target, role });
  }

  async removeMember(actor: AppUser, orgId: string, targetUserId: string): Promise<void> {
    const { role: actorRole } = await this.authorize(actor, orgId, 'members.remove', { payment: true });
    const target = await this.member(orgId, targetUserId);
    if (!canManageMember(actorRole, target.role)) throw fail('forbidden', 'Your role cannot remove this member');
    await orConflict(this.repo.removeMember(orgId, targetUserId));
    await this.audit(actor.userId, orgId, 'member.removed', targetUserId, { role: target.role });
    // A link still pending for their email would let the removed member back in.
    const profile = await this.repo.getProfile(targetUserId);
    if (profile) await this.revokePending(actor.userId, orgId, profile.email, 'member_removed');
  }

  /** Paying is how an organization gets in, so checkout and portal ask for billing.manage but not for a payment. */
  async checkout(actor: AppUser, orgId: string, planCode: string): Promise<{ url: string }> {
    const { org } = await this.authorize(actor, orgId, 'billing.manage', { payment: false });
    // A second checkout would start a second subscription; changing plan or card is the portal's job.
    if (hasPaidAccess(org.billing_status)) throw fail('conflict', 'This organization is already paid; use billing/portal');
    const plan = await this.repo.getPlan(planCode);
    if (!plan?.active) throw fail('invalid_request', 'Unknown or inactive plan');
    const { url } = await this.deps.billing.createCheckout({ orgId, plan, successUrl: `${this.appBaseUrl}/app?paid=1`,
      cancelUrl: `${this.appBaseUrl}/app/billing` });
    return { url };
  }

  async portal(actor: AppUser, orgId: string): Promise<{ url: string }> {
    await this.authorize(actor, orgId, 'billing.manage', { payment: false });
    const { url } = await this.deps.billing.createPortal({ orgId, returnUrl: `${this.appBaseUrl}/app/billing` });
    return { url };
  }

  /** Moves the subscription and billing_status, never the deletion state (DN-10 §4.4). Each event id counts once. */
  async applyBillingEvent(event: BillingEvent): Promise<'applied' | 'duplicate' | 'unknown_org'> {
    if (!(await this.repo.getOrganization(event.orgId))) return 'unknown_org';
    if (!(await this.repo.recordBillingEvent(event.id, event.type))) return 'duplicate';
    const current = await this.repo.getSubscription(event.orgId);
    const planCode = event.planCode ?? current?.plan_code ?? null;
    // An event that names no plan, for an organization that never subscribed, only moves billing_status.
    if (planCode) {
      await this.repo.upsertSubscription({ org_id: event.orgId, plan_code: planCode, customer_id: event.customerId ?? current?.customer_id ?? null,
        subscription_id: event.subscriptionId ?? current?.subscription_id ?? null, status: event.status,
        current_period_end: event.currentPeriodEnd ?? current?.current_period_end ?? null, updated_at: this.timestamp() });
    }
    await this.repo.setBillingStatus(event.orgId, event.status);
    await this.audit(null, event.orgId, 'billing.event_applied', event.id, { type: event.type, status: event.status, planCode });
    return 'applied';
  }

  /** Only a request: nothing changes until an ARCA person reviews it, and access stays meanwhile (DN-10 §4.5). */
  async requestDeletion(actor: AppUser, orgId: string, reason: string): Promise<DeletionRequestView> {
    await this.authorize(actor, orgId, 'org.request_deletion', { payment: false });
    const request: DeletionRequestRecord = { id: randomUUID(), org_id: orgId, requested_by: actor.userId, reason, status: 'pending',
      reviewed_by: null, reviewed_at: null, review_note: null, created_at: this.timestamp() };
    await orConflict(this.repo.createDeletionRequest(request));
    await this.audit(actor.userId, orgId, 'org.deletion_requested', request.id, { reason });
    return deletionView(request);
  }

  async listPlans(): Promise<PlanView[]> {
    return (await this.repo.listPlans()).filter(plan => plan.active).map(planView);
  }

  // The platform admin (DN-10 §4.6). The two lists take no user: their caller runs requirePlatformAdmin first.
  async listOrganizations(): Promise<AdminOrgView[]> {
    return Promise.all((await this.repo.listOrganizations()).map(async org => ({ id: org.id, name: org.name, billingStatus: org.billing_status,
      deleted: org.deleted_at !== null, members: (await this.repo.listMembers(org.id)).length })));
  }

  async listDeletionRequests(): Promise<DeletionRequestView[]> {
    return (await this.repo.listDeletionRequests()).map(deletionView);
  }

  /** Approving marks the organization deleted and stops the subscription; the data stays (DN-10 §4.6). Rejecting only closes the request. */
  async reviewDeletion(admin: AppUser, id: string, decision: 'approve' | 'reject', note?: string): Promise<DeletionRequestView> {
    await this.requirePlatformAdmin(admin);
    const request = await this.repo.getDeletionRequest(id);
    if (!request) throw fail('not_found', 'Deletion request not found');
    if (request.status !== 'pending') throw fail('conflict', 'This deletion request was already reviewed');
    const status = decision === 'approve' ? 'approved' : 'rejected';
    const at = this.timestamp();
    await this.repo.reviewDeletionRequest(id, status, admin.userId, note ?? null, at);
    if (status === 'approved') {
      await this.repo.markOrganizationDeleted(request.org_id, at);
      await this.deps.billing.cancel(request.org_id);
    }
    await this.audit(admin.userId, request.org_id, `org.deletion_${status}`, id, { note: note ?? null });
    return deletionView({ ...request, status, reviewed_by: admin.userId, reviewed_at: at, review_note: note ?? null });
  }

  /** Inactive plans included; the caller runs requirePlatformAdmin first. */
  async listAllPlans(): Promise<PlanView[]> {
    return (await this.repo.listPlans()).map(planView);
  }

  /** The price lives only in the plans table, so the next checkout already charges the new one (DN-10 §4.4). */
  async updatePlan(admin: AppUser, code: string, patch: UpdatePlanRequest): Promise<PlanView> {
    await this.requirePlatformAdmin(admin);
    const before = await this.repo.getPlan(code);
    if (!before) throw fail('not_found', 'Plan not found');
    // A field left undefined is not changed.
    await this.repo.updatePlan(code, { name: patch.name, amount_cents: patch.amountCents, currency: patch.currency, interval: patch.interval,
      active: patch.active });
    const after = (await this.repo.getPlan(code))!;
    await this.audit(admin.userId, null, 'plan.updated', code, { before, after });
    return planView(after);
  }

  /** The checks a claim ticket passes before its scan joins an organization. Spending it is the caller's last step. */
  private async redeemable(user: AppUser, claimId: string) {
    const idHash = sha256(claimId);
    const ticket = await this.repo.getClaimTicket(idHash);
    if (!ticket || this.expired(ticket.expires_at)) throw fail('gone', 'This claim does not exist or has expired');
    if (ticket.used_at !== null) throw fail('conflict', 'This claim was already used');
    if (!sameEmail(ticket.email, user.email)) throw fail('forbidden', 'This claim belongs to another email');
    const scan = await this.deps.scans.get(ticket.scan_id);
    if (!scan) throw fail('gone', 'The claimed scan no longer exists');
    this.requireClaimable(scan);
    const assessment = await this.deps.assessments.getByScan(scan.scan_id);
    return { idHash, scan, assessmentId: assessment?.id ?? null };
  }

  private requireClaimable(scan: ScanRecord): asserts scan is FinishedScan {
    if (!isFinished(scan)) throw fail('conflict', 'Only a completed scan can be claimed');
    if (this.deps.isDurableScan?.(scan.scan_id) === false) throw fail('conflict', 'A scan with an injected fault cannot be claimed');
  }

  private async analysisView(analysis: OrgAnalysisRecord, scan: FinishedScan): Promise<AnalysisView> {
    const assessment = await this.deps.assessments.getByScan(scan.scan_id);
    return { scanId: scan.scan_id, domain: scan.canonical_domain, scanStatus: scan.status, claimedAt: iso(analysis.claimed_at), layer1: scan.result,
      assessment: assessment?.status === 'COMPLETED' ? assessment.result : null };
  }

  private async view(org: OrganizationRecord, role: Role): Promise<OrgView> {
    return { id: org.id, name: org.name, domain: org.domain, billingStatus: org.billing_status, role,
      deletionPending: (await this.repo.getPendingDeletionRequest(org.id)) !== null, paidAccess: hasPaidAccess(org.billing_status) };
  }

  private async member(orgId: string, userId: string): Promise<MembershipRecord> {
    const membership = await this.repo.getMembership(orgId, userId);
    if (!membership) throw fail('not_found', 'Member not found');
    return membership;
  }

  private async memberView(member: MembershipRecord): Promise<MemberView> {
    const profile = await this.repo.getProfile(member.user_id);
    if (!profile) throw new Error('Member without a profile');
    return { userId: member.user_id, email: profile.email, role: member.role, joinedAt: iso(member.created_at) };
  }

  /** Revokes every pending invitation of this email in the organization, expired ones included: listInvitations returns them all. */
  private async revokePending(actor: string, orgId: string, email: string, reason: 'reinvited' | 'accepted' | 'member_removed') {
    const at = this.timestamp();
    for (const invitation of (await this.repo.listInvitations(orgId)).filter(pending => sameEmail(pending.email, email))) {
      await this.repo.updateInvitation(invitation.id, { revoked_at: at });
      await this.audit(actor, orgId, 'invitation.revoked', invitation.email, { invitationId: invitation.id, reason });
    }
  }

  /** Members are listed with the email of their profile, so every path that adds a member writes the profile first. */
  private async ensureProfile(user: AppUser) {
    const current = await this.repo.getProfile(user.userId);
    await this.repo.upsertProfile({ user_id: user.userId, email: user.email.toLowerCase(), full_name: current?.full_name ?? null,
      last_org_id: current?.last_org_id ?? null, created_at: current?.created_at ?? this.timestamp() });
  }

  private async audit(actor: string | null, orgId: string | null, action: string, target: string, data: Record<string, unknown>) {
    await this.repo.appendAudit({ id: randomUUID(), actor_user_id: actor, org_id: orgId, action, target, data, created_at: this.timestamp() });
  }

  private timestamp() { return new Date(this.now()).toISOString(); }
  private at(offsetMs: number) { return new Date(this.now() + offsetMs).toISOString(); }
  private expired(at: string) { return Date.parse(at) <= this.now(); }
}

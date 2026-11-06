import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { can, canManageMember, hasPaidAccess, type ActionItemView, type ActionPlanResponse, type ActionStatus, type ActivityEventView,
  type ActivityPage, type AdminAuditPage, type AdminMetricsView, type AdminOrgDetailView, type AdminOrgView, type AnalysisView,
  type AssessmentResult, type AuditActorKind, type ClaimResponse, type CreateActionRequest, type CreateOrgRequest, type DeletionRequestView,
  type InvitationView, type InviteRequest, type Layer1Result, type MeResponse, type MemberView, type OrgView, type Permission, type PlanView,
  type Role, type UpdateActionRequest, type UpdatePlanRequest } from '@arca/contracts';
import type { AssessmentRepository } from '../assessment/repository.js';
import { verifySessionToken } from '../auth/session-token.js';
import type { ScanRecord, ScanRepository } from '../repositories/types.js';
import type { AppUser } from './auth.js';
import type { BillingEvent, BillingProvider } from './billing.js';
import { WebappConflict, type AuditRecord, type CustomActionRecord, type DeletionRequestRecord, type InvitationRecord,
  type MembershipRecord, type OrgAnalysisRecord, type OrganizationRecord, type PlanRecord, type WebappConflictReason,
  type WebappRepository } from './types.js';

const STATUS = { invalid_request: 400, unauthorized: 401, payment_required: 402, forbidden: 403, not_found: 404, conflict: 409, gone: 410,
  rate_limited: 429 } as const;
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

// The action plan (DN-11 §4.2).
const MAX_CUSTOM_ACTIONS = 100;
const ACTION_WRITES_PER_MINUTE = 60;
type ActionItem = AssessmentResult['actionPlan'][number];
type Tracked = { status: ActionStatus; assignee_user_id: string | null; due_date: string | null };
const UNTOUCHED: Tracked = { status: 'todo', assignee_user_id: null, due_date: null };

// Public keys, split on their first two dots: `a.<scanId>.<actionKey>`, where the action key may hold more dots (improve:D1.1),
// and `c.<uuid>`. Anything else names no action. The uuid is checked here, so a SQL store never sees a malformed one.
const SCAN_ID = /^sc_[a-zA-Z0-9]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type ParsedKey = { source: 'assessment'; scanId: string; actionKey: string } | { source: 'custom'; id: string };
function parseActionKey(key: string): ParsedKey | null {
  const [kind, head, ...rest] = key.split('.');
  if (kind === 'a' && head !== undefined && SCAN_ID.test(head) && rest.join('.') !== '') {
    return { source: 'assessment', scanId: head, actionKey: rest.join('.') };
  }
  if (kind === 'c' && head !== undefined && rest.length === 0 && UUID.test(head)) return { source: 'custom', id: head.toLowerCase() };
  return null;
}
const assessmentKey = (scanId: string, actionKey: string) => `a.${scanId}.${actionKey}`;
const customKey = (id: string) => `c.${id}`;

/** The current plan is the analysis whose assessment is completed and whose claim is the latest; the scan id breaks a tie. */
type CurrentPlan = { analysis: OrgAnalysisRecord; scan: FinishedScan; actions: ActionItem[] };
const laterClaim = (a: OrgAnalysisRecord, b: OrgAnalysisRecord) =>
  Date.parse(a.claimed_at) > Date.parse(b.claimed_at) || (Date.parse(a.claimed_at) === Date.parse(b.claimed_at) && a.scan_id > b.scan_id);
/** One action of the plan: an assessment action has a row only once something changed. */
type PlanEntry = { source: 'assessment'; scanId: string; item: ActionItem; row: (Tracked & { updated_at: string }) | null }
  | { source: 'custom'; row: CustomActionRecord };
const entryKey = (entry: PlanEntry) => entry.source === 'assessment' ? assessmentKey(entry.scanId, entry.item.id) : customKey(entry.row.id);
// What action.updated keeps of each side, in the contract's names.
const trackedData = (tracked: Tracked) => ({ status: tracked.status, assigneeUserId: tracked.assignee_user_id, dueDate: tracked.due_date });

// The activity (DN-11 §4.3). What the target of each audited action is, so the back can name it; an action not listed here
// (a billing event, a deletion request) has no label.
const TARGETS: Record<string, 'user' | 'email' | 'scan' | 'org' | 'action' | 'plan'> = {
  'member.joined': 'user', 'member.role_changed': 'user', 'member.removed': 'user',
  'member.invited': 'email', 'invitation.revoked': 'email',
  'analysis.claimed': 'scan',
  'org.created': 'org', 'org.renamed': 'org',
  'action.created': 'action', 'action.updated': 'action', 'action.deleted': 'action',
  'plan.updated': 'plan',
};
type Change = NonNullable<ActivityEventView['change']>;
const textOrNull = (value: unknown): string | null | undefined => typeof value === 'string' || value === null ? value : undefined;
function pair(from: unknown, to: unknown): Change | null {
  const [before, after] = [textOrNull(from), textOrNull(to)];
  return before === undefined || after === undefined || before === after ? null : { from: before, to: after };
}
const fields = (value: unknown): Record<string, unknown> => typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
/**
 * The raw `data` of an audit row never leaves the back. Only these fields do, as `{ from, to }`: a role, an action's status, a
 * name and a date. An action update shows its status, or its due date when the status stayed.
 */
function changeOf({ action, data }: AuditRecord): Change | null {
  switch (action) {
    case 'member.role_changed': case 'org.renamed': return pair(data.from, data.to);
    case 'member.invited': case 'member.joined': return pair(null, data.role);
    case 'member.removed': return pair(data.role, null);
    case 'org.created': return pair(null, data.name);
    case 'action.updated': {
      const [before, after] = [fields(data.before), fields(data.after)];
      return pair(before.status, after.status) ?? pair(before.dueDate, after.dueDate);
    }
    default: return null;
  }
}

export type WebappServiceDeps = {
  repository: WebappRepository; scans: ScanRepository; assessments: AssessmentRepository; billing: BillingProvider;
  sessionSecret: string; appBaseUrl: string;
  /** False for a scan that lives only in memory (an injected fault, DN-09 §5.5): it can never be claimed. */
  isDurableScan?: (scanId: string) => boolean;
  now?: () => number;
};

/**
 * Every rule of the private webapp (DN-10, DN-11). The methods that receive the acting user check its permission and the
 * payment themselves; listAnalyses and listMembers receive only the organization, so their caller runs `authorize` first.
 */
export class WebappService {
  private readonly repo: WebappRepository;
  private readonly appBaseUrl: string;
  private readonly now: () => number;
  // When each user wrote to an action plan in the last minute. Per process, like the assessment's answer limit.
  private readonly actionWrites = new Map<string, number[]>();

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

  /** Also keeps the admin's profile, so ARCA's own audit can name who acted (DN-11 §4.5). */
  async requirePlatformAdmin(user: AppUser): Promise<void> {
    if (!(await this.repo.isPlatformAdmin(user.userId))) throw fail('forbidden', 'Only ARCA platform admins can do this');
    await this.ensureProfile(user);
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

  /** Needs no payment, like reading the organization itself (DN-11 §4.4). The same name again changes and audits nothing. */
  async renameOrganization(user: AppUser, orgId: string, name: string): Promise<OrgView> {
    const { org, role } = await this.authorize(user, orgId, 'org.update', { payment: false });
    if (org.name !== name) {
      await this.repo.updateOrganizationName(orgId, name);
      await this.audit(user.userId, orgId, 'org.renamed', orgId, { from: org.name, to: name });
    }
    return this.view({ ...org, name }, role);
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
    // Their actions go back to nobody, and stay so if they come back (DN-11 D15).
    await this.repo.clearAssignee(orgId, targetUserId);
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
    await this.audit(null, event.orgId, 'billing.event_applied', event.id, { type: event.type, status: event.status, planCode }, 'system');
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

  /** The current plan and the organization's own actions (DN-11 §4.2). An action of the assessment nobody touched reads as todo. */
  async listActions(user: AppUser, orgId: string): Promise<ActionPlanResponse> {
    await this.authorize(user, orgId, 'org.read', { payment: true });
    const { plan, entries } = await this.planEntries(orgId);
    return { source: plan && { scanId: plan.scan.scan_id, domain: plan.scan.canonical_domain, claimedAt: iso(plan.analysis.claimed_at) },
      items: await Promise.all(entries.map(entry => this.actionView(entry))) };
  }

  /**
   * In a fixed order (DN-11 §4.2): the permission follows the fields sent, then the key, then the assignee. Sending the assignee or
   * the due date, even as null, takes actions.assign for the whole request: nothing is applied in part. A request that changes
   * nothing writes and audits nothing.
   */
  async updateAction(user: AppUser, orgId: string, key: string, req: UpdateActionRequest): Promise<ActionItemView> {
    const assigns = req.assigneeUserId !== undefined || req.dueDate !== undefined;
    await this.authorize(user, orgId, assigns ? 'actions.assign' : 'actions.update', { payment: true });
    const target = await this.resolveAction(orgId, key);
    if (typeof req.assigneeUserId === 'string') await this.requireAssignee(orgId, req.assigneeUserId);
    const before: Tracked = target.row ?? UNTOUCHED;
    const after: Tracked = { status: req.status ?? before.status,
      assignee_user_id: req.assigneeUserId === undefined ? before.assignee_user_id : req.assigneeUserId,
      due_date: req.dueDate === undefined ? before.due_date : req.dueDate };
    if (before.status === after.status && before.assignee_user_id === after.assignee_user_id && before.due_date === after.due_date) {
      return this.actionView(target);
    }
    this.checkActionWrites(user.userId);
    const at = this.timestamp();
    const tracked = { ...after, updated_by: user.userId, updated_at: at };
    if (target.source === 'assessment') {
      // The first change creates the row; the upsert also covers a row that another request created meanwhile.
      await this.repo.upsertAssessmentAction({ id: randomUUID(), org_id: orgId, source: 'assessment', scan_id: target.scanId,
        action_key: target.item.id, title: null, detail: null, domain: null, ...tracked, created_by: user.userId, created_at: at });
    } else {
      await this.repo.updateAction(orgId, target.row.id, tracked);
    }
    const title = target.source === 'assessment' ? target.item.title : target.row.title;
    await this.audit(user.userId, orgId, 'action.updated', entryKey(target), { title, before: trackedData(before), after: trackedData(after) });
    return this.actionView(target.source === 'assessment' ? { ...target, row: tracked } : { ...target, row: { ...target.row, ...tracked } });
  }

  async createAction(user: AppUser, orgId: string, req: CreateActionRequest): Promise<ActionItemView> {
    await this.authorize(user, orgId, 'actions.assign', { payment: true });
    if (await this.repo.countCustomActions(orgId) >= MAX_CUSTOM_ACTIONS) {
      throw fail('conflict', `An organization keeps at most ${MAX_CUSTOM_ACTIONS} actions of its own`);
    }
    this.checkActionWrites(user.userId);
    const at = this.timestamp();
    const action: CustomActionRecord = { id: randomUUID(), org_id: orgId, source: 'custom', scan_id: null, action_key: null, title: req.title,
      detail: req.detail || null, domain: req.domain ?? null, ...UNTOUCHED, created_by: user.userId, created_at: at, updated_by: user.userId,
      updated_at: at };
    await this.repo.createCustomAction(action);
    await this.audit(user.userId, orgId, 'action.created', customKey(action.id), { title: action.title });
    return this.actionView({ source: 'custom', row: action });
  }

  /** Only the organization's own actions are deleted; the assessment's only change status (DN-11 D13). */
  async deleteAction(user: AppUser, orgId: string, key: string): Promise<void> {
    await this.authorize(user, orgId, 'actions.assign', { payment: true });
    // Any assessment key gets the same answer, whatever plan it names, so the refusal says nothing about the plan.
    if (key.startsWith('a.')) throw fail('invalid_request', 'An action of the assessment cannot be deleted, only its status changed');
    const parsed = parseActionKey(key);
    const action = parsed?.source === 'custom' ? await this.repo.getCustomAction(orgId, parsed.id) : null;
    if (!action) throw fail('not_found', 'Action not found');
    this.checkActionWrites(user.userId);
    await this.repo.deleteCustomAction(orgId, action.id);
    await this.audit(user.userId, orgId, 'action.deleted', customKey(action.id), { title: action.title });
  }

  /**
   * The organization's audit log as its owner and admins see it (DN-11 §4.3), with no payment: they keep their trail even
   * unpaid. Only a member's email shows; ARCA staff and the system are named by kind alone.
   */
  async activity(user: AppUser, orgId: string, page: { before?: number; limit: number }): Promise<ActivityPage> {
    await this.authorize(user, orgId, 'activity.read', { payment: false });
    // One row past the page says whether there is a next one.
    const rows = await this.repo.listAudit(orgId, { before: page.before, limit: page.limit + 1 });
    const shown = rows.slice(0, page.limit);
    const names = this.names();
    const events = await Promise.all(shown.map(async (row): Promise<ActivityEventView> => ({ id: row.id, at: iso(row.created_at),
      actor: row.actor_kind === 'platform' ? { kind: 'arca', email: null } : row.actor_kind === 'system' ? { kind: 'system', email: null }
        : { kind: 'member', email: row.actor_user_id === null ? null : await names.email(row.actor_user_id) },
      action: row.action, targetLabel: await names.target(row), change: changeOf(row) })));
    return { events, nextBefore: rows.length > page.limit ? shown.at(-1)!.seq : null };
  }

  async listPlans(): Promise<PlanView[]> {
    return (await this.repo.listPlans()).filter(plan => plan.active).map(planView);
  }

  // The platform admin (DN-10 §4.6, DN-11 §4.5). The reads take no user: their caller runs requirePlatformAdmin first.
  async listOrganizations(): Promise<AdminOrgView[]> {
    return Promise.all((await this.repo.listOrganizations()).map(async org => ({ id: org.id, name: org.name, billingStatus: org.billing_status,
      deleted: org.deleted_at !== null, members: (await this.repo.listMembers(org.id)).length })));
  }

  async listDeletionRequests(): Promise<DeletionRequestView[]> {
    return (await this.repo.listDeletionRequests()).map(deletionView);
  }

  /** A deleted organization is found too: ARCA keeps seeing what it deleted. */
  async adminOrganization(orgId: string): Promise<AdminOrgDetailView> {
    const org = await this.repo.getOrganization(orgId);
    if (!org) throw fail('not_found', 'Organization not found');
    const pending = await this.repo.getPendingDeletionRequest(orgId);
    const members = await Promise.all((await this.repo.listMembers(orgId)).map(member => this.memberView(member)));
    return { id: org.id, name: org.name, domain: org.domain, billingStatus: org.billing_status, deleted: org.deleted_at !== null,
      createdAt: iso(org.created_at), planCode: (await this.repo.getSubscription(orgId))?.plan_code ?? null,
      analysisCount: (await this.repo.listAnalyses(orgId)).length, pendingDeletion: pending && deletionView(pending),
      members: members.map(({ email, role, joinedAt }) => ({ email, role, joinedAt })) };
  }

  /** ARCA's own audit, across organizations or of one. Unlike an organization's activity, it names ARCA staff too. */
  async adminAudit(page: { orgId?: string; before?: number; limit: number }): Promise<AdminAuditPage> {
    const rows = await this.repo.listAllAudit({ ...page, limit: page.limit + 1 });
    const shown = rows.slice(0, page.limit);
    const names = this.names();
    const events = await Promise.all(shown.map(async row => ({ id: row.id, at: iso(row.created_at), orgId: row.org_id,
      orgName: row.org_id === null ? null : await names.org(row.org_id), actorKind: row.actor_kind,
      actorEmail: row.actor_kind === 'system' || row.actor_user_id === null ? null : await names.email(row.actor_user_id),
      action: row.action, targetLabel: await names.target(row) })));
    return { events, nextBefore: rows.length > page.limit ? shown.at(-1)!.seq : null };
  }

  /**
   * Counts only, never money. Members, analyses and actions are counted in the organizations that are not deleted, and the
   * actions over each one's current plan, an untouched assessment action as todo.
   */
  async adminMetrics(): Promise<AdminMetricsView> {
    const organizations = { pending_payment: 0, active: 0, past_due: 0, canceled: 0, deleted: 0 };
    const actions = { todo: 0, in_progress: 0, done: 0 };
    let members = 0, analyses = 0;
    for (const org of await this.repo.listOrganizations()) {
      if (org.deleted_at !== null) { organizations.deleted++; continue; }
      organizations[org.billing_status]++;
      members += (await this.repo.listMembers(org.id)).length;
      analyses += (await this.repo.listAnalyses(org.id)).length;
      for (const { row } of (await this.planEntries(org.id)).entries) actions[row?.status ?? 'todo']++;
    }
    const pendingDeletionRequests = (await this.repo.listDeletionRequests()).filter(request => request.status === 'pending').length;
    return { organizations, members, analyses, pendingDeletionRequests, actions };
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
    await this.audit(admin.userId, request.org_id, `org.deletion_${status}`, id, { note: note ?? null }, 'platform');
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
    await this.audit(admin.userId, null, 'plan.updated', code, { before, after }, 'platform');
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

  /**
   * Who acted is fixed here, at write time (DN-11 §4.3): `platform` for ARCA staff acting from /admin/*, `system` for a
   * billing event or the seed, and `member` for everything a signed-in user does in an organization.
   */
  private async audit(actor: string | null, orgId: string | null, action: string, target: string, data: Record<string, unknown>,
    actorKind: AuditActorKind = 'member') {
    await this.repo.appendAudit({ id: randomUUID(), actor_kind: actorKind, actor_user_id: actor, org_id: orgId, action, target, data,
      created_at: this.timestamp() });
  }

  /** The analysis behind the current plan, or null when no analysis of the organization has a completed assessment. */
  private async currentPlan(orgId: string): Promise<CurrentPlan | null> {
    let current: CurrentPlan | null = null;
    for (const analysis of await this.repo.listAnalyses(orgId)) {
      // Read live: org_analyses.assessment_id is fixed at the claim and goes stale when the assessment is completed later.
      const assessment = await this.deps.assessments.getByScan(analysis.scan_id);
      if (assessment?.status !== 'COMPLETED' || !assessment.result) continue;
      const scan = await this.deps.scans.get(analysis.scan_id);
      if (!scan || !isFinished(scan)) continue;
      if (!current || laterClaim(analysis, current.analysis)) current = { analysis, scan, actions: assessment.result.actionPlan };
    }
    return current;
  }

  /**
   * The current plan's actions in the assessment's order, then the organization's own, oldest first. The rows of an older plan
   * stay in the store but never show (D14).
   */
  private async planEntries(orgId: string): Promise<{ plan: CurrentPlan | null; entries: PlanEntry[] }> {
    const [plan, rows] = await Promise.all([this.currentPlan(orgId), this.repo.listActions(orgId)]);
    const entries: PlanEntry[] = (plan?.actions ?? []).map(item => ({ source: 'assessment', scanId: plan!.scan.scan_id, item,
      row: rows.find(row => row.source === 'assessment' && row.scan_id === plan!.scan.scan_id && row.action_key === item.id) ?? null }));
    for (const row of rows) if (row.source === 'custom') entries.push({ source: 'custom', row });
    return { plan, entries };
  }

  /**
   * A key names an action only within this organization's current plan or its own actions (DN-11 §4.2). Anything else, a key of
   * another organization or of an older plan included, is not found.
   */
  private async resolveAction(orgId: string, key: string): Promise<PlanEntry> {
    const parsed = parseActionKey(key);
    const missing = () => fail('not_found', 'Action not found');
    if (!parsed) throw missing();
    if (parsed.source === 'custom') {
      const row = await this.repo.getCustomAction(orgId, parsed.id);
      if (!row) throw missing();
      return { source: 'custom', row };
    }
    const plan = await this.currentPlan(orgId);
    const item = plan?.scan.scan_id === parsed.scanId ? plan.actions.find(action => action.id === parsed.actionKey) : undefined;
    if (!item) throw missing();
    return { source: 'assessment', scanId: parsed.scanId, item, row: await this.repo.getAssessmentAction(orgId, parsed.scanId, item.id) };
  }

  /** Only someone who can mark an action may hold it (D11). One answer whether the user exists or not. */
  private async requireAssignee(orgId: string, userId: string) {
    const membership = await this.repo.getMembership(orgId, userId);
    if (!membership || !can(membership.role, 'actions.update')) {
      throw fail('invalid_request', 'The assignee must be a member of the organization who can update actions');
    }
  }

  private async actionView(entry: PlanEntry): Promise<ActionItemView> {
    const { row } = entry;
    const tracking = { status: row?.status ?? 'todo', dueDate: row?.due_date ?? null, updatedAt: row ? iso(row.updated_at) : null,
      assignee: row?.assignee_user_id ? { userId: row.assignee_user_id, email: await this.profileEmail(row.assignee_user_id) } : null };
    return entry.source === 'assessment'
      ? { key: entryKey(entry), source: 'assessment', title: entry.item.title, detail: entry.item.detail, domain: entry.item.domain,
        pointsGain: entry.item.pointsGain, ...tracking }
      : { key: entryKey(entry), source: 'custom', title: entry.row.title, detail: entry.row.detail, domain: entry.row.domain, pointsGain: null,
        ...tracking };
  }

  /** At most 60 writes to action plans per user and minute (DN-11 §4.2). Each write takes its slot before it runs. */
  private checkActionWrites(userId: string) {
    const now = this.now();
    for (const [key, hits] of this.actionWrites) {
      const fresh = hits.filter(time => now - time < 60_000);
      if (fresh.length) this.actionWrites.set(key, fresh); else this.actionWrites.delete(key);
    }
    const hits = this.actionWrites.get(userId) ?? [];
    if (hits.length >= ACTION_WRITES_PER_MINUTE) throw fail('rate_limited', 'Too many changes to the action plan; try again in a minute');
    this.actionWrites.set(userId, [...hits, now]);
  }

  /** An assignee is always a member, and every member has a profile. */
  private async profileEmail(userId: string): Promise<string> {
    const profile = await this.repo.getProfile(userId);
    if (!profile) throw new Error('Member without a profile');
    return profile.email;
  }

  /** Readable names for one page of the audit log, each looked up once. Whatever cannot be named is null. */
  private names() {
    const cache = new Map<string, Promise<string | null>>();
    const once = (key: string, read: () => Promise<string | null>) => {
      if (!cache.has(key)) cache.set(key, read());
      return cache.get(key)!;
    };
    const email = (userId: string) => once(`user:${userId}`, async () => (await this.repo.getProfile(userId))?.email ?? null);
    const org = (orgId: string) => once(`org:${orgId}`, async () => (await this.repo.getOrganization(orgId))?.name ?? null);
    const actionTitle = async (orgId: string | null, key: string) => {
      const parsed = parseActionKey(key);
      if (!parsed || orgId === null) return null;
      if (parsed.source === 'custom') return (await this.repo.getCustomAction(orgId, parsed.id))?.title ?? null;
      // Any plan, not only the current one: an older action keeps its title in the log.
      const assessment = await this.deps.assessments.getByScan(parsed.scanId);
      return assessment?.result?.actionPlan.find(action => action.id === parsed.actionKey)?.title ?? null;
    };
    const target = async (row: AuditRecord): Promise<string | null> => {
      const { target } = row;
      if (target === null) return null;
      switch (TARGETS[row.action]) {
        case 'user': return email(target);
        case 'email': case 'plan': return target;
        case 'scan': return once(`scan:${target}`, async () => (await this.deps.scans.get(target))?.canonical_domain ?? null);
        case 'org': return org(target);
        // A deleted action of the organization's own keeps the title it was audited with.
        case 'action': return (await once(`action:${row.org_id}:${target}`, () => actionTitle(row.org_id, target)))
          ?? (typeof row.data.title === 'string' ? row.data.title : null);
        default: return null;
      }
    };
    return { email, org, target };
  }

  private timestamp() { return new Date(this.now()).toISOString(); }
  private at(offsetMs: number) { return new Date(this.now() + offsetMs).toISOString(); }
  private expired(at: string) { return Date.parse(at) <= this.now(); }
}

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
import { IneligibleAssignee, MAX_CUSTOM_ACTIONS, WebappConflict, type ActionPatch, type AuditRecord, type CustomActionRecord,
  type DeletionRequestRecord, type InvitationRecord, type MembershipRecord, type OrgAnalysisRecord, type OrganizationRecord,
  type PlanRecord, type WebappConflictReason, type WebappRepository } from './types.js';

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
  action_limit: `An organization keeps at most ${MAX_CUSTOM_ACTIONS} actions of its own`,
};
/** The rules the repository enforces atomically come back as a 409. */
async function orConflict<T>(write: Promise<T>): Promise<T> {
  try { return await write; } catch (error) {
    if (error instanceof WebappConflict) throw fail('conflict', CONFLICTS[error.reason]);
    throw error;
  }
}
// One answer whether the user exists or not, from the service's early check and from the write's own (DN-11 D11).
const ASSIGNEE_REFUSED = 'The assignee must be a member of the organization who can update actions';
/** The write checks the assignee again, against their role at that moment: a race the early check lost is the same 400. */
async function orIneligible<T>(write: Promise<T>): Promise<T> {
  try { return await write; } catch (error) {
    if (error instanceof IneligibleAssignee) throw fail('invalid_request', ASSIGNEE_REFUSED);
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
const ACTION_WRITES_PER_MINUTE = 60;
type ActionItem = AssessmentResult['actionPlan'][number];
type Tracked = { status: ActionStatus; assignee_user_id: string | null; due_date: string | null };
const TRACKED_FIELDS = ['status', 'assignee_user_id', 'due_date'] as const satisfies ReadonlyArray<keyof Tracked>;
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
/**
 * An id the store keeps in a uuid column (an organization, a user, an invitation, a deletion request), read the way Postgres reads
 * a uuid (any case), or null when it is not one. The store is never asked about anything else: its column would refuse the value
 * with an error instead of finding nothing. What follows a lookup uses the id the store returned.
 */
const asUuid = (id: string) => UUID.test(id) ? id.toLowerCase() : null;
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
// What action.updated keeps of each side: the fields the change moved, in the contract's names.
const CONTRACT_NAMES = { status: 'status', assignee_user_id: 'assigneeUserId', due_date: 'dueDate' } as const;
const trackedData = (tracked: Tracked, fields: ReadonlyArray<keyof Tracked>) =>
  Object.fromEntries(fields.map(field => [CONTRACT_NAMES[field], tracked[field]]));

// The activity (DN-11 §4.3). The actions that only ARCA staff (from /admin/*) or the system ever perform. The views name their actor
// by this kind, whatever the row stores, so a row written as a member's never shows a staff email; the role views migration
// corrects the rows DN-10 wrote with the same list.
export const ACTOR_KIND_OF_ACTION: Readonly<Record<string, Exclude<AuditActorKind, 'member'>>> = Object.freeze({
  'org.deletion_approved': 'platform', 'org.deletion_rejected': 'platform', 'plan.updated': 'platform',
  'billing.event_applied': 'system',
});
// An action is a string from a row, so the tables below are read by own key only: one named like a property every object has
// ('constructor', '__proto__') names no entry.
const entryOf = <T>(table: Readonly<Record<string, T>>, action: string): T | undefined =>
  Object.hasOwn(table, action) ? table[action] : undefined;
const actorKindOf = (row: AuditRecord): AuditActorKind => entryOf(ACTOR_KIND_OF_ACTION, row.action) ?? row.actor_kind;
// What the target of each audited action is, so the back can name it; an action not listed here (a billing event, a deletion
// request) has no label.
const TARGETS: Readonly<Record<string, 'user' | 'email' | 'scan' | 'org' | 'action' | 'plan'>> = {
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
  /** Set only through asSystem(), for the mock demo seed. */
  auditAsSystem?: boolean;
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

  /**
   * The same rules over the same store for the mock demo seed (DN-11 §4.6), which acts for no one: what a member's request would
   * audit is audited as the system's, with no user (§4.3).
   */
  asSystem(): WebappService {
    return new WebappService({ ...this.deps, auditAsSystem: true });
  }

  /**
   * In this order, so an outsider learns nothing: not a member 404 (an id that is not a UUID included), deleted 410, role 403,
   * unpaid 402. The caller goes on with `org.id`, the id as stored, whatever case the request used.
   */
  async authorize(user: AppUser, orgId: string, permission: Permission | null,
    opts: { payment: boolean }): Promise<{ org: OrganizationRecord; role: Role }> {
    const id = asUuid(orgId);
    const membership = id && await this.repo.getMembership(id, user.userId);
    const org = id && membership && await this.repo.getOrganization(id);
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
    await this.audit(user.userId, org.id, 'org.created', org.id, { name: org.name, scanId: scan.scan_id }, 'member');
    return this.view(org, 'owner');
  }

  async attachAnalysis(user: AppUser, orgId: string, claimId: string): Promise<AnalysisView> {
    const { org } = await this.authorize(user, orgId, 'analysis.create', { payment: true });
    const { idHash, scan, assessmentId } = await this.redeemable(user, claimId);
    const analysis: OrgAnalysisRecord = { org_id: org.id, scan_id: scan.scan_id, assessment_id: assessmentId, claimed_by: user.userId,
      claimed_at: this.timestamp() };
    await orConflict(this.repo.claimAnalysis(analysis));
    await this.repo.markClaimTicketUsed(idHash, analysis.claimed_at);
    await this.audit(user.userId, org.id, 'analysis.claimed', scan.scan_id, {}, 'member');
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
      await this.repo.updateOrganizationName(org.id, name);
      await this.audit(user.userId, org.id, 'org.renamed', org.id, { from: org.name, to: name }, 'member');
    }
    return this.view({ ...org, name }, role);
  }

  /** `orgId` is the id `authorize` returned. */
  async listAnalyses(orgId: string): Promise<AnalysisView[]> {
    const views: AnalysisView[] = [];
    for (const analysis of await this.repo.listAnalyses(orgId)) {
      // Straight from the scan store, by membership: claimed results outlive the 24 h scan session (DN-10 §4.2).
      const scan = await this.deps.scans.get(analysis.scan_id);
      if (scan && isFinished(scan)) views.push(await this.analysisView(analysis, scan));
    }
    return views;
  }

  /** `orgId` is the id `authorize` returned. */
  async listMembers(orgId: string): Promise<{ members: MemberView[]; invitations: InvitationView[] }> {
    const members = await Promise.all((await this.repo.listMembers(orgId)).map(member => this.memberView(member)));
    const invitations = (await this.repo.listInvitations(orgId)).filter(invitation => !this.expired(invitation.expires_at)).map(invitationView);
    return { members, invitations };
  }

  async invite(actor: AppUser, orgId: string, req: InviteRequest): Promise<InvitationView> {
    const { org } = await this.authorize(actor, orgId, 'members.invite', { payment: true });
    const email = req.email.toLowerCase();
    for (const member of await this.repo.listMembers(org.id)) {
      if (sameEmail((await this.repo.getProfile(member.user_id))?.email ?? '', email)) throw fail('conflict', CONFLICTS.already_member);
    }
    // One pending invitation per email (invitations_pending_email_idx): the new link replaces the old one, expired or not.
    await this.revokePending(actor.userId, org.id, email, 'reinvited');
    const token = secretToken();
    const invitation: InvitationRecord = { id: randomUUID(), org_id: org.id, email, role: req.role, token_hash: sha256(token),
      invited_by: actor.userId, expires_at: this.at(INVITATION_TTL_MS), accepted_at: null, revoked_at: null, created_at: this.timestamp() };
    await orConflict(this.repo.createInvitation(invitation));
    await this.audit(actor.userId, org.id, 'member.invited', invitation.email, { role: invitation.role, invitationId: invitation.id },
      'member');
    // The only time the token exists in clear.
    return { ...invitationView(invitation), inviteUrl: `${this.appBaseUrl}/app/invite/${token}` };
  }

  async revokeInvitation(actor: AppUser, orgId: string, invitationId: string): Promise<void> {
    const { org } = await this.authorize(actor, orgId, 'members.invite', { payment: true });
    // Looked up among this organization's pending invitations only: another organization's id is not found.
    const id = asUuid(invitationId);
    const invitation = id && (await this.repo.listInvitations(org.id)).find(pending => pending.id === id);
    if (!invitation) throw fail('not_found', 'Invitation not found');
    await this.repo.updateInvitation(invitation.id, { revoked_at: this.timestamp() });
    await this.audit(actor.userId, org.id, 'invitation.revoked', invitation.email, { invitationId: invitation.id }, 'member');
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
    await this.audit(user.userId, org.id, 'member.joined', user.userId, { role: invitation.role, invitationId: invitation.id }, 'member');
    return this.view(org, invitation.role);
  }

  /**
   * Only someone who can mark an action may hold it (D11): the store's setRole releases the actions of a role that cannot, in the
   * same call as the change, as removeMember does (D15). The audit row follows the write, as for every other change.
   */
  async setRole(actor: AppUser, orgId: string, targetUserId: string, role: Role): Promise<MemberView> {
    const { org, role: actorRole } = await this.authorize(actor, orgId, 'members.set_role', { payment: true });
    const target = await this.member(org.id, targetUserId);
    if (!canManageMember(actorRole, target.role, role)) throw fail('forbidden', 'Your role cannot give this role to this member');
    if (target.role !== role) {
      // Removed by another request since it was read: nothing was written, so nothing is audited.
      if (!(await orConflict(this.repo.setRole(org.id, target.user_id, role)))) throw fail('not_found', 'Member not found');
      await this.audit(actor.userId, org.id, 'member.role_changed', target.user_id, { from: target.role, to: role }, 'member');
    }
    return this.memberView({ ...target, role });
  }

  /** Their actions go back to nobody in the same call that removes them, and stay so if they come back (DN-11 D15). */
  async removeMember(actor: AppUser, orgId: string, targetUserId: string): Promise<void> {
    const { org, role: actorRole } = await this.authorize(actor, orgId, 'members.remove', { payment: true });
    const target = await this.member(org.id, targetUserId);
    if (!canManageMember(actorRole, target.role)) throw fail('forbidden', 'Your role cannot remove this member');
    // Two removals that race both find the member; only the one that removed them audits.
    if (!(await orConflict(this.repo.removeMember(org.id, target.user_id)))) throw fail('not_found', 'Member not found');
    await this.audit(actor.userId, org.id, 'member.removed', target.user_id, { role: target.role }, 'member');
    // A link still pending for their email would let the removed member back in.
    const profile = await this.repo.getProfile(target.user_id);
    if (profile) await this.revokePending(actor.userId, org.id, profile.email, 'member_removed');
  }

  /** Paying is how an organization gets in, so checkout and portal ask for billing.manage but not for a payment. */
  async checkout(actor: AppUser, orgId: string, planCode: string): Promise<{ url: string }> {
    const { org } = await this.authorize(actor, orgId, 'billing.manage', { payment: false });
    // A second checkout would start a second subscription; changing plan or card is the portal's job.
    if (hasPaidAccess(org.billing_status)) throw fail('conflict', 'This organization is already paid; use billing/portal');
    const plan = await this.repo.getPlan(planCode);
    if (!plan?.active) throw fail('invalid_request', 'Unknown or inactive plan');
    const { url } = await this.deps.billing.createCheckout({ orgId: org.id, plan, successUrl: `${this.appBaseUrl}/app?paid=1`,
      cancelUrl: `${this.appBaseUrl}/app/billing` });
    return { url };
  }

  async portal(actor: AppUser, orgId: string): Promise<{ url: string }> {
    const { org } = await this.authorize(actor, orgId, 'billing.manage', { payment: false });
    const { url } = await this.deps.billing.createPortal({ orgId: org.id, returnUrl: `${this.appBaseUrl}/app/billing` });
    return { url };
  }

  /**
   * Moves the subscription and billing_status, never the deletion state (DN-10 §4.4). Each event id counts once. An event names
   * its organization by the id its checkout carried; one that is not a UUID names none.
   */
  async applyBillingEvent(event: BillingEvent): Promise<'applied' | 'duplicate' | 'unknown_org'> {
    const orgId = asUuid(event.orgId);
    const org = orgId && await this.repo.getOrganization(orgId);
    if (!org) return 'unknown_org';
    if (!(await this.repo.recordBillingEvent(event.id, event.type))) return 'duplicate';
    const current = await this.repo.getSubscription(org.id);
    const planCode = event.planCode ?? current?.plan_code ?? null;
    // An event that names no plan, for an organization that never subscribed, only moves billing_status.
    if (planCode) {
      await this.repo.upsertSubscription({ org_id: org.id, plan_code: planCode, customer_id: event.customerId ?? current?.customer_id ?? null,
        subscription_id: event.subscriptionId ?? current?.subscription_id ?? null, status: event.status,
        current_period_end: event.currentPeriodEnd ?? current?.current_period_end ?? null, updated_at: this.timestamp() });
    }
    await this.repo.setBillingStatus(org.id, event.status);
    await this.audit(null, org.id, 'billing.event_applied', event.id, { type: event.type, status: event.status, planCode }, 'system');
    return 'applied';
  }

  /** Only a request: nothing changes until an ARCA person reviews it, and access stays meanwhile (DN-10 §4.5). */
  async requestDeletion(actor: AppUser, orgId: string, reason: string): Promise<DeletionRequestView> {
    const { org } = await this.authorize(actor, orgId, 'org.request_deletion', { payment: false });
    const request: DeletionRequestRecord = { id: randomUUID(), org_id: org.id, requested_by: actor.userId, reason, status: 'pending',
      reviewed_by: null, reviewed_at: null, review_note: null, created_at: this.timestamp() };
    await orConflict(this.repo.createDeletionRequest(request));
    await this.audit(actor.userId, org.id, 'org.deletion_requested', request.id, { reason }, 'member');
    return deletionView(request);
  }

  /** The current plan and the organization's own actions (DN-11 §4.2). An action of the assessment nobody touched reads as todo. */
  async listActions(user: AppUser, orgId: string): Promise<ActionPlanResponse> {
    const { org } = await this.authorize(user, orgId, 'org.read', { payment: true });
    const { plan, entries } = await this.planEntries(org.id);
    return { source: plan && { scanId: plan.scan.scan_id, domain: plan.scan.canonical_domain, claimedAt: iso(plan.analysis.claimed_at) },
      items: await Promise.all(entries.map(entry => this.actionView(entry))) };
  }

  /**
   * In a fixed order (DN-11 §4.2): the permission follows the fields sent, then the key, then the assignee. Sending the assignee or
   * the due date, even as null, takes actions.assign for the whole request: nothing is applied in part. A request that changes
   * nothing writes and audits nothing, and answers with the action as it is now.
   */
  async updateAction(user: AppUser, orgId: string, key: string, req: UpdateActionRequest): Promise<ActionItemView> {
    const assigns = req.assigneeUserId !== undefined || req.dueDate !== undefined;
    const { org } = await this.authorize(user, orgId, assigns ? 'actions.assign' : 'actions.update', { payment: true });
    const target = await this.resolveAction(org.id, key);
    // An early answer that spends no write slot; the write checks the assignee again, which settles a race with a role change.
    if (typeof req.assigneeUserId === 'string') await this.requireAssignee(org.id, req.assigneeUserId);
    const before: Tracked = target.row ?? UNTOUCHED;
    // Only the fields sent that differ from what was read are written and audited. Another request may have changed the row since
    // the read: writing nothing else leaves its change in place, and the audit names no change this request did not make.
    const changes: Partial<Tracked> = {};
    if (req.status !== undefined && req.status !== before.status) changes.status = req.status;
    if (req.assigneeUserId !== undefined && req.assigneeUserId !== before.assignee_user_id) changes.assignee_user_id = req.assigneeUserId;
    if (req.dueDate !== undefined && req.dueDate !== before.due_date) changes.due_date = req.dueDate;
    const changed = TRACKED_FIELDS.filter(field => field in changes);
    // What was read may be stale by now; read again rather than answer with it.
    if (changed.length === 0) return this.actionView(await this.reread(org.id, target));
    this.checkActionWrites(user.userId);
    const at = this.timestamp();
    const patch: ActionPatch = { ...changes, updated_by: user.userId, updated_at: at };
    let row: Tracked;
    let written: PlanEntry;
    if (target.source === 'assessment') {
      // The first change creates the row. A row that exists by now, from an earlier change or from a request that raced this one,
      // only gets the patch.
      const upserted = await orIneligible(this.repo.upsertAssessmentAction({ id: randomUUID(), org_id: org.id, source: 'assessment',
        scan_id: target.scanId, action_key: target.item.id, title: null, detail: null, domain: null, ...UNTOUCHED, ...patch,
        created_by: user.userId, created_at: at }, patch));
      row = upserted;
      written = { ...target, row: upserted };
    } else {
      const updated = await orIneligible(this.repo.updateAction(org.id, target.row.id, patch));
      // Deleted by another request since it was read: nothing was written, so nothing is audited.
      if (!updated) throw fail('not_found', 'Action not found');
      if (updated.source !== 'custom') throw new Error('An action of the organization\'s own changed its source');
      row = updated;
      written = { source: 'custom', row: updated };
    }
    // Before is what this request read, after what its write left: the row as written, which may also hold another request's change.
    const title = target.source === 'assessment' ? target.item.title : target.row.title;
    await this.audit(user.userId, org.id, 'action.updated', entryKey(target), { title, before: trackedData(before, changed),
      after: trackedData(row, changed) }, 'member');
    return this.actionView(written);
  }

  async createAction(user: AppUser, orgId: string, req: CreateActionRequest): Promise<ActionItemView> {
    const { org } = await this.authorize(user, orgId, 'actions.assign', { payment: true });
    // An early answer that spends no write slot; the repository enforces the cap with the insert, which settles a race.
    if (await this.repo.countCustomActions(org.id) >= MAX_CUSTOM_ACTIONS) throw fail('conflict', CONFLICTS.action_limit);
    this.checkActionWrites(user.userId);
    const at = this.timestamp();
    const action: CustomActionRecord = { id: randomUUID(), org_id: org.id, source: 'custom', scan_id: null, action_key: null,
      title: req.title, detail: req.detail || null, domain: req.domain ?? null, ...UNTOUCHED, created_by: user.userId, created_at: at,
      updated_by: user.userId, updated_at: at };
    // Created unassigned today, but the store checks any assignee it is given; its refusal stays the 400, never a 500.
    await orIneligible(orConflict(this.repo.createCustomAction(action)));
    await this.audit(user.userId, org.id, 'action.created', customKey(action.id), { title: action.title }, 'member');
    return this.actionView({ source: 'custom', row: action });
  }

  /** Only the organization's own actions are deleted; the assessment's only change status (DN-11 D13). */
  async deleteAction(user: AppUser, orgId: string, key: string): Promise<void> {
    const { org } = await this.authorize(user, orgId, 'actions.assign', { payment: true });
    // Any assessment key gets the same answer, whatever plan it names, so the refusal says nothing about the plan.
    if (key.startsWith('a.')) throw fail('invalid_request', 'An action of the assessment cannot be deleted, only its status changed');
    const parsed = parseActionKey(key);
    const action = parsed?.source === 'custom' ? await this.repo.getCustomAction(org.id, parsed.id) : null;
    if (!action) throw fail('not_found', 'Action not found');
    this.checkActionWrites(user.userId);
    // Two deletions that race both find the action; only the one that deleted it audits.
    if (!(await this.repo.deleteCustomAction(org.id, action.id))) throw fail('not_found', 'Action not found');
    await this.audit(user.userId, org.id, 'action.deleted', customKey(action.id), { title: action.title }, 'member');
  }

  /**
   * The organization's audit log as its owner and admins see it (DN-11 §4.3), with no payment: they keep their trail even
   * unpaid. Only a member's email shows; ARCA staff and the system are named by kind alone.
   */
  async activity(user: AppUser, orgId: string, page: { before?: number; limit: number }): Promise<ActivityPage> {
    const { org } = await this.authorize(user, orgId, 'activity.read', { payment: false });
    // One row past the page says whether there is a next one.
    const rows = await this.repo.listAudit(org.id, { before: page.before, limit: page.limit + 1 });
    const shown = rows.slice(0, page.limit);
    const names = this.names();
    const actor = async (row: AuditRecord): Promise<ActivityEventView['actor']> => {
      const kind = actorKindOf(row);
      if (kind !== 'member') return { kind: kind === 'platform' ? 'arca' : 'system', email: null };
      return { kind: 'member', email: row.actor_user_id === null ? null : await names.email(row.actor_user_id) };
    };
    const events = await Promise.all(shown.map(async (row): Promise<ActivityEventView> => ({ id: row.id, at: iso(row.created_at),
      actor: await actor(row), action: row.action, targetLabel: await names.target(row), change: changeOf(row) })));
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
  async adminOrganization(id: string): Promise<AdminOrgDetailView> {
    const orgId = asUuid(id);
    const org = orgId && await this.repo.getOrganization(orgId);
    if (!orgId || !org) throw fail('not_found', 'Organization not found');
    const pending = await this.repo.getPendingDeletionRequest(orgId);
    const members = await Promise.all((await this.repo.listMembers(orgId)).map(member => this.memberView(member)));
    return { id: org.id, name: org.name, domain: org.domain, billingStatus: org.billing_status, deleted: org.deleted_at !== null,
      createdAt: iso(org.created_at), planCode: (await this.repo.getSubscription(orgId))?.plan_code ?? null,
      analysisCount: (await this.repo.listAnalyses(orgId)).length, pendingDeletion: pending && deletionView(pending),
      members: members.map(({ email, role, joinedAt }) => ({ email, role, joinedAt })) };
  }

  /** ARCA's own audit, across organizations or of one. Unlike an organization's activity, it names ARCA staff too. */
  async adminAudit(page: { orgId?: string; before?: number; limit: number }): Promise<AdminAuditPage> {
    // An orgId that names no organization gives an empty page (DN-11 §4.5), one that is not even a UUID included.
    const orgId = page.orgId === undefined ? undefined : asUuid(page.orgId);
    if (orgId === null) return { events: [], nextBefore: null };
    const rows = await this.repo.listAllAudit({ orgId, before: page.before, limit: page.limit + 1 });
    const shown = rows.slice(0, page.limit);
    const names = this.names();
    const events = await Promise.all(shown.map(async row => {
      const actorKind = actorKindOf(row);
      return { id: row.id, at: iso(row.created_at), orgId: row.org_id, orgName: row.org_id === null ? null : await names.org(row.org_id),
        actorKind, actorEmail: actorKind === 'system' || row.actor_user_id === null ? null : await names.email(row.actor_user_id),
        action: row.action, targetLabel: await names.target(row) };
    }));
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
    // Anyone but ARCA staff gets the 403 first, whatever id they send.
    await this.requirePlatformAdmin(admin);
    const requestId = asUuid(id);
    const request = requestId && await this.repo.getDeletionRequest(requestId);
    if (!request) throw fail('not_found', 'Deletion request not found');
    if (request.status !== 'pending') throw fail('conflict', 'This deletion request was already reviewed');
    const status = decision === 'approve' ? 'approved' : 'rejected';
    const at = this.timestamp();
    await this.repo.reviewDeletionRequest(request.id, status, admin.userId, note ?? null, at);
    if (status === 'approved') {
      await this.repo.markOrganizationDeleted(request.org_id, at);
      await this.deps.billing.cancel(request.org_id);
    }
    await this.audit(admin.userId, request.org_id, `org.deletion_${status}`, request.id, { note: note ?? null }, 'platform');
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

  /** The caller goes on with `user_id`, the id as stored. */
  private async member(orgId: string, userId: string): Promise<MembershipRecord> {
    const id = asUuid(userId);
    const membership = id && await this.repo.getMembership(orgId, id);
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
      await this.audit(actor, orgId, 'invitation.revoked', invitation.email, { invitationId: invitation.id, reason }, 'member');
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
   * billing event or the seed, and `member` for everything a signed-in user does in an organization. Every call names the kind,
   * with no default, so a new staff action cannot pass as a member's by leaving it out.
   */
  private async audit(actor: string | null, orgId: string | null, action: string, target: string, data: Record<string, unknown>,
    actorKind: AuditActorKind) {
    const system = this.deps.auditAsSystem === true && actorKind === 'member';
    await this.repo.appendAudit({ id: randomUUID(), actor_kind: system ? 'system' : actorKind, actor_user_id: system ? null : actor,
      org_id: orgId, action, target, data, created_at: this.timestamp() });
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
    if (!membership || !can(membership.role, 'actions.update')) throw fail('invalid_request', ASSIGNEE_REFUSED);
  }

  /** The action as the store holds it now. An action of the organization's own deleted meanwhile is not found. */
  private async reread(orgId: string, entry: PlanEntry): Promise<PlanEntry> {
    if (entry.source === 'assessment') return { ...entry, row: await this.repo.getAssessmentAction(orgId, entry.scanId, entry.item.id) };
    const row = await this.repo.getCustomAction(orgId, entry.row.id);
    if (!row) throw fail('not_found', 'Action not found');
    return { source: 'custom', row };
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
      switch (entryOf(TARGETS, row.action)) {
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

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { can, canManageMember, hasPaidAccess, type ActionItemView, type ActionPlanResponse, type ActionStatus, type ActivityEventView,
  type ActivityPage, type AdminAuditPage, type AdminMetricsView, type AdminOrgDetailView, type AdminOrgView, type AnalysisView,
  type AssessmentResult, type AuditActorKind, type BillingView, type ClaimResponse, type CreateActionRequest, type CreateOrgWithProfileRequest,
  type DeletionRequestView, type EmbeddedCheckoutResponse, type EnrollRequest, type EnrollResponse, type OrgProfileInput,
  type InvitationView, type InviteRequest, type Layer1Result, type MeResponse, type MemberView, type OrgView, type Permission, type PlanView,
  type Role, type UpdateActionRequest, type UpdatePlanRequest } from '@arca/contracts';
import { underwriting } from '@arca/questions';
import type { AssessmentRepository } from '../assessment/repository.js';
import { verifySessionToken } from '../auth/session-token.js';
import type { ScanRecord, ScanRepository } from '../repositories/types.js';
import type { AppUser } from './auth.js';
import { AuthAdminUnavailable, type AuthAdmin } from './auth-admin.js';
import { BillingUnavailable, type BillingEvent, type BillingProvider, type CustomerDetails } from './billing.js';
import { BillingEvents, type ReconcileReport, type WebhookOutcome } from './billing-events.js';
import { catalogIdsOf, catalogModeOf, catalogPatchOf } from './plans.js';
import { IneligibleAssignee, MAX_CUSTOM_ACTIONS, MemberChangeRefused, WebappConflict, type ActionPatch, type AuditActor, type AuditRecord,
  type BillingApplyOutcome, type CheckoutSessionRecord, type CheckoutUiMode, type CustomActionRecord,
  type DeletionRequestRecord, type InvitationRecord, type MembershipRecord, type OrgAnalysisRecord, type OrganizationRecord, type OrgProfileRecord,
  type PlanRecord, type WebappConflictReason, type WebappRepository } from './types.js';

const STATUS = { invalid_request: 400, unauthorized: 401, payment_required: 402, forbidden: 403, not_found: 404, conflict: 409, gone: 410,
  rate_limited: 429, billing_unavailable: 502, auth_unavailable: 503 } as const;
type FailureCode = keyof typeof STATUS;

export class WebappFailure extends Error {
  /** `retryAfter`, in seconds, goes out as the Retry-After header of a 429. */
  constructor(readonly code: FailureCode, message: string, readonly status: (typeof STATUS)[FailureCode], readonly retryAfter?: number) {
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
  already_reviewed: 'This deletion request was already reviewed',
  invitation_closed: 'This invitation is no longer valid',
  sole_owner: 'You are the only owner of an organization: make someone else an owner or request its deletion first',
};
// One answer for every claim or invitation POST /auth/enroll cannot use (DN-13 §4.2): unknown, expired, spent, revoked, accepted, or
// of a deleted organization. The request names no email, so none is revealed either way.
const ENROLL_REFUSED = 'This link is no longer valid; start again from your results or ask for a new invitation';
const ALREADY_PAID = 'This organization is already paid; use billing/portal';
/** Stripe did not answer: nothing was written (DN-13 §7.3). */
async function orUnavailable<T>(work: Promise<T>): Promise<T> {
  try { return await work; } catch (error) {
    if (error instanceof BillingUnavailable) throw fail('billing_unavailable', 'Payments are unavailable right now; try again in a minute');
    throw error;
  }
}
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

/** The pre-checkout's profile as its row (DN-13 §19): written once, with the organization, by the person who creates it. */
const profileRecord = (orgId: string, userId: string, profile: OrgProfileInput, at: string): OrgProfileRecord => ({ org_id: orgId,
  contact_name: profile.contactName, contact_role: profile.contactRole, contact_phone: profile.phone ?? null, legal_name: profile.legalName,
  ein: profile.ein ?? null, address_line1: profile.billingAddress.line1, address_city: profile.billingAddress.city,
  address_state: profile.billingAddress.state, address_postal_code: profile.billingAddress.postalCode, address_country: 'US',
  attorney_range: profile.attorneyRange, practice_states: [...profile.practiceStates], created_by: userId, created_at: at, updated_at: at });
/**
 * Who the organization's Stripe customer is: the firm's legal name, phone, address and EIN when it gave its profile, so Checkout asks
 * none of it again (DN-13 §19); otherwise its name, as before. The email is always the payer's, the one Checkout shows.
 */
const customerDetails = (org: OrganizationRecord, payer: AppUser, profile: OrgProfileRecord | null): CustomerDetails => profile
  ? { orgId: org.id, name: profile.legal_name, email: payer.email, phone: profile.contact_phone, ein: profile.ein,
    address: { line1: profile.address_line1, city: profile.address_city, state: profile.address_state, postalCode: profile.address_postal_code } }
  : { orgId: org.id, name: org.name, email: payer.email };
/** A Checkout session the organization may be sent to: Stripe's page (hosted) or the client secret ARCA's page mounts (embedded). */
type OpenCheckout = { sessionId: string; url: string | null; clientSecret: string | null };

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
  'billing.event_applied': 'system', 'billing.duplicate_subscription': 'system', 'billing.invoice_paid': 'system',
  'billing.payment_failed': 'system', 'billing.payment_action_required': 'system', 'billing.refunded': 'system', 'billing.dispute': 'system',
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
  'org.created': 'org', 'org.renamed': 'org', 'account.deleted': 'user',
  'action.created': 'action', 'action.updated': 'action', 'action.deleted': 'action',
  'plan.updated': 'plan',
  'platform_admin.granted': 'user', 'platform_admin.revoked': 'user',
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
    case 'member.removed': case 'account.deleted': return pair(data.role, null);
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
  /**
   * Creates and deletes Supabase Auth users (DN-13 §4.2, §4.8): the admin API in the real webapp, the in-memory one in the debug
   * modes. Only POST /auth/enroll and DELETE /me need it; compose always passes one.
   */
  authAdmin?: AuthAdmin;
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
  // Stripe's events, the return from Checkout and the reconciliation, one organization at a time (DN-13 §6.5).
  private readonly billingEvents: BillingEvents;

  constructor(private readonly deps: WebappServiceDeps) {
    this.repo = deps.repository;
    this.appBaseUrl = deps.appBaseUrl.replace(/\/+$/, '');
    this.now = deps.now ?? Date.now;
    this.billingEvents = new BillingEvents({ repository: deps.repository, billing: deps.billing, now: this.now });
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

  /**
   * Closed sign-up (DN-13 §4.2): the Supabase Auth user of a claim's email, or of a pending invitation's, is created here and
   * nowhere else. The claim gets the checks of `redeemable` without being spent, and without a user to compare emails with: the
   * code that reaches that mailbox is what proves the person owns it. Already enrolled is the same answer. Nothing is written
   * before the Auth admin API answers, so its failure (503) leaves nothing half made.
   */
  async enroll(req: EnrollRequest): Promise<EnrollResponse> {
    const email = 'claimId' in req ? await this.enrollableClaim(req.claimId) : await this.enrollableInvitation(req.invitationToken);
    if (!email) throw fail('gone', ENROLL_REFUSED);
    try {
      await this.requireAuthAdmin().createUser(email);
    } catch (error) {
      if (error instanceof AuthAdminUnavailable) throw fail('auth_unavailable', 'Accounts cannot be created right now; try again in a minute');
      throw error;
    }
    return { email };
  }

  /**
   * A closed account is refused on every route (DN-13 §4.4): its access token stays valid until it expires, up to an hour, and
   * its Auth user may outlive the deletion if the admin API failed.
   */
  async requireLiveAccount(user: AppUser): Promise<void> {
    if ((await this.repo.getProfile(user.userId))?.deleted_at) throw fail('unauthorized', 'This account was deleted');
  }

  /**
   * DELETE /me (DN-13 §4.8). The store closes the account in one step, refusing a sole owner (409); then the Auth user goes,
   * which drops its sessions and refresh tokens. That second step is tried twice; if it still fails the account is closed already
   * (every route answers 401 to it) and the answer is 503, so the front asks again with the same token: both steps are idempotent.
   */
  async deleteAccount(user: AppUser): Promise<void> {
    const admin = this.requireAuthAdmin();
    // A user who never reached a route that writes the profile gets one now, so the tombstone exists and their token is refused
    // from here on.
    if (!(await this.repo.getProfile(user.userId))) await this.ensureProfile(user);
    await orConflict(this.repo.deleteAccount(user.userId, this.timestamp()));
    for (let attempt = 1; ; attempt++) {
      try {
        await admin.deleteUser(user.userId);
        return;
      } catch (error) {
        if (!(error instanceof AuthAdminUnavailable)) throw error;
        if (attempt === 2) {
          console.error(`[auth] account ${user.userId} was closed but its Auth user was not deleted; DELETE /me again retries`);
          throw fail('auth_unavailable', 'Your account was closed, but signing it out everywhere failed; try again');
        }
      }
    }
  }

  /**
   * Step 2 of the claim: the organization, its owner, the analysis and, from the pre-checkout, the firm profile (DN-13 §19) are written
   * together, or nothing is. The profile stays out of the audit row, which every owner and admin reads.
   */
  async createOrganization(user: AppUser, req: CreateOrgWithProfileRequest): Promise<OrgView> {
    const { idHash, scan, assessmentId } = await this.redeemable(user, req.claimId);
    const at = this.timestamp();
    const org: OrganizationRecord = { id: randomUUID(), name: req.name, domain: scan.canonical_domain, billing_status: 'pending_payment',
      deleted_at: null, created_by: user.userId, created_at: at };
    await this.ensureProfile(user);
    await orConflict(this.repo.createOrganization(org, { org_id: org.id, user_id: user.userId, role: 'owner', invited_by: null, created_at: at },
      { org_id: org.id, scan_id: scan.scan_id, assessment_id: assessmentId, claimed_by: user.userId, claimed_at: at },
      req.profile ? profileRecord(org.id, user.userId, req.profile, at) : null));
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
    const members = await this.memberViews(await this.repo.listMembers(orgId));
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
    // The second of two revokes that race finds it revoked already, and writes and audits nothing.
    if (!(await this.repo.revokeInvitation(org.id, invitation.id, this.timestamp(), this.actor(actor.userId, 'member'), null))) {
      throw fail('not_found', 'Invitation not found');
    }
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
    // Members are listed with the email of their profile, so the profile comes first.
    await this.ensureProfile(user);
    // One step in the store (DN-13 §5.4): the membership, unless they already belong (then they keep their role), the acceptance,
    // the other links of that email revoked, since a member removed later could use one to come back, and the audit. An accept
    // that raced another, or a revoke, finds it closed: the same 410 as above.
    try {
      const { role } = await this.repo.acceptInvitation(invitation.id, user.userId, this.timestamp(), this.actor(user.userId, 'member'));
      return this.view(org, role);
    } catch (error) {
      if (error instanceof WebappConflict && error.reason === 'invitation_closed') throw fail('gone', CONFLICTS.invitation_closed);
      throw error;
    }
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
      // The store checks the actor's right again against the roles as it locks them, and audits the role it found (DN-13 §4.6).
      // Removed by another request since it was read: nothing was written, so nothing is audited.
      const before = await this.memberChange(this.repo.setRole(org.id, target.user_id, role, this.change(actor, actorRole)),
        'Your role cannot give this role to this member');
      if (before === null) throw fail('not_found', 'Member not found');
    }
    return this.memberView({ ...target, role });
  }

  /** Their actions go back to nobody in the same call that removes them, and stay so if they come back (DN-11 D15). */
  async removeMember(actor: AppUser, orgId: string, targetUserId: string): Promise<void> {
    const { org, role: actorRole } = await this.authorize(actor, orgId, 'members.remove', { payment: true });
    const target = await this.member(org.id, targetUserId);
    if (!canManageMember(actorRole, target.role)) throw fail('forbidden', 'Your role cannot remove this member');
    // Two removals that race both find the member; only the one that removed them writes anything. The same step audits it and
    // revokes the links still pending for their email, which would let them back in.
    const before = await this.memberChange(this.repo.removeMember(org.id, target.user_id, this.change(actor, actorRole)),
      'Your role cannot remove this member');
    if (before === null) throw fail('not_found', 'Member not found');
  }

  /**
   * Paying is how an organization gets in, so checkout and portal ask for billing.manage but not for a payment. One open Checkout
   * Session per organization (DN-13 §6.2): while Stripe holds it open for the same plan, every click, of any owner, gets its URL; for
   * another plan it is expired first; one Stripe says was paid is applied (the return's path) instead of opening a second. The
   * organization's billing work runs one at a time, so two clicks never open two sessions. 502 when Stripe does not answer.
   */
  async checkout(actor: AppUser, orgId: string, planCode: string): Promise<{ url: string }> {
    const { url } = await this.openCheckout(actor, orgId, planCode, 'hosted');
    if (!url) throw new Error('A hosted checkout without a URL');
    return { url };
  }

  /**
   * Checkout embedded in ARCA's page (DN-13 §19), under the same rules as the hosted one: one open session per organization, whatever
   * its kind, so asking for the other kind expires the open one first. The client secret is never stored: an open session's is read
   * again from Stripe.
   */
  async embeddedCheckout(actor: AppUser, orgId: string, planCode: string): Promise<EmbeddedCheckoutResponse> {
    const { sessionId, clientSecret } = await this.openCheckout(actor, orgId, planCode, 'embedded');
    if (!clientSecret) throw new Error('An embedded checkout without a client secret');
    return { clientSecret, sessionId };
  }

  private async openCheckout(actor: AppUser, orgId: string, planCode: string, uiMode: CheckoutUiMode): Promise<OpenCheckout> {
    const { org } = await this.authorize(actor, orgId, 'billing.manage', { payment: false });
    return this.billingEvents.forOrg(org.id, async () => {
      // Read again in the organization's turn: a webhook or a return may have paid it meanwhile. A second checkout would start a
      // second subscription; changing plan or card is the portal's job.
      const current = (await this.repo.getOrganization(org.id)) ?? org;
      if (hasPaidAccess(current.billing_status)) throw fail('conflict', ALREADY_PAID);
      const plan = await this.repo.getPlan(planCode);
      if (!plan?.active) throw fail('invalid_request', 'Unknown or inactive plan');
      // The price of the key's mode (DN-13 §21): a live key does not sell a plan that only has a test price.
      if (this.deps.billing.needsCatalogPrice && !catalogIdsOf(plan, catalogModeOf(this.deps.billing.mode)).priceId) {
        throw fail('conflict', 'This plan cannot be bought yet: it has no Stripe price (npm run stripe:catalog)');
      }
      const at = this.timestamp();
      const open = await this.repo.getOpenCheckoutSession(org.id, at);
      if (open) {
        const reused = await this.reuseCheckout(org.id, open, plan.code, uiMode);
        if (reused) return reused;
      }
      const { customerId, prefilled } = await this.billingCustomer(current, actor);
      // What came before this session keeps its idempotency key apart from a session closed in the same minute (DN-13 §6.2).
      const after = open?.id ?? (await this.repo.getSubscription(org.id))?.subscription_id ?? null;
      const created: OpenCheckout & { expiresAt: string } = uiMode === 'embedded'
        ? { url: null, ...await orUnavailable(this.deps.billing.createEmbeddedCheckout({ orgId: org.id, customerId, plan, after, prefilled,
          returnUrl: `${this.appBaseUrl}/app/billing/return?session_id={CHECKOUT_SESSION_ID}` })) }
        : { clientSecret: null, ...await orUnavailable(this.deps.billing.createCheckout({ orgId: org.id, customerId, plan, after, prefilled,
          successUrl: `${this.appBaseUrl}/app/billing/return?session_id={CHECKOUT_SESSION_ID}`, cancelUrl: `${this.appBaseUrl}/app/billing` })) };
      const stored = await this.repo.addCheckoutSession({ id: created.sessionId, org_id: org.id, plan_code: plan.code, url: created.url,
        status: 'open', created_by: actor.userId, expires_at: created.expiresAt, created_at: at, ui_mode: uiMode }, at);
      if (stored.id !== created.sessionId) {
        // Another process stored its session first: that one is the organization's, and this one must not be paid.
        await this.deps.billing.expireCheckout(created.sessionId).catch(() => undefined);
        const clientSecret = stored.ui_mode === 'embedded' ? (await orUnavailable(this.deps.billing.checkoutState(stored.id)))?.clientSecret ?? null : null;
        // Of the other kind, the caller cannot use it: one more click, after it, decides (reuseCheckout).
        if (stored.ui_mode !== uiMode || (uiMode === 'hosted' ? !stored.url : !clientSecret)) {
          throw fail('conflict', 'Another checkout of this organization was just opened; try again');
        }
        return { sessionId: stored.id, url: stored.url, clientSecret };
      }
      await this.audit(actor.userId, org.id, 'billing.checkout_started', created.sessionId, { planCode: plan.code }, 'member');
      return { sessionId: created.sessionId, url: created.url, clientSecret: created.clientSecret };
    });
  }

  /**
   * The open session again while Stripe still holds it open for this plan and this kind of Checkout (an embedded one with the client
   * secret Stripe gives back). Otherwise it is closed here as Stripe says and null comes back, so a new one opens; or, when it was
   * paid, its subscription is applied and an organization that now pays gets the 409.
   */
  private async reuseCheckout(orgId: string, open: CheckoutSessionRecord, planCode: string, uiMode: CheckoutUiMode): Promise<OpenCheckout | null> {
    let checkout = await orUnavailable(this.deps.billing.checkoutState(open.id));
    if (checkout?.status === 'open') {
      const same = open.plan_code === planCode && open.ui_mode === uiMode;
      if (same && uiMode === 'hosted' && open.url) return { sessionId: open.id, url: open.url, clientSecret: null };
      if (same && uiMode === 'embedded' && checkout.clientSecret) return { sessionId: open.id, url: null, clientSecret: checkout.clientSecret };
      // Another plan or another kind: the open one is closed first, so the organization never holds two that could both be paid.
      if (await orUnavailable(this.deps.billing.expireCheckout(open.id)) === 'expired') {
        await this.repo.closeCheckoutSession(open.id, 'expired');
        return null;
      }
      checkout = await orUnavailable(this.deps.billing.checkoutState(open.id));
    }
    if (!checkout || checkout.status !== 'complete') {
      await this.repo.closeCheckoutSession(open.id, 'expired');
      return null;
    }
    const subscription = await orUnavailable(this.billingEvents.applyCheckout(orgId, checkout));
    const now = await this.repo.getOrganization(orgId);
    if (now && hasPaidAccess(now.billing_status)) throw fail('conflict', ALREADY_PAID);
    // Paid but still being confirmed (3-D Secure): a second checkout now could become a second subscription.
    if (subscription?.status === 'incomplete') throw fail('conflict', 'A payment of this organization is still being confirmed; try again in a few minutes');
    return null;
  }

  /**
   * The organization's Stripe customer: the one stored, brought up to the firm profile when there is one (DN-13 §19), or a new one
   * made from it; without a profile, a new one named after the organization, with the payer's email, as before.
   */
  private async billingCustomer(org: OrganizationRecord, payer: AppUser): Promise<{ customerId: string; prefilled: boolean }> {
    const profile = await this.repo.getOrgProfile(org.id);
    const details = customerDetails(org, payer, profile);
    // With the profile the customer holds the billing address, so Checkout need not ask for it.
    const prefilled = profile !== null;
    const stored = await this.repo.getBillingCustomer(org.id);
    if (stored) {
      if (profile) await orUnavailable(this.deps.billing.updateCustomer(stored.customer_id, details));
      return { customerId: stored.customer_id, prefilled };
    }
    const { customerId } = await orUnavailable(this.deps.billing.ensureCustomer(details));
    return { customerId: (await this.repo.addBillingCustomer({ org_id: org.id, customer_id: customerId, livemode: this.deps.billing.mode === 'live',
      created_at: this.timestamp() })).customer_id, prefilled };
  }

  /** 409 until the organization is a Stripe customer, which its first checkout makes it (DN-13 §6.4). */
  async portal(actor: AppUser, orgId: string): Promise<{ url: string }> {
    const { org } = await this.authorize(actor, orgId, 'billing.manage', { payment: false });
    const customer = await this.repo.getBillingCustomer(org.id);
    if (!customer) throw fail('conflict', 'This organization has no billing customer yet: start with a checkout');
    const { url } = await orUnavailable(this.deps.billing.createPortal({ customerId: customer.customer_id, returnUrl: `${this.appBaseUrl}/app/billing` }));
    return { url };
  }

  /**
   * The return from Checkout (DN-13 §6.3): the session is read at Stripe and, when it belongs to this organization, its subscription
   * is applied by the webhook's path, before the webhook arrives. Answers the organization as it is now. A session of another
   * organization, or one Stripe does not know, is not found.
   */
  async syncCheckout(actor: AppUser, orgId: string, sessionId: string): Promise<OrgView> {
    const { org, role } = await this.authorize(actor, orgId, 'billing.manage', { payment: false });
    const checkout = await orUnavailable(this.deps.billing.checkoutState(sessionId));
    if (!checkout || checkout.orgId?.toLowerCase() !== org.id) throw fail('not_found', 'Checkout session not found');
    await orUnavailable(this.billingEvents.syncCheckout(org.id, checkout));
    return this.view((await this.repo.getOrganization(org.id)) ?? org, role);
  }

  /** What every member sees of the subscription (DN-13 §7.2, DN-11 D10), with no payment needed. */
  async billingView(user: AppUser, orgId: string): Promise<BillingView> {
    const { org, role } = await this.authorize(user, orgId, null, { payment: false });
    const subscription = await this.repo.getSubscription(org.id);
    const plan = subscription && await this.repo.getPlan(subscription.plan_code);
    return { billingStatus: org.billing_status, plan: plan ? planView(plan) : null,
      currentPeriodEnd: subscription?.current_period_end ? iso(subscription.current_period_end) : null,
      cancelAtPeriodEnd: subscription?.cancel_at_period_end ?? false, manageable: can(role, 'billing.manage') };
  }

  /** Whether POST /billing/webhook is served: only a provider that signs its webhooks (Stripe), never the simulated one. */
  get acceptsBillingWebhooks(): boolean { return this.deps.billing.webhooks; }
  /** POST /billing/webhook (DN-13 §6.5): throws WebhookRejected for a 400; any other error is a 500 so Stripe retries. */
  billingWebhook(raw: string | Uint8Array, signature: string | undefined): Promise<WebhookOutcome> {
    return this.billingEvents.webhook(raw, signature);
  }
  /** The daily reconciliation (DN-13 §9.5). The process that runs it schedules it. */
  reconcileBilling(options: { windowMs?: number } = {}): Promise<ReconcileReport> { return this.billingEvents.reconcile(options); }

  /**
   * Moves the subscription and billing_status, never the deletion state (DN-10 §4.4). Each event id counts once. An event names
   * its organization by the id its checkout carried; one that is not a UUID names none.
   */
  async applyBillingEvent(event: BillingEvent): Promise<BillingApplyOutcome | 'unknown_org'> {
    const orgId = asUuid(event.orgId);
    const org = orgId && await this.repo.getOrganization(orgId);
    if (!org) return 'unknown_org';
    // The simulated checkout that was paid closes, so the next checkout opens a new one.
    if (event.checkoutSessionId) await this.repo.closeCheckoutSession(event.checkoutSessionId, 'complete');
    // Recorded and applied in one step (DN-13 §6.5): a crash in between can no longer leave an event seen but never applied. An
    // event that names no plan, for an organization that never subscribed, only moves billing_status.
    return this.repo.applyBillingState({ id: event.id, type: event.type }, org.id, { status: event.status, plan_code: event.planCode,
      customer_id: event.customerId, subscription_id: event.subscriptionId, current_period_end: event.currentPeriodEnd }, this.timestamp());
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
    const members = await this.memberViews(await this.repo.listMembers(orgId));
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
    // The review, the deletion mark and the audit are one step; the second of two reviews that race is the same 409 (DN-13 §5.4).
    await orConflict(this.repo.reviewDeletionRequest(request.id, status, admin.userId, note ?? null, at, this.actor(admin.userId, 'platform')));
    if (status === 'approved') await this.cancelSubscription(request.org_id);
    return deletionView({ ...request, status, reviewed_by: admin.userId, reviewed_at: at, review_note: note ?? null });
  }

  /**
   * An approved deletion stops the charges (DN-13 §6.9): the live subscription is canceled at once at the provider; the webhook that
   * follows moves billing_status. The review is already written, so a provider failure does not undo it: it is logged for a person to
   * cancel from the dashboard.
   */
  private async cancelSubscription(orgId: string) {
    const subscription = await this.repo.getSubscription(orgId);
    if (!subscription?.subscription_id || subscription.status === 'canceled') return;
    try {
      await this.deps.billing.cancel({ orgId, subscriptionId: subscription.subscription_id });
    } catch (error) {
      console.error(`[billing] failed to cancel subscription ${subscription.subscription_id} of deleted organization ${orgId} `
        + `(${error instanceof Error ? error.name : 'unknown error'}); cancel it in the Stripe dashboard`);
    }
  }

  /** Inactive plans included; the caller runs requirePlatformAdmin first. */
  async listAllPlans(): Promise<PlanView[]> {
    return (await this.repo.listPlans()).map(planView);
  }

  /**
   * The price lives in the plans table and in a catalog price (DN-13 §6.1): a new amount, currency or interval first creates the new
   * price at the provider (502, with the table untouched, when it does not answer), then points the plan at it, so the next checkout
   * charges it. Subscribers keep the price they pay (F2).
   */
  async updatePlan(admin: AppUser, code: string, patch: UpdatePlanRequest): Promise<PlanView> {
    await this.requirePlatformAdmin(admin);
    const before = await this.repo.getPlan(code);
    if (!before) throw fail('not_found', 'Plan not found');
    const price = { amountCents: patch.amountCents ?? before.amount_cents, currency: patch.currency ?? before.currency,
      interval: patch.interval ?? before.interval };
    const repriced = price.amountCents !== before.amount_cents || price.currency !== before.currency || price.interval !== before.interval;
    const catalog = repriced ? await orUnavailable(this.deps.billing.createPrice({ plan: before, ...price })) : null;
    // A field left undefined is not changed. The new price is written in the slot of the key's mode; the other mode's stays (DN-13 §21).
    await this.repo.updatePlan(code, { name: patch.name, amount_cents: patch.amountCents, currency: patch.currency, interval: patch.interval,
      active: patch.active, ...catalogPatchOf(catalogModeOf(this.deps.billing.mode), { priceId: catalog?.priceId, productId: catalog?.productId }) });
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

  /** The email of a claim that `redeemable` would take, read and not spent; null for any claim it would refuse. */
  private async enrollableClaim(claimId: string): Promise<string | null> {
    const ticket = await this.repo.getClaimTicket(sha256(claimId));
    if (!ticket || this.expired(ticket.expires_at) || ticket.used_at !== null) return null;
    const scan = await this.deps.scans.get(ticket.scan_id);
    if (!scan || !isFinished(scan) || this.deps.isDurableScan?.(scan.scan_id) === false) return null;
    return ticket.email.toLowerCase();
  }

  /** The email of an invitation that acceptInvitation would take; null for any invitation it would refuse. */
  private async enrollableInvitation(token: string): Promise<string | null> {
    const invitation = await this.repo.findInvitationByHash(sha256(token));
    if (!invitation || invitation.accepted_at || invitation.revoked_at || this.expired(invitation.expires_at)) return null;
    const org = await this.repo.getOrganization(invitation.org_id);
    return org && org.deleted_at === null ? invitation.email.toLowerCase() : null;
  }

  private requireAuthAdmin(): AuthAdmin {
    if (!this.deps.authAdmin) throw new Error('The webapp has no Auth admin');
    return this.deps.authAdmin;
  }

  private requireClaimable(scan: ScanRecord): asserts scan is FinishedScan {
    if (!isFinished(scan)) throw fail('conflict', 'Only a completed scan can be claimed');
    if (this.deps.isDurableScan?.(scan.scan_id) === false) throw fail('conflict', 'A scan with an injected fault cannot be claimed');
  }

  private async analysisView(analysis: OrgAnalysisRecord, scan: FinishedScan): Promise<AnalysisView> {
    const assessment = await this.deps.assessments.getByScan(scan.scan_id);
    return { scanId: scan.scan_id, domain: scan.canonical_domain, scanStatus: scan.status, claimedAt: iso(analysis.claimed_at), layer1: scan.result,
      // The firm's own members, never Arca's underwriters: bank 4.0's audit and summary stay out (DN-14).
      assessment: assessment?.status === 'COMPLETED' && assessment.result ? ('outcome' in assessment.result ? underwriting.publicResult(assessment.result) : assessment.result) : null };
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
    if (!profile?.email) throw new Error('Member without a profile');
    return { userId: member.user_id, email: profile.email, role: member.role, joinedAt: iso(member.created_at) };
  }
  /**
   * A closed account leaves no member in a live organization, but a deleted one keeps its memberships (DN-13 §4.8): those show
   * nobody, since the person, and their email, are gone.
   */
  private async memberViews(members: MembershipRecord[]): Promise<MemberView[]> {
    const live = await Promise.all(members.map(async member => (await this.repo.getProfile(member.user_id))?.deleted_at ? null : member));
    return Promise.all(live.filter(member => member !== null).map(member => this.memberView(member)));
  }

  /**
   * Revokes every pending invitation of this email in the organization, expired ones included: listInvitations returns them all.
   * Accepting and removing a member revoke theirs in their own step.
   */
  private async revokePending(actor: string, orgId: string, email: string, reason: 'reinvited') {
    const at = this.timestamp();
    for (const invitation of (await this.repo.listInvitations(orgId)).filter(pending => sameEmail(pending.email, email))) {
      await this.repo.revokeInvitation(orgId, invitation.id, at, this.actor(actor, 'member'), reason);
    }
  }

  /** What the service checked before a member change, for the store to check again under its lock. */
  private change(actor: AppUser, actorRole: Role) {
    return { actorUserId: actor.userId, actorRole, audit: this.actor(actor.userId, 'member'), at: this.timestamp() };
  }
  /** A member change refused by the store, because a role moved meanwhile, is the 403 the service's own check gives. */
  private async memberChange(write: Promise<Role | null>, refusal: string): Promise<Role | null> {
    try { return await orConflict(write); } catch (error) {
      if (error instanceof MemberChangeRefused) throw fail('forbidden', refusal);
      throw error;
    }
  }

  /** Members are listed with the email of their profile, so every path that adds a member writes the profile first. */
  private async ensureProfile(user: AppUser) {
    const current = await this.repo.getProfile(user.userId);
    // Never deleted_at: a closed account's profile refuses this write (DN-13 §4.8).
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
    await this.repo.appendAudit({ id: randomUUID(), ...this.actor(actor, actorKind), org_id: orgId, action, target, data,
      created_at: this.timestamp() });
  }

  /** Who an audit row names, the rows a store writes itself included: the mock seed's member actions are the system's. */
  private actor(actor: string | null, actorKind: AuditActorKind): AuditActor {
    const system = this.deps.auditAsSystem === true && actorKind === 'member';
    return { actor_kind: system ? 'system' : actorKind, actor_user_id: system ? null : actor };
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
    if (!profile?.email) throw new Error('Member without a profile');
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

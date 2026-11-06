import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ActionItemView, ActionPlanResponse, ActivityPage, AdminAuditPage, AdminMetricsView, AdminOrgDetailView, AnalysisView,
  AssessmentResult, ClaimResponse, DeletionRequestView, InvitationView, MeResponse, MemberView, OrgView, PlanView, type Role,
  type UpdateActionRequest } from '@arca/contracts';
import { DEMO_BANK } from '@arca/questions';
import { InMemoryAssessmentRepository, type AssessmentRecord } from '../../src/assessment/repository.js';
import { issueSessionToken } from '../../src/auth/session-token.js';
import { InMemoryRepository } from '../../src/repositories/in-memory.js';
import type { ScanRecord } from '../../src/repositories/types.js';
import { MockAppAuth, type AppUser } from '../../src/webapp/auth.js';
import { MockBillingProvider, type BillingEvent } from '../../src/webapp/billing.js';
import { InMemoryWebappRepository } from '../../src/webapp/in-memory.js';
import { DEFAULT_PLANS } from '../../src/webapp/plans.js';
import { WebappFailure, WebappService } from '../../src/webapp/service.js';
import { IneligibleAssignee } from '../../src/webapp/types.js';
import { fixtureResult } from '../fixtures/result.js';

const secret = 'webapp-service-test-secret-'.repeat(2);
const APP = 'http://localhost:3000';
const T0 = Date.parse('2026-10-25T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const OWNER = 'owner@firm.com';
const iso = (ms: number) => new Date(ms).toISOString();
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

type ActionItem = AssessmentResult['actionPlan'][number];
/** The plan a completed assessment of these tests recommends, unless a test names another. */
const PLAN: ActionItem[] = [
  { id: 'improve:D1.1', domain: 'governance', title: 'Adopt a written AI use policy', detail: 'Illustrative next step: a written policy.',
    pointsGain: 4 },
  { id: 'improve:D3.2', domain: 'oversight', title: 'Review AI output before it reaches a client',
    detail: 'Illustrative next step: a documented review.', pointsGain: 2.5 },
];
function assessmentResult(scanId: string, actionPlan: ActionItem[] = PLAN) {
  const domain = (key: string) => ({ key, label: key, weight: 1, score: 70, status: 'KNOWN' });
  return AssessmentResult.parse({ assessmentId: `as_${scanId}`, scanId, bankVersion: DEMO_BANK.bankVersion, bankStatus: 'DEMO',
    scoringVersion: 'v1', commercialDecisionBlocked: true, layer1Score: 82, layer2Score: 70, compositeScore: 75, tier: 'GUARDED',
    decision: 'REFERRAL', domains: ['governance', 'tools', 'oversight', 'data_protection', 'training', 'incident_preparedness'].map(domain),
    flags: [], actionPlan, completedAt: iso(T0) });
}
function assessmentRecord(scanId: string, status: 'COMPLETED' | 'IN_PROGRESS', actionPlan?: ActionItem[]): AssessmentRecord {
  return { id: `as_${scanId}`, scan_id: scanId, revision: 0, status, bank_version: DEMO_BANK.bankVersion, bank_snapshot: DEMO_BANK,
    layer1_snapshot: fixtureResult(scanId, OWNER), evidence_snapshot: [], planner: 'rules', planner_model: null, prompt_version: null,
    plan: null, rendered: [], answers: {}, result: status === 'COMPLETED' ? assessmentResult(scanId, actionPlan) : null,
    attested_at: status === 'COMPLETED' ? iso(T0) : null, created_at: iso(T0), updated_at: iso(T0), expires_at: iso(T0 + DAY),
    completed_at: status === 'COMPLETED' ? iso(T0) : null, answer_write_count: 0 };
}

async function expectFailure(promise: Promise<unknown>, code: WebappFailure['code'], status: WebappFailure['status']) {
  const error = await promise.then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(WebappFailure);
  expect(error).toMatchObject({ code, status });
}

type ScanOptions = { email?: string; status?: ScanRecord['status']; assessment?: 'COMPLETED' | 'IN_PROGRESS'; actions?: ActionItem[];
  injected?: boolean };

type HeldRead = 'getMembership' | 'getCustomAction' | 'getAssessmentAction';
/**
 * A store that can hold the answer of one read: the value is read when the call is made and handed back only once the test
 * releases it, so another request lands in between, as it would between two statements against a database.
 */
class HoldingRepository extends InMemoryWebappRepository {
  private hold: { method: HeldRead; matches: (args: string[]) => boolean; reached: () => void; gate: Promise<void> } | null = null;

  /** Holds the next read of `method` whose arguments match; `reached` settles once that read has been made. */
  holdNext(method: HeldRead, matches: (args: string[]) => boolean) {
    let reached!: () => void;
    let release!: () => void;
    const hit = new Promise<void>(resolve => { reached = resolve; });
    this.hold = { method, matches, reached, gate: new Promise<void>(resolve => { release = resolve; }) };
    return { reached: hit, release };
  }

  override async getMembership(orgId: string, userId: string) {
    return this.held('getMembership', [orgId, userId], await super.getMembership(orgId, userId));
  }
  override async getCustomAction(orgId: string, id: string) {
    return this.held('getCustomAction', [orgId, id], await super.getCustomAction(orgId, id));
  }
  override async getAssessmentAction(orgId: string, scanId: string, actionKey: string) {
    return this.held('getAssessmentAction', [orgId, scanId, actionKey], await super.getAssessmentAction(orgId, scanId, actionKey));
  }

  private async held<T>(method: HeldRead, args: string[], value: T): Promise<T> {
    const hold = this.hold;
    if (hold?.method === method && hold.matches(args)) {
      this.hold = null;
      hold.reached();
      await hold.gate;
    }
    return value;
  }
}

async function scene<R extends InMemoryWebappRepository = InMemoryWebappRepository>(
  repository: R = new InMemoryWebappRepository(DEFAULT_PLANS) as R) {
  let clock = T0;
  const scans = new InMemoryRepository();
  const assessments = new InMemoryAssessmentRepository();
  const billing = new MockBillingProvider(APP, () => clock);
  const auth = new MockAppAuth(secret, () => clock);
  const injected = new Set<string>();
  const service = new WebappService({ repository, scans, assessments, billing, sessionSecret: secret, appBaseUrl: APP,
    isDurableScan: scanId => !injected.has(scanId), now: () => clock });

  /** A scan of the anonymous funnel, and the scan session token its results page holds. */
  async function addScan(scanId: string, options: ScanOptions = {}) {
    const email = options.email ?? OWNER;
    const status = options.status ?? 'COMPLETED';
    const finished = status === 'COMPLETED' || status === 'PARTIAL';
    await scans.create({ id: `id_${scanId}`, scan_id: scanId, email, canonical_domain: 'firm.com',
      domain_resolution: { status: 'RESOLVED', canonicalDomain: 'firm.com', source: 'request', reason: null }, status,
      result: finished ? fixtureResult(scanId, email) : null, created_at: iso(clock), completed_at: finished ? iso(clock) : null,
      duration_ms: 10, cached: false });
    if (options.assessment) await assessments.create(assessmentRecord(scanId, options.assessment, options.actions));
    if (options.injected) injected.add(scanId);
    return issueSessionToken(scanId, email, secret);
  }
  async function claim(scanId: string, options: ScanOptions = {}) {
    return (await service.issueClaim(await addScan(scanId, options))).claimId;
  }
  const user = async (email: string): Promise<AppUser> => (await auth.issue(email)).user;
  async function ownedOrg(scanId = 'sc_1', options: ScanOptions = { assessment: 'COMPLETED' }) {
    const owner = await user(options.email ?? OWNER);
    const org = await service.createOrganization(owner, { name: 'Smith & Co', claimId: await claim(scanId, options) });
    return { owner, org };
  }
  async function pay(owner: AppUser, orgId: string, planCode = 'monthly') {
    const { url } = await service.checkout(owner, orgId, planCode);
    const event = billing.pay(new URL(url).searchParams.get('session')!);
    expect(event).not.toBeNull();
    return { event: event!, outcome: await service.applyBillingEvent(event!) };
  }
  /** Someone who joins through an invitation, accepted with their own login. */
  async function join(owner: AppUser, orgId: string, role: Exclude<Role, 'owner'>) {
    const invitation = await service.invite(owner, orgId, { email: `${role}@firm.com`, role });
    const joined = await user(`${role}@firm.com`);
    await service.acceptInvitation(joined, inviteToken(invitation));
    return joined;
  }
  /** A paid organization with one member per role. */
  async function team() {
    const { owner, org } = await ownedOrg();
    await pay(owner, org.id);
    return { owner, org, admin: await join(owner, org.id, 'admin'), member: await join(owner, org.id, 'member'),
      viewer: await join(owner, org.id, 'viewer') };
  }
  async function platformAdmin() {
    const admin = await user('ops@arca.example');
    await repository.grantPlatformAdmin(admin.userId, 'test');
    return admin;
  }
  return { service, repository, scans, assessments, billing, auth, addScan, claim, user, ownedOrg, pay, join, team, platformAdmin,
    advance: (ms: number) => { clock += ms; }, now: () => clock };
}
const inviteToken = (invitation: InvitationView) => invitation.inviteUrl!.split('/app/invite/')[1]!;
const roleOf = async (s: { repository: InMemoryWebappRepository }, orgId: string, userId: string) =>
  (await s.repository.getMembership(orgId, userId))?.role ?? null;
const ASSIGNEE_REFUSED = 'The assignee must be a member of the organization who can update actions';

describe('claiming the funnel analysis', () => {
  it('the funnel claim creates an organization owned by the claimant', async () => {
    const s = await scene();
    const claim = ClaimResponse.parse(await s.service.issueClaim(await s.addScan('sc_1', { assessment: 'COMPLETED' })));
    expect(claim).toEqual({ claimId: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), email: OWNER, expiresAt: iso(T0 + DAY) });
    // Only the hash of the claim id is stored.
    expect(await s.repository.getClaimTicket(claim.claimId)).toBeNull();
    expect(await s.repository.getClaimTicket(sha256(claim.claimId))).toMatchObject({ scan_id: 'sc_1', email: OWNER, used_at: null });

    // The email matches without regard to case.
    const owner: AppUser = { userId: (await s.user(OWNER)).userId, email: 'Owner@FIRM.com' };
    const org = OrgView.parse(await s.service.createOrganization(owner, { name: 'Smith & Co', claimId: claim.claimId }));
    expect(org).toEqual({ id: expect.any(String), name: 'Smith & Co', domain: 'firm.com', billingStatus: 'pending_payment', role: 'owner',
      deletionPending: false, paidAccess: false });
    expect(await s.repository.listAnalyses(org.id)).toEqual([{ org_id: org.id, scan_id: 'sc_1', assessment_id: 'as_sc_1',
      claimed_by: owner.userId, claimed_at: iso(T0) }]);
    expect(await s.repository.getClaimTicket(sha256(claim.claimId))).toMatchObject({ used_at: iso(T0) });
    expect(await s.repository.getProfile(owner.userId)).toMatchObject({ email: 'owner@firm.com' });

    const me = MeResponse.parse(await s.service.me(owner));
    expect(me).toEqual({ user: { id: owner.userId, email: 'Owner@FIRM.com' }, organizations: [org], platformAdmin: false });
    expect(await s.service.orgView(owner, org.id)).toEqual(org);

    // Claimed results are read through the membership, long after the 24 h scan session is over.
    s.advance(30 * DAY);
    const analyses = (await s.service.listAnalyses(org.id)).map(view => AnalysisView.parse(view));
    expect(analyses).toEqual([{ scanId: 'sc_1', domain: 'firm.com', scanStatus: 'COMPLETED', claimedAt: iso(T0),
      layer1: (await s.scans.get('sc_1'))!.result, assessment: assessmentResult('sc_1') }]);
  });

  it('a claim ticket works once', async () => {
    const s = await scene();
    const owner = await s.user(OWNER);
    const claimId = await s.claim('sc_1');
    const org = await s.service.createOrganization(owner, { name: 'Smith & Co', claimId });
    // Refused for the spent ticket itself, before the scan's own uniqueness is even reached.
    await expectFailure(s.service.createOrganization(owner, { name: 'Again', claimId }), 'conflict', 409);
    await expect(s.service.createOrganization(owner, { name: 'Again', claimId })).rejects.toThrow('already used');
    await s.pay(owner, org.id);
    await expect(s.service.attachAnalysis(owner, org.id, claimId)).rejects.toThrow('already used');
    expect((await s.service.me(owner)).organizations.map(o => o.id)).toEqual([org.id]);

    await expectFailure(s.service.createOrganization(owner, { name: 'Unknown', claimId: 'x'.repeat(43) }), 'gone', 410);
    const late = await s.claim('sc_2');
    s.advance(DAY);
    await expectFailure(s.service.createOrganization(owner, { name: 'Late', claimId: late }), 'gone', 410);
    expect(await s.repository.listOrganizations()).toHaveLength(1);
  });

  it('a claim for another email is refused and creates nothing', async () => {
    const s = await scene();
    const claimId = await s.claim('sc_1');
    const intruder = await s.user('intruder@other.com');
    await expectFailure(s.service.createOrganization(intruder, { name: 'Stolen', claimId }), 'forbidden', 403);
    expect((await s.service.me(intruder)).organizations).toEqual([]);
    expect(await s.repository.listOrganizations()).toEqual([]);

    // The refusal did not spend the ticket: its own email can still use it.
    const org = await s.service.createOrganization(await s.user(OWNER), { name: 'Smith & Co', claimId });
    expect(org.role).toBe('owner');
  });

  it('a failed or injected scan cannot be claimed', async () => {
    const s = await scene();
    await expectFailure(s.service.issueClaim(await s.addScan('sc_failed', { status: 'FAILED' })), 'conflict', 409);
    await expectFailure(s.service.issueClaim(await s.addScan('sc_running', { status: 'RUNNING' })), 'conflict', 409);
    await expectFailure(s.service.issueClaim(await s.addScan('sc_injected', { injected: true })), 'conflict', 409);
    expect(ClaimResponse.parse(await s.service.issueClaim(await s.addScan('sc_partial', { status: 'PARTIAL' }))).email).toBe(OWNER);

    // Only a valid scan session token of that very scan opens a claim.
    await s.addScan('sc_1');
    await expectFailure(s.service.issueClaim('not-a-token'), 'unauthorized', 401);
    await expectFailure(s.service.issueClaim(await issueSessionToken('sc_1', 'other@firm.com', secret)), 'unauthorized', 401);
    await expectFailure(s.service.issueClaim(await issueSessionToken('sc_missing', OWNER, secret)), 'unauthorized', 401);
    await expectFailure(s.service.issueClaim(await issueSessionToken('sc_1', OWNER, 'another-secret-'.repeat(3))), 'unauthorized', 401);
    await expectFailure(s.service.issueClaim((await s.auth.issue(OWNER)).token), 'unauthorized', 401);
  });

  it('a scan claimed twice through two tickets is refused', async () => {
    const s = await scene();
    const owner = await s.user(OWNER);
    const token = await s.addScan('sc_1');
    const first = (await s.service.issueClaim(token)).claimId;
    const second = (await s.service.issueClaim(token)).claimId;
    const org = await s.service.createOrganization(owner, { name: 'Smith & Co', claimId: first });
    await expectFailure(s.service.createOrganization(owner, { name: 'Twin', claimId: second }), 'conflict', 409);
    expect(await s.repository.listOrganizations()).toHaveLength(1);
    // A refused creation leaves the ticket unspent.
    expect(await s.repository.getClaimTicket(sha256(second))).toMatchObject({ used_at: null });

    await s.pay(owner, org.id);
    await expectFailure(s.service.attachAnalysis(owner, org.id, second), 'conflict', 409);
    await expectFailure(s.service.issueClaim(token), 'conflict', 409);
    expect(await s.repository.listAnalyses(org.id)).toHaveLength(1);
  });

  it('a paid organization adds a later analysis with a new ticket', async () => {
    const s = await scene();
    const { owner, org, viewer } = await s.team();
    const later = await s.claim('sc_2', { assessment: 'IN_PROGRESS' });
    await expectFailure(s.service.attachAnalysis(viewer, org.id, later), 'forbidden', 403);
    const foreign = await s.claim('sc_3', { email: 'someone@else.com' });
    await expectFailure(s.service.attachAnalysis(owner, org.id, foreign), 'forbidden', 403);

    const view = AnalysisView.parse(await s.service.attachAnalysis(owner, org.id, later));
    // The assessment counts only once it is completed.
    expect(view).toMatchObject({ scanId: 'sc_2', domain: 'firm.com', scanStatus: 'COMPLETED', assessment: null });
    expect((await s.service.listAnalyses(org.id)).map(a => [a.scanId, a.assessment === null])).toEqual([['sc_1', false], ['sc_2', true]]);
    await expectFailure(s.service.attachAnalysis(owner, org.id, later), 'conflict', 409);
  });
});

describe('access', () => {
  it('access checks run in order', async () => {
    const s = await scene();
    const { owner, org } = await s.ownedOrg();
    const stranger = await s.user('stranger@other.com');
    await expectFailure(s.service.authorize(stranger, org.id, 'org.read', { payment: false }), 'not_found', 404);
    // An id that is not a UUID gets the same answer as one that names no organization.
    for (const orgId of [randomUUID(), 'org_missing']) {
      await expectFailure(s.service.authorize(owner, orgId, 'org.read', { payment: false }), 'not_found', 404);
    }
    // Before paying the owner reaches the organization itself but no paid route.
    await expectFailure(s.service.authorize(owner, org.id, 'org.read', { payment: true }), 'payment_required', 402);
    expect(await s.service.authorize(owner, org.id, 'billing.manage', { payment: false })).toMatchObject({ role: 'owner', org: { id: org.id } });
    expect(await s.service.authorize(owner, org.id, null, { payment: false })).toMatchObject({ role: 'owner' });

    await s.pay(owner, org.id);
    const viewer = await s.join(owner, org.id, 'viewer');
    expect(await s.service.authorize(viewer, org.id, 'org.read', { payment: true })).toMatchObject({ role: 'viewer' });
    await expectFailure(s.service.authorize(viewer, org.id, 'members.invite', { payment: false }), 'forbidden', 403);

    // The permission is checked before the payment.
    await s.service.applyBillingEvent({ id: 'evt_cancel', type: 'subscription.canceled', orgId: org.id, status: 'canceled', planCode: null,
      customerId: null, subscriptionId: null, currentPeriodEnd: null });
    await expectFailure(s.service.authorize(viewer, org.id, 'members.invite', { payment: true }), 'forbidden', 403);
    await expectFailure(s.service.authorize(viewer, org.id, 'org.read', { payment: true }), 'payment_required', 402);

    // A deleted organization is gone for its members, before any permission, and still unknown to everyone else.
    const request = await s.service.requestDeletion(owner, org.id, 'Closing the firm');
    await s.service.reviewDeletion(await s.platformAdmin(), request.id, 'approve');
    await expectFailure(s.service.authorize(owner, org.id, 'org.read', { payment: false }), 'gone', 410);
    await expectFailure(s.service.authorize(viewer, org.id, 'members.invite', { payment: true }), 'gone', 410);
    await expectFailure(s.service.authorize(stranger, org.id, 'org.read', { payment: false }), 'not_found', 404);
    await expectFailure(s.service.orgView(owner, org.id), 'gone', 410);
    await expectFailure(s.service.checkout(owner, org.id, 'monthly'), 'gone', 410);
    expect((await s.service.me(owner)).organizations).toEqual([]);
  });

  it('only a platform admin passes the platform check', async () => {
    const s = await scene();
    await expectFailure(s.service.requirePlatformAdmin(await s.user(OWNER)), 'forbidden', 403);
    const admin = await s.platformAdmin();
    await expect(s.service.requirePlatformAdmin(admin)).resolves.toBeUndefined();
    expect((await s.service.me(admin)).platformAdmin).toBe(true);
  });
});

describe('members', () => {
  it('admins cannot touch owners, and the last owner stays', async () => {
    const s = await scene();
    const { owner, org, admin, member, viewer } = await s.team();

    await expectFailure(s.service.setRole(admin, org.id, owner.userId, 'member'), 'forbidden', 403);
    await expectFailure(s.service.removeMember(admin, org.id, owner.userId), 'forbidden', 403);
    await expectFailure(s.service.setRole(admin, org.id, member.userId, 'owner'), 'forbidden', 403);
    await expectFailure(s.service.setRole(member, org.id, viewer.userId, 'member'), 'forbidden', 403);
    await expectFailure(s.service.removeMember(viewer, org.id, member.userId), 'forbidden', 403);
    for (const userId of [randomUUID(), 'user_missing']) {
      await expectFailure(s.service.setRole(admin, org.id, userId, 'member'), 'not_found', 404);
      await expectFailure(s.service.removeMember(admin, org.id, userId), 'not_found', 404);
    }
    expect(MemberView.parse(await s.service.setRole(admin, org.id, viewer.userId, 'member')))
      .toEqual({ userId: viewer.userId, email: 'viewer@firm.com', role: 'member', joinedAt: iso(T0) });
    await s.service.removeMember(admin, org.id, viewer.userId);
    expect(await roleOf(s, org.id, viewer.userId)).toBeNull();

    await expectFailure(s.service.setRole(owner, org.id, owner.userId, 'admin'), 'conflict', 409);
    await expectFailure(s.service.removeMember(owner, org.id, owner.userId), 'conflict', 409);
    // A second owner lets the first one step down; then the second one is the last.
    await s.service.setRole(owner, org.id, admin.userId, 'owner');
    await s.service.setRole(owner, org.id, owner.userId, 'admin');
    await expectFailure(s.service.removeMember(admin, org.id, admin.userId), 'conflict', 409);
    await expectFailure(s.service.setRole(owner, org.id, admin.userId, 'member'), 'forbidden', 403);

    const { members } = await s.service.listMembers(org.id);
    expect(members.map(m => MemberView.parse(m)).map(m => [m.email, m.role]).sort())
      .toEqual([['admin@firm.com', 'owner'], ['member@firm.com', 'member'], [OWNER, 'admin']]);
  });

  it('a role change or a removal of a member another request removed meanwhile is a 404, and audits nothing', async () => {
    const s = await scene(new HoldingRepository(DEFAULT_PLANS));
    const { owner, org, admin, member, viewer } = await s.team();
    const appendAudit = vi.spyOn(s.repository, 'appendAudit');
    const cases = [
      { target: member, request: () => s.service.setRole(owner, org.id, member.userId, 'viewer') },
      { target: viewer, request: () => s.service.removeMember(owner, org.id, viewer.userId) },
    ];
    for (const { target, request } of cases) {
      appendAudit.mockClear();
      // The late request finds the member, and its answer is held until another request has removed them.
      const hold = s.repository.holdNext('getMembership', ([, userId]) => userId === target.userId);
      const late = request().then(() => null, (caught: unknown) => caught);
      await hold.reached;
      await s.service.removeMember(admin, org.id, target.userId);
      hold.release();
      const error = await late;
      expect(error, target.email).toBeInstanceOf(WebappFailure);
      expect(error, target.email).toMatchObject({ code: 'not_found', status: 404, message: 'Member not found' });
      expect(await roleOf(s, org.id, target.userId), target.email).toBeNull();
      expect(appendAudit.mock.calls.map(([record]) => [record.action, record.actor_user_id, record.target]), target.email)
        .toEqual([['member.removed', admin.userId, target.userId]]);
    }
  });

  it('an invitation is accepted once, by its own email', async () => {
    const s = await scene();
    const { owner, org } = await s.ownedOrg();
    await expectFailure(s.service.invite(owner, org.id, { email: 'guest@firm.com', role: 'member' }), 'payment_required', 402);
    await s.pay(owner, org.id);

    const invitation = InvitationView.parse(await s.service.invite(owner, org.id, { email: 'guest@firm.com', role: 'member' }));
    const token = inviteToken(invitation);
    expect(invitation).toEqual({ id: expect.any(String), email: 'guest@firm.com', role: 'member', expiresAt: iso(T0 + 7 * DAY),
      inviteUrl: `${APP}/app/invite/${token}` });
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await s.repository.findInvitationByHash(token)).toBeNull();
    expect((await s.service.listMembers(org.id)).invitations).toEqual([{ id: invitation.id, email: 'guest@firm.com', role: 'member',
      expiresAt: iso(T0 + 7 * DAY) }]);

    await expectFailure(s.service.acceptInvitation(await s.user('other@firm.com'), token), 'forbidden', 403);
    await expectFailure(s.service.acceptInvitation(await s.user('guest@firm.com'), 'unknown-token'), 'not_found', 404);
    const guest = await s.user('guest@firm.com');
    const view = OrgView.parse(await s.service.acceptInvitation(guest, token));
    expect(view).toMatchObject({ id: org.id, role: 'member', billingStatus: 'active', paidAccess: true });
    await expectFailure(s.service.acceptInvitation(guest, token), 'gone', 410);
    const listed = await s.service.listMembers(org.id);
    expect(listed.invitations).toEqual([]);
    expect(listed.members.map(m => [m.email, m.role])).toEqual([[OWNER, 'owner'], ['guest@firm.com', 'member']]);

    // Someone who already belongs, the owner included, is not invited again.
    await expectFailure(s.service.invite(owner, org.id, { email: 'Guest@Firm.com', role: 'admin' }), 'conflict', 409);
    await expectFailure(s.service.invite(owner, org.id, { email: OWNER, role: 'admin' }), 'conflict', 409);
    expect(await s.service.listMembers(org.id)).toMatchObject({ invitations: [] });
    expect((await s.service.listMembers(org.id)).members).toHaveLength(2);

    const revoked = await s.service.invite(owner, org.id, { email: 'late@firm.com', role: 'viewer' });
    await s.service.revokeInvitation(owner, org.id, revoked.id);
    await expectFailure(s.service.acceptInvitation(await s.user('late@firm.com'), inviteToken(revoked)), 'gone', 410);
    await expectFailure(s.service.revokeInvitation(owner, org.id, revoked.id), 'not_found', 404);

    const slow = await s.service.invite(owner, org.id, { email: 'slow@firm.com', role: 'viewer' });
    s.advance(7 * DAY);
    expect((await s.service.listMembers(org.id)).invitations).toEqual([]);
    await expectFailure(s.service.acceptInvitation(await s.user('slow@firm.com'), inviteToken(slow)), 'gone', 410);
    expect(await roleOf(s, org.id, (await s.user('slow@firm.com')).userId)).toBeNull();
  });

  it('a new invitation replaces the pending one of the same email, expired or not', async () => {
    const s = await scene();
    const { owner, org } = await s.ownedOrg();
    await s.pay(owner, org.id);
    const first = await s.service.invite(owner, org.id, { email: 'guest@firm.com', role: 'viewer' });
    const second = await s.service.invite(owner, org.id, { email: 'Guest@Firm.com', role: 'member' });
    expect((await s.service.listMembers(org.id)).invitations).toEqual([{ id: second.id, email: 'guest@firm.com', role: 'member',
      expiresAt: iso(T0 + 7 * DAY) }]);
    const guest = await s.user('guest@firm.com');
    await expectFailure(s.service.acceptInvitation(guest, inviteToken(first)), 'gone', 410);

    // An expired invitation still holds the SQL slot (invitations_pending_email_idx), so it is revoked too.
    s.advance(8 * DAY);
    const third = await s.service.invite(owner, org.id, { email: 'guest@firm.com', role: 'viewer' });
    expect(await s.repository.listInvitations(org.id)).toEqual([expect.objectContaining({ id: third.id })]);
    expect(await s.repository.findInvitationByHash(sha256(inviteToken(second)))).toMatchObject({ revoked_at: iso(T0 + 8 * DAY) });
    await expectFailure(s.service.acceptInvitation(guest, inviteToken(second)), 'gone', 410);
    expect(await s.service.acceptInvitation(guest, inviteToken(third))).toMatchObject({ id: org.id, role: 'viewer' });
  });

  it('accepting or removing closes every other link of that email', async () => {
    const s = await scene();
    const { owner, org } = await s.ownedOrg();
    await s.pay(owner, org.id);
    // A second live link for the same email, which the in-memory store allows (the SQL index would not).
    const extraLink = async (name: string) => {
      const token = `${name}-${'x'.repeat(40)}`;
      await s.repository.createInvitation({ id: `inv_${name}`, org_id: org.id, email: 'guest@firm.com', role: 'admin', token_hash: sha256(token),
        invited_by: owner.userId, expires_at: iso(s.now() + DAY), accepted_at: null, revoked_at: null, created_at: iso(s.now()) });
      return token;
    };
    const guest = await s.user('guest@firm.com');

    // Accept, then remove: the second link answers 410 and the removed member stays out.
    const invitation = await s.service.invite(owner, org.id, { email: 'guest@firm.com', role: 'member' });
    const second = await extraLink('second');
    await s.service.acceptInvitation(guest, inviteToken(invitation));
    expect((await s.service.listMembers(org.id)).invitations).toEqual([]);
    await s.service.removeMember(owner, org.id, guest.userId);
    await expectFailure(s.service.acceptInvitation(guest, second), 'gone', 410);
    expect(await roleOf(s, org.id, guest.userId)).toBeNull();

    // Removing a member closes the links still pending for their email.
    await s.service.acceptInvitation(guest, inviteToken(await s.service.invite(owner, org.id, { email: 'guest@firm.com', role: 'member' })));
    const leftover = await extraLink('leftover');
    await s.service.removeMember(owner, org.id, guest.userId);
    await expectFailure(s.service.acceptInvitation(guest, leftover), 'gone', 410);
    expect(await roleOf(s, org.id, guest.userId)).toBeNull();

    // Someone who already belongs keeps their role, and the other links are closed too.
    await s.service.acceptInvitation(guest, inviteToken(await s.service.invite(owner, org.id, { email: 'guest@firm.com', role: 'member' })));
    const [stale, other] = [await extraLink('stale'), await extraLink('other')];
    expect(await s.service.acceptInvitation(guest, stale)).toMatchObject({ id: org.id, role: 'member' });
    await expectFailure(s.service.acceptInvitation(guest, other), 'gone', 410);
    expect(await s.service.listMembers(org.id)).toMatchObject({ invitations: [] });
  });

  it('an invitation of another organization cannot be revoked through this one', async () => {
    const s = await scene();
    const a = await s.ownedOrg('sc_a');
    const b = await s.ownedOrg('sc_b', { email: 'boss@b.com' });
    await s.pay(a.owner, a.org.id);
    await s.pay(b.owner, b.org.id);
    const invitation = await s.service.invite(b.owner, b.org.id, { email: 'guest@b.com', role: 'member' });
    await expectFailure(s.service.revokeInvitation(a.owner, a.org.id, invitation.id), 'not_found', 404);
    expect((await s.service.listMembers(b.org.id)).invitations).toHaveLength(1);
  });
});

describe('billing', () => {
  it('a repeated billing event is applied once and an unknown organization is ignored', async () => {
    const s = await scene();
    const { owner, org } = await s.ownedOrg();
    const { event, outcome } = await s.pay(owner, org.id);
    expect(outcome).toBe('applied');
    expect(await s.service.applyBillingEvent(event)).toBe('duplicate');

    const failed: BillingEvent = { id: 'evt_failed', type: 'payment.failed', orgId: org.id, status: 'past_due', planCode: null,
      customerId: null, subscriptionId: null, currentPeriodEnd: null };
    expect(await s.service.applyBillingEvent(failed)).toBe('applied');
    // Replaying the old payment does not bring the organization back to active.
    expect(await s.service.applyBillingEvent(event)).toBe('duplicate');
    expect(await s.service.applyBillingEvent(failed)).toBe('duplicate');
    expect(await s.service.orgView(owner, org.id)).toMatchObject({ billingStatus: 'past_due', paidAccess: true });
    expect(await s.repository.getSubscription(org.id)).toMatchObject({ status: 'past_due', plan_code: 'monthly',
      customer_id: event.customerId, subscription_id: event.subscriptionId, current_period_end: event.currentPeriodEnd });

    for (const orgId of [randomUUID(), 'org_missing']) {
      const stray = { ...event, id: `evt_stray_${orgId}`, orgId };
      expect(await s.service.applyBillingEvent(stray)).toBe('unknown_org');
      expect(await s.repository.getSubscription(stray.orgId)).toBeNull();
      expect(await s.repository.getOrganization(stray.orgId)).toBeNull();
    }
  });

  it('a payment activates the organization and a cancellation keeps the deletion state untouched', async () => {
    const s = await scene();
    const { owner, org } = await s.ownedOrg();
    const { url } = await s.service.checkout(owner, org.id, 'monthly');
    expect(url).toMatch(new RegExp(`^${APP}/app/billing/mock-checkout\\?session=`));
    expect((await s.service.portal(owner, org.id)).url).toBe(`${APP}/app/billing`);
    expect(await s.service.applyBillingEvent(s.billing.pay(new URL(url).searchParams.get('session')!)!)).toBe('applied');
    expect(await s.service.orgView(owner, org.id)).toMatchObject({ billingStatus: 'active', paidAccess: true });
    expect(await s.repository.getSubscription(org.id)).toEqual({ org_id: org.id, plan_code: 'monthly', customer_id: expect.any(String),
      subscription_id: expect.any(String), status: 'active', current_period_end: '2026-11-25T12:00:00.000Z', updated_at: iso(T0) });

    await s.service.requestDeletion(owner, org.id, 'Closing the firm');
    const canceled: BillingEvent = { id: 'evt_canceled', type: 'subscription.canceled', orgId: org.id, status: 'canceled', planCode: null,
      customerId: null, subscriptionId: null, currentPeriodEnd: null };
    expect(await s.service.applyBillingEvent(canceled)).toBe('applied');
    expect(await s.service.orgView(owner, org.id)).toMatchObject({ billingStatus: 'canceled', paidAccess: false, deletionPending: true });
    expect(await s.repository.getOrganization(org.id)).toMatchObject({ deleted_at: null });
    expect(await s.repository.getPendingDeletionRequest(org.id)).toMatchObject({ status: 'pending' });

    // After an approved deletion, a billing event moves the billing state and nothing else.
    const request = (await s.repository.getPendingDeletionRequest(org.id))!;
    await s.service.reviewDeletion(await s.platformAdmin(), request.id, 'approve');
    const deletedAt = (await s.repository.getOrganization(org.id))!.deleted_at;
    expect(deletedAt).toBe(iso(T0));
    s.advance(HOUR);
    expect(await s.service.applyBillingEvent({ ...canceled, id: 'evt_late', type: 'subscription.updated', status: 'active' })).toBe('applied');
    expect(await s.repository.getOrganization(org.id)).toMatchObject({ deleted_at: deletedAt, billing_status: 'active' });
  });

  it('only the owner manages billing, and only for an active plan', async () => {
    const s = await scene();
    const { owner, org, admin } = await s.team();
    await expectFailure(s.service.checkout(admin, org.id, 'monthly'), 'forbidden', 403);
    await expectFailure(s.service.portal(admin, org.id), 'forbidden', 403);
    const unpaid = await s.ownedOrg('sc_unpaid');
    await expectFailure(s.service.checkout(unpaid.owner, unpaid.org.id, 'weekly'), 'invalid_request', 400);
    await s.service.updatePlan(await s.platformAdmin(), 'annual', { active: false });
    await expectFailure(s.service.checkout(unpaid.owner, unpaid.org.id, 'annual'), 'invalid_request', 400);
  });

  it('an organization that already pays goes to the portal, not to another checkout', async () => {
    const s = await scene();
    const { owner, org } = await s.ownedOrg();
    await s.pay(owner, org.id);
    const checkout = vi.spyOn(s.billing, 'createCheckout');
    await expectFailure(s.service.checkout(owner, org.id, 'annual'), 'conflict', 409);
    await s.service.applyBillingEvent({ id: 'evt_failed', type: 'payment.failed', orgId: org.id, status: 'past_due', planCode: null,
      customerId: null, subscriptionId: null, currentPeriodEnd: null });
    await expectFailure(s.service.checkout(owner, org.id, 'monthly'), 'conflict', 409);
    expect(checkout).not.toHaveBeenCalled();
    expect((await s.service.portal(owner, org.id)).url).toBe(`${APP}/app/billing`);

    // Once the subscription is canceled, paying again starts with a checkout.
    await s.service.applyBillingEvent({ id: 'evt_canceled', type: 'subscription.canceled', orgId: org.id, status: 'canceled', planCode: null,
      customerId: null, subscriptionId: null, currentPeriodEnd: null });
    expect((await s.service.checkout(owner, org.id, 'monthly')).url).toMatch(/mock-checkout\?session=/);
  });
});

describe('deletion and the platform admin', () => {
  it('deletion is only requested', async () => {
    const s = await scene();
    const { owner, org, admin: orgAdmin } = await s.team();
    await expectFailure(s.service.requestDeletion(orgAdmin, org.id, 'Not mine to ask'), 'forbidden', 403);

    const first = DeletionRequestView.parse(await s.service.requestDeletion(owner, org.id, 'Closing the firm'));
    expect(first).toEqual({ id: expect.any(String), orgId: org.id, reason: 'Closing the firm', status: 'pending', requestedAt: iso(T0),
      reviewedAt: null, reviewNote: null });
    expect(await s.repository.getOrganization(org.id)).toMatchObject({ deleted_at: null, billing_status: 'active' });
    expect(await s.service.orgView(owner, org.id)).toMatchObject({ deletionPending: true, paidAccess: true });
    await expect(s.service.authorize(owner, org.id, 'org.read', { payment: true })).resolves.toMatchObject({ role: 'owner' });
    await expectFailure(s.service.requestDeletion(owner, org.id, 'Again'), 'conflict', 409);

    await expectFailure(s.service.reviewDeletion(owner, first.id, 'approve'), 'forbidden', 403);
    const ops = await s.platformAdmin();
    const rejected = await s.service.reviewDeletion(ops, first.id, 'reject', 'Send a signed letter');
    expect(rejected).toMatchObject({ status: 'rejected', reviewedAt: iso(T0), reviewNote: 'Send a signed letter' });
    expect(await s.repository.getOrganization(org.id)).toMatchObject({ deleted_at: null, billing_status: 'active' });
    expect(s.billing.canceled).toEqual([]);
    expect(await s.service.orgView(owner, org.id)).toMatchObject({ deletionPending: false });
    await expectFailure(s.service.reviewDeletion(ops, first.id, 'approve'), 'conflict', 409);
    for (const id of [randomUUID(), 'dr_missing']) await expectFailure(s.service.reviewDeletion(ops, id, 'approve'), 'not_found', 404);

    const second = await s.service.requestDeletion(owner, org.id, 'Closing the firm, signed letter attached');
    expect(await s.service.listDeletionRequests()).toEqual([rejected, second].map(r => DeletionRequestView.parse(r)));
    s.advance(HOUR);
    expect(await s.service.reviewDeletion(ops, second.id, 'approve')).toMatchObject({ status: 'approved', reviewNote: null });
    expect(await s.repository.getOrganization(org.id)).toMatchObject({ deleted_at: iso(T0 + HOUR), billing_status: 'active' });
    expect(s.billing.canceled).toEqual([org.id]);
    await expectFailure(s.service.reviewDeletion(ops, second.id, 'reject'), 'conflict', 409);
    expect(await s.service.listOrganizations()).toEqual([{ id: org.id, name: 'Smith & Co', billingStatus: 'active', deleted: true, members: 4 }]);
  });

  it('a plan price change is what the next checkout charges', async () => {
    const s = await scene();
    const { owner, org } = await s.ownedOrg();
    const ops = await s.platformAdmin();
    await expectFailure(s.service.updatePlan(owner, 'monthly', { amountCents: 1 }), 'forbidden', 403);
    await expectFailure(s.service.updatePlan(ops, 'weekly', { amountCents: 1 }), 'not_found', 404);

    expect(PlanView.parse(await s.service.updatePlan(ops, 'monthly', { amountCents: 1000 }))).toEqual({ code: 'monthly',
      name: 'Monthly (example price)', amountCents: 1000, currency: 'usd', interval: 'month' });
    expect((await s.service.listPlans()).find(plan => plan.code === 'monthly')).toMatchObject({ amountCents: 1000 });

    const createCheckout = vi.spyOn(s.billing, 'createCheckout');
    await s.service.checkout(owner, org.id, 'monthly');
    expect(createCheckout).toHaveBeenCalledWith({ orgId: org.id, plan: { code: 'monthly', name: 'Monthly (example price)',
      amount_cents: 1000, currency: 'usd', interval: 'month', active: true }, successUrl: `${APP}/app?paid=1`, cancelUrl: `${APP}/app/billing` });

    await s.service.updatePlan(ops, 'annual', { active: false });
    expect((await s.service.listPlans()).map(plan => plan.code)).toEqual(['monthly']);
    expect((await s.service.listAllPlans()).map(plan => PlanView.parse(plan).code)).toEqual(['monthly', 'annual']);
  });
});

describe('views', () => {
  it('timestamps leave as ISO with Z, whatever format the store returns', async () => {
    const s = await scene();
    const { owner, org } = await s.ownedOrg();
    await s.pay(owner, org.id);
    // How Postgres prints a timestamptz.
    const pg = '2026-10-25 13:30:00.5+00';
    const expected = '2026-10-25T13:30:00.500Z';
    await s.addScan('sc_pg');
    await s.repository.claimAnalysis({ org_id: org.id, scan_id: 'sc_pg', assessment_id: null, claimed_by: owner.userId, claimed_at: pg });
    const guest = await s.user('guest@firm.com');
    await s.repository.upsertProfile({ user_id: guest.userId, email: 'guest@firm.com', full_name: null, last_org_id: null, created_at: pg });
    await s.repository.addMember({ org_id: org.id, user_id: guest.userId, role: 'viewer', invited_by: owner.userId, created_at: pg });
    await s.repository.createInvitation({ id: 'inv_pg', org_id: org.id, email: 'late@firm.com', role: 'viewer', token_hash: sha256('pg'),
      invited_by: owner.userId, expires_at: '2026-11-01 13:30:00.5+00', accepted_at: null, revoked_at: null, created_at: pg });
    await s.repository.createDeletionRequest({ id: 'dr_pg', org_id: org.id, requested_by: owner.userId, reason: 'Closing the firm',
      status: 'pending', reviewed_by: null, reviewed_at: null, review_note: null, created_at: pg });
    await s.repository.reviewDeletionRequest('dr_pg', 'rejected', owner.userId, null, pg);

    const analysis = (await s.service.listAnalyses(org.id)).find(view => view.scanId === 'sc_pg')!;
    expect(AnalysisView.parse(analysis).claimedAt).toBe(expected);
    const { members, invitations } = await s.service.listMembers(org.id);
    expect(members.map(m => MemberView.parse(m)).find(m => m.userId === guest.userId)!.joinedAt).toBe(expected);
    expect(invitations.map(i => InvitationView.parse(i))).toEqual([expect.objectContaining({ expiresAt: '2026-11-01T13:30:00.500Z' })]);
    expect((await s.service.listDeletionRequests()).map(r => DeletionRequestView.parse(r)))
      .toEqual([expect.objectContaining({ requestedAt: expected, reviewedAt: expected })]);
  });
});

describe('audit', () => {
  it('every change writes the audit log', async () => {
    const s = await scene();
    const appendAudit = vi.spyOn(s.repository, 'appendAudit');
    const { owner, org, admin, member, viewer } = await s.team();
    await s.service.attachAnalysis(owner, org.id, await s.claim('sc_2'));
    await s.service.setRole(admin, org.id, viewer.userId, 'member');
    await s.service.removeMember(admin, org.id, member.userId);
    const invitation = await s.service.invite(owner, org.id, { email: 'late@firm.com', role: 'viewer' });
    await s.service.revokeInvitation(owner, org.id, invitation.id);
    const request = await s.service.requestDeletion(owner, org.id, 'Closing the firm');
    const ops = await s.platformAdmin();
    await s.service.reviewDeletion(ops, request.id, 'reject');
    await s.service.updatePlan(ops, 'monthly', { amountCents: 1000 });

    // Who acted is fixed when the row is written: ARCA staff from /admin/* as platform, a billing event as system (DN-11 §4.3).
    const log = appendAudit.mock.calls.map(([record]) => [record.action, record.actor_user_id, record.org_id, record.actor_kind]);
    expect(log).toEqual([
      ['org.created', owner.userId, org.id, 'member'],
      ['billing.event_applied', null, org.id, 'system'],
      ...[admin, member, viewer].flatMap(joined => [['member.invited', owner.userId, org.id, 'member'],
        ['member.joined', joined.userId, org.id, 'member']]),
      ['analysis.claimed', owner.userId, org.id, 'member'],
      ['member.role_changed', admin.userId, org.id, 'member'],
      ['member.removed', admin.userId, org.id, 'member'],
      ['member.invited', owner.userId, org.id, 'member'],
      ['invitation.revoked', owner.userId, org.id, 'member'],
      ['org.deletion_requested', owner.userId, org.id, 'member'],
      ['org.deletion_rejected', ops.userId, org.id, 'platform'],
      ['plan.updated', ops.userId, null, 'platform'],
    ]);
    expect(appendAudit.mock.calls.find(([record]) => record.action === 'member.role_changed')![0])
      .toMatchObject({ target: viewer.userId, data: { from: 'viewer', to: 'member' } });
    expect(await s.repository.listAudit(org.id, { limit: 200 })).toHaveLength(log.length - 1);
  });

  it('the copy for the mock demo seed audits as the system what a member would, naming no user', async () => {
    const s = await scene();
    const appendAudit = vi.spyOn(s.repository, 'appendAudit');
    const system = s.service.asSystem();
    const owner = await s.user(OWNER);
    const org = await system.createOrganization(owner, { name: 'Robust Law (demo)', claimId: await s.claim('sc_1') });
    await s.pay(owner, org.id);
    const invitation = await system.invite(owner, org.id, { email: 'admin@firm.com', role: 'admin' });
    const admin = await s.user('admin@firm.com');
    await system.acceptInvitation(admin, inviteToken(invitation));
    // The same rules and store: the member is in, and the original service keeps auditing members as members.
    expect(await roleOf(s, org.id, admin.userId)).toBe('admin');
    await s.service.renameOrganization(owner, org.id, 'Robust Law');
    expect(appendAudit.mock.calls.map(([record]) => [record.action, record.actor_user_id, record.actor_kind])).toEqual([
      ['org.created', null, 'system'], ['billing.event_applied', null, 'system'], ['member.invited', null, 'system'],
      ['member.joined', null, 'system'], ['org.renamed', owner.userId, 'member']]);
  });
});

// The DN-11 rules: the action plan, the activity, renaming and the platform admin panel.
const canceled = (orgId: string, id = 'evt_canceled'): BillingEvent => ({ id, type: 'subscription.canceled', orgId, status: 'canceled',
  planCode: null, customerId: null, subscriptionId: null, currentPeriodEnd: null });
const A1 = 'a.sc_1.improve:D1.1';
const A2 = 'a.sc_1.improve:D3.2';
const untouched = { status: 'todo', assignee: null, dueDate: null, updatedAt: null } as const;

describe('the action plan', () => {
  it('lists the current plan, untouched actions as todo, then the organization\'s own', async () => {
    const s = await scene();
    const { owner, org, admin, member, viewer } = await s.team();
    expect(ActionPlanResponse.parse(await s.service.listActions(viewer, org.id))).toEqual({
      source: { scanId: 'sc_1', domain: 'firm.com', claimedAt: iso(T0) },
      items: PLAN.map(item => ({ key: `a.sc_1.${item.id}`, source: 'assessment', title: item.title, detail: item.detail, domain: item.domain,
        pointsGain: item.pointsGain, ...untouched })),
    });

    s.advance(HOUR);
    const own = ActionItemView.parse(await s.service.createAction(admin, org.id, { title: 'Name an AI lead',
      detail: 'Someone who owns the policy', domain: 'governance' }));
    expect(own).toEqual({ key: expect.stringMatching(/^c\.[0-9a-f-]{36}$/), source: 'custom', title: 'Name an AI lead',
      detail: 'Someone who owns the policy', domain: 'governance', pointsGain: null, status: 'todo', assignee: null, dueDate: null,
      updatedAt: iso(T0 + HOUR) });
    const bare = await s.service.createAction(owner, org.id, { title: 'Train the associates', detail: '' });
    expect(bare).toMatchObject({ detail: null, domain: null });
    const plan = ActionPlanResponse.parse(await s.service.listActions(member, org.id));
    expect(plan.items.map(item => item.key)).toEqual([A1, A2, own.key, bare.key]);
    expect(plan.items[2]).toEqual(own);

    // Reading the plan needs the payment, like the analyses.
    await s.service.applyBillingEvent(canceled(org.id));
    await expectFailure(s.service.listActions(owner, org.id), 'payment_required', 402);
    await expectFailure(s.service.listActions(await s.user('stranger@other.com'), org.id), 'not_found', 404);
  });

  it('without a completed assessment there is no plan, only the organization\'s own actions', async () => {
    const s = await scene();
    const { owner, org } = await s.ownedOrg('sc_1', { assessment: 'IN_PROGRESS' });
    await s.pay(owner, org.id);
    expect(await s.service.listActions(owner, org.id)).toEqual({ source: null, items: [] });
    const own = await s.service.createAction(owner, org.id, { title: 'Name an AI lead' });
    expect(ActionPlanResponse.parse(await s.service.listActions(owner, org.id))).toEqual({ source: null, items: [own] });
    await expectFailure(s.service.updateAction(owner, org.id, A1, { status: 'done' }), 'not_found', 404);
  });

  it('the current plan is the latest claim with a completed assessment, read live, and its progress starts over (D14)', async () => {
    const s = await scene();
    const { owner, org, member } = await s.team();
    await s.service.updateAction(member, org.id, A1, { status: 'done' });

    // A later analysis with no assessment leaves the plan where it was.
    s.advance(HOUR);
    await s.service.attachAnalysis(owner, org.id, await s.claim('sc_2'));
    expect((await s.service.listActions(owner, org.id)).source).toMatchObject({ scanId: 'sc_1' });
    // Its assessment is completed after the claim: org_analyses.assessment_id stays null, and the plan moves anyway.
    await s.assessments.create(assessmentRecord('sc_2', 'COMPLETED', [PLAN[0]!]));
    expect((await s.repository.listAnalyses(org.id)).find(analysis => analysis.scan_id === 'sc_2')).toMatchObject({ assessment_id: null });
    const plan = ActionPlanResponse.parse(await s.service.listActions(owner, org.id));
    expect(plan.source).toEqual({ scanId: 'sc_2', domain: 'firm.com', claimedAt: iso(T0 + HOUR) });
    // Progress is not carried over by action key, and a key of the old plan names nothing any more.
    expect(plan.items).toEqual([expect.objectContaining({ key: 'a.sc_2.improve:D1.1', ...untouched })]);
    await expectFailure(s.service.updateAction(member, org.id, A1, { status: 'in_progress' }), 'not_found', 404);
    // The old plan's row is kept as it was.
    expect(await s.repository.getAssessmentAction(org.id, 'sc_1', 'improve:D1.1')).toMatchObject({ status: 'done' });
  });

  it('of two claims at the same time, the larger scan id holds the current plan', async () => {
    const s = await scene();
    const { owner, org } = await s.ownedOrg('sc_b');
    await s.pay(owner, org.id);
    await s.service.attachAnalysis(owner, org.id, await s.claim('sc_a', { assessment: 'COMPLETED' }));
    expect((await s.service.listActions(owner, org.id)).source).toMatchObject({ scanId: 'sc_b' });
    s.advance(1);
    await s.service.attachAnalysis(owner, org.id, await s.claim('sc_0', { assessment: 'COMPLETED' }));
    expect((await s.service.listActions(owner, org.id)).source).toMatchObject({ scanId: 'sc_0' });
  });

  it('the fields sent decide the permission, for the whole request', async () => {
    const s = await scene();
    const { owner, org, admin, member, viewer } = await s.team();
    // The status alone takes actions.update, which a member has.
    expect(ActionItemView.parse(await s.service.updateAction(member, org.id, A1, { status: 'in_progress' })))
      .toMatchObject({ key: A1, status: 'in_progress', assignee: null, dueDate: null, updatedAt: iso(T0) });
    await expectFailure(s.service.updateAction(viewer, org.id, A1, { status: 'done' }), 'forbidden', 403);
    // An assignee or a due date, even null, takes actions.assign, and then nothing of the request is applied.
    const assigning: UpdateActionRequest[] = [{ status: 'done', dueDate: '2026-12-01' }, { status: 'done', assigneeUserId: null }, { dueDate: null }];
    for (const req of assigning) await expectFailure(s.service.updateAction(member, org.id, A1, req), 'forbidden', 403);
    expect(await s.repository.getAssessmentAction(org.id, 'sc_1', 'improve:D1.1')).toMatchObject({ status: 'in_progress', due_date: null });

    expect(await s.service.updateAction(admin, org.id, A1, { status: 'done', assigneeUserId: member.userId, dueDate: '2026-12-01' }))
      .toMatchObject({ status: 'done', assignee: { userId: member.userId, email: 'member@firm.com' }, dueDate: '2026-12-01' });
    // Null clears.
    expect(await s.service.updateAction(owner, org.id, A1, { assigneeUserId: null, dueDate: null }))
      .toMatchObject({ status: 'done', assignee: null, dueDate: null });
  });

  it('a key names an action only in this organization\'s current plan or among its own', async () => {
    const s = await scene();
    const a = await s.team();
    const b = await s.ownedOrg('sc_b', { email: 'boss@b.com', assessment: 'COMPLETED' });
    await s.pay(b.owner, b.org.id);
    const theirs = await s.service.createAction(b.owner, b.org.id, { title: 'Their own action' });
    const appendAudit = vi.spyOn(s.repository, 'appendAudit');
    const keys = [theirs.key, 'a.sc_b.improve:D1.1', 'a.sc_1.improve:D9.9', 'a.sc_1.', `c.${randomUUID()}`, 'c.not-a-uuid', `${A1}.x`,
      'x.sc_1.improve:D1.1', 'a.sc-1.improve:D1.1', 'improve:D1.1', ''];
    for (const key of keys) {
      await expectFailure(s.service.updateAction(a.owner, a.org.id, key, { status: 'done' }), 'not_found', 404);
      await expectFailure(s.service.updateAction(a.owner, a.org.id, key, { dueDate: '2026-12-01' }), 'not_found', 404);
    }
    for (const key of keys.filter(key => !key.startsWith('a.'))) {
      await expectFailure(s.service.deleteAction(a.owner, a.org.id, key), 'not_found', 404);
    }
    // Nothing was created, written or audited, here or in the other organization.
    expect(appendAudit).not.toHaveBeenCalled();
    expect(await s.repository.listActions(a.org.id)).toEqual([]);
    expect((await s.service.listActions(b.owner, b.org.id)).items).toEqual([expect.objectContaining(untouched),
      expect.objectContaining(untouched), theirs]);
  });

  it('only a current member who can mark actions may hold one (D11)', async () => {
    const s = await scene();
    const { owner, org, admin, member, viewer } = await s.team();
    const outsider = await s.user('outsider@other.com');
    await s.service.me(outsider);
    const messages = new Set<string>();
    for (const userId of [viewer.userId, outsider.userId, randomUUID()]) {
      const error = await s.service.updateAction(owner, org.id, A1, { assigneeUserId: userId }).then(() => null, (caught: unknown) => caught);
      expect(error).toMatchObject({ code: 'invalid_request', status: 400 });
      messages.add((error as Error).message);
    }
    // The same answer whether the user exists or not.
    expect(messages.size).toBe(1);
    expect(await s.repository.listActions(org.id)).toEqual([]);
    for (const holder of [owner, admin, member]) {
      expect(await s.service.updateAction(admin, org.id, A1, { assigneeUserId: holder.userId }))
        .toMatchObject({ assignee: { userId: holder.userId } });
    }
    // The key is checked before the assignee.
    await expectFailure(s.service.updateAction(owner, org.id, 'a.sc_1.missing', { assigneeUserId: viewer.userId }), 'not_found', 404);
  });

  it('a creation the store refuses for its assignee is the same 400, never a 500', async () => {
    // No request names an assignee on creation today; the store checks one anyway, and its refusal must keep its answer.
    class Refusing extends InMemoryWebappRepository {
      override async createCustomAction(): Promise<void> { throw new IneligibleAssignee(); }
    }
    const s = await scene(new Refusing(DEFAULT_PLANS));
    const { owner, org } = await s.team();
    const appendAudit = vi.spyOn(s.repository, 'appendAudit');
    const error = await s.service.createAction(owner, org.id, { title: 'Name an AI lead' }).then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(WebappFailure);
    expect(error).toMatchObject({ code: 'invalid_request', status: 400, message: ASSIGNEE_REFUSED });
    expect(appendAudit).not.toHaveBeenCalled();
  });

  it('a change that changes nothing writes and audits nothing', async () => {
    const s = await scene();
    const { owner, org, member } = await s.team();
    const own = await s.service.createAction(owner, org.id, { title: 'Name an AI lead' });
    const appendAudit = vi.spyOn(s.repository, 'appendAudit');
    const upsert = vi.spyOn(s.repository, 'upsertAssessmentAction');
    const update = vi.spyOn(s.repository, 'updateAction');
    // An untouched action of the assessment is todo, with nobody and no date: no row is created for it.
    expect(await s.service.updateAction(member, org.id, A1, { status: 'todo' })).toMatchObject({ key: A1, ...untouched });
    expect(await s.service.updateAction(owner, org.id, A1, { assigneeUserId: null, dueDate: null })).toMatchObject(untouched);
    expect(await s.service.updateAction(member, org.id, own.key, { status: 'todo' })).toEqual(own);
    expect(await s.repository.listActions(org.id)).toHaveLength(1);

    s.advance(HOUR);
    const done = await s.service.updateAction(member, org.id, A1, { status: 'done' });
    s.advance(HOUR);
    expect(await s.service.updateAction(owner, org.id, A1, { status: 'done', dueDate: null })).toEqual(done);
    expect(appendAudit.mock.calls.map(([record]) => record.action)).toEqual(['action.updated']);
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
  });

  it('a change writes the row and audits the key with the values before and after', async () => {
    const s = await scene();
    const { owner, org, member } = await s.team();
    s.advance(HOUR);
    await s.service.updateAction(owner, org.id, A2, { assigneeUserId: member.userId, dueDate: '2026-12-01' });
    expect(await s.repository.getAssessmentAction(org.id, 'sc_1', 'improve:D3.2')).toEqual({ id: expect.any(String), org_id: org.id,
      source: 'assessment', scan_id: 'sc_1', action_key: 'improve:D3.2', title: null, detail: null, domain: null, status: 'todo',
      assignee_user_id: member.userId, due_date: '2026-12-01', created_by: owner.userId, created_at: iso(T0 + HOUR), updated_by: owner.userId,
      updated_at: iso(T0 + HOUR) });
    s.advance(HOUR);
    const marked = await s.service.updateAction(member, org.id, A2, { status: 'in_progress' });
    expect(marked).toMatchObject({ status: 'in_progress', assignee: { userId: member.userId, email: 'member@firm.com' }, dueDate: '2026-12-01',
      updatedAt: iso(T0 + 2 * HOUR) });
    expect(await s.repository.getAssessmentAction(org.id, 'sc_1', 'improve:D3.2'))
      .toMatchObject({ created_by: owner.userId, created_at: iso(T0 + HOUR), updated_by: member.userId, updated_at: iso(T0 + 2 * HOUR) });
    expect((await s.service.listActions(owner, org.id)).items[1]).toEqual(marked);

    // Each event keeps only the fields its request changed.
    const [second, first] = await s.repository.listAudit(org.id, { limit: 2 });
    expect(first).toMatchObject({ action: 'action.updated', actor_user_id: owner.userId, actor_kind: 'member', target: A2,
      data: { title: PLAN[1]!.title, before: { assigneeUserId: null, dueDate: null }, after: { assigneeUserId: member.userId, dueDate: '2026-12-01' } } });
    expect(second).toMatchObject({ action: 'action.updated', actor_user_id: member.userId, target: A2,
      data: { before: { status: 'todo' }, after: { status: 'in_progress' } } });
    expect([first!.data.before, second!.data.after]).toEqual([{ assigneeUserId: null, dueDate: null }, { status: 'in_progress' }]);

    // A field sent with the value it already has is neither written nor audited.
    s.advance(HOUR);
    const update = vi.spyOn(s.repository, 'upsertAssessmentAction');
    await s.service.updateAction(owner, org.id, A2, { status: 'done', dueDate: '2026-12-01', assigneeUserId: member.userId });
    expect(update.mock.calls[0]![1]).toEqual({ status: 'done', updated_by: owner.userId, updated_at: iso(T0 + 3 * HOUR) });
    expect((await s.repository.listAudit(org.id, { limit: 1 }))[0]!.data).toEqual({ title: PLAN[1]!.title, before: { status: 'in_progress' },
      after: { status: 'done' } });
  });

  it('two changes to the same action at once both stay, and each is audited as made', async () => {
    const s = await scene();
    const { owner, org, admin, member } = await s.team();
    const own = await s.service.createAction(owner, org.id, { title: 'Name an AI lead' });
    // An untouched assessment action (its row is created by the race), one that has a row, and one of the organization's own.
    await s.service.updateAction(owner, org.id, A2, { dueDate: '2026-12-01' });
    for (const key of [A1, A2, own.key]) {
      const appendAudit = vi.spyOn(s.repository, 'appendAudit');
      const [marked, assigned] = await Promise.all([s.service.updateAction(member, org.id, key, { status: 'done' }),
        s.service.updateAction(admin, org.id, key, { assigneeUserId: member.userId })]);
      const stored = (await s.service.listActions(owner, org.id)).items.find(item => item.key === key)!;
      expect(stored, key).toMatchObject({ status: 'done', assignee: { userId: member.userId } });
      // Each answer holds its own change, and the write that landed last answers with both.
      expect([marked.status, assigned.assignee?.userId], key).toEqual(['done', member.userId]);
      expect([marked, assigned].some(view => view.status === 'done' && view.assignee?.userId === member.userId), key).toBe(true);
      const audited = new Map(appendAudit.mock.calls.map(([record]) => [record.actor_user_id, [record.target, record.data.before, record.data.after]]));
      expect(audited, key).toEqual(new Map([[member.userId, [key, { status: 'todo' }, { status: 'done' }]],
        [admin.userId, [key, { assigneeUserId: null }, { assigneeUserId: member.userId }]]]));
      appendAudit.mockRestore();
    }
    expect(await s.repository.getAssessmentAction(org.id, 'sc_1', 'improve:D3.2')).toMatchObject({ due_date: '2026-12-01' });
    expect((await s.repository.listActions(org.id)).filter(row => row.source === 'assessment')).toHaveLength(2);
  });

  it('an organization keeps at most 100 actions of its own', async () => {
    const s = await scene();
    const { owner, org, member, viewer } = await s.team();
    for (const other of [member, viewer]) await expectFailure(s.service.createAction(other, org.id, { title: 'Mine' }), 'forbidden', 403);
    for (let index = 0; index < 99; index++) {
      await s.repository.createCustomAction({ id: randomUUID(), org_id: org.id, source: 'custom', scan_id: null, action_key: null,
        title: `Action ${index}`, detail: null, domain: null, status: 'todo', assignee_user_id: null, due_date: null, created_by: owner.userId,
        created_at: iso(T0), updated_by: owner.userId, updated_at: iso(T0) });
    }
    const hundredth = await s.service.createAction(owner, org.id, { title: 'The hundredth' });
    await expectFailure(s.service.createAction(owner, org.id, { title: 'One too many' }), 'conflict', 409);
    expect(await s.repository.countCustomActions(org.id)).toBe(100);
    // The assessment's actions do not count, and deleting one makes room.
    await s.service.deleteAction(owner, org.id, hundredth.key);
    expect(await s.service.createAction(owner, org.id, { title: 'Room again' })).toMatchObject({ title: 'Room again' });
  });

  it('creations that race at the cap stop at 100 actions', async () => {
    const s = await scene();
    const { owner, org, admin } = await s.team();
    for (let index = 0; index < 98; index++) {
      await s.repository.createCustomAction({ id: randomUUID(), org_id: org.id, source: 'custom', scan_id: null, action_key: null,
        title: `Action ${index}`, detail: null, domain: null, status: 'todo', assignee_user_id: null, due_date: null, created_by: owner.userId,
        created_at: iso(T0), updated_by: owner.userId, updated_at: iso(T0) });
    }
    const appendAudit = vi.spyOn(s.repository, 'appendAudit');
    // Every one of them counts 98 before any is written.
    const results = await Promise.allSettled([owner, admin, owner, admin, owner].map((who, index) =>
      s.service.createAction(who, org.id, { title: `Racing ${index}` })));
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'fulfilled', 'rejected', 'rejected', 'rejected']);
    for (const result of results) {
      if (result.status === 'rejected') expect(result.reason).toMatchObject({ code: 'conflict', status: 409 });
    }
    expect(await s.repository.countCustomActions(org.id)).toBe(100);
    expect(appendAudit.mock.calls.map(([record]) => record.action)).toEqual(['action.created', 'action.created']);
  });

  it('only the organization\'s own actions are deleted, by whoever can assign (D13)', async () => {
    const s = await scene();
    const { owner, org, admin, member } = await s.team();
    const own = await s.service.createAction(owner, org.id, { title: 'Name an AI lead' });
    await expectFailure(s.service.deleteAction(member, org.id, own.key), 'forbidden', 403);
    // Any assessment key gets the same 400, in the plan or not.
    for (const key of [A1, 'a.sc_1.missing', 'a.anything']) await expectFailure(s.service.deleteAction(admin, org.id, key), 'invalid_request', 400);
    expect((await s.service.listActions(owner, org.id)).items).toHaveLength(3);

    await s.service.deleteAction(admin, org.id, own.key);
    expect((await s.service.listActions(owner, org.id)).items.map(item => item.key)).toEqual([A1, A2]);
    await expectFailure(s.service.deleteAction(admin, org.id, own.key), 'not_found', 404);
    await expectFailure(s.service.updateAction(admin, org.id, own.key, { status: 'done' }), 'not_found', 404);
    expect((await s.repository.listAudit(org.id, { limit: 1 }))[0]).toMatchObject({ action: 'action.deleted', actor_user_id: admin.userId,
      target: own.key, data: { title: 'Name an AI lead' } });
  });

  it('a user writes to action plans at most 60 times a minute', async () => {
    const s = await scene();
    const { owner, org, admin, member } = await s.team();
    const own = await s.service.createAction(owner, org.id, { title: 'Name an AI lead' });
    const statuses = ['in_progress', 'done', 'todo'] as const;
    for (let index = 0; index < 59; index++) await s.service.updateAction(owner, org.id, A1, { status: statuses[index % 3]! });
    const appendAudit = vi.spyOn(s.repository, 'appendAudit');
    await expectFailure(s.service.updateAction(owner, org.id, A1, { status: 'todo' }), 'rate_limited', 429);
    await expectFailure(s.service.createAction(owner, org.id, { title: 'Another' }), 'rate_limited', 429);
    await expectFailure(s.service.deleteAction(owner, org.id, own.key), 'rate_limited', 429);
    expect(appendAudit).not.toHaveBeenCalled();
    // A change that changes nothing writes nothing, so it still answers.
    expect(await s.service.updateAction(owner, org.id, A1, { status: 'done' })).toMatchObject({ status: 'done' });
    // The cap is per user.
    expect(await s.service.updateAction(member, org.id, A1, { status: 'todo' })).toMatchObject({ status: 'todo' });
    await s.service.updateAction(admin, org.id, A2, { dueDate: '2026-12-01' });
    s.advance(60_000);
    expect(await s.service.updateAction(owner, org.id, A1, { status: 'in_progress' })).toMatchObject({ status: 'in_progress' });
  });

  it('removing a member frees their actions, and coming back does not restore them (D15)', async () => {
    const s = await scene();
    const { owner, org, member } = await s.team();
    const own = await s.service.createAction(owner, org.id, { title: 'Name an AI lead' });
    await s.service.updateAction(owner, org.id, A1, { assigneeUserId: member.userId, status: 'in_progress' });
    await s.service.updateAction(owner, org.id, own.key, { assigneeUserId: member.userId });
    await s.service.updateAction(owner, org.id, A2, { assigneeUserId: owner.userId });
    await s.service.removeMember(owner, org.id, member.userId);
    const holders = async () => (await s.service.listActions(owner, org.id)).items
      .map(item => [item.key, item.assignee?.userId ?? null, item.status]);
    expect(await holders()).toEqual([[A1, null, 'in_progress'], [A2, owner.userId, 'todo'], [own.key, null, 'todo']]);
    await expectFailure(s.service.updateAction(owner, org.id, A1, { assigneeUserId: member.userId }), 'invalid_request', 400);

    await s.service.acceptInvitation(member, inviteToken(await s.service.invite(owner, org.id, { email: 'member@firm.com', role: 'member' })));
    expect(await holders()).toEqual([[A1, null, 'in_progress'], [A2, owner.userId, 'todo'], [own.key, null, 'todo']]);
  });

  it('a member made viewer lets go of their actions, and is not given them back with the role (D11, D15)', async () => {
    const s = await scene();
    const { owner, org, admin, member } = await s.team();
    const own = await s.service.createAction(owner, org.id, { title: 'Name an AI lead' });
    await s.service.updateAction(owner, org.id, A1, { assigneeUserId: member.userId, status: 'in_progress' });
    await s.service.updateAction(owner, org.id, own.key, { assigneeUserId: member.userId, dueDate: '2026-12-01' });
    await s.service.updateAction(owner, org.id, A2, { assigneeUserId: admin.userId });
    const holders = async () => (await s.service.listActions(owner, org.id)).items
      .map(item => [item.key, item.assignee?.userId ?? null, item.status, item.dueDate]);

    // A role that can still mark actions keeps them.
    await s.service.setRole(owner, org.id, admin.userId, 'member');
    expect(await holders()).toEqual([[A1, member.userId, 'in_progress', null], [A2, admin.userId, 'todo', null],
      [own.key, member.userId, 'todo', '2026-12-01']]);
    // A viewer cannot, so nothing stays with them; the rest of each action is untouched.
    await s.service.setRole(owner, org.id, member.userId, 'viewer');
    expect(await holders()).toEqual([[A1, null, 'in_progress', null], [A2, admin.userId, 'todo', null], [own.key, null, 'todo', '2026-12-01']]);
    await s.service.setRole(owner, org.id, member.userId, 'member');
    expect(await holders()).toEqual([[A1, null, 'in_progress', null], [A2, admin.userId, 'todo', null], [own.key, null, 'todo', '2026-12-01']]);
  });

  it('checks access, then the key, then the assignee', async () => {
    const s = await scene();
    const { owner, org, viewer } = await s.team();
    const stranger = await s.user('stranger@other.com');
    await expectFailure(s.service.updateAction(stranger, org.id, 'nonsense', { status: 'done' }), 'not_found', 404);
    await expectFailure(s.service.updateAction(viewer, org.id, 'nonsense', { status: 'done' }), 'forbidden', 403);
    await s.service.applyBillingEvent(canceled(org.id));
    // The role before the payment, and the payment before the key.
    await expectFailure(s.service.updateAction(viewer, org.id, A1, { dueDate: null }), 'forbidden', 403);
    await expectFailure(s.service.updateAction(owner, org.id, 'nonsense', { status: 'done' }), 'payment_required', 402);
    await expectFailure(s.service.createAction(owner, org.id, { title: 'Name an AI lead' }), 'payment_required', 402);
    await expectFailure(s.service.deleteAction(owner, org.id, A1), 'payment_required', 402);
    const request = await s.service.requestDeletion(owner, org.id, 'Closing the firm');
    await s.service.reviewDeletion(await s.platformAdmin(), request.id, 'approve');
    await expectFailure(s.service.updateAction(viewer, org.id, 'nonsense', { dueDate: null }), 'gone', 410);
    await expectFailure(s.service.updateAction(stranger, org.id, 'nonsense', { dueDate: null }), 'not_found', 404);
  });
});

describe('the action plan under requests that race', () => {
  async function racing() {
    const repository = new HoldingRepository(DEFAULT_PLANS);
    const s = await scene(repository);
    const team = await s.team();
    return { ...s, ...team, own: await s.service.createAction(team.owner, team.org.id, { title: 'Name an AI lead' }) };
  }

  it('an assignee made viewer or removed after the check is refused by the write itself, and holds nothing (D11, D15)', async () => {
    const r = await racing();
    const cases = [
      { key: A1, holder: r.member, change: () => r.service.setRole(r.owner, r.org.id, r.member.userId, 'viewer') },
      { key: r.own.key, holder: r.member, change: () => r.service.setRole(r.owner, r.org.id, r.member.userId, 'viewer') },
      { key: A1, holder: r.member, change: () => r.service.removeMember(r.owner, r.org.id, r.member.userId) },
      { key: r.own.key, holder: r.admin, change: () => r.service.removeMember(r.owner, r.org.id, r.admin.userId) },
    ];
    const appendAudit = vi.spyOn(r.repository, 'appendAudit');
    for (const { key, holder, change } of cases) {
      if (await roleOf(r, r.org.id, holder.userId) === 'viewer') await r.service.setRole(r.owner, r.org.id, holder.userId, 'member');
      appendAudit.mockClear();
      // The service's own check reads a role that can mark actions, and its answer is held until the change has landed.
      const hold = r.repository.holdNext('getMembership', ([, userId]) => userId === holder.userId);
      const assigning = r.service.updateAction(r.owner, r.org.id, key, { assigneeUserId: holder.userId })
        .then(() => null, (caught: unknown) => caught);
      await hold.reached;
      await change();
      hold.release();
      const error = await assigning;
      expect(error, key).toBeInstanceOf(WebappFailure);
      expect(error, key).toMatchObject({ code: 'invalid_request', status: 400, message: ASSIGNEE_REFUSED });
      expect((await r.service.listActions(r.owner, r.org.id)).items.find(item => item.key === key)?.assignee, key).toBeNull();
      expect(appendAudit.mock.calls.map(([record]) => record.action), key).not.toContain('action.updated');
    }
  });

  it('a change or a deletion of an action another request deleted meanwhile is a 404, and audits nothing', async () => {
    const r = await racing();
    const appendAudit = vi.spyOn(r.repository, 'appendAudit');
    const requests = [
      (key: string) => r.service.updateAction(r.member, r.org.id, key, { status: 'done' }),
      (key: string) => r.service.updateAction(r.admin, r.org.id, key, { dueDate: '2026-12-01' }),
      // A change that changes nothing answers with a fresh read, which finds nothing either.
      (key: string) => r.service.updateAction(r.member, r.org.id, key, { status: 'todo' }),
      (key: string) => r.service.deleteAction(r.admin, r.org.id, key),
    ];
    for (const [index, request] of requests.entries()) {
      const { key } = await r.service.createAction(r.owner, r.org.id, { title: `Doomed ${index}` });
      appendAudit.mockClear();
      const hold = r.repository.holdNext('getCustomAction', ([, id]) => key === `c.${id}`);
      const late = request(key).then(() => null, (caught: unknown) => caught);
      await hold.reached;
      await r.service.deleteAction(r.owner, r.org.id, key);
      hold.release();
      const error = await late;
      expect(error, `request ${index}`).toBeInstanceOf(WebappFailure);
      expect(error, `request ${index}`).toMatchObject({ code: 'not_found', status: 404, message: 'Action not found' });
      expect(appendAudit.mock.calls.map(([record]) => [record.action, record.actor_user_id]), `request ${index}`)
        .toEqual([['action.deleted', r.owner.userId]]);
    }
  });

  it('a change that changes nothing answers with the action as it is now, not as it was read', async () => {
    const r = await racing();
    const appendAudit = vi.spyOn(r.repository, 'appendAudit');
    const holds = [
      { key: A1, read: 'getAssessmentAction', matches: ([, scanId, actionKey]: string[]) => A1 === `a.${scanId}.${actionKey}` },
      { key: r.own.key, read: 'getCustomAction', matches: ([, id]: string[]) => r.own.key === `c.${id}` },
    ] as const;
    for (const { key, read, matches } of holds) {
      const hold = r.repository.holdNext(read, matches);
      const answer = r.service.updateAction(r.member, r.org.id, key, { status: 'todo' });
      await hold.reached;
      r.advance(HOUR);
      const dated = await r.service.updateAction(r.owner, r.org.id, key, { dueDate: '2026-12-01' });
      expect(dated, key).toMatchObject({ status: 'todo', dueDate: '2026-12-01', updatedAt: iso(r.now()) });
      hold.release();
      expect(await answer, key).toEqual(dated);
    }
    // Only the change that wrote is audited.
    expect(appendAudit.mock.calls.map(([record]) => [record.action, record.actor_user_id, record.target]))
      .toEqual([['action.updated', r.owner.userId, A1], ['action.updated', r.owner.userId, r.own.key]]);
  });
});

describe('activity', () => {
  it('owners and admins read it, unpaid too; members and viewers do not', async () => {
    const s = await scene();
    const { owner, org, admin, member, viewer } = await s.team();
    await s.service.applyBillingEvent(canceled(org.id));
    for (const reader of [owner, admin]) {
      expect(ActivityPage.parse(await s.service.activity(reader, org.id, { limit: 50 })).events[0])
        .toMatchObject({ action: 'billing.event_applied' });
    }
    for (const other of [member, viewer]) await expectFailure(s.service.activity(other, org.id, { limit: 50 }), 'forbidden', 403);
    await expectFailure(s.service.activity(await s.user('stranger@other.com'), org.id, { limit: 50 }), 'not_found', 404);
  });

  it('names a member by email, and ARCA staff and the system only by kind', async () => {
    const s = await scene();
    const { owner, org } = await s.ownedOrg();
    await s.pay(owner, org.id);
    const ops = await s.platformAdmin();
    const request = await s.service.requestDeletion(owner, org.id, 'Closing the firm');
    await s.service.reviewDeletion(ops, request.id, 'reject', 'Send a signed letter');
    // The staff profile exists, so its email had a way to leak.
    expect(await s.repository.getProfile(ops.userId)).toMatchObject({ email: 'ops@arca.example' });

    const page = ActivityPage.parse(await s.service.activity(owner, org.id, { limit: 50 }));
    expect(page.events.map(event => [event.action, event.actor])).toEqual([
      ['org.deletion_rejected', { kind: 'arca', email: null }],
      ['org.deletion_requested', { kind: 'member', email: OWNER }],
      ['billing.event_applied', { kind: 'system', email: null }],
      ['org.created', { kind: 'member', email: OWNER }],
    ]);
    const json = JSON.stringify(page);
    for (const hidden of ['ops@arca.example', ops.userId, 'Closing the firm', 'Send a signed letter', 'cus_mock', 'evt_mock', 'sub_mock']) {
      expect(json).not.toContain(hidden);
    }
    // A member who left keeps their email in the trail.
    const admin = await s.join(owner, org.id, 'admin');
    await s.service.renameOrganization(admin, org.id, 'Smith & Partners');
    await s.service.removeMember(owner, org.id, admin.userId);
    expect((await s.service.activity(owner, org.id, { limit: 50 })).events.find(event => event.action === 'org.renamed'))
      .toMatchObject({ actor: { kind: 'member', email: 'admin@firm.com' } });
    // ARCA's own audit does name its staff.
    expect((await s.service.adminAudit({ orgId: org.id, limit: 100 })).events.find(event => event.action === 'org.deletion_rejected'))
      .toMatchObject({ actorKind: 'platform', actorEmail: 'ops@arca.example' });
  });

  it('never shows what only ARCA staff or the system do as a member\'s, whatever kind the row stores', async () => {
    const s = await scene();
    const { owner, org } = await s.ownedOrg();
    const ops = await s.platformAdmin();
    await s.service.requirePlatformAdmin(ops);
    // Rows a store could hold with the wrong kind: written before actor_kind existed, or by a path that named the wrong one.
    const stored = [['org.deletion_rejected', ops.userId], ['org.deletion_approved', ops.userId], ['plan.updated', ops.userId],
      ['billing.event_applied', owner.userId]] as const;
    for (const [action, actor] of stored) {
      s.advance(1);
      await s.repository.appendAudit({ id: randomUUID(), actor_kind: 'member', actor_user_id: actor, org_id: org.id, action,
        target: null, data: {}, created_at: iso(s.now()) });
    }
    const page = ActivityPage.parse(await s.service.activity(owner, org.id, { limit: 50 }));
    expect(page.events.map(event => [event.action, event.actor])).toEqual([
      ['billing.event_applied', { kind: 'system', email: null }], ['plan.updated', { kind: 'arca', email: null }],
      ['org.deletion_approved', { kind: 'arca', email: null }], ['org.deletion_rejected', { kind: 'arca', email: null }],
      ['org.created', { kind: 'member', email: OWNER }]]);
    expect(JSON.stringify(page)).not.toContain('ops@arca.example');
    // ARCA's audit tells them apart the same way: staff by email, the system by kind alone.
    const audit = AdminAuditPage.parse(await s.service.adminAudit({ orgId: org.id, limit: 100 }));
    expect(audit.events.map(event => [event.action, event.actorKind, event.actorEmail])).toEqual([
      ['billing.event_applied', 'system', null], ['plan.updated', 'platform', 'ops@arca.example'],
      ['org.deletion_approved', 'platform', 'ops@arca.example'], ['org.deletion_rejected', 'platform', 'ops@arca.example'],
      ['org.created', 'member', OWNER]]);
  });

  it('looks an action up among the listed ones only, so one named like a property of every object stays a member\'s', async () => {
    const s = await scene();
    const { owner, org } = await s.ownedOrg();
    const names = ['constructor', 'toString', '__proto__', 'hasOwnProperty'];
    for (const action of names) {
      s.advance(1);
      await s.repository.appendAudit({ id: randomUUID(), actor_kind: 'member', actor_user_id: owner.userId, org_id: org.id, action,
        target: owner.userId, data: {}, created_at: iso(s.now()) });
    }
    const page = ActivityPage.parse(await s.service.activity(owner, org.id, { limit: 50 }));
    expect(page.events.map(event => [event.action, event.actor, event.targetLabel])).toEqual([
      ...[...names].reverse().map(action => [action, { kind: 'member', email: OWNER }, null]),
      ['org.created', { kind: 'member', email: OWNER }, 'Smith & Co']]);
    const audit = AdminAuditPage.parse(await s.service.adminAudit({ orgId: org.id, limit: 100 }));
    expect(audit.events.map(event => [event.action, event.actorKind, event.actorEmail, event.targetLabel])).toEqual([
      ...[...names].reverse().map(action => [action, 'member', OWNER, null]), ['org.created', 'member', OWNER, 'Smith & Co']]);
  });

  it('labels each target and shows only the allowed changes', async () => {
    const s = await scene();
    const { owner, org, admin, member, viewer } = await s.team();
    await s.service.attachAnalysis(owner, org.id, await s.claim('sc_2'));
    await s.service.setRole(admin, org.id, viewer.userId, 'member');
    await s.service.renameOrganization(owner, org.id, 'Smith & Partners');
    const own = await s.service.createAction(admin, org.id, { title: 'Name an AI lead', detail: 'Someone who owns the policy' });
    await s.service.updateAction(member, org.id, A1, { status: 'in_progress' });
    await s.service.updateAction(owner, org.id, A1, { dueDate: '2026-12-01' });
    await s.service.updateAction(owner, org.id, A1, { assigneeUserId: member.userId });
    await s.service.deleteAction(admin, org.id, own.key);
    await s.service.removeMember(owner, org.id, viewer.userId);

    const { events } = ActivityPage.parse(await s.service.activity(owner, org.id, { limit: 200 }));
    expect(events.map(({ action, targetLabel, change }) => ({ action, targetLabel, change })).reverse()).toEqual([
      { action: 'org.created', targetLabel: 'Smith & Partners', change: { from: null, to: 'Smith & Co' } },
      { action: 'billing.event_applied', targetLabel: null, change: null },
      ...['admin', 'member', 'viewer'].flatMap(role => [
        { action: 'member.invited', targetLabel: `${role}@firm.com`, change: { from: null, to: role } },
        { action: 'member.joined', targetLabel: `${role}@firm.com`, change: { from: null, to: role } }]),
      { action: 'analysis.claimed', targetLabel: 'firm.com', change: null },
      { action: 'member.role_changed', targetLabel: 'viewer@firm.com', change: { from: 'viewer', to: 'member' } },
      { action: 'org.renamed', targetLabel: 'Smith & Partners', change: { from: 'Smith & Co', to: 'Smith & Partners' } },
      { action: 'action.created', targetLabel: 'Name an AI lead', change: null },
      { action: 'action.updated', targetLabel: PLAN[0]!.title, change: { from: 'todo', to: 'in_progress' } },
      { action: 'action.updated', targetLabel: PLAN[0]!.title, change: { from: null, to: '2026-12-01' } },
      // Who holds an action is not one of the fields an event shows.
      { action: 'action.updated', targetLabel: PLAN[0]!.title, change: null },
      // A deleted action keeps the title it was audited with.
      { action: 'action.deleted', targetLabel: 'Name an AI lead', change: null },
      { action: 'member.removed', targetLabel: 'viewer@firm.com', change: { from: 'member', to: null } },
    ]);
    // The raw data stays in the log: no user id, no invitation id and no detail leaves.
    const json = JSON.stringify(events);
    for (const hidden of [member.userId, viewer.userId, 'Someone who owns the policy', 'invitationId']) expect(json).not.toContain(hidden);
  });

  it('pages newest first, with before and nextBefore', async () => {
    const s = await scene();
    const { owner, org } = await s.team();
    const all = (await s.service.activity(owner, org.id, { limit: 200 })).events;
    expect(all.map(event => event.action)).toEqual(['member.joined', 'member.invited', 'member.joined', 'member.invited', 'member.joined',
      'member.invited', 'billing.event_applied', 'org.created']);
    const first = await s.service.activity(owner, org.id, { limit: 3 });
    expect(first.events).toEqual(all.slice(0, 3));
    const second = await s.service.activity(owner, org.id, { limit: 3, before: first.nextBefore! });
    expect(second.events).toEqual(all.slice(3, 6));
    expect(await s.service.activity(owner, org.id, { limit: 3, before: second.nextBefore! })).toEqual({ events: all.slice(6), nextBefore: null });
    // A page that ends on the last event says so.
    expect((await s.service.activity(owner, org.id, { limit: 8 })).nextBefore).toBeNull();
    expect((await s.service.activity(owner, org.id, { limit: 7 })).nextBefore).toEqual(expect.any(Number));
  });
});

describe('renaming the organization', () => {
  it('owners and admins rename it without a payment, and the same name changes nothing', async () => {
    const s = await scene();
    const { owner, org, admin, member, viewer } = await s.team();
    await s.service.applyBillingEvent(canceled(org.id));
    for (const other of [member, viewer]) await expectFailure(s.service.renameOrganization(other, org.id, 'Mine now'), 'forbidden', 403);
    expect(OrgView.parse(await s.service.renameOrganization(admin, org.id, 'Smith & Partners'))).toEqual({ id: org.id, name: 'Smith & Partners',
      domain: 'firm.com', billingStatus: 'canceled', role: 'admin', deletionPending: false, paidAccess: false });
    expect(await s.service.orgView(owner, org.id)).toMatchObject({ name: 'Smith & Partners' });
    expect((await s.repository.listAudit(org.id, { limit: 1 }))[0]).toMatchObject({ action: 'org.renamed', actor_user_id: admin.userId,
      actor_kind: 'member', target: org.id, data: { from: 'Smith & Co', to: 'Smith & Partners' } });

    const appendAudit = vi.spyOn(s.repository, 'appendAudit');
    const write = vi.spyOn(s.repository, 'updateOrganizationName');
    expect(await s.service.renameOrganization(owner, org.id, 'Smith & Partners')).toMatchObject({ name: 'Smith & Partners', role: 'owner' });
    expect(appendAudit).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();

    await s.service.reviewDeletion(await s.platformAdmin(), (await s.service.requestDeletion(owner, org.id, 'Closing')).id, 'approve');
    await expectFailure(s.service.renameOrganization(owner, org.id, 'Too late'), 'gone', 410);
  });
});

describe('the platform admin panel', () => {
  it('keeps the profile of the staff member it lets in, and only theirs', async () => {
    const s = await scene();
    const ops = await s.platformAdmin();
    expect(await s.repository.getProfile(ops.userId)).toBeNull();
    await s.service.requirePlatformAdmin(ops);
    expect(await s.repository.getProfile(ops.userId)).toMatchObject({ email: 'ops@arca.example' });
    const owner = await s.user(OWNER);
    await expectFailure(s.service.requirePlatformAdmin(owner), 'forbidden', 403);
    expect(await s.repository.getProfile(owner.userId)).toBeNull();
  });

  it('shows one organization in detail, a deleted one too', async () => {
    const s = await scene();
    const { owner, org } = await s.team();
    await s.service.attachAnalysis(owner, org.id, await s.claim('sc_2'));
    const request = await s.service.requestDeletion(owner, org.id, 'Closing the firm');
    expect(AdminOrgDetailView.parse(await s.service.adminOrganization(org.id))).toEqual({ id: org.id, name: 'Smith & Co', domain: 'firm.com',
      billingStatus: 'active', deleted: false, createdAt: iso(T0), planCode: 'monthly', analysisCount: 2, pendingDeletion: request,
      members: (['owner', 'admin', 'member', 'viewer'] as const).map(role => ({ email: role === 'owner' ? OWNER : `${role}@firm.com`, role,
        joinedAt: iso(T0) })) });
    await s.service.reviewDeletion(await s.platformAdmin(), request.id, 'approve');
    expect(await s.service.adminOrganization(org.id)).toMatchObject({ deleted: true, pendingDeletion: null });

    const unpaid = await s.ownedOrg('sc_unpaid', { email: 'solo@else.com' });
    expect(await s.service.adminOrganization(unpaid.org.id)).toMatchObject({ billingStatus: 'pending_payment', planCode: null, analysisCount: 1,
      members: [{ email: 'solo@else.com', role: 'owner' }] });
    await expectFailure(s.service.adminOrganization(randomUUID()), 'not_found', 404);
    // An id is read the way Postgres reads a uuid, whatever its case.
    expect(await s.service.adminOrganization(unpaid.org.id.toUpperCase())).toMatchObject({ id: unpaid.org.id });
  });

  it('answers an organization id that is not a UUID without asking the store, whose column would refuse it', async () => {
    const s = await scene();
    const { org } = await s.ownedOrg();
    const getOrganization = vi.spyOn(s.repository, 'getOrganization');
    const listAllAudit = vi.spyOn(s.repository, 'listAllAudit');
    for (const id of ['org_missing', `${org.id}x`, '', 'null']) {
      await expectFailure(s.service.adminOrganization(id), 'not_found', 404);
      expect(await s.service.adminAudit({ orgId: id, limit: 100 })).toEqual({ events: [], nextBefore: null });
    }
    expect(getOrganization).not.toHaveBeenCalled();
    expect(listAllAudit).not.toHaveBeenCalled();
    expect((await s.service.adminAudit({ orgId: org.id.toUpperCase(), limit: 100 })).events.map(event => event.action)).toEqual(['org.created']);
  });

  it('pages the audit across organizations or of one', async () => {
    const s = await scene();
    const a = await s.ownedOrg('sc_a');
    const b = await s.ownedOrg('sc_b', { email: 'boss@b.com', assessment: 'COMPLETED' });
    await s.repository.updateOrganizationName(b.org.id, 'Boss LLP');
    await s.pay(a.owner, a.org.id);
    const ops = await s.platformAdmin();
    await s.service.updatePlan(ops, 'monthly', { amountCents: 1000 });

    const all = AdminAuditPage.parse(await s.service.adminAudit({ limit: 100 }));
    expect(all.events.map(event => [event.action, event.orgId, event.orgName, event.actorKind, event.actorEmail, event.targetLabel])).toEqual([
      ['plan.updated', null, null, 'platform', 'ops@arca.example', 'monthly'],
      ['billing.event_applied', a.org.id, 'Smith & Co', 'system', null, null],
      ['org.created', b.org.id, 'Boss LLP', 'member', 'boss@b.com', 'Boss LLP'],
      ['org.created', a.org.id, 'Smith & Co', 'member', OWNER, 'Smith & Co'],
    ]);
    expect(all.nextBefore).toBeNull();
    expect((await s.service.adminAudit({ orgId: b.org.id, limit: 100 })).events.map(event => event.action)).toEqual(['org.created']);
    expect(await s.service.adminAudit({ orgId: randomUUID(), limit: 100 })).toEqual({ events: [], nextBefore: null });
    const first = await s.service.adminAudit({ limit: 2 });
    expect(first.events).toEqual(all.events.slice(0, 2));
    expect(await s.service.adminAudit({ limit: 2, before: first.nextBefore! })).toEqual({ events: all.events.slice(2), nextBefore: null });
  });

  it('never gives a system row an email in ARCA\'s audit, even one that names a user', async () => {
    const s = await scene();
    const { owner, org } = await s.ownedOrg();
    await s.repository.appendAudit({ id: randomUUID(), actor_kind: 'system', actor_user_id: owner.userId, org_id: org.id,
      action: 'billing.event_applied', target: null, data: {}, created_at: iso(T0) });
    const page = AdminAuditPage.parse(await s.service.adminAudit({ orgId: org.id, limit: 100 }));
    expect(page.events.map(event => [event.action, event.actorKind, event.actorEmail])).toEqual([
      ['billing.event_applied', 'system', null], ['org.created', 'member', OWNER]]);
  });

  it('counts, never money, over the organizations that are not deleted and each one\'s current plan', async () => {
    const s = await scene();
    expect(AdminMetricsView.parse(await s.service.adminMetrics())).toEqual({ organizations: { pending_payment: 0, active: 0, past_due: 0,
      canceled: 0, deleted: 0 }, members: 0, analyses: 0, pendingDeletionRequests: 0, actions: { todo: 0, in_progress: 0, done: 0 } });

    const { owner, org, member } = await s.team();
    await s.service.updateAction(member, org.id, A1, { status: 'done' });
    await s.service.createAction(owner, org.id, { title: 'Name an AI lead' });
    const own = await s.service.createAction(owner, org.id, { title: 'Train the associates' });
    await s.service.updateAction(owner, org.id, own.key, { status: 'in_progress' });
    await s.service.requestDeletion(owner, org.id, 'Thinking about it');
    // Unpaid, its plan still counts: two untouched actions.
    await s.ownedOrg('sc_unpaid', { email: 'solo@else.com', assessment: 'COMPLETED' });
    // Deleted, it counts only as deleted.
    const gone = await s.ownedOrg('sc_gone', { email: 'gone@else.com', assessment: 'COMPLETED' });
    await s.pay(gone.owner, gone.org.id);
    await s.service.updateAction(gone.owner, gone.org.id, 'a.sc_gone.improve:D1.1', { status: 'done' });
    await s.service.reviewDeletion(await s.platformAdmin(), (await s.service.requestDeletion(gone.owner, gone.org.id, 'Closing')).id, 'approve');

    expect(AdminMetricsView.parse(await s.service.adminMetrics())).toEqual({
      organizations: { pending_payment: 1, active: 1, past_due: 0, canceled: 0, deleted: 1 },
      members: 5, analyses: 2, pendingDeletionRequests: 1, actions: { todo: 4, in_progress: 1, done: 1 } });
  });
});

// Every id the store keeps in a uuid column (DN-11 §5): a column like that refuses anything else with an error, not a miss.
describe('ids of the store', () => {
  it('an id that is not a UUID gets the answer of an unknown one, and the store is never asked about it', async () => {
    const s = await scene();
    const { owner, org, member } = await s.team();
    const ops = await s.platformAdmin();
    const spies = (['getMembership', 'getOrganization', 'listInvitations', 'getDeletionRequest'] as const)
      .map(method => vi.spyOn(s.repository, method));
    const notUuids = ['org_missing', `${org.id}x`, '', 'null'];
    for (const id of notUuids) {
      await expectFailure(s.service.authorize(owner, id, 'org.read', { payment: false }), 'not_found', 404);
      await expectFailure(s.service.listActions(owner, id), 'not_found', 404);
      await expectFailure(s.service.activity(owner, id, { limit: 50 }), 'not_found', 404);
      await expectFailure(s.service.setRole(owner, org.id, id, 'viewer'), 'not_found', 404);
      await expectFailure(s.service.removeMember(owner, org.id, id), 'not_found', 404);
      await expectFailure(s.service.revokeInvitation(owner, org.id, id), 'not_found', 404);
      await expectFailure(s.service.reviewDeletion(ops, id, 'approve'), 'not_found', 404);
      expect(await s.service.applyBillingEvent({ ...canceled(org.id, `evt_${id}`), orgId: id })).toBe('unknown_org');
    }
    // Asked about the organization, its members and the platform admin, but never about one of these ids.
    for (const spy of spies) for (const args of spy.mock.calls) for (const arg of args) expect(notUuids).not.toContain(arg);
    const [, , listInvitations, getDeletionRequest] = spies;
    expect(listInvitations).not.toHaveBeenCalled();
    expect(getDeletionRequest).not.toHaveBeenCalled();
    // The answers that come before the lookup still come first.
    await expectFailure(s.service.setRole(member, org.id, 'user_missing', 'viewer'), 'forbidden', 403);
    await expectFailure(s.service.revokeInvitation(member, org.id, 'inv_missing'), 'forbidden', 403);
    await expectFailure(s.service.reviewDeletion(owner, 'dr_missing', 'approve'), 'forbidden', 403);
    expect(await s.repository.getOrganization(org.id)).toMatchObject({ billing_status: 'active', deleted_at: null });
  });

  it('an id is read in any case, as Postgres reads a uuid, and the stored one is what is written', async () => {
    const s = await scene();
    const { owner, org, member } = await s.team();
    const ORG = org.id.toUpperCase();
    expect(ORG).not.toBe(org.id);
    expect(await s.service.orgView(owner, ORG)).toEqual(await s.service.orgView(owner, org.id));
    expect(await s.service.listActions(owner, ORG)).toEqual(await s.service.listActions(owner, org.id));
    expect(await s.service.setRole(owner, ORG, member.userId.toUpperCase(), 'viewer')).toMatchObject({ userId: member.userId, role: 'viewer' });
    const own = await s.service.createAction(owner, ORG, { title: 'Name an AI lead' });
    expect(await s.repository.getCustomAction(org.id, own.key.slice(2))).toMatchObject({ org_id: org.id });
    const invitation = await s.service.invite(owner, ORG, { email: 'late@firm.com', role: 'viewer' });
    await s.service.revokeInvitation(owner, ORG, invitation.id.toUpperCase());
    expect(await s.repository.listInvitations(org.id)).toEqual([]);
    const portal = vi.spyOn(s.billing, 'createPortal');
    await s.service.portal(owner, ORG);
    expect(portal).toHaveBeenCalledWith({ orgId: org.id, returnUrl: `${APP}/app/billing` });
    const request = await s.service.requestDeletion(owner, ORG, 'Closing the firm');
    expect(request.orgId).toBe(org.id);
    expect(await s.service.reviewDeletion(await s.platformAdmin(), request.id.toUpperCase(), 'reject')).toMatchObject({ id: request.id,
      status: 'rejected' });
    expect(await s.service.applyBillingEvent(canceled(ORG))).toBe('applied');
    expect(await s.repository.getOrganization(org.id)).toMatchObject({ billing_status: 'canceled' });
    // Every row written names the stored ids.
    const rows = await s.repository.listAllAudit({ limit: 500 });
    expect(rows.filter(row => row.org_id !== null && row.org_id !== org.id)).toEqual([]);
    expect(rows.filter(row => ['member.role_changed', 'org.deletion_rejected', 'invitation.revoked'].includes(row.action))
      .map(row => [row.action, row.target, row.data.invitationId])).toEqual([['org.deletion_rejected', request.id, undefined],
      ['invitation.revoked', 'late@firm.com', invitation.id], ['member.role_changed', member.userId, undefined]]);
  });
});

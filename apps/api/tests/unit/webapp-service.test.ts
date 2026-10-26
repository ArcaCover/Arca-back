import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { AnalysisView, AssessmentResult, ClaimResponse, DeletionRequestView, InvitationView, MeResponse, MemberView, OrgView, PlanView,
  type Role } from '@arca/contracts';
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
import { fixtureResult } from '../fixtures/result.js';

const secret = 'webapp-service-test-secret-'.repeat(2);
const APP = 'http://localhost:3000';
const T0 = Date.parse('2026-10-25T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const OWNER = 'owner@firm.com';
const iso = (ms: number) => new Date(ms).toISOString();
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

function assessmentResult(scanId: string) {
  const domain = (key: string) => ({ key, label: key, weight: 1, score: 70, status: 'KNOWN' });
  return AssessmentResult.parse({ assessmentId: `as_${scanId}`, scanId, bankVersion: DEMO_BANK.bankVersion, bankStatus: 'DEMO',
    scoringVersion: 'v1', commercialDecisionBlocked: true, layer1Score: 82, layer2Score: 70, compositeScore: 75, tier: 'GUARDED',
    decision: 'REFERRAL', domains: ['governance', 'tools', 'oversight', 'data_protection', 'training', 'incident_preparedness'].map(domain),
    flags: [], actionPlan: [], completedAt: iso(T0) });
}
function assessmentRecord(scanId: string, status: 'COMPLETED' | 'IN_PROGRESS'): AssessmentRecord {
  return { id: `as_${scanId}`, scan_id: scanId, revision: 0, status, bank_version: DEMO_BANK.bankVersion, bank_snapshot: DEMO_BANK,
    layer1_snapshot: fixtureResult(scanId, OWNER), evidence_snapshot: [], planner: 'rules', planner_model: null, prompt_version: null,
    plan: null, rendered: [], answers: {}, result: status === 'COMPLETED' ? assessmentResult(scanId) : null,
    attested_at: status === 'COMPLETED' ? iso(T0) : null, created_at: iso(T0), updated_at: iso(T0), expires_at: iso(T0 + DAY),
    completed_at: status === 'COMPLETED' ? iso(T0) : null, answer_write_count: 0 };
}

async function expectFailure(promise: Promise<unknown>, code: WebappFailure['code'], status: WebappFailure['status']) {
  const error = await promise.then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(WebappFailure);
  expect(error).toMatchObject({ code, status });
}

type ScanOptions = { email?: string; status?: ScanRecord['status']; assessment?: 'COMPLETED' | 'IN_PROGRESS'; injected?: boolean };

async function scene() {
  let clock = T0;
  const scans = new InMemoryRepository();
  const assessments = new InMemoryAssessmentRepository();
  const repository = new InMemoryWebappRepository(DEFAULT_PLANS);
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
    if (options.assessment) await assessments.create(assessmentRecord(scanId, options.assessment));
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
const roleOf = async (s: Awaited<ReturnType<typeof scene>>, orgId: string, userId: string) =>
  (await s.repository.getMembership(orgId, userId))?.role ?? null;

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
    await expectFailure(s.service.authorize(owner, 'org_missing', 'org.read', { payment: false }), 'not_found', 404);
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
    await expectFailure(s.service.setRole(admin, org.id, 'user_missing', 'member'), 'not_found', 404);
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

    const stray = { ...event, id: 'evt_stray', orgId: 'org_missing' };
    expect(await s.service.applyBillingEvent(stray)).toBe('unknown_org');
    expect(await s.repository.getSubscription('org_missing')).toBeNull();
    expect(await s.repository.getOrganization('org_missing')).toBeNull();
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
    await expectFailure(s.service.checkout(owner, org.id, 'weekly'), 'invalid_request', 400);
    await s.service.updatePlan(await s.platformAdmin(), 'annual', { active: false });
    await expectFailure(s.service.checkout(owner, org.id, 'annual'), 'invalid_request', 400);
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
    await expectFailure(s.service.reviewDeletion(ops, 'dr_missing', 'approve'), 'not_found', 404);

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

    const log = appendAudit.mock.calls.map(([record]) => [record.action, record.actor_user_id, record.org_id]);
    expect(log).toEqual([
      ['org.created', owner.userId, org.id],
      ['billing.event_applied', null, org.id],
      ...[admin, member, viewer].flatMap(joined => [['member.invited', owner.userId, org.id], ['member.joined', joined.userId, org.id]]),
      ['analysis.claimed', owner.userId, org.id],
      ['member.role_changed', admin.userId, org.id],
      ['member.removed', admin.userId, org.id],
      ['member.invited', owner.userId, org.id],
      ['invitation.revoked', owner.userId, org.id],
      ['org.deletion_requested', owner.userId, org.id],
      ['org.deletion_rejected', ops.userId, org.id],
      ['plan.updated', ops.userId, null],
    ]);
    expect(appendAudit.mock.calls.find(([record]) => record.action === 'member.role_changed')![0])
      .toMatchObject({ target: viewer.userId, data: { from: 'viewer', to: 'member' } });
    expect(await s.repository.listAudit(org.id)).toHaveLength(log.length - 1);
  });
});

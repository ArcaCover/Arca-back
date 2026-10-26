import { describe, expect, it } from 'vitest';
import {
  AdminOrgView, AnalysisView, AttachAnalysisRequest, BILLING_STATUSES, CheckoutRequest, ClaimResponse, CreateClaimRequest,
  CreateOrgRequest, DeletionRequestBody, DeletionRequestView, InvitationView, InviteRequest, MeResponse, MemberView,
  OrgView, PERMISSIONS, PlanView, ROLES, ROLE_PERMISSIONS, ReviewRequest, SetRoleRequest, UpdatePlanRequest, UrlResponse,
  can, canManageMember, hasPaidAccess,
  type BillingStatus, type Permission, type Role,
} from '@arca/contracts';
import { fixtureResult } from './fixture.js';

// DN-10 §4.3, written out literally so a change to the matrix has to change this table too.
const EXPECTED: Record<Permission, Record<Role, boolean>> = {
  'org.read':               { owner: true,  admin: true,  member: true,  viewer: true },
  'analysis.create':        { owner: true,  admin: true,  member: true,  viewer: false },
  'members.invite':         { owner: true,  admin: true,  member: false, viewer: false },
  'members.remove':         { owner: true,  admin: true,  member: false, viewer: false },
  'members.set_role':       { owner: true,  admin: true,  member: false, viewer: false },
  'billing.manage':         { owner: true,  admin: false, member: false, viewer: false },
  'org.transfer_ownership': { owner: true,  admin: false, member: false, viewer: false },
  'org.request_deletion':   { owner: true,  admin: false, member: false, viewer: false },
};
const CELLS = ROLES.flatMap(role => PERMISSIONS.map(permission => [role, permission, EXPECTED[permission][role]] as const));

describe('the permission matrix', () => {
  it('has the four roles and the eight permissions, in order', () => {
    expect(ROLES).toEqual(['owner', 'admin', 'member', 'viewer']);
    expect(PERMISSIONS).toEqual([
      'org.read', 'analysis.create', 'members.invite', 'members.remove', 'members.set_role',
      'billing.manage', 'org.transfer_ownership', 'org.request_deletion',
    ]);
  });

  it('covers every role x permission combination', () => {
    expect(CELLS).toHaveLength(32);
  });

  it.each(CELLS)('the matrix is exactly DN-10 §4.3: %s / %s -> %s', (role, permission, allowed) => {
    expect(can(role, permission)).toBe(allowed);
    expect(ROLE_PERMISSIONS[role].includes(permission)).toBe(allowed);
  });

  it('lists no permission twice for a role', () => {
    for (const role of ROLES) expect(new Set(ROLE_PERMISSIONS[role]).size).toBe(ROLE_PERMISSIONS[role].length);
  });
});

describe('canManageMember', () => {
  it('admins cannot touch owners or grant ownership', () => {
    expect(canManageMember('admin', 'owner')).toBe(false);
    expect(canManageMember('admin', 'member', 'owner')).toBe(false);
    expect(canManageMember('member', 'viewer', 'viewer')).toBe(false);
    expect(canManageMember('viewer', 'viewer')).toBe(false);
    expect(canManageMember('owner', 'owner', 'member')).toBe(true);
    expect(canManageMember('admin', 'member', 'viewer')).toBe(true);
  });

  it('lets an owner do anything, including granting ownership', () => {
    for (const target of ROLES) {
      expect(canManageMember('owner', target)).toBe(true);
      for (const next of ROLES) expect(canManageMember('owner', target, next)).toBe(true);
    }
  });

  it('lets an admin manage non-owners without a role change', () => {
    expect(canManageMember('admin', 'admin')).toBe(true);
    expect(canManageMember('admin', 'viewer')).toBe(true);
    expect(canManageMember('admin', 'admin', 'viewer')).toBe(true);
  });

  it('never lets a member or a viewer manage anyone', () => {
    for (const actor of ['member', 'viewer'] as const) {
      for (const target of ROLES) {
        expect(canManageMember(actor, target)).toBe(false);
        for (const next of ROLES) expect(canManageMember(actor, target, next)).toBe(false);
      }
    }
  });
});

describe('billing status', () => {
  it('has the four statuses', () => {
    expect(BILLING_STATUSES).toEqual(['pending_payment', 'active', 'past_due', 'canceled']);
  });

  it('paid access is true only for active and past_due', () => {
    const expected: Record<BillingStatus, boolean> = { pending_payment: false, active: true, past_due: true, canceled: false };
    for (const status of BILLING_STATUSES) expect(hasPaidAccess(status)).toBe(expected[status]);
  });
});

const domain = (key: string) => ({ key, label: key, weight: 1, score: 70, status: 'KNOWN' });
const assessment = {
  assessmentId: 'as_1', scanId: 'sc_fixture', bankVersion: 'demo-1', bankStatus: 'DEMO', scoringVersion: 'v1',
  commercialDecisionBlocked: true, layer1Score: 82, layer2Score: 70, compositeScore: 75, tier: 'GUARDED', decision: 'REFERRAL',
  domains: ['governance', 'tools', 'oversight', 'data_protection', 'training', 'incident_preparedness'].map(domain),
  flags: [], actionPlan: [], completedAt: '2026-10-25T10:00:00.000Z',
};

const orgView = {
  id: 'org-1', name: 'Smith & Co', domain: 'smithlaw.com', billingStatus: 'active', role: 'owner', deletionPending: false, paidAccess: true,
};

describe('schemas', () => {
  it('schemas are strict', () => {
    expect(OrgView.safeParse(orgView).success).toBe(true);
    expect(OrgView.safeParse({ ...orgView, extra: 1 }).success).toBe(false);
    expect(PlanView.safeParse({ code: 'monthly', name: 'Monthly', amountCents: 49900, currency: 'usd', interval: 'month', extra: 1 }).success).toBe(false);
    expect(UrlResponse.safeParse({ url: 'https://x.test', extra: 1 }).success).toBe(false);
  });

  it('OrgView accepts a null domain and rejects an unknown role or status', () => {
    expect(OrgView.safeParse({ ...orgView, domain: null }).success).toBe(true);
    expect(OrgView.safeParse({ ...orgView, role: 'root' }).success).toBe(false);
    expect(OrgView.safeParse({ ...orgView, billingStatus: 'trialing' }).success).toBe(false);
  });

  it('PlanView checks the amount, the currency and the interval', () => {
    const plan = { code: 'monthly', name: 'Monthly (example price)', amountCents: 49900, currency: 'usd', interval: 'month' };
    expect(PlanView.safeParse(plan).success).toBe(true);
    expect(PlanView.safeParse({ ...plan, amountCents: -1 }).success).toBe(false);
    expect(PlanView.safeParse({ ...plan, amountCents: 1.5 }).success).toBe(false);
    expect(PlanView.safeParse({ ...plan, currency: 'USD' }).success).toBe(false);
    expect(PlanView.safeParse({ ...plan, currency: 'us' }).success).toBe(false);
    expect(PlanView.safeParse({ ...plan, interval: 'week' }).success).toBe(false);
    expect(PlanView.safeParse({ ...plan, interval: 'year' }).success).toBe(true);
  });

  it('MeResponse carries the user, their organizations and the platform flag', () => {
    const me = { user: { id: 'u1', email: 'a@b.co' }, organizations: [orgView], platformAdmin: false };
    expect(MeResponse.safeParse(me).success).toBe(true);
    expect(MeResponse.safeParse({ ...me, organizations: [] }).success).toBe(true);
    expect(MeResponse.safeParse({ ...me, user: { id: 'u1', email: 'a@b.co', extra: 1 } }).success).toBe(false);
    expect(MeResponse.safeParse({ user: me.user, organizations: me.organizations }).success).toBe(false);
  });

  it('MemberView and InvitationView parse', () => {
    expect(MemberView.safeParse({ userId: 'u1', email: 'a@b.co', role: 'viewer', joinedAt: '2026-10-25T10:00:00.000Z' }).success).toBe(true);
    expect(MemberView.safeParse({ userId: 'u1', email: 'a@b.co', role: 'viewer', joinedAt: 'yesterday' }).success).toBe(false);
    const invitation = { id: 'i1', email: 'a@b.co', role: 'member', expiresAt: '2026-11-01T10:00:00.000Z' };
    expect(InvitationView.safeParse(invitation).success).toBe(true);
    expect(InvitationView.safeParse({ ...invitation, inviteUrl: 'http://localhost:3000/app/invite/abc' }).success).toBe(true);
    expect(InvitationView.safeParse({ ...invitation, role: 'owner' }).success).toBe(false);
  });

  it('AnalysisView wraps a layer 1 result and an optional assessment', () => {
    const analysis = {
      scanId: 'sc_fixture', domain: 'smithlaw.com', scanStatus: 'COMPLETED', claimedAt: '2026-10-25T10:00:00.000Z',
      layer1: fixtureResult(), assessment: null,
    };
    expect(AnalysisView.safeParse(analysis).success).toBe(true);
    expect(AnalysisView.safeParse({ ...analysis, scanStatus: 'PARTIAL' }).success).toBe(true);
    expect(AnalysisView.safeParse({ ...analysis, assessment }).success).toBe(true);
    expect(AnalysisView.safeParse({ ...analysis, scanStatus: 'FAILED' }).success).toBe(false);
    expect(AnalysisView.safeParse({ ...analysis, layer1: {} }).success).toBe(false);
    expect(AnalysisView.safeParse({ ...analysis, extra: 1 }).success).toBe(false);
    const { assessment: _omitted, ...withoutAssessment } = analysis;
    expect(AnalysisView.safeParse(withoutAssessment).success).toBe(false);
  });

  it('ClaimResponse, UrlResponse, DeletionRequestView and AdminOrgView parse', () => {
    expect(ClaimResponse.safeParse({ claimId: 'c1', email: 'a@b.co', expiresAt: '2026-10-25T10:30:00.000Z' }).success).toBe(true);
    expect(UrlResponse.safeParse({ url: 'http://localhost:3000/app/billing/mock-success' }).success).toBe(true);
    const deletion = {
      id: 'd1', orgId: 'org-1', reason: 'We closed the firm', status: 'pending', requestedAt: '2026-10-25T10:00:00.000Z',
      reviewedAt: null, reviewNote: null,
    };
    expect(DeletionRequestView.safeParse(deletion).success).toBe(true);
    expect(DeletionRequestView.safeParse({ ...deletion, status: 'deleted' }).success).toBe(false);
    expect(DeletionRequestView.safeParse({ ...deletion, status: 'approved', reviewedAt: '2026-10-26T10:00:00.000Z', reviewNote: 'ok' }).success).toBe(true);
    const adminOrg = { id: 'org-1', name: 'Smith & Co', billingStatus: 'pending_payment', deleted: false, members: 2 };
    expect(AdminOrgView.safeParse(adminOrg).success).toBe(true);
    expect(AdminOrgView.safeParse({ ...adminOrg, members: 1.5 }).success).toBe(false);
  });
});

describe('request bodies', () => {
  it('invitations cannot grant ownership', () => {
    expect(InviteRequest.safeParse({ email: 'a@b.co', role: 'owner' }).success).toBe(false);
    for (const role of ['admin', 'member', 'viewer']) expect(InviteRequest.safeParse({ email: 'a@b.co', role }).success).toBe(true);
    expect(InviteRequest.safeParse({ email: 'not-an-email', role: 'member' }).success).toBe(false);
    expect(InviteRequest.safeParse({ email: 'a@b.co', role: 'member', extra: 1 }).success).toBe(false);
  });

  it('normalizes the invited email so it matches the login email later', () => {
    expect(InviteRequest.parse({ email: '  Jane@Smith-Law.COM ', role: 'member' }).email).toBe('jane@smith-law.com');
  });

  it('SetRoleRequest accepts any of the four roles', () => {
    for (const role of ROLES) expect(SetRoleRequest.safeParse({ role }).success).toBe(true);
    expect(SetRoleRequest.safeParse({ role: 'root' }).success).toBe(false);
  });

  it('CreateClaimRequest needs a non-empty scan token', () => {
    expect(CreateClaimRequest.safeParse({ scanToken: 'abc' }).success).toBe(true);
    expect(CreateClaimRequest.safeParse({ scanToken: '' }).success).toBe(false);
    expect(CreateClaimRequest.safeParse({}).success).toBe(false);
  });

  it('CreateOrgRequest bounds the name to 1..120 characters', () => {
    expect(CreateOrgRequest.safeParse({ name: 'A', claimId: 'c1' }).success).toBe(true);
    expect(CreateOrgRequest.safeParse({ name: 'x'.repeat(120), claimId: 'c1' }).success).toBe(true);
    expect(CreateOrgRequest.safeParse({ name: '', claimId: 'c1' }).success).toBe(false);
    expect(CreateOrgRequest.safeParse({ name: 'x'.repeat(121), claimId: 'c1' }).success).toBe(false);
    expect(CreateOrgRequest.safeParse({ name: '   ', claimId: 'c1' }).success).toBe(false);
    expect(CreateOrgRequest.safeParse({ name: 'Firm' }).success).toBe(false);
  });

  it('AttachAnalysisRequest, CheckoutRequest need their one field', () => {
    expect(AttachAnalysisRequest.safeParse({ claimId: 'c1' }).success).toBe(true);
    expect(AttachAnalysisRequest.safeParse({}).success).toBe(false);
    expect(CheckoutRequest.safeParse({ planCode: 'monthly' }).success).toBe(true);
    expect(CheckoutRequest.safeParse({}).success).toBe(false);
  });

  it('DeletionRequestBody bounds the reason to 1..2000 characters', () => {
    expect(DeletionRequestBody.safeParse({ reason: 'Closing the firm' }).success).toBe(true);
    expect(DeletionRequestBody.safeParse({ reason: '' }).success).toBe(false);
    expect(DeletionRequestBody.safeParse({ reason: 'x'.repeat(2001) }).success).toBe(false);
    expect(DeletionRequestBody.safeParse({ reason: 'x'.repeat(2000) }).success).toBe(true);
    expect(DeletionRequestBody.safeParse({ reason: ' \t ' }).success).toBe(false);
  });

  it('ReviewRequest takes an optional note of at most 2000 characters', () => {
    expect(ReviewRequest.safeParse({}).success).toBe(true);
    expect(ReviewRequest.safeParse({ note: 'ok' }).success).toBe(true);
    expect(ReviewRequest.safeParse({ note: 'x'.repeat(2001) }).success).toBe(false);
  });

  it('UpdatePlanRequest needs a change', () => {
    expect(UpdatePlanRequest.safeParse({}).success).toBe(false);
    expect(UpdatePlanRequest.safeParse({ amountCents: 59900 }).success).toBe(true);
    expect(UpdatePlanRequest.safeParse({ active: false }).success).toBe(true);
    expect(UpdatePlanRequest.safeParse({ name: 'Monthly', currency: 'eur', interval: 'year' }).success).toBe(true);
    expect(UpdatePlanRequest.safeParse({ amountCents: -5 }).success).toBe(false);
    expect(UpdatePlanRequest.safeParse({ currency: 'EUR' }).success).toBe(false);
    expect(UpdatePlanRequest.safeParse({ interval: 'week' }).success).toBe(false);
    expect(UpdatePlanRequest.safeParse({ code: 'other' }).success).toBe(false);
    expect(UpdatePlanRequest.safeParse({ name: undefined }).success).toBe(false);
  });
});

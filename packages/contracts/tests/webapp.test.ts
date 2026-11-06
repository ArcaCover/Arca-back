import { describe, expect, it } from 'vitest';
import {
  ACTION_STATUSES, AUDIT_ACTOR_KINDS, ActionItemView, ActionPlanResponse, ActivityActor, ActivityEventView, ActivityPage,
  AdminAuditEventView, AdminAuditPage, AdminMetricsView, AdminOrgDetailView, AdminOrgView, AnalysisView, AttachAnalysisRequest, BILLING_STATUSES,
  CheckoutRequest, ClaimResponse, CreateActionRequest, CreateClaimRequest, CreateOrgRequest, DeletionRequestBody, DeletionRequestView,
  InvitationView, InviteRequest, MeResponse, MemberView, OrgView, PERMISSIONS, PlanView, ROLES, ROLE_PERMISSIONS, ReviewRequest,
  SetRoleRequest, UpdateActionRequest, UpdateOrgRequest, UpdatePlanRequest, UrlResponse,
  can, canManageMember, hasPaidAccess,
  type BillingStatus, type Permission, type Role,
} from '@arca/contracts';
import { fixtureResult } from './fixture.js';

// DN-11 §4.1, written out literally so a change to the matrix has to change this table too.
const EXPECTED: Record<Permission, Record<Role, boolean>> = {
  'org.read':               { owner: true,  admin: true,  member: true,  viewer: true },
  'org.update':             { owner: true,  admin: true,  member: false, viewer: false },
  'analysis.create':        { owner: true,  admin: true,  member: false, viewer: false },
  'actions.update':         { owner: true,  admin: true,  member: true,  viewer: false },
  'actions.assign':         { owner: true,  admin: true,  member: false, viewer: false },
  'activity.read':          { owner: true,  admin: true,  member: false, viewer: false },
  'members.invite':         { owner: true,  admin: true,  member: false, viewer: false },
  'members.remove':         { owner: true,  admin: true,  member: false, viewer: false },
  'members.set_role':       { owner: true,  admin: true,  member: false, viewer: false },
  'billing.manage':         { owner: true,  admin: false, member: false, viewer: false },
  'org.transfer_ownership': { owner: true,  admin: false, member: false, viewer: false },
  'org.request_deletion':   { owner: true,  admin: false, member: false, viewer: false },
};
const CELLS = ROLES.flatMap(role => PERMISSIONS.map(permission => [role, permission, EXPECTED[permission][role]] as const));

describe('the permission matrix', () => {
  it('has the four roles and the twelve permissions, in order', () => {
    expect(ROLES).toEqual(['owner', 'admin', 'member', 'viewer']);
    expect(PERMISSIONS).toEqual([
      'org.read', 'org.update', 'analysis.create', 'actions.update', 'actions.assign', 'activity.read',
      'members.invite', 'members.remove', 'members.set_role',
      'billing.manage', 'org.transfer_ownership', 'org.request_deletion',
    ]);
  });

  it('covers every role x permission combination', () => {
    expect(Object.keys(EXPECTED)).toHaveLength(PERMISSIONS.length);
    expect(CELLS).toHaveLength(48);
  });

  it.each(CELLS)('the matrix is exactly DN-11 §4.1: %s / %s -> %s', (role, permission, allowed) => {
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

// What the mock login issues for member@firm.com (RFC 9562 version 8), and a version 4 id like the ones Supabase Auth issues.
const MOCK_USER_ID = '2c294f0a-7fef-8432-994d-eb217db83c68';
const SUPABASE_USER_ID = '7d3f5b9e-1c2a-4e8f-9b6d-0a1b2c3d4e5f';

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

  it('UpdateOrgRequest follows the name rule of CreateOrgRequest', () => {
    for (const name of ['A', 'x'.repeat(120), '', 'x'.repeat(121), '   ', `  ${'x'.repeat(120)}  `, 'Smith & Co']) {
      expect(UpdateOrgRequest.safeParse({ name }).success, JSON.stringify(name))
        .toBe(CreateOrgRequest.safeParse({ name, claimId: 'c1' }).success);
    }
    expect(UpdateOrgRequest.parse({ name: '  Smith & Co ' })).toEqual({ name: 'Smith & Co' });
    expect(UpdateOrgRequest.safeParse({}).success).toBe(false);
    expect(UpdateOrgRequest.safeParse({ name: 'Firm', claimId: 'c1' }).success).toBe(false);
  });

  it('UpdateActionRequest needs at least one field that is not undefined', () => {
    expect(UpdateActionRequest.safeParse({}).success).toBe(false);
    expect(UpdateActionRequest.safeParse({ status: undefined, dueDate: undefined }).success).toBe(false);
    for (const status of ACTION_STATUSES) expect(UpdateActionRequest.safeParse({ status }).success).toBe(true);
    expect(UpdateActionRequest.safeParse({ assigneeUserId: MOCK_USER_ID }).success).toBe(true);
    expect(UpdateActionRequest.safeParse({ status: 'done', assigneeUserId: MOCK_USER_ID, dueDate: '2026-12-01' }).success).toBe(true);
  });

  it('UpdateActionRequest takes an assignee by UUID: version 4 from Supabase, version 8 from the mock login', () => {
    for (const assigneeUserId of [MOCK_USER_ID, SUPABASE_USER_ID]) {
      expect(UpdateActionRequest.parse({ assigneeUserId }), assigneeUserId).toEqual({ assigneeUserId });
    }
    // Written the way Postgres prints a uuid, so the same user always compares equal.
    expect(UpdateActionRequest.parse({ assigneeUserId: SUPABASE_USER_ID.toUpperCase() })).toEqual({ assigneeUserId: SUPABASE_USER_ID });
    for (const assigneeUserId of ['u1', 'user_missing', 'member@firm.com', `c.${SUPABASE_USER_ID}`, `{${SUPABASE_USER_ID}}`,
      ` ${SUPABASE_USER_ID}`, SUPABASE_USER_ID.slice(0, -1), SUPABASE_USER_ID.replaceAll('-', '')]) {
      expect(UpdateActionRequest.safeParse({ assigneeUserId }).success, assigneeUserId).toBe(false);
    }
  });

  it('UpdateActionRequest takes null as "clear" for the assignee and the due date, and keeps it apart from a missing field', () => {
    expect(UpdateActionRequest.parse({ assigneeUserId: null })).toEqual({ assigneeUserId: null });
    expect(UpdateActionRequest.parse({ dueDate: null })).toEqual({ dueDate: null });
    // The service picks the permission by the fields present, so a field that was not sent must stay absent.
    const statusOnly = UpdateActionRequest.parse({ status: 'in_progress' });
    expect(Object.keys(statusOnly)).toEqual(['status']);
    expect(UpdateActionRequest.safeParse({ status: null }).success).toBe(false);
  });

  it('UpdateActionRequest checks each field', () => {
    expect(UpdateActionRequest.safeParse({ status: 'blocked' }).success).toBe(false);
    expect(UpdateActionRequest.safeParse({ assigneeUserId: '' }).success).toBe(false);
    expect(UpdateActionRequest.safeParse({ assigneeUserId: 7 }).success).toBe(false);
    expect(UpdateActionRequest.safeParse({ title: 'Renamed' }).success).toBe(false);
    expect(UpdateActionRequest.safeParse({ status: 'done', key: 'a.sc_1.improve:D1.1' }).success).toBe(false);
  });

  it('a due date is a calendar date written YYYY-MM-DD', () => {
    for (const dueDate of ['2026-12-01', '2028-02-29']) expect(UpdateActionRequest.safeParse({ dueDate }).success, dueDate).toBe(true);
    for (const dueDate of ['2026-12-1', '2026-02-29', '2026-13-01', '2026-12-01T00:00:00.000Z', '12/01/2026', '', ' 2026-12-01']) {
      expect(UpdateActionRequest.safeParse({ dueDate }).success, dueDate).toBe(false);
    }
  });

  it('CreateActionRequest trims the title and bounds it to 1..200 characters', () => {
    expect(CreateActionRequest.parse({ title: '  Write an AI use policy ' })).toEqual({ title: 'Write an AI use policy' });
    expect(CreateActionRequest.safeParse({ title: 'x'.repeat(200) }).success).toBe(true);
    expect(CreateActionRequest.safeParse({ title: `  ${'x'.repeat(200)}  ` }).success).toBe(true);
    expect(CreateActionRequest.safeParse({ title: 'x'.repeat(201) }).success).toBe(false);
    expect(CreateActionRequest.safeParse({ title: '' }).success).toBe(false);
    expect(CreateActionRequest.safeParse({ title: ' \t ' }).success).toBe(false);
    expect(CreateActionRequest.safeParse({}).success).toBe(false);
  });

  it('CreateActionRequest takes an optional detail of at most 2000 characters and an optional domain', () => {
    const title = 'Review vendor terms';
    expect(CreateActionRequest.safeParse({ title, detail: 'x'.repeat(2000) }).success).toBe(true);
    expect(CreateActionRequest.safeParse({ title, detail: 'x'.repeat(2001) }).success).toBe(false);
    expect(CreateActionRequest.parse({ title, detail: ' Ask the vendor ' }).detail).toBe('Ask the vendor');
    expect(CreateActionRequest.safeParse({ title, detail: 7 }).success).toBe(false);
    expect(CreateActionRequest.safeParse({ title, domain: 'tools' }).success).toBe(true);
    expect(CreateActionRequest.safeParse({ title, domain: null }).success).toBe(true);
    expect(CreateActionRequest.safeParse({ title, domain: 'marketing' }).success).toBe(false);
    expect(CreateActionRequest.safeParse({ title, status: 'done' }).success).toBe(false);
    expect(CreateActionRequest.safeParse({ title, pointsGain: 2 }).success).toBe(false);
  });

  it('CreateActionRequest reads a null or blank detail as no detail, so the plan never shows an empty one', () => {
    const title = 'Review vendor terms';
    for (const detail of [null, '', '   ', ' \t\n ']) {
      expect(CreateActionRequest.parse({ title, detail }), JSON.stringify(detail)).toEqual({ title, detail: null });
    }
    // Left out, it stays out.
    expect(Object.keys(CreateActionRequest.parse({ title }))).toEqual(['title']);
  });
});

const fromAssessment = {
  key: 'a.sc_robust1.improve:D1.1', source: 'assessment', title: 'Does the firm have a written AI use policy?',
  detail: 'Illustrative next step: Yes.', domain: 'governance', pointsGain: 1.75,
  status: 'todo', assignee: null, dueDate: null, updatedAt: null,
};
const custom = {
  key: 'c.3f1c2a9e-8b7d-4c6e-9a5f-0d1e2f3a4b5c', source: 'custom', title: 'Review vendor terms', detail: null, domain: null,
  pointsGain: null, status: 'in_progress', assignee: { userId: 'u2', email: 'member@firm.com' }, dueDate: '2026-12-01',
  updatedAt: '2026-11-05T10:00:00.000Z',
};

describe('the action plan', () => {
  it('has three statuses', () => {
    expect(ACTION_STATUSES).toEqual(['todo', 'in_progress', 'done']);
  });

  it('ActionItemView accepts an untouched action of the assessment and one the organization wrote', () => {
    expect(ActionItemView.parse(fromAssessment)).toEqual(fromAssessment);
    expect(ActionItemView.parse(custom)).toEqual(custom);
    expect(ActionItemView.safeParse({ ...custom, detail: 'Ask for the data terms', domain: 'tools' }).success).toBe(true);
  });

  it('ActionItemView keeps the points and the domain to the actions of the assessment', () => {
    expect(ActionItemView.safeParse({ ...custom, pointsGain: 2 }).success).toBe(false);
    expect(ActionItemView.safeParse({ ...fromAssessment, pointsGain: null }).success).toBe(false);
    expect(ActionItemView.safeParse({ ...fromAssessment, pointsGain: -1 }).success).toBe(false);
    expect(ActionItemView.safeParse({ ...fromAssessment, domain: null }).success).toBe(false);
    expect(ActionItemView.safeParse({ ...fromAssessment, detail: null }).success).toBe(false);
  });

  it('ActionItemView ties the key to its source', () => {
    expect(ActionItemView.safeParse({ ...fromAssessment, source: 'custom', pointsGain: null }).success).toBe(false);
    expect(ActionItemView.safeParse({ ...custom, source: 'assessment', domain: 'tools', detail: '', pointsGain: 1 }).success).toBe(false);
    expect(ActionItemView.safeParse({ ...custom, source: 'imported' }).success).toBe(false);
  });

  it('ActionItemView only accepts well-formed keys', () => {
    for (const key of ['a.sc_1.D1', 'a.sc_AbC123.improve:D1.1', 'a.sc_1.x.y.z']) {
      expect(ActionItemView.safeParse({ ...fromAssessment, key }).success, key).toBe(true);
    }
    for (const key of ['a.sc_1.', 'a.sc_1', 'a.scan1.D1', 'a.sc_bad-id.D1', 'c.3f1c2a9e-8b7d-4c6e-9a5f-0d1e2f3a4b5c', 'improve:D1.1']) {
      expect(ActionItemView.safeParse({ ...fromAssessment, key }).success, key).toBe(false);
    }
    for (const key of ['c.not-a-uuid', 'c.', 'c.3f1c2a9e8b7d4c6e9a5f0d1e2f3a4b5c', 'a.sc_1.D1']) {
      expect(ActionItemView.safeParse({ ...custom, key }).success, key).toBe(false);
    }
  });

  it('ActionItemView checks the tracking fields and is strict', () => {
    expect(ActionItemView.safeParse({ ...custom, status: 'blocked' }).success).toBe(false);
    expect(ActionItemView.safeParse({ ...custom, dueDate: '2026-12-01T00:00:00.000Z' }).success).toBe(false);
    expect(ActionItemView.safeParse({ ...custom, updatedAt: 'today' }).success).toBe(false);
    expect(ActionItemView.safeParse({ ...custom, assignee: { userId: 'u2' } }).success).toBe(false);
    expect(ActionItemView.safeParse({ ...custom, assignee: { ...custom.assignee, role: 'member' } }).success).toBe(false);
    expect(ActionItemView.safeParse({ ...custom, extra: 1 }).success).toBe(false);
    const { updatedAt: _omitted, ...withoutUpdatedAt } = custom;
    expect(ActionItemView.safeParse(withoutUpdatedAt).success).toBe(false);
  });

  const source = { scanId: 'sc_robust1', domain: 'robust.arca.example', claimedAt: '2026-11-05T09:00:00.000Z' };

  it('ActionPlanResponse carries where the plan comes from and its actions, not the analysis', () => {
    expect(ActionPlanResponse.parse({ source, items: [fromAssessment, custom] })).toEqual({ source, items: [fromAssessment, custom] });
    expect(ActionPlanResponse.safeParse({ source, items: [] }).success).toBe(true);
    expect(ActionPlanResponse.safeParse({ source, items: [], analysis: {} }).success).toBe(false);
    expect(ActionPlanResponse.safeParse({ source: { ...source, decision: 'REFERRAL' }, items: [] }).success).toBe(false);
    expect(ActionPlanResponse.safeParse({ source: { ...source, scanId: 'scan-1' }, items: [] }).success).toBe(false);
  });

  it('ActionPlanResponse without an assessment lists the organization\'s own actions only', () => {
    expect(ActionPlanResponse.safeParse({ source: null, items: [custom] }).success).toBe(true);
    expect(ActionPlanResponse.safeParse({ source: null, items: [fromAssessment] }).success).toBe(false);
  });

  it('ActionPlanResponse never lists an action of an older plan, nor one key twice', () => {
    const older = { ...fromAssessment, key: 'a.sc_older.improve:D1.1' };
    expect(ActionPlanResponse.safeParse({ source, items: [older] }).success).toBe(false);
    // A scan id that only starts like the current one is another scan.
    expect(ActionPlanResponse.safeParse({ source, items: [{ ...fromAssessment, key: 'a.sc_robust12.improve:D1.1' }] }).success).toBe(false);
    expect(ActionPlanResponse.safeParse({ source, items: [fromAssessment, fromAssessment] }).success).toBe(false);
    expect(ActionPlanResponse.safeParse({ source, items: [custom, { ...custom, title: 'Another' }] }).success).toBe(false);
  });
});

const activityEvent = {
  id: '6a1f0c1e-2b3c-4d5e-8f90-a1b2c3d4e5f6', at: '2026-11-05T10:00:00.000Z',
  actor: { kind: 'member', email: 'admin@firm.com' }, action: 'member.role_changed', targetLabel: 'viewer@firm.com',
  change: { from: 'viewer', to: 'member' },
};

describe('the activity of an organization', () => {
  it('ActivityEventView accepts an event of a member, with or without an email', () => {
    expect(ActivityEventView.parse(activityEvent)).toEqual(activityEvent);
    expect(ActivityEventView.safeParse({ ...activityEvent, actor: { kind: 'member', email: null } }).success).toBe(true);
  });

  it('ActivityEventView never carries the email of ARCA staff or of the system', () => {
    expect(ActivityEventView.safeParse({ ...activityEvent, actor: { kind: 'arca', email: null } }).success).toBe(true);
    expect(ActivityEventView.safeParse({ ...activityEvent, actor: { kind: 'system', email: null } }).success).toBe(true);
    expect(ActivityEventView.safeParse({ ...activityEvent, actor: { kind: 'arca', email: 'ops@arca.example' } }).success).toBe(false);
    expect(ActivityEventView.safeParse({ ...activityEvent, actor: { kind: 'system', email: 'ops@arca.example' } }).success).toBe(false);
    expect(ActivityEventView.safeParse({ ...activityEvent, actor: { kind: 'platform', email: null } }).success).toBe(false);
    expect(ActivityEventView.safeParse({ ...activityEvent, actor: { kind: 'arca' } }).success).toBe(false);
    expect(ActivityEventView.safeParse({ ...activityEvent, actor: { kind: 'member', email: 'a@b.co', userId: 'u1' } }).success).toBe(false);
  });

  it('ActivityActor is exported for the front, schema and type', () => {
    const actors: ActivityActor[] = [{ kind: 'member', email: 'admin@firm.com' }, { kind: 'member', email: null },
      { kind: 'arca', email: null }, { kind: 'system', email: null }];
    for (const actor of actors) expect(ActivityActor.parse(actor)).toEqual(actor);
    expect(ActivityActor.safeParse({ kind: 'system', email: 'ops@arca.example' }).success).toBe(false);
    expect(ActivityActor.safeParse({ kind: 'platform', email: null }).success).toBe(false);
  });

  it('ActivityEventView shows a translated target and an allowed change, never the raw data', () => {
    expect(ActivityEventView.safeParse({ ...activityEvent, targetLabel: null, change: null }).success).toBe(true);
    expect(ActivityEventView.safeParse({ ...activityEvent, action: 'action.updated', change: { from: null, to: '2026-12-01' } }).success)
      .toBe(true);
    expect(ActivityEventView.safeParse({ ...activityEvent, data: { from: 'viewer', to: 'member' } }).success).toBe(false);
    expect(ActivityEventView.safeParse({ ...activityEvent, target: 'u1' }).success).toBe(false);
    expect(ActivityEventView.safeParse({ ...activityEvent, change: { from: 'viewer', to: 'member', reason: 'x' } }).success).toBe(false);
    expect(ActivityEventView.safeParse({ ...activityEvent, change: { from: 'viewer' } }).success).toBe(false);
    expect(ActivityEventView.safeParse({ ...activityEvent, at: 'yesterday' }).success).toBe(false);
    expect(ActivityEventView.safeParse({ ...activityEvent, action: '' }).success).toBe(false);
  });

  it('ActivityPage pages backwards by audit sequence', () => {
    expect(ActivityPage.parse({ events: [activityEvent], nextBefore: 41 })).toEqual({ events: [activityEvent], nextBefore: 41 });
    expect(ActivityPage.safeParse({ events: [], nextBefore: null }).success).toBe(true);
    for (const nextBefore of [0, -1, 1.5, '41']) expect(ActivityPage.safeParse({ events: [], nextBefore }).success).toBe(false);
    expect(ActivityPage.safeParse({ events: [] }).success).toBe(false);
    expect(ActivityPage.safeParse({ events: [], nextBefore: null, total: 0 }).success).toBe(false);
  });
});

describe('the platform admin views', () => {
  const detail = {
    id: 'org-1', name: 'Robust Law (demo)', domain: 'robust.arca.example', billingStatus: 'active', deleted: false,
    createdAt: '2026-11-05T09:00:00.000Z', planCode: 'monthly', analysisCount: 1, pendingDeletion: null,
    members: [{ email: 'owner@firm.com', role: 'owner', joinedAt: '2026-11-05T09:00:00.000Z' }],
  };
  const pending = {
    id: 'd1', orgId: 'org-1', reason: 'Closing the firm', status: 'pending', requestedAt: '2026-11-05T11:00:00.000Z',
    reviewedAt: null, reviewNote: null,
  };

  it('AdminOrgDetailView describes one organization and its members', () => {
    expect(AdminOrgDetailView.parse(detail)).toEqual(detail);
    const unpaid = { ...detail, domain: null, billingStatus: 'pending_payment', planCode: null, analysisCount: 0, pendingDeletion: pending };
    expect(AdminOrgDetailView.parse(unpaid)).toEqual(unpaid);
    expect(AdminOrgDetailView.safeParse({ ...detail, deleted: true }).success).toBe(true);
  });

  it('AdminOrgDetailView is strict, also for each member', () => {
    expect(AdminOrgDetailView.safeParse({ ...detail, extra: 1 }).success).toBe(false);
    expect(AdminOrgDetailView.safeParse({ ...detail, members: [{ ...detail.members[0], userId: 'u1' }] }).success).toBe(false);
    expect(AdminOrgDetailView.safeParse({ ...detail, members: [{ ...detail.members[0], role: 'root' }] }).success).toBe(false);
    expect(AdminOrgDetailView.safeParse({ ...detail, analysisCount: -1 }).success).toBe(false);
    expect(AdminOrgDetailView.safeParse({ ...detail, billingStatus: 'trialing' }).success).toBe(false);
    expect(AdminOrgDetailView.safeParse({ ...detail, pendingDeletion: { ...pending, extra: 1 } }).success).toBe(false);
    const { createdAt: _omitted, ...withoutCreatedAt } = detail;
    expect(AdminOrgDetailView.safeParse(withoutCreatedAt).success).toBe(false);
  });

  const auditEvent = {
    id: 'e1', at: '2026-11-05T10:00:00.000Z', orgId: 'org-1', orgName: 'Robust Law (demo)', actorKind: 'platform',
    actorEmail: 'ops@arca.example', action: 'org.deletion_approved', targetLabel: 'Robust Law (demo)',
  };

  it('AdminAuditEventView names the organization and the actor, ARCA staff included', () => {
    expect(AUDIT_ACTOR_KINDS).toEqual(['member', 'platform', 'system']);
    expect(AdminAuditEventView.parse(auditEvent)).toEqual(auditEvent);
    const planChange = { ...auditEvent, orgId: null, orgName: null, action: 'plan.updated', targetLabel: 'monthly' };
    expect(AdminAuditEventView.parse(planChange)).toEqual(planChange);
    const billing = { ...auditEvent, actorKind: 'system', actorEmail: null, action: 'billing.event_applied', targetLabel: null };
    expect(AdminAuditEventView.parse(billing)).toEqual(billing);
    expect(AdminAuditEventView.safeParse({ ...auditEvent, actorKind: 'arca' }).success).toBe(false);
    expect(AdminAuditEventView.safeParse({ ...auditEvent, actorEmail: 'not-an-email' }).success).toBe(false);
    expect(AdminAuditEventView.safeParse({ ...auditEvent, data: {} }).success).toBe(false);
  });

  it('AdminAuditEventView gives an email to ARCA staff and members only, never to the system', () => {
    for (const actorKind of ['member', 'platform']) {
      for (const actorEmail of ['someone@firm.com', null]) {
        expect(AdminAuditEventView.safeParse({ ...auditEvent, actorKind, actorEmail }).success, `${actorKind} ${actorEmail}`).toBe(true);
      }
    }
    expect(AdminAuditEventView.safeParse({ ...auditEvent, actorKind: 'system', actorEmail: null }).success).toBe(true);
    expect(AdminAuditEventView.safeParse({ ...auditEvent, actorKind: 'system', actorEmail: 'ops@arca.example' }).success).toBe(false);
    expect(AdminAuditPage.safeParse({ events: [{ ...auditEvent, actorKind: 'system' }], nextBefore: null }).success).toBe(false);
  });

  it('AdminAuditPage pages backwards like the activity', () => {
    expect(AdminAuditPage.safeParse({ events: [auditEvent], nextBefore: 7 }).success).toBe(true);
    expect(AdminAuditPage.safeParse({ events: [], nextBefore: null }).success).toBe(true);
    expect(AdminAuditPage.safeParse({ events: [], nextBefore: 0 }).success).toBe(false);
    expect(AdminAuditPage.safeParse({ events: [activityEvent], nextBefore: null }).success).toBe(false);
  });

  const metrics = {
    organizations: { pending_payment: 1, active: 2, past_due: 0, canceled: 0, deleted: 1 },
    members: 7, analyses: 3, pendingDeletionRequests: 1, actions: { todo: 4, in_progress: 1, done: 2 },
  };

  it('AdminMetricsView holds counts only', () => {
    expect(AdminMetricsView.parse(metrics)).toEqual(metrics);
    expect(AdminMetricsView.safeParse({ ...metrics, members: -1 }).success).toBe(false);
    expect(AdminMetricsView.safeParse({ ...metrics, analyses: 1.5 }).success).toBe(false);
    expect(AdminMetricsView.safeParse({ ...metrics, revenueCents: 0 }).success).toBe(false);
    expect(AdminMetricsView.safeParse({ ...metrics, actions: { ...metrics.actions, blocked: 0 } }).success).toBe(false);
    const { canceled: _omitted, ...withoutCanceled } = metrics.organizations;
    expect(AdminMetricsView.safeParse({ ...metrics, organizations: withoutCanceled }).success).toBe(false);
  });

  it('AdminMetricsView counts every billing status, with the deleted organizations apart', () => {
    expect(Object.keys(AdminMetricsView.shape.organizations.shape)).toEqual([...BILLING_STATUSES, 'deleted']);
    expect(AdminMetricsView.safeParse({ ...metrics, organizations: { ...metrics.organizations, trialing: 0 } }).success).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { PlanView } from '@arca/contracts';
import { InMemoryWebappRepository } from '../../src/webapp/in-memory.js';
import { DEFAULT_PLANS } from '../../src/webapp/plans.js';
import {
  WebappConflict, type AuditRecord, type ClaimTicketRecord, type DeletionRequestRecord, type InvitationRecord,
  type MembershipRecord, type OrgAnalysisRecord, type OrganizationRecord, type ProfileRecord, type SubscriptionRecord,
} from '../../src/webapp/types.js';

const NOW = '2026-10-25T12:00:00.000Z';
const LATER = '2026-10-25T13:00:00.000Z';

const profile = (userId: string): ProfileRecord => ({ user_id: userId, email: `${userId}@firm.com`, full_name: null, last_org_id: null, created_at: NOW });
const org = (id: string, patch: Partial<OrganizationRecord> = {}): OrganizationRecord => ({ id, name: `Org ${id}`, domain: 'firm.com',
  billing_status: 'pending_payment', deleted_at: null, created_by: 'user_a', created_at: NOW, ...patch });
const member = (orgId: string, userId: string, role: MembershipRecord['role'] = 'member'): MembershipRecord => ({ org_id: orgId,
  user_id: userId, role, invited_by: null, created_at: NOW });
const analysis = (orgId: string, scanId: string): OrgAnalysisRecord => ({ org_id: orgId, scan_id: scanId, assessment_id: null,
  claimed_by: 'user_a', claimed_at: NOW });
const invitation = (id: string, patch: Partial<InvitationRecord> = {}): InvitationRecord => ({ id, org_id: 'org_1', email: 'guest@firm.com',
  role: 'member', token_hash: `hash_${id}`, invited_by: 'user_a', expires_at: '2026-11-01T12:00:00.000Z', accepted_at: null, revoked_at: null,
  created_at: NOW, ...patch });
const ticket = (idHash: string): ClaimTicketRecord => ({ id_hash: idHash, scan_id: 'scan_1', email: 'owner@firm.com', expires_at: LATER, used_at: null });
const deletion = (id: string, orgId = 'org_1'): DeletionRequestRecord => ({ id, org_id: orgId, requested_by: 'user_a', reason: 'We left the firm',
  status: 'pending', reviewed_by: null, reviewed_at: null, review_note: null, created_at: NOW });
const subscription = (orgId: string, patch: Partial<SubscriptionRecord> = {}): SubscriptionRecord => ({ org_id: orgId, plan_code: 'monthly',
  customer_id: 'cus_1', subscription_id: 'sub_1', status: 'active', current_period_end: LATER, updated_at: NOW, ...patch });
const audit = (id: string, orgId: string | null, data: Record<string, unknown> = {}): AuditRecord => ({ id, actor_user_id: 'user_a', org_id: orgId,
  action: 'member.invited', target: 'guest@firm.com', data, created_at: NOW });

const newRepo = () => new InMemoryWebappRepository([...DEFAULT_PLANS]);
async function repoWithOrg(orgId = 'org_1', ownerId = 'user_a') {
  const repo = newRepo();
  await repo.createOrganization(org(orgId), member(orgId, ownerId, 'owner'), null);
  return repo;
}

describe('default plans', () => {
  it('seeds the two example plans, labelled as example prices', () => {
    expect(DEFAULT_PLANS.map(plan => [plan.code, plan.amount_cents, plan.currency, plan.interval, plan.active]))
      .toEqual([['monthly', 49900, 'usd', 'month', true], ['annual', 499000, 'usd', 'year', true]]);
    for (const plan of DEFAULT_PLANS) {
      expect(plan.name).toContain('(example price)');
      expect(PlanView.safeParse({ code: plan.code, name: plan.name, amountCents: plan.amount_cents, currency: plan.currency, interval: plan.interval }).success).toBe(true);
    }
  });

  it('starts the repository with those plans', async () => {
    expect(await newRepo().listPlans()).toEqual(DEFAULT_PLANS);
  });
});

describe('organizations', () => {
  it('an organization is created with its owner and its claimed analysis, atomically', async () => {
    const repo = newRepo();
    await repo.createOrganization(org('org_1'), member('org_1', 'user_a', 'owner'), analysis('org_1', 'scan_1'));
    expect(await repo.getOrganization('org_1')).toEqual(org('org_1'));
    expect(await repo.getMembership('org_1', 'user_a')).toMatchObject({ role: 'owner' });
    expect(await repo.listAnalyses('org_1')).toEqual([analysis('org_1', 'scan_1')]);

    const rejected = repo.createOrganization(org('org_2'), member('org_2', 'user_b', 'owner'), analysis('org_2', 'scan_1'));
    await expect(rejected).rejects.toBeInstanceOf(WebappConflict);
    await expect(rejected).rejects.toMatchObject({ reason: 'scan_claimed' });
    expect(await repo.getOrganization('org_2')).toBeNull();
    expect(await repo.getMembership('org_2', 'user_b')).toBeNull();
    expect(await repo.listOrganizationsForUser('user_b')).toEqual([]);
    expect(await repo.listAnalyses('org_2')).toEqual([]);
    expect((await repo.listOrganizations()).map(o => o.id)).toEqual(['org_1']);
  });

  it('an organization can start without an analysis', async () => {
    const repo = await repoWithOrg();
    expect(await repo.listAnalyses('org_1')).toEqual([]);
    expect(await repo.getOrganization('org_1')).toMatchObject({ id: 'org_1', billing_status: 'pending_payment', deleted_at: null });
  });

  it('an organization cannot start without an owner, nor with records of another organization', async () => {
    const repo = newRepo();
    await expect(repo.createOrganization(org('org_1'), member('org_1', 'user_a', 'admin'), null)).rejects.toThrow('Invalid organization');
    await expect(repo.createOrganization(org('org_1'), member('org_2', 'user_a', 'owner'), null)).rejects.toThrow('Invalid organization');
    await expect(repo.createOrganization(org('org_1'), member('org_1', 'user_a', 'owner'), analysis('org_2', 'scan_1'))).rejects.toThrow('Invalid organization');
    expect(await repo.listOrganizations()).toEqual([]);
    await repo.createOrganization(org('org_1'), member('org_1', 'user_a', 'owner'), null);
    await expect(repo.createOrganization(org('org_1'), member('org_1', 'user_b', 'owner'), null)).rejects.toThrow('Duplicate organization');
    expect(await repo.listMembers('org_1')).toHaveLength(1);
  });

  it('lists the organizations of a user with the role they hold in each', async () => {
    const repo = await repoWithOrg('org_1', 'user_a');
    await repo.createOrganization(org('org_2', { created_by: 'user_b' }), member('org_2', 'user_b', 'owner'), null);
    await repo.addMember(member('org_2', 'user_a', 'viewer'));
    expect((await repo.listOrganizationsForUser('user_a')).map(({ org: o, role }) => [o.id, role])).toEqual([['org_1', 'owner'], ['org_2', 'viewer']]);
    expect((await repo.listOrganizationsForUser('user_b')).map(({ org: o, role }) => [o.id, role])).toEqual([['org_2', 'owner']]);
    expect(await repo.listOrganizationsForUser('nobody')).toEqual([]);
  });

  it('upserts a profile by user', async () => {
    const repo = newRepo();
    expect(await repo.getProfile('user_a')).toBeNull();
    await repo.upsertProfile(profile('user_a'));
    await repo.upsertProfile({ ...profile('user_a'), full_name: 'Ana', last_org_id: 'org_1' });
    expect(await repo.getProfile('user_a')).toEqual({ ...profile('user_a'), full_name: 'Ana', last_org_id: 'org_1' });
  });
});

describe('members', () => {
  it('a member is added once', async () => {
    const repo = await repoWithOrg();
    await repo.addMember(member('org_1', 'user_b', 'viewer'));
    await expect(repo.addMember(member('org_1', 'user_b', 'admin'))).rejects.toMatchObject({ reason: 'already_member' });
    await expect(repo.addMember(member('org_1', 'user_a', 'member'))).rejects.toBeInstanceOf(WebappConflict);
    expect((await repo.listMembers('org_1')).map(m => [m.user_id, m.role])).toEqual([['user_a', 'owner'], ['user_b', 'viewer']]);
  });

  it('the last owner can be neither demoted nor removed', async () => {
    const repo = await repoWithOrg();
    // Owners of other organizations do not count: user_a owns org_2 too, and org_1 still has one owner.
    await repo.createOrganization(org('org_2'), member('org_2', 'user_a', 'owner'), null);
    await repo.addMember(member('org_1', 'user_b', 'admin'));

    await expect(repo.setRole('org_1', 'user_a', 'admin')).rejects.toMatchObject({ reason: 'last_owner' });
    await expect(repo.removeMember('org_1', 'user_a')).rejects.toMatchObject({ reason: 'last_owner' });
    expect(await repo.getMembership('org_1', 'user_a')).toMatchObject({ role: 'owner' });

    // With two owners either can go, and the one left is protected in turn.
    await repo.setRole('org_1', 'user_b', 'owner');
    await repo.setRole('org_1', 'user_a', 'admin');
    expect(await repo.getMembership('org_1', 'user_a')).toMatchObject({ role: 'admin' });
    await expect(repo.removeMember('org_1', 'user_b')).rejects.toMatchObject({ reason: 'last_owner' });
    await expect(repo.setRole('org_1', 'user_b', 'viewer')).rejects.toMatchObject({ reason: 'last_owner' });

    await repo.setRole('org_1', 'user_a', 'owner');
    await repo.removeMember('org_1', 'user_b');
    expect(await repo.getMembership('org_1', 'user_b')).toBeNull();
    expect((await repo.listMembers('org_1')).map(m => m.user_id)).toEqual(['user_a']);
  });

  it('lets everyone but the last owner change role or leave', async () => {
    const repo = await repoWithOrg();
    await repo.addMember(member('org_1', 'user_b', 'member'));
    await repo.setRole('org_1', 'user_a', 'owner');
    await repo.setRole('org_1', 'user_b', 'admin');
    await repo.setRole('org_1', 'user_b', 'viewer');
    await repo.removeMember('org_1', 'user_b');
    expect(await repo.getMembership('org_1', 'user_a')).toMatchObject({ role: 'owner' });
    expect(await repo.listMembers('org_1')).toHaveLength(1);
  });

  it('refuses to change a member that does not exist', async () => {
    const repo = await repoWithOrg();
    await expect(repo.setRole('org_1', 'ghost', 'admin')).rejects.toThrow('Member not found');
    await expect(repo.removeMember('org_1', 'ghost')).rejects.toThrow('Member not found');
    await expect(repo.setRole('org_9', 'user_a', 'admin')).rejects.toThrow('Member not found');
  });
});

describe('invitations', () => {
  it('lists only the pending ones, while any of them can still be found by its hash', async () => {
    const repo = await repoWithOrg();
    await repo.createInvitation(invitation('inv_pending'));
    await repo.createInvitation(invitation('inv_accepted'));
    await repo.createInvitation(invitation('inv_revoked'));
    await repo.createInvitation(invitation('inv_other_org', { org_id: 'org_2' }));
    await repo.updateInvitation('inv_accepted', { accepted_at: LATER });
    await repo.updateInvitation('inv_revoked', { revoked_at: LATER });

    expect((await repo.listInvitations('org_1')).map(i => i.id)).toEqual(['inv_pending']);
    expect(await repo.findInvitationByHash('hash_inv_accepted')).toMatchObject({ id: 'inv_accepted', accepted_at: LATER, revoked_at: null });
    expect(await repo.findInvitationByHash('hash_inv_revoked')).toMatchObject({ id: 'inv_revoked', revoked_at: LATER, accepted_at: null });
    expect(await repo.findInvitationByHash('hash_unknown')).toBeNull();
  });

  it('updates only the fields it is given, and rejects an unknown invitation', async () => {
    const repo = await repoWithOrg();
    await repo.createInvitation(invitation('inv_1'));
    await repo.updateInvitation('inv_1', { revoked_at: LATER });
    await repo.updateInvitation('inv_1', {});
    expect(await repo.findInvitationByHash('hash_inv_1')).toEqual(invitation('inv_1', { revoked_at: LATER }));
    await expect(repo.updateInvitation('inv_missing', { revoked_at: LATER })).rejects.toThrow('Invitation not found');
  });
});

describe('analyses', () => {
  it('a scan is claimed once, by one organization only', async () => {
    const repo = await repoWithOrg();
    await repo.createOrganization(org('org_2'), member('org_2', 'user_b', 'owner'), null);
    await repo.claimAnalysis(analysis('org_1', 'scan_1'));
    await expect(repo.claimAnalysis(analysis('org_1', 'scan_1'))).rejects.toMatchObject({ reason: 'scan_claimed' });
    await expect(repo.claimAnalysis(analysis('org_2', 'scan_1'))).rejects.toMatchObject({ reason: 'scan_claimed' });
    await repo.claimAnalysis(analysis('org_1', 'scan_2'));
    expect((await repo.listAnalyses('org_1')).map(a => a.scan_id)).toEqual(['scan_1', 'scan_2']);
    expect(await repo.listAnalyses('org_2')).toEqual([]);
  });
});

describe('claim tickets', () => {
  it('a claim ticket is used once', async () => {
    const repo = newRepo();
    await repo.createClaimTicket(ticket('ticket_1'));
    expect(await repo.getClaimTicket('ticket_1')).toEqual(ticket('ticket_1'));
    expect(await repo.markClaimTicketUsed('ticket_1', NOW)).toBe(true);
    expect(await repo.markClaimTicketUsed('ticket_1', LATER)).toBe(false);
    expect(await repo.getClaimTicket('ticket_1')).toEqual({ ...ticket('ticket_1'), used_at: NOW });
  });

  it('there is nothing to use in a ticket that does not exist', async () => {
    const repo = newRepo();
    expect(await repo.getClaimTicket('ticket_missing')).toBeNull();
    expect(await repo.markClaimTicketUsed('ticket_missing', NOW)).toBe(false);
  });
});

describe('plans and billing', () => {
  it('updates only the fields given and never the code', async () => {
    const repo = newRepo();
    await repo.updatePlan('monthly', { amount_cents: 59900, active: false });
    expect(await repo.getPlan('monthly')).toEqual({ ...DEFAULT_PLANS[0], amount_cents: 59900, active: false });
    expect(await repo.getPlan('annual')).toEqual(DEFAULT_PLANS[1]);
    expect((await repo.listPlans()).map(plan => plan.code)).toEqual(['monthly', 'annual']);
    expect(await repo.getPlan('weekly')).toBeNull();
    await expect(repo.updatePlan('weekly', { active: false })).rejects.toThrow('Plan not found');
  });

  it('keeps the subscription of an organization and moves its billing status separately', async () => {
    const repo = await repoWithOrg();
    expect(await repo.getSubscription('org_1')).toBeNull();
    await repo.upsertSubscription(subscription('org_1', { status: 'pending_payment', subscription_id: null }));
    await repo.upsertSubscription(subscription('org_1'));
    expect(await repo.getSubscription('org_1')).toEqual(subscription('org_1'));

    await repo.setBillingStatus('org_1', 'active');
    expect((await repo.getOrganization('org_1'))?.billing_status).toBe('active');
    await repo.setBillingStatus('org_1', 'past_due');
    expect((await repo.getOrganization('org_1'))?.billing_status).toBe('past_due');
    await expect(repo.setBillingStatus('org_missing', 'active')).rejects.toThrow('Organization not found');
  });

  it('billing events are recorded once', async () => {
    const repo = newRepo();
    expect(await repo.recordBillingEvent('evt_1', 'x')).toBe(true);
    expect(await repo.recordBillingEvent('evt_1', 'x')).toBe(false);
    expect(await repo.recordBillingEvent('evt_1', 'another.type')).toBe(false);
    expect(await repo.recordBillingEvent('evt_2', 'x')).toBe(true);
  });
});

describe('deletion requests', () => {
  it('one pending deletion request per organization', async () => {
    const repo = await repoWithOrg();
    await repo.createOrganization(org('org_2'), member('org_2', 'user_b', 'owner'), null);
    await repo.createDeletionRequest(deletion('del_1'));
    await expect(repo.createDeletionRequest(deletion('del_2'))).rejects.toMatchObject({ reason: 'deletion_pending' });
    expect(await repo.getDeletionRequest('del_2')).toBeNull();
    expect(await repo.getPendingDeletionRequest('org_1')).toEqual(deletion('del_1'));

    // Another organization is not blocked, and a reviewed request frees the organization to ask again.
    await repo.createDeletionRequest(deletion('del_3', 'org_2'));
    await repo.reviewDeletionRequest('del_1', 'rejected', 'admin_1', 'Please contact us first', LATER);
    expect(await repo.getPendingDeletionRequest('org_1')).toBeNull();
    await repo.createDeletionRequest(deletion('del_4'));
    expect((await repo.getPendingDeletionRequest('org_1'))?.id).toBe('del_4');
    expect((await repo.listDeletionRequests()).map(r => [r.id, r.status])).toEqual([
      ['del_1', 'rejected'], ['del_3', 'pending'], ['del_4', 'pending']]);
  });

  it('a review records who decided, when and why, and only once', async () => {
    const repo = await repoWithOrg();
    await repo.createDeletionRequest(deletion('del_1'));
    await repo.reviewDeletionRequest('del_1', 'approved', 'admin_1', null, LATER);
    expect(await repo.getDeletionRequest('del_1')).toEqual({ ...deletion('del_1'), status: 'approved', reviewed_by: 'admin_1', reviewed_at: LATER, review_note: null });
    await expect(repo.reviewDeletionRequest('del_1', 'rejected', 'admin_2', 'changed my mind', LATER)).rejects.toThrow('Deletion request already reviewed');
    await expect(repo.reviewDeletionRequest('del_missing', 'approved', 'admin_1', null, LATER)).rejects.toThrow('Deletion request not found');
    expect(await repo.getDeletionRequest('del_1')).toMatchObject({ status: 'approved', reviewed_by: 'admin_1' });
  });

  it('marks an organization deleted without losing the first deletion time', async () => {
    const repo = await repoWithOrg();
    await repo.markOrganizationDeleted('org_1', NOW);
    await repo.markOrganizationDeleted('org_1', LATER);
    expect(await repo.getOrganization('org_1')).toMatchObject({ deleted_at: NOW });
    expect((await repo.listOrganizations()).map(o => o.id)).toEqual(['org_1']);
    expect((await repo.listOrganizationsForUser('user_a')).map(({ org: o }) => o.id)).toEqual(['org_1']);
    await expect(repo.markOrganizationDeleted('org_missing', NOW)).rejects.toThrow('Organization not found');
  });
});

describe('platform admins and the audit log', () => {
  it('grants the platform role by user, apart from any organization role', async () => {
    const repo = await repoWithOrg();
    expect(await repo.isPlatformAdmin('user_a')).toBe(false);
    await repo.grantPlatformAdmin('staff_1', 'script');
    await repo.grantPlatformAdmin('staff_1', 'script');
    expect(await repo.isPlatformAdmin('staff_1')).toBe(true);
    expect(await repo.isPlatformAdmin('user_a')).toBe(false);
  });

  it('lists the audit rows of one organization in the order they were appended', async () => {
    const repo = newRepo();
    await repo.appendAudit(audit('aud_1', 'org_1'));
    await repo.appendAudit(audit('aud_2', 'org_2'));
    await repo.appendAudit(audit('aud_3', 'org_1'));
    await repo.appendAudit(audit('aud_4', null));
    expect((await repo.listAudit('org_1')).map(a => a.id)).toEqual(['aud_1', 'aud_3']);
    expect(await repo.listAudit('org_9')).toEqual([]);
  });
});

describe('records with an identity', () => {
  it('refuses to overwrite an invitation, a claim ticket or a deletion request that already exists', async () => {
    const repo = await repoWithOrg();
    await repo.createInvitation(invitation('inv_1'));
    await repo.updateInvitation('inv_1', { accepted_at: NOW });
    await expect(repo.createInvitation(invitation('inv_1', { email: 'other@firm.com' }))).rejects.toThrow('Duplicate invitation');
    await expect(repo.createInvitation(invitation('inv_2', { token_hash: 'hash_inv_1' }))).rejects.toThrow('Duplicate invitation');
    expect(await repo.findInvitationByHash('hash_inv_1')).toMatchObject({ id: 'inv_1', email: 'guest@firm.com', accepted_at: NOW });

    await repo.createClaimTicket(ticket('ticket_1'));
    await repo.markClaimTicketUsed('ticket_1', NOW);
    await expect(repo.createClaimTicket(ticket('ticket_1'))).rejects.toThrow('Duplicate claim ticket');
    expect((await repo.getClaimTicket('ticket_1'))?.used_at).toBe(NOW);

    await repo.createDeletionRequest(deletion('del_1'));
    await repo.reviewDeletionRequest('del_1', 'rejected', 'admin_1', null, LATER);
    await expect(repo.createDeletionRequest(deletion('del_1'))).rejects.toThrow('Duplicate deletion request');
    expect((await repo.getDeletionRequest('del_1'))?.status).toBe('rejected');
  });
});

describe('copies and reset', () => {
  it('returns copies', async () => {
    const repo = newRepo();
    const created = org('org_1');
    await repo.createOrganization(created, member('org_1', 'user_a', 'owner'), analysis('org_1', 'scan_1'));
    await repo.createInvitation(invitation('inv_1'));
    await repo.appendAudit(audit('aud_1', 'org_1', { nested: { count: 1 } }));
    await repo.upsertProfile(profile('user_a'));

    created.name = 'mutated input';
    (await repo.getOrganization('org_1'))!.name = 'mutated';
    (await repo.listOrganizations())[0]!.name = 'mutated';
    (await repo.listOrganizationsForUser('user_a'))[0]!.org.name = 'mutated';
    (await repo.listOrganizationsForUser('user_a'))[0]!.role = 'viewer';
    (await repo.getMembership('org_1', 'user_a'))!.role = 'viewer';
    (await repo.listMembers('org_1'))[0]!.role = 'viewer';
    (await repo.listAnalyses('org_1'))[0]!.scan_id = 'mutated';
    (await repo.findInvitationByHash('hash_inv_1'))!.email = 'mutated@firm.com';
    (await repo.listInvitations('org_1'))[0]!.role = 'viewer';
    (await repo.getPlan('monthly'))!.amount_cents = 1;
    (await repo.listPlans())[0]!.name = 'mutated';
    (await repo.listAudit('org_1'))[0]!.data.nested = 'mutated';
    (await repo.getProfile('user_a'))!.email = 'mutated@firm.com';

    expect(await repo.getOrganization('org_1')).toEqual(org('org_1'));
    expect(await repo.listOrganizations()).toEqual([org('org_1')]);
    expect(await repo.listOrganizationsForUser('user_a')).toEqual([{ org: org('org_1'), role: 'owner' }]);
    expect(await repo.getMembership('org_1', 'user_a')).toMatchObject({ role: 'owner' });
    expect(await repo.listAnalyses('org_1')).toEqual([analysis('org_1', 'scan_1')]);
    expect(await repo.findInvitationByHash('hash_inv_1')).toEqual(invitation('inv_1'));
    expect(await repo.getPlan('monthly')).toEqual(DEFAULT_PLANS[0]);
    expect((await repo.listAudit('org_1'))[0]!.data).toEqual({ nested: { count: 1 } });
    expect(await repo.getProfile('user_a')).toEqual(profile('user_a'));
  });

  it('does not share the plans it was seeded with', async () => {
    const seed = [...DEFAULT_PLANS].map(plan => ({ ...plan }));
    const repo = new InMemoryWebappRepository(seed);
    seed[0]!.amount_cents = 1;
    expect((await repo.getPlan('monthly'))?.amount_cents).toBe(49900);
  });

  it('clear() empties everything and reseeds the plans', async () => {
    const repo = newRepo();
    await repo.upsertProfile(profile('user_a'));
    await repo.createOrganization(org('org_1'), member('org_1', 'user_a', 'owner'), analysis('org_1', 'scan_1'));
    await repo.createInvitation(invitation('inv_1'));
    await repo.createClaimTicket(ticket('ticket_1'));
    await repo.markClaimTicketUsed('ticket_1', NOW);
    await repo.updatePlan('monthly', { amount_cents: 1 });
    await repo.upsertSubscription(subscription('org_1'));
    await repo.recordBillingEvent('evt_1', 'x');
    await repo.createDeletionRequest(deletion('del_1'));
    await repo.grantPlatformAdmin('staff_1', 'script');
    await repo.appendAudit(audit('aud_1', 'org_1'));

    repo.clear();

    expect(await repo.getProfile('user_a')).toBeNull();
    expect(await repo.listOrganizations()).toEqual([]);
    expect(await repo.getOrganization('org_1')).toBeNull();
    expect(await repo.getMembership('org_1', 'user_a')).toBeNull();
    expect(await repo.listMembers('org_1')).toEqual([]);
    expect(await repo.listOrganizationsForUser('user_a')).toEqual([]);
    expect(await repo.listAnalyses('org_1')).toEqual([]);
    expect(await repo.findInvitationByHash('hash_inv_1')).toBeNull();
    expect(await repo.getClaimTicket('ticket_1')).toBeNull();
    expect(await repo.getSubscription('org_1')).toBeNull();
    expect(await repo.getPendingDeletionRequest('org_1')).toBeNull();
    expect(await repo.listDeletionRequests()).toEqual([]);
    expect(await repo.isPlatformAdmin('staff_1')).toBe(false);
    expect(await repo.listAudit('org_1')).toEqual([]);
    expect(await repo.listPlans()).toEqual(DEFAULT_PLANS);

    // What was remembered to refuse repeats is forgotten too.
    expect(await repo.recordBillingEvent('evt_1', 'x')).toBe(true);
    await repo.createOrganization(org('org_1'), member('org_1', 'user_a', 'owner'), analysis('org_1', 'scan_1'));
    expect(await repo.listAnalyses('org_1')).toHaveLength(1);
  });
});

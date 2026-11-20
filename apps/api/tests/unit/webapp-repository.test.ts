import { describe, expect, it } from 'vitest';
import { PlanView } from '@arca/contracts';
import { InMemoryWebappRepository } from '../../src/webapp/in-memory.js';
import { DEFAULT_PLANS } from '../../src/webapp/plans.js';
import type { AssessmentActionRecord, ClaimTicketRecord, CustomActionRecord, DeletionRequestRecord, InvitationRecord, MembershipRecord,
  NewAuditRecord, OrgAnalysisRecord, OrganizationRecord, ProfileWrite, SubscriptionRecord } from '../../src/webapp/types.js';
import { describeWebappRepository } from '../conformance/webapp-repository.js';

// The contract every repository keeps lives in the conformance suite, which the Supabase repository runs too (DN-13 §11). What
// stays here is the in-memory store's own: its seed, the copies it returns and the debug reset.
describeWebappRepository('in memory', async () => {
  let scans = 0;
  return { repository: new InMemoryWebappRepository(DEFAULT_PLANS), scan: async () => `sc_conformance${++scans}` };
});

const NOW = '2026-10-25T12:00:00.000Z';
const LATER = '2026-10-25T13:00:00.000Z';

const profile = (userId: string): ProfileWrite => ({ user_id: userId, email: `${userId}@firm.com`, full_name: null, last_org_id: null, created_at: NOW });
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
const audit = (id: string, orgId: string | null, patch: Partial<NewAuditRecord> = {}): NewAuditRecord => ({ id, actor_kind: 'member',
  actor_user_id: 'user_a', org_id: orgId, action: 'member.invited', target: 'guest@firm.com', data: {}, created_at: NOW, ...patch });
const custom = (id: string, orgId = 'org_1', patch: Partial<CustomActionRecord> = {}): CustomActionRecord => ({ id, org_id: orgId,
  source: 'custom', scan_id: null, action_key: null, title: `Action ${id}`, detail: null, domain: null, status: 'todo', assignee_user_id: null,
  due_date: null, created_by: 'user_a', created_at: NOW, updated_by: 'user_a', updated_at: NOW, ...patch });
const tracked = (id: string, scanId: string, actionKey: string, patch: Partial<AssessmentActionRecord> = {}): AssessmentActionRecord => ({ id,
  org_id: 'org_1', source: 'assessment', scan_id: scanId, action_key: actionKey, title: null, detail: null, domain: null, status: 'todo',
  assignee_user_id: null, due_date: null, created_by: 'user_a', created_at: NOW, updated_by: 'user_a', updated_at: NOW, ...patch });

const newRepo = () => new InMemoryWebappRepository([...DEFAULT_PLANS]);
/** An upsert whose patch names every tracked field of the row, as a first write does. */
const upsert = (repo: InMemoryWebappRepository, row: AssessmentActionRecord) => repo.upsertAssessmentAction(row, { status: row.status,
  assignee_user_id: row.assignee_user_id, due_date: row.due_date, updated_by: row.updated_by, updated_at: row.updated_at });
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

describe('copies and reset', () => {
  it('returns copies', async () => {
    const repo = newRepo();
    const created = org('org_1');
    await repo.createOrganization(created, member('org_1', 'user_a', 'owner'), analysis('org_1', 'scan_1'));
    await repo.createInvitation(invitation('inv_1'));
    const record = audit('aud_1', 'org_1', { data: { nested: { count: 1 } } });
    await repo.appendAudit(record);
    await repo.upsertProfile(profile('user_a'));
    const written = custom('act_1');
    await repo.createCustomAction(written);
    const upserted = tracked('act_2', 'scan_1', 'improve:D1.1');
    await upsert(repo, upserted);

    created.name = 'mutated input';
    record.data.nested = 'mutated input';
    written.title = 'mutated input';
    upserted.status = 'done';
    (await upsert(repo, tracked('act_2', 'scan_1', 'improve:D1.1'))).status = 'done';
    (await repo.updateAction('org_1', 'act_1', { updated_by: 'user_a', updated_at: NOW }))!.title = 'mutated';
    (await repo.getCustomAction('org_1', 'act_1'))!.title = 'mutated';
    (await repo.getAssessmentAction('org_1', 'scan_1', 'improve:D1.1'))!.status = 'done';
    (await repo.listActions('org_1'))[0]!.status = 'done';
    (await repo.listAllAudit({ limit: 1 }))[0]!.data.nested = 'mutated';
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
    (await repo.listAudit('org_1', { limit: 1 }))[0]!.data.nested = 'mutated';
    (await repo.getProfile('user_a'))!.email = 'mutated@firm.com';

    expect(await repo.getOrganization('org_1')).toEqual(org('org_1'));
    expect(await repo.listOrganizations()).toEqual([org('org_1')]);
    expect(await repo.listOrganizationsForUser('user_a')).toEqual([{ org: org('org_1'), role: 'owner' }]);
    expect(await repo.getMembership('org_1', 'user_a')).toMatchObject({ role: 'owner' });
    expect(await repo.listAnalyses('org_1')).toEqual([analysis('org_1', 'scan_1')]);
    expect(await repo.findInvitationByHash('hash_inv_1')).toEqual(invitation('inv_1'));
    expect(await repo.getPlan('monthly')).toEqual(DEFAULT_PLANS[0]);
    expect((await repo.listAudit('org_1', { limit: 1 }))[0]!.data).toEqual({ nested: { count: 1 } });
    expect(await repo.getProfile('user_a')).toEqual({ ...profile('user_a'), deleted_at: null });
    expect(await repo.listActions('org_1')).toEqual([custom('act_1'), tracked('act_2', 'scan_1', 'improve:D1.1')]);
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
    await repo.createCustomAction(custom('act_1'));
    await upsert(repo, tracked('act_2', 'scan_1', 'improve:D1.1'));
    const [cursor] = await repo.listAudit('org_1', { limit: 1 });

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
    expect(await repo.listAudit('org_1', { limit: 10 })).toEqual([]);
    expect(await repo.listAllAudit({ limit: 10 })).toEqual([]);
    expect(await repo.listActions('org_1')).toEqual([]);
    expect(await repo.countCustomActions('org_1')).toBe(0);
    expect(await repo.getAssessmentAction('org_1', 'scan_1', 'improve:D1.1')).toBeNull();
    expect(await repo.listPlans()).toEqual(DEFAULT_PLANS);

    // What was remembered to refuse repeats is forgotten too.
    expect(await repo.recordBillingEvent('evt_1', 'x')).toBe(true);
    await repo.createOrganization(org('org_1'), member('org_1', 'user_a', 'owner'), analysis('org_1', 'scan_1'));
    expect(await repo.listAnalyses('org_1')).toHaveLength(1);
    await repo.createCustomAction(custom('act_1'));
    expect(await repo.countCustomActions('org_1')).toBe(1);
    // Like an identity column, seq is never reused: a cursor from before the reset names no row.
    await repo.appendAudit(audit('aud_1', 'org_1'));
    const [after] = await repo.listAudit('org_1', { limit: 1 });
    expect(after!.seq).toBeGreaterThan(cursor!.seq);
    expect(await repo.listAudit('org_1', { before: cursor!.seq, limit: 10 })).toEqual([]);
  });
});

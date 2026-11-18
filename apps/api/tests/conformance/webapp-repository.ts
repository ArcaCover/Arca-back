import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Role } from '@arca/contracts';
import {
  IneligibleAssignee, MAX_CUSTOM_ACTIONS, MemberChangeRefused, WebappConflict, type ActionPatch, type AssessmentActionRecord, type AuditActor,
  type BillingStateRecord, type ClaimTicketRecord, type CustomActionRecord, type DeletionRequestRecord, type InvitationRecord,
  type MemberChange, type MembershipRecord, type NewAuditRecord, type OrgAnalysisRecord, type OrganizationRecord, type ProfileRecord,
  type SubscriptionRecord, type WebappConflictReason, type WebappRepository,
} from '../../src/webapp/types.js';

/**
 * The contract every WebappRepository keeps (DN-13 §11, "suite de conformidad"): the in-memory store, the Supabase one over PGlite
 * and the Supabase one over a real Supabase run these same tests.
 *
 * The suite never assumes an empty store, so it can run against a shared database: every record has fresh ids, every list it reads
 * is filtered to what the test wrote, and its timestamps come from a clock far in the future that moves forward from one run to
 * the next, so the audit rows of the test running are the newest of the store. It leaves its rows behind (the audit log is
 * append-only and organizations are never deleted); against a real Supabase, use a local one (`supabase start`, then
 * `supabase db reset` to wipe it) or Arca-dev, never production. The one shared row it changes, the `monthly` plan, is put back
 * as it was found.
 */
export type ConformanceTarget = {
  repository: WebappRepository;
  /** The id of a scan a store with a scans table holds (a claim needs one); any well-formed id for one without. */
  scan(): Promise<string>;
  close?(): Promise<void>;
};

// Forward from one run to the next (200 ms of future per ms elapsed), one second per tick within a run, and below year 9999.
let clock = Date.UTC(2100, 0, 1) + (Date.now() - Date.UTC(2026, 0, 1)) * 200;
const tick = () => new Date(clock += 1000).toISOString();
const plus = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString();
const DAY = 24 * 60 * 60 * 1000;

const uuid = () => randomUUID();
const hash = () => randomBytes(32).toString('hex');
const sorted = <T>(values: T[]) => [...values].sort();
const member = (userId: string): AuditActor => ({ actor_kind: 'member', actor_user_id: userId });
const change = (actorUserId: string, actorRole: Role, at = tick()): MemberChange => ({ actorUserId, actorRole, audit: member(actorUserId), at });

const profileOf = (userId: string, patch: Partial<ProfileRecord> = {}): ProfileRecord => ({ user_id: userId, email: `${userId}@firm.example`,
  full_name: null, last_org_id: null, created_at: tick(), ...patch });
const orgOf = (id: string, createdBy: string, patch: Partial<OrganizationRecord> = {}): OrganizationRecord => ({ id, name: `Org ${id.slice(0, 8)}`,
  domain: 'firm.example', billing_status: 'pending_payment', deleted_at: null, created_by: createdBy, created_at: tick(), ...patch });
const membershipOf = (orgId: string, userId: string, role: Role = 'member'): MembershipRecord => ({ org_id: orgId, user_id: userId, role,
  invited_by: null, created_at: tick() });
const analysisOf = (orgId: string, scanId: string): OrgAnalysisRecord => ({ org_id: orgId, scan_id: scanId, assessment_id: null,
  claimed_by: uuid(), claimed_at: tick() });

function invitationOf(orgId: string, patch: Partial<InvitationRecord> = {}): InvitationRecord {
  const createdAt = tick();
  return { id: uuid(), org_id: orgId, email: `${uuid()}@firm.example`, role: 'member', token_hash: hash(), invited_by: uuid(),
    expires_at: plus(createdAt, 7 * DAY), accepted_at: null, revoked_at: null, created_at: createdAt, ...patch };
}
const deletionOf = (orgId: string, patch: Partial<DeletionRequestRecord> = {}): DeletionRequestRecord => ({ id: uuid(), org_id: orgId,
  requested_by: uuid(), reason: 'We left the firm', status: 'pending', reviewed_by: null, reviewed_at: null, review_note: null,
  created_at: tick(), ...patch });
const auditOf = (orgId: string | null, patch: Partial<NewAuditRecord> = {}): NewAuditRecord => ({ id: uuid(), actor_kind: 'member',
  actor_user_id: uuid(), org_id: orgId, action: 'member.invited', target: 'guest@firm.example', data: {}, created_at: tick(), ...patch });
function customOf(orgId: string, patch: Partial<CustomActionRecord> = {}): CustomActionRecord {
  const at = tick();
  const by = uuid();
  return { id: uuid(), org_id: orgId, source: 'custom', scan_id: null, action_key: null, title: 'Write an AI policy', detail: null, domain: null,
    status: 'todo', assignee_user_id: null, due_date: null, created_by: by, created_at: at, updated_by: by, updated_at: at, ...patch };
}
function trackedOf(orgId: string, scanId: string, actionKey: string, patch: Partial<AssessmentActionRecord> = {}): AssessmentActionRecord {
  const at = tick();
  const by = uuid();
  return { id: uuid(), org_id: orgId, source: 'assessment', scan_id: scanId, action_key: actionKey, title: null, detail: null, domain: null,
    status: 'todo', assignee_user_id: null, due_date: null, created_by: by, created_at: at, updated_by: by, updated_at: at, ...patch };
}
const stateOf = (subscriptionId: string, patch: Partial<BillingStateRecord> = {}): BillingStateRecord => ({ status: 'active', plan_code: 'monthly',
  customer_id: 'cus_Conf1', subscription_id: subscriptionId, current_period_end: plus(tick(), 30 * DAY), provider_status: 'active',
  price_id: null, cancel_at_period_end: false, current_period_start: null, livemode: false, ...patch });
const subscriptionId = () => `sub_${randomBytes(8).toString('hex')}`;
const eventOf = (type = 'customer.subscription.updated') => ({ id: `evt_${randomBytes(8).toString('hex')}`, type, livemode: false });

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(() => { throw new Error('Expected the write to be refused'); }, (error: unknown) => error);
}
async function expectConflict(promise: Promise<unknown>, reason: WebappConflictReason) {
  const error = await rejection(promise);
  expect(error).toBeInstanceOf(WebappConflict);
  expect(error).toMatchObject({ reason });
}

export function describeWebappRepository(name: string, setup: () => Promise<ConformanceTarget>, options: { skip?: boolean } = {}) {
  describe.skipIf(options.skip ?? false)(`WebappRepository conformance: ${name}`, () => {
    let target: ConformanceTarget;
    let repo: WebappRepository;
    beforeAll(async () => {
      target = await setup();
      repo = target.repository;
    }, 120_000);
    afterAll(async () => { await target?.close?.(); });

    /** An organization with its owner, who has a profile. */
    async function organization(options: { scan?: boolean } = {}) {
      const owner = uuid();
      await repo.upsertProfile(profileOf(owner));
      const id = uuid();
      const scanId = options.scan ? await target.scan() : null;
      await repo.createOrganization(orgOf(id, owner), membershipOf(id, owner, 'owner'), scanId ? analysisOf(id, scanId) : null);
      return { id, owner, scanId: scanId! };
    }
    async function join(orgId: string, role: Role = 'member', userId = uuid()) {
      if (!(await repo.getProfile(userId))) await repo.upsertProfile(profileOf(userId));
      await repo.addMember(membershipOf(orgId, userId, role));
      return userId;
    }
    const roleOf = async (orgId: string, userId: string) => (await repo.getMembership(orgId, userId))?.role ?? null;
    const auditOfOrg = async (orgId: string) => (await repo.listAudit(orgId, { limit: 500 })).reverse()
      .map(({ action, actor_kind, actor_user_id, target: t, data }) => ({ action, actor_kind, actor_user_id, target: t, data }));
    const holders = async (orgId: string) => (await repo.listActions(orgId)).map(action => action.assignee_user_id);

    describe('organizations and profiles', () => {
      it('creates an organization with its owner and its claimed analysis, atomically (scan_claimed)', async () => {
        const owner = uuid();
        const id = uuid();
        const scanId = await target.scan();
        const org = orgOf(id, owner);
        await repo.createOrganization(org, membershipOf(id, owner, 'owner'), analysisOf(id, scanId));
        expect(await repo.getOrganization(id)).toEqual(org);
        expect(await repo.getMembership(id, owner)).toMatchObject({ org_id: id, user_id: owner, role: 'owner' });
        expect((await repo.listAnalyses(id)).map(a => a.scan_id)).toEqual([scanId]);

        const [other, otherOwner] = [uuid(), uuid()];
        await expectConflict(repo.createOrganization(orgOf(other, otherOwner), membershipOf(other, otherOwner, 'owner'), analysisOf(other, scanId)),
          'scan_claimed');
        expect(await repo.getOrganization(other)).toBeNull();
        expect(await repo.getMembership(other, otherOwner)).toBeNull();
        expect(await repo.listOrganizationsForUser(otherOwner)).toEqual([]);
        expect((await repo.listOrganizations()).map(o => o.id)).not.toContain(other);
      });

      it('starts an organization without an analysis, never without its owner, and never twice', async () => {
        const { id } = await organization();
        expect(await repo.listAnalyses(id)).toEqual([]);
        expect(await repo.getOrganization(id)).toMatchObject({ id, billing_status: 'pending_payment', deleted_at: null });
        const [fresh, owner] = [uuid(), uuid()];
        await expect(repo.createOrganization(orgOf(fresh, owner), membershipOf(fresh, owner, 'admin'), null)).rejects.toThrow('Invalid organization');
        await expect(repo.createOrganization(orgOf(fresh, owner), membershipOf(uuid(), owner, 'owner'), null)).rejects.toThrow('Invalid organization');
        await expect(repo.createOrganization(orgOf(fresh, owner), membershipOf(fresh, owner, 'owner'), analysisOf(uuid(), await target.scan())))
          .rejects.toThrow('Invalid organization');
        expect(await repo.getOrganization(fresh)).toBeNull();
        await expect(repo.createOrganization(orgOf(id, owner), membershipOf(id, owner, 'owner'), null)).rejects.toThrow('Duplicate organization');
        expect(await repo.listMembers(id)).toHaveLength(1);
      });

      it('lists the organizations of a user with the role held in each, deleted ones included', async () => {
        const first = await organization();
        const second = await organization();
        await join(second.id, 'viewer', first.owner);
        await repo.markOrganizationDeleted(second.id, tick());
        expect(sorted((await repo.listOrganizationsForUser(first.owner)).map(({ org, role }) => `${org.id}:${role}`)))
          .toEqual(sorted([`${first.id}:owner`, `${second.id}:viewer`]));
        expect((await repo.listOrganizationsForUser(second.owner)).map(({ org }) => org)).toEqual([await repo.getOrganization(second.id)]);
        expect(await repo.listOrganizationsForUser(uuid())).toEqual([]);
        const all = (await repo.listOrganizations()).map(o => o.id);
        expect(all).toEqual(expect.arrayContaining([first.id, second.id]));
      });

      it('renames one organization and nothing else', async () => {
        const first = await organization();
        const second = await organization();
        const before = (await repo.getOrganization(second.id))!;
        await repo.updateOrganizationName(first.id, 'Renamed LLP');
        expect(await repo.getOrganization(first.id)).toMatchObject({ name: 'Renamed LLP', billing_status: 'pending_payment' });
        expect(await repo.getOrganization(second.id)).toEqual(before);
        await expect(repo.updateOrganizationName(uuid(), 'Renamed LLP')).rejects.toThrow('Organization not found');
      });

      it('upserts a profile by user, finds it by email in any case, and keeps one profile per email', async () => {
        const userId = uuid();
        expect(await repo.getProfile(userId)).toBeNull();
        const created = profileOf(userId);
        await repo.upsertProfile(created);
        const { id } = await organization();
        await repo.upsertProfile({ ...created, full_name: 'Ana', last_org_id: id });
        expect(await repo.getProfile(userId)).toEqual({ ...created, full_name: 'Ana', last_org_id: id });
        expect(await repo.findProfileByEmail(created.email.toUpperCase())).toEqual({ ...created, full_name: 'Ana', last_org_id: id });
        expect(await repo.findProfileByEmail(`${uuid()}@firm.example`)).toBeNull();
        await expect(repo.upsertProfile(profileOf(uuid(), { email: created.email }))).rejects.toThrow();
        expect(await repo.findProfileByEmail(created.email)).toMatchObject({ user_id: userId });
      });
    });

    describe('members', () => {
      it('adds a member once (already_member)', async () => {
        const { id, owner } = await organization();
        const userId = await join(id, 'viewer');
        await expectConflict(repo.addMember(membershipOf(id, userId, 'admin')), 'already_member');
        await expectConflict(repo.addMember(membershipOf(id, owner, 'member')), 'already_member');
        expect(sorted((await repo.listMembers(id)).map(m => `${m.user_id}:${m.role}`))).toEqual(sorted([`${owner}:owner`, `${userId}:viewer`]));
      });

      it('keeps the last owner, neither demoted nor removed', async () => {
        const { id, owner } = await organization();
        // Owners of other organizations do not count.
        const elsewhere = await organization();
        await join(elsewhere.id, 'owner', owner);
        await expectConflict(repo.setRole(id, owner, 'admin', change(owner, 'owner')), 'last_owner');
        await expectConflict(repo.removeMember(id, owner, change(owner, 'owner')), 'last_owner');
        expect(await roleOf(id, owner)).toBe('owner');
        const second = await join(id, 'admin');
        expect(await repo.setRole(id, second, 'owner', change(owner, 'owner'))).toBe('admin');
        expect(await repo.setRole(id, owner, 'admin', change(second, 'owner'))).toBe('owner');
        await expectConflict(repo.removeMember(id, second, change(second, 'owner')), 'last_owner');
        await expectConflict(repo.setRole(id, second, 'viewer', change(second, 'owner')), 'last_owner');
        expect(await roleOf(id, second)).toBe('owner');
      });

      it('returns the role it found, null for nobody, and audits each change with that role', async () => {
        const { id, owner } = await organization();
        const userId = await join(id, 'member');
        expect(await repo.setRole(id, uuid(), 'admin', change(owner, 'owner'))).toBeNull();
        expect(await repo.removeMember(id, uuid(), change(owner, 'owner'))).toBeNull();
        // In an organization the actor does not belong to, the actor check comes first.
        expect(await rejection(repo.setRole(uuid(), userId, 'admin', change(owner, 'owner')))).toBeInstanceOf(MemberChangeRefused);
        expect(await repo.setRole(id, userId, 'admin', change(owner, 'owner'))).toBe('member');
        // The same role again writes and audits nothing.
        expect(await repo.setRole(id, userId, 'admin', change(owner, 'owner'))).toBe('admin');
        expect(await repo.removeMember(id, userId, change(owner, 'owner'))).toBe('admin');
        // The second of two removals finds nobody.
        expect(await repo.removeMember(id, userId, change(owner, 'owner'))).toBeNull();
        expect(await repo.setRole(id, userId, 'viewer', change(owner, 'owner'))).toBeNull();
        expect((await repo.listMembers(id)).map(m => m.user_id)).toEqual([owner]);
        expect(await auditOfOrg(id)).toEqual([
          { action: 'member.role_changed', actor_kind: 'member', actor_user_id: owner, target: userId, data: { from: 'member', to: 'admin' } },
          { action: 'member.removed', actor_kind: 'member', actor_user_id: owner, target: userId, data: { role: 'admin' } }]);
      });

      it('checks the actor\'s right again against the roles it finds, and writes nothing when it no longer holds (DN-13 §4.6)', async () => {
        const { id, owner } = await organization();
        const admin = await join(id, 'admin');
        const target = await join(id, 'member');
        // The admin read the target as a member; the owner's promotion lands first.
        await repo.setRole(id, target, 'owner', change(owner, 'owner'));
        expect(await rejection(repo.setRole(id, target, 'viewer', change(admin, 'admin')))).toBeInstanceOf(MemberChangeRefused);
        expect(await rejection(repo.removeMember(id, target, change(admin, 'admin')))).toBeInstanceOf(MemberChangeRefused);
        expect(await roleOf(id, target)).toBe('owner');
        // An actor demoted meanwhile no longer acts with the role the service read.
        await repo.setRole(id, admin, 'member', change(owner, 'owner'));
        const other = await join(id, 'viewer');
        expect(await rejection(repo.setRole(id, other, 'member', change(admin, 'admin')))).toBeInstanceOf(MemberChangeRefused);
        expect(await rejection(repo.removeMember(id, other, change(uuid(), 'owner')))).toBeInstanceOf(MemberChangeRefused);
        expect(await roleOf(id, other)).toBe('viewer');
        expect((await auditOfOrg(id)).map(row => row.data)).toEqual([{ from: 'member', to: 'owner' }, { from: 'admin', to: 'member' }]);
      });

      it('releases a user\'s actions in the same call that makes them viewer or removes them, and only there (DN-11 D11, D15)', async () => {
        const { id, owner, scanId } = await organization({ scan: true });
        const other = await organization();
        const userB = await join(id);
        const userC = await join(id);
        await join(other.id, 'member', userC);
        await repo.createCustomAction(customOf(id, { assignee_user_id: userB }));
        await repo.createCustomAction(customOf(id, { assignee_user_id: userC }));
        const row = trackedOf(id, scanId, 'improve:D1.1', { assignee_user_id: userB, due_date: '2026-12-01' });
        await repo.upsertAssessmentAction(row, { assignee_user_id: userB, due_date: '2026-12-01', updated_by: row.updated_by, updated_at: row.updated_at });
        await repo.createCustomAction(customOf(other.id, { assignee_user_id: userC }));
        await repo.createCustomAction(customOf(id, { assignee_user_id: owner }));

        await repo.setRole(id, userB, 'admin', change(owner, 'owner'));
        await repo.setRole(id, userB, 'member', change(owner, 'owner'));
        expect(await holders(id)).toEqual([userB, userC, userB, owner]);
        await repo.setRole(id, userB, 'viewer', change(owner, 'owner'));
        expect(await holders(id)).toEqual([null, userC, null, owner]);
        // The rest of each row stays as it was.
        expect((await repo.getAssessmentAction(id, scanId, 'improve:D1.1'))).toMatchObject({ due_date: '2026-12-01', status: 'todo' });
        await repo.setRole(id, userB, 'member', change(owner, 'owner'));
        expect(await holders(id)).toEqual([null, userC, null, owner]);
        await repo.removeMember(id, userC, change(owner, 'owner'));
        expect(await holders(id)).toEqual([null, null, null, owner]);
        expect(await holders(other.id)).toEqual([userC]);
        // A refused change releases nothing either.
        await expectConflict(repo.setRole(id, owner, 'viewer', change(owner, 'owner')), 'last_owner');
        await expectConflict(repo.removeMember(id, owner, change(owner, 'owner')), 'last_owner');
        expect(await holders(id)).toEqual([null, null, null, owner]);
      });

      it('revokes the pending links of a removed member\'s email in that organization only', async () => {
        const { id, owner } = await organization();
        const other = await organization();
        const userId = await join(id);
        const email = (await repo.getProfile(userId))!.email;
        const link = invitationOf(id, { email });
        const elsewhere = invitationOf(other.id, { email });
        await repo.createInvitation(link);
        await repo.createInvitation(elsewhere);
        const at = tick();
        expect(await repo.removeMember(id, userId, change(owner, 'owner', at))).toBe('member');
        expect(await repo.findInvitationByHash(link.token_hash)).toMatchObject({ revoked_at: at });
        expect(await repo.findInvitationByHash(elsewhere.token_hash)).toMatchObject({ revoked_at: null });
        expect(await auditOfOrg(id)).toEqual([
          { action: 'member.removed', actor_kind: 'member', actor_user_id: owner, target: userId, data: { role: 'member' } },
          { action: 'invitation.revoked', actor_kind: 'member', actor_user_id: owner, target: email, data: { invitationId: link.id, reason: 'member_removed' } }]);
      });

      it('settles a role change racing a removal: the member is gone and the audit tells one consistent story', async () => {
        const { id, owner } = await organization();
        const admin = await join(id, 'admin');
        const userId = await join(id, 'member');
        const [changed, removed] = await Promise.all([repo.setRole(id, userId, 'viewer', change(owner, 'owner')),
          repo.removeMember(id, userId, change(admin, 'admin'))]);
        expect(await roleOf(id, userId)).toBeNull();
        const actions = (await auditOfOrg(id)).map(row => row.action);
        if (changed === null) {
          expect(removed).toBe('member');
          expect(actions).toEqual(['member.removed']);
        } else {
          expect(changed).toBe('member');
          expect(removed).toBe('viewer');
          expect(actions).toEqual(['member.role_changed', 'member.removed']);
        }
      });
    });

    describe('invitations', () => {
      it('lists only the pending ones, while any of them can still be found by its hash', async () => {
        const { id } = await organization();
        const other = await organization();
        const [pending, accepted, revoked, elsewhere] = [invitationOf(id), invitationOf(id), invitationOf(id), invitationOf(other.id)];
        for (const invitation of [pending, accepted, revoked, elsewhere]) await repo.createInvitation(invitation);
        const at = tick();
        await repo.updateInvitation(accepted.id, { accepted_at: at });
        await repo.updateInvitation(revoked.id, { revoked_at: at });
        expect(await repo.listInvitations(id)).toEqual([pending]);
        expect(await repo.findInvitationByHash(accepted.token_hash)).toEqual({ ...accepted, accepted_at: at });
        expect(await repo.findInvitationByHash(revoked.token_hash)).toEqual({ ...revoked, revoked_at: at });
        expect(await repo.findInvitationByHash(hash())).toBeNull();
      });

      it('updates only the fields given, and refuses an unknown invitation', async () => {
        const { id } = await organization();
        const invitation = invitationOf(id);
        await repo.createInvitation(invitation);
        const at = tick();
        await repo.updateInvitation(invitation.id, { revoked_at: at });
        await repo.updateInvitation(invitation.id, {});
        expect(await repo.findInvitationByHash(invitation.token_hash)).toEqual({ ...invitation, revoked_at: at });
        await expect(repo.updateInvitation(uuid(), { revoked_at: at })).rejects.toThrow('Invitation not found');
      });

      it('refuses a second invitation with the same id or token, and a second pending one per email (already_invited)', async () => {
        const { id } = await organization();
        const invitation = invitationOf(id);
        await repo.createInvitation(invitation);
        await expect(repo.createInvitation({ ...invitationOf(id), id: invitation.id })).rejects.toThrow('Duplicate invitation');
        await expect(repo.createInvitation({ ...invitationOf(id), token_hash: invitation.token_hash })).rejects.toThrow('Duplicate invitation');
        await expectConflict(repo.createInvitation(invitationOf(id, { email: invitation.email.toUpperCase() })), 'already_invited');
        expect(await repo.listInvitations(id)).toEqual([invitation]);
        // Revoked, the email may be invited again.
        await repo.updateInvitation(invitation.id, { revoked_at: tick() });
        await repo.createInvitation(invitationOf(id, { email: invitation.email }));
        expect(await repo.listInvitations(id)).toHaveLength(1);
      });

      it('accepts an invitation in one step and only once (invitation_closed)', async () => {
        const { id } = await organization();
        const guest = uuid();
        await repo.upsertProfile(profileOf(guest));
        const invitation = invitationOf(id, { role: 'admin', email: (await repo.getProfile(guest))!.email });
        await repo.createInvitation(invitation);
        const at = tick();
        expect(await repo.acceptInvitation(invitation.id, guest, at, member(guest))).toEqual({ joined: true, role: 'admin' });
        expect(await repo.getMembership(id, guest)).toMatchObject({ role: 'admin', invited_by: invitation.invited_by });
        expect(await repo.findInvitationByHash(invitation.token_hash)).toMatchObject({ accepted_at: at, revoked_at: null });
        await expectConflict(repo.acceptInvitation(invitation.id, guest, tick(), member(guest)), 'invitation_closed');
        await expect(repo.acceptInvitation(uuid(), guest, tick(), member(guest))).rejects.toThrow('Invitation not found');
        expect(await auditOfOrg(id)).toEqual([{ action: 'member.joined', actor_kind: 'member', actor_user_id: guest, target: guest,
          data: { role: 'admin', invitationId: invitation.id } }]);
      });

      it('closes the invitation of someone who already belongs and keeps their role', async () => {
        const { id } = await organization();
        const userId = await join(id, 'viewer');
        const invitation = invitationOf(id, { role: 'admin', email: (await repo.getProfile(userId))!.email });
        await repo.createInvitation(invitation);
        expect(await repo.acceptInvitation(invitation.id, userId, tick(), member(userId))).toEqual({ joined: false, role: 'viewer' });
        expect(await roleOf(id, userId)).toBe('viewer');
        expect(await repo.listInvitations(id)).toEqual([]);
        expect(await auditOfOrg(id)).toEqual([]);
      });

      it('lets exactly one of two racing accepts in', async () => {
        const { id } = await organization();
        const guest = uuid();
        const invitation = invitationOf(id);
        await repo.createInvitation(invitation);
        const results = await Promise.allSettled([repo.acceptInvitation(invitation.id, guest, tick(), member(guest)),
          repo.acceptInvitation(invitation.id, guest, tick(), member(guest))]);
        expect(results.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected']);
        expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { reason: 'invitation_closed' } });
        expect((await auditOfOrg(id)).map(row => row.action)).toEqual(['member.joined']);
      });

      it('revokes an invitation once: the second of two revokes, or another organization\'s, writes nothing', async () => {
        const { id, owner } = await organization();
        const other = await organization();
        const invitation = invitationOf(id);
        await repo.createInvitation(invitation);
        expect(await repo.revokeInvitation(other.id, invitation.id, tick(), member(other.owner), null)).toBe(false);
        const at = tick();
        const results = await Promise.all([repo.revokeInvitation(id, invitation.id, at, member(owner), null),
          repo.revokeInvitation(id, invitation.id, at, member(owner), null)]);
        expect(results.sort()).toEqual([false, true]);
        expect(await repo.revokeInvitation(id, uuid(), tick(), member(owner), null)).toBe(false);
        expect(await repo.findInvitationByHash(invitation.token_hash)).toMatchObject({ revoked_at: at });
        const reinvited = invitationOf(id);
        await repo.createInvitation(reinvited);
        expect(await repo.revokeInvitation(id, reinvited.id, tick(), member(owner), 'reinvited')).toBe(true);
        expect(await auditOfOrg(id)).toEqual([
          { action: 'invitation.revoked', actor_kind: 'member', actor_user_id: owner, target: invitation.email, data: { invitationId: invitation.id } },
          { action: 'invitation.revoked', actor_kind: 'member', actor_user_id: owner, target: reinvited.email,
            data: { invitationId: reinvited.id, reason: 'reinvited' } }]);
      });
    });

    describe('analyses and claim tickets', () => {
      it('claims a scan once, by one organization only, and finds its claim', async () => {
        const first = await organization();
        const second = await organization();
        const [scanA, scanB] = [await target.scan(), await target.scan()];
        const claim = analysisOf(first.id, scanA);
        await repo.claimAnalysis(claim);
        await expectConflict(repo.claimAnalysis(analysisOf(first.id, scanA)), 'scan_claimed');
        await expectConflict(repo.claimAnalysis(analysisOf(second.id, scanA)), 'scan_claimed');
        await repo.claimAnalysis(analysisOf(first.id, scanB));
        expect(sorted((await repo.listAnalyses(first.id)).map(a => a.scan_id))).toEqual(sorted([scanA, scanB]));
        expect(await repo.listAnalyses(second.id)).toEqual([]);
        expect(await repo.getAnalysisByScan(scanA)).toEqual(claim);
        expect(await repo.getAnalysisByScan(await target.scan())).toBeNull();
      });

      it('spends a claim ticket once, and keeps one ticket per id', async () => {
        const ticket: ClaimTicketRecord = { id_hash: hash(), scan_id: await target.scan(), email: 'owner@firm.example', expires_at: plus(tick(), DAY),
          used_at: null };
        await repo.createClaimTicket(ticket);
        expect(await repo.getClaimTicket(ticket.id_hash)).toEqual(ticket);
        const at = tick();
        expect(await Promise.all([repo.markClaimTicketUsed(ticket.id_hash, at), repo.markClaimTicketUsed(ticket.id_hash, at)]).then(r => r.sort()))
          .toEqual([false, true]);
        expect(await repo.getClaimTicket(ticket.id_hash)).toEqual({ ...ticket, used_at: at });
        await expect(repo.createClaimTicket(ticket)).rejects.toThrow('Duplicate claim ticket');
        expect(await repo.getClaimTicket(hash())).toBeNull();
        expect(await repo.markClaimTicketUsed(hash(), at)).toBe(false);
      });
    });

    describe('plans and billing', () => {
      it('updates only the fields given and never the code, and puts the plan back', async () => {
        const before = (await repo.getPlan('monthly'))!;
        expect(before).toMatchObject({ code: 'monthly', interval: 'month' });
        expect((await repo.listPlans()).map(plan => plan.code)).toEqual(expect.arrayContaining(['monthly', 'annual']));
        const annual = await repo.getPlan('annual');
        try {
          await repo.updatePlan('monthly', { amount_cents: before.amount_cents + 100, active: false });
          expect(await repo.getPlan('monthly')).toEqual({ ...before, amount_cents: before.amount_cents + 100, active: false });
          await repo.updatePlan('monthly', {});
          expect(await repo.getPlan('monthly')).toEqual({ ...before, amount_cents: before.amount_cents + 100, active: false });
          expect(await repo.getPlan('annual')).toEqual(annual);
        } finally {
          await repo.updatePlan('monthly', { name: before.name, amount_cents: before.amount_cents, currency: before.currency,
            interval: before.interval, active: before.active });
        }
        expect(await repo.getPlan('monthly')).toEqual(before);
        expect(await repo.getPlan(`weekly_${uuid()}`)).toBeNull();
        await expect(repo.updatePlan(`weekly_${uuid()}`, { active: false })).rejects.toThrow('Plan not found');
      });

      it('keeps the subscription of an organization, one per provider id, and moves its billing status apart', async () => {
        const { id } = await organization();
        const other = await organization();
        expect(await repo.getSubscription(id)).toBeNull();
        const sub = subscriptionId();
        const record: SubscriptionRecord = { org_id: id, plan_code: 'monthly', customer_id: 'cus_Conf2', subscription_id: sub, status: 'active',
          current_period_end: plus(tick(), 30 * DAY), updated_at: tick() };
        await repo.upsertSubscription({ ...record, status: 'pending_payment', subscription_id: null });
        await repo.upsertSubscription(record);
        expect(await repo.getSubscription(id)).toEqual(record);
        await expect(repo.upsertSubscription({ ...record, org_id: other.id })).rejects.toThrow();
        expect(await repo.getSubscription(other.id)).toBeNull();
        await repo.setBillingStatus(id, 'active');
        expect((await repo.getOrganization(id))?.billing_status).toBe('active');
        await repo.setBillingStatus(id, 'past_due');
        expect((await repo.getOrganization(id))?.billing_status).toBe('past_due');
        await expect(repo.setBillingStatus(uuid(), 'active')).rejects.toThrow('Organization not found');
      });

      it('sees a billing event once', async () => {
        const id = eventOf().id;
        expect(await repo.recordBillingEvent(id, 'x')).toBe(true);
        expect(await repo.recordBillingEvent(id, 'x')).toBe(false);
        expect(await repo.recordBillingEvent(id, 'another.type')).toBe(false);
        expect(await repo.recordBillingEvent(eventOf().id, 'x')).toBe(true);
      });

      it('applies a billing state with its event in one step, and the same event again, or racing, changes nothing', async () => {
        const { id } = await organization();
        const sub = subscriptionId();
        const event = eventOf('checkout.session.completed');
        const at = tick();
        const results = await Promise.all([repo.applyBillingState(event, id, stateOf(sub), at),
          repo.applyBillingState(event, id, stateOf(sub, { status: 'canceled' }), at)]);
        expect(results.sort()).toEqual(['applied', 'duplicate']);
        const subscription = (await repo.getSubscription(id))!;
        expect(subscription).toMatchObject({ org_id: id, plan_code: 'monthly', customer_id: 'cus_Conf1', subscription_id: sub, updated_at: at });
        expect((await repo.getOrganization(id))!.billing_status).toBe(subscription.status);
        expect(await repo.applyBillingState(event, id, stateOf(sub, { status: 'past_due' }), tick())).toBe('duplicate');
        // An event seen but never processed is still applied.
        const seen = eventOf();
        await repo.recordBillingEvent(seen.id, seen.type);
        expect(await repo.applyBillingState(seen, id, { status: 'past_due', plan_code: null, customer_id: null, subscription_id: null,
          current_period_end: null }, tick())).toBe('applied');
        expect(await repo.getSubscription(id)).toMatchObject({ plan_code: 'monthly', customer_id: 'cus_Conf1', subscription_id: sub,
          status: 'past_due', current_period_end: subscription.current_period_end });
        expect((await repo.getOrganization(id))!.billing_status).toBe('past_due');
        const audit = await auditOfOrg(id);
        expect(audit.map(({ action, actor_kind, actor_user_id, target: t }) => [action, actor_kind, actor_user_id, t]))
          .toEqual([['billing.event_applied', 'system', null, event.id], ['billing.event_applied', 'system', null, seen.id]]);
        expect(audit[1]!.data).toEqual({ type: seen.type, status: 'past_due', planCode: 'monthly' });
        await expect(repo.applyBillingState(eventOf(), uuid(), stateOf(subscriptionId()), tick())).rejects.toThrow('Organization not found');
      });

      it('never lets another subscription overwrite a live one, and lets a new one in once the old one is canceled', async () => {
        const { id } = await organization();
        const [first, second, third] = [subscriptionId(), subscriptionId(), subscriptionId()];
        expect(await repo.applyBillingState(eventOf(), id, { status: 'pending_payment', plan_code: null, customer_id: null, subscription_id: null,
          current_period_end: null }, tick())).toBe('applied');
        expect(await repo.getSubscription(id)).toBeNull();
        await repo.applyBillingState(eventOf(), id, stateOf(first), tick());
        expect(await repo.applyBillingState(eventOf(), id, stateOf(second), tick())).toBe('duplicate_subscription');
        expect(await repo.applyBillingState(eventOf(), id, stateOf(second, { status: 'canceled' }), tick())).toBe('stale_subscription');
        expect(await repo.getSubscription(id)).toMatchObject({ subscription_id: first, status: 'active' });
        await repo.applyBillingState(eventOf(), id, stateOf(first, { status: 'canceled' }), tick());
        expect(await repo.applyBillingState(eventOf(), id, stateOf(third), tick())).toBe('applied');
        expect(await repo.getSubscription(id)).toMatchObject({ subscription_id: third, status: 'active' });
        expect((await auditOfOrg(id)).map(row => row.action)).toEqual(['billing.event_applied', 'billing.event_applied',
          'billing.duplicate_subscription', 'billing.event_applied', 'billing.event_applied']);
      });
    });

    describe('deletion requests', () => {
      it('keeps one pending request per organization, and a review frees it', async () => {
        const first = await organization();
        const second = await organization();
        const pending = deletionOf(first.id);
        await repo.createDeletionRequest(pending);
        const refused = deletionOf(first.id);
        await expectConflict(repo.createDeletionRequest(refused), 'deletion_pending');
        expect(await repo.getDeletionRequest(refused.id)).toBeNull();
        expect(await repo.getPendingDeletionRequest(first.id)).toEqual(pending);
        await repo.createDeletionRequest(deletionOf(second.id));
        await repo.reviewDeletionRequest(pending.id, 'rejected', uuid(), 'Please contact us first', tick(), { actor_kind: 'platform', actor_user_id: uuid() });
        expect(await repo.getPendingDeletionRequest(first.id)).toBeNull();
        const again = deletionOf(first.id);
        await repo.createDeletionRequest(again);
        expect((await repo.getPendingDeletionRequest(first.id))?.id).toBe(again.id);
        await expect(repo.createDeletionRequest({ ...deletionOf(second.id), id: pending.id, status: 'rejected' })).rejects.toThrow('Duplicate deletion request');
        const mine = (await repo.listDeletionRequests()).filter(r => r.org_id === first.id || r.org_id === second.id);
        expect(sorted(mine.map(r => `${r.org_id === first.id ? 'first' : 'second'}:${r.status}`)))
          .toEqual(['first:pending', 'first:rejected', 'second:pending']);
        expect((await repo.getOrganization(first.id))!.deleted_at).toBeNull();
      });

      it('approves in one step with the deletion mark and the audit, and only once (already_reviewed)', async () => {
        const { id } = await organization();
        const request = deletionOf(id);
        await repo.createDeletionRequest(request);
        const [admin, at] = [uuid(), tick()];
        const staff: AuditActor = { actor_kind: 'platform', actor_user_id: admin };
        const results = await Promise.allSettled([repo.reviewDeletionRequest(request.id, 'approved', admin, null, at, staff),
          repo.reviewDeletionRequest(request.id, 'rejected', uuid(), 'changed my mind', tick(), staff)]);
        expect(results.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected']);
        expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { reason: 'already_reviewed' } });
        const stored = (await repo.getDeletionRequest(request.id))!;
        const approved = stored.status === 'approved';
        expect(stored).toMatchObject(approved ? { reviewed_by: admin, reviewed_at: at, review_note: null } : { review_note: 'changed my mind' });
        expect((await repo.getOrganization(id))!.deleted_at).toBe(approved ? at : null);
        await expectConflict(repo.reviewDeletionRequest(request.id, 'approved', admin, null, tick(), staff), 'already_reviewed');
        await expect(repo.reviewDeletionRequest(uuid(), 'approved', admin, null, tick(), staff)).rejects.toThrow('Deletion request not found');
        expect(await auditOfOrg(id)).toEqual([{ action: `org.deletion_${stored.status}`, actor_kind: 'platform', actor_user_id: admin,
          target: request.id, data: { note: stored.review_note } }]);
      });

      it('marks an organization deleted without losing the first deletion time', async () => {
        const { id, owner } = await organization();
        const first = tick();
        await repo.markOrganizationDeleted(id, first);
        await repo.markOrganizationDeleted(id, tick());
        expect(await repo.getOrganization(id)).toMatchObject({ deleted_at: first });
        expect((await repo.listOrganizationsForUser(owner)).map(({ org }) => org.id)).toEqual([id]);
        await expect(repo.markOrganizationDeleted(uuid(), tick())).rejects.toThrow('Organization not found');
      });
    });

    describe('the action plan', () => {
      it('finds an action of the organization\'s own only within that organization, and counts them', async () => {
        const first = await organization();
        const second = await organization();
        const action = customOf(first.id, { detail: 'Name an owner for it', domain: 'governance' });
        await repo.createCustomAction(action);
        const theirs = customOf(second.id);
        await repo.createCustomAction(theirs);
        expect(await repo.getCustomAction(first.id, action.id)).toEqual(action);
        expect(await repo.getCustomAction(second.id, action.id)).toBeNull();
        expect(await repo.getCustomAction(first.id, theirs.id)).toBeNull();
        expect(await repo.getCustomAction(first.id, uuid())).toBeNull();
        expect([await repo.countCustomActions(first.id), await repo.countCustomActions(second.id), await repo.countCustomActions(uuid())])
          .toEqual([1, 1, 0]);
        await expect(repo.createCustomAction({ ...customOf(first.id), id: action.id })).rejects.toThrow('Duplicate action');
        await expect(repo.createCustomAction(customOf(uuid()))).rejects.toThrow('Organization not found');
        expect(await repo.countCustomActions(first.id)).toBe(1);
      });

      it('keeps at most 100 actions of an organization\'s own, counted with the insert, even when creations race', async () => {
        const { id, scanId } = await organization({ scan: true });
        for (let index = 0; index < MAX_CUSTOM_ACTIONS - 1; index++) await repo.createCustomAction(customOf(id));
        const row = trackedOf(id, scanId, 'improve:D1.1');
        await repo.upsertAssessmentAction(row, { updated_by: row.updated_by, updated_at: row.updated_at });
        const racing = await Promise.allSettled([customOf(id), customOf(id), customOf(id)].map(action => repo.createCustomAction(action)));
        expect(racing.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected', 'rejected']);
        for (const result of racing) if (result.status === 'rejected') expect(result.reason).toMatchObject({ reason: 'action_limit' });
        expect(await repo.countCustomActions(id)).toBe(MAX_CUSTOM_ACTIONS);
        await expectConflict(repo.createCustomAction(customOf(id)), 'action_limit');
        const other = await organization();
        await repo.createCustomAction(customOf(other.id));
        expect(await repo.countCustomActions(other.id)).toBe(1);
      });

      it('gives an action of the assessment one row per plan, created by the first change and moved by later ones', async () => {
        const { id, owner, scanId } = await organization({ scan: true });
        const newer = await target.scan();
        await repo.claimAnalysis(analysisOf(id, newer));
        const userB = await join(id);
        expect(await repo.getAssessmentAction(id, scanId, 'improve:D1.1')).toBeNull();
        const first = trackedOf(id, scanId, 'improve:D1.1', { status: 'in_progress' });
        expect(await repo.upsertAssessmentAction(first, { status: 'in_progress', updated_by: first.updated_by, updated_at: first.updated_at }))
          .toEqual(first);
        const movedAt = tick();
        const moved = { status: 'done', assignee_user_id: userB, due_date: '2026-12-01', updated_by: userB, updated_at: movedAt } as const;
        const expected = { ...first, ...moved };
        expect(await repo.upsertAssessmentAction(trackedOf(id, scanId, 'improve:D1.1', { ...moved, created_by: userB }), moved)).toEqual(expected);
        expect(await repo.getAssessmentAction(id, scanId, 'improve:D1.1')).toEqual(expected);
        const lateAt = tick();
        expect(await repo.upsertAssessmentAction(trackedOf(id, scanId, 'improve:D1.1'), { assignee_user_id: null, updated_by: owner, updated_at: lateAt }))
          .toEqual({ ...expected, assignee_user_id: null, updated_by: owner, updated_at: lateAt });
        const second = trackedOf(id, newer, 'improve:D1.1');
        await repo.upsertAssessmentAction(second, { updated_by: second.updated_by, updated_at: second.updated_at });
        expect((await repo.listActions(id)).map(a => [a.id, a.scan_id, a.status])).toEqual([[first.id, scanId, 'done'], [second.id, newer, 'todo']]);
        expect(await repo.countCustomActions(id)).toBe(0);
        expect(await repo.getAssessmentAction(id, scanId, 'improve:D1.2')).toBeNull();
        expect(await repo.getCustomAction(id, first.id)).toBeNull();
      });

      it('gives actions only to a scan the organization claimed, and refuses an id already taken', async () => {
        const { id, scanId } = await organization({ scan: true });
        const other = await organization({ scan: true });
        const upsert = (row: AssessmentActionRecord) => repo.upsertAssessmentAction(row, { updated_by: row.updated_by, updated_at: row.updated_at });
        await expect(upsert(trackedOf(id, other.scanId, 'improve:D1.1'))).rejects.toThrow('Analysis not found');
        await expect(upsert(trackedOf(id, await target.scan(), 'improve:D1.1'))).rejects.toThrow('Analysis not found');
        await expect(upsert(trackedOf(other.id, scanId, 'improve:D1.1'))).rejects.toThrow('Analysis not found');
        expect(await repo.listActions(id)).toEqual([]);
        const own = customOf(id);
        await repo.createCustomAction(own);
        await expect(upsert({ ...trackedOf(id, scanId, 'improve:D1.1'), id: own.id })).rejects.toThrow('Duplicate action');
        expect(await repo.listActions(id)).toEqual([own]);
      });

      it('lists every action of one organization, from both sources and every plan, oldest first', async () => {
        const { id, scanId } = await organization({ scan: true });
        const other = await organization();
        const upsert = (row: AssessmentActionRecord) => repo.upsertAssessmentAction(row, { updated_by: row.updated_by, updated_at: row.updated_at });
        const a = customOf(id);
        await repo.createCustomAction(a);
        const b = trackedOf(id, scanId, 'improve:D1.1');
        await upsert(b);
        await repo.createCustomAction(customOf(other.id));
        const c = trackedOf(id, scanId, 'improve:D2.1');
        await upsert(c);
        expect((await repo.listActions(id)).map(action => [action.id, action.source])).toEqual([[a.id, 'custom'], [b.id, 'assessment'],
          [c.id, 'assessment']]);
        expect(await repo.listActions(uuid())).toEqual([]);
      });

      it('updates only the tracked fields given, always recording who changed them and when, and null for a row not there', async () => {
        const { id, owner, scanId } = await organization({ scan: true });
        const other = await organization();
        const userB = await join(id);
        const action = customOf(id);
        await repo.createCustomAction(action);
        const tracked = trackedOf(id, scanId, 'improve:D1.1');
        await repo.upsertAssessmentAction(tracked, { updated_by: tracked.updated_by, updated_at: tracked.updated_at });
        const t1 = tick();
        expect(await repo.updateAction(id, action.id, { status: 'in_progress', updated_by: userB, updated_at: t1 }))
          .toEqual({ ...action, status: 'in_progress', updated_by: userB, updated_at: t1 });
        const t2 = tick();
        await repo.updateAction(id, action.id, { assignee_user_id: userB, due_date: '2026-12-01', updated_by: owner, updated_at: t2 });
        expect(await repo.getCustomAction(id, action.id)).toEqual({ ...action, status: 'in_progress', assignee_user_id: userB, due_date: '2026-12-01',
          updated_by: owner, updated_at: t2 });
        // Null clears; what the row says about itself never moves.
        const t3 = tick();
        await repo.updateAction(id, action.id, { assignee_user_id: null, due_date: null, title: 'Changed', org_id: other.id, created_by: userB,
          updated_by: userB, updated_at: t3 } as ActionPatch);
        expect(await repo.getCustomAction(id, action.id)).toEqual({ ...action, status: 'in_progress', updated_by: userB, updated_at: t3 });
        const t4 = tick();
        expect(await repo.updateAction(id, tracked.id, { status: 'done', updated_by: userB, updated_at: t4 }))
          .toEqual({ ...tracked, status: 'done', updated_by: userB, updated_at: t4 });
        expect(await repo.updateAction(other.id, action.id, { status: 'done', updated_by: userB, updated_at: tick() })).toBeNull();
        expect(await repo.updateAction(id, uuid(), { status: 'done', updated_by: userB, updated_at: tick() })).toBeNull();
        expect((await repo.getCustomAction(id, action.id))?.status).toBe('in_progress');
      });

      it('deletes only an action the organization wrote, within that organization, once', async () => {
        const { id, scanId } = await organization({ scan: true });
        const other = await organization();
        const [a, b] = [customOf(id), customOf(id)];
        await repo.createCustomAction(a);
        await repo.createCustomAction(b);
        const tracked = trackedOf(id, scanId, 'improve:D1.1');
        await repo.upsertAssessmentAction(tracked, { updated_by: tracked.updated_by, updated_at: tracked.updated_at });
        expect(await repo.deleteCustomAction(other.id, a.id)).toBe(false);
        expect(await repo.deleteCustomAction(id, tracked.id)).toBe(false);
        expect(await repo.deleteCustomAction(id, uuid())).toBe(false);
        expect(await Promise.all([repo.deleteCustomAction(id, a.id), repo.deleteCustomAction(id, a.id)]).then(r => r.sort())).toEqual([false, true]);
        expect(await repo.getCustomAction(id, a.id)).toBeNull();
        expect((await repo.listActions(id)).map(action => action.id)).toEqual([b.id, tracked.id]);
      });

      it('refuses, in the write itself, an assignee who is not a member that can mark actions (DN-11 D11)', async () => {
        const { id, owner, scanId } = await organization({ scan: true });
        const other = await organization();
        const userB = await join(id);
        const viewer = await join(id, 'viewer');
        const outsider = await join(other.id);
        const action = customOf(id);
        await repo.createCustomAction(action);
        const tracked = trackedOf(id, scanId, 'improve:D1.1');
        await repo.upsertAssessmentAction(tracked, { updated_by: tracked.updated_by, updated_at: tracked.updated_at });
        for (const userId of [viewer, outsider, uuid()]) {
          const patch = { assignee_user_id: userId, status: 'done', updated_by: owner, updated_at: tick() } as const;
          expect(await rejection(repo.updateAction(id, action.id, patch)), userId).toBeInstanceOf(IneligibleAssignee);
          expect(await rejection(repo.upsertAssessmentAction(trackedOf(id, scanId, 'improve:D1.1', patch), patch))).toBeInstanceOf(IneligibleAssignee);
          expect(await rejection(repo.upsertAssessmentAction(trackedOf(id, scanId, 'improve:D2.1', patch), patch))).toBeInstanceOf(IneligibleAssignee);
          expect(await rejection(repo.createCustomAction(customOf(id, { assignee_user_id: userId })))).toBeInstanceOf(IneligibleAssignee);
        }
        expect(await repo.listActions(id)).toEqual([action, tracked]);
        await repo.setRole(id, viewer, 'admin', change(owner, 'owner'));
        for (const userId of [owner, userB, viewer]) {
          expect(await repo.updateAction(id, action.id, { assignee_user_id: userId, updated_by: owner, updated_at: tick() }))
            .toMatchObject({ assignee_user_id: userId });
          expect(await repo.upsertAssessmentAction(trackedOf(id, scanId, 'improve:D1.1'), { assignee_user_id: userId, updated_by: owner,
            updated_at: tick() })).toMatchObject({ assignee_user_id: userId });
        }
        expect(await repo.updateAction(id, action.id, { assignee_user_id: null, updated_by: owner, updated_at: tick() }))
          .toMatchObject({ assignee_user_id: null });
        expect(await repo.upsertAssessmentAction(trackedOf(id, scanId, 'improve:D1.1'), { status: 'done', updated_by: owner, updated_at: tick() }))
          .toMatchObject({ status: 'done', assignee_user_id: viewer });
      });
    });

    describe('platform admins and the audit log', () => {
      it('grants and revokes the platform role once each, audited only when it changed', async () => {
        const userId = uuid();
        const script = { actor: { actor_kind: 'platform', actor_user_id: null } as AuditActor, at: tick() };
        expect(await repo.isPlatformAdmin(userId)).toBe(false);
        expect(await repo.grantPlatformAdmin(userId, null, script)).toBe(true);
        expect(await repo.grantPlatformAdmin(userId, null, script)).toBe(false);
        expect(await repo.isPlatformAdmin(userId)).toBe(true);
        expect(await repo.revokePlatformAdmin(userId, { ...script, at: tick() })).toBe(true);
        expect(await repo.revokePlatformAdmin(userId, script)).toBe(false);
        expect(await repo.isPlatformAdmin(userId)).toBe(false);
        // As the debug login grants it: no audit.
        expect(await repo.grantPlatformAdmin(userId, userId)).toBe(true);
        expect(await repo.isPlatformAdmin(userId)).toBe(true);
        const rows = (await repo.listAllAudit({ limit: 50 })).filter(row => row.target === userId).reverse();
        expect(rows.map(({ action, actor_kind, actor_user_id, org_id }) => [action, actor_kind, actor_user_id, org_id]))
          .toEqual([['platform_admin.granted', 'platform', null, null], ['platform_admin.revoked', 'platform', null, null]]);
      });

      it('numbers every audit row in order and records the kind of actor it names', async () => {
        const { id } = await organization();
        const rows = [auditOf(id), auditOf(id, { actor_kind: 'system', actor_user_id: null, data: { nested: { count: 1 } } }),
          auditOf(null, { actor_kind: 'platform' })];
        for (const row of rows) await repo.appendAudit(row);
        const listed = await repo.listAllAudit({ limit: 3 });
        expect(listed.map(row => row.id)).toEqual([rows[2]!.id, rows[1]!.id, rows[0]!.id]);
        expect(listed[0]!.seq).toBeGreaterThan(listed[1]!.seq);
        expect(listed[1]!.seq).toBeGreaterThan(listed[2]!.seq);
        expect(await repo.listAudit(id, { limit: 1 })).toEqual([{ ...rows[1], seq: listed[1]!.seq }]);
      });

      it('refuses an audit row that names no kind of actor, rather than take it for a member\'s', async () => {
        const { id } = await organization();
        const { actor_kind: _, ...unnamed } = auditOf(id);
        for (const record of [unnamed, { ...unnamed, actor_kind: undefined }, { ...unnamed, actor_kind: 'arca' }]) {
          await expect(repo.appendAudit({ ...record, id: uuid() } as unknown as NewAuditRecord)).rejects.toThrow('actor kind');
        }
        expect(await repo.listAudit(id, { limit: 10 })).toEqual([]);
      });

      /** One organization gets a1 (now), a3 (earlier, appended late), a4 (later) and a6 (now); a2 belongs to another, a5 to none. */
      async function auditTrail() {
        const first = await organization();
        const second = await organization();
        const [earlier, now, later] = [tick(), tick(), tick()];
        const rows = [auditOf(first.id, { created_at: now }), auditOf(second.id, { created_at: now }), auditOf(first.id, { created_at: earlier }),
          auditOf(first.id, { created_at: later }), auditOf(null, { actor_kind: 'platform', created_at: now }), auditOf(first.id, { created_at: now })];
        for (const row of rows) await repo.appendAudit(row);
        const [a1, a2, a3, a4, a5, a6] = rows.map(row => row.id);
        return { first: first.id, second: second.id, a1, a2, a3, a4, a5, a6 };
      }
      const ids = (rows: Array<{ id: string }>) => rows.map(row => row.id);

      it('lists the audit rows of one organization newest first, then by seq, a page at a time', async () => {
        const t = await auditTrail();
        expect(ids(await repo.listAudit(t.first, { limit: 10 }))).toEqual([t.a4, t.a6, t.a1, t.a3]);
        const first = await repo.listAudit(t.first, { limit: 3 });
        expect(ids(first)).toEqual([t.a4, t.a6, t.a1]);
        // a3 has a higher seq than the cursor but an older time: the page goes on by the order, not by the seq alone.
        const second = await repo.listAudit(t.first, { before: first[2]!.seq, limit: 3 });
        expect(ids(second)).toEqual([t.a3]);
        expect(await repo.listAudit(t.first, { before: second[0]!.seq, limit: 3 })).toEqual([]);
        expect(ids(await repo.listAudit(t.first, { before: first[0]!.seq, limit: 1 }))).toEqual([t.a6]);
        expect(await repo.listAudit(uuid(), { limit: 10 })).toEqual([]);
        expect(await repo.listAudit(t.first, { before: Number.MAX_SAFE_INTEGER, limit: 10 })).toEqual([]);
      });

      it('lists the audit rows of every organization for ARCA, or of one', async () => {
        const t = await auditTrail();
        // The newest rows of the store are this trail's.
        expect(ids(await repo.listAllAudit({ limit: 6 }))).toEqual([t.a4, t.a6, t.a5, t.a2, t.a1, t.a3]);
        const first = await repo.listAllAudit({ limit: 2 });
        expect(ids(await repo.listAllAudit({ before: first[1]!.seq, limit: 2 }))).toEqual([t.a5, t.a2]);
        expect(ids(await repo.listAllAudit({ orgId: t.second, limit: 10 }))).toEqual([t.a2]);
        expect(ids(await repo.listAllAudit({ orgId: t.first, before: first[1]!.seq, limit: 10 }))).toEqual([t.a1, t.a3]);
        expect(await repo.listAllAudit({ orgId: uuid(), limit: 10 })).toEqual([]);
      });

      it('looks a cursor up only within the same filter, so another organization\'s seq gives an empty page', async () => {
        const t = await auditTrail();
        const [theirs] = await repo.listAudit(t.second, { limit: 1 });
        const unowned = (await repo.listAllAudit({ limit: 6 })).find(row => row.id === t.a5)!;
        expect(await repo.listAudit(t.first, { before: theirs!.seq, limit: 10 })).toEqual([]);
        expect(await repo.listAudit(t.first, { before: unowned.seq, limit: 10 })).toEqual([]);
        expect(await repo.listAllAudit({ orgId: t.first, before: theirs!.seq, limit: 10 })).toEqual([]);
        expect(await repo.listAllAudit({ orgId: t.second, before: unowned.seq, limit: 10 })).toEqual([]);
        expect(ids(await repo.listAllAudit({ before: theirs!.seq, limit: 2 }))).toEqual([t.a1, t.a3]);
      });
    });
  });
}

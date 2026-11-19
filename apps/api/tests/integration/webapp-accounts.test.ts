import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActivityPage, AdminOrgDetailView, ClaimResponse, EnrollRequest, EnrollResponse, InvitationView, MeResponse, MemberView, OrgView,
  type Role } from '@arca/contracts';
import { InMemoryAssessmentRepository } from '../../src/assessment/repository.js';
import { issueSessionToken } from '../../src/auth/session-token.js';
import { InMemoryRepository } from '../../src/repositories/in-memory.js';
import { MockAppAuth, mockUserIdFor } from '../../src/webapp/auth.js';
import { AuthAdminUnavailable, InMemoryAuthAdmin, type AuthAdmin } from '../../src/webapp/auth-admin.js';
import { MockBillingProvider } from '../../src/webapp/billing.js';
import { InMemoryWebappRepository } from '../../src/webapp/in-memory.js';
import { DEFAULT_PLANS } from '../../src/webapp/plans.js';
import { webappRoutes } from '../../src/webapp/routes.js';
import { WebappService } from '../../src/webapp/service.js';
import { fixtureResult } from '../fixtures/result.js';

// DN-13 T7 and T11: POST /auth/enroll (closed sign-up, §4.2) and DELETE /me (§4.8), through the routes, over the in-memory store and
// an Auth admin the test controls. Supabase local runs the same flow in real-accounts-supabase.test.ts.
const secret = 's'.repeat(40);
const APP = 'http://localhost:3000';
const HOUR = 60 * 60 * 1000;
type Reply = { status: number; body: unknown; headers: Headers };

/** An Auth admin that fails while `down` is true, and records every call. */
class FlakyAuthAdmin implements AuthAdmin {
  down = false;
  readonly inner = new InMemoryAuthAdmin(mockUserIdFor);
  readonly createUser = vi.fn(async (email: string) => {
    if (this.down) throw new AuthAdminUnavailable('create the user');
    return this.inner.createUser(email);
  });
  readonly deleteUser = vi.fn(async (userId: string) => {
    if (this.down) throw new AuthAdminUnavailable('delete the user');
    return this.inner.deleteUser(userId);
  });
}

function harness() {
  let offset = 0;
  const now = () => Date.now() + offset;
  let ip = '203.0.113.1';
  const scans = new InMemoryRepository();
  const repository = new InMemoryWebappRepository(DEFAULT_PLANS);
  const authAdmin = new FlakyAuthAdmin();
  const auth = new MockAppAuth(secret, now);
  const service = new WebappService({ repository, scans, assessments: new InMemoryAssessmentRepository(), billing: new MockBillingProvider(APP),
    sessionSecret: secret, appBaseUrl: APP, authAdmin, now });
  const app = webappRoutes({ service, auth, clientIp: () => ip, now });

  async function call(method: string, path: string, options: { token?: string; body?: unknown; raw?: string } = {}): Promise<Reply> {
    const body = options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
    const response = await app.request(path, { method, body, headers: { ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) } });
    expect(response.headers.get('Cache-Control'), `${method} ${path}`).toBe('no-store');
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
  }
  /** A finished scan of the funnel for this email, and the claim its results page would get. */
  async function claim(email: string) {
    const scanId = `sc_${randomUUID().replaceAll('-', '')}`;
    const at = new Date(now()).toISOString();
    await scans.create({ id: randomUUID(), scan_id: scanId, email, canonical_domain: 'firm.com', domain_resolution: { status: 'RESOLVED',
      canonicalDomain: 'firm.com', source: 'request', reason: null }, status: 'COMPLETED', result: fixtureResult(scanId, email), created_at: at,
      completed_at: at, duration_ms: 10, cached: false });
    const reply = await call('POST', '/claims', { body: { scanToken: await issueSessionToken(scanId, email, secret) } });
    expect(reply.status).toBe(201);
    return ClaimResponse.parse(reply.body).claimId;
  }
  const login = async (email: string) => (await auth.issue(email)).token;
  /** An owner with a paid organization made from their claim. */
  async function paidOrg(email = 'owner@firm.com') {
    const token = await login(email);
    const created = await call('POST', '/orgs', { token, body: { name: 'Smith & Co', claimId: await claim(email) } });
    expect(created.status).toBe(201);
    const org = OrgView.parse(created.body);
    await repository.setBillingStatus(org.id, 'active');
    return { token, org };
  }
  async function invite(token: string, orgId: string, email: string, role: Exclude<Role, 'owner'> = 'member') {
    const reply = await call('POST', `/orgs/${orgId}/invitations`, { token, body: { email, role } });
    expect(reply.status).toBe(201);
    const view = InvitationView.parse(reply.body);
    return { ...view, token: view.inviteUrl!.split('/').at(-1)! };
  }
  async function join(owner: string, orgId: string, email: string, role: Exclude<Role, 'owner'> = 'member') {
    const invitation = await invite(owner, orgId, email, role);
    const token = await login(email);
    expect((await call('POST', `/invitations/${invitation.token}/accept`, { token })).status).toBe(200);
    return { token, userId: (await auth.verify(token))!.userId };
  }
  const enroll = (body: unknown) => call('POST', '/auth/enroll', { body });
  return { app, call, claim, login, paidOrg, invite, join, enroll, repository, authAdmin, auth,
    advance: (ms: number) => { offset += ms; }, from: (address: string) => { ip = address; } };
}

afterEach(() => { vi.restoreAllMocks(); });

describe('POST /auth/enroll (DN-13 §4.2)', () => {
  it('creates the Auth user of a valid claim\'s email, and answers the same whether it already existed or not', async () => {
    const h = harness();
    const claimId = await h.claim('Owner@Firm.com');
    const first = await h.enroll({ claimId });
    expect(first.status).toBe(200);
    expect(EnrollResponse.parse(first.body)).toEqual({ email: 'owner@firm.com' });
    expect(h.authAdmin.createUser).toHaveBeenCalledWith('owner@firm.com');
    expect(h.authAdmin.inner.has('owner@firm.com')).toBe(true);
    // The second time the user exists: the same answer, so nobody learns whether an email had an account.
    const again = await h.enroll({ claimId });
    expect({ status: again.status, body: again.body }).toEqual({ status: first.status, body: first.body });
    expect(await h.authAdmin.createUser.mock.results[1]!.value).toBe('exists');
    // Reading the claim does not spend it: the organization is made from it afterwards.
    const created = await h.call('POST', '/orgs', { token: await h.login('owner@firm.com'), body: { name: 'Smith & Co', claimId } });
    expect(created.status).toBe(201);
  });

  it('creates the Auth user of a pending invitation\'s email, and the invitation can be accepted afterwards', async () => {
    const h = harness();
    const { token, org } = await h.paidOrg();
    const invitation = await h.invite(token, org.id, 'guest@firm.com', 'viewer');
    const reply = await h.enroll({ invitationToken: invitation.token });
    expect(reply.status).toBe(200);
    expect(EnrollResponse.parse(reply.body)).toEqual({ email: 'guest@firm.com' });
    expect(h.authAdmin.createUser).toHaveBeenCalledWith('guest@firm.com');
    const accepted = await h.call('POST', `/invitations/${invitation.token}/accept`, { token: await h.login('guest@firm.com') });
    expect(accepted.status).toBe(200);
    expect(OrgView.parse(accepted.body)).toMatchObject({ id: org.id, role: 'viewer' });
  });

  it('answers one and the same 410 for every claim or invitation it cannot use, and creates nobody', async () => {
    const h = harness();
    const { token, org } = await h.paidOrg();
    const used = await h.claim('owner@firm.com');
    expect((await h.call('POST', `/orgs/${org.id}/analyses`, { token, body: { claimId: used } })).status).toBe(201);
    const accepted = await h.invite(token, org.id, 'accepted@firm.com');
    expect((await h.call('POST', `/invitations/${accepted.token}/accept`, { token: await h.login('accepted@firm.com') })).status).toBe(200);
    const replaced = await h.invite(token, org.id, 'twice@firm.com');
    await h.invite(token, org.id, 'twice@firm.com');
    const revoked = await h.invite(token, org.id, 'revoked@firm.com');
    expect((await h.call('DELETE', `/orgs/${org.id}/invitations/${revoked.id}`, { token })).status).toBe(204);
    // An invitation of an organization deleted since.
    const other = await h.paidOrg('other@firm.com');
    const ofDeleted = await h.invite(other.token, other.org.id, 'late@firm.com');
    await h.repository.markOrganizationDeleted(other.org.id, new Date().toISOString());
    // And, further below, a claim and an invitation that outlived their time (24 h and 7 days).
    const stale = await h.claim('stale@firm.com');
    const expiring = await h.invite(token, org.id, 'expiring@firm.com');
    h.authAdmin.createUser.mockClear();

    const replies: unknown[] = [];
    const refuse = async (body: unknown) => {
      const reply = await h.enroll(body);
      replies.push({ status: reply.status, body: reply.body });
    };
    for (const body of [{ claimId: 'not-a-claim' }, { claimId: used }, { invitationToken: 'not-an-invitation' },
      { invitationToken: accepted.token }, { invitationToken: replaced.token }, { invitationToken: revoked.token },
      { invitationToken: ofDeleted.token }]) await refuse(body);
    h.advance(8 * 24 * HOUR);
    await refuse({ claimId: stale });
    await refuse({ invitationToken: expiring.token });
    expect(replies).toHaveLength(9);
    expect(new Set(replies.map(reply => JSON.stringify(reply))).size).toBe(1);
    expect(replies[0]).toEqual({ status: 410, body: { error: 'gone', message: expect.any(String) } });
    expect(h.authAdmin.createUser).not.toHaveBeenCalled();
  });

  it('refuses a body that is not exactly a claim or an invitation with a 400', async () => {
    const h = harness();
    const claimId = await h.claim('owner@firm.com');
    for (const body of [{}, { claimId, invitationToken: 'x' }, { claimId, email: 'owner@firm.com' }, { claimId: '' }, { invitationToken: 7 },
      { email: 'owner@firm.com' }]) {
      expect(EnrollRequest.safeParse(body).success, JSON.stringify(body)).toBe(false);
      expect((await h.enroll(body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await h.call('POST', '/auth/enroll', { raw: 'not json' })).status).toBe(400);
    expect(h.authAdmin.createUser).not.toHaveBeenCalled();
  });

  it('answers 503 auth_unavailable when the Auth admin API fails, and leaves the claim as it was', async () => {
    const h = harness();
    const claimId = await h.claim('owner@firm.com');
    h.authAdmin.down = true;
    const reply = await h.enroll({ claimId });
    expect({ status: reply.status, body: reply.body }).toEqual({ status: 503, body: { error: 'auth_unavailable', message: expect.any(String) } });
    expect(h.authAdmin.inner.has('owner@firm.com')).toBe(false);
    h.authAdmin.down = false;
    expect((await h.enroll({ claimId })).status).toBe(200);
    expect((await h.call('POST', '/orgs', { token: await h.login('owner@firm.com'), body: { name: 'Smith & Co', claimId } })).status).toBe(201);
  });

  it('allows 10 a hour from one address and 5 a hour for one claim or invitation, then 429 with Retry-After', async () => {
    const h = harness();
    for (let attempt = 0; attempt < 10; attempt++) expect((await h.enroll({ claimId: `unknown-${attempt}` })).status).toBe(410);
    const limited = await h.enroll({ claimId: 'unknown-10' });
    expect({ status: limited.status, body: limited.body }).toEqual({ status: 429, body: { error: 'rate_limited', message: expect.any(String) } });
    expect(Number(limited.headers.get('Retry-After'))).toBeGreaterThan(0);
    // Another address has its own count.
    h.from('203.0.113.2');
    const claimId = await h.claim('owner@firm.com');
    expect((await h.enroll({ claimId })).status).toBe(200);
    // One claim, five times, from five addresses; the sixth is refused wherever it comes from.
    for (let address = 3; address < 7; address++) {
      h.from(`203.0.113.${address}`);
      expect((await h.enroll({ claimId })).status).toBe(200);
    }
    h.from('203.0.113.7');
    expect((await h.enroll({ claimId })).status).toBe(429);
    expect((await h.enroll({ claimId: 'unknown-11' })).status).toBe(410);
    // An hour later, both counts start again.
    h.advance(HOUR);
    h.from('203.0.113.1');
    expect((await h.enroll({ claimId: 'unknown-12' })).status).toBe(410);
  });
});

describe('DELETE /me (DN-13 §4.8)', () => {
  it('refuses the only owner of an organization with 409 and changes nothing', async () => {
    const h = harness();
    const { token, org } = await h.paidOrg();
    const reply = await h.call('DELETE', '/me', { token });
    expect({ status: reply.status, body: reply.body }).toEqual({ status: 409, body: { error: 'conflict', message: expect.stringMatching(/only owner/) } });
    expect(h.authAdmin.deleteUser).not.toHaveBeenCalled();
    const me = await h.call('GET', '/me', { token });
    expect(me.status).toBe(200);
    expect(MeResponse.parse(me.body).organizations.map(o => o.id)).toEqual([org.id]);
  });

  it('closes a member\'s account and its Auth user, and every route answers 401 to its token afterwards', async () => {
    const h = harness();
    const { token: owner, org } = await h.paidOrg();
    const member = await h.join(owner, org.id, 'member@firm.com');
    // A link to the same email, pending in another organization.
    const other = await h.paidOrg('other@firm.com');
    await h.invite(other.token, other.org.id, 'member@firm.com');
    await h.authAdmin.createUser('member@firm.com');

    const reply = await h.call('DELETE', '/me', { token: member.token });
    expect({ status: reply.status, body: reply.body }).toEqual({ status: 204, body: null });
    expect(h.authAdmin.deleteUser).toHaveBeenCalledWith(member.userId);
    expect(h.authAdmin.inner.has('member@firm.com')).toBe(false);
    for (const [method, path] of [['GET', '/me'], ['GET', `/orgs/${org.id}`], ['POST', '/orgs'],
      ['GET', '/admin/organizations']] as const) {
      const after = await h.call(method, path, { token: member.token, ...(method === 'POST' ? { body: { name: 'x', claimId: 'y' } } : {}) });
      expect({ status: after.status, body: after.body }, `${method} ${path}`)
        .toEqual({ status: 401, body: { error: 'unauthorized', message: expect.any(String) } });
    }
    // The owner sees the member gone, the link to their email revoked, and the activity naming a former member.
    const members = await h.call('GET', `/orgs/${org.id}/members`, { token: owner });
    expect((members.body as { members: unknown[] }).members.map(m => MemberView.parse(m).email)).toEqual(['owner@firm.com']);
    const elsewhere = await h.call('GET', `/orgs/${other.org.id}/members`, { token: other.token });
    expect((elsewhere.body as { invitations: unknown[] }).invitations).toEqual([]);
    const activity = ActivityPage.parse((await h.call('GET', `/orgs/${org.id}/activity`, { token: owner })).body);
    expect(activity.events[0]).toMatchObject({ action: 'account.deleted', actor: { kind: 'member', email: null }, targetLabel: null,
      change: { from: 'member', to: null } });
    expect(await h.repository.getProfile(member.userId)).toMatchObject({ email: null, deleted_at: expect.any(String) });
  });

  it('lets an owner go while another owner stays', async () => {
    const h = harness();
    const { token: owner, org } = await h.paidOrg();
    const second = await h.join(owner, org.id, 'second@firm.com', 'admin');
    expect((await h.call('PATCH', `/orgs/${org.id}/members/${second.userId}`, { token: owner, body: { role: 'owner' } })).status).toBe(200);
    expect((await h.call('DELETE', '/me', { token: owner })).status).toBe(204);
    expect((await h.call('GET', `/orgs/${org.id}`, { token: second.token })).status).toBe(200);
  });

  it('closes the account first: when the Auth admin API fails it answers 503, and the same token can try again', async () => {
    const h = harness();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { token: owner, org } = await h.paidOrg();
    const member = await h.join(owner, org.id, 'member@firm.com');
    h.authAdmin.down = true;
    const failed = await h.call('DELETE', '/me', { token: member.token });
    expect({ status: failed.status, body: failed.body }).toEqual({ status: 503, body: { error: 'auth_unavailable', message: expect.any(String) } });
    // One retry inside the request before giving up.
    expect(h.authAdmin.deleteUser).toHaveBeenCalledTimes(2);
    expect((await h.call('GET', '/me', { token: member.token })).status).toBe(401);
    h.authAdmin.down = false;
    expect((await h.call('DELETE', '/me', { token: member.token })).status).toBe(204);
    expect(h.authAdmin.deleteUser).toHaveBeenLastCalledWith(member.userId);
    // An Auth user already gone is fine too.
    expect((await h.call('DELETE', '/me', { token: member.token })).status).toBe(204);
  });

  it('allows 3 a hour for one user, then 429 with Retry-After', async () => {
    const h = harness();
    const { token } = await h.paidOrg();
    for (let attempt = 0; attempt < 3; attempt++) expect((await h.call('DELETE', '/me', { token })).status).toBe(409);
    const limited = await h.call('DELETE', '/me', { token });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('Retry-After'))).toBeGreaterThan(0);
    // Another user is not affected.
    expect((await h.call('DELETE', '/me', { token: await h.login('nobody@firm.com') })).status).toBe(204);
  });

  it('keeps the platform admin\'s view of a deleted organization whole after one of its members closed their account', async () => {
    const h = harness();
    const { token: owner, org } = await h.paidOrg();
    const member = await h.join(owner, org.id, 'member@firm.com');
    await h.repository.markOrganizationDeleted(org.id, new Date().toISOString());
    expect((await h.call('DELETE', '/me', { token: member.token })).status).toBe(204);
    const staff = await h.login('ops@arca.example');
    await h.repository.grantPlatformAdmin((await h.auth.verify(staff))!.userId, null);
    const detail = await h.call('GET', `/admin/organizations/${org.id}`, { token: staff });
    expect(detail.status).toBe(200);
    expect(AdminOrgDetailView.parse(detail.body).members.map(m => m.email)).toEqual(['owner@firm.com']);
  });

  it('needs a session', async () => {
    const h = harness();
    expect((await h.call('DELETE', '/me')).status).toBe(401);
    expect(h.authAdmin.deleteUser).not.toHaveBeenCalled();
  });
});

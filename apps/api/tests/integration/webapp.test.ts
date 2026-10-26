import { beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AnalysisView, AssessmentView, ClaimResponse, DeletionRequestView, InvitationView, MeResponse, MemberView, OrgView, PlanView,
  PollResponse, ScanResponse, StartedAssessmentResponse, UrlResponse, type AnswerValue, type RenderedQuestion, type Role } from '@arca/contracts';
import { DEBUG_REQUEST_HEADER, DEBUG_SCENARIO_HEADER, type DebugModeResponse, type DebugScenarioInput } from '@arca/contracts/debug';
import { InMemoryAssessmentRepository } from '../../src/assessment/repository.js';
import { compose } from '../../src/compose.js';
import { loadEnv } from '../../src/config/env.js';
import { RoutingAssessmentRepository, RoutingScanRepository } from '../../src/debug/isolation.js';
import { createDebugTools } from '../../src/debug/tools.js';
import { createApp } from '../../src/http/app.js';
import { PublicDomainResolver } from '../../src/pipeline/domain-resolution.js';
import { InProcessPipeline } from '../../src/pipeline/in-process-pipeline.js';
import { mockSources } from '../../src/pipeline/mock-sources.js';
import { InMemoryRepository } from '../../src/repositories/in-memory.js';
import { MockAppAuth } from '../../src/webapp/auth.js';
import { MockBillingProvider } from '../../src/webapp/billing.js';
import { InMemoryWebappRepository } from '../../src/webapp/in-memory.js';
import { DEFAULT_PLANS } from '../../src/webapp/plans.js';
import { WebappService } from '../../src/webapp/service.js';

const secret = 's'.repeat(40);
const origin = 'http://localhost:3000';
const DOMAIN = 'robust.arca.example';
const OWNER = `owner@${DOMAIN}`;
type App = Awaited<ReturnType<typeof compose>>['app'];
type Reply = { status: number; body: unknown };

const LoginResponse = z.object({ token: z.string().min(1), user: z.object({ userId: z.string().uuid(), email: z.string().email() }).strict(),
  expiresAt: z.string().datetime() }).strict();
const failure = (status: number, error: string): Reply => ({ status, body: { error, message: expect.any(String) } });

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = await read();
    if (done(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Gave up waiting');
}

function firstValidAnswer(question: RenderedQuestion): AnswerValue {
  if (question.type === 'multi_select') return { kind: 'options', optionIds: [question.options![0]!.id] };
  if (question.type === 'scale') return { kind: 'scale', value: question.scale!.min };
  if (question.type === 'number') return { kind: 'number', value: question.number!.min };
  return { kind: 'option', optionId: question.options![0]!.id };
}

/** A finished scan of the anonymous funnel, through the real mock pipeline. */
async function scan(app: App, email = OWNER, scenario?: DebugScenarioInput) {
  const response = await app.request('/scan', { method: 'POST', body: JSON.stringify({ email, domain: DOMAIN }),
    headers: { 'Content-Type': 'application/json', ...(scenario ? { [DEBUG_SCENARIO_HEADER]: JSON.stringify(scenario) } : {}) } });
  expect([200, 202]).toContain(response.status);
  const started = ScanResponse.parse(await response.json());
  const poll = await until(async () => PollResponse.parse(await (await app.request(`/scan/${started.scanId}`,
    { headers: { Authorization: `Bearer ${started.sessionToken}` } })).json()), value => value.status !== 'RUNNING');
  expect(['COMPLETED', 'PARTIAL']).toContain(poll.status);
  return started;
}

/** The assessment of the funnel, answered with the first valid answer of each question, as mock-offline.test.ts does. */
async function completeAssessment(app: App, started: Awaited<ReturnType<typeof scan>>) {
  const auth = { Authorization: `Bearer ${started.sessionToken}`, 'Content-Type': 'application/json' };
  const created = await app.request(`/scan/${started.scanId}/assessment`, { method: 'POST', headers: auth });
  expect(created.status).toBe(202);
  const { assessmentId } = StartedAssessmentResponse.parse(await created.json());
  const view = async () => AssessmentView.parse(await (await app.request(`/assessment/${assessmentId}`, { headers: auth })).json());
  expect((await until(view, value => value.status !== 'PLANNING')).status).toBe('READY');
  for (let current = await view(), answered = 0; ; current = await view()) {
    const question = current.questions.find(candidate => !current.answers[candidate.id]);
    if (!question) break;
    const saved = await app.request(`/assessment/${assessmentId}/answers/${question.id}`, { method: 'PUT', headers: auth,
      body: JSON.stringify({ answer: firstValidAnswer(question) }) });
    expect(saved.status).toBe(200);
    expect(++answered).toBeLessThan(50);
  }
  const completed = await app.request(`/assessment/${assessmentId}/complete`, { method: 'POST', headers: auth,
    body: JSON.stringify({ attestation: true }) });
  expect(completed.status).toBe(200);
}

/** The app exactly as `npm run dev:mock` builds it, plus the calls the webapp makes. Every webapp answer is no-store. */
async function mockApp() {
  const composed = await compose(loadEnv({ ARCA_MODE: 'mock', SESSION_TOKEN_SECRET: secret, CORS_ALLOWED_ORIGINS: origin }));
  const { app } = composed;
  async function call(method: string, path: string, options: { token?: string; body?: unknown; debug?: boolean } = {}): Promise<Reply> {
    const response = await app.request(path, { method, body: options.body === undefined ? undefined : JSON.stringify(options.body),
      headers: { ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(options.debug ? { [DEBUG_REQUEST_HEADER]: '1' } : {}) } });
    expect(response.headers.get('Cache-Control'), `${method} ${path}`).toBe('no-store');
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  }
  async function login(email: string, platformAdmin?: boolean) {
    const reply = await call('POST', '/__debug/auth/login', { debug: true, body: { email, ...(platformAdmin === undefined ? {} : { platformAdmin }) } });
    expect(reply.status).toBe(200);
    return LoginResponse.parse(reply.body);
  }
  async function claim(email = OWNER) {
    const started = await scan(app, email);
    const reply = await call('POST', '/claims', { body: { scanToken: started.sessionToken } });
    expect(reply.status).toBe(201);
    return ClaimResponse.parse(reply.body).claimId;
  }
  async function createOrg(token: string, claimId: string, name = 'Smith & Co') {
    const reply = await call('POST', '/orgs', { token, body: { name, claimId } });
    expect(reply.status).toBe(201);
    return OrgView.parse(reply.body);
  }
  async function pay(token: string, orgId: string, planCode = 'monthly') {
    const checkout = await call('POST', `/orgs/${orgId}/billing/checkout`, { token, body: { planCode } });
    expect(checkout.status).toBe(200);
    const sessionId = new URL(UrlResponse.parse(checkout.body).url).searchParams.get('session')!;
    expect(await call('POST', '/__debug/billing/pay', { debug: true, body: { sessionId } })).toEqual({ status: 200, body: { ok: true } });
    return sessionId;
  }
  async function invite(token: string, orgId: string, email: string, role: Exclude<Role, 'owner'>) {
    const reply = await call('POST', `/orgs/${orgId}/invitations`, { token, body: { email, role } });
    expect(reply.status).toBe(201);
    const invitation = InvitationView.parse(reply.body);
    return { invitation, inviteToken: invitation.inviteUrl!.split('/app/invite/')[1]! };
  }
  /** Someone who joins through an invitation, accepted with their own mock login. */
  async function join(ownerToken: string, orgId: string, email: string, role: Exclude<Role, 'owner'>) {
    const { inviteToken } = await invite(ownerToken, orgId, email, role);
    const session = await login(email);
    const accepted = await call('POST', `/invitations/${inviteToken}/accept`, { token: session.token });
    expect(accepted.status).toBe(200);
    expect(OrgView.parse(accepted.body)).toMatchObject({ id: orgId, role });
    return session;
  }
  /** An organization created from a funnel claim, paid unless told otherwise. */
  async function ownedOrg(email = OWNER, options: { paid?: boolean } = {}) {
    const owner = await login(email);
    const org = await createOrg(owner.token, await claim(email));
    if (options.paid ?? true) await pay(owner.token, org.id);
    return { owner, org };
  }
  return { ...composed, call, login, claim, createOrg, pay, invite, join, ownedOrg };
}

type OrgIds = { orgId: string; memberId: string; invitationId: string };
/** Every route under /orgs/:id, each with a valid body, so only who asks decides the answer. */
const orgRoutes = ({ orgId, memberId, invitationId }: OrgIds): Array<[method: string, path: string, body?: unknown]> => [
  ['GET', `/orgs/${orgId}`],
  ['GET', `/orgs/${orgId}/analyses`],
  ['POST', `/orgs/${orgId}/analyses`, { claimId: 'not-a-real-claim' }],
  ['GET', `/orgs/${orgId}/members`],
  ['POST', `/orgs/${orgId}/invitations`, { email: 'newcomer@elsewhere.example', role: 'viewer' }],
  ['DELETE', `/orgs/${orgId}/invitations/${invitationId}`],
  ['PATCH', `/orgs/${orgId}/members/${memberId}`, { role: 'viewer' }],
  ['DELETE', `/orgs/${orgId}/members/${memberId}`],
  ['POST', `/orgs/${orgId}/billing/checkout`, { planCode: 'monthly' }],
  ['POST', `/orgs/${orgId}/billing/portal`],
  ['POST', `/orgs/${orgId}/deletion-request`, { reason: 'Closing the firm' }],
];

describe('the webapp API in mock', () => {
  it('the demo flow works end to end', async () => {
    const s = await mockApp();
    // 1. Funnel, claim, sign-up and the organization.
    const started = await scan(s.app);
    await completeAssessment(s.app, started);
    const claimed = await s.call('POST', '/claims', { body: { scanToken: started.sessionToken } });
    expect(claimed.status).toBe(201);
    expect(ClaimResponse.parse(claimed.body).email).toBe(OWNER);
    const owner = await s.login(OWNER);
    const org = await s.createOrg(owner.token, ClaimResponse.parse(claimed.body).claimId);
    expect(org).toEqual({ id: expect.any(String), name: 'Smith & Co', domain: DOMAIN, billingStatus: 'pending_payment', role: 'owner',
      deletionPending: false, paidAccess: false });
    const me = await s.call('GET', '/me', { token: owner.token });
    expect(me.status).toBe(200);
    expect(MeResponse.parse(me.body)).toEqual({ user: { id: owner.user.userId, email: OWNER }, organizations: [org], platformAdmin: false });

    // 2. Locked until paid; the organization itself stays readable.
    expect(await s.call('GET', `/orgs/${org.id}/analyses`, { token: owner.token })).toEqual(failure(402, 'payment_required'));
    expect(await s.call('GET', `/orgs/${org.id}`, { token: owner.token })).toEqual({ status: 200, body: org });

    // 3. Simulated payment, then the claimed analysis with its results.
    const sessionId = await s.pay(owner.token, org.id);
    // A checkout is paid once.
    expect(await s.call('POST', '/__debug/billing/pay', { debug: true, body: { sessionId } })).toEqual(failure(409, 'conflict'));
    const analyses = await s.call('GET', `/orgs/${org.id}/analyses`, { token: owner.token });
    expect(analyses.status).toBe(200);
    const [analysis, ...rest] = z.array(AnalysisView).parse(analyses.body);
    expect(rest).toEqual([]);
    expect(analysis).toMatchObject({ scanId: started.scanId, domain: DOMAIN, scanStatus: 'COMPLETED' });
    expect(analysis!.layer1.preScore.total).toBe(82);
    expect(analysis!.assessment).not.toBeNull();
    expect(OrgView.parse((await s.call('GET', `/orgs/${org.id}`, { token: owner.token })).body))
      .toMatchObject({ billingStatus: 'active', paidAccess: true });

    // 4. A member joins through the invitation link and reads the analyses.
    const member = await s.join(owner.token, org.id, 'member@robust.arca.example', 'member');
    expect((await s.call('GET', `/orgs/${org.id}/analyses`, { token: member.token })).status).toBe(200);
    const members = await s.call('GET', `/orgs/${org.id}/members`, { token: member.token });
    expect(members.status).toBe(200);
    expect(z.object({ members: z.array(MemberView), invitations: z.array(InvitationView) }).parse(members.body).members
      .map(({ email, role }) => ({ email, role }))).toEqual([{ email: OWNER, role: 'owner' }, { email: 'member@robust.arca.example', role: 'member' }]);

    // 5. The member can neither pay nor change roles: the back is the one that says no.
    expect(await s.call('POST', `/orgs/${org.id}/billing/checkout`, { token: member.token, body: { planCode: 'monthly' } }))
      .toEqual(failure(403, 'forbidden'));
    expect(await s.call('PATCH', `/orgs/${org.id}/members/${owner.user.userId}`, { token: member.token, body: { role: 'viewer' } }))
      .toEqual(failure(403, 'forbidden'));

    // 6. A platform admin changes the price, and the public list shows it.
    const ops = await s.login('ops@arca.example', true);
    const updated = await s.call('PUT', '/admin/plans/monthly', { token: ops.token, body: { amountCents: 1000 } });
    expect(updated.status).toBe(200);
    expect(PlanView.parse(updated.body)).toMatchObject({ code: 'monthly', amountCents: 1000 });
    const plans = await s.call('GET', '/plans');
    expect(plans.status).toBe(200);
    expect(z.array(PlanView).parse(plans.body).find(plan => plan.code === 'monthly')).toMatchObject({ amountCents: 1000 });

    // 7. Asking for deletion changes nothing until ARCA reviews it, and a second request is refused.
    const requested = await s.call('POST', `/orgs/${org.id}/deletion-request`, { token: owner.token, body: { reason: 'Closing the firm' } });
    expect(requested.status).toBe(201);
    expect(DeletionRequestView.parse(requested.body)).toMatchObject({ orgId: org.id, status: 'pending', reason: 'Closing the firm' });
    expect(OrgView.parse((await s.call('GET', `/orgs/${org.id}`, { token: owner.token })).body)).toMatchObject({ deletionPending: true });
    expect((await s.call('GET', `/orgs/${org.id}/analyses`, { token: owner.token })).status).toBe(200);
    expect(await s.call('POST', `/orgs/${org.id}/deletion-request`, { token: owner.token, body: { reason: 'Again' } }))
      .toEqual(failure(409, 'conflict'));
    await s.drain();
  });

  it('organizations are isolated', async () => {
    const s = await mockApp();
    const a = await s.ownedOrg('owner@robust.arca.example');
    const b = await s.ownedOrg('partner@robust.arca.example');
    const bMember = await s.join(b.owner.token, b.org.id, 'associate@robust.arca.example', 'member');
    const { invitation } = await s.invite(b.owner.token, b.org.id, 'pending@robust.arca.example', 'viewer');
    const before = await s.call('GET', `/orgs/${b.org.id}/members`, { token: b.owner.token });

    // Not 403: an outsider must not learn that the organization exists.
    for (const [method, path, body] of orgRoutes({ orgId: b.org.id, memberId: bMember.user.userId, invitationId: invitation.id })) {
      expect(await s.call(method, path, { token: a.owner.token, body }), `${method} ${path}`).toEqual(failure(404, 'not_found'));
    }
    // The same answer as for an organization that does not exist at all.
    expect(await s.call('GET', `/orgs/${crypto.randomUUID()}`, { token: a.owner.token })).toEqual(failure(404, 'not_found'));
    // Nor can A reach B's invitation from its own organization.
    expect(await s.call('DELETE', `/orgs/${a.org.id}/invitations/${invitation.id}`, { token: a.owner.token })).toEqual(failure(404, 'not_found'));
    expect(await s.call('PATCH', `/orgs/${a.org.id}/members/${bMember.user.userId}`, { token: a.owner.token, body: { role: 'viewer' } }))
      .toEqual(failure(404, 'not_found'));

    // B is untouched, and A only ever sees its own organization.
    expect(await s.call('GET', `/orgs/${b.org.id}/members`, { token: b.owner.token })).toEqual(before);
    expect(OrgView.parse((await s.call('GET', `/orgs/${b.org.id}`, { token: b.owner.token })).body)).toMatchObject({ deletionPending: false });
    expect(MeResponse.parse((await s.call('GET', '/me', { token: a.owner.token })).body).organizations.map(org => org.id)).toEqual([a.org.id]);
  });

  it('a deleted organization answers 410 everywhere', async () => {
    const s = await mockApp();
    const { owner, org } = await s.ownedOrg();
    const member = await s.join(owner.token, org.id, 'member@robust.arca.example', 'member');
    const pending = await s.invite(owner.token, org.id, 'late@robust.arca.example', 'viewer');
    const requested = DeletionRequestView.parse((await s.call('POST', `/orgs/${org.id}/deletion-request`, { token: owner.token,
      body: { reason: 'Closing the firm' } })).body);
    const ops = await s.login('ops@arca.example', true);
    const approved = await s.call('POST', `/admin/deletion-requests/${requested.id}/approve`, { token: ops.token, body: { note: 'Confirmed' } });
    expect(approved.status).toBe(200);
    expect(DeletionRequestView.parse(approved.body)).toMatchObject({ id: requested.id, status: 'approved', reviewNote: 'Confirmed' });

    // Billing and the deletion request included.
    for (const [method, path, body] of orgRoutes({ orgId: org.id, memberId: member.user.userId, invitationId: pending.invitation.id })) {
      expect(await s.call(method, path, { token: owner.token, body }), `${method} ${path}`).toEqual(failure(410, 'gone'));
    }
    expect(await s.call('GET', `/orgs/${org.id}/analyses`, { token: member.token })).toEqual(failure(410, 'gone'));
    const late = await s.login('late@robust.arca.example');
    expect(await s.call('POST', `/invitations/${pending.inviteToken}/accept`, { token: late.token })).toEqual(failure(410, 'gone'));
    // An outsider still learns nothing.
    const stranger = await s.login('stranger@elsewhere.example');
    expect(await s.call('GET', `/orgs/${org.id}`, { token: stranger.token })).toEqual(failure(404, 'not_found'));
    expect(MeResponse.parse((await s.call('GET', '/me', { token: owner.token })).body).organizations).toEqual([]);
    const listed = await s.call('GET', '/admin/organizations', { token: ops.token });
    expect(listed).toEqual({ status: 200, body: [expect.objectContaining({ id: org.id, deleted: true })] });
    // A reviewed request cannot be reviewed again.
    expect(await s.call('POST', `/admin/deletion-requests/${requested.id}/reject`, { token: ops.token })).toEqual(failure(409, 'conflict'));
  });

  it('an unpaid organization answers 402 on every paid route, and only there', async () => {
    const s = await mockApp();
    const { owner, org } = await s.ownedOrg(OWNER, { paid: false });
    // Paying is how an organization gets in, and asking for its deletion needs no payment either (DN-10 §4.4).
    const exempt = new Set([`GET /orgs/${org.id}`, `POST /orgs/${org.id}/billing/checkout`, `POST /orgs/${org.id}/billing/portal`,
      `POST /orgs/${org.id}/deletion-request`]);
    const routes = orgRoutes({ orgId: org.id, memberId: owner.user.userId, invitationId: crypto.randomUUID() });
    expect(routes.filter(([method, path]) => exempt.has(`${method} ${path}`))).toHaveLength(exempt.size);
    for (const [method, path, body] of routes.filter(([method, path]) => !exempt.has(`${method} ${path}`))) {
      expect(await s.call(method, path, { token: owner.token, body }), `${method} ${path}`).toEqual(failure(402, 'payment_required'));
    }
    for (const [method, path, body] of routes.filter(([method, path]) => exempt.has(`${method} ${path}`))) {
      const reply = await s.call(method, path, { token: owner.token, body });
      expect(reply.status, `${method} ${path}`).toBeGreaterThanOrEqual(200);
      expect(reply.status, `${method} ${path}`).toBeLessThan(300);
    }
    expect(OrgView.parse((await s.call('GET', `/orgs/${org.id}`, { token: owner.token })).body))
      .toMatchObject({ billingStatus: 'pending_payment', paidAccess: false, deletionPending: true });
  });

  describe('routes refuse every role the matrix refuses', () => {
    type Team = { orgId: string; ids: Record<Role, string>; tokens: Record<Role, string>; invitationId: string; deletionId: string };
    let team: Team;
    let s: Awaited<ReturnType<typeof mockApp>>;
    let before: { members: Reply; plans: Reply; requests: Reply };

    beforeAll(async () => {
      s = await mockApp();
      const { owner, org } = await s.ownedOrg();
      const admin = await s.join(owner.token, org.id, 'admin@robust.arca.example', 'admin');
      const member = await s.join(owner.token, org.id, 'member@robust.arca.example', 'member');
      const viewer = await s.join(owner.token, org.id, 'viewer@robust.arca.example', 'viewer');
      const { invitation } = await s.invite(owner.token, org.id, 'pending@robust.arca.example', 'viewer');
      const deletion = DeletionRequestView.parse((await s.call('POST', `/orgs/${org.id}/deletion-request`, { token: owner.token,
        body: { reason: 'Closing the firm' } })).body);
      team = { orgId: org.id, invitationId: invitation.id, deletionId: deletion.id,
        ids: { owner: owner.user.userId, admin: admin.user.userId, member: member.user.userId, viewer: viewer.user.userId },
        tokens: { owner: owner.token, admin: admin.token, member: member.token, viewer: viewer.token } };
      const ops = await s.login('ops@arca.example', true);
      before = { members: await s.call('GET', `/orgs/${org.id}/members`, { token: owner.token }),
        plans: await s.call('GET', '/admin/plans', { token: ops.token }), requests: await s.call('GET', '/admin/deletion-requests', { token: ops.token }) };
    });

    const org = (path: string) => (t: Team) => `/orgs/${t.orgId}${path}`;
    const routes = {
      attach: ['POST', org('/analyses'), () => ({ claimId: 'not-a-real-claim' })],
      invite: ['POST', org('/invitations'), () => ({ email: 'newcomer@elsewhere.example', role: 'viewer' })],
      revoke: ['DELETE', (t: Team) => `/orgs/${t.orgId}/invitations/${t.invitationId}`, undefined],
      checkout: ['POST', org('/billing/checkout'), () => ({ planCode: 'monthly' })],
      portal: ['POST', org('/billing/portal'), undefined],
      deletion: ['POST', org('/deletion-request'), () => ({ reason: 'Not mine to ask' })],
    } as const;
    const setRole = (target: Role, role: Role) => ['PATCH', (t: Team) => `/orgs/${t.orgId}/members/${t.ids[target]}`, () => ({ role })] as const;
    const remove = (target: Role) => ['DELETE', (t: Team) => `/orgs/${t.orgId}/members/${t.ids[target]}`, undefined] as const;
    const admin = (method: string, path: string, body?: unknown) => [method, (t: Team) => path.replace(':id', t.deletionId),
      body === undefined ? undefined : () => body] as const;
    type Route = readonly [string, (t: Team) => string, (() => unknown) | undefined];
    const cases: Array<{ actor: Role; name: string; route: Route }> = [
      ...(['checkout', 'portal', 'deletion'] as const).map(name => ({ actor: 'admin' as const, name, route: routes[name] })),
      { actor: 'admin', name: 'demote an owner', route: setRole('owner', 'admin') },
      { actor: 'admin', name: 'remove an owner', route: remove('owner') },
      { actor: 'admin', name: 'give owner', route: setRole('member', 'owner') },
      ...(['invite', 'revoke', 'checkout', 'portal', 'deletion'] as const).map(name => ({ actor: 'member' as const, name, route: routes[name] })),
      { actor: 'member', name: 'change a role', route: setRole('viewer', 'member') },
      { actor: 'member', name: 'remove a member', route: remove('viewer') },
      ...(['attach', 'invite', 'revoke', 'checkout', 'portal', 'deletion'] as const).map(name => ({ actor: 'viewer' as const, name,
        route: routes[name] })),
      { actor: 'viewer', name: 'change a role', route: setRole('member', 'viewer') },
      { actor: 'viewer', name: 'remove a member', route: remove('member') },
      // An organization owner is not an ARCA platform admin.
      { actor: 'owner', name: 'list organizations', route: admin('GET', '/admin/organizations') },
      { actor: 'owner', name: 'list deletion requests', route: admin('GET', '/admin/deletion-requests') },
      { actor: 'owner', name: 'approve a deletion', route: admin('POST', '/admin/deletion-requests/:id/approve', {}) },
      { actor: 'owner', name: 'reject a deletion', route: admin('POST', '/admin/deletion-requests/:id/reject', {}) },
      { actor: 'owner', name: 'list every plan', route: admin('GET', '/admin/plans') },
      { actor: 'owner', name: 'change a price', route: admin('PUT', '/admin/plans/monthly', { amountCents: 1 }) },
    ];

    it.each(cases)('$actor: $name', async ({ actor, route: [method, path, body] }) => {
      expect(await s.call(method, path(team), { token: team.tokens[actor], body: body?.() })).toEqual(failure(403, 'forbidden'));
    });

    it('and none of the refusals changed anything', async () => {
      const ops = await s.login('ops@arca.example', true);
      expect(await s.call('GET', `/orgs/${team.orgId}/members`, { token: team.tokens.owner })).toEqual(before.members);
      expect(await s.call('GET', '/admin/plans', { token: ops.token })).toEqual(before.plans);
      expect(await s.call('GET', '/admin/deletion-requests', { token: ops.token })).toEqual(before.requests);
    });
  });

  it('without a token the app answers 401, and with a scan session token too', async () => {
    const s = await mockApp();
    const { owner, org } = await s.ownedOrg();
    const started = await scan(s.app);
    const routes: Array<[method: string, path: string, body?: unknown]> = [
      ['GET', '/me'],
      ['POST', '/orgs', { name: 'Smith & Co', claimId: 'not-a-real-claim' }],
      ...orgRoutes({ orgId: org.id, memberId: owner.user.userId, invitationId: crypto.randomUUID() }),
      ['POST', '/invitations/not-a-real-token/accept'],
      ['GET', '/admin/organizations'], ['GET', '/admin/deletion-requests'], ['GET', '/admin/plans'],
      ['POST', `/admin/deletion-requests/${crypto.randomUUID()}/approve`, {}], ['POST', `/admin/deletion-requests/${crypto.randomUUID()}/reject`, {}],
      ['PUT', '/admin/plans/monthly', { amountCents: 1 }],
    ];
    // The scan session token is signed under another key, issuer and audience. A mock token under another secret is refused too.
    const forged = await new MockAppAuth('x'.repeat(40)).issue(OWNER);
    for (const [method, path, body] of routes) {
      for (const token of [undefined, started.sessionToken, forged.token, 'garbage']) {
        expect(await s.call(method, path, { token, body }), `${method} ${path}`).toEqual(failure(401, 'unauthorized'));
      }
    }
    // Nor does an app token open a scan, even one of its own email.
    const poll = await s.app.request(`/scan/${started.scanId}`, { headers: { Authorization: `Bearer ${owner.token}` } });
    expect(poll.status).toBe(401);
    expect((await s.app.request(`/scan/${started.scanId}`, { headers: { Authorization: `Bearer ${started.sessionToken}` } })).status).toBe(200);
    // The public routes stay public.
    expect((await s.call('GET', '/plans')).status).toBe(200);
    expect(MeResponse.parse((await s.call('GET', '/me', { token: owner.token })).body).organizations).toHaveLength(1);
  });

  it('a claim works once, for its own email', async () => {
    const s = await mockApp();
    const owner = await s.login(OWNER);
    const started = await scan(s.app);
    const claimOf = async () => ClaimResponse.parse((await s.call('POST', '/claims', { body: { scanToken: started.sessionToken } })).body).claimId;
    const first = await claimOf(), second = await claimOf();
    await s.createOrg(owner.token, first);
    expect(await s.call('POST', '/orgs', { token: owner.token, body: { name: 'Again', claimId: first } })).toEqual(failure(409, 'conflict'));
    expect(await s.call('POST', '/orgs', { token: owner.token, body: { name: 'Again', claimId: second } })).toEqual(failure(409, 'conflict'));
    expect(await s.call('POST', '/claims', { body: { scanToken: started.sessionToken } })).toEqual(failure(409, 'conflict'));
    // Another person's ticket.
    const theirs = await s.claim('partner@robust.arca.example');
    const stranger = await s.login('stranger@elsewhere.example');
    expect(await s.call('POST', '/orgs', { token: stranger.token, body: { name: 'Mine', claimId: theirs } })).toEqual(failure(403, 'forbidden'));
    expect(MeResponse.parse((await s.call('GET', '/me', { token: stranger.token })).body).organizations).toEqual([]);
    expect(MeResponse.parse((await s.call('GET', '/me', { token: owner.token })).body).organizations).toHaveLength(1);
    // A scan with an injected fault lives in memory only (DN-09 5.5), so it is never claimable.
    const injected = await scan(s.app, OWNER, { bar: 'empty' });
    expect(await s.call('POST', '/claims', { body: { scanToken: injected.sessionToken } })).toEqual(failure(409, 'conflict'));
    expect(await s.call('POST', '/claims', { body: { scanToken: 'garbage' } })).toEqual(failure(401, 'unauthorized'));
    expect(await s.call('POST', '/claims', { body: { token: started.sessionToken } })).toEqual(failure(400, 'invalid_request'));
  });

  it('validates every body against the contract', async () => {
    const s = await mockApp();
    const { owner, org } = await s.ownedOrg();
    const ops = await s.login('ops@arca.example', true);
    const invalid: Array<[method: string, path: string, body: unknown, token: string]> = [
      ['POST', '/orgs', { name: '   ', claimId: 'x' }, owner.token],
      ['POST', `/orgs/${org.id}/analyses`, {}, owner.token],
      // An invitation never grants ownership.
      ['POST', `/orgs/${org.id}/invitations`, { email: 'boss@robust.arca.example', role: 'owner' }, owner.token],
      ['PATCH', `/orgs/${org.id}/members/${owner.user.userId}`, { role: 'king' }, owner.token],
      ['POST', `/orgs/${org.id}/billing/checkout`, { planCode: '' }, owner.token],
      ['POST', `/orgs/${org.id}/deletion-request`, { reason: '' }, owner.token],
      ['PUT', '/admin/plans/monthly', {}, ops.token],
      ['PUT', '/admin/plans/monthly', { amountCents: -1 }, ops.token],
    ];
    for (const [method, path, body, token] of invalid) {
      expect(await s.call(method, path, { token, body }), `${method} ${path}`).toEqual(failure(400, 'invalid_request'));
    }
    const notJson = await s.app.request('/orgs', { method: 'POST', body: '{', headers: { Authorization: `Bearer ${owner.token}`,
      'Content-Type': 'application/json' } });
    expect(notJson.status).toBe(400);
  });

  it('the Stripe webhook is not configured, even in mock', async () => {
    const s = await mockApp();
    expect(await s.call('POST', '/billing/webhook', { body: { type: 'checkout.session.completed' } })).toEqual(failure(501, 'not_configured'));
  });
});

describe('the mock login and payment', () => {
  it('need X-Arca-Debug: 1 and a valid body', async () => {
    const s = await mockApp();
    const post = (path: string, body: unknown, headers: Record<string, string> = {}) => s.app.request(path, { method: 'POST',
      body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', ...headers } });
    for (const path of ['/__debug/auth/login', '/__debug/billing/pay']) {
      const response = await post(path, { email: OWNER, sessionId: 'cs_x' });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'invalid_request', message: expect.stringContaining(DEBUG_REQUEST_HEADER) });
    }
    expect(await s.call('POST', '/__debug/auth/login', { debug: true, body: { email: 'not-an-email' } })).toEqual(failure(400, 'invalid_request'));
    expect(await s.call('POST', '/__debug/billing/pay', { debug: true, body: {} })).toEqual(failure(400, 'invalid_request'));
    expect(await s.call('POST', '/__debug/billing/pay', { debug: true, body: { sessionId: 'cs_mock_unknown' } })).toEqual(failure(409, 'conflict'));
  });

  it('log in the same user for the same email, and only grant platform admin when asked', async () => {
    const s = await mockApp();
    const first = await s.login('Owner@Robust.Arca.Example');
    const again = await s.login(OWNER);
    expect(first.user).toEqual({ userId: again.user.userId, email: OWNER });
    expect(MeResponse.parse((await s.call('GET', '/me', { token: first.token })).body).platformAdmin).toBe(false);
    expect((await s.call('GET', '/admin/plans', { token: first.token })).status).toBe(403);
    const ops = await s.login('ops@arca.example', true);
    expect(MeResponse.parse((await s.call('GET', '/me', { token: ops.token })).body).platformAdmin).toBe(true);
    const plans = await s.call('GET', '/admin/plans', { token: ops.token });
    expect(plans.status).toBe(200);
    expect(z.array(PlanView).parse(plans.body).map(plan => plan.code)).toEqual(['monthly', 'annual']);
  });

  it('a mock reset forgets the webapp and seeds the plans again', async () => {
    const s = await mockApp();
    const { owner, org } = await s.ownedOrg();
    const ops = await s.login('ops@arca.example', true);
    expect((await s.call('PUT', '/admin/plans/monthly', { token: ops.token, body: { amountCents: 1000 } })).status).toBe(200);
    expect(await s.call('POST', '/__debug/reset', { debug: true })).toEqual({ status: 200, body: { ok: true } });
    expect(await s.call('GET', `/orgs/${org.id}`, { token: owner.token })).toEqual(failure(404, 'not_found'));
    expect(MeResponse.parse((await s.call('GET', '/me', { token: ops.token })).body)).toMatchObject({ organizations: [], platformAdmin: false });
    expect(z.array(PlanView).parse((await s.call('GET', '/plans')).body).find(plan => plan.code === 'monthly'))
      .toMatchObject({ amountCents: 49_900 });
  });
});

describe('production wiring', () => {
  it('answers 501 on every webapp route, has no mock login and keeps CORS exact', async () => {
    const { app } = await compose(loadEnv({ SOURCE_MODE: 'mock', STORAGE_BACKEND: 'memory', SESSION_TOKEN_SECRET: secret,
      CORS_ALLOWED_ORIGINS: origin }));
    const routes: Array<[string, string]> = [['GET', '/me'], ['POST', '/claims'], ['GET', '/plans'], ['POST', '/orgs'], ['GET', '/orgs/x'],
      ['GET', '/orgs/x/analyses'], ['PATCH', '/orgs/x/members/y'], ['DELETE', '/orgs/x/members/y'], ['POST', '/orgs/x/billing/checkout'],
      ['POST', '/invitations/t/accept'], ['GET', '/admin/organizations'], ['PUT', '/admin/plans/monthly'], ['POST', '/billing/webhook']];
    for (const [method, path] of routes) {
      const response = await app.request(path, { method, headers: { Authorization: 'Bearer x', 'Content-Type': 'application/json' },
        body: method === 'GET' ? undefined : '{}' });
      expect(response.status, `${method} ${path}`).toBe(501);
      expect(await response.json()).toEqual({ error: 'not_configured', message: expect.any(String) });
    }
    for (const path of ['/__debug/auth/login', '/__debug/billing/pay']) {
      const response = await app.request(path, { method: 'POST', body: JSON.stringify({ email: OWNER, sessionId: 'cs_x' }),
        headers: { 'Content-Type': 'application/json', [DEBUG_REQUEST_HEADER]: '1' } });
      expect(response.status).toBe(404);
    }
    const preflight = await app.request('/orgs', { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'PATCH',
      'Access-Control-Request-Headers': 'content-type, authorization, x-arca-debug' } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type,Authorization');
    expect(preflight.headers.get('Access-Control-Allow-Methods')).toBe('GET,POST,PUT,PATCH,DELETE,OPTIONS');
    // The funnel is untouched.
    expect((await app.request('/health')).status).toBe(200);
  });
});

describe('live-debug has no mock login', () => {
  const description: DebugModeResponse = { mode: 'live-debug', sourceMode: 'live', storageBackend: 'supabase', websiteEvidenceProvider: 'agentic',
    assessmentPlanner: 'rules', signalLlmModel: 'fixture-model', inUse: { openai: true, apify: true, supabase: true } };
  function liveDebug() {
    const scans = new RoutingScanRepository(new InMemoryRepository(), new InMemoryRepository());
    const assessments = new RoutingAssessmentRepository(new InMemoryAssessmentRepository(), new InMemoryAssessmentRepository(), scans);
    return { scans, assessments, options: { mode: 'live-debug' as const, describe: description, sources: mockSources(), scans, assessments,
      pipelineTimeoutMs: 600_000 } };
  }

  it('answers 404 on /__debug/auth/login and /__debug/billing/pay', async () => {
    const { scans, assessments, options } = liveDebug();
    const { app } = createApp({ repository: scans, assessmentRepository: assessments, debug: createDebugTools(options),
      pipeline: new InProcessPipeline({ ...mockSources(), repository: scans, timeoutMs: 600_000 }),
      domainResolver: new PublicDomainResolver(async () => {}), sessionSecret: secret, corsOrigins: [origin], clientIp: () => '127.0.0.1' });
    expect((await app.request('/__debug/mode')).status).toBe(200);
    for (const path of ['/__debug/auth/login', '/__debug/billing/pay']) {
      const response = await app.request(path, { method: 'POST', body: JSON.stringify({ email: OWNER, sessionId: 'cs_x' }),
        headers: { 'Content-Type': 'application/json', [DEBUG_REQUEST_HEADER]: '1' } });
      expect(response.status).toBe(404);
    }
    expect((await app.request('/me')).status).toBe(501);
  });

  it('nor does compose build one: the webapp answers 501 there', async () => {
    // Stands in for Supabase, which compose reaches once at start to fail the scans a restart interrupted.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
    try {
      const { app } = await compose(loadEnv({ ARCA_MODE: 'live-debug', SOURCE_MODE: 'live', STORAGE_BACKEND: 'supabase',
        SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SECRET_KEY: 'sb_secret_x', OPENAI_API_KEY: 'sk-x', APIFY_API_TOKEN: 'apify_x',
        SESSION_TOKEN_SECRET: secret, CORS_ALLOWED_ORIGINS: origin }));
      expect((await app.request('/__debug/mode')).status).toBe(200);
      const login = await app.request('/__debug/auth/login', { method: 'POST', body: JSON.stringify({ email: OWNER }),
        headers: { 'Content-Type': 'application/json', [DEBUG_REQUEST_HEADER]: '1' } });
      expect(login.status).toBe(404);
      const me = await app.request('/me', { headers: { Authorization: 'Bearer x' } });
      expect(me.status).toBe(501);
      expect(await me.json()).toEqual({ error: 'not_configured', message: expect.any(String) });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('refuses to build the mock login outside mock', () => {
    const { scans, assessments, options } = liveDebug();
    const repository = new InMemoryWebappRepository(DEFAULT_PLANS);
    const billing = new MockBillingProvider(origin);
    const service = new WebappService({ repository, scans, assessments, billing, sessionSecret: secret, appBaseUrl: origin });
    expect(() => createDebugTools({ ...options, webapp: { auth: new MockAppAuth(secret), billing, service, repository } })).toThrow('mock');
  });
});

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ActionItemView, ActionPlanResponse, ActivityPage, AdminAuditPage, AdminMetricsView, AdminOrgDetailView, AdminOrgView, AnalysisView,
  AssessmentView, ClaimResponse, DeletionRequestView, InvitationView, MeResponse, MemberView, OrgView, PlanView, PollResponse, ROLES, ScanResponse,
  StartedAssessmentResponse, UrlResponse, type AnswerValue, type RenderedQuestion, type Role } from '@arca/contracts';
import { DEBUG_REQUEST_HEADER, DEBUG_SCENARIO_HEADER, DebugSeedResponse, type DebugModeResponse,
  type DebugScenarioInput } from '@arca/contracts/debug';
import { InMemoryAssessmentRepository } from '../../src/assessment/repository.js';
import { AssessmentService } from '../../src/assessment/service.js';
import { compose } from '../../src/compose.js';
import { loadEnv } from '../../src/config/env.js';
import { RoutingAssessmentRepository, RoutingScanRepository } from '../../src/debug/isolation.js';
import { createDebugTools } from '../../src/debug/tools.js';
import { createApp } from '../../src/http/app.js';
import { ScanLimiter } from '../../src/http/rate-limit.js';
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
  /** With `assessed`, the assessment is completed before the claim, which gives the organization its action plan. */
  async function claim(email = OWNER, options: { assessed?: boolean } = {}) {
    const started = await scan(app, email);
    if (options.assessed) await completeAssessment(app, started);
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
  async function ownedOrg(email = OWNER, options: { paid?: boolean; assessed?: boolean } = {}) {
    const owner = await login(email);
    const org = await createOrg(owner.token, await claim(email, { assessed: options.assessed }));
    if (options.paid ?? true) await pay(owner.token, org.id);
    return { owner, org };
  }
  async function actionPlan(token: string, orgId: string) {
    const reply = await call('GET', `/orgs/${orgId}/actions`, { token });
    expect(reply.status).toBe(200);
    return ActionPlanResponse.parse(reply.body);
  }
  async function createAction(token: string, orgId: string, title = 'Name an AI lead') {
    const reply = await call('POST', `/orgs/${orgId}/actions`, { token, body: { title } });
    expect(reply.status).toBe(201);
    return ActionItemView.parse(reply.body);
  }
  return { ...composed, call, login, claim, createOrg, pay, invite, join, ownedOrg, actionPlan, createAction };
}

// The front sends an action key through encodeURIComponent: an assessment key holds a colon (improve:D1.1).
const actionPath = (orgId: string, key: string) => `/orgs/${orgId}/actions/${encodeURIComponent(key)}`;

type OrgIds = { orgId: string; memberId: string; invitationId: string; actionKey: string };
/** Every route under /orgs/:id, each with a valid body, so only who asks decides the answer. */
const orgRoutes = ({ orgId, memberId, invitationId, actionKey }: OrgIds): Array<[method: string, path: string, body?: unknown]> => [
  ['GET', `/orgs/${orgId}`],
  ['PATCH', `/orgs/${orgId}`, { name: 'Smith & Co' }],
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
  ['GET', `/orgs/${orgId}/actions`],
  ['POST', `/orgs/${orgId}/actions`, { title: 'Name an AI lead' }],
  ['PATCH', actionPath(orgId, actionKey), { status: 'done' }],
  ['DELETE', actionPath(orgId, actionKey)],
  ['GET', `/orgs/${orgId}/activity`],
];
/** Every route of ARCA's panel; `:id` is a deletion request, `:org` an organization. */
const adminRoutes = (ids: { deletionId: string; orgId: string }): Array<[method: string, path: string, body?: unknown]> => [
  ['GET', '/admin/organizations'],
  ['GET', `/admin/organizations/${ids.orgId}`],
  ['GET', '/admin/audit'],
  ['GET', '/admin/metrics'],
  ['GET', '/admin/deletion-requests'],
  ['POST', `/admin/deletion-requests/${ids.deletionId}/approve`, {}],
  ['POST', `/admin/deletion-requests/${ids.deletionId}/reject`, {}],
  ['GET', '/admin/plans'],
  ['PUT', '/admin/plans/monthly', { amountCents: 1 }],
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
    const bAction = await s.createAction(b.owner.token, b.org.id);
    const before = await s.call('GET', `/orgs/${b.org.id}/members`, { token: b.owner.token });
    const beforeActivity = await s.call('GET', `/orgs/${b.org.id}/activity`, { token: b.owner.token });

    // Not 403: an outsider must not learn that the organization exists.
    for (const [method, path, body] of orgRoutes({ orgId: b.org.id, memberId: bMember.user.userId, invitationId: invitation.id,
      actionKey: bAction.key })) {
      expect(await s.call(method, path, { token: a.owner.token, body }), `${method} ${path}`).toEqual(failure(404, 'not_found'));
    }
    // Nor does A reach B's action through its own organization.
    expect(await s.call('PATCH', actionPath(a.org.id, bAction.key), { token: a.owner.token, body: { status: 'done' } }))
      .toEqual(failure(404, 'not_found'));
    expect(await s.call('DELETE', actionPath(a.org.id, bAction.key), { token: a.owner.token })).toEqual(failure(404, 'not_found'));
    // The same answer as for an organization that does not exist at all.
    expect(await s.call('GET', `/orgs/${crypto.randomUUID()}`, { token: a.owner.token })).toEqual(failure(404, 'not_found'));
    // Nor can A reach B's invitation from its own organization.
    expect(await s.call('DELETE', `/orgs/${a.org.id}/invitations/${invitation.id}`, { token: a.owner.token })).toEqual(failure(404, 'not_found'));
    expect(await s.call('PATCH', `/orgs/${a.org.id}/members/${bMember.user.userId}`, { token: a.owner.token, body: { role: 'viewer' } }))
      .toEqual(failure(404, 'not_found'));

    // B is untouched, and A only ever sees its own organization.
    expect(await s.call('GET', `/orgs/${b.org.id}/members`, { token: b.owner.token })).toEqual(before);
    expect(await s.call('GET', `/orgs/${b.org.id}/activity`, { token: b.owner.token })).toEqual(beforeActivity);
    expect((await s.actionPlan(b.owner.token, b.org.id)).items).toEqual([bAction]);
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

    // Billing, the deletion request, renaming and the activity included.
    for (const [method, path, body] of orgRoutes({ orgId: org.id, memberId: member.user.userId, invitationId: pending.invitation.id,
      actionKey: `c.${crypto.randomUUID()}` })) {
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
    // Paying is how an organization gets in, and asking for its deletion needs no payment either (DN-10 §4.4). Renaming it and
    // reading its activity need none (DN-11 D5, D6): the owner keeps their trail unpaid.
    const exempt = new Set([`GET /orgs/${org.id}`, `PATCH /orgs/${org.id}`, `POST /orgs/${org.id}/billing/checkout`,
      `POST /orgs/${org.id}/billing/portal`, `POST /orgs/${org.id}/deletion-request`, `GET /orgs/${org.id}/activity`]);
    const routes = orgRoutes({ orgId: org.id, memberId: owner.user.userId, invitationId: crypto.randomUUID(),
      actionKey: `c.${crypto.randomUUID()}` });
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

  describe('every role against every route', () => {
    type Team = { orgId: string; ids: Record<Role, string>; tokens: Record<Role, string>; invitationId: string; deletionId: string;
      assessmentKey: string; customKey: string };
    type Snapshot = { members: Reply; actions: Reply; activity: Reply; plans: Reply; requests: Reply };
    let team: Team;
    let s: Awaited<ReturnType<typeof mockApp>>;
    let before: Snapshot;
    const snapshot = async (): Promise<Snapshot> => {
      const ops = await s.login('ops@arca.example', true);
      const read = (path: string) => s.call('GET', path, { token: team.tokens.owner });
      return { members: await read(`/orgs/${team.orgId}/members`), actions: await read(`/orgs/${team.orgId}/actions`),
        activity: await read(`/orgs/${team.orgId}/activity?limit=200`), plans: await s.call('GET', '/admin/plans', { token: ops.token }),
        requests: await s.call('GET', '/admin/deletion-requests', { token: ops.token }) };
    };

    beforeAll(async () => {
      s = await mockApp();
      const owner = await s.login(OWNER);
      // The assessment is completed before the claim, so the organization has a plan whose keys are real.
      const org = await s.createOrg(owner.token, await s.claim(OWNER, { assessed: true }));
      await s.pay(owner.token, org.id);
      const admin = await s.join(owner.token, org.id, 'admin@robust.arca.example', 'admin');
      const member = await s.join(owner.token, org.id, 'member@robust.arca.example', 'member');
      const viewer = await s.join(owner.token, org.id, 'viewer@robust.arca.example', 'viewer');
      const { invitation } = await s.invite(owner.token, org.id, 'pending@robust.arca.example', 'viewer');
      const deletion = DeletionRequestView.parse((await s.call('POST', `/orgs/${org.id}/deletion-request`, { token: owner.token,
        body: { reason: 'Closing the firm' } })).body);
      const assessmentKey = (await s.actionPlan(owner.token, org.id)).items.find(item => item.source === 'assessment')?.key;
      expect(assessmentKey).toMatch(/^a\.sc_[a-zA-Z0-9]+\..+$/);
      const custom = await s.createAction(owner.token, org.id);
      team = { orgId: org.id, invitationId: invitation.id, deletionId: deletion.id, assessmentKey: assessmentKey!, customKey: custom.key,
        ids: { owner: owner.user.userId, admin: admin.user.userId, member: member.user.userId, viewer: viewer.user.userId },
        tokens: { owner: owner.token, admin: admin.token, member: member.token, viewer: viewer.token } };
      before = await snapshot();
    });

    // What each role gets on each route. Every allowed call is chosen so it leaves the organization as it was, or only adds to
    // it, and so the next role meets the same state: renaming to the same name, marking an untouched action todo, a deletion
    // request already pending.
    const everyone = (status: number) => ({ owner: status, admin: status, member: status, viewer: status });
    const only = (roles: Role[], status: number) =>
      Object.fromEntries(ROLES.map(role => [role, roles.includes(role) ? status : 403])) as Record<Role, number>;
    const managers: Role[] = ['owner', 'admin'];
    const markers: Role[] = ['owner', 'admin', 'member'];
    const nobody = everyone(403);
    type Row = { name: string; method: string; path: (t: Team) => string; body?: unknown; expected: Record<Role, number> };
    const orgPath = (path: string) => (t: Team) => `/orgs/${t.orgId}${path}`;
    const rows: Row[] = [
      { name: 'read the organization', method: 'GET', path: orgPath(''), expected: everyone(200) },
      { name: 'rename it to its own name', method: 'PATCH', path: orgPath(''), body: { name: 'Smith & Co' }, expected: only(managers, 200) },
      { name: 'read the analyses', method: 'GET', path: orgPath('/analyses'), expected: everyone(200) },
      // A member saves no analysis (DN-11 D2); the others get as far as the made-up claim.
      { name: 'add an analysis', method: 'POST', path: orgPath('/analyses'), body: { claimId: 'not-a-real-claim' }, expected: only(managers, 410) },
      { name: 'read the members', method: 'GET', path: orgPath('/members'), expected: everyone(200) },
      { name: 'invite', method: 'POST', path: orgPath('/invitations'), body: { email: 'newcomer@elsewhere.example', role: 'viewer' },
        expected: only(managers, 201) },
      { name: 'revoke an unknown invitation', method: 'DELETE', path: t => `/orgs/${t.orgId}/invitations/${crypto.randomUUID()}`,
        expected: only(managers, 404) },
      { name: 'keep a viewer a viewer', method: 'PATCH', path: t => `/orgs/${t.orgId}/members/${t.ids.viewer}`, body: { role: 'viewer' },
        expected: only(managers, 200) },
      // An admin may not touch an owner nor hand out ownership; the owner meets the last-owner rule.
      { name: 'demote the owner', method: 'PATCH', path: t => `/orgs/${t.orgId}/members/${t.ids.owner}`, body: { role: 'admin' },
        expected: { ...nobody, owner: 409 } },
      { name: 'keep the owner an owner', method: 'PATCH', path: t => `/orgs/${t.orgId}/members/${t.ids.owner}`, body: { role: 'owner' },
        expected: { ...nobody, owner: 200 } },
      { name: 'remove the owner', method: 'DELETE', path: t => `/orgs/${t.orgId}/members/${t.ids.owner}`, expected: { ...nobody, owner: 409 } },
      { name: 'remove an unknown member', method: 'DELETE', path: t => `/orgs/${t.orgId}/members/${crypto.randomUUID()}`,
        expected: only(managers, 404) },
      // Already paid, so the owner is sent to the portal.
      { name: 'check out', method: 'POST', path: orgPath('/billing/checkout'), body: { planCode: 'monthly' }, expected: { ...nobody, owner: 409 } },
      { name: 'open the portal', method: 'POST', path: orgPath('/billing/portal'), expected: { ...nobody, owner: 200 } },
      { name: 'request deletion again', method: 'POST', path: orgPath('/deletion-request'), body: { reason: 'Not mine to ask' },
        expected: { ...nobody, owner: 409 } },
      { name: 'read the action plan', method: 'GET', path: orgPath('/actions'), expected: everyone(200) },
      { name: 'create an action', method: 'POST', path: orgPath('/actions'), body: { title: 'Another action' }, expected: only(managers, 201) },
      { name: 'mark an assessment action', method: 'PATCH', path: t => actionPath(t.orgId, t.assessmentKey), body: { status: 'todo' },
        expected: only(markers, 200) },
      { name: 'mark an own action', method: 'PATCH', path: t => actionPath(t.orgId, t.customKey), body: { status: 'todo' },
        expected: only(markers, 200) },
      { name: 'clear a due date', method: 'PATCH', path: t => actionPath(t.orgId, t.assessmentKey), body: { dueDate: null },
        expected: only(managers, 200) },
      { name: 'clear an assignee', method: 'PATCH', path: t => actionPath(t.orgId, t.customKey), body: { assigneeUserId: null },
        expected: only(managers, 200) },
      { name: 'delete an assessment action', method: 'DELETE', path: t => actionPath(t.orgId, t.assessmentKey), expected: only(managers, 400) },
      { name: 'delete an unknown action', method: 'DELETE', path: t => actionPath(t.orgId, `c.${crypto.randomUUID()}`),
        expected: only(managers, 404) },
      { name: 'read the activity', method: 'GET', path: orgPath('/activity'), expected: only(managers, 200) },
      // An organization owner is not an ARCA platform admin.
      ...adminRoutes({ deletionId: ':deletion', orgId: ':org' }).map(([method, path, body]): Row => ({ name: `${method} ${path}`, method,
        path: t => path.replace(':deletion', t.deletionId).replace(':org', t.orgId), body, expected: nobody })),
    ];
    const cells = rows.flatMap(row => ROLES.map(role => ({ ...row, role, status: row.expected[role] })));

    it('walks every webapp route', () => {
      // Path shapes, ids replaced, so a route added later without a row fails here.
      const shape = (path: string) => path.replace(/\/orgs\/[^/]+/, '/orgs/:id')
        .replace(/\/(members|invitations|actions|organizations|deletion-requests)\/[^/?]+/, '/$1/:param');
      const ids = { orgId: 'o', memberId: 'm', invitationId: 'i', actionKey: 'c.k' };
      const routes = [...orgRoutes(ids), ...adminRoutes({ deletionId: 'd', orgId: 'o' })].map(([method, path]) => `${method} ${shape(path)}`);
      const covered = new Set(rows.map(row => `${row.method} ${shape(row.path({ ...team, orgId: 'o' }))}`));
      expect(routes.filter(route => !covered.has(route))).toEqual([]);
    });

    it.each(cells.filter(cell => cell.status === 403))('$role is refused: $name', async ({ role, method, path, body }) => {
      expect(await s.call(method, path(team), { token: team.tokens[role], body })).toEqual(failure(403, 'forbidden'));
    });

    it('and none of the refusals changed anything', async () => {
      expect(await snapshot()).toEqual(before);
    });

    it.each(cells.filter(cell => cell.status !== 403))('$role may: $name ($status)', async ({ role, method, path, body, status }) => {
      expect((await s.call(method, path(team), { token: team.tokens[role], body })).status).toBe(status);
    });
  });

  it('without a token the app answers 401, and with a scan session token too', async () => {
    const s = await mockApp();
    const { owner, org } = await s.ownedOrg();
    const started = await scan(s.app);
    const routes: Array<[method: string, path: string, body?: unknown]> = [
      ['GET', '/me'],
      ['POST', '/orgs', { name: 'Smith & Co', claimId: 'not-a-real-claim' }],
      ...orgRoutes({ orgId: org.id, memberId: owner.user.userId, invitationId: crypto.randomUUID(), actionKey: `c.${crypto.randomUUID()}` }),
      ['POST', '/invitations/not-a-real-token/accept'],
      ...adminRoutes({ deletionId: crypto.randomUUID(), orgId: org.id }),
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
    const stranger = await s.login('stranger@robust.arca.example');
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
      ['PATCH', `/orgs/${org.id}`, { name: '   ' }, owner.token],
      ['PATCH', `/orgs/${org.id}`, { name: 'x'.repeat(121) }, owner.token],
      ['PATCH', `/orgs/${org.id}`, { name: 'Smith & Co', domain: 'other.example' }, owner.token],
      ['POST', `/orgs/${org.id}/actions`, {}, owner.token],
      ['POST', `/orgs/${org.id}/actions`, { title: '  ' }, owner.token],
      ['POST', `/orgs/${org.id}/actions`, { title: 'x'.repeat(201) }, owner.token],
      ['POST', `/orgs/${org.id}/actions`, { title: 'Name an AI lead', detail: 'x'.repeat(2001) }, owner.token],
      ['POST', `/orgs/${org.id}/actions`, { title: 'Name an AI lead', domain: 'finance' }, owner.token],
      ['POST', `/orgs/${org.id}/actions`, { title: 'Name an AI lead', status: 'done' }, owner.token],
      // Nothing to change is a 400 before anything else, whatever the key.
      ['PATCH', actionPath(org.id, 'c.whatever'), {}, owner.token],
      ['PATCH', actionPath(org.id, 'c.whatever'), { status: 'finished' }, owner.token],
      ['PATCH', actionPath(org.id, 'c.whatever'), { dueDate: '2026-13-01' }, owner.token],
      ['PATCH', actionPath(org.id, 'c.whatever'), { dueDate: '01/12/2026' }, owner.token],
      ['PATCH', actionPath(org.id, 'c.whatever'), { assigneeUserId: '' }, owner.token],
      // A user id is a UUID; anything else is refused with the body, before who asks or which key is looked at.
      ['PATCH', actionPath(org.id, 'c.whatever'), { assigneeUserId: 'user_missing' }, owner.token],
      ['PATCH', actionPath(org.id, 'c.whatever'), { assigneeUserId: 'user_missing' }, stranger.token],
      ['PATCH', actionPath(org.id, 'c.whatever'), { status: 'done', title: 'Renamed' }, owner.token],
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

  it('a member marks the plan, the owner assigns and sees it, and only the organization\'s own actions are deleted', async () => {
    const s = await mockApp();
    const { owner, org } = await s.ownedOrg(OWNER, { assessed: true });
    const member = await s.join(owner.token, org.id, 'member@robust.arca.example', 'member');
    const plan = await s.actionPlan(member.token, org.id);
    expect(plan.source).toMatchObject({ domain: DOMAIN });
    const [first] = plan.items;
    expect(first).toMatchObject({ source: 'assessment', status: 'todo', assignee: null, dueDate: null, updatedAt: null });
    // An assessment key holds a colon, which the front encodes.
    expect(first!.key).toMatch(/^a\.sc_[a-zA-Z0-9]+\.improve:/);

    const marked = await s.call('PATCH', actionPath(org.id, first!.key), { token: member.token, body: { status: 'done' } });
    expect(marked).toEqual({ status: 200, body: { ...first, status: 'done', updatedAt: expect.any(String) } });
    expect(await s.call('PATCH', actionPath(org.id, first!.key), { token: member.token, body: { status: 'todo', dueDate: '2026-12-01' } }))
      .toEqual(failure(403, 'forbidden'));
    const assigned = await s.call('PATCH', actionPath(org.id, first!.key), { token: owner.token,
      body: { assigneeUserId: member.user.userId, dueDate: '2026-12-01' } });
    expect(assigned.status).toBe(200);
    expect(ActionItemView.parse(assigned.body)).toMatchObject({ status: 'done', dueDate: '2026-12-01',
      assignee: { userId: member.user.userId, email: 'member@robust.arca.example' } });
    // Only someone who can mark actions may hold one.
    const viewer = await s.join(owner.token, org.id, 'viewer@robust.arca.example', 'viewer');
    expect(await s.call('PATCH', actionPath(org.id, first!.key), { token: owner.token, body: { assigneeUserId: viewer.user.userId } }))
      .toEqual(failure(400, 'invalid_request'));
    expect((await s.actionPlan(owner.token, org.id)).items[0]).toEqual(ActionItemView.parse(assigned.body));

    const own = await s.createAction(owner.token, org.id);
    expect(own).toMatchObject({ source: 'custom', title: 'Name an AI lead', pointsGain: null, status: 'todo' });
    expect(await s.call('DELETE', actionPath(org.id, first!.key), { token: owner.token })).toEqual(failure(400, 'invalid_request'));
    expect(await s.call('DELETE', actionPath(org.id, own.key), { token: member.token })).toEqual(failure(403, 'forbidden'));
    expect(await s.call('DELETE', actionPath(org.id, own.key), { token: owner.token })).toEqual({ status: 204, body: null });
    expect(await s.call('DELETE', actionPath(org.id, own.key), { token: owner.token })).toEqual(failure(404, 'not_found'));

    const activity = ActivityPage.parse((await s.call('GET', `/orgs/${org.id}/activity`, { token: owner.token })).body);
    expect(activity.events.filter(event => event.action.startsWith('action.')).map(event => [event.action, event.actor.email, event.change]))
      .toEqual([['action.deleted', OWNER, null], ['action.created', OWNER, null], ['action.updated', OWNER, { from: null, to: '2026-12-01' }],
        ['action.updated', 'member@robust.arca.example', { from: 'todo', to: 'done' }]]);
  });

  it('an action of the organization\'s own sent with a blank or null detail is stored with none', async () => {
    const s = await mockApp();
    const { owner, org } = await s.ownedOrg();
    const created: ActionItemView[] = [];
    for (const detail of [undefined, null, '', '   ', ' Ask the vendor ']) {
      const reply = await s.call('POST', `/orgs/${org.id}/actions`, { token: owner.token, body: { title: 'Review vendor terms', detail } });
      expect(reply.status, JSON.stringify(detail)).toBe(201);
      created.push(ActionItemView.parse(reply.body));
    }
    expect(created.map(item => item.detail)).toEqual([null, null, null, null, 'Ask the vendor']);
    expect((await s.actionPlan(owner.token, org.id)).items.map(item => item.detail)).toEqual([null, null, null, null, 'Ask the vendor']);
  });

  it('a key of another organization or of an older plan is not found', async () => {
    const s = await mockApp();
    const a = await s.ownedOrg('owner@robust.arca.example', { assessed: true });
    const b = await s.ownedOrg('partner@robust.arca.example', { assessed: true });
    const theirs = [(await s.actionPlan(b.owner.token, b.org.id)).items[0]!.key, (await s.createAction(b.owner.token, b.org.id)).key];
    const bBefore = await s.actionPlan(b.owner.token, b.org.id);
    for (const key of theirs) {
      expect(await s.call('PATCH', actionPath(a.org.id, key), { token: a.owner.token, body: { status: 'done' } })).toEqual(failure(404, 'not_found'));
      expect(await s.call('PATCH', actionPath(a.org.id, key), { token: a.owner.token, body: { dueDate: null } })).toEqual(failure(404, 'not_found'));
    }
    expect(await s.call('DELETE', actionPath(a.org.id, theirs[1]!), { token: a.owner.token })).toEqual(failure(404, 'not_found'));
    expect(await s.actionPlan(b.owner.token, b.org.id)).toEqual(bBefore);

    // A newer analysis with a completed assessment replaces the plan: the old keys name nothing and nothing carries over.
    const [old] = (await s.actionPlan(a.owner.token, a.org.id)).items;
    expect((await s.call('PATCH', actionPath(a.org.id, old!.key), { token: a.owner.token, body: { status: 'done' } })).status).toBe(200);
    const attached = await s.call('POST', `/orgs/${a.org.id}/analyses`, { token: a.owner.token,
      body: { claimId: await s.claim('owner@robust.arca.example', { assessed: true }) } });
    expect(attached.status).toBe(201);
    const current = await s.actionPlan(a.owner.token, a.org.id);
    expect(current.source?.scanId).toBe(AnalysisView.parse(attached.body).scanId);
    expect(current.items.map(item => item.key)).not.toContain(old!.key);
    expect(current.items.every(item => item.status === 'todo' && item.updatedAt === null)).toBe(true);
    expect(await s.call('PATCH', actionPath(a.org.id, old!.key), { token: a.owner.token, body: { status: 'in_progress' } }))
      .toEqual(failure(404, 'not_found'));
  });

  it('answers 429 after 60 writes to the action plan in a minute', async () => {
    const s = await mockApp();
    const { owner, org } = await s.ownedOrg();
    const own = await s.createAction(owner.token, org.id);
    for (let index = 0; index < 59; index++) {
      const reply = await s.call('PATCH', actionPath(org.id, own.key), { token: owner.token, body: { status: index % 2 ? 'todo' : 'done' } });
      expect(reply.status).toBe(200);
    }
    expect(await s.call('PATCH', actionPath(org.id, own.key), { token: owner.token, body: { status: 'in_progress' } }))
      .toEqual(failure(429, 'rate_limited'));
    expect(await s.call('POST', `/orgs/${org.id}/actions`, { token: owner.token, body: { title: 'Another' } })).toEqual(failure(429, 'rate_limited'));
    expect((await s.actionPlan(owner.token, org.id)).items).toEqual([expect.objectContaining({ key: own.key, status: 'done' })]);
  });

  it('owners and admins read the activity, paged, and never the email of ARCA staff', async () => {
    const s = await mockApp();
    const { owner, org } = await s.ownedOrg();
    const admin = await s.join(owner.token, org.id, 'admin@robust.arca.example', 'admin');
    const member = await s.join(owner.token, org.id, 'member@robust.arca.example', 'member');
    const requested = DeletionRequestView.parse((await s.call('POST', `/orgs/${org.id}/deletion-request`, { token: owner.token,
      body: { reason: 'Closing the firm' } })).body);
    const ops = await s.login('ops@arca.example', true);
    expect((await s.call('POST', `/admin/deletion-requests/${requested.id}/reject`, { token: ops.token })).status).toBe(200);

    const reply = await s.call('GET', `/orgs/${org.id}/activity`, { token: admin.token });
    expect(reply.status).toBe(200);
    const all = ActivityPage.parse(reply.body);
    expect(all.events[0]).toMatchObject({ action: 'org.deletion_rejected', actor: { kind: 'arca', email: null } });
    expect(all.events.at(-1)).toMatchObject({ action: 'org.created', actor: { kind: 'member', email: OWNER } });
    expect(all.nextBefore).toBeNull();
    expect(JSON.stringify(reply.body)).not.toContain('ops@arca.example');
    expect(await s.call('GET', `/orgs/${org.id}/activity`, { token: member.token })).toEqual(failure(403, 'forbidden'));
    // ARCA's own audit names its staff.
    const audit = await s.call('GET', `/admin/audit?orgId=${org.id}&limit=1`, { token: ops.token });
    expect(AdminAuditPage.parse(audit.body).events).toEqual([expect.objectContaining({ action: 'org.deletion_rejected', actorKind: 'platform',
      actorEmail: 'ops@arca.example', orgName: 'Smith & Co' })]);

    const first = ActivityPage.parse((await s.call('GET', `/orgs/${org.id}/activity?limit=2`, { token: owner.token })).body);
    expect(first.events).toEqual(all.events.slice(0, 2));
    const next = await s.call('GET', `/orgs/${org.id}/activity?limit=2&before=${first.nextBefore}`, { token: owner.token });
    expect(ActivityPage.parse(next.body).events).toEqual(all.events.slice(2, 4));
    expect((await s.call('GET', `/orgs/${org.id}/activity?limit=200`, { token: owner.token })).status).toBe(200);
    for (const query of ['limit=0', 'limit=201', 'limit=abc', 'limit=1.5', 'limit=', 'before=0', 'before=-3', 'before=x', 'before=1e3']) {
      expect(await s.call('GET', `/orgs/${org.id}/activity?${query}`, { token: owner.token }), query).toEqual(failure(400, 'invalid_request'));
    }
  });

  it('owners and admins rename the organization', async () => {
    const s = await mockApp();
    const { owner, org } = await s.ownedOrg();
    const admin = await s.join(owner.token, org.id, 'admin@robust.arca.example', 'admin');
    const member = await s.join(owner.token, org.id, 'member@robust.arca.example', 'member');
    expect(await s.call('PATCH', `/orgs/${org.id}`, { token: member.token, body: { name: 'Mine now' } })).toEqual(failure(403, 'forbidden'));
    const renamed = await s.call('PATCH', `/orgs/${org.id}`, { token: admin.token, body: { name: '  Robust Law (demo)  ' } });
    expect(renamed).toEqual({ status: 200, body: { ...org, name: 'Robust Law (demo)', role: 'admin', billingStatus: 'active', paidAccess: true } });
    expect(MeResponse.parse((await s.call('GET', '/me', { token: owner.token })).body).organizations[0]).toMatchObject({ name: 'Robust Law (demo)' });
    const [latest] = ActivityPage.parse((await s.call('GET', `/orgs/${org.id}/activity`, { token: owner.token })).body).events;
    expect(latest).toMatchObject({ action: 'org.renamed', actor: { kind: 'member', email: 'admin@robust.arca.example' },
      targetLabel: 'Robust Law (demo)', change: { from: 'Smith & Co', to: 'Robust Law (demo)' } });
  });

  it('gives ARCA an organization in detail, its audit and the metrics', async () => {
    const s = await mockApp();
    const { owner, org } = await s.ownedOrg(OWNER, { assessed: true });
    const plan = await s.actionPlan(owner.token, org.id);
    const ops = await s.login('ops@arca.example', true);

    const detail = await s.call('GET', `/admin/organizations/${org.id}`, { token: ops.token });
    expect(detail.status).toBe(200);
    expect(AdminOrgDetailView.parse(detail.body)).toEqual({ id: org.id, name: 'Smith & Co', domain: DOMAIN, billingStatus: 'active', deleted: false,
      createdAt: expect.any(String), planCode: 'monthly', analysisCount: 1, pendingDeletion: null,
      members: [{ email: OWNER, role: 'owner', joinedAt: expect.any(String) }] });
    expect(await s.call('GET', `/admin/organizations/${crypto.randomUUID()}`, { token: ops.token })).toEqual(failure(404, 'not_found'));
    // An id that is not a UUID is not looked up at all: a uuid column would refuse it with an error, not a 404.
    expect(await s.call('GET', '/admin/organizations/org_missing', { token: ops.token })).toEqual(failure(404, 'not_found'));

    const metrics = await s.call('GET', '/admin/metrics', { token: ops.token });
    expect(AdminMetricsView.parse(metrics.body)).toEqual({ organizations: { pending_payment: 0, active: 1, past_due: 0, canceled: 0, deleted: 0 },
      members: 1, analyses: 1, pendingDeletionRequests: 0, actions: { todo: plan.items.length, in_progress: 0, done: 0 } });

    const audit = AdminAuditPage.parse((await s.call('GET', '/admin/audit', { token: ops.token })).body);
    expect(audit.events.map(event => event.action)).toEqual(['billing.event_applied', 'org.created']);
    for (const orgId of [crypto.randomUUID(), 'org_missing']) {
      expect(await s.call('GET', `/admin/audit?orgId=${orgId}`, { token: ops.token }), orgId).toEqual({ status: 200,
        body: { events: [], nextBefore: null } });
    }
    expect((await s.call('GET', '/admin/audit?limit=500', { token: ops.token })).status).toBe(200);
    for (const query of ['limit=0', 'limit=501', 'before=abc', 'orgId=']) {
      expect(await s.call('GET', `/admin/audit?${query}`, { token: ops.token }), query).toEqual(failure(400, 'invalid_request'));
    }
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

describe('the demo seed', () => {
  const DEMO = 'demo.arca.example';
  const SEEDED_USERS = [{ email: `owner@${DEMO}`, role: 'owner' }, { email: `admin@${DEMO}`, role: 'admin' },
    { email: `member@${DEMO}`, role: 'member' }, { email: `viewer@${DEMO}`, role: 'viewer' }, { email: `ops@${DEMO}`, role: 'platform_admin' }];
  async function seed(s: Awaited<ReturnType<typeof mockApp>>) {
    const reply = await s.call('POST', '/__debug/seed', { debug: true });
    expect(reply.status).toBe(200);
    return DebugSeedResponse.parse(reply.body);
  }
  async function organizations(s: Awaited<ReturnType<typeof mockApp>>) {
    const ops = await s.login(`ops@${DEMO}`);
    return z.array(AdminOrgView).parse((await s.call('GET', '/admin/organizations', { token: ops.token })).body);
  }
  /** The mock app built by hand, the way compose builds it, so a test can hold or watch the scan pipeline. */
  function handBuilt(options: { hold?: Promise<void>; seedTimeoutMs?: number } = {}) {
    const scans = new RoutingScanRepository(new InMemoryRepository(), new InMemoryRepository());
    const assessments = new RoutingAssessmentRepository(new InMemoryAssessmentRepository(), new InMemoryAssessmentRepository(), scans);
    const repository = new InMemoryWebappRepository(DEFAULT_PLANS);
    const billing = new MockBillingProvider(origin);
    const auth = new MockAppAuth(secret);
    const service = new WebappService({ repository, scans, assessments, billing, sessionSecret: secret, appBaseUrl: origin });
    const real = new InProcessPipeline({ ...mockSources(), repository: scans, timeoutMs: 600_000 });
    const run = vi.fn(async (input: Parameters<InProcessPipeline['run']>[0]) => { await options.hold; return real.run(input); });
    const debug = createDebugTools({ mode: 'mock', sources: mockSources(), scans, assessments, pipelineTimeoutMs: 600_000,
      describe: { mode: 'mock', sourceMode: 'mock', storageBackend: 'memory', websiteEvidenceProvider: 'mock', assessmentPlanner: 'rules',
        signalLlmModel: null, inUse: { openai: false, apify: false, supabase: false } },
      webapp: { auth, billing, service, repository }, seedTimeoutMs: options.seedTimeoutMs });
    const { app } = createApp({ repository: scans, assessmentRepository: assessments, debug, webapp: { service, auth }, pipeline: { run },
      domainResolver: new PublicDomainResolver(async () => {}), sessionSecret: secret, corsOrigins: [origin], clientIp: () => '127.0.0.1' });
    const seed = () => app.request('/__debug/seed', { method: 'POST', headers: { [DEBUG_REQUEST_HEADER]: '1' } });
    return { app, debug, repository, run, seed };
  }

  it('builds a paid organization with a user of each role through the real flow, its plan holding at least three actions', async () => {
    const s = await mockApp();
    const response = await s.app.request('/__debug/seed', { method: 'POST' });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_request', message: expect.stringContaining(DEBUG_REQUEST_HEADER) });
    const demo = await seed(s);
    // Strict: never a token.
    expect(demo).toEqual({ organization: { id: expect.any(String), name: 'Robust Law (demo)' }, users: SEEDED_USERS });
    // Each user signs in through the mock login, as the debug panel does, and finds the organization paid, with their role.
    for (const { email, role } of SEEDED_USERS.slice(0, 4)) {
      const { token } = await s.login(email);
      expect(MeResponse.parse((await s.call('GET', '/me', { token })).body).organizations, email)
        .toEqual([expect.objectContaining({ id: demo.organization.id, role, billingStatus: 'active', paidAccess: true })]);
    }
    const owner = await s.login(`owner@${DEMO}`);
    const plan = await s.actionPlan(owner.token, demo.organization.id);
    expect(plan.source).toMatchObject({ domain: DOMAIN });
    expect(plan.items.filter(item => item.source === 'assessment').length).toBeGreaterThanOrEqual(3);
    // ops is an ARCA admin without asking the login for it, and the seed audited everything it did as the system.
    const ops = await s.login(`ops@${DEMO}`);
    expect(MeResponse.parse((await s.call('GET', '/me', { token: ops.token })).body)).toMatchObject({ organizations: [], platformAdmin: true });
    const audit = AdminAuditPage.parse((await s.call('GET', `/admin/audit?orgId=${demo.organization.id}`, { token: ops.token })).body);
    expect(audit.events.map(event => event.action).sort()).toEqual(['billing.event_applied', 'member.invited', 'member.invited',
      'member.invited', 'member.joined', 'member.joined', 'member.joined', 'org.created']);
    expect(audit.events.every(event => event.actorKind === 'system' && event.actorEmail === null)).toBe(true);
    const activity = ActivityPage.parse((await s.call('GET', `/orgs/${demo.organization.id}/activity`, { token: owner.token })).body);
    expect(activity.events.every(event => event.actor.kind === 'system' && event.actor.email === null)).toBe(true);
  });

  it('runs its scan past the limiter, without spending an attempt', async () => {
    const s = await mockApp();
    const attempt = () => s.app.request('/scan', { method: 'POST', body: JSON.stringify({ email: `owner@${DEMO}`, domain: DOMAIN }),
      headers: { 'Content-Type': 'application/json' } });
    for (let allowed = 0; allowed < 3; allowed++) expect([200, 202]).toContain((await attempt()).status);
    expect((await attempt()).status).toBe(429);
    await seed(s);
  });

  it('returns the seeded organization as the demo left it, and seeds a new one once it is deleted or after a reset', async () => {
    const s = await mockApp();
    const first = await seed(s);
    const orgId = first.organization.id;
    const owner = await s.login(`owner@${DEMO}`);
    const [member, viewer] = [await s.login(`member@${DEMO}`), await s.login(`viewer@${DEMO}`)];
    expect((await s.call('PATCH', `/orgs/${orgId}`, { token: owner.token, body: { name: 'Robust Law (renamed)' } })).status).toBe(200);
    expect((await s.call('PATCH', `/orgs/${orgId}/members/${viewer.user.userId}`, { token: owner.token, body: { role: 'member' } })).status)
      .toBe(200);
    expect((await s.call('DELETE', `/orgs/${orgId}/members/${member.user.userId}`, { token: owner.token })).status).toBe(204);
    expect(await seed(s)).toEqual({ organization: { id: orgId, name: 'Robust Law (renamed)' }, users: [SEEDED_USERS[0], SEEDED_USERS[1],
      { email: `viewer@${DEMO}`, role: 'member' }, SEEDED_USERS[4]] });
    expect((await organizations(s)).map(org => org.id)).toEqual([orgId]);
    // Deleted: ARCA approves the owner's request, and the next seed builds a new organization.
    const request = await s.call('POST', `/orgs/${orgId}/deletion-request`, { token: owner.token, body: { reason: 'The demo is over' } });
    const ops = await s.login(`ops@${DEMO}`);
    expect((await s.call('POST', `/admin/deletion-requests/${DeletionRequestView.parse(request.body).id}/approve`,
      { token: ops.token, body: {} })).status).toBe(200);
    const second = await seed(s);
    expect(second).toEqual({ organization: { id: expect.any(String), name: 'Robust Law (demo)' }, users: SEEDED_USERS });
    expect(second.organization.id).not.toBe(orgId);
    // A reset forgets it along with the rest of the memory.
    expect(await s.call('POST', '/__debug/reset', { debug: true })).toEqual({ status: 200, body: { ok: true } });
    const third = await seed(s);
    expect(third.organization.id).not.toBe(second.organization.id);
    expect((await organizations(s)).map(org => org.id)).toEqual([third.organization.id]);
  });

  it('gives requests that arrive together the one run in flight', async () => {
    const s = await mockApp();
    const replies = await Promise.all([1, 2, 3].map(() => s.call('POST', '/__debug/seed', { debug: true })));
    expect(replies.map(reply => reply.status)).toEqual([200, 200, 200]);
    expect(new Set(replies.map(reply => DebugSeedResponse.parse(reply.body).organization.id)).size).toBe(1);
    expect(await organizations(s)).toHaveLength(1);
  });

  it('checks for an active plan before anything else, so a refusal leaves no organization and runs no scan', async () => {
    const { seed, repository, run } = handBuilt();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (const code of ['monthly', 'annual']) await repository.updatePlan(code, { active: false });
      // A retry finds the same refusal, and still nothing behind it.
      for (let attempt = 0; attempt < 2; attempt++) {
        const refused = await seed();
        expect(refused.status).toBe(500);
        expect(await refused.json()).toEqual({ error: 'internal_error', message: expect.stringContaining('No active plan') });
      }
      expect(await repository.listOrganizations()).toEqual([]);
      expect(run).not.toHaveBeenCalled();
      expect(logged).toHaveBeenCalledWith('[debug] demo seed failed', expect.stringContaining('No active plan'));
    } finally {
      logged.mockRestore();
    }
    // With a plan to pay with again, the seed builds its one organization.
    await repository.updatePlan('monthly', { active: true });
    expect((await seed()).status).toBe(200);
    expect(await repository.listOrganizations()).toHaveLength(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('is the only mode whose debug routes get the seed\'s scan runner, and they refuse to go without it', () => {
    const { debug } = handBuilt();
    expect(debug.seeds).toBe(true);
    expect(() => debug.routes({ limiter: new ScanLimiter(), sessionSecret: secret })).toThrow('only in mock, and only together');
  });

  it('answers 504 when the run outlives the deadline, and the run goes on', async () => {
    // The scan's pipeline holds until the test lets it go.
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const { seed: post, repository } = handBuilt({ hold, seedTimeoutMs: 50 });
    const late = await post();
    expect(late.status).toBe(504);
    expect(await late.json()).toEqual({ error: 'timeout', message: expect.any(String) });
    release();
    const seeded = await until(async () => post(), response => response.status === 200);
    expect(DebugSeedResponse.parse(await seeded.json()).users).toEqual(SEEDED_USERS);
    expect(await repository.listOrganizations()).toHaveLength(1);
  });
});

describe('production wiring', () => {
  it('answers 501 on every webapp route, has no mock login or demo seed and keeps CORS exact', async () => {
    const { app } = await compose(loadEnv({ SOURCE_MODE: 'mock', STORAGE_BACKEND: 'memory', SESSION_TOKEN_SECRET: secret,
      CORS_ALLOWED_ORIGINS: origin }));
    const routes: Array<[string, string]> = [['GET', '/me'], ['POST', '/claims'], ['GET', '/plans'], ['POST', '/orgs'], ['GET', '/orgs/x'],
      ['PATCH', '/orgs/x'], ['GET', '/orgs/x/analyses'], ['PATCH', '/orgs/x/members/y'], ['DELETE', '/orgs/x/members/y'],
      ['POST', '/orgs/x/billing/checkout'], ['GET', '/orgs/x/actions'], ['POST', '/orgs/x/actions'], ['PATCH', '/orgs/x/actions/a.sc_1.y'],
      ['DELETE', '/orgs/x/actions/c.y'], ['GET', '/orgs/x/activity'], ['POST', '/invitations/t/accept'], ['GET', '/admin/organizations'],
      ['GET', '/admin/organizations/x'], ['GET', '/admin/audit'], ['GET', '/admin/metrics'], ['PUT', '/admin/plans/monthly'],
      ['POST', '/billing/webhook']];
    for (const [method, path] of routes) {
      const response = await app.request(path, { method, headers: { Authorization: 'Bearer x', 'Content-Type': 'application/json' },
        body: method === 'GET' ? undefined : '{}' });
      expect(response.status, `${method} ${path}`).toBe(501);
      expect(await response.json()).toEqual({ error: 'not_configured', message: expect.any(String) });
    }
    for (const path of ['/__debug/auth/login', '/__debug/billing/pay', '/__debug/seed']) {
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

  it('answers 404 on /__debug/auth/login, /__debug/billing/pay and /__debug/seed', async () => {
    const { scans, assessments, options } = liveDebug();
    const { app } = createApp({ repository: scans, assessmentRepository: assessments, debug: createDebugTools(options),
      pipeline: new InProcessPipeline({ ...mockSources(), repository: scans, timeoutMs: 600_000 }),
      domainResolver: new PublicDomainResolver(async () => {}), sessionSecret: secret, corsOrigins: [origin], clientIp: () => '127.0.0.1' });
    expect((await app.request('/__debug/mode')).status).toBe(200);
    for (const path of ['/__debug/auth/login', '/__debug/billing/pay', '/__debug/seed']) {
      const response = await app.request(path, { method: 'POST', body: JSON.stringify({ email: OWNER, sessionId: 'cs_x' }),
        headers: { 'Content-Type': 'application/json', [DEBUG_REQUEST_HEADER]: '1' } });
      expect(response.status).toBe(404);
    }
    expect((await app.request('/me')).status).toBe(501);
  });

  it('hands its debug routes no scan runner, so none that skips the limiter is built there', () => {
    const { scans, assessments, options } = liveDebug();
    const debug = createDebugTools(options);
    expect(debug.seeds).toBe(false);
    const routes = vi.spyOn(debug, 'routes');
    createApp({ repository: scans, assessmentRepository: assessments, debug,
      pipeline: new InProcessPipeline({ ...mockSources(), repository: scans, timeoutMs: 600_000 }),
      domainResolver: new PublicDomainResolver(async () => {}), sessionSecret: secret, corsOrigins: [origin], clientIp: () => '127.0.0.1' });
    expect(routes).toHaveBeenCalledTimes(1);
    expect(routes.mock.calls[0]![0]).toEqual({ limiter: expect.any(ScanLimiter), sessionSecret: secret, seed: undefined });
    // Nor would the routes take one.
    expect(() => debug.routes({ limiter: new ScanLimiter(), sessionSecret: secret,
      seed: { runScan: vi.fn(), assessments: new AssessmentService({ repository: assessments }) } })).toThrow('only in mock');
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
      expect((await app.request('/__debug/seed', { method: 'POST', headers: { [DEBUG_REQUEST_HEADER]: '1' } })).status).toBe(404);
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

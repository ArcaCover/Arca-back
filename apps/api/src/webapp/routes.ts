import { createHash } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { AttachAnalysisRequest, CheckoutRequest, CreateActionRequest, CreateClaimRequest, CreateOrgRequest, DeletionRequestBody, EnrollRequest,
  InviteRequest, ReviewRequest, SetRoleRequest, UpdateActionRequest, UpdateOrgRequest, UpdatePlanRequest } from '@arca/contracts';
import { WindowLimiter } from '../http/rate-limit.js';
import { AuthUnavailable, type AppAuth, type AppUser } from './auth.js';
import { WebappFailure, type WebappService } from './service.js';

// Every path the private webapp answers on (DN-10 §4.7, DN-11 §4.9, DN-13 §7.2). Production answers 501 on all of them unless
// WEBAPP_ENABLED=true.
const WEBAPP_PATHS = ['/me', '/claims', '/plans', '/auth/*', '/orgs', '/orgs/*', '/invitations/*', '/admin/*', '/billing/*'] as const;

// DN-13 §7.4, per process, over an hour. Enrolling creates an Auth user and lets a code be mailed to that address; closing an account
// deletes one.
const HOUR_MS = 60 * 60 * 1000;
const ENROLL_PER_ADDRESS = 10;
const ENROLL_PER_LINK = 5;
const ACCOUNT_DELETIONS_PER_USER = 3;
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

// A page of the audit log (DN-11 §4.3, §4.5): `before` is the seq the previous page ended on; a limit out of range is a 400.
const auditPage = (max: number, fallback: number) => z.object({
  before: z.string().regex(/^[1-9]\d{0,14}$/).transform(Number).optional(),
  limit: z.string().regex(/^\d{1,4}$/).transform(Number).pipe(z.number().int().min(1).max(max)).default(String(fallback)),
});

/**
 * Accounts, organizations and billing of the private webapp. The service owns every rule; these routes only authenticate, parse and
 * count requests. `clientIp` is the caller's address as the server resolved it; `limiter` is shared with the debug reset.
 */
export function webappRoutes(deps: { service: WebappService; auth: AppAuth; clientIp?: (request: Request) => string;
  limiter?: WindowLimiter; now?: () => number }): Hono {
  const { service } = deps;
  const limiter = deps.limiter ?? new WindowLimiter(HOUR_MS, deps.now);
  const app = new Hono();
  for (const path of WEBAPP_PATHS) app.use(path, noStore);
  app.onError((error, c) => {
    if (error instanceof WebappFailure) {
      if (error.retryAfter) c.header('Retry-After', String(error.retryAfter));
      return c.json({ error: error.code, message: error.message }, error.status);
    }
    // The verifier holds no key yet (Supabase unreachable since the start): 503, never a 401 that would sign the user out.
    if (error instanceof AuthUnavailable) return c.json({ error: 'auth_unavailable', message: error.message }, 503);
    throw error;
  });

  // The app's session token: Supabase's, or the simulated issuer's in the debug modes, never both. A scan session token is refused
  // here: its issuer and audience are not the app's. A closed account is refused too (DN-13 §4.4), except by DELETE /me, which
  // finishes a deletion whose Auth step failed.
  async function user(c: Context, options: { closed?: boolean } = {}): Promise<AppUser> {
    const token = /^Bearer\s+(.+)$/i.exec(c.req.header('Authorization') ?? '')?.[1];
    const verified = token ? await deps.auth.verify(token) : null;
    if (!verified) throw new WebappFailure('unauthorized', 'Invalid or missing session token', 401);
    if (!options.closed) await service.requireLiveAccount(verified);
    return verified;
  }
  const signedIn = (handler: (c: Context, user: AppUser) => Promise<Response>) => async (c: Context) => handler(c, await user(c));
  /** Counts the request against every key it names; 429 with Retry-After once one of them is full. */
  function limit(limits: ReadonlyArray<readonly [string, number]>) {
    const { allowed, retryAfter } = limiter.check(limits);
    if (!allowed) throw new WebappFailure('rate_limited', 'Too many requests; try again later', 429, retryAfter);
  }
  const platformAdmin = (handler: (c: Context, user: AppUser) => Promise<Response>) => signedIn(async (c, admin) => {
    await service.requirePlatformAdmin(admin);
    return handler(c, admin);
  });

  app.get('/plans', async c => c.json(await service.listPlans()));
  // The scan token travels in the body, so CORS keeps allowing only Content-Type and Authorization.
  app.post('/claims', async c => c.json(await service.issueClaim((await body(c, CreateClaimRequest)).scanToken), 201));
  // Closed sign-up (DN-13 §4.2): public, counted per address and per claim or invitation, which are kept here only as their hash.
  app.post('/auth/enroll', async c => {
    const req = await body(c, EnrollRequest);
    limit([[`enroll:address:${deps.clientIp?.(c.req.raw) ?? 'unknown'}`, ENROLL_PER_ADDRESS],
      [`enroll:link:${sha256('claimId' in req ? `claim:${req.claimId}` : `invitation:${req.invitationToken}`)}`, ENROLL_PER_LINK]]);
    return c.json(await service.enroll(req));
  });
  app.get('/me', signedIn(async (c, me) => c.json(await service.me(me))));
  // Closing one's own account (DN-13 §4.8): 204, 409 for a sole owner, 503 when the Auth user could not be deleted (send it again).
  app.delete('/me', async c => {
    const me = await user(c, { closed: true });
    limit([[`delete-account:${me.userId}`, ACCOUNT_DELETIONS_PER_USER]]);
    await service.deleteAccount(me);
    return c.body(null, 204);
  });
  app.post('/orgs', signedIn(async (c, me) => c.json(await service.createOrganization(me, await body(c, CreateOrgRequest)), 201)));
  app.get('/orgs/:id', signedIn(async (c, me) => c.json(await service.orgView(me, param(c, 'id')))));
  app.patch('/orgs/:id', signedIn(async (c, me) =>
    c.json(await service.renameOrganization(me, param(c, 'id'), (await body(c, UpdateOrgRequest)).name))));
  // These two read with the organization id as stored, which authorize returns whatever case the path used.
  app.get('/orgs/:id/analyses', signedIn(async (c, me) => {
    const { org } = await service.authorize(me, param(c, 'id'), 'org.read', { payment: true });
    return c.json(await service.listAnalyses(org.id));
  }));
  app.post('/orgs/:id/analyses', signedIn(async (c, me) =>
    c.json(await service.attachAnalysis(me, param(c, 'id'), (await body(c, AttachAnalysisRequest)).claimId), 201)));
  app.get('/orgs/:id/members', signedIn(async (c, me) => {
    const { org } = await service.authorize(me, param(c, 'id'), 'org.read', { payment: true });
    return c.json(await service.listMembers(org.id));
  }));
  app.post('/orgs/:id/invitations', signedIn(async (c, me) =>
    c.json(await service.invite(me, param(c, 'id'), await body(c, InviteRequest)), 201)));
  app.delete('/orgs/:id/invitations/:invitationId', signedIn(async (c, me) => {
    await service.revokeInvitation(me, param(c, 'id'), param(c, 'invitationId'));
    return c.body(null, 204);
  }));
  app.patch('/orgs/:id/members/:userId', signedIn(async (c, me) =>
    c.json(await service.setRole(me, param(c, 'id'), param(c, 'userId'), (await body(c, SetRoleRequest)).role))));
  app.delete('/orgs/:id/members/:userId', signedIn(async (c, me) => {
    await service.removeMember(me, param(c, 'id'), param(c, 'userId'));
    return c.body(null, 204);
  }));
  app.post('/invitations/:token/accept', signedIn(async (c, me) => c.json(await service.acceptInvitation(me, param(c, 'token')))));
  app.post('/orgs/:id/billing/checkout', signedIn(async (c, me) =>
    c.json(await service.checkout(me, param(c, 'id'), (await body(c, CheckoutRequest)).planCode))));
  app.post('/orgs/:id/billing/portal', signedIn(async (c, me) => c.json(await service.portal(me, param(c, 'id')))));
  app.post('/orgs/:id/deletion-request', signedIn(async (c, me) =>
    c.json(await service.requestDeletion(me, param(c, 'id'), (await body(c, DeletionRequestBody)).reason), 201)));
  // The action plan (DN-11 §4.2). Hono decodes the key, which the front sends through encodeURIComponent.
  app.get('/orgs/:id/actions', signedIn(async (c, me) => c.json(await service.listActions(me, param(c, 'id')))));
  app.post('/orgs/:id/actions', signedIn(async (c, me) =>
    c.json(await service.createAction(me, param(c, 'id'), await body(c, CreateActionRequest)), 201)));
  app.patch('/orgs/:id/actions/:key', signedIn(async (c, me) =>
    c.json(await service.updateAction(me, param(c, 'id'), param(c, 'key'), await body(c, UpdateActionRequest)))));
  app.delete('/orgs/:id/actions/:key', signedIn(async (c, me) => {
    await service.deleteAction(me, param(c, 'id'), param(c, 'key'));
    return c.body(null, 204);
  }));
  app.get('/orgs/:id/activity', signedIn(async (c, me) =>
    c.json(await service.activity(me, param(c, 'id'), query(c, auditPage(200, 50))))));

  // The platform admin is checked before the body, so anyone else gets the same 403 whatever they send.
  app.get('/admin/organizations', platformAdmin(async c => c.json(await service.listOrganizations())));
  app.get('/admin/organizations/:id', platformAdmin(async c => c.json(await service.adminOrganization(param(c, 'id')))));
  // An orgId that names no organization gives an empty page.
  app.get('/admin/audit', platformAdmin(async c => c.json(await service.adminAudit(query(c, auditPage(500, 100).extend({
    orgId: z.string().min(1).optional() }))))));
  app.get('/admin/metrics', platformAdmin(async c => c.json(await service.adminMetrics())));
  app.get('/admin/deletion-requests', platformAdmin(async c => c.json(await service.listDeletionRequests())));
  app.get('/admin/plans', platformAdmin(async c => c.json(await service.listAllPlans())));
  for (const decision of ['approve', 'reject'] as const) {
    // The note is optional, so the body may be left out altogether.
    app.post(`/admin/deletion-requests/:id/${decision}`, platformAdmin(async (c, admin) =>
      c.json(await service.reviewDeletion(admin, param(c, 'id'), decision, (await body(c, ReviewRequest, { optional: true })).note))));
  }
  app.put('/admin/plans/:code', platformAdmin(async (c, admin) =>
    c.json(await service.updatePlan(admin, param(c, 'code'), await body(c, UpdatePlanRequest)))));

  // Stripe comes after the demo (DN-10 §10): without a signature to verify, no event is accepted, in the debug modes either.
  app.post('/billing/webhook', c => notConfigured(c));
  return app;
}

/** What production serves while WEBAPP_ENABLED is not true (DN-13 §3.2). */
export function notConfiguredWebapp(): Hono {
  const app = new Hono();
  for (const path of WEBAPP_PATHS) app.all(path, noStore, c => notConfigured(c));
  return app;
}

async function noStore(c: Context, next: () => Promise<void>) {
  c.header('Cache-Control', 'no-store');
  await next();
}

const notConfigured = (c: Context) => c.json({ error: 'not_configured', message: 'The webapp is not configured in this environment' }, 501);

async function body<T extends z.ZodTypeAny>(c: Context, schema: T, options: { optional?: boolean } = {}): Promise<z.output<T>> {
  const raw = await c.req.text();
  let value: unknown = null;
  try { value = options.optional && raw.trim() === '' ? {} : JSON.parse(raw); } catch { /* not JSON: refused below */ }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new WebappFailure('invalid_request', 'The request body is not valid', 400);
  return parsed.data;
}

function query<T extends z.ZodTypeAny>(c: Context, schema: T): z.output<T> {
  const parsed = schema.safeParse(c.req.query());
  if (!parsed.success) throw new WebappFailure('invalid_request', 'The query is not valid', 400);
  return parsed.data;
}

// Hono only calls a handler on a path that carries the parameter; the untyped Context cannot tell.
const param = (c: Context, name: string) => c.req.param(name) as string;

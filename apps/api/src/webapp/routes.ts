import { Hono, type Context } from 'hono';
import type { z } from 'zod';
import { AttachAnalysisRequest, CheckoutRequest, CreateClaimRequest, CreateOrgRequest, DeletionRequestBody, InviteRequest, ReviewRequest,
  SetRoleRequest, UpdatePlanRequest } from '@arca/contracts';
import type { AppAuth, AppUser } from './auth.js';
import { WebappFailure, type WebappService } from './service.js';

// Every path the private webapp answers on (DN-10 §4.7). Outside mock they all answer 501 until the real adapters exist.
const WEBAPP_PATHS = ['/me', '/claims', '/plans', '/orgs', '/orgs/*', '/invitations/*', '/admin/*', '/billing/*'] as const;

/** Accounts, organizations and billing of the private webapp. The service owns every rule; these routes only authenticate and parse. */
export function webappRoutes(deps: { service: WebappService; auth: AppAuth }): Hono {
  const { service } = deps;
  const app = new Hono();
  for (const path of WEBAPP_PATHS) app.use(path, noStore);
  app.onError((error, c) => {
    if (error instanceof WebappFailure) return c.json({ error: error.code, message: error.message }, error.status);
    throw error;
  });

  // The app's own session token. A scan session token is refused here: its issuer and audience are not the app's.
  async function user(c: Context): Promise<AppUser> {
    const token = /^Bearer\s+(.+)$/i.exec(c.req.header('Authorization') ?? '')?.[1];
    const verified = token ? await deps.auth.verify(token) : null;
    if (!verified) throw new WebappFailure('unauthorized', 'Invalid or missing session token', 401);
    return verified;
  }
  const signedIn = (handler: (c: Context, user: AppUser) => Promise<Response>) => async (c: Context) => handler(c, await user(c));
  const platformAdmin = (handler: (c: Context, user: AppUser) => Promise<Response>) => signedIn(async (c, admin) => {
    await service.requirePlatformAdmin(admin);
    return handler(c, admin);
  });

  app.get('/plans', async c => c.json(await service.listPlans()));
  // The scan token travels in the body, so CORS keeps allowing only Content-Type and Authorization.
  app.post('/claims', async c => c.json(await service.issueClaim((await body(c, CreateClaimRequest)).scanToken), 201));
  app.get('/me', signedIn(async (c, me) => c.json(await service.me(me))));
  app.post('/orgs', signedIn(async (c, me) => c.json(await service.createOrganization(me, await body(c, CreateOrgRequest)), 201)));
  app.get('/orgs/:id', signedIn(async (c, me) => c.json(await service.orgView(me, param(c, 'id')))));
  app.get('/orgs/:id/analyses', signedIn(async (c, me) => {
    await service.authorize(me, param(c, 'id'), 'org.read', { payment: true });
    return c.json(await service.listAnalyses(param(c, 'id')));
  }));
  app.post('/orgs/:id/analyses', signedIn(async (c, me) =>
    c.json(await service.attachAnalysis(me, param(c, 'id'), (await body(c, AttachAnalysisRequest)).claimId), 201)));
  app.get('/orgs/:id/members', signedIn(async (c, me) => {
    await service.authorize(me, param(c, 'id'), 'org.read', { payment: true });
    return c.json(await service.listMembers(param(c, 'id')));
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

  // The platform admin is checked before the body, so anyone else gets the same 403 whatever they send.
  app.get('/admin/organizations', platformAdmin(async c => c.json(await service.listOrganizations())));
  app.get('/admin/deletion-requests', platformAdmin(async c => c.json(await service.listDeletionRequests())));
  app.get('/admin/plans', platformAdmin(async c => c.json(await service.listAllPlans())));
  for (const decision of ['approve', 'reject'] as const) {
    // The note is optional, so the body may be left out altogether.
    app.post(`/admin/deletion-requests/:id/${decision}`, platformAdmin(async (c, admin) =>
      c.json(await service.reviewDeletion(admin, param(c, 'id'), decision, (await body(c, ReviewRequest, { optional: true })).note))));
  }
  app.put('/admin/plans/:code', platformAdmin(async (c, admin) =>
    c.json(await service.updatePlan(admin, param(c, 'code'), await body(c, UpdatePlanRequest)))));

  // Stripe comes after the demo (DN-10 §10): without a signature to verify, no event is accepted, in mock either.
  app.post('/billing/webhook', c => notConfigured(c));
  return app;
}

/** What every mode but mock serves for now: the webapp exists, but its real adapters (Supabase Auth, Stripe) do not yet. */
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

// Hono only calls a handler on a path that carries the parameter; the untyped Context cannot tell.
const param = (c: Context, name: string) => c.req.param(name) as string;

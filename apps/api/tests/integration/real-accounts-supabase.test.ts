import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';
import { ActivityPage, ClaimResponse, EnrollResponse, InvitationView, MeResponse, OrgView } from '@arca/contracts';
import { issueSessionToken } from '../../src/auth/session-token.js';
import { compose } from '../../src/compose.js';
import { loadEnv } from '../../src/config/env.js';
import { MockBillingProvider } from '../../src/webapp/billing.js';
import { REAL_WEBAPP_ADAPTERS } from '../../src/webapp/real-adapters.js';
import { SupabaseWebappRepository } from '../../src/webapp/supabase.js';
import { fixtureResult } from '../fixtures/result.js';

/**
 * DN-13 T7 and T11 end to end against Supabase local: the real GoTrue admin API creates the user (POST /auth/enroll), the person
 * signs in with the 6-digit code that GoTrue mails to Mailpit (signInWithOtp + verifyOtp, as the front will), SupabaseJwtAuth
 * verifies the access token against the local JWKS, and DELETE /me closes the account and deletes the Auth user. Stripe is not
 * involved: the billing provider is the simulated one, handed in through the seam (the Stripe provider is T14).
 *
 * Skipped unless the three variables are set, so `npm test` never touches the network. From the repository root, in PowerShell,
 * with Supabase local running (`supabase start`):
 *
 *   $status = supabase status -o env | ConvertFrom-StringData
 *   $env:ARCA_AUTH_SUPABASE_URL = $status.API_URL.Trim('"')
 *   $env:ARCA_AUTH_SUPABASE_SECRET_KEY = $status.SECRET_KEY.Trim('"')            # or SERVICE_ROLE_KEY on older CLIs
 *   $env:ARCA_AUTH_SUPABASE_PUBLISHABLE_KEY = $status.PUBLISHABLE_KEY.Trim('"')  # or ANON_KEY
 *   $env:ARCA_AUTH_MAILPIT_URL = $status.MAILPIT_URL.Trim('"')                   # optional, http://127.0.0.1:54324 by default
 *   npx vitest run apps/api/tests/integration/real-accounts-supabase.test.ts
 *   Remove-Item Env:ARCA_AUTH_SUPABASE_URL, Env:ARCA_AUTH_SUPABASE_SECRET_KEY, Env:ARCA_AUTH_SUPABASE_PUBLISHABLE_KEY, Env:ARCA_AUTH_MAILPIT_URL
 *
 * Local hosts only: it creates and deletes Auth users and reads a mailbox, so it never runs against a hosted project. It needs the
 * migrations applied (`supabase db reset` applies them all) and asymmetric JWT signing keys, which the local stack of CLI 2.x
 * has by default (the JWKS at /auth/v1/.well-known/jwks.json lists an ES256 key). It leaves its rows behind, under fresh emails, and
 * deletes the Auth users it created.
 */
const url = process.env.ARCA_AUTH_SUPABASE_URL;
const secretKey = process.env.ARCA_AUTH_SUPABASE_SECRET_KEY;
const publishableKey = process.env.ARCA_AUTH_SUPABASE_PUBLISHABLE_KEY;
const mailpit = process.env.ARCA_AUTH_MAILPIT_URL ?? 'http://127.0.0.1:54324';
const configured = Boolean(url && secretKey && publishableKey);
const LOCAL = ['127.0.0.1', 'localhost', '::1', '[::1]'];
const sessionSecret = randomBytes(32).toString('hex');
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe.skipIf(!configured)('real accounts against Supabase local (DN-13 T7, T11)', () => {
  let app: Awaited<ReturnType<typeof compose>>['app'];
  let service: SupabaseClient;
  let repository: SupabaseWebappRepository;
  const run = randomBytes(6).toString('hex');
  const ownerEmail = `t7-owner-${run}@arca-local.test`;
  const memberEmail = `t7-member-${run}@arca-local.test`;
  const created: string[] = [];
  let owner: Session;
  let orgId: string;

  async function call(method: string, path: string, options: { token?: string; body?: unknown } = {}) {
    const response = await app.request(path, { method, body: options.body === undefined ? undefined : JSON.stringify(options.body),
      headers: { ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }) } });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) as unknown : null };
  }
  const browser = () => createClient(url!, publishableKey!, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });

  /**
   * The sign-in email Mailpit holds for this address, sent after `since`: its 6-digit code when the template carries one
   * (supabase/templates/magic_link.html, DN-13 §4.9), or else the token hash of its link (GoTrue's default template, until the
   * stack is restarted with that config).
   */
  async function mailed(email: string, since: number): Promise<{ code: string } | { tokenHash: string }> {
    for (let attempt = 0; attempt < 60; attempt++) {
      const found = await (await fetch(`${mailpit}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`)).json() as {
        messages: Array<{ ID: string; Created: string }> };
      const latest = found.messages.find(message => Date.parse(message.Created) >= since - 5000);
      if (latest) {
        const message = await (await fetch(`${mailpit}/api/v1/message/${latest.ID}`)).json() as { Text?: string; HTML?: string };
        const text = [message.Text ?? '', message.HTML ?? ''].join(' ');
        const code = /(?<![\w/=.-])(\d{6})(?![\w.-])/.exec(text)?.[1];
        if (code) return { code };
        const tokenHash = /[?&](?:amp;)?token(?:_hash)?=([0-9a-f]{20,})/.exec(text)?.[1];
        if (tokenHash) return { tokenHash };
      }
      await sleep(250);
    }
    throw new Error(`No sign-in email reached Mailpit for ${email}`);
  }
  /** What the front does (DN-13 §3.1): ask for a code with shouldCreateUser false, read the email, verify what it carries. */
  async function signIn(email: string): Promise<{ client: SupabaseClient; session: Session; by: 'code' | 'link' }> {
    const client = browser();
    const since = Date.now();
    const { error } = await client.auth.signInWithOtp({ email, options: { shouldCreateUser: false } });
    if (error) throw error;
    const got = await mailed(email, since);
    const { data, error: refused } = 'code' in got ? await client.auth.verifyOtp({ email, token: got.code, type: 'email' })
      : await client.auth.verifyOtp({ token_hash: got.tokenHash, type: 'email' });
    if (refused || !data.session) throw refused ?? new Error('No session');
    created.push(data.session.user.id);
    console.info(`[supabase-local] ${email.split('@')[0]} signed in with the emailed ${'code' in got ? '6-digit code' : 'link (no code in the template)'}`);
    return { client, session: data.session, by: 'code' in got ? 'code' : 'link' };
  }
  /** The 6-digit code GoTrue would mail, generated by the admin API (no email), verified exactly as the front verifies a code. */
  async function signInWithCode(email: string): Promise<Session> {
    const { data: link, error } = await service.auth.admin.generateLink({ type: 'magiclink', email });
    if (error) throw error;
    expect(link.properties.email_otp).toMatch(/^\d{6}$/);
    const { data, error: refused } = await browser().auth.verifyOtp({ email, token: link.properties.email_otp, type: 'email' });
    if (refused || !data.session) throw refused ?? new Error('No session');
    created.push(data.session.user.id);
    return data.session;
  }

  beforeAll(async () => {
    for (const address of [url!, mailpit]) {
      const host = new URL(address).hostname;
      if (!LOCAL.includes(host)) throw new Error(`Refusing to run against ${host}: Supabase local and its Mailpit only`);
    }
    service = createClient(url!, secretKey!, { auth: { persistSession: false, autoRefreshToken: false } });
    repository = new SupabaseWebappRepository(service);
    // The real webapp of live-debug (WEBAPP_PROVIDERS=real) on the shipped adapters, with the simulated billing in place of T14's.
    // No scan runs, so the model and directory keys are never used; the Stripe keys only pass the start guards.
    const composed = await compose(loadEnv({ ARCA_MODE: 'live-debug', WEBAPP_PROVIDERS: 'real', SESSION_TOKEN_SECRET: sessionSecret,
      CORS_ALLOWED_ORIGINS: 'http://localhost:3000', SOURCE_MODE: 'live', STORAGE_BACKEND: 'supabase', SUPABASE_URL: url, SUPABASE_SECRET_KEY: secretKey,
      OPENAI_API_KEY: 'sk-unused', APIFY_API_TOKEN: 'apify_unused', STRIPE_SECRET_KEY: 'rk_test_unused', STRIPE_WEBHOOK_SECRET: 'whsec_unused' }),
    undefined, { ...REAL_WEBAPP_ADAPTERS, billing: () => new MockBillingProvider('http://localhost:3000') });
    app = composed.app;
    const settings = await (await fetch(`${url}/auth/v1/settings`, { headers: { apikey: publishableKey! } })).json() as { disable_signup?: boolean };
    console.info(`[supabase-local] public sign-up ${settings.disable_signup ? 'off' : 'ON (config.toml asks for off: restart the stack)'}`);
  }, 60_000);

  afterAll(async () => {
    // The owner keeps their account (sole owner); the Auth users this run made go, its rows stay.
    for (const id of created) await service?.auth.admin.deleteUser(id);
  });

  it('enrolls the email of a claim, signs in from the email and with a 6-digit code, verifies the token, and refuses to close a sole owner', async () => {
    const scanId = `sc_t7${run}`;
    const { error } = await service.from('scans').insert({ scan_id: scanId, email: ownerEmail, canonical_domain: 'arca-local.test',
      domain_resolution: { status: 'RESOLVED', canonicalDomain: 'arca-local.test', source: 'request', reason: null }, status: 'COMPLETED',
      result: fixtureResult(scanId, ownerEmail), completed_at: new Date().toISOString(), duration_ms: 10, cached: false });
    expect(error).toBeNull();
    const claimed = await call('POST', '/claims', { body: { scanToken: await issueSessionToken(scanId, ownerEmail, sessionSecret) } });
    expect(claimed.status).toBe(201);
    const { claimId } = ClaimResponse.parse(claimed.body);

    // Before enrolling, the browser cannot get a code: the front never creates users (shouldCreateUser: false).
    expect((await browser().auth.signInWithOtp({ email: ownerEmail, options: { shouldCreateUser: false } })).error).not.toBeNull();
    const enrolled = await call('POST', '/auth/enroll', { body: { claimId } });
    expect(enrolled).toEqual({ status: 200, body: { email: ownerEmail } });
    EnrollResponse.parse(enrolled.body);
    // Again: the user exists, and the answer is the same.
    expect(await call('POST', '/auth/enroll', { body: { claimId } })).toEqual(enrolled);
    expect(await call('POST', '/auth/enroll', { body: { claimId: 'not-a-claim' } })).toEqual({ status: 410,
      body: { error: 'gone', message: expect.any(String) } });

    // The email Mailpit catches, then a 6-digit code: both reach the same session of the same user.
    const first = await signIn(ownerEmail);
    owner = await signInWithCode(ownerEmail);
    expect(owner.user.id).toBe(first.session.user.id);
    const header = JSON.parse(Buffer.from(owner.access_token.split('.')[0]!, 'base64url').toString()) as { alg: string; kid?: string };
    const jwks = await (await fetch(`${url}/auth/v1/.well-known/jwks.json`)).json() as { keys: Array<{ kid: string; alg?: string }> };
    expect(header.alg).toBe('ES256');
    expect(jwks.keys.map(key => key.kid)).toContain(header.kid);
    const { data: authUser } = await service.auth.admin.getUserById(owner.user.id);
    expect(authUser.user).toMatchObject({ email: ownerEmail, email_confirmed_at: expect.any(String) });

    const me = await call('GET', '/me', { token: owner.access_token });
    expect(me.status).toBe(200);
    expect(MeResponse.parse(me.body).user).toEqual({ id: owner.user.id, email: ownerEmail });
    // auth.users.id = sub = profiles.user_id (§4.5).
    expect(await repository.getProfile(owner.user.id)).toMatchObject({ email: ownerEmail, deleted_at: null });

    const org = await call('POST', '/orgs', { token: owner.access_token, body: { name: `T7 ${run}`, claimId } });
    expect(org.status).toBe(201);
    orgId = OrgView.parse(org.body).id;
    expect(await call('DELETE', '/me', { token: owner.access_token })).toEqual({ status: 409,
      body: { error: 'conflict', message: expect.stringMatching(/only owner/) } });
    expect((await call('GET', '/me', { token: owner.access_token })).status).toBe(200);
  }, 60_000);

  it('enrolls an invited email, lets it join, then closes the account: token refused, session revoked, Auth user deleted', async () => {
    expect(orgId).toBeDefined();
    await repository.setBillingStatus(orgId, 'active');
    const invited = await call('POST', `/orgs/${orgId}/invitations`, { token: owner.access_token, body: { email: memberEmail, role: 'member' } });
    expect(invited.status).toBe(201);
    const invitationToken = InvitationView.parse(invited.body).inviteUrl!.split('/').at(-1)!;
    expect(await call('POST', '/auth/enroll', { body: { invitationToken } })).toEqual({ status: 200, body: { email: memberEmail } });

    const { client, session } = await signIn(memberEmail);
    const accepted = await call('POST', `/invitations/${invitationToken}/accept`, { token: session.access_token });
    expect(accepted.status).toBe(200);
    expect(OrgView.parse(accepted.body)).toMatchObject({ id: orgId, role: 'member' });

    expect(await call('DELETE', '/me', { token: session.access_token })).toEqual({ status: 204, body: null });
    // The access token is still within its hour, but the account is closed.
    expect(await call('GET', '/me', { token: session.access_token })).toEqual({ status: 401,
      body: { error: 'unauthorized', message: expect.any(String) } });
    // Deleting the Auth user took its sessions and refresh tokens with it.
    const refreshed = await client.auth.refreshSession({ refresh_token: session.refresh_token });
    expect(refreshed.error).not.toBeNull();
    const { data: gone } = await service.auth.admin.getUserById(session.user.id);
    expect(gone.user).toBeNull();
    // And no code can be asked for that email any more.
    expect((await browser().auth.signInWithOtp({ email: memberEmail, options: { shouldCreateUser: false } })).error).not.toBeNull();
    // Retrying with the same token is harmless.
    expect((await call('DELETE', '/me', { token: session.access_token })).status).toBe(204);

    expect(await repository.getProfile(session.user.id)).toMatchObject({ email: null, deleted_at: expect.any(String) });
    const members = await call('GET', `/orgs/${orgId}/members`, { token: owner.access_token });
    expect((members.body as { members: Array<{ email: string }> }).members.map(m => m.email)).toEqual([ownerEmail]);
    const activity = ActivityPage.parse((await call('GET', `/orgs/${orgId}/activity`, { token: owner.access_token })).body);
    expect(activity.events[0]).toMatchObject({ action: 'account.deleted', actor: { kind: 'member', email: null } });
  }, 60_000);
});

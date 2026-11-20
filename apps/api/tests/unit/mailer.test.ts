import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InvitationView } from '@arca/contracts';
import { InMemoryAssessmentRepository } from '../../src/assessment/repository.js';
import { InMemoryRepository } from '../../src/repositories/in-memory.js';
import type { AppUser } from '../../src/webapp/auth.js';
import { MockBillingProvider } from '../../src/webapp/billing.js';
import { InMemoryWebappRepository } from '../../src/webapp/in-memory.js';
import { MailingWebappService, invitationEmail } from '../../src/webapp/invitation-email.js';
import { MemoryMailer, RESEND_EMAILS_URL, ResendMailer, SesMailer, type EmailMessage, type Mailer } from '../../src/webapp/mailer.js';
import { DEFAULT_PLANS } from '../../src/webapp/plans.js';
import { WebappFailure } from '../../src/webapp/service.js';

const FROM = 'ARCA <no-reply@arcacover.com>';
const APP = 'https://arcacover.com';
const T0 = Date.parse('2026-11-18T12:00:00.000Z');
const message: EmailMessage = { from: FROM, to: 'new@firm.com', subject: 'Hello', text: 'Plain', html: '<p>Plain</p>' };

afterEach(() => { vi.restoreAllMocks(); });

describe('MemoryMailer', () => {
  it('keeps every message it is handed, apart from the caller, until cleared', async () => {
    const mailer = new MemoryMailer();
    const sent = { ...message };
    await mailer.send(sent);
    sent.to = 'changed@firm.com';
    await mailer.send({ ...message, to: 'second@firm.com' });
    expect(mailer.sent.map(entry => entry.to)).toEqual(['new@firm.com', 'second@firm.com']);
    mailer.clear();
    expect(mailer.sent).toEqual([]);
  });
});

describe('SesMailer', () => {
  it('hands SES v2 one simple message to one recipient', async () => {
    const sendEmail = vi.fn(async () => ({ MessageId: 'ses-1' }));
    await new SesMailer(sendEmail).send(message);
    expect(sendEmail).toHaveBeenCalledWith({ FromEmailAddress: FROM, Destination: { ToAddresses: ['new@firm.com'] },
      Content: { Simple: { Subject: { Data: 'Hello', Charset: 'UTF-8' },
        Body: { Text: { Data: 'Plain', Charset: 'UTF-8' }, Html: { Data: '<p>Plain</p>', Charset: 'UTF-8' } } } } });
    // A configuration set routes bounces and complaints (DN-13 §9.5); a message without HTML sends text only.
    await new SesMailer(sendEmail, { configurationSetName: 'arca-transactional' }).send({ ...message, html: undefined });
    expect(sendEmail).toHaveBeenLastCalledWith({ FromEmailAddress: FROM, Destination: { ToAddresses: ['new@firm.com'] },
      ConfigurationSetName: 'arca-transactional',
      Content: { Simple: { Subject: { Data: 'Hello', Charset: 'UTF-8' }, Body: { Text: { Data: 'Plain', Charset: 'UTF-8' } } } } });
  });

  it('lets a failure of SES reach the caller', async () => {
    await expect(new SesMailer(async () => { throw new Error('Throttling'); }).send(message)).rejects.toThrow('Throttling');
  });
});

describe('ResendMailer', () => {
  const KEY = 're_fixture_123';
  const keyed: EmailMessage = { ...message, idempotencyKey: 'invitation-0d9c1f9e-8b7a-4c6d-9e5f-4a3b2c1d0e0f' };
  type Call = [string, RequestInit];
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const answering = (...responses: Array<Response | Error>) => {
    const queue = [...responses];
    return vi.fn(async (_url: string, _init: RequestInit) => {
      const next = queue.shift() ?? json(200, { id: 'extra' });
      if (next instanceof Error) throw next;
      return next;
    });
  };
  const calls = (fetch: ReturnType<typeof answering>) => fetch.mock.calls as unknown as Call[];

  it('posts one email to Resend, with the key, a User-Agent and the idempotency key of the message', async () => {
    const fetch = answering(json(200, { id: 'resend-1' }));
    await new ResendMailer(KEY, { fetch }).send(keyed);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = calls(fetch)[0]!;
    expect(url).toBe('https://api.resend.com/emails');
    expect(RESEND_EMAILS_URL).toBe(url);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', 'User-Agent': 'arca-api',
      'Idempotency-Key': keyed.idempotencyKey });
    expect(JSON.parse(init.body as string)).toEqual({ from: FROM, to: ['new@firm.com'], subject: 'Hello', text: 'Plain', html: '<p>Plain</p>' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('sends text only when the message has no HTML, and no idempotency header when it has no key', async () => {
    const fetch = answering(json(200, { id: 'resend-1' }));
    await new ResendMailer(KEY, { fetch }).send({ ...message, html: undefined });
    const [, init] = calls(fetch)[0]!;
    expect(init.headers).not.toHaveProperty('Idempotency-Key');
    expect(JSON.parse(init.body as string)).toEqual({ from: FROM, to: ['new@firm.com'], subject: 'Hello', text: 'Plain' });
  });

  it('names a refusal by Resend\'s error type, without the address, the key or Resend\'s message, and does not retry it', async () => {
    const fetch = answering(json(422, { statusCode: 422, name: 'validation_error', message: 'Invalid `to` field: new@firm.com' }));
    const failure = await new ResendMailer(KEY, { fetch }).send(keyed).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).name).toBe('validation_error');
    expect((failure as { status?: number }).status).toBe(422);
    for (const secret of ['new@firm.com', KEY]) expect(`${(failure as Error).message} ${(failure as Error).stack}`).not.toContain(secret);
    expect(fetch).toHaveBeenCalledTimes(1);
    // A rate limit or a spent quota is not retried either: the retry would hit the same wall.
    const limited = answering(json(429, { statusCode: 429, name: 'rate_limit_exceeded', message: 'Too many requests' }));
    await expect(new ResendMailer(KEY, { fetch: limited }).send(keyed)).rejects.toMatchObject({ name: 'rate_limit_exceeded', status: 429 });
    expect(limited).toHaveBeenCalledTimes(1);
  });

  it('names an answer that is not Resend\'s JSON by its status', async () => {
    // Cloudflare in front of Resend answers 403 "error code: 1010" to a request without a User-Agent.
    const fetch = answering(new Response('error code: 1010', { status: 403 }));
    await expect(new ResendMailer(KEY, { fetch }).send(keyed)).rejects.toMatchObject({ name: 'resend_http_403', status: 403 });
    const odd = answering(json(400, { name: 'Bcc: x@y.co\r\n' }));
    await expect(new ResendMailer(KEY, { fetch: odd }).send(keyed)).rejects.toMatchObject({ name: 'resend_http_400' });
  });

  it('retries a server error once with the same body and idempotency key, so Resend sends it at most once', async () => {
    const fetch = answering(json(500, { statusCode: 500, name: 'application_error', message: 'x' }), json(200, { id: 'resend-1' }));
    await new ResendMailer(KEY, { fetch }).send(keyed);
    expect(fetch).toHaveBeenCalledTimes(2);
    const [first, second] = calls(fetch);
    expect(second![1].body).toBe(first![1].body);
    expect((second![1].headers as Record<string, string>)['Idempotency-Key']).toBe(keyed.idempotencyKey);

    const down = answering(json(503, { name: 'service_unavailable' }), json(503, { name: 'service_unavailable' }));
    await expect(new ResendMailer(KEY, { fetch: down }).send(keyed)).rejects.toMatchObject({ name: 'service_unavailable', status: 503 });
    expect(down).toHaveBeenCalledTimes(2);
  });

  it('never retries a message without an idempotency key: the first try may have been sent', async () => {
    const fetch = answering(json(500, { name: 'application_error' }), json(200, { id: 'resend-1' }));
    await expect(new ResendMailer(KEY, { fetch }).send(message)).rejects.toMatchObject({ name: 'application_error' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('gives up on a Resend that does not answer in time, and on one it cannot reach', async () => {
    const hanging = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
    }));
    const started = Date.now();
    await expect(new ResendMailer(KEY, { fetch: hanging, timeoutMs: 20 }).send(keyed)).rejects.toMatchObject({ name: 'TimeoutError', status: null });
    expect(Date.now() - started).toBeLessThan(2_000);
    // The retry carries the same key: if the first try did reach Resend, the second sends nothing new.
    expect(hanging).toHaveBeenCalledTimes(2);

    const unreachable = answering(new TypeError('fetch failed'), new TypeError('fetch failed'));
    await expect(new ResendMailer(KEY, { fetch: unreachable }).send(keyed)).rejects.toMatchObject({ name: 'NetworkError', status: null });
    expect(unreachable).toHaveBeenCalledTimes(2);
    const recovered = answering(new TypeError('fetch failed'), json(200, { id: 'resend-1' }));
    await expect(new ResendMailer(KEY, { fetch: recovered }).send(keyed)).resolves.toBeUndefined();
  });

  it('defaults to a short timeout', () => {
    expect(new ResendMailer(KEY).timeoutMs).toBeLessThanOrEqual(10_000);
  });
});

describe('the invitation email (DN-13 §4.6)', () => {
  const invite = { to: 'new@firm.com', from: FROM, orgName: 'Robust Law LLP', inviterEmail: 'owner@firm.com', role: 'admin' as const,
    inviteUrl: `${APP}/app/invite/tok_abc`, expiresAt: '2026-11-25T12:00:00.000Z', invitationId: 'inv-1' };

  it('names the organization, who invites and the role, and carries the link and its expiry', () => {
    const email = invitationEmail(invite);
    expect(email).toMatchObject({ from: FROM, to: 'new@firm.com', subject: "You're invited to join Robust Law LLP on ARCA" });
    // One invitation, one email: a retried send of the same invitation carries the same key.
    expect(email.idempotencyKey).toBe('invitation-inv-1');
    expect(email.text).toContain('owner@firm.com invited you to join Robust Law LLP on ARCA as an admin.');
    expect(email.text).toContain(`${APP}/app/invite/tok_abc`);
    expect(email.text).toContain('November 25, 2026');
    expect(email.text).toContain("If you weren't expecting this invitation, you can ignore this email.");
    expect(email.html).toContain(`href="${APP}/app/invite/tok_abc"`);
    expect(invitationEmail({ ...invite, role: 'viewer' }).text).toContain('as a viewer.');
    expect(invitationEmail({ ...invite, role: 'member' }).text).toContain('as a member.');
  });

  it('keeps a name typed by a customer out of the headers and out of the markup', () => {
    const email = invitationEmail({ ...invite, orgName: 'Evil\r\nBcc: all@x.co <script>alert(1)</script> & Co' });
    expect(email.subject).not.toMatch(/[\r\n]/);
    expect(email.subject).toBe("You're invited to join Evil Bcc: all@x.co <script>alert(1)</script> & Co on ARCA");
    expect(email.html).not.toContain('<script>');
    expect(email.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; Co');
  });
});

describe('MailingWebappService', () => {
  const owner: AppUser = { userId: randomUUID(), email: 'owner@firm.com' };
  async function paidOrganization(mailer: Mailer) {
    const repository = new InMemoryWebappRepository(DEFAULT_PLANS);
    const service = new MailingWebappService({ repository, scans: new InMemoryRepository(), assessments: new InMemoryAssessmentRepository(),
      billing: new MockBillingProvider(APP), sessionSecret: 's'.repeat(40), appBaseUrl: `${APP}/`, now: () => T0 }, { mailer, from: FROM });
    const orgId = randomUUID(), at = new Date(T0).toISOString();
    await repository.createOrganization({ id: orgId, name: 'Robust Law LLP', domain: 'robust.example', billing_status: 'active',
      deleted_at: null, created_by: owner.userId, created_at: at }, { org_id: orgId, user_id: owner.userId, role: 'owner', invited_by: null,
      created_at: at }, null);
    return { repository, service, orgId };
  }

  it('sends the invitation once it is written, and answers exactly as before', async () => {
    const mailer = new MemoryMailer();
    const { repository, service, orgId } = await paidOrganization(mailer);
    const view = await service.invite(owner, orgId, { email: 'New@Firm.com', role: 'member' });
    // The wire format the front parses does not change: inviteUrl stays, nothing is added (contracts 0.5.0 is phase 4).
    expect(InvitationView.parse(view)).toEqual(view);
    expect(Object.keys(view).sort()).toEqual(['email', 'expiresAt', 'id', 'inviteUrl', 'role']);
    expect(view.inviteUrl).toMatch(/^https:\/\/arcacover\.com\/app\/invite\/[A-Za-z0-9_-]{43}$/);
    expect(mailer.sent).toEqual([invitationEmail({ to: 'new@firm.com', from: FROM, orgName: 'Robust Law LLP', inviterEmail: 'owner@firm.com',
      role: 'member', inviteUrl: view.inviteUrl!, expiresAt: view.expiresAt, invitationId: view.id })]);
    expect(mailer.sent[0]!.idempotencyKey).toBe(`invitation-${view.id}`);
    expect(await repository.listInvitations(orgId)).toHaveLength(1);
  });

  it('keeps the invitation when Resend refuses the email, and logs only the invitation id and Resend\'s error type', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ statusCode: 403, name: 'validation_error',
      message: 'The arcacover.com domain is not verified. new@firm.com' }), { status: 403 }));
    const { repository, service, orgId } = await paidOrganization(new ResendMailer('re_fixture_123', { fetch }));
    const view = await service.invite(owner, orgId, { email: 'new@firm.com', role: 'member' });
    expect(view.inviteUrl).toBeDefined();
    expect((await repository.listInvitations(orgId)).map(invitation => invitation.id)).toEqual([view.id]);
    const sent = JSON.parse((fetch.mock.calls[0]![1] as RequestInit).body as string) as { text: string };
    expect(sent.text).toContain(view.inviteUrl!);
    expect((fetch.mock.calls[0]![1] as RequestInit).headers).toMatchObject({ 'Idempotency-Key': `invitation-${view.id}` });
    expect(error).toHaveBeenCalledTimes(1);
    const logged = error.mock.calls.flat().map(String).join(' ');
    expect(logged).toBe(`[mail] invitation ${view.id} was created but its email was not sent (validation_error)`);
  });

  it('keeps the invitation when the email cannot be sent, and logs no address or link', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const mailer: Mailer = { send: vi.fn(async () => { throw new Error('MessageRejected: new@firm.com'); }) };
    const { repository, service, orgId } = await paidOrganization(mailer);
    const view = await service.invite(owner, orgId, { email: 'new@firm.com', role: 'viewer' });
    expect(view.inviteUrl).toBeDefined();
    expect(mailer.send).toHaveBeenCalledTimes(1);
    expect((await repository.listInvitations(orgId)).map(invitation => invitation.id)).toEqual([view.id]);
    expect(error).toHaveBeenCalledTimes(1);
    const logged = error.mock.calls.flat().map(String).join(' ');
    expect(logged).toContain('[mail] invitation');
    expect(logged).toContain(view.id);
    for (const secret of ['new@firm.com', 'owner@firm.com', view.inviteUrl!]) expect(logged).not.toContain(secret);
  });

  it('sends nothing when the invitation is refused', async () => {
    const mailer = new MemoryMailer();
    const { service, orgId } = await paidOrganization(mailer);
    const outsider: AppUser = { userId: randomUUID(), email: 'outsider@else.com' };
    await expect(service.invite(outsider, orgId, { email: 'new@firm.com', role: 'member' })).rejects.toBeInstanceOf(WebappFailure);
    expect(mailer.sent).toEqual([]);
  });
});

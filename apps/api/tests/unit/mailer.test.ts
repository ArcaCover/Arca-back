import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InvitationView } from '@arca/contracts';
import { InMemoryAssessmentRepository } from '../../src/assessment/repository.js';
import { InMemoryRepository } from '../../src/repositories/in-memory.js';
import type { AppUser } from '../../src/webapp/auth.js';
import { MockBillingProvider } from '../../src/webapp/billing.js';
import { InMemoryWebappRepository } from '../../src/webapp/in-memory.js';
import { MailingWebappService, invitationEmail } from '../../src/webapp/invitation-email.js';
import { MemoryMailer, SesMailer, type EmailMessage, type Mailer } from '../../src/webapp/mailer.js';
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

describe('the invitation email (DN-13 §4.6)', () => {
  const invite = { to: 'new@firm.com', from: FROM, orgName: 'Robust Law LLP', inviterEmail: 'owner@firm.com', role: 'admin' as const,
    inviteUrl: `${APP}/app/invite/tok_abc`, expiresAt: '2026-11-25T12:00:00.000Z' };

  it('names the organization, who invites and the role, and carries the link and its expiry', () => {
    const email = invitationEmail(invite);
    expect(email).toMatchObject({ from: FROM, to: 'new@firm.com', subject: "You're invited to join Robust Law LLP on ARCA" });
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
      role: 'member', inviteUrl: view.inviteUrl!, expiresAt: view.expiresAt })]);
    expect(await repository.listInvitations(orgId)).toHaveLength(1);
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

import type { InvitationView, InviteRequest } from '@arca/contracts';
import type { AppUser } from './auth.js';
import type { EmailMessage, Mailer } from './mailer.js';
import { WebappService, type WebappServiceDeps } from './service.js';

type InvitableRole = InvitationView['role'];
const ROLE_PHRASE: Record<InvitableRole, string> = { admin: 'an admin', member: 'a member', viewer: 'a viewer' };

// An organization name is typed by a customer: it never reaches a header with a line break in it, nor the markup unescaped.
const oneLine = (value: string) => value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
const escapeHtml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');
const longDate = (iso: string) => new Date(iso).toLocaleDateString('en-US', { timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric' });

/**
 * The invitation of DN-13 §4.6, in English like the whole interface. It carries only what the invitee needs: the organization,
 * who invites (their email: there is no name to show), the role, the link and when it expires.
 */
export function invitationEmail(input: { to: string; from: string; orgName: string; inviterEmail: string; role: InvitableRole;
  inviteUrl: string; expiresAt: string; invitationId: string }): EmailMessage {
  const org = oneLine(input.orgName), inviter = oneLine(input.inviterEmail), role = ROLE_PHRASE[input.role];
  const expires = longDate(input.expiresAt);
  const text = [
    `${inviter} invited you to join ${org} on ARCA as ${role}.`,
    '',
    'Accept the invitation:',
    input.inviteUrl,
    '',
    `The link expires on ${expires}. You will sign in with a code we send to this address.`,
    '',
    "If you weren't expecting this invitation, you can ignore this email.",
  ].join('\n');
  const html = [
    `<p>${escapeHtml(inviter)} invited you to join <strong>${escapeHtml(org)}</strong> on ARCA as ${role}.</p>`,
    `<p><a href="${escapeHtml(input.inviteUrl)}">Accept the invitation</a></p>`,
    `<p>The link expires on ${expires}. You will sign in with a code we send to this address.</p>`,
    "<p>If you weren't expecting this invitation, you can ignore this email.</p>",
  ].join('\n');
  // One invitation, one email: a reinvitation is a new invitation with its own id, and so its own email.
  return { from: input.from, to: input.to, subject: `You're invited to join ${org} on ARCA`, text, html,
    idempotencyKey: `invitation-${input.invitationId}` };
}

/**
 * The webapp service that also emails each invitation it creates, once the write is confirmed (DN-13 §4.6). The response does not
 * change: `inviteUrl` stays, so the owner can copy the link if the email is lost, and a failed send never undoes the invitation.
 * It is logged by invitation id, with no address or link. The `emailSent` field of §4.6 waits for contracts 0.5.0 (§7.6).
 */
export class MailingWebappService extends WebappService {
  constructor(deps: WebappServiceDeps, private readonly mail: { mailer: Mailer; from: string }) {
    super(deps);
  }

  override async invite(actor: AppUser, orgId: string, req: InviteRequest): Promise<InvitationView> {
    const invitation = await super.invite(actor, orgId, req);
    try {
      const org = await this.orgView(actor, orgId);
      await this.mail.mailer.send(invitationEmail({ to: invitation.email, from: this.mail.from, orgName: org.name,
        inviterEmail: actor.email, role: invitation.role, inviteUrl: invitation.inviteUrl!, expiresAt: invitation.expiresAt,
        invitationId: invitation.id }));
    } catch (error) {
      const reason = error instanceof Error ? error.name : 'unknown error';
      console.error(`[mail] invitation ${invitation.id} was created but its email was not sent (${reason})`);
    }
    return invitation;
  }
}

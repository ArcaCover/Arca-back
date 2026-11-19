/** One transactional email: one sender, one recipient (DN-13 §4.6). */
export type EmailMessage = { from: string; to: string; subject: string; text: string; html?: string };

/** Where the back sends its own emails. Today only invitations; the sign-in codes are Supabase's (DN-13 §4.9). */
export interface Mailer {
  send(message: EmailMessage): Promise<void>;
}

/**
 * Keeps every message in the process: the mailer of the simulated webapp and of live-debug with EMAIL_PROVIDER=memory. The tests
 * and the debug panel read `sent`; a debug reset clears it. Nothing leaves the process.
 */
export class MemoryMailer implements Mailer {
  readonly sent: EmailMessage[] = [];
  async send(message: EmailMessage) { this.sent.push(structuredClone(message)); }
  clear() { this.sent.length = 0; }
}

/** The input of SES v2 SendEmail (`SendEmailCommandInput` of `@aws-sdk/client-sesv2`) that this mailer uses. */
export type SesSendEmailInput = {
  FromEmailAddress: string;
  Destination: { ToAddresses: string[] };
  ConfigurationSetName?: string;
  Content: { Simple: { Subject: { Data: string; Charset: 'UTF-8' };
    Body: { Text: { Data: string; Charset: 'UTF-8' }; Html?: { Data: string; Charset: 'UTF-8' } } } };
};
export type SesSendEmail = (input: SesSendEmailInput) => Promise<{ MessageId?: string }>;

/**
 * Amazon SES (F11), behind an injected sender, so the API carries no AWS SDK until the real one is wired. With
 * `@aws-sdk/client-sesv2` added to apps/api, the sender is:
 *
 *   const client = new SESv2Client({ region: process.env.AWS_REGION });
 *   const sesSendEmail: SesSendEmail = input => client.send(new SendEmailCommand(input));
 *
 * and it goes to `REAL_WEBAPP_ADAPTERS.sesSendEmail`. On the host the instance role grants `ses:SendEmail` on the
 * arcacover.com identity, so there is no credential to store (DN-13 §9.1, §10.4).
 */
export class SesMailer implements Mailer {
  constructor(private readonly sendEmail: SesSendEmail, private readonly options: { configurationSetName?: string } = {}) {}

  async send(message: EmailMessage) {
    const body: SesSendEmailInput['Content']['Simple']['Body'] = { Text: { Data: message.text, Charset: 'UTF-8' } };
    if (message.html !== undefined) body.Html = { Data: message.html, Charset: 'UTF-8' };
    await this.sendEmail({ FromEmailAddress: message.from, Destination: { ToAddresses: [message.to] },
      ...(this.options.configurationSetName ? { ConfigurationSetName: this.options.configurationSetName } : {}),
      Content: { Simple: { Subject: { Data: message.subject, Charset: 'UTF-8' }, Body: body } } });
  }
}

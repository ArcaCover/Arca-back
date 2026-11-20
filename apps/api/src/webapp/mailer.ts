/**
 * One transactional email: one sender, one recipient (DN-13 §4.6). `idempotencyKey` names the email, not the attempt: a provider
 * that supports it (Resend) sends a retried message once.
 */
export type EmailMessage = { from: string; to: string; subject: string; text: string; html?: string; idempotencyKey?: string };

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

export const RESEND_EMAILS_URL = 'https://api.resend.com/emails';
const RESEND_TIMEOUT_MS = 5_000;
// Resend's error types are snake_case words (validation_error, rate_limit_exceeded); anything else is not trusted as a name.
const RESEND_ERROR_TYPE = /^[a-z][a-z_]{0,63}$/;

/**
 * A send Resend did not accept. Its `name` is what the log prints, like the error codes of SES: Resend's error type
 * (`validation_error`, `rate_limit_exceeded`), `resend_http_<status>` for an answer that is not Resend's JSON, or `TimeoutError` and
 * `NetworkError` when no answer came (`status` null). The message never carries Resend's own message, which can quote the address.
 */
export class ResendError extends Error {
  constructor(readonly status: number | null, name: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = name;
  }
}

/**
 * Resend (F11), over its HTTP API with plain fetch: `POST /emails` with the API key as a Bearer token. Supabase Auth already sends
 * its sign-in codes through Resend's SMTP from the same verified domain, arcacover.com (DN-13 §4.9, §9.1).
 *
 * A message with an `idempotencyKey` goes out with it as `Idempotency-Key` (Resend keeps it 24 hours), and only such a message is
 * retried, once, with the same body, after a timeout, a network failure or a 5xx: if the first try did reach Resend, the second
 * returns the same email instead of sending another. A 4xx, a rate limit or a spent quota is not retried.
 */
export class ResendMailer implements Mailer {
  readonly timeoutMs: number;
  private readonly fetch: typeof fetch;
  private readonly attempts: number;

  constructor(private readonly apiKey: string, options: { fetch?: typeof fetch; timeoutMs?: number; attempts?: number } = {}) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? RESEND_TIMEOUT_MS;
    this.attempts = options.attempts ?? 2;
  }

  async send(message: EmailMessage) {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json',
      // Resend refuses a request without one (403); the SDKs send their own.
      'User-Agent': 'arca-api' };
    if (message.idempotencyKey) headers['Idempotency-Key'] = message.idempotencyKey;
    const body = JSON.stringify({ from: message.from, to: [message.to], subject: message.subject, text: message.text,
      ...(message.html !== undefined ? { html: message.html } : {}) });
    const attempts = message.idempotencyKey ? this.attempts : 1;
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.post(headers, body);
      } catch (error) {
        const transient = error instanceof ResendError && (error.status === null || error.status >= 500);
        if (!transient || attempt >= attempts) throw error;
      }
    }
  }

  private async post(headers: Record<string, string>, body: string): Promise<void> {
    let response: Response;
    try {
      response = await this.fetch(RESEND_EMAILS_URL, { method: 'POST', headers, body, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      throw timedOut ? new ResendError(null, 'TimeoutError', `Resend did not answer within ${this.timeoutMs} ms`, { cause: error })
        : new ResendError(null, 'NetworkError', 'Resend could not be reached', { cause: error });
    }
    if (response.ok) {
      await response.text().catch(() => undefined);
      return;
    }
    const type = await response.json().then((answer: unknown) => (answer as { name?: unknown } | null)?.name, () => undefined);
    const name = typeof type === 'string' && RESEND_ERROR_TYPE.test(type) ? type : `resend_http_${response.status}`;
    throw new ResendError(response.status, name, `Resend refused the email: ${response.status} ${name}`);
  }
}

import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * The users of Supabase Auth, as only the back may change them (DN-13 §4.2, §4.8): public sign-up is off, so POST /auth/enroll is
 * the one place a user is created, and DELETE /me the one place one is deleted. Neither sends an email nor sets a password: the
 * person signs in with the code Supabase mails when the front asks for one.
 */
export interface AuthAdmin {
  /** A confirmed user for this email; `exists` when there is one already, which is the same success to the caller. */
  createUser(email: string): Promise<'created' | 'exists'>;
  /** Deletes the user for good, and its sessions and refresh tokens with it; `missing` when it was gone already. */
  deleteUser(userId: string): Promise<'deleted' | 'missing'>;
}

/** The Auth admin API failed or did not answer: the routes say 503 `auth_unavailable`, and nothing was created. */
export class AuthAdminUnavailable extends Error {
  constructor(operation: string, options?: { cause?: unknown }) {
    super(`The Auth admin API could not ${operation}`, options);
    this.name = 'AuthAdminUnavailable';
  }
}

type AuthFailure = { status?: number; code?: string; message?: string; name?: string };
// What GoTrue answers for an email that has a user: `email_exists` since v2.1xx, only the message before.
const EXISTS = /already (been )?registered/i;

/**
 * The admin API of Supabase Auth (`auth.admin` of supabase-js), on the service-role client the repositories use. Every failure
 * other than "already there" or "already gone" is AuthAdminUnavailable, logged with its status and code, never with the email.
 */
export class SupabaseAuthAdmin implements AuthAdmin {
  constructor(private readonly client: SupabaseClient) {}

  async createUser(email: string): Promise<'created' | 'exists'> {
    // email_confirm: the only way into the account is still the code that reaches this mailbox (DN-13 §4.2).
    const { error } = await this.call('create the user', () => this.client.auth.admin.createUser({ email, email_confirm: true }));
    if (!error) return 'created';
    if (error.code === 'email_exists' || (error.status === 422 && EXISTS.test(error.message ?? ''))) return 'exists';
    throw this.unavailable('create the user', error);
  }

  async deleteUser(userId: string): Promise<'deleted' | 'missing'> {
    // A hard delete: GoTrue removes the user's sessions, refresh tokens and identities with it.
    const { error } = await this.call('delete the user', () => this.client.auth.admin.deleteUser(userId, false));
    if (!error) return 'deleted';
    if (error.code === 'user_not_found' || error.status === 404) return 'missing';
    throw this.unavailable('delete the user', error);
  }

  /** supabase-js returns most failures as `error`, and throws the rest. */
  private async call(operation: string, run: () => Promise<{ error: AuthFailure | null }>): Promise<{ error: AuthFailure | null }> {
    try { return await run(); } catch (error) { throw this.unavailable(operation, error); }
  }

  private unavailable(operation: string, error: unknown): AuthAdminUnavailable {
    const { status, code, name } = (error ?? {}) as AuthFailure;
    console.error(`[auth] the Auth admin API could not ${operation} (${[name, status, code].filter(Boolean).join(' ') || 'unknown error'})`);
    return new AuthAdminUnavailable(operation, { cause: error });
  }
}

/**
 * The simulated Auth admin of the debug modes and the tests: one user per email, in any case. `idFor` names the user; the debug
 * modes pass the simulated login's own derivation, so DELETE /me deletes the user that login signs in.
 */
export class InMemoryAuthAdmin implements AuthAdmin {
  private readonly users = new Map<string, string>();
  constructor(private readonly idFor: (email: string) => string = () => randomUUID()) {}

  async createUser(email: string): Promise<'created' | 'exists'> {
    const key = email.trim().toLowerCase();
    if (this.users.has(key)) return 'exists';
    this.users.set(key, this.idFor(key));
    return 'created';
  }

  async deleteUser(userId: string): Promise<'deleted' | 'missing'> {
    for (const [email, id] of this.users) {
      if (id === userId) {
        this.users.delete(email);
        return 'deleted';
      }
    }
    return 'missing';
  }

  has(email: string): boolean { return this.users.has(email.trim().toLowerCase()); }
  /** Forgets every user, for the debug reset. */
  clear(): void { this.users.clear(); }
}

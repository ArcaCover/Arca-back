import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { mockUserIdFor } from '../../src/webapp/auth.js';
import { AuthAdminUnavailable, InMemoryAuthAdmin, SupabaseAuthAdmin } from '../../src/webapp/auth-admin.js';

const URL_BASE = 'https://x.supabase.co';
const USER_ID = '7b5e2f0e-3c1a-4d8e-9f00-1a2b3c4d5e6f';
type Call = { method: string; url: string; body: unknown };

/** The admin API of a Supabase project of the test's own: each call is recorded and answered by `reply`. */
function project(reply: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const call = { method: init?.method ?? 'GET', url: String(input), body: init?.body ? JSON.parse(String(init.body)) : null };
    calls.push(call);
    return reply(call);
  });
  const client = createClient(URL_BASE, 'sb_secret_fixture', { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch } });
  return { admin: new SupabaseAuthAdmin(client), calls };
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const user = (email: string) => ({ id: USER_ID, aud: 'authenticated', role: 'authenticated', email, email_confirmed_at: new Date().toISOString(),
  app_metadata: { provider: 'email' }, user_metadata: {}, identities: [], created_at: new Date().toISOString() });

afterEach(() => { vi.restoreAllMocks(); });

describe('SupabaseAuthAdmin (DN-13 §4.2, §4.8)', () => {
  it('creates a confirmed user for the email through the admin API, with no password and no email sent', async () => {
    const { admin, calls } = project(() => json(200, user('owner@firm.com')));
    expect(await admin.createUser('owner@firm.com')).toBe('created');
    expect(calls).toEqual([{ method: 'POST', url: `${URL_BASE}/auth/v1/admin/users`, body: { email: 'owner@firm.com', email_confirm: true } }]);
  });

  it('takes an email that already has a user as done, in the words of current and older Auth versions', async () => {
    const current = project(() => json(422, { code: 422, error_code: 'email_exists',
      msg: 'A user with this email address has already been registered' }));
    expect(await current.admin.createUser('owner@firm.com')).toBe('exists');
    const older = project(() => json(422, { code: 422, msg: 'A user with this email address has already been registered' }));
    expect(await older.admin.createUser('owner@firm.com')).toBe('exists');
  });

  it('turns any other failure into AuthAdminUnavailable, and logs no email', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const replies: Array<() => Response | Promise<Response>> = [
      () => json(500, { code: 500, error_code: 'unexpected_failure', msg: 'Database error creating new user' }),
      () => new Response('Bad gateway', { status: 502 }),
      () => json(401, { message: 'Invalid API key' }),
      () => { throw new TypeError('fetch failed'); },
    ];
    for (const reply of replies) {
      const { admin } = project(reply);
      await expect(admin.createUser('owner@firm.com')).rejects.toBeInstanceOf(AuthAdminUnavailable);
    }
    expect(error.mock.calls.flat().join(' ')).not.toContain('owner@firm.com');
  });

  it('deletes the user for good (no soft delete), and takes a user already gone as done', async () => {
    const { admin, calls } = project(() => json(200, user('owner@firm.com')));
    expect(await admin.deleteUser(USER_ID)).toBe('deleted');
    expect(calls).toEqual([{ method: 'DELETE', url: `${URL_BASE}/auth/v1/admin/users/${USER_ID}`, body: { should_soft_delete: false } }]);
    const gone = project(() => json(404, { code: 404, error_code: 'user_not_found', msg: 'User not found' }));
    expect(await gone.admin.deleteUser(USER_ID)).toBe('missing');
  });

  it('turns a failed deletion into AuthAdminUnavailable', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const reply of [() => json(500, { code: 500, msg: 'Database error deleting user' }), () => { throw new TypeError('fetch failed'); }]) {
      const { admin } = project(reply);
      await expect(admin.deleteUser(USER_ID)).rejects.toBeInstanceOf(AuthAdminUnavailable);
    }
  });
});

describe('InMemoryAuthAdmin', () => {
  it('keeps one user per email in any case, under the id the simulated login gives that email', async () => {
    const admin = new InMemoryAuthAdmin(mockUserIdFor);
    expect(await admin.createUser('Owner@Firm.com')).toBe('created');
    expect(await admin.createUser('owner@firm.com')).toBe('exists');
    expect(admin.has('owner@firm.com')).toBe(true);
    expect(await admin.deleteUser(mockUserIdFor('owner@firm.com'))).toBe('deleted');
    expect(admin.has('owner@firm.com')).toBe(false);
    expect(await admin.deleteUser(mockUserIdFor('owner@firm.com'))).toBe('missing');
    expect(await admin.createUser('owner@firm.com')).toBe('created');
  });
});

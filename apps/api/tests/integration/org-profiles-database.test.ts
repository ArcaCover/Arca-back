import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';

// DN-13 §19: the pre-checkout's migration (20261121000000_org_profiles.sql) on PGlite: the firm profile, its function, its grants,
// and the embedded Checkout sessions, over every migration before it.
const directory = new URL('../../../../supabase/migrations/', import.meta.url);
const migrations = async () => (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
const T0 = '2026-11-21T12:00:00.000Z';
const FN = 'create_organization_with_profile(jsonb,jsonb,jsonb,jsonb)';

async function roles(db: PGlite) {
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;`);
}

describe('PostgreSQL firm profiles and embedded Checkout (DN-13 §19)', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = new PGlite();
    await roles(db);
    for (const name of await migrations()) await db.exec(await readFile(new URL(name, directory), 'utf8'));
  });
  afterAll(async () => { await db?.close(); });

  const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
  async function asRole<T>(role: 'anon' | 'authenticated' | 'service_role', action: () => Promise<T>) {
    await db.exec(`set role ${role}`);
    try { return await action(); } finally { await db.exec('reset role'); }
  }
  /** As PostgREST calls it: named arguments under the back's role, jsonb as JSON. */
  async function create(input: { org: Record<string, unknown>; owner: Record<string, unknown>; analysis?: unknown; profile: unknown }) {
    const values = [input.org, input.owner, input.analysis ?? null, input.profile].map(value => value === null ? null : JSON.stringify(value));
    await asRole('service_role', () => db.query(`select public.create_organization_with_profile(p_org => $1, p_owner => $2, p_analysis => $3,
      p_profile => $4)`, values));
  }
  function records(overrides: Record<string, unknown> = {}) {
    const [id, owner] = [randomUUID(), randomUUID()];
    return { id, owner, org: { id, name: 'Smith & Co LLP', domain: 'smith.law', billing_status: 'pending_payment', deleted_at: null, created_by: owner,
      created_at: T0 }, ownerRow: { org_id: id, user_id: owner, role: 'owner', invited_by: null, created_at: T0 },
    profile: { org_id: id, contact_name: 'Ana Smith', contact_role: 'partner', contact_phone: '+1 305 555 0100', legal_name: 'Smith & Co LLP',
      ein: '12-3456789', address_line1: '100 Main St', address_city: 'Miami', address_state: 'FL', address_postal_code: '33101',
      address_country: 'US', attorney_range: '2-5', practice_states: ['FL', 'NY'], created_by: owner, created_at: T0, updated_at: T0, ...overrides } };
  }
  const orgExists = async (id: string) => (await rows('select 1 from public.organizations where id=$1', [id])).length === 1;

  it('creates the organization, its owner and its profile in one step', async () => {
    const r = records();
    await create({ org: r.org, owner: r.ownerRow, profile: r.profile });
    expect(await rows('select contact_name, contact_role, contact_phone, ein, address_state, address_country, attorney_range, practice_states from public.org_profiles where org_id=$1', [r.id]))
      .toEqual([{ contact_name: 'Ana Smith', contact_role: 'partner', contact_phone: '+1 305 555 0100', ein: '12-3456789', address_state: 'FL',
        address_country: 'US', attorney_range: '2-5', practice_states: ['FL', 'NY'] }]);
    expect(await rows('select role from public.memberships where org_id=$1', [r.id])).toEqual([{ role: 'owner' }]);
    // A null profile is the old function's work alone.
    const plain = records();
    await create({ org: plain.org, owner: plain.ownerRow, profile: null });
    expect(await orgExists(plain.id)).toBe(true);
    expect(await rows('select 1 from public.org_profiles where org_id=$1', [plain.id])).toEqual([]);
  });

  it('writes nothing when the profile breaks a rule, or names another organization', async () => {
    const broken: Array<[string, Record<string, unknown>]> = [
      ['an EIN without its dash', { ein: '123456789' }], ['an unknown role', { contact_role: 'associate' }],
      ['an unknown range', { attorney_range: '100+' }], ['no practice state', { practice_states: [] }], ['a lowercase state', { address_state: 'fl' }],
      ['a ZIP of letters', { address_postal_code: 'ABCDE' }], ['another country', { address_country: 'CA' }], ['a phone with letters', { contact_phone: 'call me' }],
      ['an empty name', { contact_name: '' }],
    ];
    for (const [why, patch] of broken) {
      const r = records(patch);
      await expect(create({ org: r.org, owner: r.ownerRow, profile: r.profile }), why).rejects.toThrow('check constraint');
      expect(await orgExists(r.id), why).toBe(false);
    }
    const r = records();
    await expect(create({ org: r.org, owner: r.ownerRow, profile: { ...r.profile, org_id: randomUUID() } })).rejects.toThrow('webapp_invalid:organization');
    expect(await orgExists(r.id)).toBe(false);
  });

  it('keeps a hosted session with its url and lets an embedded one have none', async () => {
    const r = records();
    await create({ org: r.org, owner: r.ownerRow, profile: r.profile });
    const insert = (id: string, uiMode: string | null, url: string | null, status = 'expired') => db.query(`insert into public.checkout_sessions
      (id,org_id,plan_code,url,status,created_by,expires_at${uiMode ? ',ui_mode' : ''}) values ($1,$2,'monthly',$3,$4,$5,$6${uiMode ? ',$7' : ''})`,
      [id, r.id, url, status, r.owner, T0, ...(uiMode ? [uiMode] : [])]);
    await insert('cs_test_hosted1', null, 'https://checkout.stripe.com/c/pay/x');
    expect(await rows("select ui_mode from public.checkout_sessions where id='cs_test_hosted1'")).toEqual([{ ui_mode: 'hosted' }]);
    await expect(insert('cs_test_hosted2', 'hosted', null)).rejects.toThrow('checkout_sessions_url_of_hosted');
    await expect(insert('cs_test_other1', 'custom', null)).rejects.toThrow('check constraint');
    await insert('cs_test_embedded1', 'embedded', null, 'open');
    await expect(insert('cs_test_embedded2', 'embedded', null, 'open')).rejects.toThrow('checkout_sessions_open_idx');
  });

  it('opens the profiles to no client role and runs the function only for the service role (§5.5)', async () => {
    expect(await rows("select relrowsecurity from pg_class where relname='org_profiles' and relnamespace='public'::regnamespace"))
      .toEqual([{ relrowsecurity: true }]);
    expect(await rows("select policyname from pg_policies where schemaname='public'")).toEqual([]);
    for (const role of ['anon', 'authenticated'] as const) {
      await asRole(role, async () => {
        await expect(db.query('select * from public.org_profiles'), role).rejects.toThrow('permission denied');
        await expect(db.query('delete from public.org_profiles'), role).rejects.toThrow('permission denied');
      });
      expect((await rows<{ ok: boolean }>("select has_function_privilege($1, $2, 'execute') as ok", [role, `public.${FN}`]))[0]!.ok, role).toBe(false);
    }
    expect((await rows<{ ok: boolean }>("select has_function_privilege('service_role', $1, 'execute') as ok", [`public.${FN}`]))[0]!.ok).toBe(true);
    expect(await rows<Record<string, boolean>>(`select has_table_privilege('service_role', 'public.org_profiles', 'select') as "select",
      has_table_privilege('service_role', 'public.org_profiles', 'insert') as "insert", has_table_privilege('service_role', 'public.org_profiles', 'update') as "update",
      has_table_privilege('service_role', 'public.org_profiles', 'delete') as "delete"`)).toEqual([{ select: true, insert: true, update: true, delete: true }]);
    expect(await rows("select prosecdef, proconfig from pg_proc where pronamespace='public'::regnamespace and proname='create_organization_with_profile'"))
      .toEqual([{ prosecdef: true, proconfig: ['search_path=pg_catalog, public'] }]);
  });
});

describe('the org profiles migration over the earlier schema', () => {
  it('applies on top of rows already written: the stored checkout sessions read as hosted', async () => {
    const db = new PGlite();
    try {
      await roles(db);
      const names = await migrations();
      const index = names.findIndex((name) => name.endsWith('_org_profiles.sql'));
      expect(index).toBeGreaterThan(0);
      for (const name of names.slice(0, index)) await db.exec(await readFile(new URL(name, directory), 'utf8'));
      const [org, owner] = [randomUUID(), randomUUID()];
      await db.query("insert into public.organizations (id,name,created_by) values ($1,'Firm LLP',$2)", [org, owner]);
      await db.query(`insert into public.checkout_sessions (id,org_id,plan_code,url,status,created_by,expires_at)
        values ('cs_test_old1',$1,'monthly','https://checkout.stripe.com/c/pay/old','open',$2,$3)`, [org, owner, T0]);
      // It, and every migration after it, applies over those rows.
      for (const name of names.slice(index)) await db.exec(await readFile(new URL(name, directory), 'utf8'));
      expect((await db.query('select id, ui_mode, url, status from public.checkout_sessions')).rows)
        .toEqual([{ id: 'cs_test_old1', ui_mode: 'hosted', url: 'https://checkout.stripe.com/c/pay/old', status: 'open' }]);
      expect((await db.query('select count(*)::int as n from public.org_profiles')).rows).toEqual([{ n: 0 }]);
    } finally {
      await db.close();
    }
  });
});

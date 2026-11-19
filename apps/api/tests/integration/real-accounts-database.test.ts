import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { ROLES, can, canManageMember, type Role } from '@arca/contracts';
import { MAX_CUSTOM_ACTIONS } from '../../src/webapp/types.js';

// DN-13 §5.3–§5.5: the third webapp migration, its RPC functions and its grants, on PGlite.
const directory = new URL('../../../../supabase/migrations/', import.meta.url);
const migrations = async () => (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
const NEW_TABLES = ['billing_customers', 'checkout_sessions'] as const;
const RPCS = ['create_organization(jsonb,jsonb,jsonb)', 'claim_analysis(jsonb)', 'redeem_claim_ticket(text,timestamptz)',
  'accept_invitation(uuid,uuid,jsonb,timestamptz)', 'set_member_role(uuid,uuid,text,uuid,text,jsonb,timestamptz)',
  'remove_member(uuid,uuid,uuid,text,jsonb,timestamptz)', 'revoke_invitation(uuid,uuid,text,jsonb,timestamptz)',
  'upsert_assessment_action(jsonb,jsonb)', 'create_custom_action(jsonb)', 'update_action(uuid,uuid,jsonb)',
  'apply_billing_state(jsonb,uuid,jsonb,timestamptz)', 'review_deletion_request(uuid,text,uuid,text,jsonb,timestamptz)',
  'delete_account(uuid,timestamptz)', 'grant_platform_admin(uuid,uuid,jsonb,timestamptz)', 'revoke_platform_admin(uuid,jsonb,timestamptz)',
  'list_audit(uuid,boolean,bigint,integer)'] as const;
const HELPERS = ['can_manage_member(text,text,text)', 'can_hold_actions(text)', 'append_audit(jsonb,uuid,text,text,jsonb,timestamptz)'] as const;

const T0 = '2026-11-18T12:00:00.000Z';
const at = (minutes: number) => new Date(Date.parse(T0) + minutes * 60_000).toISOString();
const member = (userId: string) => ({ actor_kind: 'member', actor_user_id: userId });
const SYSTEM = { actor_kind: 'system', actor_user_id: null };

describe('PostgreSQL real accounts and billing (DN-13)', () => {
  let db: PGlite;
  let sequence = 0;
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;`);
    for (const name of await migrations()) await db.exec(await readFile(new URL(name, directory), 'utf8'));
  });
  afterAll(async () => { await db?.close(); });

  async function asRole<T>(role: 'anon' | 'authenticated' | 'service_role', action: () => Promise<T>) {
    await db.exec(`set role ${role}`);
    try { return await action(); } finally { await db.exec('reset role'); }
  }
  /** Calls a function with named arguments, as PostgREST does, under the backend's role. jsonb arguments travel as JSON. */
  async function rpc<T = unknown>(fn: string, args: Record<string, unknown>): Promise<T> {
    const names = Object.keys(args);
    const values = Object.values(args).map((value) => value !== null && typeof value === 'object' ? JSON.stringify(value) : value);
    return asRole('service_role', async () => (await db.query<{ r: T }>(
      `select public.${fn}(${names.map((name, index) => `${name} => $${index + 1}`).join(', ')}) as r`, values)).rows[0]!.r);
  }
  const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
  const hash = () => randomBytes(32).toString('hex');
  async function scan() {
    const scanId = `sc_accounts${++sequence}`;
    await db.query(`insert into public.scans (scan_id,email,canonical_domain,domain_resolution,status,result)
      values ($1,'owner@firm.example','firm.example',$2,'COMPLETED','{}')`, [scanId, JSON.stringify({ status: 'RESOLVED', canonicalDomain: 'firm.example' })]);
    return scanId;
  }
  async function profile(userId: string, email = `${userId}@firm.example`) {
    await db.query("insert into public.profiles (user_id,email,created_at) values ($1,$2,$3)", [userId, email, T0]);
    return email;
  }
  async function organization(options: { deleted?: boolean } = {}) {
    const id = randomUUID();
    const owner = randomUUID();
    await profile(owner);
    await db.query("insert into public.organizations (id,name,created_by,deleted_at) values ($1,'Firm LLP',$2,$3)",
      [id, owner, options.deleted ? T0 : null]);
    await db.query("insert into public.memberships (org_id,user_id,role) values ($1,$2,'owner')", [id, owner]);
    return { id, owner };
  }
  async function join(orgId: string, role: Role) {
    const userId = randomUUID();
    await profile(userId);
    await db.query('insert into public.memberships (org_id,user_id,role) values ($1,$2,$3)', [orgId, userId, role]);
    return userId;
  }
  const roleOf = async (orgId: string, userId: string) =>
    (await rows<{ role: string }>('select role from public.memberships where org_id=$1 and user_id=$2', [orgId, userId]))[0]?.role ?? null;
  async function invite(orgId: string, email: string, role = 'member') {
    const id = randomUUID();
    await db.query(`insert into public.invitations (id,org_id,email,role,token_hash,invited_by,expires_at,created_at)
      values ($1,$2,$3,$4,$5,$6,$7,$8)`, [id, orgId, email, role, hash(), randomUUID(), at(7 * 24 * 60), T0]);
    return id;
  }
  const audits = (orgId: string | null) => rows<{ action: string; actor_kind: string; actor_user_id: string | null; target: string | null;
    data: Record<string, unknown> }>(
    `select action,actor_kind,actor_user_id,target,data from public.audit_log where org_id ${orgId === null ? 'is null' : '= $1'} order by seq`,
    orgId === null ? [] : [orgId]);
  async function customAction(orgId: string, assignee: string | null = null, createdAt = T0) {
    const id = randomUUID();
    await db.query(`insert into public.org_actions (id,org_id,source,title,assignee_user_id,created_by,updated_by,created_at,updated_at)
      values ($1,$2,'custom','Write an AI policy',$3,$4,$4,$5,$5)`, [id, orgId, assignee, randomUUID(), createdAt]);
    return id;
  }
  const holders = async (orgId: string) => (await rows<{ assignee_user_id: string | null }>(
    'select assignee_user_id from public.org_actions where org_id=$1 order by created_at, id', [orgId])).map((row) => row.assignee_user_id);

  describe('schema', () => {
    it('adds the billing tables and the columns of §5.3', async () => {
      const columns = async (table: string) => (await rows<{ column_name: string }>(
        "select column_name from information_schema.columns where table_schema='public' and table_name=$1", [table])).map((r) => r.column_name);
      expect(await columns('billing_customers')).toEqual(expect.arrayContaining(['org_id', 'customer_id', 'livemode', 'created_at']));
      expect(await columns('checkout_sessions')).toEqual(expect.arrayContaining(
        ['id', 'org_id', 'plan_code', 'url', 'status', 'created_by', 'expires_at', 'created_at']));
      expect(await columns('plans')).toEqual(expect.arrayContaining(['stripe_product_id', 'stripe_price_id']));
      expect(await columns('subscriptions')).toEqual(expect.arrayContaining(
        ['provider_status', 'price_id', 'cancel_at_period_end', 'current_period_start', 'livemode']));
      expect(await columns('stripe_events')).toEqual(expect.arrayContaining(['livemode', 'org_id', 'attempts', 'last_error']));
      expect(await columns('profiles')).toContain('deleted_at');
      const indexes = (await rows<{ indexname: string }>("select indexname from pg_indexes where schemaname='public'")).map((r) => r.indexname);
      expect(indexes).toEqual(expect.arrayContaining(['checkout_sessions_open_idx', 'subscriptions_subscription_idx', 'stripe_events_received_idx',
        'profiles_email_idx', 'invitations_email_idx', 'claim_tickets_expiry_idx']));
    });

    it('keeps the provider ids in shape and one open checkout per organization', async () => {
      const { id, owner } = await organization();
      const customer = (customerId: string, orgId = id) =>
        db.query('insert into public.billing_customers (org_id,customer_id,livemode) values ($1,$2,false)', [orgId, customerId]);
      await expect(customer('cus with space')).rejects.toThrow('check constraint');
      await customer('cus_Test123');
      await expect(customer('cus_Other')).rejects.toThrow('billing_customers_pkey');
      await expect(customer('cus_Test123', (await organization()).id)).rejects.toThrow('billing_customers_customer_id_key');
      const checkout = (sessionId: string, status = 'open') => db.query(`insert into public.checkout_sessions
        (id,org_id,plan_code,url,status,created_by,expires_at) values ($1,$2,'monthly','https://checkout.stripe.com/c/pay/x',$3,$4,$5)`,
        [sessionId, id, status, owner, at(60)]);
      await expect(checkout('sess_1')).rejects.toThrow('check constraint');
      await expect(checkout('cs_test_a1', 'paid')).rejects.toThrow('check constraint');
      await checkout('cs_test_a1');
      await expect(checkout('cs_test_a2')).rejects.toThrow('checkout_sessions_open_idx');
      await checkout('cs_live_a3', 'expired');
      await db.query("update public.checkout_sessions set status='complete' where id='cs_test_a1'");
      await checkout('cs_test_a4');
      await expect(checkout('cs_test_a5', 'open')).rejects.toThrow('checkout_sessions_open_idx');
    });

    it('keeps a deleted profile as a tombstone without email, and one live profile per email', async () => {
      const userId = randomUUID();
      await profile(userId, 'Same@Firm.example');
      await expect(profile(randomUUID(), 'same@firm.example')).rejects.toThrow('profiles_email_idx');
      await expect(db.query('update public.profiles set email=null where user_id=$1', [userId])).rejects.toThrow('profiles_email_unless_deleted');
      await expect(db.query('update public.profiles set deleted_at=now() where user_id=$1', [userId])).rejects.toThrow('profiles_email_unless_deleted');
      await db.query('update public.profiles set deleted_at=now(), email=null where user_id=$1', [userId]);
      // The email is free again once its profile is a tombstone.
      await profile(randomUUID(), 'same@firm.example');
    });

    it('gives a subscription id and a catalog price to one row only', async () => {
      const first = await organization();
      const second = await organization();
      const subscribe = (orgId: string) =>
        db.query("insert into public.subscriptions (org_id,plan_code,status,subscription_id) values ($1,'monthly','active','sub_1x')", [orgId]);
      await subscribe(first.id);
      await expect(subscribe(second.id)).rejects.toThrow('subscriptions_subscription_idx');
      await db.query("insert into public.subscriptions (org_id,plan_code,status) values ($1,'monthly','pending_payment')", [second.id]);
      await db.query("update public.plans set stripe_price_id='price_1' where code='monthly'");
      await expect(db.query("update public.plans set stripe_price_id='price_1' where code='annual'")).rejects.toThrow('plans_stripe_price_id_key');
      await db.query("update public.plans set stripe_price_id=null where code='monthly'");
    });

    it('opens nothing to anon or authenticated, and runs every function only for the service role (§5.5)', async () => {
      const rls = await rows<{ relname: string; relrowsecurity: boolean }>(`select relname, relrowsecurity from pg_class
        where relkind='r' and relnamespace='public'::regnamespace and relname in ('billing_customers','checkout_sessions') order by relname`);
      expect(rls).toEqual([{ relname: 'billing_customers', relrowsecurity: true }, { relname: 'checkout_sessions', relrowsecurity: true }]);
      expect(await rows("select policyname from pg_policies where schemaname='public'")).toEqual([]);
      for (const role of ['anon', 'authenticated'] as const) {
        await asRole(role, async () => {
          for (const table of NEW_TABLES) {
            await expect(db.query(`select * from public.${table}`), `${role} ${table}`).rejects.toThrow('permission denied');
            await expect(db.query(`delete from public.${table}`), `${role} ${table}`).rejects.toThrow('permission denied');
          }
        });
        for (const fn of [...RPCS, ...HELPERS]) {
          expect((await rows<{ ok: boolean }>('select has_function_privilege($1, $2, \'execute\') as ok', [role, `public.${fn}`]))[0]!.ok,
            `${role} ${fn}`).toBe(false);
        }
        await asRole(role, async () => {
          await expect(db.query("select public.redeem_claim_ticket('x', now())"), role).rejects.toThrow('permission denied');
          await expect(db.query('select public.list_audit(null, false, null, 10)'), role).rejects.toThrow('permission denied');
        });
      }
      for (const fn of RPCS) {
        expect((await rows<{ ok: boolean }>("select has_function_privilege('service_role', $1, 'execute') as ok", [`public.${fn}`]))[0]!.ok, fn)
          .toBe(true);
      }
      for (const fn of HELPERS) {
        expect((await rows<{ ok: boolean }>("select has_function_privilege('service_role', $1, 'execute') as ok", [`public.${fn}`]))[0]!.ok, fn)
          .toBe(false);
      }
      for (const table of NEW_TABLES) {
        const privileges = (await rows<Record<string, boolean>>(`select has_table_privilege('service_role', $1, 'select') as "select",
          has_table_privilege('service_role', $1, 'insert') as "insert", has_table_privilege('service_role', $1, 'update') as "update",
          has_table_privilege('service_role', $1, 'delete') as "delete"`, [`public.${table}`]))[0];
        expect(privileges, table).toEqual({ select: true, insert: true, update: true, delete: true });
      }
      // Every function of the webapp runs as its owner with a fixed search_path, like create_assessment.
      const definers = await rows<{ proname: string; prosecdef: boolean; proconfig: string[] | null }>(`select proname, prosecdef, proconfig
        from pg_proc where pronamespace='public'::regnamespace and proname = any($1)`, [RPCS.map((fn) => fn.split('(')[0])]);
      expect(definers).toHaveLength(RPCS.length);
      for (const fn of definers) {
        expect(fn.prosecdef, fn.proname).toBe(true);
        expect(fn.proconfig, fn.proname).toEqual(['search_path=pg_catalog, public']);
      }
    });

    it('says in SQL what canManageMember and can(…, actions.update) say in TypeScript, for every role', async () => {
      for (const actor of ROLES) for (const target of ROLES) for (const next of [...ROLES, undefined]) {
        const sql = (await rows<{ ok: boolean }>('select public.can_manage_member($1,$2,$3) as ok', [actor, target, next ?? null]))[0]!.ok;
        expect(sql, `${actor} ${target} ${next}`).toBe(canManageMember(actor, target, next));
      }
      for (const role of ROLES) {
        expect((await rows<{ ok: boolean }>('select public.can_hold_actions($1) as ok', [role]))[0]!.ok, role).toBe(can(role, 'actions.update'));
      }
    });
  });

  describe('organizations, claims and tickets', () => {
    const orgRecord = (id: string, owner: string) => ({ id, name: 'Smith & Co', domain: 'firm.example', billing_status: 'pending_payment',
      deleted_at: null, created_by: owner, created_at: T0 });
    const ownerRecord = (orgId: string, userId: string, role = 'owner') => ({ org_id: orgId, user_id: userId, role, invited_by: null, created_at: T0 });
    const analysisRecord = (orgId: string, scanId: string) => ({ org_id: orgId, scan_id: scanId, assessment_id: null, claimed_by: randomUUID(),
      claimed_at: T0 });

    it('creates the organization, its owner and its analysis together, or nothing (scan_claimed)', async () => {
      const [id, owner, scanId] = [randomUUID(), randomUUID(), await scan()];
      await rpc('create_organization', { p_org: orgRecord(id, owner), p_owner: ownerRecord(id, owner), p_analysis: analysisRecord(id, scanId) });
      expect(await rows('select name, billing_status from public.organizations where id=$1', [id])).toEqual([{ name: 'Smith & Co',
        billing_status: 'pending_payment' }]);
      expect(await roleOf(id, owner)).toBe('owner');
      const second = randomUUID();
      await expect(rpc('create_organization', { p_org: orgRecord(second, owner), p_owner: ownerRecord(second, owner),
        p_analysis: analysisRecord(second, scanId) })).rejects.toThrow('webapp_conflict:scan_claimed');
      expect(await rows('select 1 from public.organizations where id=$1', [second])).toEqual([]);
      expect(await rows('select 1 from public.memberships where org_id=$1', [second])).toEqual([]);
      // Without an analysis, and the same id twice.
      await rpc('create_organization', { p_org: orgRecord(second, owner), p_owner: ownerRecord(second, owner), p_analysis: null });
      await expect(rpc('create_organization', { p_org: orgRecord(second, owner), p_owner: ownerRecord(second, owner), p_analysis: null }))
        .rejects.toThrow('webapp_duplicate:organization');
    });

    it('refuses an organization whose first member is not its owner', async () => {
      const [id, owner] = [randomUUID(), randomUUID()];
      for (const [p_owner, p_analysis] of [[ownerRecord(id, owner, 'admin'), null], [ownerRecord(randomUUID(), owner), null],
        [ownerRecord(id, owner), analysisRecord(randomUUID(), 'sc_x')]] as const) {
        await expect(rpc('create_organization', { p_org: orgRecord(id, owner), p_owner, p_analysis })).rejects.toThrow('webapp_invalid:organization');
      }
      expect(await rows('select 1 from public.organizations where id=$1', [id])).toEqual([]);
    });

    it('claims a scan once, across organizations', async () => {
      const first = await organization();
      const second = await organization();
      const scanId = await scan();
      await rpc('claim_analysis', { p_analysis: analysisRecord(first.id, scanId) });
      await expect(rpc('claim_analysis', { p_analysis: analysisRecord(second.id, scanId) })).rejects.toThrow('webapp_conflict:scan_claimed');
      await expect(rpc('claim_analysis', { p_analysis: analysisRecord(first.id, scanId) })).rejects.toThrow('webapp_conflict:scan_claimed');
      expect(await rows('select org_id from public.org_analyses where scan_id=$1', [scanId])).toEqual([{ org_id: first.id }]);
    });

    it('spends a claim ticket once', async () => {
      const idHash = hash();
      await db.query("insert into public.claim_tickets (id_hash,scan_id,email,expires_at) values ($1,$2,'owner@firm.example',$3)",
        [idHash, await scan(), at(60)]);
      expect(await rpc('redeem_claim_ticket', { p_id_hash: idHash, p_at: T0 })).toBe(true);
      expect(await rpc('redeem_claim_ticket', { p_id_hash: idHash, p_at: at(1) })).toBe(false);
      expect(await rpc('redeem_claim_ticket', { p_id_hash: hash(), p_at: T0 })).toBe(false);
      expect(await rows('select used_at from public.claim_tickets where id_hash=$1', [idHash])).toEqual([{ used_at: new Date(T0) }]);
    });
  });

  describe('invitations', () => {
    it('accepts an invitation in one step: membership, acceptance, the other links of that email revoked, audited', async () => {
      const { id } = await organization();
      const guest = randomUUID();
      const invitation = await invite(id, 'Guest@Firm.example', 'admin');
      // An older link of the same email, which only a race could leave pending beside the new one, and someone else's.
      await db.query('drop index public.invitations_pending_email_idx');
      try {
        const older = await invite(id, 'guest@firm.example');
        const other = await invite(id, 'other@firm.example');
        expect(await rpc('accept_invitation', { p_invitation_id: invitation, p_user_id: guest, p_actor: member(guest), p_at: at(5) }))
          .toEqual({ joined: true, role: 'admin' });
        expect(await roleOf(id, guest)).toBe('admin');
        expect(await rows('select id, accepted_at, revoked_at from public.invitations where org_id=$1 order by id', [id])).toEqual(
          [{ id: invitation, accepted_at: new Date(at(5)), revoked_at: null }, { id: older, accepted_at: null, revoked_at: new Date(at(5)) },
            { id: other, accepted_at: null, revoked_at: null }].sort((a, b) => a.id.localeCompare(b.id)));
        expect((await audits(id)).map(({ action, data, actor_user_id }) => [action, data, actor_user_id])).toEqual([
          ['invitation.revoked', { invitationId: older, reason: 'accepted' }, guest],
          ['member.joined', { role: 'admin', invitationId: invitation }, guest]]);
      } finally {
        await db.query(`update public.invitations set revoked_at = now() where org_id = $1 and accepted_at is null and revoked_at is null
          and email <> 'other@firm.example'`, [id]);
        await db.query(`create unique index invitations_pending_email_idx on public.invitations(org_id, lower(email))
          where accepted_at is null and revoked_at is null`);
      }
    });

    it('closes an invitation of someone who already belongs without touching their role', async () => {
      const { id } = await organization();
      const guest = await join(id, 'viewer');
      const invitation = await invite(id, `${guest}@firm.example`, 'admin');
      expect(await rpc('accept_invitation', { p_invitation_id: invitation, p_user_id: guest, p_actor: member(guest), p_at: T0 }))
        .toEqual({ joined: false, role: 'viewer' });
      expect(await roleOf(id, guest)).toBe('viewer');
      expect(await audits(id)).toEqual([]);
    });

    it('accepts an invitation once, so the second of two racing accepts is refused (invitation_closed)', async () => {
      const { id } = await organization();
      const guest = randomUUID();
      const invitation = await invite(id, 'racer@firm.example');
      await rpc('accept_invitation', { p_invitation_id: invitation, p_user_id: guest, p_actor: member(guest), p_at: T0 });
      await expect(rpc('accept_invitation', { p_invitation_id: invitation, p_user_id: guest, p_actor: member(guest), p_at: at(1) }))
        .rejects.toThrow('webapp_conflict:invitation_closed');
      const revoked = await invite(id, 'late@firm.example');
      await rpc('revoke_invitation', { p_org_id: id, p_invitation_id: revoked, p_reason: null, p_audit: member(randomUUID()), p_at: T0 });
      await expect(rpc('accept_invitation', { p_invitation_id: revoked, p_user_id: randomUUID(), p_actor: member(guest), p_at: at(1) }))
        .rejects.toThrow('webapp_conflict:invitation_closed');
      await expect(rpc('accept_invitation', { p_invitation_id: randomUUID(), p_user_id: guest, p_actor: member(guest), p_at: T0 }))
        .rejects.toThrow('webapp_missing:invitation');
      expect((await audits(id)).filter((row) => row.action === 'member.joined')).toHaveLength(1);
    });

    it('revokes an invitation once: the second of two revokes changes and audits nothing', async () => {
      const { id, owner } = await organization();
      const other = await organization();
      const invitation = await invite(id, 'twice@firm.example');
      const revoke = (orgId: string, minutes: number, reason: string | null = null) => rpc<boolean>('revoke_invitation', { p_org_id: orgId,
        p_invitation_id: invitation, p_reason: reason, p_audit: member(owner), p_at: at(minutes) });
      expect(await revoke(other.id, 0)).toBe(false);
      expect(await revoke(id, 1)).toBe(true);
      expect(await revoke(id, 2)).toBe(false);
      expect(await rows('select revoked_at from public.invitations where id=$1', [invitation])).toEqual([{ revoked_at: new Date(at(1)) }]);
      expect((await audits(id)).map(({ action, target, data }) => [action, target, data])).toEqual([
        ['invitation.revoked', 'twice@firm.example', { invitationId: invitation }]]);
      // A revocation with a reason says so.
      const second = await invite(id, 'again@firm.example');
      expect(await rpc('revoke_invitation', { p_org_id: id, p_invitation_id: second, p_reason: 'reinvited', p_audit: member(owner), p_at: T0 }))
        .toBe(true);
      expect((await audits(id)).at(-1)!.data).toEqual({ invitationId: second, reason: 'reinvited' });
    });
  });

  describe('members', () => {
    const setRole = (orgId: string, userId: string, role: Role, actor: string, actorRole: Role, minutes = 0) => rpc<string | null>('set_member_role', {
      p_org_id: orgId, p_user_id: userId, p_role: role, p_actor_user_id: actor, p_actor_role: actorRole, p_audit: member(actor), p_at: at(minutes) });
    const remove = (orgId: string, userId: string, actor: string, actorRole: Role) => rpc<string | null>('remove_member', {
      p_org_id: orgId, p_user_id: userId, p_actor_user_id: actor, p_actor_role: actorRole, p_audit: member(actor), p_at: T0 });

    it('changes a role, releases the actions of a viewer in the same step and audits the role it found', async () => {
      const { id, owner } = await organization();
      const target = await join(id, 'member');
      await customAction(id, target);
      await customAction(id, owner, at(1));
      expect(await setRole(id, target, 'admin', owner, 'owner')).toBe('member');
      expect(await holders(id)).toEqual([target, owner]);
      expect(await setRole(id, target, 'viewer', owner, 'owner', 1)).toBe('admin');
      expect(await holders(id)).toEqual([null, owner]);
      // The same role again changes and audits nothing.
      expect(await setRole(id, target, 'viewer', owner, 'owner', 2)).toBe('viewer');
      expect((await audits(id)).map(({ action, target: t, data }) => [action, t, data])).toEqual([
        ['member.role_changed', target, { from: 'member', to: 'admin' }], ['member.role_changed', target, { from: 'admin', to: 'viewer' }]]);
    });

    it('re-checks the actor\'s right against the role read under the lock, so an admin cannot demote someone just made owner', async () => {
      const { id, owner } = await organization();
      const admin = await join(id, 'admin');
      const target = await join(id, 'member');
      // The admin's request read the target as a member; the owner's promotion commits first.
      expect(await setRole(id, target, 'owner', owner, 'owner')).toBe('member');
      await expect(setRole(id, target, 'viewer', admin, 'admin')).rejects.toThrow('webapp_refused:member_change');
      await expect(remove(id, target, admin, 'admin')).rejects.toThrow('webapp_refused:member_change');
      expect(await roleOf(id, target)).toBe('owner');
      // An actor demoted meanwhile no longer acts with the role the service checked.
      expect(await setRole(id, admin, 'member', owner, 'owner')).toBe('admin');
      await expect(setRole(id, owner, 'viewer', admin, 'admin')).rejects.toThrow('webapp_refused:member_change');
      await expect(setRole(id, randomUUID(), 'viewer', admin, 'admin')).rejects.toThrow('webapp_refused:member_change');
      // An admin never hands out ownership, even to a target that is still a member.
      await expect(setRole(id, admin, 'owner', admin, 'member')).rejects.toThrow('webapp_refused:member_change');
      expect((await audits(id)).map(({ data }) => data)).toEqual([{ from: 'member', to: 'owner' }, { from: 'admin', to: 'member' }]);
    });

    it('keeps the last owner, whatever the actor', async () => {
      const { id, owner } = await organization();
      await expect(setRole(id, owner, 'admin', owner, 'owner')).rejects.toThrow('webapp_conflict:last_owner');
      await expect(remove(id, owner, owner, 'owner')).rejects.toThrow('webapp_conflict:last_owner');
      const second = await join(id, 'owner');
      expect(await setRole(id, owner, 'admin', second, 'owner')).toBe('owner');
      await expect(remove(id, second, second, 'owner')).rejects.toThrow('webapp_conflict:last_owner');
      expect(await roleOf(id, second)).toBe('owner');
    });

    it('removes a member, releases their actions and revokes their pending links, in one step', async () => {
      const { id, owner } = await organization();
      const other = await organization();
      const target = await join(id, 'member');
      await db.query("insert into public.memberships (org_id,user_id,role) values ($1,$2,'member')", [other.id, target]);
      await customAction(id, target);
      await customAction(other.id, target);
      const link = await invite(id, `${target}@firm.example`);
      const elsewhere = await invite(other.id, `${target}@firm.example`);
      expect(await remove(id, target, owner, 'owner')).toBe('member');
      expect(await roleOf(id, target)).toBeNull();
      expect(await holders(id)).toEqual([null]);
      expect(await holders(other.id)).toEqual([target]);
      expect(await rows('select id from public.invitations where revoked_at is not null and id = any($1)', [[link, elsewhere]])).toEqual([{ id: link }]);
      expect((await audits(id)).map(({ action, target: t, data }) => [action, t, data])).toEqual([
        ['member.removed', target, { role: 'member' }], ['invitation.revoked', `${target}@firm.example`, { invitationId: link, reason: 'member_removed' }]]);
    });

    it('a role change that loses the race to a removal finds nobody and writes nothing, and so does a second removal', async () => {
      const { id, owner } = await organization();
      const admin = await join(id, 'admin');
      const target = await join(id, 'member');
      expect(await remove(id, target, admin, 'admin')).toBe('member');
      expect(await setRole(id, target, 'viewer', owner, 'owner')).toBeNull();
      expect(await remove(id, target, owner, 'owner')).toBeNull();
      expect(await roleOf(id, target)).toBeNull();
      expect((await audits(id)).map(({ action }) => action)).toEqual(['member.removed']);
    });
  });

  describe('the action plan', () => {
    const action = (orgId: string, scanId: string, patch: Record<string, unknown> = {}) => ({ id: randomUUID(), org_id: orgId,
      source: 'assessment', scan_id: scanId, action_key: 'improve:D1.1', title: null, detail: null, domain: null, status: 'todo',
      assignee_user_id: null, due_date: null, created_by: randomUUID(), created_at: T0, updated_by: randomUUID(), updated_at: T0, ...patch });
    const custom = (orgId: string, patch: Record<string, unknown> = {}) => ({ id: randomUUID(), org_id: orgId, source: 'custom', scan_id: null,
      action_key: null, title: 'Train the team', detail: null, domain: null, status: 'todo', assignee_user_id: null, due_date: null,
      created_by: randomUUID(), created_at: T0, updated_by: randomUUID(), updated_at: T0, ...patch });

    it('creates an action of the assessment on its first change and later moves only what the patch names', async () => {
      const { id } = await organization();
      const holder = await join(id, 'member');
      const scanId = await scan();
      await db.query('insert into public.org_analyses (org_id,scan_id,claimed_by) values ($1,$2,$3)', [id, scanId, randomUUID()]);
      const first = action(id, scanId, { status: 'in_progress' });
      const created = await rpc<Record<string, unknown>>('upsert_assessment_action', { p_action: first,
        p_patch: { status: 'in_progress', updated_by: first.updated_by, updated_at: T0 } });
      expect(created).toMatchObject({ id: first.id, status: 'in_progress', assignee_user_id: null });
      const later = await rpc<Record<string, unknown>>('upsert_assessment_action', { p_action: action(id, scanId),
        p_patch: { assignee_user_id: holder, due_date: '2026-12-01', updated_by: holder, updated_at: at(1) } });
      expect(later).toMatchObject({ id: first.id, status: 'in_progress', assignee_user_id: holder, due_date: '2026-12-01', updated_by: holder,
        created_by: first.created_by });
      expect(Date.parse(String(later.updated_at))).toBe(Date.parse(at(1)));
      await expect(rpc('upsert_assessment_action', { p_action: action(id, await scan()), p_patch: { updated_by: holder, updated_at: T0 } }))
        .rejects.toThrow('webapp_missing:analysis');
      // An assignee who cannot hold actions is refused by the write, which creates nothing.
      const viewer = await join(id, 'viewer');
      await expect(rpc('upsert_assessment_action', { p_action: action(id, scanId, { action_key: 'improve:D2.1', assignee_user_id: viewer }),
        p_patch: { assignee_user_id: viewer, updated_by: holder, updated_at: T0 } })).rejects.toThrow('webapp_ineligible_assignee');
      expect(await rows('select 1 from public.org_actions where org_id=$1', [id])).toHaveLength(1);
    });

    it('keeps at most 100 actions of an organization\'s own, counted under the organization lock, and checks their assignee', async () => {
      const { id } = await organization();
      const outsider = randomUUID();
      await expect(rpc('create_custom_action', { p_action: custom(id, { assignee_user_id: outsider }) })).rejects.toThrow('webapp_ineligible_assignee');
      await expect(rpc('create_custom_action', { p_action: custom(randomUUID()) })).rejects.toThrow('webapp_missing:organization');
      const duplicate = custom(id);
      await rpc('create_custom_action', { p_action: duplicate });
      await expect(rpc('create_custom_action', { p_action: duplicate })).rejects.toThrow('webapp_duplicate:action');
      await db.query(`insert into public.org_actions (org_id,source,title,created_by,updated_by)
        select $1,'custom','Policy ' || n, $2, $2 from generate_series(2, $3) n`, [id, randomUUID(), MAX_CUSTOM_ACTIONS]);
      await expect(rpc('create_custom_action', { p_action: custom(id) })).rejects.toThrow('webapp_conflict:action_limit');
      expect((await rows<{ n: number }>("select count(*)::int as n from public.org_actions where org_id=$1 and source='custom'", [id]))[0]!.n)
        .toBe(MAX_CUSTOM_ACTIONS);
    });

    it('updates an action by id within its organization, null when it is gone', async () => {
      const { id, owner } = await organization();
      const other = await organization();
      const actionId = await customAction(id);
      const viewer = await join(id, 'viewer');
      const patch = (value: Record<string, unknown>) => ({ ...value, updated_by: owner, updated_at: at(3) });
      expect(await rpc('update_action', { p_org_id: id, p_action_id: actionId, p_patch: patch({ status: 'done' }) }))
        .toMatchObject({ id: actionId, status: 'done', assignee_user_id: null, title: 'Write an AI policy' });
      expect(await rpc('update_action', { p_org_id: id, p_action_id: actionId, p_patch: patch({ assignee_user_id: owner, due_date: '2027-01-02' }) }))
        .toMatchObject({ status: 'done', assignee_user_id: owner, due_date: '2027-01-02' });
      expect(await rpc('update_action', { p_org_id: id, p_action_id: actionId, p_patch: patch({ assignee_user_id: null, due_date: null }) }))
        .toMatchObject({ status: 'done', assignee_user_id: null, due_date: null });
      await expect(rpc('update_action', { p_org_id: id, p_action_id: actionId, p_patch: patch({ assignee_user_id: viewer }) }))
        .rejects.toThrow('webapp_ineligible_assignee');
      expect(await rpc('update_action', { p_org_id: other.id, p_action_id: actionId, p_patch: patch({ status: 'todo' }) })).toBeNull();
      expect(await rpc('update_action', { p_org_id: id, p_action_id: randomUUID(), p_patch: patch({ status: 'todo' }) })).toBeNull();
    });
  });

  describe('billing', () => {
    const event = (id = `evt_${randomUUID().replaceAll('-', '')}`, type = 'customer.subscription.updated') => ({ id, type, livemode: false });
    // Subscription ids are unique across organizations (subscriptions_subscription_idx): each test names its own.
    let sub = 'sub_A1';
    const state = (patch: Record<string, unknown> = {}) => ({ status: 'active', plan_code: 'monthly', customer_id: 'cus_A1',
      subscription_id: sub, current_period_end: at(30 * 24 * 60), provider_status: 'active', price_id: 'price_monthly',
      cancel_at_period_end: false, current_period_start: T0, livemode: false, ...patch });
    const apply = (orgId: string, e: ReturnType<typeof event>, s: Record<string, unknown>, minutes = 0) =>
      rpc<string>('apply_billing_state', { p_event: e, p_org_id: orgId, p_state: s, p_at: at(minutes) });

    it('records and applies an event in one step, and the same event again changes nothing (§6.5)', async () => {
      const { id } = await organization();
      sub = 'sub_A1';
      const first = event();
      expect(await apply(id, first, state())).toBe('applied');
      expect(await rows('select billing_status from public.organizations where id=$1', [id])).toEqual([{ billing_status: 'active' }]);
      expect(await rows(`select plan_code, customer_id, subscription_id, status, provider_status, price_id, cancel_at_period_end, livemode
        from public.subscriptions where org_id=$1`, [id])).toEqual([{ plan_code: 'monthly', customer_id: 'cus_A1', subscription_id: 'sub_A1',
        status: 'active', provider_status: 'active', price_id: 'price_monthly', cancel_at_period_end: false, livemode: false }]);
      expect(await rows('select type, org_id, attempts, last_error, processed_at from public.stripe_events where id=$1', [first.id]))
        .toEqual([{ type: first.type, org_id: id, attempts: 1, last_error: null, processed_at: new Date(T0) }]);

      expect(await apply(id, first, state({ status: 'canceled' }), 1)).toBe('duplicate');
      expect(await rows('select billing_status from public.organizations where id=$1', [id])).toEqual([{ billing_status: 'active' }]);
      expect(await rows('select attempts, processed_at from public.stripe_events where id=$1', [first.id]))
        .toEqual([{ attempts: 2, processed_at: new Date(T0) }]);
      expect((await audits(id)).map(({ action, actor_kind, actor_user_id, target, data }) => [action, actor_kind, actor_user_id, target, data]))
        .toEqual([['billing.event_applied', 'system', null, first.id, { type: first.type, status: 'active', planCode: 'monthly' }]]);
    });

    it('fills what a state leaves out from the stored subscription, and moves only the billing status without a plan', async () => {
      const { id } = await organization();
      sub = 'sub_A2';
      expect(await apply(id, event(), state({ plan_code: null, subscription_id: null, customer_id: null }))).toBe('applied');
      expect(await rows('select 1 from public.subscriptions where org_id=$1', [id])).toEqual([]);
      expect(await apply(id, event(), state())).toBe('applied');
      expect(await apply(id, event(), { status: 'past_due', plan_code: null, customer_id: null, subscription_id: null, current_period_end: null }))
        .toBe('applied');
      expect(await rows('select plan_code, customer_id, subscription_id, status from public.subscriptions where org_id=$1', [id]))
        .toEqual([{ plan_code: 'monthly', customer_id: 'cus_A1', subscription_id: 'sub_A2', status: 'past_due' }]);
      expect(await rows('select billing_status from public.organizations where id=$1', [id])).toEqual([{ billing_status: 'past_due' }]);
    });

    it('an event of another subscription never overwrites a live one: a second paid one is a duplicate to raise', async () => {
      const { id } = await organization();
      sub = 'sub_A3';
      await apply(id, event(), state());
      const twin = event();
      expect(await apply(id, twin, state({ subscription_id: 'sub_B2' }))).toBe('duplicate_subscription');
      // A late event of an old, canceled subscription is only marked processed.
      const stale = event();
      expect(await apply(id, stale, state({ subscription_id: 'sub_OLD', status: 'canceled' }))).toBe('stale_subscription');
      expect(await rows('select subscription_id, status from public.subscriptions where org_id=$1', [id])).toEqual([{ subscription_id: 'sub_A3',
        status: 'active' }]);
      expect(await rows('select id, last_error, processed_at is not null as processed from public.stripe_events where id = any($1) order by id',
        [[twin.id, stale.id]])).toEqual([{ id: twin.id, last_error: 'other_subscription', processed: true },
        { id: stale.id, last_error: 'other_subscription', processed: true }].sort((a, b) => a.id.localeCompare(b.id)));
      expect((await audits(id)).map(({ action }) => action)).toEqual(['billing.event_applied', 'billing.duplicate_subscription']);
      // Once the stored one is canceled, a new subscription takes its place.
      await apply(id, event(), state({ status: 'canceled' }));
      expect(await apply(id, event(), state({ subscription_id: 'sub_C3' }))).toBe('applied');
      expect(await rows('select subscription_id, status from public.subscriptions where org_id=$1', [id])).toEqual([{ subscription_id: 'sub_C3',
        status: 'active' }]);
    });

    it('refuses an organization that does not exist, and records nothing for it', async () => {
      const stray = event();
      await expect(apply(randomUUID(), stray, state())).rejects.toThrow('webapp_missing:organization');
      expect(await rows('select 1 from public.stripe_events where id=$1', [stray.id])).toEqual([]);
    });
  });

  describe('deletion requests and accounts', () => {
    async function pending(orgId: string) {
      return (await rows<{ id: string }>("insert into public.deletion_requests (org_id,requested_by,reason) values ($1,$2,'Closing') returning id",
        [orgId, randomUUID()]))[0]!.id;
    }
    const review = (requestId: string, status: 'approved' | 'rejected', admin: string, minutes = 0) => rpc('review_deletion_request', {
      p_request_id: requestId, p_status: status, p_reviewed_by: admin, p_note: 'Checked', p_audit: { actor_kind: 'platform', actor_user_id: admin },
      p_at: at(minutes) });

    it('approves in one step and a second review is a conflict, not an error (409, not 500)', async () => {
      const { id } = await organization();
      const admin = randomUUID();
      const requestId = await pending(id);
      await review(requestId, 'approved', admin);
      expect(await rows('select status, reviewed_by, review_note from public.deletion_requests where id=$1', [requestId]))
        .toEqual([{ status: 'approved', reviewed_by: admin, review_note: 'Checked' }]);
      expect(await rows('select deleted_at from public.organizations where id=$1', [id])).toEqual([{ deleted_at: new Date(T0) }]);
      await expect(review(requestId, 'rejected', randomUUID(), 1)).rejects.toThrow('webapp_conflict:already_reviewed');
      await expect(review(requestId, 'approved', admin, 2)).rejects.toThrow('webapp_conflict:already_reviewed');
      await expect(review(randomUUID(), 'approved', admin)).rejects.toThrow('webapp_missing:deletion_request');
      expect(await rows('select deleted_at from public.organizations where id=$1', [id])).toEqual([{ deleted_at: new Date(T0) }]);
      expect((await audits(id)).map(({ action, actor_kind, target, data }) => [action, actor_kind, target, data]))
        .toEqual([['org.deletion_approved', 'platform', requestId, { note: 'Checked' }]]);
    });

    it('a rejection only closes the request', async () => {
      const { id } = await organization();
      const requestId = await pending(id);
      await review(requestId, 'rejected', randomUUID());
      expect(await rows('select deleted_at from public.organizations where id=$1', [id])).toEqual([{ deleted_at: null }]);
      expect((await audits(id)).map(({ action }) => action)).toEqual(['org.deletion_rejected']);
    });

    it('refuses to delete the account of a sole owner and changes nothing (§4.8)', async () => {
      const { id, owner } = await organization();
      await expect(rpc('delete_account', { p_user_id: owner, p_at: T0 })).rejects.toThrow('webapp_conflict:sole_owner');
      expect(await roleOf(id, owner)).toBe('owner');
      expect(await rows('select email is not null as live, deleted_at from public.profiles where user_id=$1', [owner]))
        .toEqual([{ live: true, deleted_at: null }]);
    });

    it('deletes an account: memberships, assignments and links go, the profile stays as a tombstone, each organization audits it', async () => {
      const first = await organization();
      const second = await organization();
      const gone = await organization({ deleted: true });
      const user = await join(first.id, 'owner');
      await db.query("insert into public.memberships (org_id,user_id,role) values ($1,$2,'member'), ($3,$2,'owner')",
        [second.id, user, gone.id]);
      await db.query("delete from public.memberships where org_id=$1 and user_id=$2", [gone.id, gone.owner]);
      await customAction(first.id, user);
      await customAction(second.id, user);
      const link = await invite((await organization()).id, `${user}@firm.example`);
      const result = await rpc<{ orgs: string[] }>('delete_account', { p_user_id: user, p_at: at(10) });
      expect(result.orgs.sort()).toEqual([first.id, second.id].sort());
      expect(await roleOf(first.id, user)).toBeNull();
      expect(await roleOf(second.id, user)).toBeNull();
      // A deleted organization keeps its history, its last owner included.
      expect(await roleOf(gone.id, user)).toBe('owner');
      expect([...await holders(first.id), ...await holders(second.id)]).toEqual([null, null]);
      expect(await rows('select revoked_at from public.invitations where id=$1', [link])).toEqual([{ revoked_at: new Date(at(10)) }]);
      expect(await rows('select email, full_name, deleted_at from public.profiles where user_id=$1', [user]))
        .toEqual([{ email: null, full_name: null, deleted_at: new Date(at(10)) }]);
      for (const orgId of [first.id, second.id]) {
        expect((await audits(orgId)).map(({ action, actor_user_id, target }) => [action, actor_user_id, target]))
          .toEqual([['account.deleted', user, user]]);
      }
      // A second call has nothing left to do.
      expect(await rpc('delete_account', { p_user_id: user, p_at: at(11) })).toEqual({ orgs: [] });
      expect(await rows('select deleted_at from public.profiles where user_id=$1', [user])).toEqual([{ deleted_at: new Date(at(10)) }]);
    });
  });

  describe('platform admins and the audit log', () => {
    it('grants and revokes the platform role once each, audited only when it changed', async () => {
      const userId = randomUUID();
      const script = { actor_kind: 'platform', actor_user_id: null };
      expect(await rpc('grant_platform_admin', { p_user_id: userId, p_granted_by: null, p_audit: script, p_at: T0 })).toBe(true);
      expect(await rpc('grant_platform_admin', { p_user_id: userId, p_granted_by: null, p_audit: script, p_at: at(1) })).toBe(false);
      expect(await rows('select granted_by from public.platform_admins where user_id=$1', [userId])).toEqual([{ granted_by: null }]);
      expect(await rpc('revoke_platform_admin', { p_user_id: userId, p_audit: script, p_at: at(2) })).toBe(true);
      expect(await rpc('revoke_platform_admin', { p_user_id: userId, p_audit: script, p_at: at(3) })).toBe(false);
      // Without an audit actor, as the debug login grants it, nothing is audited.
      expect(await rpc('grant_platform_admin', { p_user_id: userId, p_granted_by: userId, p_audit: null, p_at: at(4) })).toBe(true);
      const rowsOf = (await audits(null)).filter((row) => row.target === userId);
      expect(rowsOf.map(({ action, actor_kind, actor_user_id }) => [action, actor_kind, actor_user_id]))
        .toEqual([['platform_admin.granted', 'platform', null], ['platform_admin.revoked', 'platform', null]]);
    });

    it('pages the audit log newest first by (created_at, seq), looking the cursor up within the same filter', async () => {
      const { id } = await organization();
      const other = await organization();
      const append = async (orgId: string, minutes: number) => (await rows<{ seq: number }>(`insert into public.audit_log
        (actor_kind,org_id,action,created_at) values ('member',$1,'org.renamed',$2) returning seq::int`, [orgId, at(1000 + minutes)]))[0]!.seq;
      const now = await append(id, 0);
      const earlier = await append(id, -10);
      const later = await append(id, 10);
      const theirs = await append(other.id, 20);
      const page = async (orgId: string | null, before: number | null, limit: number) => (await rpc<Array<{ seq: number }>>('list_audit', {
        p_org_id: orgId, p_scoped: orgId !== null, p_before: before, p_limit: limit })).map((row) => row.seq);
      expect(await page(id, null, 10)).toEqual([later, now, earlier]);
      expect(await page(id, later, 1)).toEqual([now]);
      expect(await page(id, now, 10)).toEqual([earlier]);
      expect(await page(id, theirs, 10)).toEqual([]);
      expect(await page(id, 99_999_999, 10)).toEqual([]);
      expect(await page(null, null, 2)).toEqual([theirs, later]);
      expect(await page(null, theirs, 2)).toEqual([later, now]);
      const [row] = await rpc<Array<Record<string, unknown>>>('list_audit', { p_org_id: id, p_scoped: true, p_before: null, p_limit: 1 });
      expect(row).toMatchObject({ seq: later, org_id: id, actor_kind: 'member', action: 'org.renamed', data: {} });
    });
  });
});

describe('the real accounts migration over the DN-10 and DN-11 schema', () => {
  it('applies on top of rows already written and keeps them', async () => {
    const db = new PGlite();
    try {
      await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;`);
      const names = await migrations();
      const index = names.findIndex((name) => name.endsWith('_real_accounts_billing.sql'));
      expect(index).toBe(names.length - 1);
      for (const name of names.slice(0, index)) await db.exec(await readFile(new URL(name, directory), 'utf8'));
      const [org, owner] = [randomUUID(), randomUUID()];
      await db.query("insert into public.profiles (user_id,email) values ($1,'owner@firm.example')", [owner]);
      await db.query("insert into public.organizations (id,name,created_by) values ($1,'Firm LLP',$2)", [org, owner]);
      await db.query("insert into public.subscriptions (org_id,plan_code,status,subscription_id) values ($1,'monthly','active','sub_1')", [org]);
      await db.query("insert into public.stripe_events (id,type) values ('evt_1','checkout.completed')");
      await db.exec(await readFile(new URL(names[index]!, directory), 'utf8'));
      expect((await db.query('select email, deleted_at from public.profiles')).rows).toEqual([{ email: 'owner@firm.example', deleted_at: null }]);
      expect((await db.query('select cancel_at_period_end, provider_status from public.subscriptions')).rows)
        .toEqual([{ cancel_at_period_end: false, provider_status: null }]);
      expect((await db.query('select attempts, last_error from public.stripe_events')).rows).toEqual([{ attempts: 0, last_error: null }]);
      expect((await db.query('select code, stripe_price_id from public.plans order by code')).rows)
        .toEqual([{ code: 'annual', stripe_price_id: null }, { code: 'monthly', stripe_price_id: null }]);
    } finally {
      await db.close();
    }
  });
});

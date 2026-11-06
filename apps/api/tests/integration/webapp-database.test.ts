import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { DEFAULT_PLANS } from '../../src/webapp/plans.js';

const TABLES = ['profiles', 'organizations', 'memberships', 'invitations', 'org_analyses', 'claim_tickets', 'plans',
  'subscriptions', 'stripe_events', 'deletion_requests', 'platform_admins', 'audit_log', 'org_actions'] as const;

describe('PostgreSQL webapp schema (DN-10, DN-11)', () => {
  let db: PGlite;
  let sequence = 0;
  beforeAll(async () => {
    db = new PGlite();
    await db.exec('create role anon; create role authenticated; create role service_role bypassrls;');
    const directory = new URL('../../../../supabase/migrations/', import.meta.url);
    for (const migration of (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort()) {
      await db.exec(await readFile(new URL(migration, directory), 'utf8'));
    }
  });
  afterAll(async () => { await db?.close(); });

  const hash = () => randomBytes(32).toString('hex');
  async function scan() {
    const scanId = `sc_webapp${++sequence}`;
    await db.query(`insert into public.scans (scan_id,email,canonical_domain,domain_resolution,status,result)
      values ($1,'owner@firm.example','firm.example',$2,'COMPLETED','{}')`, [scanId,
      JSON.stringify({ status: 'RESOLVED', canonicalDomain: 'firm.example' })]);
    return scanId;
  }
  async function organization() {
    const id = randomUUID();
    const owner = randomUUID();
    await db.query("insert into public.organizations (id,name,created_by) values ($1,'Firm LLP',$2)", [id, owner]);
    await db.query("insert into public.memberships (org_id,user_id,role) values ($1,$2,'owner')", [id, owner]);
    return { id, owner };
  }
  async function addMember(orgId: string, role: string) {
    const userId = randomUUID();
    await db.query('insert into public.memberships (org_id,user_id,role) values ($1,$2,$3)', [orgId, userId, role]);
    return userId;
  }
  const claim = (orgId: string, scanId: string, assessmentId: string | null = null) => db.query(
    'insert into public.org_analyses (org_id,scan_id,assessment_id,claimed_by) values ($1,$2,$3,$4)',
    [orgId, scanId, assessmentId, randomUUID()]);
  const invite = (orgId: string, email: string, role = 'member', tokenHash = hash()) => db.query(
    `insert into public.invitations (org_id,email,role,token_hash,invited_by,expires_at)
      values ($1,$2,$3,$4,$5, now() + interval '7 days')`, [orgId, email, role, tokenHash, randomUUID()]);
  const requestDeletion = (orgId: string) => db.query(
    "insert into public.deletion_requests (org_id,requested_by,reason) values ($1,$2,'Closing the firm') returning id", [orgId, randomUUID()]);
  async function claimedScan(orgId: string) {
    const scanId = await scan();
    await claim(orgId, scanId);
    return scanId;
  }
  const assessmentAction = (orgId: string, scanId: string, actionKey: string) => db.query(
    `insert into public.org_actions (org_id,source,scan_id,action_key,created_by,updated_by)
      values ($1,'assessment',$2,$3,$4,$4) returning id,status`, [orgId, scanId, actionKey, randomUUID()]);
  const customAction = (orgId: string, title: string) => db.query(
    "insert into public.org_actions (org_id,source,title,created_by,updated_by) values ($1,'custom',$2,$3,$3)", [orgId, title, randomUUID()]);
  async function asRole<T>(role: 'anon' | 'authenticated' | 'service_role', action: () => Promise<T>) {
    await db.exec(`set role ${role}`);
    try { return await action(); } finally { await db.exec('reset role'); }
  }

  it('applies on top of the existing schema', async () => {
    const tables = await db.query<{ tablename: string }>("select tablename from pg_tables where schemaname='public' order by tablename");
    expect(tables.rows.map(({ tablename }) => tablename)).toEqual(expect.arrayContaining(
      ['scans', 'scan_raw_data', 'assessments', 'assessment_answer_events', ...TABLES]));
    const member = await organization();
    expect((await db.query('select role from public.memberships where org_id=$1', [member.id])).rows).toEqual([{ role: 'owner' }]);
  });

  it('seeds the example plans', async () => {
    const plans = await db.query('select code,name,amount_cents,currency,"interval",active from public.plans order by code');
    expect(plans.rows).toEqual([
      { code: 'annual', name: 'Annual (example price)', amount_cents: 499_000, currency: 'usd', interval: 'year', active: true },
      { code: 'monthly', name: 'Monthly (example price)', amount_cents: 49_900, currency: 'usd', interval: 'month', active: true },
    ]);
    // The in-memory repository seeds the same plans; the two must not drift.
    expect(plans.rows).toEqual([...DEFAULT_PLANS].sort((a, b) => a.code.localeCompare(b.code)));
  });

  it('keeps at least one owner', async () => {
    const { id, owner } = await organization();
    await organization(); // owners of other organizations do not count
    const demote = (userId: string) => db.query("update public.memberships set role='admin' where org_id=$1 and user_id=$2", [id, userId]);
    const remove = (userId: string) => db.query('delete from public.memberships where org_id=$1 and user_id=$2', [id, userId]);
    const roles = async () => (await db.query<{ role: string }>('select role from public.memberships where org_id=$1 order by role', [id]))
      .rows.map(({ role }) => role);

    await expect(demote(owner)).rejects.toThrow('at least one owner');
    await expect(remove(owner)).rejects.toThrow('at least one owner');
    // A change that leaves the sole owner an owner is not a demotion.
    await db.query('update public.memberships set invited_by=$2 where org_id=$1 and user_id=$2', [id, owner]);

    const second = await addMember(id, 'owner');
    // Both owners in one statement would leave none, even though each row alone would not.
    await expect(db.query("update public.memberships set role='member' where org_id=$1", [id])).rejects.toThrow('at least one owner');
    expect(await roles()).toEqual(['owner', 'owner']);

    await demote(owner);
    expect(await roles()).toEqual(['admin', 'owner']);
    await expect(db.query("update public.memberships set role='viewer' where org_id=$1 and user_id=$2", [id, second])).rejects.toThrow('at least one owner');
    await expect(remove(second)).rejects.toThrow('at least one owner');

    // Everyone else can change freely, and an owner can still leave once there is another.
    await db.query("update public.memberships set role='owner' where org_id=$1 and user_id=$2", [id, owner]);
    await remove(second);
    expect(await roles()).toEqual(['owner']);
    const member = await addMember(id, 'member');
    await db.query("update public.memberships set role='viewer' where org_id=$1 and user_id=$2", [id, member]);
    await remove(member);
    expect(await roles()).toEqual(['owner']);
  });

  it('a scan is claimed once', async () => {
    const first = await organization();
    const second = await organization();
    const scanId = await scan();
    await claim(first.id, scanId);
    await expect(claim(second.id, scanId)).rejects.toThrow('org_analyses_scan_id_key');
    await expect(claim(first.id, scanId)).rejects.toThrow('org_analyses_scan_id_key');
    expect((await db.query('select org_id from public.org_analyses where scan_id=$1', [scanId])).rows).toEqual([{ org_id: first.id }]);
    await expect(claim(first.id, 'sc_missing')).rejects.toThrow('foreign key');
    await expect(claim(randomUUID(), await scan())).rejects.toThrow('foreign key');
  });

  it('ties a claimed analysis to a real assessment, and a claim ticket to a real scan', async () => {
    const { id } = await organization();
    const scanId = await scan();
    await db.query('select public.create_assessment($1)', [JSON.stringify({ id: 'as_webapp', scan_id: scanId, status: 'PLANNING',
      bank_version: 'test-1.0.0', bank_snapshot: {}, layer1_snapshot: {}, evidence_snapshot: [], planner: 'rules',
      created_at: '2026-10-25T00:00:00Z', expires_at: '2026-10-26T00:00:00Z' })]);
    await expect(claim(id, scanId, 'as_missing')).rejects.toThrow('foreign key');
    await claim(id, scanId, 'as_webapp');
    expect((await db.query('select assessment_id from public.org_analyses where scan_id=$1', [scanId])).rows).toEqual([{ assessment_id: 'as_webapp' }]);
    const ticket = (ticketScan: string) => db.query(
      "insert into public.claim_tickets (id_hash,scan_id,email,expires_at) values ($1,$2,'owner@firm.example', now() + interval '1 day')",
      [hash(), ticketScan]);
    await ticket(scanId);
    await expect(ticket('sc_missing')).rejects.toThrow('foreign key');
  });

  it('an invitation cannot grant ownership', async () => {
    const { id } = await organization();
    await expect(invite(id, 'new@firm.example', 'owner')).rejects.toThrow('check constraint');
    for (const role of ['admin', 'member', 'viewer']) await invite(id, `${role}@firm.example`, role);
    expect((await db.query('select role from public.invitations where org_id=$1 order by role', [id])).rows)
      .toEqual([{ role: 'admin' }, { role: 'member' }, { role: 'viewer' }]);
  });

  it('allows one pending invitation per email and organization', async () => {
    const first = await organization();
    const second = await organization();
    await invite(first.id, 'new@firm.example');
    await expect(invite(first.id, 'New@Firm.example')).rejects.toThrow('invitations_pending_email_idx');
    await invite(second.id, 'new@firm.example');
    const reused = hash();
    await invite(first.id, 'other@firm.example', 'member', reused);
    await expect(invite(second.id, 'another@firm.example', 'member', reused)).rejects.toThrow('invitations_token_hash_key');
    // A revoked or accepted invitation no longer holds the slot.
    await db.query("update public.invitations set revoked_at=now() where org_id=$1 and email='new@firm.example'", [first.id]);
    await invite(first.id, 'new@firm.example');
    await db.query("update public.invitations set accepted_at=now() where org_id=$1 and email='new@firm.example' and revoked_at is null", [first.id]);
    await invite(first.id, 'new@firm.example');
    expect((await db.query('select 1 from public.invitations where org_id=$1 and email=$2', [first.id, 'new@firm.example'])).rows).toHaveLength(3);
  });

  it('one pending deletion request per organization', async () => {
    const first = await organization();
    const second = await organization();
    const pending = (await requestDeletion(first.id)).rows[0] as { id: string };
    await expect(requestDeletion(first.id)).rejects.toThrow('deletion_requests_pending_idx');
    await requestDeletion(second.id);
    // Once reviewed, the request leaves the queue and the organization can ask again.
    await db.query("update public.deletion_requests set status='rejected', reviewed_by=$2, reviewed_at=now() where id=$1", [pending.id, randomUUID()]);
    await requestDeletion(first.id);
    expect((await db.query("select status from public.deletion_requests where org_id=$1 order by status", [first.id])).rows)
      .toEqual([{ status: 'pending' }, { status: 'rejected' }]);
  });

  it('rejects values outside the allowed sets', async () => {
    const { id } = await organization();
    const scanId = await scan();
    const attempts: Array<[string, unknown[]]> = [
      ["insert into public.organizations (name,created_by,billing_status) values ('Firm',$1,'trialing')", [randomUUID()]],
      ["insert into public.memberships (org_id,user_id,role) values ($1,$2,'superuser')", [id, randomUUID()]],
      ["insert into public.plans (code,name,amount_cents,currency,\"interval\") values ('weekly','Weekly',100,'usd','week')", []],
      ["insert into public.plans (code,name,amount_cents,currency,\"interval\") values ('negative','Negative',-1,'usd','month')", []],
      ["insert into public.plans (code,name,amount_cents,currency,\"interval\") values ('upper','Upper',100,'USD','month')", []],
      ["insert into public.plans (code,name,amount_cents,currency,\"interval\") values ('short','Short',100,'us','month')", []],
      ["insert into public.subscriptions (org_id,plan_code,status) values ($1,'monthly','trialing')", [id]],
      ["insert into public.deletion_requests (org_id,requested_by,reason,status) values ($1,$2,'Closing','done')", [id, randomUUID()]],
      // Only hashes are stored, so a clear claim id or invitation token is refused.
      ["insert into public.claim_tickets (id_hash,scan_id,email,expires_at) values ('clear-claim-id',$1,'a@firm.example',now())", [scanId]],
      ["insert into public.invitations (org_id,email,role,token_hash,invited_by,expires_at) values ($1,'a@firm.example','member','clear-token',$2,now() + interval '1 day')", [id, randomUUID()]],
    ];
    for (const [statement, params] of attempts) await expect(db.query(statement, params), statement).rejects.toThrow('check constraint');
    await db.query("insert into public.subscriptions (org_id,plan_code,status) values ($1,'monthly','active')", [id]);
    await expect(db.query("insert into public.subscriptions (org_id,plan_code,status) values ($1,'missing','active')", [randomUUID()])).rejects.toThrow('foreign key');
  });

  it('the audit log is append-only', async () => {
    const { id, owner } = await organization();
    const row = (await db.query<{ id: string }>(
      "insert into public.audit_log (actor_user_id,org_id,action,target,data) values ($1,$2,'member.invited','new@firm.example','{\"role\":\"member\"}') returning id",
      [owner, id])).rows[0]!;
    await expect(db.query("update public.audit_log set action='member.removed' where id=$1", [row.id])).rejects.toThrow('append-only');
    await expect(db.query('delete from public.audit_log where id=$1', [row.id])).rejects.toThrow('append-only');
    expect((await db.query('select action,data from public.audit_log where id=$1', [row.id])).rows)
      .toEqual([{ action: 'member.invited', data: { role: 'member' } }]);
    // The backend's own role cannot even try: it was only granted select and insert.
    await asRole('service_role', async () => {
      await db.query("insert into public.audit_log (org_id,action) values ($1,'org.created')", [id]);
      await expect(db.query("update public.audit_log set action='x' where id=$1", [row.id])).rejects.toThrow('permission denied');
      await expect(db.query('delete from public.audit_log where id=$1', [row.id])).rejects.toThrow('permission denied');
    });
  });

  it('an action of the assessment belongs to a scan its own organization claimed', async () => {
    const first = await organization();
    const second = await organization();
    const scanId = await claimedScan(first.id);
    await assessmentAction(first.id, scanId, 'improve:D1.1');
    // The plan of another organization's scan, a scan nobody claimed, and one that does not exist.
    await expect(assessmentAction(second.id, scanId, 'improve:D1.1')).rejects.toThrow('org_actions_analysis_fk');
    await expect(assessmentAction(first.id, await scan(), 'improve:D1.1')).rejects.toThrow('org_actions_analysis_fk');
    await expect(assessmentAction(first.id, 'sc_missing', 'improve:D1.1')).rejects.toThrow('org_actions_analysis_fk');
    await expect(customAction(randomUUID(), 'Write an AI policy')).rejects.toThrow('foreign key');
    expect((await db.query('select org_id,source,status,assignee_user_id,due_date from public.org_actions where scan_id=$1', [scanId])).rows)
      .toEqual([{ org_id: first.id, source: 'assessment', status: 'todo', assignee_user_id: null, due_date: null }]);
  });

  it('keeps one row per action of each plan, which an upsert moves', async () => {
    const { id } = await organization();
    const other = await organization();
    const scanId = await claimedScan(id);
    const created = (await assessmentAction(id, scanId, 'improve:D1.1')).rows[0] as { id: string };
    await expect(assessmentAction(id, scanId, 'improve:D1.1')).rejects.toThrow('org_actions_assessment_idx');
    // The same action key in a newer plan, or in another organization's, is another action (DN-11 D14).
    await assessmentAction(id, await claimedScan(id), 'improve:D1.1');
    await assessmentAction(other.id, await claimedScan(other.id), 'improve:D1.1');
    // An organization may write the same title twice: the unique index covers only the assessment's actions.
    await customAction(id, 'Write an AI policy');
    await customAction(id, 'Write an AI policy');

    const actor = randomUUID();
    const upsert = await db.query(`insert into public.org_actions (org_id,source,scan_id,action_key,status,created_by,updated_by)
      values ($1,'assessment',$2,'improve:D1.1','done',$3,$3)
      on conflict (org_id,scan_id,action_key) where source = 'assessment'
      do update set status = excluded.status, updated_by = excluded.updated_by, updated_at = excluded.updated_at
      returning id,status,updated_by`, [id, scanId, actor]);
    expect(upsert.rows).toEqual([{ id: created.id, status: 'done', updated_by: actor }]);
    expect((await db.query('select source from public.org_actions where org_id=$1 order by source', [id])).rows)
      .toEqual([{ source: 'assessment' }, { source: 'assessment' }, { source: 'custom' }, { source: 'custom' }]);
  });

  it('keeps the columns of each source apart, and the values of an action in range', async () => {
    const { id } = await organization();
    const scanId = await claimedScan(id);
    const user = randomUUID();
    const insert = (columns: string, values: string, params: unknown[] = []) => db.query(
      `insert into public.org_actions (org_id,created_by,updated_by,${columns}) values ($1,$2,$2,${values})`, [id, user, ...params]);
    const attempts: Array<[string, string, unknown[]]> = [
      ['source,action_key', "'assessment','improve:D1.1'", []],
      ['source,scan_id', "'assessment',$3", [scanId]],
      ['source,scan_id,action_key', "'assessment',$3,''", [scanId]],
      ['source,scan_id,action_key,title', "'assessment',$3,'improve:D1.1','Own title'", [scanId]],
      ['source,scan_id,action_key,domain', "'assessment',$3,'improve:D1.2','governance'", [scanId]],
      ['source', "'custom'", []],
      ['source,title', "'custom','   '", []],
      ['source,title', "'custom',$3", ['x'.repeat(201)]],
      ['source,title,detail', "'custom','Policy',$3", ['x'.repeat(2001)]],
      ['source,title,domain', "'custom','Policy','finance'", []],
      ['source,title,scan_id', "'custom','Policy',$3", [scanId]],
      ['source,title,action_key', "'custom','Policy','improve:D1.1'", []],
      ['source,title,status', "'custom','Policy','blocked'", []],
      ['source,title', "'broker','Policy'", []],
    ];
    for (const [columns, values, params] of attempts) {
      await expect(insert(columns, values, params), `${columns} = ${values}`).rejects.toThrow('check constraint');
    }
    await insert('source,title,detail,domain,status,assignee_user_id,due_date', "'custom',$3,$4,'governance','in_progress',$5,'2026-12-01'",
      ['x'.repeat(200), 'x'.repeat(2000), randomUUID()]);
    await insert('source,title', "'custom','Train the team'");
    expect((await db.query("select status,domain from public.org_actions where org_id=$1 and source='custom' order by status", [id])).rows)
      .toEqual([{ status: 'in_progress', domain: 'governance' }, { status: 'todo', domain: null }]);
  });

  it('numbers the audit log in a strict order and records the kind of actor', async () => {
    const { id, owner } = await organization();
    const append = (createdAt: string, actorKind = 'member') => db.query<{ seq: number; actor_kind: string }>(
      `insert into public.audit_log (actor_user_id,org_id,action,created_at,actor_kind)
        values ($1,$2,'member.invited',$3,$4) returning seq::int,actor_kind`, [owner, id, createdAt, actorKind]);
    // Inserted out of clock order: the second row is the oldest.
    const rows = [(await append('2026-11-05T10:00:00Z')).rows[0]!, (await append('2026-11-05T09:00:00Z', 'platform')).rows[0]!,
      (await append('2026-11-05T11:00:00Z', 'system')).rows[0]!];
    expect(rows.map(({ actor_kind }) => actor_kind)).toEqual(['member', 'platform', 'system']);
    expect(rows[1]!.seq).toBeGreaterThan(rows[0]!.seq);
    expect(rows[2]!.seq).toBeGreaterThan(rows[1]!.seq);
    // A row that names no kind is a member's; the store numbers every row itself.
    expect((await db.query("insert into public.audit_log (org_id,action) values ($1,'org.renamed') returning actor_kind", [id])).rows)
      .toEqual([{ actor_kind: 'member' }]);
    await expect(append('2026-11-05T12:00:00Z', 'arca')).rejects.toThrow('check constraint');
    await expect(db.query("insert into public.audit_log (seq,org_id,action) values (1,$1,'org.created')", [id]))
      .rejects.toThrow('cannot insert a non-DEFAULT value into column "seq"');

    // A page goes on after the (created_at, seq) of its cursor row, so the oldest row is not lost behind a lower seq.
    const page = async (before: number | null) => (await db.query<{ seq: number }>(
      `select seq::int from public.audit_log where org_id=$1 and action='member.invited'
        and ($2::bigint is null or (created_at, seq) < (select created_at, seq from public.audit_log where seq = $2))
        order by created_at desc, seq desc limit 2`, [id, before])).rows.map(({ seq }) => seq);
    const first = await page(null);
    expect(first).toEqual([rows[2]!.seq, rows[0]!.seq]);
    expect(await page(first[1]!)).toEqual([rows[1]!.seq]);
    const index = await db.query<{ indexdef: string }>("select indexdef from pg_indexes where indexname='audit_log_org_seq_idx'");
    expect(index.rows[0]?.indexdef).toContain('(org_id, seq)');
  });

  it('anon and authenticated cannot read the tables', async () => {
    const rls = await db.query<{ relname: string; relrowsecurity: boolean }>(
      `select relname, relrowsecurity from pg_class where relkind='r' and relnamespace='public'::regnamespace
        and relname in (${TABLES.map((table) => `'${table}'`).join(',')}) order by relname`);
    expect(rls.rows).toEqual([...TABLES].sort().map((relname) => ({ relname, relrowsecurity: true })));
    for (const role of ['anon', 'authenticated'] as const) {
      await asRole(role, async () => {
        for (const table of TABLES) {
          await expect(db.query(`select * from public.${table}`), `${role} select ${table}`).rejects.toThrow('permission denied');
          await expect(db.query(`delete from public.${table}`), `${role} delete ${table}`).rejects.toThrow('permission denied');
        }
      });
    }
  });

  it('gives the service role the writes the backend needs, and audit_log only select and insert', async () => {
    for (const table of TABLES) {
      const privileges = await db.query<{ [privilege: string]: boolean }>(
        `select has_table_privilege('service_role', $1, 'select') as "select", has_table_privilege('service_role', $1, 'insert') as "insert",
          has_table_privilege('service_role', $1, 'update') as "update", has_table_privilege('service_role', $1, 'delete') as "delete"`,
        [`public.${table}`]);
      const appendOnly = table === 'audit_log';
      expect(privileges.rows[0], table).toEqual({ select: true, insert: true, update: !appendOnly, delete: !appendOnly });
    }
    // The last-owner trigger runs as the caller, so it has to work for the role the backend really uses.
    await asRole('service_role', async () => {
      const org = randomUUID();
      const owner = randomUUID();
      await db.query("insert into public.organizations (id,name,created_by) values ($1,'Firm LLP',$2)", [org, owner]);
      await db.query("insert into public.memberships (org_id,user_id,role) values ($1,$2,'owner')", [org, owner]);
      await expect(db.query("update public.memberships set role='admin' where org_id=$1", [org])).rejects.toThrow('at least one owner');
      await expect(db.query('delete from public.memberships where org_id=$1', [org])).rejects.toThrow('at least one owner');
    });
  });
});

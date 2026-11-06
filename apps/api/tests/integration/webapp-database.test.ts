import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { DEFAULT_PLANS } from '../../src/webapp/plans.js';
import { ACTOR_KIND_OF_ACTION } from '../../src/webapp/service.js';

const TABLES = ['profiles', 'organizations', 'memberships', 'invitations', 'org_analyses', 'claim_tickets', 'plans',
  'subscriptions', 'stripe_events', 'deletion_requests', 'platform_admins', 'audit_log', 'org_actions'] as const;

const directory = new URL('../../../../supabase/migrations/', import.meta.url);
const migrations = async () => (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
const migrate = async (db: PGlite, names: string[]) => {
  for (const migration of names) await db.exec(await readFile(new URL(migration, directory), 'utf8'));
};
/** The roles Supabase has, and what it hands them by default on every new sequence in public, as a real project does. */
async function supabaseRoles(db: PGlite) {
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;`);
}

describe('PostgreSQL webapp schema (DN-10, DN-11)', () => {
  let db: PGlite;
  let sequence = 0;
  beforeAll(async () => {
    db = new PGlite();
    await supabaseRoles(db);
    await migrate(db, await migrations());
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
      "insert into public.audit_log (actor_kind,actor_user_id,org_id,action,target,data) values ('member',$1,$2,'member.invited','new@firm.example','{\"role\":\"member\"}') returning id",
      [owner, id])).rows[0]!;
    await expect(db.query("update public.audit_log set action='member.removed' where id=$1", [row.id])).rejects.toThrow('append-only');
    await expect(db.query('delete from public.audit_log where id=$1', [row.id])).rejects.toThrow('append-only');
    expect((await db.query('select action,data from public.audit_log where id=$1', [row.id])).rows)
      .toEqual([{ action: 'member.invited', data: { role: 'member' } }]);
    // The backend's own role cannot even try: it was only granted select and insert.
    await asRole('service_role', async () => {
      await db.query("insert into public.audit_log (actor_kind,org_id,action) values ('system',$1,'org.created')", [id]);
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
    // A row that names no kind is refused rather than taken for a member's, which would show its actor's email (DN-11 §4.3).
    await expect(db.query("insert into public.audit_log (org_id,action) values ($1,'org.renamed')", [id]))
      .rejects.toThrow('null value in column "actor_kind"');
    await expect(append('2026-11-05T12:00:00Z', 'arca')).rejects.toThrow('check constraint');
    await expect(db.query("insert into public.audit_log (seq,actor_kind,org_id,action) values (1,'member',$1,'org.created')", [id]))
      .rejects.toThrow('cannot insert a non-DEFAULT value into column "seq"');

    // A page goes on after the (created_at, seq) of its cursor row, so the oldest row is not lost behind a lower seq. The cursor row
    // is looked up within the same organization: a seq of another one gives an empty page, not a glimpse of when it was written.
    const page = async (orgId: string, before: number | null) => (await db.query<{ seq: number }>(
      `select seq::int from public.audit_log where org_id=$1 and action='member.invited'
        and ($2::bigint is null or (created_at, seq) < (select created_at, seq from public.audit_log where seq = $2 and org_id = $1))
        order by created_at desc, seq desc limit 2`, [orgId, before])).rows.map(({ seq }) => seq);
    const first = await page(id, null);
    expect(first).toEqual([rows[2]!.seq, rows[0]!.seq]);
    expect(await page(id, first[1]!)).toEqual([rows[1]!.seq]);
    const other = await organization();
    const elsewhere = (await db.query<{ seq: number }>(`insert into public.audit_log (actor_kind,actor_user_id,org_id,action,created_at)
      values ('member',$1,$2,'member.invited','2026-11-05T12:00:00Z') returning seq::int`, [other.owner, other.id])).rows[0]!.seq;
    expect(await page(id, elsewhere)).toEqual([]);
    expect(await page(other.id, elsewhere)).toEqual([]);
  });

  it('indexes the audit log in the order the activity and ARCA\'s audit read it', async () => {
    const indexes = new Map((await db.query<{ indexname: string; indexdef: string }>(
      "select indexname, indexdef from pg_indexes where schemaname='public' and tablename='audit_log'")).rows
      .map(({ indexname, indexdef }) => [indexname, indexdef]));
    // One organization's pages, newest first (DN-11 §4.3); it also covers what DN-10's (org_id, created_at) served.
    expect(indexes.get('audit_log_org_order_idx')).toContain('(org_id, created_at DESC, seq DESC)');
    // ARCA's audit across organizations (§4.5).
    expect(indexes.get('audit_log_order_idx')).toContain('(created_at DESC, seq DESC)');
    // The cursor is looked up by seq, which stays unique.
    expect(indexes.get('audit_log_seq_key')).toMatch(/CREATE UNIQUE INDEX .*\(seq\)/);
    expect([...indexes.keys()].sort()).toEqual(['audit_log_order_idx', 'audit_log_org_order_idx', 'audit_log_pkey', 'audit_log_seq_key']);
  });

  it('closes the audit sequence to every client role, and the backend still appends', async () => {
    const name = (await db.query<{ name: string }>("select pg_get_serial_sequence('public.audit_log', 'seq') as name")).rows[0]!.name;
    expect(name).toBe('public.audit_log_seq_seq');
    const rights = async (role: string, sequence: string) => (await db.query<{ [privilege: string]: boolean }>(
      `select has_sequence_privilege($1, $2, 'usage') as usage, has_sequence_privilege($1, $2, 'select') as "select",
        has_sequence_privilege($1, $2, 'update') as update`, [role, sequence])).rows[0];
    // The default privileges are in force here, so a sequence nobody revoked is open to the client roles.
    await db.exec('create sequence public.probe_seq');
    try {
      expect(await rights('anon', 'public.probe_seq')).toEqual({ usage: true, select: true, update: true });
    } finally {
      await db.exec('drop sequence public.probe_seq');
    }
    for (const role of ['anon', 'authenticated', 'service_role']) {
      expect(await rights(role, name), role).toEqual({ usage: false, select: false, update: false });
    }
    for (const role of ['anon', 'authenticated'] as const) {
      await asRole(role, async () => {
        await expect(db.query(`select nextval('${name}')`), role).rejects.toThrow('permission denied');
        await expect(db.query(`select setval('${name}', 1)`), role).rejects.toThrow('permission denied');
      });
    }
    // Drawing the identity takes no right on the sequence.
    const { id } = await organization();
    await asRole('service_role', async () => {
      expect((await db.query("insert into public.audit_log (actor_kind,org_id,action) values ('member',$1,'org.renamed') returning seq", [id]))
        .rows).toHaveLength(1);
    });
  });

  it('anon and authenticated cannot read the tables', async () => {
    const rls = await db.query<{ relname: string; relrowsecurity: boolean }>(
      `select relname, relrowsecurity from pg_class where relkind='r' and relnamespace='public'::regnamespace
        and relname in (${TABLES.map((table) => `'${table}'`).join(',')}) order by relname`);
    expect(rls.rows).toEqual([...TABLES].sort().map((relname) => ({ relname, relrowsecurity: true })));
    // RLS with no policy at all: nothing opens a row to a client role, org_actions included.
    expect((await db.query(`select tablename, policyname from pg_policies where schemaname='public'
      and tablename in (${TABLES.map((table) => `'${table}'`).join(',')})`)).rows).toEqual([]);
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

describe('the role views migration over a DN-10 audit log', () => {
  it('names the actor of the rows already written, puts the append-only guard back and leaves no default', async () => {
    const db = new PGlite();
    try {
      await supabaseRoles(db);
      const names = await migrations();
      const roleViews = names.findIndex((name) => name.endsWith('_role_views.sql'));
      expect(roleViews).toBeGreaterThan(0);
      await migrate(db, names.slice(0, roleViews));

      // The rows DN-10 writes, each as its service did: ARCA staff and the billing system included, with no kind to say so.
      const [org, owner, staff] = [randomUUID(), randomUUID(), randomUUID()];
      await db.query("insert into public.organizations (id,name,created_by) values ($1,'Firm LLP',$2)", [org, owner]);
      const written: Array<[action: string, actor: string | null, orgId: string | null]> = [
        ['org.created', owner, org], ['billing.event_applied', null, org], ['member.invited', owner, org],
        ['org.deletion_requested', owner, org], ['org.deletion_rejected', staff, org], ['org.deletion_requested', owner, org],
        ['org.deletion_approved', staff, org], ['plan.updated', staff, null]];
      for (const [action, actor, orgId] of written) {
        await db.query('insert into public.audit_log (actor_user_id,org_id,action) values ($1,$2,$3)', [actor, orgId, action]);
      }
      await migrate(db, [names[roleViews]!]);

      const rows = (await db.query<{ action: string; actor_kind: string }>('select action, actor_kind from public.audit_log order by seq')).rows;
      expect(rows).toEqual([
        { action: 'org.created', actor_kind: 'member' }, { action: 'billing.event_applied', actor_kind: 'system' },
        { action: 'member.invited', actor_kind: 'member' }, { action: 'org.deletion_requested', actor_kind: 'member' },
        { action: 'org.deletion_rejected', actor_kind: 'platform' }, { action: 'org.deletion_requested', actor_kind: 'member' },
        { action: 'org.deletion_approved', actor_kind: 'platform' }, { action: 'plan.updated', actor_kind: 'platform' }]);
      // The migration and the service agree on who alone writes each of these actions.
      for (const [action, kind] of Object.entries(ACTOR_KIND_OF_ACTION)) {
        expect(rows.filter((row) => row.action === action).map((row) => row.actor_kind), action).toEqual([kind]);
      }

      // The guard was off for the correction only.
      expect((await db.query("select tgenabled from pg_trigger where tgname='audit_log_preserve_history'")).rows).toEqual([{ tgenabled: 'O' }]);
      await expect(db.query("update public.audit_log set actor_kind='member'")).rejects.toThrow('append-only');
      await expect(db.query('delete from public.audit_log')).rejects.toThrow('append-only');
      // From now on a write names its actor kind, or fails.
      expect((await db.query(`select column_default from information_schema.columns
        where table_schema='public' and table_name='audit_log' and column_name='actor_kind'`)).rows).toEqual([{ column_default: null }]);
      await expect(db.query("insert into public.audit_log (actor_user_id,org_id,action) values ($1,$2,'org.renamed')", [owner, org]))
        .rejects.toThrow('null value in column "actor_kind"');
    } finally {
      await db.close();
    }
  });
});

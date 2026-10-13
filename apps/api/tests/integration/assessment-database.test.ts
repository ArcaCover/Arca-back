import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFile, readdir } from 'node:fs/promises';

type Row = {
  id: string;
  scan_id: string;
  revision: number;
  status: string;
  bank_snapshot: unknown;
  layer1_snapshot: unknown;
  evidence_snapshot: unknown;
  plan: unknown;
  rendered: unknown[];
  answers: Record<string, unknown>;
  answer_write_count: number;
  result: unknown;
  updated_at: string;
};

const question = { id: 'D1.1', text: 'Official question', context: null, suggestedAnswer: null };
const followup = { id: 'D1.1a', text: 'Official follow-up', context: null, suggestedAnswer: null };
const yes = { kind: 'option', optionId: 'yes' };
const no = { kind: 'option', optionId: 'no' };
const plan = { intro: 'Assessment', items: [{ questionId: 'D1.1', context: null, evidenceIds: [], suggestedOption: null }] };
const saved = (answer = yes, rendered = question) => ({
  question_id: rendered.id, answer, kind: 'saved', suggested: false, rendered,
});

describe('PostgreSQL assessment transactions', () => {
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

  async function input(overrides: Record<string, unknown> = {}) {
    const suffix = String(++sequence);
    const scanId = `sc_assessment${suffix}`;
    await db.query(`insert into public.scans (scan_id,email,canonical_domain,domain_resolution,status,result)
      values ($1,'owner@firm.example','firm.example',$2,'COMPLETED','{}')`, [scanId,
      JSON.stringify({ status: 'RESOLVED', canonicalDomain: 'firm.example' })]);
    return {
      id: `as_database${suffix}`, scan_id: scanId, status: 'PLANNING', bank_version: 'test-1.0.0',
      bank_snapshot: { bankVersion: 'test-1.0.0', questions: [{ id: 'D1.1' }] },
      layer1_snapshot: { preScore: { total: 50 }, signals: {} },
      evidence_snapshot: [{ id: 'website:1', quote: 'Original evidence' }],
      planner: 'rules', planner_model: null, prompt_version: null,
      plan: null, rendered: [], answers: {}, result: null, attested_at: null, completed_at: null,
      created_at: '2026-10-13T00:00:00Z', expires_at: '2026-10-14T00:00:00Z',
      updated_at: '2026-10-13T00:00:00Z', ...overrides,
    };
  }
  async function create(record: Record<string, unknown>) {
    return (await db.query<{ value: Row }>('select public.create_assessment($1) as value', [JSON.stringify(record)])).rows[0]!.value;
  }
  async function update(id: string, revision: number, patch: Record<string, unknown>, events: unknown[] = []) {
    return (await db.query<{ value: Row | null }>('select public.update_assessment($1,$2,$3,$4) as value',
      [id, revision, JSON.stringify(patch), JSON.stringify(events)])).rows[0]!.value;
  }
  async function read(id: string) {
    return (await db.query<Row>('select * from public.assessments where id=$1', [id])).rows[0]!;
  }
  async function ready() {
    const created = await create(await input());
    return (await update(created.id, 0, { status: 'READY', plan, rendered: [question] }))!;
  }
  async function asRole<T>(role: 'anon' | 'authenticated' | 'service_role', action: () => Promise<T>) {
    await db.exec(`set role ${role}`);
    try { return await action(); } finally { await db.exec('reset role'); }
  }

  it('enables RLS and closes table, sequence, and RPC access to client roles', async () => {
    const rls = await db.query<{ relname: string; relrowsecurity: boolean }>(`select relname, relrowsecurity from pg_class
      where relname in ('assessments','assessment_answer_events') order by relname`);
    expect(rls.rows).toEqual([
      { relname: 'assessment_answer_events', relrowsecurity: true },
      { relname: 'assessments', relrowsecurity: true },
    ]);
    for (const role of ['anon', 'authenticated'] as const) {
      await asRole(role, async () => {
        for (const table of ['assessments', 'assessment_answer_events']) {
          await expect(db.query(`select * from public.${table}`)).rejects.toThrow('permission denied');
          await expect(db.query(`delete from public.${table}`)).rejects.toThrow('permission denied');
        }
        await expect(db.query("select nextval('public.assessment_answer_events_id_seq')")).rejects.toThrow('permission denied');
        await expect(create({})).rejects.toThrow('permission denied');
        await expect(update('absent', 0, {})).rejects.toThrow('permission denied');
      });
    }
    const functions = await db.query<{ proname: string; prosecdef: boolean; proconfig: string[] }>(`select proname, prosecdef, proconfig
      from pg_proc where proname in ('create_assessment','update_assessment') order by proname`);
    expect(functions.rows).toEqual([
      { proname: 'create_assessment', prosecdef: true, proconfig: ['search_path=pg_catalog, public'] },
      { proname: 'update_assessment', prosecdef: true, proconfig: ['search_path=pg_catalog, public'] },
    ]);
  });

  it('lets the service role read and mutate through RPCs, but not bypass transactions directly', async () => {
    const record = await input();
    await asRole('service_role', async () => {
      const created = await create(record);
      expect(created).toMatchObject({ id: record.id, revision: 0, answer_write_count: 0 });
      expect((await read(created.id)).id).toBe(created.id);
      expect(await update(created.id, 0, { status: 'READY', plan, rendered: [question] })).toMatchObject({ revision: 1 });
      await expect(db.query("update public.assessments set status='EXPIRED' where id=$1", [created.id])).rejects.toThrow('permission denied');
      await expect(db.query('delete from public.assessments where id=$1', [created.id])).rejects.toThrow('permission denied');
      await expect(db.query(`insert into public.assessment_answer_events(assessment_id, question_id, answer, kind, rendered)
        values ($1,'D1.1',$2,'saved',$3)`, [created.id, JSON.stringify(yes), JSON.stringify(question)])).rejects.toThrow('permission denied');
    });
  });

  it('stores all immutable inputs and enforces a real scan, required snapshots, status and planner', async () => {
    const record = await input();
    const row = await create(record);
    expect(row).toMatchObject({ bank_snapshot: record.bank_snapshot, layer1_snapshot: record.layer1_snapshot,
      evidence_snapshot: record.evidence_snapshot, revision: 0, plan: null, rendered: [], answers: {}, result: null });
    await expect(create({ ...await input(), scan_id: 'sc_missing' })).rejects.toThrow('foreign key');
    for (const field of ['bank_snapshot', 'layer1_snapshot', 'evidence_snapshot']) {
      const invalid: Record<string, unknown> = await input();
      delete invalid[field];
      await expect(create(invalid)).rejects.toThrow('not-null');
      await expect(create({ ...await input(), [field]: null })).rejects.toThrow('check constraint');
    }
    await expect(create(await input({ status: 'UNKNOWN' }))).rejects.toThrow('check constraint');
    await expect(create(await input({ planner: 'unknown' }))).rejects.toThrow('check constraint');
    await expect(create(await input({ answers: { 'D1.1': yes } }))).rejects.toThrow('no answer history');
  });

  it('returns one assessment for competing creates and never replaces a terminal assessment', async () => {
    const record = await input();
    const [first, second] = await Promise.all([
      create(record), create({ ...record, id: 'as_duplicate', bank_snapshot: { changed: true } }),
    ]);
    expect(first.id).toBe(second.id);
    expect(second.bank_snapshot).toEqual(record.bank_snapshot);
    expect((await db.query('select id from public.assessments where scan_id=$1', [record.scan_id])).rows).toHaveLength(1);
    await update(first.id, 0, { status: 'EXPIRED' });
    expect(await create({ ...record, id: 'as_restarted' })).toMatchObject({ id: first.id, status: 'EXPIRED', revision: 1 });
    expect(await update(first.id, 1, { status: 'PLANNING' })).toBeNull();
    const failed = await create(await input());
    await update(failed.id, 0, { status: 'FAILED' });
    expect(await update(failed.id, 1, { status: 'READY', plan })).toBeNull();
  });

  it('permits exactly one same-revision write and commits no events from the losing writer', async () => {
    const row = await ready();
    // PGlite queues concurrent promises on one connection; these exercise the losing CAS
    // path. The SQL additionally uses FOR UPDATE for multi-connection PostgreSQL callers.
    const writes = await Promise.all([
      update(row.id, row.revision, { status: 'IN_PROGRESS', answers: { 'D1.1': yes } }, [saved(yes)]),
      update(row.id, row.revision, { status: 'IN_PROGRESS', answers: { 'D1.1': no } }, [saved(no)]),
    ]);
    expect(writes.filter(Boolean)).toHaveLength(1);
    expect(writes.filter((value) => value === null)).toHaveLength(1);
    const winner = writes.find((value) => value !== null)!;
    expect(await read(row.id)).toMatchObject({ revision: 2, answers: winner.answers, answer_write_count: 1 });
    const events = await db.query<{ answer: unknown }>('select answer from public.assessment_answer_events where assessment_id=$1', [row.id]);
    expect(events.rows).toEqual([{ answer: winner.answers['D1.1'] }]);
    expect(await update('as_missing', 0, {})).toBeNull();
    expect(await update(row.id, -1, {})).toBeNull();
  });

  it('rolls back the assessment and every event if an event insert fails', async () => {
    let row = await ready();
    row = (await update(row.id, row.revision, { answers: { 'D1.1a': yes }, rendered: [question, followup] }, [saved(yes, followup)]))!;
    const original = await read(row.id);
    const originalEvents = (await db.query('select * from public.assessment_answer_events where assessment_id=$1', [row.id])).rows;
    await expect(update(row.id, row.revision, { status: 'IN_PROGRESS', answers: { 'D1.1': yes } }, [saved(),
      { question_id: followup.id, answer: null, kind: 'invalidated', rendered: followup, created_at: 'invalid timestamp' }]))
      .rejects.toThrow('timestamp');
    expect(await read(row.id)).toEqual(original);
    expect((await db.query('select * from public.assessment_answer_events where assessment_id=$1', [row.id])).rows).toEqual(originalEvents);
  });

  it('appends exact displayed text and saves answer changes and invalidation history atomically', async () => {
    let row = await ready();
    row = (await update(row.id, row.revision, { status: 'IN_PROGRESS', answers: { 'D1.1': yes },
      rendered: [question, followup] }, [{ ...saved(), suggested: true }]))!;
    row = (await update(row.id, row.revision, { answers: { 'D1.1': yes, 'D1.1a': yes } }, [saved(yes, followup)]))!;
    row = (await update(row.id, row.revision, { answers: { 'D1.1': no }, answer_write_count: 3 }, [saved(no),
      { question_id: followup.id, answer: null, kind: 'invalidated', suggested: false, rendered: followup }]))!;
    expect(row).toMatchObject({ answer_write_count: 3, answers: { 'D1.1': no }, rendered: [question, followup] });
    const events = await db.query<{ question_id: string; kind: string; answer: unknown; rendered: unknown; suggested: boolean }>(
      'select question_id,kind,answer,rendered,suggested from public.assessment_answer_events where assessment_id=$1 order by id', [row.id]);
    expect(events.rows).toEqual([
      { question_id: question.id, kind: 'saved', answer: yes, rendered: question, suggested: true },
      { question_id: followup.id, kind: 'saved', answer: yes, rendered: followup, suggested: false },
      { question_id: question.id, kind: 'saved', answer: no, rendered: question, suggested: false },
      { question_id: followup.id, kind: 'invalidated', answer: null, rendered: followup, suggested: false },
    ]);
  });

  it('rejects unaudited answer writes, mismatched events, invalidations and duplicate event ids', async () => {
    const row = await ready();
    await expect(update(row.id, row.revision, { answers: { 'D1.1': yes } })).rejects.toThrow('audit event');
    await expect(update(row.id, row.revision, { answers: { 'D1.1': no } }, [saved()])).rejects.toThrow('match the current answer');
    await expect(update(row.id, row.revision, { answers: { 'D1.1': yes } }, [saved(yes, { ...question, text: 'Rewritten' })]))
      .rejects.toThrow('exact rendered question');
    await expect(update(row.id, row.revision, {}, [{ question_id: question.id, answer: null,
      kind: 'invalidated', rendered: question }])).rejects.toThrow('remove an existing answer');
    await expect(update(row.id, row.revision, { answers: { 'D1.1': yes } }, [saved(), saved()])).rejects.toThrow('unique question ids');
    expect((await read(row.id)).revision).toBe(row.revision);
  });

  it('rejects immutable/unknown update keys and direct changes to every frozen input', async () => {
    const record = await input();
    const row = await create(record);
    for (const field of ['id', 'scan_id', 'bank_version', 'bank_snapshot', 'layer1_snapshot', 'evidence_snapshot',
      'created_at', 'expires_at', 'revision', 'unknown']) {
      await expect(update(row.id, row.revision, { [field]: 'tampered' })).rejects.toThrow('immutable or unknown field');
    }
    for (const field of ['bank_snapshot', 'layer1_snapshot', 'evidence_snapshot']) {
      await expect(db.query(`update public.assessments set ${field}='{}' where id=$1`, [row.id])).rejects.toThrow('snapshots and identity are immutable');
    }
    await expect(db.query("update public.assessments set bank_version='other' where id=$1", [row.id])).rejects.toThrow('immutable');
    await expect(db.query("update public.assessments set expires_at=expires_at + interval '1 day' where id=$1", [row.id])).rejects.toThrow('immutable');
    await expect(db.query('delete from public.assessments where id=$1', [row.id])).rejects.toThrow('cannot be deleted');
    expect((await read(row.id)).bank_snapshot).toEqual(record.bank_snapshot);
  });

  it('freezes a published plan and provenance while allowing recovery before publication', async () => {
    const original = await create(await input({ planner: 'agent', planner_model: 'test-model', prompt_version: 'test-v1' }));
    const row = (await update(original.id, 0, { status: 'READY', planner: 'rules', planner_model: null, prompt_version: null,
      plan, rendered: [question] }))!;
    for (const patch of [{ plan: { items: [] } }, { plan: null }, { planner: 'agent' },
      { planner_model: 'replacement' }, { prompt_version: 'replacement' }]) {
      await expect(update(row.id, row.revision, patch)).rejects.toThrow('plan and planner provenance are immutable');
    }
    expect(await update(row.id, row.revision, { status: 'EXPIRED', plan })).toMatchObject({ status: 'EXPIRED', plan });
  });

  it('rejects changed, removed, reordered or duplicate rendered questions', async () => {
    let row = await ready();
    row = (await update(row.id, row.revision, { rendered: [question, followup] }))!;
    for (const rendered of [[], [question], [followup, question], [{ ...question, context: 'Changed' }, followup]]) {
      await expect(update(row.id, row.revision, { rendered })).rejects.toThrow('immutable prefix');
    }
    await expect(update(row.id, row.revision, { rendered: [question, followup, question] })).rejects.toThrow('unique nonempty ids');
    await expect(update(row.id, row.revision, { rendered: [question, followup, { text: 'No id' }] })).rejects.toThrow('unique nonempty ids');
    expect((await read(row.id)).rendered).toEqual([question, followup]);
  });

  it('requires attestation/result for completion and prevents all subsequent row or event changes', async () => {
    let row = await ready();
    row = (await update(row.id, row.revision, { status: 'IN_PROGRESS', answers: { 'D1.1': yes } }, [saved()]))!;
    await expect(update(row.id, row.revision, { status: 'COMPLETED' })).rejects.toThrow('completed_assessment_has_result');
    row = (await update(row.id, row.revision, { status: 'COMPLETED', result: { layer2Score: 100 },
      attested_at: '2026-10-13T01:00:00Z', completed_at: '2026-10-13T01:00:00Z' }))!;
    expect(await update(row.id, row.revision, { status: 'IN_PROGRESS', answers: {} })).toBeNull();
    expect(await update(row.id, row.revision, { result: { layer2Score: 0 } })).toBeNull();
    await expect(db.query("update public.assessments set result='{}' where id=$1", [row.id])).rejects.toThrow('Completed assessments are immutable');
    await expect(db.query('delete from public.assessments where id=$1', [row.id])).rejects.toThrow('cannot be deleted');
    await expect(db.query("update public.assessment_answer_events set answer='{}' where assessment_id=$1", [row.id])).rejects.toThrow('append-only');
    await expect(db.query('delete from public.assessment_answer_events where assessment_id=$1', [row.id])).rejects.toThrow('append-only');
    const retry = await create({ ...await input(), scan_id: row.scan_id, id: 'as_completed_retry' });
    expect(retry).toMatchObject({ id: row.id, status: 'COMPLETED', result: { layer2Score: 100 } });
  });

  it('increments the durable write budget once per save and atomically rejects the 1001st save', async () => {
    let row = await ready();
    await expect(update(row.id, row.revision, { answer_write_count: 1 })).rejects.toThrow('counter violated');
    await expect(update(row.id, row.revision, { answers: { 'D1.1': yes }, answer_write_count: 0 }, [saved()])).rejects.toThrow('counter violated');
    await expect(update(row.id, row.revision, { answers: { 'D1.1': yes, 'D1.1a': yes }, rendered: [question, followup] },
      [saved(), saved(yes, followup)])).rejects.toThrow('counter violated');
    // Seed the boundary as the database owner; the service role cannot set this directly.
    await db.query('update public.assessments set answer_write_count=999 where id=$1', [row.id]);
    row = (await update(row.id, row.revision, { answers: { 'D1.1': yes }, answer_write_count: 1000 }, [saved()]))!;
    expect(row.answer_write_count).toBe(1000);
    await expect(update(row.id, row.revision, { answers: { 'D1.1': no } }, [saved(no)])).rejects.toThrow('write limit');
    expect((await read(row.id)).answers).toEqual({ 'D1.1': yes });
    expect((await db.query('select id from public.assessment_answer_events where assessment_id=$1', [row.id])).rows).toHaveLength(1);
    expect(await update(row.id, row.revision, { status: 'EXPIRED' })).toMatchObject({ answer_write_count: 1000, status: 'EXPIRED' });
  });

  it('supports stale planning reads, caller timestamps and CAS expiry without rewriting inputs', async () => {
    const row = await create(await input());
    await asRole('service_role', async () => {
      const stale = await db.query<{ id: string }>("select id from public.assessments where status='PLANNING' and updated_at < $1", ['2026-10-13T00:30:00Z']);
      expect(stale.rows.map(({ id }) => id)).toContain(row.id);
      const expired = await update(row.id, row.revision, { status: 'EXPIRED', updated_at: '2026-10-13T01:00:00Z' });
      expect(expired).toMatchObject({ status: 'EXPIRED', revision: 1, bank_snapshot: row.bank_snapshot });
      expect(Date.parse(expired!.updated_at)).toBe(Date.parse('2026-10-13T01:00:00Z'));
    });
  });
});

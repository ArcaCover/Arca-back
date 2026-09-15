import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';

describe('PostgreSQL baseline', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = new PGlite();
    await db.exec('create role anon; create role authenticated; create role service_role bypassrls;');
    for (const migration of ['20260908151940_create_layer1.sql', '20260912231500_cache_partial_scans.sql',
      '20260914234000_apify_run_ledger.sql']) {
      await db.exec(await readFile(new URL(`../../../../supabase/migrations/${migration}`, import.meta.url), 'utf8'));
    }
  });
  afterAll(async () => { await db?.close(); });
  it('enables RLS on all application tables', async () => {
    const result = await db.query<{ relname: string; relrowsecurity: boolean }>("select relname, relrowsecurity from pg_class where relname in ('scans', 'scan_raw_data', 'apify_runs', 'scan_apify_runs') order by relname");
    expect(result.rows).toEqual([{ relname: 'apify_runs', relrowsecurity: true },
      { relname: 'scan_apify_runs', relrowsecurity: true }, { relname: 'scan_raw_data', relrowsecurity: true },
      { relname: 'scans', relrowsecurity: true }]);
  });
  it('denies direct reads to anonymous and authenticated users', async () => {
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`set role ${role}`);
      await expect(db.query('select * from scans')).rejects.toThrow('permission denied');
      for (const table of ['scan_raw_data', 'apify_runs', 'scan_apify_runs']) {
        await expect(db.query(`select * from ${table}`)).rejects.toThrow('permission denied');
      }
      await db.exec('reset role');
    }
  });
  it('requires a canonical identity and stores JSONB with null evidence', async () => {
    await expect(db.query("insert into scans (scan_id,email,domain_resolution) values ('sc_bad','user@gmail.com','{}')")).rejects.toThrow();
    await db.query(`insert into scans (scan_id, email, canonical_domain, domain_resolution, status, result)
      values ($1,$2,$3,$4,'PARTIAL',$5)`, ['sc_database', 'user@gmail.com', 'firm.com',
      JSON.stringify({ status: 'RESOLVED', canonicalDomain: 'firm.com', source: 'request', reason: null }), JSON.stringify({ preScore: { total: null } })]);
    const result = await db.query<{ result: { preScore: { total: null } } }>("select result from scans where scan_id='sc_database'");
    expect(result.rows[0]?.result.preScore.total).toBeNull();
  });
  it('requires real parent scans for raw evidence', async () => {
    await expect(db.query("insert into scan_raw_data (scan_id,source,raw_content,content_hash) values ('sc_missing','bar','{}',$1)", ['a'.repeat(64)])).rejects.toThrow();
    await db.query("insert into scan_raw_data (scan_id,source,raw_content,content_hash) values ('sc_database','bar','{}',$1)", ['a'.repeat(64)]);
    await db.query("delete from scans where scan_id='sc_database'");
    expect((await db.query('select * from scan_raw_data')).rows).toEqual([]);
  });
  it('reserves one Apify run per fingerprint and enforces the scan budget atomically', async () => {
    await db.query(`insert into scans (scan_id, email, canonical_domain, domain_resolution)
      values ('sc_ledger','user@firm.com','firm.com',$1)`,
    [JSON.stringify({ status: 'RESOLVED', canonicalDomain: 'firm.com', source: 'request', reason: null })]);
    const reserve = (fingerprint: string) => db.query<{ reserve_apify_run: { decision: string; record: { id: string } | null } }>(
      'select reserve_apify_run($1,$2,$3,$4,$5,$6,$7,$8,$9)', ['sc_ledger', fingerprint, 'owner/actor', '1.2.3',
        JSON.stringify({ name: 'Jane' }), 1, 1, 10, new Date(Date.now() + 900000).toISOString()]);
    const first = await reserve('a'.repeat(64));
    const repeated = await reserve('a'.repeat(64));
    const blocked = await reserve('b'.repeat(64));
    expect(first.rows[0]?.reserve_apify_run.decision).toBe('start');
    expect(repeated.rows[0]?.reserve_apify_run).toMatchObject({ decision: 'resume',
      record: { id: first.rows[0]?.reserve_apify_run.record?.id } });
    expect(blocked.rows[0]?.reserve_apify_run).toEqual({ decision: 'budget_exceeded', record: null, chargedToScan: false });
  });
});

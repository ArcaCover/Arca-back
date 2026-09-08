import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';

describe('PostgreSQL baseline', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = new PGlite();
    await db.exec('create role anon; create role authenticated; create role service_role bypassrls;');
    const sql = await readFile(new URL('../../../../supabase/migrations/20260905221010_create_layer1.sql', import.meta.url), 'utf8');
    await db.exec(sql);
  });
  afterAll(async () => { await db?.close(); });
  it('enables RLS on both tables', async () => {
    const result = await db.query<{ relname: string; relrowsecurity: boolean }>("select relname, relrowsecurity from pg_class where relname in ('scans', 'scan_raw_data') order by relname");
    expect(result.rows).toEqual([{ relname: 'scan_raw_data', relrowsecurity: true }, { relname: 'scans', relrowsecurity: true }]);
  });
  it('denies direct reads to anonymous and authenticated users', async () => {
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`set role ${role}`);
      await expect(db.query('select * from scans')).rejects.toThrow('permission denied');
      await expect(db.query('select * from scan_raw_data')).rejects.toThrow('permission denied');
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
});

import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { createClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { SupabaseWebappRepository } from '../../src/webapp/supabase.js';
import { describeWebappRepository } from '../conformance/webapp-repository.js';
import { pglitePostgrest } from '../fixtures/pglite-postgrest.js';

// SupabaseWebappRepository against the three webapp migrations, through supabase-js and a PostgREST stand-in over PGlite (DN-13 §11).
// The same suite runs against a real Supabase in webapp-repository-supabase.test.ts.
const directory = new URL('../../../../supabase/migrations/', import.meta.url);
const client = (fetch: typeof globalThis.fetch) => createClient('http://pglite.test', 'sb_secret_fixture',
  { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch } });

describeWebappRepository('Supabase over PGlite', async () => {
  const db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;`);
  for (const name of (await readdir(directory)).filter((file) => file.endsWith('.sql')).sort()) {
    await db.exec(await readFile(new URL(name, directory), 'utf8'));
  }
  let scans = 0;
  return {
    repository: new SupabaseWebappRepository(client(pglitePostgrest(db))),
    async scan() {
      const scanId = `sc_conformance${++scans}`;
      await db.query(`insert into public.scans (scan_id,email,canonical_domain,domain_resolution,status,result)
        values ($1,'owner@firm.example','firm.example',$2,'COMPLETED','{}')`, [scanId, JSON.stringify({ status: 'RESOLVED', canonicalDomain: 'firm.example' })]);
      return scanId;
    },
    close: () => db.close(),
  };
});

describe('SupabaseWebappRepository errors', () => {
  const failing = (status: number, body: object) => new SupabaseWebappRepository(client(vi.fn(async () => Response.json(body, { status }))));

  it('reports a storage error as one, naming the operation, never as an absent record', async () => {
    const repository = failing(500, { code: '57014', message: 'canceling statement due to statement timeout', details: null, hint: null });
    await expect(repository.getOrganization('7d1f8a2e-0000-4000-8000-000000000000')).rejects.toThrow('Unable to read organization');
    await expect(repository.listAudit('7d1f8a2e-0000-4000-8000-000000000000', { limit: 1 })).rejects.toThrow('Unable to list audit');
    await expect(repository.isPlatformAdmin('7d1f8a2e-0000-4000-8000-000000000000')).rejects.toThrow('Unable to read platform admin');
  });

  it('keeps an unknown message of a function a plain error, so only the fixed messages become rules', async () => {
    const repository = failing(400, { code: 'P0001', message: 'webapp_conflict:something_new', details: null, hint: null });
    await expect(repository.claimAnalysis({ org_id: 'o', scan_id: 'sc_x', assessment_id: null, claimed_by: 'u', claimed_at: 'now' }))
      .rejects.toThrow('Unable to claim analysis');
  });
});

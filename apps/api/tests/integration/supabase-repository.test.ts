import { describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { SupabaseRepository } from '../../src/repositories/supabase.js';

describe('Supabase Data API adapter', () => {
  function setup(handler: (url: URL, init?: RequestInit) => Response) {
    const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => handler(new URL(String(input)), init));
    const client = createClient('https://fixture.supabase.co', 'sb_secret_fixture', {
      auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: request },
    });
    return { repository: new SupabaseRepository(client), request };
  }
  it('queries original completed and partial evidence within the domain cache TTL', async () => {
    const { repository } = setup(url => {
      expect(url.pathname).toBe('/rest/v1/scans');
      expect(Object.fromEntries(url.searchParams)).toMatchObject({ canonical_domain: 'eq.firm.com', cached: 'eq.false',
        status: 'in.(COMPLETED,PARTIAL)', completed_at: 'gte.2026-09-07T00:00:00.000Z',
        'result->meta->>contractVersion': 'eq.layer1-2026-09-12-v2', order: 'completed_at.desc', limit: '1' });
      return Response.json([]);
    });
    expect(await repository.cached('firm.com', '2026-09-07T00:00:00.000Z')).toBeNull();
  });
  it('joins raw evidence to its canonical domain through PostgREST', async () => {
    const { repository } = setup(url => {
      expect(url.pathname).toBe('/rest/v1/scan_raw_data');
      expect(url.searchParams.get('select')).toBe('*,scans!inner(canonical_domain)');
      expect(url.searchParams.get('scans.canonical_domain')).toBe('eq.firm.com');
      expect(url.searchParams.get('source')).toBe('eq.website');
      return Response.json([]);
    });
    expect(await repository.latestRaw('firm.com', 'website')).toBeNull();
  });
  it('preserves unknown JSON values in evidence writes', async () => {
    const raw = { scan_id: 'sc_test', source: 'bar' as const, raw_content: '{"discipline":null}', content_hash: 'a'.repeat(64), fetched_at: '2026-09-08T00:00:00.000Z' };
    const { repository } = setup((_url, init) => {
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual(raw);
      return new Response(null, { status: 201 });
    });
    await repository.saveRaw(raw);
  });
  it('distinguishes database errors from an absent record', async () => {
    const { repository } = setup(() => Response.json({ code: '42501', message: 'permission denied' }, { status: 403 }));
    await expect(repository.get('sc_test')).rejects.toThrow('Unable to read scan');
    await expect(repository.cached('firm.com', '2026-09-07T00:00:00.000Z')).rejects.toThrow('Unable to read cache');
  });
  it('does not silently complete a nonexistent scan', async () => {
    const { repository } = setup(() => Response.json({ code: 'PGRST116', message: 'No rows' }, { status: 406 }));
    await expect(repository.complete('sc_missing', { status: 'FAILED', result: null, completed_at: '2026-09-08T00:00:00.000Z', duration_ms: 1 })).rejects.toThrow('Unable to complete scan');
  });
  it('books the provisional cost on the atomic reservation and sends no spend ceiling', async () => {
    const { repository } = setup((url, init) => {
      expect(url.pathname).toBe('/rest/v1/rpc/reserve_apify_run');
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({ p_scan_id: 'sc_test',
        p_query_fingerprint: 'a'.repeat(64), p_actor: 'owner/actor', p_build: '1.2.3',
        p_expected_cost_usd: 1 });
      // Spend is recorded, not capped: no budget scope may reach the database.
      expect(body).not.toHaveProperty('p_max_scan_cost_usd');
      expect(body).not.toHaveProperty('p_max_daily_cost_usd');
      return Response.json({ decision: 'start', record: null, chargedToScan: true });
    });
    await expect(repository.reserveApifyRun({ scanId: 'sc_test', queryFingerprint: 'a'.repeat(64),
      actor: 'owner/actor', build: '1.2.3', input: { name: 'Jane' }, expectedCostUsd: 1,
      expiresAt: '2026-09-14T23:00:00.000Z' }))
      .resolves.toEqual({ decision: 'start', record: null, chargedToScan: true });
  });
});

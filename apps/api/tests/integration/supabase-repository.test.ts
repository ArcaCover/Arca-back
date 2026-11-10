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
  it('lets the database search raw evidence for a marker and returns ids, never the content', async () => {
    const marker = `wsk1-${'ab12'.repeat(16)}`;
    const { repository, request } = setup(url => {
      expect(url.pathname).toBe('/rest/v1/scan_raw_data');
      const select = url.searchParams.get('select')!;
      expect(select.replaceAll(' ', '')).toBe('scan_id,source,content_hash,fetched_at,scans!inner(canonical_domain)');
      expect(select).not.toContain('raw_content');
      expect(Object.fromEntries(url.searchParams)).toMatchObject({ 'scans.canonical_domain': 'eq.firm.com', source: 'eq.website',
        fetched_at: 'gte.2026-10-10T00:00:00.000Z', raw_content: `like.%${marker}%`, order: 'fetched_at.desc', limit: '3' });
      return Response.json([{ scan_id: 'sc_new', source: 'website', content_hash: 'a'.repeat(64),
        fetched_at: '2026-11-08T00:00:00.000Z', scans: { canonical_domain: 'firm.com' } }]);
    });
    expect(await repository.findRaw('firm.com', 'website', marker, '2026-10-10T00:00:00.000Z', 3)).toEqual([
      { scan_id: 'sc_new', source: 'website', content_hash: 'a'.repeat(64), fetched_at: '2026-11-08T00:00:00.000Z' }]);
    // A marker is a plain token: anything a LIKE pattern or a query string could read as syntax never reaches the database.
    for (const unsafe of ['wsk1-%', 'wsk1_abcdef', 'wsk1-abc,def', 'WSK1-ABCDEF', 'short']) {
      await expect(repository.findRaw('firm.com', 'website', unsafe, '2026-10-10T00:00:00.000Z', 3)).rejects.toThrow('Invalid raw evidence marker');
    }
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('reads the one raw record of a scan and reports a storage error instead of an absent record', async () => {
    const record = { scan_id: 'sc_new', source: 'website' as const, raw_content: '{"analysis":null}', content_hash: 'a'.repeat(64),
      fetched_at: '2026-11-08T00:00:00.000Z' };
    const found = setup(url => {
      expect(url.pathname).toBe('/rest/v1/scan_raw_data');
      expect(Object.fromEntries(url.searchParams)).toMatchObject({ scan_id: 'eq.sc_new', source: 'eq.website',
        order: 'fetched_at.desc', limit: '1' });
      return Response.json([record]);
    });
    expect(await found.repository.rawOf('sc_new', 'website')).toEqual(record);
    const failing = setup(() => Response.json({ code: '57014', message: 'canceling statement due to statement timeout' }, { status: 500 }));
    await expect(failing.repository.rawOf('sc_new', 'website')).rejects.toThrow('Unable to read evidence');
    await expect(failing.repository.findRaw('firm.com', 'website', 'wsk1-abcdef', '2026-10-10T00:00:00.000Z', 3))
      .rejects.toThrow('Unable to search evidence');
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
  it('reads the recent ledger rows for the spend ceiling without their datasets', async () => {
    const row = { id: 'ledger-1', run_id: 'run-1', status: 'SUCCEEDED', cost_usd: 0.045, reserved_usd: 1, accounting_complete: true,
      created_at: '2026-11-09T11:00:00+00:00', expires_at: '2026-11-16T11:00:00+00:00' };
    const { repository } = setup(url => {
      expect(url.pathname).toBe('/rest/v1/apify_runs');
      const select = url.searchParams.get('select')!;
      expect(select.split(',').sort()).toEqual(['accounting_complete', 'cost_usd', 'created_at', 'expires_at', 'id', 'reserved_usd', 'run_id', 'status']);
      // `items` and `input_json` hold whole datasets and queries: the sum needs neither.
      expect(select).not.toContain('items');
      // Refused starts count nothing and are left out, so refusals cannot fill the rows read.
      expect(Object.fromEntries(url.searchParams)).toMatchObject({ created_at: 'gte.2026-11-08T12:00:00.000Z',
        status: 'neq.SPEND_CEILING_REACHED', order: 'created_at.desc', limit: '1000' });
      return Response.json([row]);
    });
    expect(await repository.recentApifyRuns('2026-11-08T12:00:00.000Z', 1000)).toEqual([row]);
    const failing = setup(() => Response.json({ code: '57014', message: 'canceling statement due to statement timeout' }, { status: 500 }));
    await expect(failing.repository.recentApifyRuns('2026-11-08T12:00:00.000Z', 1000)).rejects.toThrow('Unable to read recent Apify runs');
  });
});

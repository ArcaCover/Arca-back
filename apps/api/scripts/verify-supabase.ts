import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { loadEnv } from '../src/config/env.js';
import { SupabaseRepository } from '../src/repositories/supabase.js';
import { InProcessPipeline } from '../src/pipeline/in-process-pipeline.js';
import { mockSources } from '../src/pipeline/mock-sources.js';
import type { ScanRecord } from '../src/repositories/types.js';

// Explicit integration check: writes two synthetic scans and deletes only those UUIDs afterward.
// No migrations, schema resets, external sources or recovery of unrelated scans are performed.
const envPath = fileURLToPath(new URL('../../../.env.local', import.meta.url));
if (existsSync(envPath)) loadEnvFile(envPath);
async function verify() {
  const env = loadEnv();
  assert.equal(env.storageBackend, 'supabase', 'Set STORAGE_BACKEND=supabase for this check');
  assert.equal(env.sourceMode, 'mock', 'Set SOURCE_MODE=mock for this check');
  const client = createClient(env.SUPABASE_URL!, env.supabaseKey!, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(5000) }) },
  });
  const repository = new SupabaseRepository(client);
  const ids = [`sc_${randomUUID().replaceAll('-', '')}`, `sc_${randomUUID().replaceAll('-', '')}`];
  const started = new Date().toISOString();
  const canonicalDomain = 'robust.arca.example';
  const makeScan = (scanId: string): ScanRecord => ({ id: randomUUID(), scan_id: scanId,
    email: 'supabase-verification@arca.example', canonical_domain: canonicalDomain,
    domain_resolution: { status: 'RESOLVED', canonicalDomain, source: 'request', reason: null },
    status: 'RUNNING', result: null, created_at: started, completed_at: null, duration_ms: null, cached: false });
  try {
    await repository.create(makeScan(ids[0]!));
    const outcome = await new InProcessPipeline({ ...mockSources(), repository }).run({ scanId: ids[0]!, canonicalDomain,
      email: 'supabase-verification@arca.example' });
    assert.equal(outcome.status, 'COMPLETED');
    assert.equal(outcome.result.preScore.total, 82);
    await repository.complete(ids[0]!, { status: outcome.status, result: outcome.result,
      completed_at: outcome.result.meta.completedAt, duration_ms: outcome.result.meta.scanDurationMs });
    assert.deepEqual((await repository.get(ids[0]!))?.result, outcome.result);
    const raw = await client.from('scan_raw_data').select('source,content_hash').eq('scan_id', ids[0]!);
    assert.ifError(raw.error);
    assert.deepEqual(raw.data?.map(row => row.source).sort(), ['avvo', 'bar', 'website']);
    assert(raw.data?.every(row => /^[a-f0-9]{64}$/.test(row.content_hash)));
    assert(await repository.latestRaw(canonicalDomain, 'website'));
    const cached = await repository.cached(canonicalDomain, started);
    assert.equal(cached?.result?.preScore.total, 82);
    await repository.create({ ...makeScan(ids[1]!), status: 'COMPLETED', cached: true,
      result: { ...outcome.result, meta: { ...outcome.result.meta, cached: true } },
      completed_at: new Date().toISOString(), duration_ms: 0 });
    assert.notEqual((await repository.cached(canonicalDomain, started))?.scan_id, ids[1]);
    console.log('Supabase verified: persisted mock score 82, three raw sources, domain cache and JSON round-trip.');
  } finally {
    const cleanup = await client.from('scans').delete().in('scan_id', ids);
    if (cleanup.error) throw new Error(`Verification cleanup failed; remove only scans ${ids.join(', ')}`);
    const remaining = await client.from('scan_raw_data').select('scan_id').in('scan_id', ids);
    assert.ifError(remaining.error);
    assert.equal(remaining.data?.length, 0, 'Raw evidence must cascade with verification scans');
    console.log('Synthetic verification records removed.');
  }
}
verify().catch(error => {
  console.error('Supabase verification failed:', error instanceof Error ? error.message : 'Unknown error');
  process.exitCode = 1;
});

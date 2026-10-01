import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/config/env.js';

const base = { SESSION_TOKEN_SECRET: 's'.repeat(40), CORS_ALLOWED_ORIGINS: 'http://localhost:3000' };
const database = { SUPABASE_URL: 'https://fixture.supabase.co', SUPABASE_SECRET_KEY: 'sb_secret_fixture' };
describe('independent source and storage configuration', () => {
  it('runs mock sources with Supabase without paid provider credentials', () => {
    expect(loadEnv({ ...base, ...database, SOURCE_MODE: 'mock', STORAGE_BACKEND: 'supabase' })).toMatchObject({ sourceMode: 'mock', storageBackend: 'supabase', supabaseKey: database.SUPABASE_SECRET_KEY });
  });
  it('runs local mocks without any external credentials', () => {
    expect(loadEnv({ ...base, SOURCE_MODE: 'mock', STORAGE_BACKEND: 'memory' })).toMatchObject({ sourceMode: 'mock', storageBackend: 'memory' });
  });
  it('preserves legacy configuration and lets explicit modes override its defaults', () => {
    expect(loadEnv({ ...base, MOCK_MODE: 'true' })).toMatchObject({ sourceMode: 'mock', storageBackend: 'memory' });
    expect(loadEnv({ ...base, ...database, MOCK_MODE: 'true', STORAGE_BACKEND: 'supabase' }).storageBackend).toBe('supabase');
  });
  it('accepts an existing service role key and prefers the new secret when both are supplied', () => {
    expect(loadEnv({ ...base, SOURCE_MODE: 'mock', STORAGE_BACKEND: 'supabase', SUPABASE_URL: database.SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: 'legacy-key' }).supabaseKey).toBe('legacy-key');
    expect(loadEnv({ ...base, ...database, SOURCE_MODE: 'mock', STORAGE_BACKEND: 'supabase', SUPABASE_SERVICE_ROLE_KEY: 'legacy-key' }).supabaseKey).toBe(database.SUPABASE_SECRET_KEY);
  });
  it('requires credentials for the selected storage and rejects publishable keys', () => {
    expect(() => loadEnv({ ...base, SOURCE_MODE: 'mock', STORAGE_BACKEND: 'supabase' })).toThrow('SUPABASE_URL');
    expect(() => loadEnv({ ...base, SOURCE_MODE: 'mock', STORAGE_BACKEND: 'supabase', SUPABASE_URL: database.SUPABASE_URL })).toThrow('SUPABASE_SECRET_KEY');
    expect(() => loadEnv({ ...base, ...database, SOURCE_MODE: 'mock', STORAGE_BACKEND: 'supabase', SUPABASE_SECRET_KEY: 'sb_publishable_fixture' })).toThrow('server secret');
  });
  it('defaults live extraction to the agentic OpenAI extraction and validates credentials for the selected provider', () => {
    expect(loadEnv({ ...base, SOURCE_MODE: 'live', STORAGE_BACKEND: 'memory', APIFY_API_TOKEN: 'test',
      OPENAI_API_KEY: 'sk-test' })).toMatchObject({ WEBSITE_EVIDENCE_PROVIDER: 'agentic', SIGNAL_LLM_MODEL: 'gpt-6-luna' });
    expect(() => loadEnv({ ...base, SOURCE_MODE: 'live', STORAGE_BACKEND: 'memory' })).toThrow('APIFY_API_TOKEN');
    expect(() => loadEnv({ ...base, SOURCE_MODE: 'live', STORAGE_BACKEND: 'memory', APIFY_API_TOKEN: 'test' }))
      .toThrow('OPENAI_API_KEY');
    expect(loadEnv({ ...base, SOURCE_MODE: 'live', STORAGE_BACKEND: 'memory', APIFY_API_TOKEN: 'test',
      WEBSITE_EVIDENCE_PROVIDER: 'rules' })).toMatchObject({ WEBSITE_EVIDENCE_PROVIDER: 'rules' });
    expect(() => loadEnv({ ...base, SOURCE_MODE: 'live', STORAGE_BACKEND: 'memory', APIFY_API_TOKEN: 'test',
      WEBSITE_EVIDENCE_PROVIDER: 'openai' })).toThrow('OPENAI_API_KEY');
  });
  it('runs the agentic extraction on the configured OpenAI model, and knows no NVIDIA provider', () => {
    const live = { ...base, SOURCE_MODE: 'live', STORAGE_BACKEND: 'memory', APIFY_API_TOKEN: 'test', OPENAI_API_KEY: 'sk-test' };
    expect(loadEnv({ ...live, SIGNAL_LLM_MODEL: ' gpt-5.6-luna ' }).SIGNAL_LLM_MODEL).toBe('gpt-5.6-luna');
    expect(loadEnv({ ...live, SIGNAL_LLM_MODEL: '' }).SIGNAL_LLM_MODEL).toBe('gpt-6-luna');
    expect(() => loadEnv({ ...live, WEBSITE_EVIDENCE_PROVIDER: 'nvidia' })).toThrow();
  });
  it('accepts only known reasoning efforts for the agentic extraction', () => {
    const openai = { ...base, SOURCE_MODE: 'live', STORAGE_BACKEND: 'memory', APIFY_API_TOKEN: 'test',
      OPENAI_API_KEY: 'sk-test', SIGNAL_LLM_MODEL: 'gpt-5-mini' };
    expect(loadEnv({ ...openai, SIGNAL_LLM_REASONING_EFFORT: 'low' })).toMatchObject({ SIGNAL_LLM_REASONING_EFFORT: 'low' });
    expect(loadEnv(openai).SIGNAL_LLM_REASONING_EFFORT).toBeUndefined();
    expect(() => loadEnv({ ...openai, SIGNAL_LLM_REASONING_EFFORT: 'extreme' })).toThrow();
  });
  it('records Apify spend without capping it and keeps both caches on the same window', () => {
    expect(loadEnv({ ...base, SOURCE_MODE: 'mock', STORAGE_BACKEND: 'memory' })).toMatchObject({
      APIFY_EXPECTED_COST_USD_PER_RUN: 1,
      APIFY_RUN_TIMEOUT_SECS: 300, APIFY_ACTIVE_RUN_TTL_MS: 900000,
      APIFY_BAR_TARGETED_MAX_RESULTS: 25, APIFY_AVVO_TARGETED_MAX_RESULTS: 10,
      APIFY_MAX_CACHED_ITEMS: 1000,
      // Repairing a partial scan must not re-pay directory runs, so the query cache cannot
      // expire before the scan cache does.
      SCAN_CACHE_TTL_MS: 604_800_000, APIFY_QUERY_CACHE_TTL_MS: 604_800_000,
    });
    // There is no per-scan or per-day ceiling left to order: any positive estimate loads.
    expect(loadEnv({ ...base, SOURCE_MODE: 'mock', STORAGE_BACKEND: 'memory',
      APIFY_EXPECTED_COST_USD_PER_RUN: '3' })).toMatchObject({ APIFY_EXPECTED_COST_USD_PER_RUN: 3 });
    expect(() => loadEnv({ ...base, SOURCE_MODE: 'mock', STORAGE_BACKEND: 'memory',
      APIFY_RUN_TIMEOUT_SECS: '600', APIFY_ACTIVE_RUN_TTL_MS: '600000' })).toThrow('must exceed');
  });
  it('runs sixteen Apify actors at once by default and allows up to the account limit of 32', () => {
    const mock = { ...base, SOURCE_MODE: 'mock', STORAGE_BACKEND: 'memory' };
    expect(loadEnv(mock).MAX_APIFY_CONCURRENCY).toBe(16);
    expect(loadEnv({ ...mock, MAX_APIFY_CONCURRENCY: '32' }).MAX_APIFY_CONCURRENCY).toBe(32);
    expect(() => loadEnv({ ...mock, MAX_APIFY_CONCURRENCY: '33' })).toThrow();
  });
  it('repairs a partial scan at most hourly by default, never less often than the cache window', () => {
    const mock = { ...base, SOURCE_MODE: 'mock', STORAGE_BACKEND: 'memory' };
    expect(loadEnv(mock).SCAN_PARTIAL_REPAIR_COOLDOWN_MS).toBe(3_600_000);
    expect(loadEnv({ ...mock, SCAN_PARTIAL_REPAIR_COOLDOWN_MS: '0' }).SCAN_PARTIAL_REPAIR_COOLDOWN_MS).toBe(0);
    expect(() => loadEnv({ ...mock, SCAN_CACHE_TTL_MS: '3600000', SCAN_PARTIAL_REPAIR_COOLDOWN_MS: '7200000' }))
      .toThrow('SCAN_PARTIAL_REPAIR_COOLDOWN_MS');
  });
});

import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/config/env.js';
import { listenHostname } from '../../src/config/mode.js';

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
  it('takes the webapp base URL over http or https only, and an empty one falls back to the default', () => {
    const local = { ...base, SOURCE_MODE: 'mock', STORAGE_BACKEND: 'memory' };
    expect(loadEnv(local).APP_BASE_URL).toBe('http://localhost:3000');
    expect(loadEnv({ ...local, APP_BASE_URL: '' }).APP_BASE_URL).toBe('http://localhost:3000');
    expect(loadEnv({ ...local, APP_BASE_URL: '  ' }).APP_BASE_URL).toBe('http://localhost:3000');
    expect(loadEnv({ ...local, APP_BASE_URL: 'https://app.arca.example' }).APP_BASE_URL).toBe('https://app.arca.example');
    for (const url of ['javascript:alert(1)', 'ftp://app.arca.example', 'file:///etc/passwd', 'not a url']) {
      expect(() => loadEnv({ ...local, APP_BASE_URL: url }), url).toThrow('APP_BASE_URL');
    }
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
describe('ARCA_MODE', () => {
  const liveKeys = { APIFY_API_TOKEN: 'test', OPENAI_API_KEY: 'sk-test' };
  it('defaults to production when ARCA_MODE is absent', () => {
    expect(loadEnv({ ...base, SOURCE_MODE: 'mock', STORAGE_BACKEND: 'memory' })).toMatchObject({ mode: 'production', overridden: [] });
  });
  it('rejects an unknown mode, listing the valid ones', () => {
    const env = { ...base, SOURCE_MODE: 'mock', STORAGE_BACKEND: 'memory' };
    for (const mode of ['Mock', 'debug', 'live', '']) {
      const start = () => loadEnv({ ...env, ARCA_MODE: mode });
      expect(start).toThrow(/production/);
      expect(start).toThrow(/live-debug/);
      expect(start).toThrow(/mock/);
    }
  });
  it('mock forces mock sources, memory storage and rules planning over live settings', () => {
    const result = loadEnv({ ...base, ...database, ARCA_MODE: 'mock', SOURCE_MODE: 'live', STORAGE_BACKEND: 'supabase', ASSESSMENT_PLANNER: 'agent' });
    expect(result).toMatchObject({ mode: 'mock', sourceMode: 'mock', storageBackend: 'memory', ASSESSMENT_PLANNER: 'rules' });
    expect(result.overridden).toEqual(['SOURCE_MODE=live→mock', 'STORAGE_BACKEND=supabase→memory', 'ASSESSMENT_PLANNER=agent→rules']);
  });
  it('mock overrides the legacy MOCK_MODE defaults too, and reports only what it actually changed', () => {
    expect(loadEnv({ ...base, ARCA_MODE: 'mock' }).overridden).toEqual(['SOURCE_MODE=live→mock', 'STORAGE_BACKEND=supabase→memory']);
    expect(loadEnv({ ...base, ARCA_MODE: 'mock', SOURCE_MODE: 'mock', STORAGE_BACKEND: 'memory' }).overridden).toEqual([]);
    expect(loadEnv({ ...base, ARCA_MODE: 'mock', MOCK_MODE: 'true' })).toMatchObject({ mode: 'mock', overridden: [] });
  });
  it('live-debug never forces: it requires live sources and Supabase', () => {
    expect(() => loadEnv({ ...base, ARCA_MODE: 'live-debug', SOURCE_MODE: 'mock' })).toThrow(/live-debug requires SOURCE_MODE=live/);
    expect(() => loadEnv({ ...base, ARCA_MODE: 'live-debug', MOCK_MODE: 'true' })).toThrow(/live-debug requires SOURCE_MODE=live/);
    expect(() => loadEnv({ ...base, ARCA_MODE: 'live-debug', STORAGE_BACKEND: 'memory' })).toThrow(/live-debug requires STORAGE_BACKEND=supabase/);
    expect(loadEnv({ ...base, ...database, ...liveKeys, ARCA_MODE: 'live-debug', SOURCE_MODE: 'live', STORAGE_BACKEND: 'supabase' }))
      .toMatchObject({ mode: 'live-debug', sourceMode: 'live', storageBackend: 'supabase', overridden: [] });
  });
  it('live-debug keeps the credential checks of production', () => {
    const debug = { ...base, ...database, ARCA_MODE: 'live-debug', SOURCE_MODE: 'live', STORAGE_BACKEND: 'supabase' };
    expect(() => loadEnv(debug)).toThrow('APIFY_API_TOKEN');
    expect(() => loadEnv({ ...debug, APIFY_API_TOKEN: 'test' })).toThrow('OPENAI_API_KEY');
  });
  it('refuses any debug mode inside a deployment', () => {
    expect(() => loadEnv({ ...base, ARCA_MODE: 'mock', ARCA_DEPLOYMENT: 'aws' })).toThrow(/ARCA_DEPLOYMENT/);
    expect(() => loadEnv({ ...base, ...database, ...liveKeys, ARCA_MODE: 'live-debug', ARCA_DEPLOYMENT: 'aws' })).toThrow(/ARCA_DEPLOYMENT/);
    expect(loadEnv({ ...base, SOURCE_MODE: 'mock', STORAGE_BACKEND: 'memory', ARCA_DEPLOYMENT: 'aws' })).toMatchObject({ mode: 'production' });
    expect(loadEnv({ ...base, ...database, ...liveKeys, ARCA_MODE: 'production', ARCA_DEPLOYMENT: 'aws' })).toMatchObject({ mode: 'production' });
  });
  it('listens on loopback only in debug modes', () => {
    expect(listenHostname('mock')).toBe('127.0.0.1');
    expect(listenHostname('live-debug')).toBe('127.0.0.1');
    expect(listenHostname('production')).toBeUndefined();
  });
});

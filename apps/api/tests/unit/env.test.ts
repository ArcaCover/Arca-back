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
  it('defaults live extraction to NVIDIA and validates credentials for the selected provider', () => {
    expect(loadEnv({ ...base, SOURCE_MODE: 'live', STORAGE_BACKEND: 'memory', APIFY_API_TOKEN: 'test',
      NVIDIA_NIM_API_KEY: 'nim-test' })).toMatchObject({ WEBSITE_EVIDENCE_PROVIDER: 'nvidia' });
    expect(() => loadEnv({ ...base, SOURCE_MODE: 'live', STORAGE_BACKEND: 'memory' })).toThrow('APIFY_API_TOKEN');
    expect(() => loadEnv({ ...base, SOURCE_MODE: 'live', STORAGE_BACKEND: 'memory', APIFY_API_TOKEN: 'test' }))
      .toThrow('NVIDIA_NIM_API_KEY');
    expect(loadEnv({ ...base, SOURCE_MODE: 'live', STORAGE_BACKEND: 'memory', APIFY_API_TOKEN: 'test',
      WEBSITE_EVIDENCE_PROVIDER: 'rules' })).toMatchObject({ WEBSITE_EVIDENCE_PROVIDER: 'rules' });
    expect(() => loadEnv({ ...base, SOURCE_MODE: 'live', STORAGE_BACKEND: 'memory', APIFY_API_TOKEN: 'test',
      WEBSITE_EVIDENCE_PROVIDER: 'openai' })).toThrow('OPENAI_API_KEY');
  });
  it('lets the agentic extraction run on OpenAI with its own key and model', () => {
    const live = { ...base, SOURCE_MODE: 'live', STORAGE_BACKEND: 'memory', APIFY_API_TOKEN: 'test' };
    expect(() => loadEnv({ ...live, SIGNAL_LLM_ENDPOINT: 'openai', NVIDIA_NIM_API_KEY: 'nim-test' })).toThrow('OPENAI_API_KEY');
    expect(() => loadEnv({ ...live, SIGNAL_LLM_ENDPOINT: 'openai', OPENAI_API_KEY: 'sk-test' })).toThrow('SIGNAL_LLM_MODEL');
    expect(loadEnv({ ...live, SIGNAL_LLM_ENDPOINT: 'openai', OPENAI_API_KEY: 'sk-test', SIGNAL_LLM_MODEL: ' gpt-5.6-luna ' }))
      .toMatchObject({ SIGNAL_LLM_ENDPOINT: 'openai', signalModel: 'gpt-5.6-luna' });
    expect(loadEnv({ ...live, NVIDIA_NIM_API_KEY: 'nim-test', NVIDIA_NIM_MODEL: 'z-ai/glm-5.3-flash' }))
      .toMatchObject({ SIGNAL_LLM_ENDPOINT: 'nvidia', signalModel: 'z-ai/glm-5.3-flash' });
  });
  it('accepts only known reasoning efforts for the agentic extraction', () => {
    const openai = { ...base, SOURCE_MODE: 'live', STORAGE_BACKEND: 'memory', APIFY_API_TOKEN: 'test', SIGNAL_LLM_ENDPOINT: 'openai',
      OPENAI_API_KEY: 'sk-test', SIGNAL_LLM_MODEL: 'gpt-5-mini' };
    expect(loadEnv({ ...openai, SIGNAL_LLM_REASONING_EFFORT: 'low' })).toMatchObject({ SIGNAL_LLM_REASONING_EFFORT: 'low' });
    expect(loadEnv(openai).SIGNAL_LLM_REASONING_EFFORT).toBeUndefined();
    expect(() => loadEnv({ ...openai, SIGNAL_LLM_REASONING_EFFORT: 'extreme' })).toThrow();
  });
  it('validates nested Apify budgets and a recovery window longer than the remote timeout', () => {
    expect(loadEnv({ ...base, SOURCE_MODE: 'mock', STORAGE_BACKEND: 'memory' })).toMatchObject({
      APIFY_MAX_COST_USD_PER_RUN: 1, APIFY_MAX_COST_USD_PER_SCAN: 10, APIFY_MAX_COST_USD_PER_DAY: 100,
      APIFY_RUN_TIMEOUT_SECS: 300, APIFY_ACTIVE_RUN_TTL_MS: 900000,
      APIFY_BAR_TARGETED_MAX_RESULTS: 25, APIFY_AVVO_TARGETED_MAX_RESULTS: 10,
      APIFY_MAX_CACHED_ITEMS: 1000,
    });
    expect(() => loadEnv({ ...base, SOURCE_MODE: 'mock', STORAGE_BACKEND: 'memory',
      APIFY_MAX_COST_USD_PER_RUN: '3', APIFY_MAX_COST_USD_PER_SCAN: '2' })).toThrow('per-run <= per-scan');
    expect(() => loadEnv({ ...base, SOURCE_MODE: 'mock', STORAGE_BACKEND: 'memory',
      APIFY_RUN_TIMEOUT_SECS: '600', APIFY_ACTIVE_RUN_TTL_MS: '600000' })).toThrow('must exceed');
  });
});

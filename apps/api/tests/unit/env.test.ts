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
});

import { describe, expect, it } from 'vitest';
import { LIVE_DEBUG_APIFY_SPEND_CEILING_USD, LIVE_DEBUG_OPENAI_MAX_REQUESTS_PER_SCAN, loadEnv } from '../../src/config/env.js';
import { listenHostname } from '../../src/config/mode.js';
import { WEBSITE_SIGNAL_REUSE_MAX_AGE_MS } from '../../src/pipeline/website-source.js';

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
      APIFY_BAR_OFFICE_SAMPLE_MAX_RESULTS: 20, APIFY_AVVO_OFFICE_SAMPLE_MAX_RESULTS: 10,
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
  it('reuses a stored website analysis for 30 days by default, and never when the age is 0', () => {
    const mock = { ...base, SOURCE_MODE: 'mock', STORAGE_BACKEND: 'memory' };
    expect(loadEnv(mock).WEBSITE_SIGNAL_REUSE_MAX_AGE_MS).toBe(WEBSITE_SIGNAL_REUSE_MAX_AGE_MS);
    expect(loadEnv({ ...mock, WEBSITE_SIGNAL_REUSE_MAX_AGE_MS: '0' }).WEBSITE_SIGNAL_REUSE_MAX_AGE_MS).toBe(0);
    expect(() => loadEnv({ ...mock, WEBSITE_SIGNAL_REUSE_MAX_AGE_MS: '-1' })).toThrow();
  });
  it('loads the values that force a fresh run of a cached firm', () => {
    // DN-12 §4.4: no header and no contract change, only the environment of one start.
    const forced = loadEnv({ ...base, SOURCE_MODE: 'mock', STORAGE_BACKEND: 'memory', SCAN_CACHE_TTL_MS: '1',
      SCAN_PARTIAL_REPAIR_COOLDOWN_MS: '0', WEBSITE_SIGNAL_REUSE_MAX_AGE_MS: '0' });
    expect(forced).toMatchObject({ SCAN_CACHE_TTL_MS: 1, SCAN_PARTIAL_REPAIR_COOLDOWN_MS: 0, WEBSITE_SIGNAL_REUSE_MAX_AGE_MS: 0 });
    // The cooldown has to go down with the window: its default alone is refused.
    expect(() => loadEnv({ ...base, SOURCE_MODE: 'mock', STORAGE_BACKEND: 'memory', SCAN_CACHE_TTL_MS: '1' }))
      .toThrow('SCAN_PARTIAL_REPAIR_COOLDOWN_MS');
  });
  it('repairs a partial scan at most hourly by default, never less often than the cache window', () => {
    const mock = { ...base, SOURCE_MODE: 'mock', STORAGE_BACKEND: 'memory' };
    expect(loadEnv(mock).SCAN_PARTIAL_REPAIR_COOLDOWN_MS).toBe(3_600_000);
    expect(loadEnv({ ...mock, SCAN_PARTIAL_REPAIR_COOLDOWN_MS: '0' }).SCAN_PARTIAL_REPAIR_COOLDOWN_MS).toBe(0);
    expect(() => loadEnv({ ...mock, SCAN_CACHE_TTL_MS: '3600000', SCAN_PARTIAL_REPAIR_COOLDOWN_MS: '7200000' }))
      .toThrow('SCAN_PARTIAL_REPAIR_COOLDOWN_MS');
  });
});
describe('spend guards', () => {
  // DN-12 §5: production records spend and caps nothing unless its environment says so; live-debug guards itself.
  const production = { ...base, SOURCE_MODE: 'live', STORAGE_BACKEND: 'memory', APIFY_API_TOKEN: 'test', OPENAI_API_KEY: 'sk-test' };
  const liveDebug = { ...base, ...database, ARCA_MODE: 'live-debug', SOURCE_MODE: 'live', STORAGE_BACKEND: 'supabase',
    APIFY_API_TOKEN: 'test', OPENAI_API_KEY: 'sk-test' };
  it('leaves production without a spend ceiling and without a request cap', () => {
    expect(loadEnv(production)).toMatchObject({ mode: 'production', apifySpendCeilingUsd: null, openAiMaxRequestsPerScan: null });
    expect(loadEnv(production).APIFY_SPEND_CEILING_USD).toBeUndefined();
    expect(loadEnv(production).OPENAI_MAX_REQUESTS_PER_SCAN).toBeUndefined();
    // Mock builds no paid client, so it has nothing to guard.
    expect(loadEnv({ ...base, ARCA_MODE: 'mock' })).toMatchObject({ apifySpendCeilingUsd: null, openAiMaxRequestsPerScan: null });
  });
  it('turns both guards on in live-debug by default', () => {
    expect(LIVE_DEBUG_APIFY_SPEND_CEILING_USD).toBe(2);
    expect(LIVE_DEBUG_OPENAI_MAX_REQUESTS_PER_SCAN).toBe(30);
    expect(loadEnv(liveDebug)).toMatchObject({ mode: 'live-debug', apifySpendCeilingUsd: 2, openAiMaxRequestsPerScan: 30 });
  });
  it('takes an explicit value in any mode', () => {
    expect(loadEnv({ ...liveDebug, APIFY_SPEND_CEILING_USD: '7.5', OPENAI_MAX_REQUESTS_PER_SCAN: '12' }))
      .toMatchObject({ apifySpendCeilingUsd: 7.5, openAiMaxRequestsPerScan: 12 });
    expect(loadEnv({ ...production, APIFY_SPEND_CEILING_USD: '50', OPENAI_MAX_REQUESTS_PER_SCAN: '40' }))
      .toMatchObject({ apifySpendCeilingUsd: 50, openAiMaxRequestsPerScan: 40 });
    // 0 is a ceiling too: no new run, cached queries only.
    expect(loadEnv({ ...liveDebug, APIFY_SPEND_CEILING_USD: '0' }).apifySpendCeilingUsd).toBe(0);
  });
  it('reads an empty value as not set, never as a ceiling of 0', () => {
    for (const blank of ['', '  ']) {
      expect(loadEnv({ ...production, APIFY_SPEND_CEILING_USD: blank, OPENAI_MAX_REQUESTS_PER_SCAN: blank }))
        .toMatchObject({ apifySpendCeilingUsd: null, openAiMaxRequestsPerScan: null });
      expect(loadEnv({ ...liveDebug, APIFY_SPEND_CEILING_USD: blank, OPENAI_MAX_REQUESTS_PER_SCAN: blank }))
        .toMatchObject({ apifySpendCeilingUsd: 2, openAiMaxRequestsPerScan: 30 });
    }
  });
  it('refuses values that are not a ceiling or a cap', () => {
    for (const value of ['-1', 'two', 'Infinity']) expect(() => loadEnv({ ...liveDebug, APIFY_SPEND_CEILING_USD: value }), value).toThrow();
    for (const value of ['0', '-3', '2.5', 'many']) expect(() => loadEnv({ ...liveDebug, OPENAI_MAX_REQUESTS_PER_SCAN: value }), value).toThrow();
    // A ceiling no run fits under would refuse everything while looking like a budget.
    expect(() => loadEnv({ ...liveDebug, APIFY_SPEND_CEILING_USD: '0.5' })).toThrow('APIFY_SPEND_CEILING_USD is below APIFY_EXPECTED_COST_USD_PER_RUN');
    expect(loadEnv({ ...liveDebug, APIFY_SPEND_CEILING_USD: '0.5', APIFY_EXPECTED_COST_USD_PER_RUN: '0.25' }).apifySpendCeilingUsd).toBe(0.5);
    expect(() => loadEnv({ ...liveDebug, APIFY_EXPECTED_COST_USD_PER_RUN: '3' })).toThrow('APIFY_SPEND_CEILING_USD');
  });
  it('reserves less for a targeted lookup than for a firm search, and every kind must fit under the ceiling', () => {
    expect(loadEnv(liveDebug)).toMatchObject({ APIFY_EXPECTED_COST_USD_PER_RUN: 1, APIFY_EXPECTED_COST_USD_PER_TARGETED_RUN: 0.1,
      APIFY_AVVO_EXPECTED_COST_USD_PER_TARGETED_RUN: 0.4 });
    expect(loadEnv({ ...liveDebug, APIFY_EXPECTED_COST_USD_PER_TARGETED_RUN: '0.05', APIFY_AVVO_EXPECTED_COST_USD_PER_TARGETED_RUN: '0.5' }))
      .toMatchObject({ APIFY_EXPECTED_COST_USD_PER_TARGETED_RUN: 0.05, APIFY_AVVO_EXPECTED_COST_USD_PER_TARGETED_RUN: 0.5 });
    for (const value of ['0', '-1', 'cheap']) {
      expect(() => loadEnv({ ...liveDebug, APIFY_EXPECTED_COST_USD_PER_TARGETED_RUN: value }), value).toThrow();
      expect(() => loadEnv({ ...liveDebug, APIFY_AVVO_EXPECTED_COST_USD_PER_TARGETED_RUN: value }), value).toThrow();
    }
    // A ceiling only targeted lookups fit under would refuse every firm search while looking like a budget, and the other way round.
    expect(() => loadEnv({ ...liveDebug, APIFY_SPEND_CEILING_USD: '0.3', APIFY_EXPECTED_COST_USD_PER_RUN: '0.25' }))
      .toThrow('APIFY_SPEND_CEILING_USD is below APIFY_AVVO_EXPECTED_COST_USD_PER_TARGETED_RUN');
    expect(() => loadEnv({ ...liveDebug, APIFY_SPEND_CEILING_USD: '0.3', APIFY_EXPECTED_COST_USD_PER_RUN: '0.25',
      APIFY_AVVO_EXPECTED_COST_USD_PER_TARGETED_RUN: '0.2', APIFY_EXPECTED_COST_USD_PER_TARGETED_RUN: '0.5' }))
      .toThrow('APIFY_SPEND_CEILING_USD is below APIFY_EXPECTED_COST_USD_PER_TARGETED_RUN');
    expect(loadEnv({ ...liveDebug, APIFY_SPEND_CEILING_USD: '0.3', APIFY_EXPECTED_COST_USD_PER_RUN: '0.25',
      APIFY_AVVO_EXPECTED_COST_USD_PER_TARGETED_RUN: '0.3' }).apifySpendCeilingUsd).toBe(0.3);
    // 0 still means cached queries only, whatever each kind reserves.
    expect(loadEnv({ ...liveDebug, APIFY_SPEND_CEILING_USD: '0' }).apifySpendCeilingUsd).toBe(0);
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
describe('webapp providers (DN-13 §7.1)', () => {
  const liveKeys = { APIFY_API_TOKEN: 'test', OPENAI_API_KEY: 'sk-test' };
  const production = { ...base, ...database, ...liveKeys, SOURCE_MODE: 'live', STORAGE_BACKEND: 'supabase' };
  const liveDebug = { ...production, ARCA_MODE: 'live-debug' };
  const stripeTest = { STRIPE_SECRET_KEY: 'rk_test_fixture', STRIPE_WEBHOOK_SECRET: 'whsec_fixture' };
  const stripeLive = { STRIPE_SECRET_KEY: 'rk_live_fixture', STRIPE_WEBHOOK_SECRET: 'whsec_fixture' };
  const launch: Record<string, string> = { ...production, ...stripeLive, WEBAPP_ENABLED: 'true', APP_BASE_URL: 'https://arcacover.com',
    EMAIL_PROVIDER: 'ses', EMAIL_FROM: 'ARCA <no-reply@arcacover.com>' };
  const without = (name: string) => { const env = { ...launch }; delete env[name]; return env; };

  it('keeps production without a webapp unless WEBAPP_ENABLED=true, whatever else is set', () => {
    expect(loadEnv(production)).toMatchObject({ webapp: 'none', stripeMode: null });
    expect(loadEnv({ ...production, WEBAPP_ENABLED: 'false' }).webapp).toBe('none');
    expect(loadEnv({ ...production, WEBAPP_ENABLED: '' }).webapp).toBe('none');
    // Keys that sit in the environment do not switch it on.
    expect(loadEnv({ ...production, ...stripeLive, EMAIL_PROVIDER: 'ses' }).webapp).toBe('none');
    expect(() => loadEnv({ ...production, WEBAPP_ENABLED: 'yes' })).toThrow();
  });

  it('runs the debug modes on the simulated webapp by default', () => {
    expect(loadEnv({ ...base, ARCA_MODE: 'mock' })).toMatchObject({ webapp: 'simulated', stripeMode: null, emailProvider: 'memory' });
    expect(loadEnv(liveDebug)).toMatchObject({ webapp: 'simulated', stripeMode: null, emailProvider: 'memory' });
    expect(loadEnv({ ...liveDebug, WEBAPP_PROVIDERS: 'simulated' }).webapp).toBe('simulated');
    expect(() => loadEnv({ ...liveDebug, WEBAPP_PROVIDERS: 'stripe' })).toThrow();
  });

  it('switches production on with every real piece configured', () => {
    expect(loadEnv(launch)).toMatchObject({ webapp: 'real', stripeMode: 'live', emailProvider: 'ses',
      emailFrom: 'ARCA <no-reply@arcacover.com>' });
    // SES is what production sends with when nothing else is said.
    expect(loadEnv(without('EMAIL_PROVIDER')).emailProvider).toBe('ses');
  });

  it('refuses to switch production on without a real piece', () => {
    expect(() => loadEnv(without('STRIPE_SECRET_KEY'))).toThrow('STRIPE_SECRET_KEY');
    expect(() => loadEnv(without('STRIPE_WEBHOOK_SECRET'))).toThrow('STRIPE_WEBHOOK_SECRET');
    expect(() => loadEnv(without('EMAIL_FROM'))).toThrow('EMAIL_FROM');
    // The default APP_BASE_URL is the local front: invitation links and Stripe return URLs would point at localhost.
    expect(() => loadEnv(without('APP_BASE_URL'))).toThrow('APP_BASE_URL');
    expect(() => loadEnv({ ...launch, APP_BASE_URL: 'http://arcacover.com' })).toThrow('APP_BASE_URL');
    // Invitations kept in memory would vanish: production never sends to it.
    expect(() => loadEnv({ ...launch, EMAIL_PROVIDER: 'memory' })).toThrow('EMAIL_PROVIDER');
    // The webapp's data lives in Supabase, next to the scans it claims.
    expect(() => loadEnv({ ...launch, STORAGE_BACKEND: 'memory' })).toThrow('STORAGE_BACKEND=supabase');
    expect(() => loadEnv({ ...launch, SUPABASE_SECRET_KEY: 'sb_publishable_fixture' })).toThrow('server secret');
  });

  it('never runs the simulated providers in production, and leaves WEBAPP_PROVIDERS to live-debug', () => {
    expect(() => loadEnv({ ...production, WEBAPP_PROVIDERS: 'simulated' })).toThrow('WEBAPP_PROVIDERS');
    expect(() => loadEnv({ ...launch, WEBAPP_PROVIDERS: 'simulated' })).toThrow('WEBAPP_PROVIDERS');
    expect(() => loadEnv({ ...production, WEBAPP_PROVIDERS: 'real' })).toThrow('WEBAPP_ENABLED');
  });

  it('refuses a Stripe test key in production unless STRIPE_ALLOW_TEST_MODE=true', () => {
    expect(() => loadEnv({ ...launch, ...stripeTest })).toThrow('STRIPE_ALLOW_TEST_MODE');
    expect(() => loadEnv({ ...launch, STRIPE_SECRET_KEY: 'sk_test_fixture' })).toThrow('STRIPE_ALLOW_TEST_MODE');
    expect(loadEnv({ ...launch, ...stripeTest, STRIPE_ALLOW_TEST_MODE: 'true' })).toMatchObject({ webapp: 'real', stripeMode: 'test' });
    expect(loadEnv({ ...launch, STRIPE_SECRET_KEY: 'sk_live_fixture' }).stripeMode).toBe('live');
  });

  it('runs live-debug on the real providers with a Stripe test key only', () => {
    expect(loadEnv({ ...liveDebug, ...stripeTest, WEBAPP_PROVIDERS: 'real' }))
      .toMatchObject({ webapp: 'real', stripeMode: 'test', emailProvider: 'memory', emailFrom: 'ARCA <no-reply@arcacover.com>' });
    expect(loadEnv({ ...liveDebug, ...stripeTest, WEBAPP_PROVIDERS: 'real', EMAIL_PROVIDER: 'ses' }).emailProvider).toBe('ses');
    expect(() => loadEnv({ ...liveDebug, WEBAPP_PROVIDERS: 'real' })).toThrow('STRIPE_SECRET_KEY');
    expect(() => loadEnv({ ...liveDebug, ...stripeTest, WEBAPP_PROVIDERS: 'real', STRIPE_WEBHOOK_SECRET: '' })).toThrow('STRIPE_WEBHOOK_SECRET');
    // A live key never loads outside production, flag or no flag.
    for (const flag of ['false', 'true']) {
      expect(() => loadEnv({ ...liveDebug, ...stripeLive, WEBAPP_PROVIDERS: 'real', STRIPE_ALLOW_TEST_MODE: flag })).toThrow('live Stripe key');
    }
  });

  it('refuses a live Stripe key in any debug mode, even one that never calls Stripe', () => {
    expect(() => loadEnv({ ...liveDebug, STRIPE_SECRET_KEY: 'sk_live_fixture' })).toThrow('live Stripe key');
    expect(() => loadEnv({ ...base, ARCA_MODE: 'mock', STRIPE_SECRET_KEY: 'rk_live_fixture' })).toThrow('live Stripe key');
    expect(loadEnv({ ...base, ARCA_MODE: 'mock', ...stripeTest }).webapp).toBe('simulated');
  });

  it('refuses what is not a Stripe secret or restricted key, or a webhook secret', () => {
    for (const key of ['pk_live_fixture', 'pk_test_fixture', 'sk_fixture', 'whsec_fixture', 'secret']) {
      expect(() => loadEnv({ ...launch, STRIPE_SECRET_KEY: key }), key).toThrow('STRIPE_SECRET_KEY');
    }
    expect(() => loadEnv({ ...launch, STRIPE_WEBHOOK_SECRET: 'sk_live_fixture' })).toThrow('STRIPE_WEBHOOK_SECRET');
  });

  it('keeps mock and the simulated webapp off every real service', () => {
    expect(() => loadEnv({ ...base, ARCA_MODE: 'mock', WEBAPP_PROVIDERS: 'real' })).toThrow('ARCA_MODE=mock');
    expect(() => loadEnv({ ...base, ARCA_MODE: 'mock', EMAIL_PROVIDER: 'ses' })).toThrow('EMAIL_PROVIDER');
    expect(() => loadEnv({ ...liveDebug, EMAIL_PROVIDER: 'ses' })).toThrow('EMAIL_PROVIDER');
    expect(loadEnv({ ...liveDebug, EMAIL_PROVIDER: 'memory' }).emailProvider).toBe('memory');
  });

  it('takes a sender with or without a display name, never a header in disguise', () => {
    const real = { ...liveDebug, ...stripeTest, WEBAPP_PROVIDERS: 'real' };
    expect(loadEnv({ ...real, EMAIL_FROM: 'no-reply@arcacover.com' }).emailFrom).toBe('no-reply@arcacover.com');
    expect(loadEnv({ ...real, EMAIL_FROM: ' ARCA <no-reply@arcacover.com> ' }).emailFrom).toBe('ARCA <no-reply@arcacover.com>');
    expect(loadEnv({ ...real, EMAIL_FROM: '' }).emailFrom).toBe('ARCA <no-reply@arcacover.com>');
    for (const from of ['ARCA', 'ARCA <no-reply>', 'ARCA <no-reply@arcacover.com>\r\nBcc: x@y.co', 'a@b.co, c@d.co', '"A" <a@b.co> <c@d.co>']) {
      expect(() => loadEnv({ ...real, EMAIL_FROM: from }), from).toThrow('EMAIL_FROM');
    }
  });
});

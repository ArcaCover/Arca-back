import { describe, expect, it } from 'vitest';
import * as root from '@arca/contracts';
import {
  DEBUG_PRESETS, DEBUG_SCENARIO_HEADER, DebugModeResponse, DebugScanState, DebugScenario, isInjected,
} from '@arca/contracts/debug';

const okSource = { status: 'ok', dataStatus: 'PRESENT', durationMs: 12 } as const;
const scanState = {
  scanId: 'scan-1', status: 'COMPLETED', canonicalDomain: 'smithlaw.com', createdAt: '2026-10-23T10:00:00.000Z',
  completedAt: '2026-10-23T10:00:05.000Z', durationMs: 5000, cached: false, storage: 'memory', injected: true,
  scenario: DebugScenario.parse({ bar: 'apify_quota' }), sources: { website: okSource, bar: okSource, avvo: okSource },
};

describe('DebugScenario', () => {
  it('fills every axis with its default', () => {
    expect(DebugScenario.parse({})).toEqual({
      website: 'default', bar: 'default', avvo: 'default', latency: 'instant',
      http: { start: 'none', poll: 'none', report: 'none' }, planner: 'default',
    });
  });

  it('fills the missing http fields of a partial http object', () => {
    expect(DebugScenario.parse({ http: { poll: 'hang' } }).http).toEqual({ start: 'none', poll: 'hang', report: 'none' });
  });

  it('rejects a value outside an axis and any unknown key, also inside http', () => {
    expect(DebugScenario.safeParse({ bar: 'nope' }).success).toBe(false);
    expect(DebugScenario.safeParse({ website: 'apify_quota' }).success).toBe(false);
    expect(DebugScenario.safeParse({ extra: 1 }).success).toBe(false);
    expect(DebugScenario.safeParse({ http: { extra: 'x' } }).success).toBe(false);
  });

  it('names the request header that carries the scenario', () => {
    expect(DEBUG_SCENARIO_HEADER).toBe('X-Arca-Debug-Scenario');
  });
});

describe('isInjected', () => {
  it('is false for the default scenario', () => {
    expect(isInjected(DebugScenario.parse({}))).toBe(false);
  });

  it('is true when any axis differs from its default', () => {
    expect(isInjected(DebugScenario.parse({ bar: 'apify_quota' }))).toBe(true);
    expect(isInjected(DebugScenario.parse({ website: 'timeout' }))).toBe(true);
    expect(isInjected(DebugScenario.parse({ planner: 'timeout' }))).toBe(true);
    expect(isInjected(DebugScenario.parse({ http: { report: 'unavailable' } }))).toBe(true);
  });

  it('counts latency as an injection: any value but "instant"', () => {
    expect(isInjected(DebugScenario.parse({ latency: 'normal' }))).toBe(true);
    expect(isInjected(DebugScenario.parse({ latency: 'slow' }))).toBe(true);
    expect(isInjected(DebugScenario.parse({ latency: 'instant' }))).toBe(false);
  });
});

describe('DEBUG_PRESETS', () => {
  it('has the five presets, with English labels', () => {
    expect(Object.keys(DEBUG_PRESETS).sort()).toEqual(['all_down', 'apify_quota', 'identity_failed', 'partial', 'session_expired']);
    expect(Object.fromEntries(Object.entries(DEBUG_PRESETS).map(([key, preset]) => [key, preset.label]))).toEqual({
      apify_quota: 'Apify out of credit', partial: 'Partial scan', identity_failed: 'Failed: no firm identity',
      all_down: 'Every source down', session_expired: 'Session expired',
    });
  });

  it('parses every preset as a scenario that injects a fault', () => {
    for (const [key, preset] of Object.entries(DEBUG_PRESETS)) {
      const parsed = DebugScenario.safeParse(preset.scenario);
      expect(parsed.success, key).toBe(true);
      expect(isInjected(DebugScenario.parse(preset.scenario)), key).toBe(true);
    }
  });

  it('builds the scenarios the brief describes', () => {
    expect(DEBUG_PRESETS.apify_quota.scenario).toEqual({ bar: 'apify_quota', avvo: 'apify_quota' });
    expect(DEBUG_PRESETS.partial.scenario).toEqual({ avvo: 'error' });
    expect(DEBUG_PRESETS.identity_failed.scenario).toEqual({ website: 'no_identity' });
    expect(DEBUG_PRESETS.all_down.scenario).toEqual({ website: 'error', bar: 'error', avvo: 'error' });
    expect(DEBUG_PRESETS.session_expired.scenario).toEqual({ http: { poll: 'unauthorized' } });
  });
});

describe('DebugModeResponse', () => {
  const mode = {
    mode: 'live-debug', sourceMode: 'live', storageBackend: 'supabase', websiteEvidenceProvider: 'firecrawl',
    assessmentPlanner: 'agent', signalLlmModel: 'gpt-5.4-mini', configured: { openai: true, apify: true, supabase: false },
  };

  it('accepts a complete description of the running back', () => {
    expect(DebugModeResponse.parse(mode)).toEqual(mode);
  });

  it('never reports production, and rejects unknown keys', () => {
    expect(DebugModeResponse.safeParse({ ...mode, mode: 'production' }).success).toBe(false);
    expect(DebugModeResponse.safeParse({ ...mode, extra: 1 }).success).toBe(false);
    expect(DebugModeResponse.safeParse({ ...mode, configured: { ...mode.configured, anthropic: true } }).success).toBe(false);
  });
});

describe('DebugScanState', () => {
  it('accepts the state of a scan, with or without an injected scenario', () => {
    expect(DebugScanState.parse(scanState)).toEqual(scanState);
    const running = { ...scanState, status: 'RUNNING', completedAt: null, durationMs: null, injected: false, scenario: null, sources: null };
    expect(DebugScanState.parse(running)).toEqual(running);
  });

  it('rejects an object with an email, by design', () => {
    expect(DebugScanState.safeParse({ ...scanState, email: 'partner@smithlaw.com' }).success).toBe(false);
  });

  it('reuses the Layer 1 source statuses and the scan statuses', () => {
    expect(DebugScanState.safeParse({ ...scanState, status: 'DONE' }).success).toBe(false);
    expect(DebugScanState.safeParse({ ...scanState, sources: { ...scanState.sources, bar: { status: 'bogus' } } }).success).toBe(false);
    expect(DebugScanState.safeParse({ ...scanState, sources: { website: okSource, bar: okSource } }).success).toBe(false);
  });
});

describe('the package root', () => {
  it('does not expose the debug contract: it lives only on the @arca/contracts/debug subpath', () => {
    for (const name of ['DebugScenario', 'DEBUG_SCENARIO_HEADER', 'DEBUG_PRESETS', 'DebugModeResponse', 'DebugScanState', 'isInjected']) {
      expect(root, name).not.toHaveProperty(name);
    }
  });
});

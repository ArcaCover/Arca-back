import { z } from 'zod';
import { Layer1Result, ScanStatus } from './layer1.js';

// The debug contract is reachable only through the `@arca/contracts/debug` subpath. It is not re-exported from
// index.ts, so production code that imports the package root never bundles it.

/** Request header that carries a DebugScenario as JSON. Only POST /scan reads it, and only when debug is wired. */
export const DEBUG_SCENARIO_HEADER = 'X-Arca-Debug-Scenario';

const sourceFault = z.enum(['default', 'empty', 'apify_quota', 'error', 'timeout']);

/** The faults to inject into one scan. Every axis defaults to "no fault", so `{}` is the real behavior. */
export const DebugScenario = z.object({
  website: z.enum(['default', 'no_identity', 'blocked', 'error', 'timeout']).default('default'),
  bar: sourceFault.default('default'),
  avvo: sourceFault.default('default'),
  latency: z.enum(['instant', 'normal', 'slow']).default('instant'),
  http: z.object({
    start: z.enum(['none', 'rate_limited', 'server_error']).default('none'),
    poll: z.enum(['none', 'unauthorized', 'server_error', 'hang']).default('none'),
    report: z.enum(['none', 'unavailable']).default('none'),
  }).strict().default({}),
  planner: z.enum(['default', 'timeout']).default('default'),
}).strict();
export type DebugScenario = z.infer<typeof DebugScenario>;
/** What a caller may write: every axis optional, and `http` may name only the endpoints it changes. */
export type DebugScenarioInput = z.input<typeof DebugScenario>;

const DEFAULT_SCENARIO = DebugScenario.parse({});

const differs = (value: unknown, base: unknown): boolean => {
  if (typeof base !== 'object' || base === null) return value !== base;
  const fields = value as Record<string, unknown>;
  return Object.entries(base).some(([key, expected]) => differs(fields[key], expected));
};

/** True when any axis differs from its default. A latency other than "instant" counts as injected. */
export const isInjected = (scenario: DebugScenario): boolean => differs(scenario, DEFAULT_SCENARIO);

/** What GET /__debug/mode reports about the running back. */
export const DebugModeResponse = z.object({
  mode: z.enum(['mock', 'live-debug']),
  sourceMode: z.enum(['mock', 'live']),
  storageBackend: z.enum(['memory', 'supabase']),
  websiteEvidenceProvider: z.string(),
  assessmentPlanner: z.enum(['rules', 'agent']),
  signalLlmModel: z.string(),
  configured: z.object({ openai: z.boolean(), apify: z.boolean(), supabase: z.boolean() }).strict(),
}).strict();
export type DebugModeResponse = z.infer<typeof DebugModeResponse>;

/** What GET /__debug/scan/:scanId reports about one scan. It carries no email, by design. */
export const DebugScanState = z.object({
  scanId: z.string(),
  status: ScanStatus,
  canonicalDomain: z.string(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
  durationMs: z.number().nullable(),
  cached: z.boolean(),
  storage: z.enum(['memory', 'supabase']),
  injected: z.boolean(),
  scenario: DebugScenario.nullable(),
  sources: Layer1Result.shape.sources.nullable(),
}).strict();
export type DebugScanState = z.infer<typeof DebugScanState>;

export const DEBUG_PRESETS: Record<'apify_quota' | 'partial' | 'identity_failed' | 'all_down' | 'session_expired',
  { label: string; scenario: DebugScenarioInput }> = {
  apify_quota: { label: 'Apify out of credit', scenario: { bar: 'apify_quota', avvo: 'apify_quota' } },
  partial: { label: 'Partial scan', scenario: { avvo: 'error' } },
  identity_failed: { label: 'Failed: no firm identity', scenario: { website: 'no_identity' } },
  all_down: { label: 'Every source down', scenario: { website: 'error', bar: 'error', avvo: 'error' } },
  session_expired: { label: 'Session expired', scenario: { http: { poll: 'unauthorized' } } },
};

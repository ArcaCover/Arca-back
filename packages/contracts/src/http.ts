import { z } from 'zod';
import { Layer1Result } from './layer1.js';

// The HTTP surface of Layer 1. It lives in contracts rather than inside the API app
// because the frontend consumes exactly these shapes: one definition, both sides.
export const ScanRequest = z.object({
  domain: z.string().trim().min(1).max(2048),
  email: z.string().trim().email().max(320).transform(v => v.toLowerCase()),
}).strict();
export const StartedScanResponse = z.object({
  scanId: z.string(), sessionToken: z.string(), status: z.literal('RUNNING'),
}).strict();
// A cache hit is always COMPLETED. A cached PARTIAL is repaired before it is handed back,
// so it reaches the caller through polling, never through this response.
export const CachedScanResponse = z.object({
  scanId: z.string(), sessionToken: z.string(), status: z.literal('COMPLETED'),
  cached: z.literal(true), result: Layer1Result,
}).strict();
export const ScanResponse = z.union([StartedScanResponse, CachedScanResponse]);
const runningPoll = z.object({ scanId: z.string(), status: z.literal('RUNNING'), elapsed: z.number().nonnegative() }).strict();
const resultPoll = (status: 'COMPLETED' | 'PARTIAL') => z.object({
  scanId: z.string(), status: z.literal(status), cached: z.boolean(), result: Layer1Result,
}).strict();
const failedPoll = z.object({ scanId: z.string(), status: z.literal('FAILED'), cached: z.boolean() }).strict();
export const PollResponse = z.union([runningPoll, resultPoll('COMPLETED'), resultPoll('PARTIAL'), failedPoll]);
export const ScanErrorResponse = z.object({ error: z.string(), message: z.string() }).strict();

export type ScanRequest = z.infer<typeof ScanRequest>;
export type StartedScanResponse = z.infer<typeof StartedScanResponse>;
export type CachedScanResponse = z.infer<typeof CachedScanResponse>;
export type ScanResponse = z.infer<typeof ScanResponse>;
export type PollResponse = z.infer<typeof PollResponse>;
export type ScanErrorResponse = z.infer<typeof ScanErrorResponse>;

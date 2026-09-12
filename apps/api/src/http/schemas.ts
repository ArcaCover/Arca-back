import { z } from 'zod';
import { Layer1Result } from '@arca/contracts';
export const ScanRequest = z.object({
  domain: z.string().trim().min(1).max(2048),
  email: z.string().trim().email().max(320).transform(v => v.toLowerCase()),
}).strict();
export const StartedScanResponse = z.object({
  scanId: z.string(), sessionToken: z.string(), status: z.literal('RUNNING'),
}).strict();
export const CachedScanResponse = z.object({
  scanId: z.string(), sessionToken: z.string(), status: z.enum(['COMPLETED', 'PARTIAL']),
  cached: z.literal(true), result: Layer1Result,
}).strict();
export const ScanResponse = z.union([StartedScanResponse, CachedScanResponse]);
const runningPoll = z.object({ scanId: z.string(), status: z.literal('RUNNING'), elapsed: z.number().nonnegative() }).strict();
const resultPoll = (status: 'COMPLETED' | 'PARTIAL') => z.object({
  scanId: z.string(), status: z.literal(status), cached: z.boolean(), result: Layer1Result,
}).strict();
const failedPoll = z.object({ scanId: z.string(), status: z.literal('FAILED'), cached: z.boolean() }).strict();
export const PollResponse = z.union([runningPoll, resultPoll('COMPLETED'), resultPoll('PARTIAL'), failedPoll]);

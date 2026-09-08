import { z } from 'zod';
import { Layer1Result, ScanStatus, DomainResolution } from '@arca/contracts';
export const ScanRequest = z.object({
  domain: z.string().max(2048).optional(),
  email: z.string().trim().email().max(320).transform(v => v.toLowerCase()),
}).strict();
export const ScanResponse = z.object({
  scanId: z.string().optional(), sessionToken: z.string().optional(), status: z.union([ScanStatus, z.literal('UNRESOLVED')]),
  domainResolution: DomainResolution, assessment: Layer1Result.nullable(), cached: z.boolean().optional(),
}).strict();
export const PollResponse = z.object({
  scanId: z.string(), status: ScanStatus, elapsed: z.number().optional(),
  domainResolution: DomainResolution, assessment: Layer1Result.nullable(), cached: z.boolean().optional(),
}).strict();

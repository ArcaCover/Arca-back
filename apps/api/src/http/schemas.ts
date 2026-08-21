import { z } from 'zod';

/** Acepta un dominio suelto o una URL completa; siempre se normaliza a host en minúsculas. */
const DOMAIN_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;

export const ScanRequest = z.object({
  domain: z
    .string()
    .min(4)
    .max(253)
    .transform((value) =>
      value
        .trim()
        .replace(/^https?:\/\//i, '')
        .replace(/^www\./i, '')
        .replace(/[/?#].*$/, '')
        .toLowerCase(),
    )
    .refine((value) => DOMAIN_PATTERN.test(value), { message: 'Invalid domain' }),
  // Opcional: el broker escanea sin tener todavía el email de la firma.
  email: z.string().email().max(320).optional(),
  broker_id: z.string().uuid().optional(),
});
export type ScanRequest = z.infer<typeof ScanRequest>;

export const SubmitRequest = z.object({
  responses: z
    .array(
      z.object({
        question_id: z.string().regex(/^Q\d\.\d$/, 'Unknown question id'),
        answer: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
      }),
    )
    .min(1, 'At least one response is required'),
});
export type SubmitRequest = z.infer<typeof SubmitRequest>;

export const ScanIdParam = z.string().uuid('Invalid scan id');

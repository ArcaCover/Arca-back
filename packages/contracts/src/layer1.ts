import { Confidence, PracticeArea, Tier } from '@arca/scoring';
import { z } from 'zod';

export const SignalCategory = z.enum(['governance', 'tech', 'regulatory', 'content']);
export const SignalType = z.enum(['positive', 'warning', 'negative', 'neutral']);

/** Una señal tal como la consume el frontend: ya traducida a puntos y texto. */
export const Signal = z.object({
  id: z.string(),
  category: SignalCategory,
  type: SignalType,
  title: z.string(),
  detail: z.string(),
  points: z.number(),
  max_points: z.number(),
});
export type Signal = z.infer<typeof Signal>;

export const LegalPlatform = z.enum(['clio', 'practicepanther', 'mycase']);
export type LegalPlatform = z.infer<typeof LegalPlatform>;

export const EmailProvider = z.enum(['google', 'microsoft', 'other']);
export type EmailProvider = z.infer<typeof EmailProvider>;

export const Layer1Firm = z.object({
  name: z.string().nullable(),
  domain: z.string(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  attorneys_count: z.number().int().nullable(),
  practice_areas: z.array(PracticeArea),
  primary_practice: PracticeArea.nullable(),
});
export type Layer1Firm = z.infer<typeof Layer1Firm>;

/** Hechos crudos detectados por el pipeline. Alimentan tanto el pre-score como las preguntas. */
export const Layer1Observations = z.object({
  website_found: z.boolean(),
  pages_scraped: z.array(z.string()),
  ai_policy_found: z.boolean(),
  ai_policy_url: z.string().nullable(),
  ai_in_services: z.boolean(),
  blog_ai_content: z.boolean(),
  job_posts_ai: z.boolean(),
  legal_platform: LegalPlatform.nullable(),
  email_provider: EmailProvider.nullable(),
  dmarc_configured: z.boolean(),
  bar_verified: z.boolean(),
  bar_check: z.string(),
  /** Derivada: hay SaaS de por medio, así que aplica preguntar por residencia de datos. */
  cloud_tools_detected: z.boolean(),
});
export type Layer1Observations = z.infer<typeof Layer1Observations>;

/** Traza de cada paso, para diagnosticar por qué bajó la confianza de un scan. */
export const PipelineStep = z.object({
  step: z.string(),
  status: z.enum(['ok', 'failed', 'timeout', 'skipped']),
  duration_ms: z.number(),
  error: z.string().nullable(),
});
export type PipelineStep = z.infer<typeof PipelineStep>;

export const PreScore = z.object({
  value: z.number(),
  tier: Tier,
  confidence: Confidence,
  signals_detected: z.number().int(),
  points_earned: z.number(),
  /** Solo suma el máximo de las señales efectivamente chequeadas. */
  points_possible: z.number(),
});
export type PreScore = z.infer<typeof PreScore>;

export const QuickReport = z.object({
  summary: z.string(),
  top_strengths: z.array(z.string()),
  top_risks: z.array(z.string()),
});
export type QuickReport = z.infer<typeof QuickReport>;

/**
 * Salida del pipeline de Capa 1. Es un contrato de datos plano a propósito: el día que el
 * pipeline se mueva a un servicio Python, esto es lo que viaja por HTTP sin tocar nada más.
 */
export const Layer1Result = z.object({
  domain: z.string(),
  firm: Layer1Firm,
  pre_score: PreScore,
  signals: z.array(Signal),
  observations: Layer1Observations,
  quick_report: QuickReport,
  steps: z.array(PipelineStep),
  duration_ms: z.number(),
});
export type Layer1Result = z.infer<typeof Layer1Result>;

export const Layer1Input = z.object({
  domain: z.string(),
  /** Correlaciona la evidencia y el run record con el scan en el MemoryStore. */
  scan_id: z.string().optional(),
});
export type Layer1Input = z.infer<typeof Layer1Input>;

/**
 * Puerto del pipeline. Hoy solo existe InProcessPipeline; mañana un HttpPipeline que hace
 * POST a un servicio aparte implementa esta misma firma y nada más cambia.
 */
export interface Layer1Pipeline {
  run(input: Layer1Input): Promise<Layer1Result>;
}

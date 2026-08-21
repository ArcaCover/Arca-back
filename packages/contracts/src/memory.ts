import { z } from 'zod';

/** Evidencia cruda del scraping. Va a MongoDB cuando el Memory System exista; hoy no persiste. */
export const EvidenceItem = z.object({
  kind: z.enum(['page_text', 'dns_record', 'tech_fingerprint', 'http_header']),
  source_url: z.string(),
  /** Contenido textual plano: nada de buffers ni DOM, tiene que serializar a JSON. */
  content: z.string(),
  /** Metadata libre pero escalar, para no arrastrar objetos anidados a Mongo. */
  metadata: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),
  /** ISO 8601. String y no Date, porque este objeto viaja por HTTP. */
  collected_at: z.string(),
});
export type EvidenceItem = z.infer<typeof EvidenceItem>;

/** Historial de ejecución de un scan: qué pasos corrieron, cuánto tardaron y qué falló. */
export const RunRecord = z.object({
  domain: z.string(),
  pipeline: z.string(),
  started_at: z.string(),
  finished_at: z.string(),
  duration_ms: z.number(),
  steps: z.array(
    z.object({
      step: z.string(),
      status: z.enum(['ok', 'failed', 'timeout', 'skipped']),
      duration_ms: z.number(),
      error: z.string().nullable(),
    }),
  ),
  pre_score: z.number(),
  confidence: z.enum(['HIGH', 'MEDIUM', 'LOW']),
  signals_detected: z.number().int(),
});
export type RunRecord = z.infer<typeof RunRecord>;

/**
 * Puerto del Memory System. La implementación real (MongoDB) llega en otra fase; el pipeline
 * ya llama a estos métodos para que conectarla no requiera tocar el pipeline.
 */
export interface MemoryStore {
  saveEvidence(scanId: string, items: EvidenceItem[]): Promise<void>;
  saveRunRecord(scanId: string, record: RunRecord): Promise<void>;
}

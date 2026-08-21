import { DomainKey } from '@arca/scoring';
import { z } from 'zod';

export const QuestionOption = z.object({
  id: z.string(),
  text: z.string(),
});
export type QuestionOption = z.infer<typeof QuestionOption>;

export const QuestionType = z.enum(['single_select', 'multi_select']);
export type QuestionType = z.infer<typeof QuestionType>;

/** Definición estática de una pregunta, tal como vive en el banco versionado. */
export const Question = z.object({
  id: z.string(),
  domain: DomainKey,
  domain_label: z.string(),
  text: z.string(),
  type: QuestionType,
  options: z.array(QuestionOption),
  info_tooltip: z.string().nullable(),
});
export type Question = z.infer<typeof Question>;

/** Pregunta ya resuelta para un scan concreto: con orden, contexto y motivo del salto. */
export const SelectedQuestion = Question.extend({
  order: z.number().int(),
  context: z.string().nullable(),
  skipped_question: z.string().nullable(),
  skip_reason: z.string().nullable(),
});
export type SelectedQuestion = z.infer<typeof SelectedQuestion>;

export const QuestionSet = z.object({
  total_questions: z.number().int(),
  estimated_minutes: z.number().int(),
  questions: z.array(SelectedQuestion),
});
export type QuestionSet = z.infer<typeof QuestionSet>;

/** Request profile of the OpenAI chat endpoint: each model family accepts different parameters. */
export type LlmEndpoint = { id: 'openai'; requestParams(model: string): Record<string, unknown>;
  /**
   * What the one retry of a call the model cut at its completion limit (finish_reason 'length') sends on top of
   * requestParams. An endpoint without it fails such a call at once.
   */
  lengthRetryParams?(model: string): Record<string, unknown> };
/** The model the agentic website extraction uses unless SIGNAL_LLM_MODEL says otherwise. */
export const DEFAULT_SIGNAL_LLM_MODEL = 'gpt-6-luna';
export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

// Probed on 2026-09-14: GPT-5 family models reject temperature 0 and max_tokens; gpt-4.1-mini accepts both but no
// reasoning_effort. Supported efforts vary: gpt-5-mini has no 'none', gpt-5.4-mini and gpt-5.6-luna have no 'minimal'.
// Re-probed on 2026-09-23: gpt-6-luna behaves like the GPT-5 family and answers "Unsupported value: 'temperature'
// does not support 0 with this model". The boundary is the major version, not the number 5, so match GPT-5 and every
// major after it (two-digit versions included) rather than gpt-5 alone.
const reasoningModel = (model: string) => /^(gpt-(?:[5-9]|\d{2,})|o\d)/i.test(model);

// A reasoning model spends part of max_completion_tokens on reasoning before it writes the answer, so a long round can
// stop on 'length' with no usable JSON (DN-12 §13.8). The retry doubles the budget: 32,000 is well inside the output
// limit of the GPT-5 family and later; for the older models 16,000 stays under the smallest output limit among them
// (gpt-4o-mini, 16,384).
const COMPLETION_TOKENS = { reasoning: 16_000, reasoningRetry: 32_000, standard: 8000, standardRetry: 16_000 };

export function openAiEndpoint(reasoningEffort?: ReasoningEffort): LlmEndpoint {
  return { id: 'openai',
    requestParams: model => reasoningModel(model)
      ? { max_completion_tokens: COMPLETION_TOKENS.reasoning, ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}) }
      : { temperature: 0, max_completion_tokens: COMPLETION_TOKENS.standard },
    lengthRetryParams: model => ({ max_completion_tokens: reasoningModel(model) ? COMPLETION_TOKENS.reasoningRetry
      : COMPLETION_TOKENS.standardRetry }) };
}

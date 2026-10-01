/** Request profile of the OpenAI chat endpoint: each model family accepts different parameters. */
export type LlmEndpoint = { id: 'openai'; requestParams(model: string): Record<string, unknown> };
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

export function openAiEndpoint(reasoningEffort?: ReasoningEffort): LlmEndpoint {
  return { id: 'openai', requestParams: model => reasoningModel(model)
    ? { max_completion_tokens: 16_000, ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}) }
    : { temperature: 0, max_completion_tokens: 8000 } };
}


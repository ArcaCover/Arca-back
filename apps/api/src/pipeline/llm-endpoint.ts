/** Request profile of an OpenAI-compatible chat endpoint: each endpoint and model family accepts different parameters. */
export type LlmEndpointId = 'nvidia' | 'openai';
export type LlmEndpoint = { id: LlmEndpointId; baseURL?: string; requestParams(model: string): Record<string, unknown> };
export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

// Probed on 2026-09-14: GPT-5 family models reject temperature 0 and max_tokens; gpt-4.1-mini accepts both but no
// reasoning_effort. Supported efforts vary: gpt-5-mini has no 'none', gpt-5.4-mini and gpt-5.6-luna have no 'minimal'.
const reasoningModel = (model: string) => /^(gpt-5|o\d)/i.test(model);

export function openAiEndpoint(reasoningEffort?: ReasoningEffort): LlmEndpoint {
  return { id: 'openai', requestParams: model => reasoningModel(model)
    ? { max_completion_tokens: 16_000, ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}) }
    : { temperature: 0, max_completion_tokens: 8000 } };
}

export const LLM_ENDPOINTS: Record<LlmEndpointId, LlmEndpoint> = {
  nvidia: { id: 'nvidia', baseURL: 'https://integrate.api.nvidia.com/v1',
    requestParams: () => ({ temperature: 0, max_tokens: 8000, chat_template_kwargs: { enable_thinking: false } }) },
  openai: openAiEndpoint(),
};

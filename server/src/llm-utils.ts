import type { LLMOptions } from './llm.js';

export function buildLLMRequestBody(opts: LLMOptions): Record<string, unknown> {
  const body: Record<string, unknown> = {
    messages: opts.messages,
    temperature: opts.temperature ?? 0.7,
  };
  if (opts.maxTokens != null) body.max_completion_tokens = opts.maxTokens;
  if (opts.tools) body.tools = opts.tools;
  if (opts.toolChoice) body.tool_choice = opts.toolChoice;
  if (opts.responseFormat) body.response_format = opts.responseFormat;
  return body;
}

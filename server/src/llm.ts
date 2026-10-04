import { generateText, jsonSchema, streamText, tool, type ModelMessage, type ToolChoice, type ToolSet } from 'ai';
import type { ResponseLength } from './engine/modes.js';
import { createLanguageModel, resolveProvider, usesGoogleOptions } from './provider-registry.js';
import { loadSettings } from './settings-store.js';
import { smartRouting } from './smart-routing-bridge.js';
import { withRetry } from './engine/retry.js';
import { getConfig } from './config/load.js';
import { traceEvent } from './trace.js';
import { traceLive } from './trace.js';

export type LLMRole = keyof import('./settings-store.js').ModelRouting;

export interface TargetReference {
  source: 'role' | 'provider';
  id: string;
  url: string;
  model: string;
}

export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

const EFFORT_RANK: Record<ReasoningEffort, number> = { none: 0, minimal: 1, low: 2, medium: 3, high: 4, xhigh: 5 };
/* Wire-safe landing for each rank: `minimal`/`high` exist in settings but
   never travel the wire, so a floor on either rounds up to `low`/`xhigh`. */
const RANK_TO_WIRE: ReasoningEffort[] = ['none', 'low', 'low', 'medium', 'xhigh', 'xhigh'];

/**
 * The provider's `reasoningEffort` is a floor, not a fallback: the round's
 * effort can only go up from here. Without a floor the round passes through
 * untouched, so providers that never set one behave exactly as before.
 */
export function applyReasoningFloor(
  round: ReasoningEffort | undefined,
  floor: ReasoningEffort | undefined,
): ReasoningEffort | undefined {
  if (!floor) return round;
  if (!round) return RANK_TO_WIRE[EFFORT_RANK[floor]];
  return RANK_TO_WIRE[Math.max(EFFORT_RANK[round], EFFORT_RANK[floor])];
}

export interface LLMOptions {
  messages: unknown[];
  temperature?: number;
  maxTokens?: number;
  tools?: unknown[];
  toolChoice?: 'auto' | 'none' | { type: 'function'; function: { name: string } };
  stream?: boolean;
  onToken?: (text: string) => void;
  onModelSelected?: (model: string, provider: string) => void;
  label?: string;
  role?: LLMRole;
  /** The requested answer length. Only read for output-side timeouts. */
  responseLength?: ResponseLength;
  /** True on the forced final-answer call, whose output dwarfs other turns. */
  finalAnswer?: boolean;
  signal?: AbortSignal;
  responseFormat?: unknown;
  reasoningEffort?: ReasoningEffort;
  /** Job id, so every provider attempt lands in that job's trace file. */
  traceId?: string;
  /** Research round, for grouping a trace by step. */
  traceRound?: number;
}

/** Token counts as reported by the provider, split by billing category. */
export interface LLMUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  requests: number;
  /** False when the provider returned no usage data; the call is then unpriced. */
  reported: boolean;
}

export interface LLMResult {
  data?: unknown;
  fullContent?: string;
  model: string;
  provider: string;
  usage: LLMUsage;
}

type FailureReason = 'auth' | 'rate-limit' | 'transient';
type AttemptResult =
  | { ok: true; data: unknown; fullContent?: string; usage: LLMUsage; observations?: CapacityObservation[] }
  | { ok: false; reason: FailureReason; observations?: CapacityObservation[]; detail?: string };

interface CapacityObservation {
  scopeId: string;
  source: 'response-header' | 'retry-after';
  observedAt: string;
  request?: { limit: number | null; remaining: number | null; resetAt: string | null };
  tokens?: { limit: number | null; remaining: number | null; resetAt: string | null };
  retryAfterSeconds?: number | null;
}

interface RawMessage extends Record<string, unknown> {
  role?: unknown;
  content?: unknown;
  tool_calls?: unknown;
  tool_call_id?: unknown;
}

function logError(label: string, target: string, status: number, message: string): void {
  console.error(`[${status}] ${label} (${target}): ${message.slice(0, 1000)}`);
}

/**
 * Flattens a message array for the trace. The raw SDK shape is nested and hard
 * to read after the fact; what matters when diagnosing a run is which role said
 * what, which tool was called with which arguments, and how big the prompt got.
 *
 * `sizes` records every message as {role, chars} in order, with tool results
 * attributed to their tool by call id. Phase 0 needs this to measure what share
 * of context is raw tool output versus assistant text versus fixed parts, and
 * that split is only computable if each message carries its own size.
 */
function summarizeMessages(messages: unknown[]): {
  count: number;
  chars: number;
  roles: Record<string, number>;
  preview: string[];
  sizes: { role: string; chars: number; tool?: string }[];
} {
  const roles: Record<string, number> = {};
  let chars = 0;
  const preview: string[] = [];
  const sizes: { role: string; chars: number; tool?: string }[] = [];
  /* Tool results carry no name, so attribute them by matching the call id the
     assistant used when it invoked them. Unmatched results stay 'unknown'
     rather than guessed. */
  const callIdToTool = new Map<string, string>();
  for (const raw of messages) {
    const m = asRecord(raw);
    if (m.role !== 'assistant' || !Array.isArray(m.tool_calls)) continue;
    for (const call of m.tool_calls) {
      const c = asRecord(call);
      const fn = asRecord(c.function);
      if (typeof c.id === 'string' && typeof fn.name === 'string') {
        callIdToTool.set(c.id, fn.name);
      }
    }
  }
  for (const raw of messages) {
    const m = asRecord(raw);
    const role = typeof m.role === 'string' ? m.role : 'unknown';
    roles[role] = (roles[role] ?? 0) + 1;
    let text = '';
    if (typeof m.content === 'string') {
      text = m.content;
    } else if (Array.isArray(m.content)) {
      text = m.content.map((part) => asRecord(part).text ?? '').join(' ');
    }
    if (Array.isArray(m.tool_calls)) {
      for (const call of m.tool_calls) {
        const fn = asRecord(asRecord(call).function);
        text += `\n[tool_call ${String(fn.name)} ${typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments)}]`;
      }
    }
    chars += text.length;
    const sizeEntry: { role: string; chars: number; tool?: string } = { role, chars: text.length };
    if (role === 'tool') {
      const callId = typeof m.tool_call_id === 'string' ? m.tool_call_id : null;
      sizeEntry.tool = (callId && callIdToTool.get(callId)) ?? 'unknown';
    }
    sizes.push(sizeEntry);
    if (role === 'system' || role === 'user') {
      preview.push(`--- ${role} (${text.length} chars) ---\n${text.slice(0, 600)}`);
    }
  }
  return { count: messages.length, chars, roles, preview, sizes };
}

/**
 * Renders every message in full for the live log. Unlike the trace summary
 * above, nothing is previewed or clipped: this is what the provider actually
 * received. Tool results are labeled with the tool they came from, matched by
 * call id the same way.
 */
function formatMessagesFull(messages: unknown[]): string {
  const callIdToTool = new Map<string, string>();
  for (const raw of messages) {
    const m = asRecord(raw);
    if (m.role !== 'assistant' || !Array.isArray(m.tool_calls)) continue;
    for (const call of m.tool_calls) {
      const c = asRecord(call);
      const fn = asRecord(c.function);
      if (typeof c.id === 'string' && typeof fn.name === 'string') {
        callIdToTool.set(c.id, fn.name);
      }
    }
  }
  const parts: string[] = [];
  for (const raw of messages) {
    const m = asRecord(raw);
    const role = typeof m.role === 'string' ? m.role : 'unknown';
    let label = `[${role}]`;
    if (role === 'tool') {
      const callId = typeof m.tool_call_id === 'string' ? m.tool_call_id : null;
      label = `[tool:${(callId && callIdToTool.get(callId)) ?? 'unknown'}]`;
    }
    let text = '';
    if (typeof m.content === 'string') {
      text = m.content;
    } else if (Array.isArray(m.content)) {
      text = m.content.map((part) => {
        const p = asRecord(part);
        return typeof p.text === 'string' ? p.text : JSON.stringify(part);
      }).join('\n');
    }
    if (Array.isArray(m.tool_calls)) {
      for (const call of m.tool_calls) {
        const fn = asRecord(asRecord(call).function);
        text += `\n[tool_call ${String(fn.name)}]\n${typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments)}`;
      }
    }
    parts.push(`${label} (${text.length} chars)\n${text}`);
  }
  return parts.join('\n\n---\n\n');
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function parseJsonObject(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? {};
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return {};
  }
}

function toModelMessages(input: unknown[]): ModelMessage[] {
  const toolNames = new Map<string, string>();
  for (const value of input) {
    const message = asRecord(value);
    if (message.role !== 'assistant' || !Array.isArray(message.tool_calls)) continue;
    for (const rawCall of message.tool_calls) {
      const call = asRecord(rawCall);
      const fn = asRecord(call.function);
      if (typeof call.id === 'string' && typeof fn.name === 'string') toolNames.set(call.id, fn.name);
    }
  }

  const messages: ModelMessage[] = [];
  for (const value of input) {
    const message = asRecord(value) as RawMessage;
    const role = message.role;
    if (role === 'system') {
      messages.push({ role: 'system', content: typeof message.content === 'string' ? message.content : '' });
      continue;
    }
    if (role === 'user') {
      messages.push({ role: 'user', content: typeof message.content === 'string' ? message.content : String(message.content ?? '') });
      continue;
    }
    if (role === 'assistant') {
      const parts: Array<Record<string, unknown>> = [];
      /* Preserved deliberation travels as a reasoning part, mirroring the
         shape the transport itself parses responses into
         ({ type: 'reasoning', text }), which packages map to their thinking
         channel (reasoning_content and friends). An extra plain field here
         would be dropped silently, so this stays explicit. */
      const priorReasoning = asRecord(message).reasoning;
      if (typeof priorReasoning === 'string' && priorReasoning.length > 0) {
        parts.push({ type: 'reasoning', text: priorReasoning });
      }
      if (typeof message.content === 'string' && message.content.length > 0) {
        parts.push({ type: 'text', text: message.content });
      }
      if (Array.isArray(message.tool_calls)) {
        for (const rawCall of message.tool_calls) {
          const call = asRecord(rawCall);
          const fn = asRecord(call.function);
          if (typeof call.id !== 'string' || typeof fn.name !== 'string') continue;
          parts.push({
            type: 'tool-call',
            toolCallId: call.id,
            toolName: fn.name,
            input: parseJsonObject(fn.arguments),
            ...(call.providerOptions ? { providerOptions: call.providerOptions } : {}),
          });
        }
      }
      if (parts.length > 0) messages.push({ role: 'assistant', content: parts } as unknown as ModelMessage);
      continue;
    }
    if (role === 'tool' && typeof message.tool_call_id === 'string') {
      const toolCallId = message.tool_call_id;
      const toolName = toolNames.get(toolCallId);
      if (!toolName) continue;
      messages.push({
        role: 'tool',
        content: [{
          type: 'tool-result',
          toolCallId,
          toolName,
          output: { type: 'text', value: typeof message.content === 'string' ? message.content : String(message.content ?? '') },
        }],
      });
    }
  }
  return messages;
}

function toSdkTools(rawTools: unknown[] | undefined): ToolSet | undefined {
  if (!rawTools?.length) return undefined;
  const tools: Record<string, ReturnType<typeof tool>> = {};
  for (const rawTool of rawTools) {
    const wrapper = asRecord(rawTool);
    const definition = asRecord(wrapper.function ?? wrapper);
    if (typeof definition.name !== 'string' || !definition.name) continue;
    const schema = asRecord(definition.parameters);
    tools[definition.name] = tool({
      description: typeof definition.description === 'string' ? definition.description : '',
      inputSchema: jsonSchema(schema as never),
    });
  }
  return tools as ToolSet;
}

function toSdkToolChoice(choice: LLMOptions['toolChoice']): ToolChoice<ToolSet> | undefined {
  if (choice === 'auto' || choice === 'none') return choice;
  if (choice && typeof choice === 'object') {
    return { type: 'tool', toolName: choice.function.name } as ToolChoice<ToolSet>;
  }
  return undefined;
}

function googleOptions(target: TargetReference, provider: ReturnType<typeof loadSettings>['providers'][string], effort?: ReasoningEffort): Record<string, unknown> | undefined {
  const resolvedEffort = applyReasoningFloor(effort, provider.reasoningEffort);
  if (!resolvedEffort || provider.disabledThinkingModels?.includes(target.model)) return undefined;
  const modelId = target.model.toLowerCase();
  const includeThoughts = provider.includeThoughts ?? false;
  if (modelId.includes('gemini-3')) {
    const thinkingLevel = resolvedEffort === 'none' || resolvedEffort === 'minimal'
      ? 'minimal'
      : resolvedEffort === 'xhigh' ? 'high' : resolvedEffort;
    return { google: { thinkingConfig: { thinkingLevel, includeThoughts } } };
  }
  if (modelId.includes('gemini-2.5')) {
    const thinkingBudget = resolvedEffort === 'none' ? 0
      : resolvedEffort === 'minimal' || resolvedEffort === 'low' ? 2048
        : resolvedEffort === 'medium' ? 8192 : -1;
    return { google: { thinkingConfig: { thinkingBudget, includeThoughts } } };
  }
  return undefined;
}

function toCamelCase(value: string): string {
  return value.replace(/[-_ ]+([a-z0-9])/gi, (_match, letter: string) => letter.toUpperCase());
}

export function modelProviderOptions(
  target: TargetReference,
  provider: ReturnType<typeof loadSettings>['providers'][string],
  npm: string,
  effort?: ReasoningEffort,
): Record<string, unknown> | undefined {
  /* The Google SDK shapes thinking options its own way; every other package
     takes the generic reasoning-effort field under its provider key. A setting
     a package does not understand is ignored by that package. */
  if (usesGoogleOptions(npm)) return googleOptions(target, provider, effort);

  const resolvedEffort = applyReasoningFloor(effort, provider.reasoningEffort);
  if (!resolvedEffort || provider.disabledThinkingModels?.includes(target.model)) return undefined;
  /* Generic packages read their own namespace, not the provider id: a custom
     endpoint on the openai-compatible package never saw `sovinfra`, so the
     effort died in the SDK while the trace still labelled it. Measured: no
     thinking in any qwen response at any effort level. */
  if (npm === '@ai-sdk/openai-compatible') return { openaiCompatible: { reasoningEffort: resolvedEffort } };
  return { [toCamelCase(target.id)]: { reasoningEffort: resolvedEffort } };
}

function createTimeoutSignal(parent: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return parent ? AbortSignal.any([parent, timeout]) : timeout;
}

/** Stall after which a flowing stream is declared dead. Chunks arrive far more
 *  often than this in a healthy stream; an hour-long silence is not patience. */
export const LLM_STREAM_IDLE_TIMEOUT_MS = 60_000;

/** Ceiling for turning a finished stream into text. The stream timers are
 *  disposed once consumption ends, so an SDK promise that never settles
 *  after a broken stream would otherwise hang the attempt forever. */
export const LLM_MATERIALIZE_TIMEOUT_MS = 60_000;

export function materializeWithTimeout<T>(promise: Promise<T>, ms: number = LLM_MATERIALIZE_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`LLM response materialization timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** Output-side budgets for the forced final answer, by requested length. The
 *  input-scaled total covers prefill; these cover generating the report,
 *  which is the largest output of the whole run. */
export const FINAL_ANSWER_TIMEOUT_MS = {
  short: 240_000,
  long: 540_000,
  exhaustive: 900_000,
} as const satisfies Record<ResponseLength, number>;

/**
 * Total budget for one model call, scaled with context. The forced answer at a
 * ceiling is the largest prompt of the run: a flat total-only deadline killed
 * runs that were still streaming (`j-faE5hOH46vGt`, then `j-iOjo2HjVNvkC` at
 * 377K chars against a 75s guillotine). A final answer takes the larger of the
 * input-scaled budget and its length's output budget
 * (`j-AbdnmdUTgeLo`: 405K chars in, long report out, dead at ~200s).
 * Streaming calls pair this with the idle timer below instead of relying on
 * it alone.
 */
export function llmTotalTimeoutMs(contextChars: number, responseLength?: ResponseLength | null): number {
  const inputScaled = 120_000 + Math.min(480_000, Math.floor(Math.max(0, contextChars) / 5_000) * 1_000);
  if (!responseLength) return inputScaled;
  return Math.max(inputScaled, FINAL_ANSWER_TIMEOUT_MS[responseLength]);
}

/**
 * Retry schedule for one model call. A final-answer call gets a single retry:
 * the final phase is wall-clock-bound, and six dead attempts is how a
 * finished run dies with nothing (`j-AbdnmdUTgeLo`). The real error surfaces
 * after the second failure instead.
 */
export function retryDelaysForFinalAnswer(allDelaysMs: number[], finalAnswer: boolean | undefined): number[] {
  return finalAnswer ? allDelaysMs.slice(0, 1) : allDelaysMs;
}

/**
 * Streaming-aware timeout: a total deadline plus an idle deadline that
 * restarts on every reported chunk. A stream that flows is never cut; a stream
 * that stalls still dies. The idle arm starts on the first chunk, so a long
 * prefill is governed by the total alone. Call `dispose` once the stream is
 * fully consumed so neither timer outlives the call.
 */
export function createStreamingTimeout(
  parent: AbortSignal | undefined,
  totalMs: number,
  idleMs: number = LLM_STREAM_IDLE_TIMEOUT_MS,
): { signal: AbortSignal; chunk: () => void; dispose: () => void } {
  const controller = new AbortController();
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const totalTimer = setTimeout(() => {
    controller.abort(new Error(`LLM call exceeded its total budget of ${totalMs}ms`));
  }, totalMs);
  const chunk = (): void => {
    if (controller.signal.aborted) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      controller.abort(new Error(`LLM stream stalled for ${idleMs}ms`));
    }, idleMs);
  };
  const dispose = (): void => {
    clearTimeout(totalTimer);
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };
  return {
    signal: parent ? AbortSignal.any([parent, controller.signal]) : controller.signal,
    chunk,
    dispose,
  };
}

function toUsageTokens(value: unknown): number {
  const usage = asRecord(value);
  const input = typeof usage.inputTokens === 'number' ? usage.inputTokens : 0;
  const output = typeof usage.outputTokens === 'number' ? usage.outputTokens : 0;
  return typeof usage.totalTokens === 'number' ? usage.totalTokens : input + output;
}

function numberOr(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Normalises provider-reported usage into billing categories. Nothing is
 * inferred: a category the provider did not report is zero, and `reported` is
 * false when the provider sent no usage at all.
 */
function toTokenUsage(value: unknown): LLMUsage {
  const usage = asRecord(value);
  const details = asRecord(usage.inputTokenDetails);
  const inputTokens = numberOr(usage.inputTokens);
  const outputTokens = numberOr(usage.outputTokens);
  const cacheReadTokens = numberOr(details.cacheReadTokens);
  const cacheWriteTokens = numberOr(details.cacheWriteTokens);
  return {
    inputTokens: Math.max(0, inputTokens - cacheReadTokens - cacheWriteTokens),
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens: toUsageTokens(usage),
    requests: 1,
    reported: toUsageTokens(usage) > 0,
  };
}

function responseHeadersToObservations(headers: Headers | null, scopeId: string): CapacityObservation[] | undefined {
  if (!headers) return undefined;
  const observedAt = new Date().toISOString();
  const parseIntHeader = (name: string): number | null => {
    const value = headers.get(name);
    return value ? Number.parseInt(value, 10) || null : null;
  };
  const requestLimit = parseIntHeader('x-ratelimit-limit-requests');
  const requestRemaining = parseIntHeader('x-ratelimit-remaining-requests');
  const requestReset = parseIntHeader('x-ratelimit-reset-requests');
  const tokenLimit = parseIntHeader('x-ratelimit-limit-tokens');
  const tokenRemaining = parseIntHeader('x-ratelimit-remaining-tokens');
  const tokenReset = parseIntHeader('x-ratelimit-reset-tokens');
  const observations: CapacityObservation[] = [];
  if (requestLimit !== null || requestRemaining !== null || requestReset !== null) {
    observations.push({
      scopeId,
      source: 'response-header',
      observedAt,
      request: {
        limit: requestLimit,
        remaining: requestRemaining,
        resetAt: requestReset === null ? null : new Date(requestReset * 1000).toISOString(),
      },
    });
  }
  if (tokenLimit !== null || tokenRemaining !== null || tokenReset !== null) {
    observations.push({
      scopeId,
      source: 'response-header',
      observedAt,
      tokens: {
        limit: tokenLimit,
        remaining: tokenRemaining,
        resetAt: tokenReset === null ? null : new Date(tokenReset * 1000).toISOString(),
      },
    });
  }
  return observations.length ? observations : undefined;
}

function statusCodeOf(error: unknown): number | null {
  const record = asRecord(error);
  const statusCode = record.statusCode ?? record.status;
  return typeof statusCode === 'number' ? statusCode : null;
}

function errorHeadersOf(error: unknown): Headers | null {
  const raw = asRecord(error).responseHeaders;
  if (raw instanceof Headers) return raw;
  if (raw && typeof raw === 'object') {
    const entries = Object.entries(raw as Record<string, unknown>)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string');
    return new Headers(entries);
  }
  return null;
}

function retryAfterMs(headers: Headers | null): number | null {
  const value = headers?.get('retry-after');
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

function normalizedFinishReason(reason: unknown, hasToolCalls: boolean): string {
  if (hasToolCalls) return 'tool_calls';
  if (reason === 'length') return 'length';
  if (reason === 'content-filter') return 'content_filter';
  return 'stop';
}

function engineResponse(
  text: string,
  toolCalls: Array<{ id: string; name: string; input: unknown; providerOptions?: unknown }>,
  finishReason: unknown,
  model: string,
  usage: unknown,
  reasoning?: string,
): unknown {
  const message: Record<string, unknown> = { role: 'assistant', content: text || null };
  /* Reasoning is written onto the message so that everything downstream — the
     engine's step event, the trace, and the live log — can read it. Omitting it
     here made reasoning invisible everywhere, because the engine, the trace and
     the live log all read this object rather than the raw provider body. */
  if (reasoning && reasoning.length > 0) message.reasoning = reasoning;
  if (toolCalls.length) {
    message.tool_calls = toolCalls.map((call) => ({
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.input ?? {}) },
      ...(call.providerOptions ? { providerOptions: call.providerOptions } : {}),
    }));
  }
  const tokens = asRecord(usage);
  return {
    id: `athena-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: normalizedFinishReason(finishReason, toolCalls.length > 0) }],
    usage: {
      prompt_tokens: typeof tokens.inputTokens === 'number' ? tokens.inputTokens : 0,
      completion_tokens: typeof tokens.outputTokens === 'number' ? tokens.outputTokens : 0,
      total_tokens: toUsageTokens(usage),
    },
  };
}

function toolCallsFrom(content: unknown): Array<{ id: string; name: string; input: unknown; providerOptions?: unknown }> {
  if (!Array.isArray(content)) return [];
  return content.flatMap((partValue) => {
    const part = asRecord(partValue);
    if (part.type !== 'tool-call' || typeof part.toolCallId !== 'string' || typeof part.toolName !== 'string') return [];
    return [{
      id: part.toolCallId,
      name: part.toolName,
      input: part.input,
      ...(part.providerOptions ? { providerOptions: part.providerOptions } : {}),
    }];
  });
}

async function callSelectedTarget(
  target: TargetReference,
  options: LLMOptions,
  streaming: boolean,
  label: string,
): Promise<AttemptResult | null> {
  const settings = loadSettings();
  const provider = settings.providers[target.id];
  if (!provider?.enabled) return null;
  const resolution = resolveProvider(target.id, provider);
  if (!resolution.ok) return null;
  const scopeId = `${target.id}/${target.model}`;
  let lastFailure: FailureReason = 'transient';
  let lastDetail: string | undefined;
  let lastObservations: CapacityObservation[] | undefined;

  for (const { key: apiKey } of resolution.provider.apiKeys) {
    let responseHeaders: Headers | null = null;
    const trackedFetch: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      responseHeaders = response.headers;
      return response;
    };
    const created = createLanguageModel(target.id, target.model, provider, trackedFetch, apiKey);
    if (!created.ok) return null;
    const model = created.model;
    const contextChars = options.messages.reduce((n: number, m) => {
      const content = (m as { content?: unknown }).content;
      return n + (typeof content === 'string' ? content.length : 0);
    }, 0);
    const timeoutMs = llmTotalTimeoutMs(contextChars, options.finalAnswer ? options.responseLength ?? null : null);
    const streamingTimeout = streaming
      ? createStreamingTimeout(options.signal, timeoutMs)
      : null;
    const signal = streamingTimeout ? streamingTimeout.signal : createTimeoutSignal(options.signal, timeoutMs);
    const modelTools = toSdkTools(options.tools);
    const providerOptions = modelProviderOptions(target, provider, resolution.provider.npm, options.reasoningEffort) as Parameters<typeof generateText>[0]['providerOptions'];
    /* The leading system prompt travels via the SDK's `system` option, not as
       a message in the array. Mid-array system messages trigger the SDK's
       prompt-injection warning on every call, so the engine keeps exactly one
       system message (the base prompt, always first) and everything dynamic
       travels as user messages. */
    const converted = toModelMessages(options.messages);
    const leading = converted.length > 0 && (converted[0] as { role?: string }).role === 'system' ? converted[0] : null;
    const rest = leading ? converted.slice(1) : converted;
    const leadingText = leading ? (leading as { content?: unknown }).content : undefined;
    const common = {
      model,
      ...(typeof leadingText === 'string' && leadingText.length > 0 ? { system: leadingText } : {}),
      messages: rest,
      temperature: options.temperature ?? 0.7,
      ...(options.maxTokens === undefined ? {} : { maxOutputTokens: options.maxTokens }),
      ...(modelTools ? { tools: modelTools, toolChoice: toSdkToolChoice(options.toolChoice) } : {}),
      ...(providerOptions ? { providerOptions } : {}),
      abortSignal: signal,
      maxRetries: 0,
    };

    try {
      if (streaming) {
        const result = streamText(common);
        let streamError: unknown;
        try {
          for await (const chunk of result.fullStream) {
            /* Any chunk proves the stream alive — reasoning deltas included.
               Only text was armed before, so a reasoning-only stall ran past
               the idle deadline on a technicality. */
            if (chunk.type !== 'error') streamingTimeout?.chunk();
            if (chunk.type === 'text-delta') {
              options.onToken?.(chunk.text);
            }
            if (chunk.type === 'error') streamError = chunk.error;
          }
        } finally {
          streamingTimeout?.dispose();
        }
        if (streamError) throw streamError;
        const [text, content, finishReason, usage, reasoningText] = await materializeWithTimeout(Promise.all([
          result.text,
          result.content,
          result.finishReason,
          result.totalUsage,
          result.reasoningText,
        ]));
        const toolCalls = toolCallsFrom(content);
        return {
          ok: true,
          data: engineResponse(text, toolCalls, finishReason, target.model, usage, reasoningText),
          fullContent: text,
          usage: toTokenUsage(usage),
          observations: responseHeadersToObservations(responseHeaders, scopeId),
        };
      }

      const result = await generateText(common);
      const toolCalls = toolCallsFrom(result.content);
      return {
        ok: true,
        data: engineResponse(result.text, toolCalls, result.finishReason, target.model, result.totalUsage, result.reasoningText),
        usage: toTokenUsage(result.totalUsage),
        observations: responseHeadersToObservations(responseHeaders, scopeId),
      };
    } catch (error) {
      if (options.signal?.aborted) throw error;
      const status = statusCodeOf(error);
      const errorHeaders = errorHeadersOf(error) ?? responseHeaders;
      if (status === 429) {
        lastFailure = 'rate-limit';
        /* The wait is recorded as an observation and handed to smart routing,
           which is what decides when this route may be used again. */
        const waitMs = retryAfterMs(errorHeaders);
        lastObservations = [{
          scopeId,
          source: 'retry-after',
          observedAt: new Date().toISOString(),
          retryAfterSeconds: waitMs === null ? null : waitMs / 1000,
        }];
      } else if (status === 401 || status === 403) {
        lastFailure = 'auth';
      } else {
        lastFailure = 'transient';
      }
      lastDetail = error instanceof Error ? error.message : String(error);
      logError(label, target.url, status ?? 0, error instanceof Error ? error.message : String(error));
    }
  }
  return { ok: false, reason: lastFailure, observations: lastObservations, detail: lastDetail };
}

async function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (signal?.aborted) throw new Error('cancelled');
    await new Promise((resolve) => setTimeout(resolve, Math.min(200, ms)));
  }
}

async function runLLM(options: LLMOptions, streaming: boolean): Promise<LLMResult> {
  const label = options.label || (streaming ? 'callLLMStream' : 'callLLM');
  const tried: string[] = [];
  const startTime = Date.now();
  const maxDurationMs = 120_000;
  /* A single route that is merely busy must not end the run. The same
     `withRetry` that protects search and fetch wraps each attempt here, so a
     429 from a busy provider is waited out instead of dropped. Previously the
     loop below spun on `getMinRecoveryMs()` without ever issuing a second
     request: a 429 at second two became a dead run at second 120, and the
     message said targets were exhausted when the only target was asleep. */
  const retryDelays = getConfig().research.retryDelaysMs;
  /* Counts real requests, not loop turns, so the closing message can tell the
     difference between "tried five times" and "spun for two minutes". */
  let attempts = 0;

  while (Date.now() - startTime < maxDurationMs) {
    if (options.signal?.aborted) throw new Error(`${label} cancelled`);
    const selection = smartRouting.selectTarget(options.role, {
      toolCall: Boolean(options.tools?.length),
      reasoning: Boolean(options.reasoningEffort && options.reasoningEffort !== 'none' && options.reasoningEffort !== 'minimal'),
    });
    if (!selection) {
      /* Every route is cooling off. Wait for the shortest recovery and try
         again, bounded by the same deadline as the rest of the loop. Before
         this, one target out of one that was merely busy ended the run. */
      const waitMs = smartRouting.getMinRecoveryMs();
      const remaining = maxDurationMs - (Date.now() - startTime);
      if (waitMs && waitMs > 0 && remaining > 0) {
        await sleepWithSignal(Math.min(waitMs, remaining), options.signal);
        continue;
      }
      throw new Error(`${label} - all targets are blocked or unavailable.\n${tried.map((item) => `  • ${item}`).join('\n')}`);
    }

    options.onModelSelected?.(selection.target.model, selection.target.id);
    /* Recorded before the call so a run that dies mid-flight still shows which
       route was taken and what was sent to it. */
    if (options.traceId) {
      traceEvent(options.traceId, 'llm.attempt', {
        label,
        role: options.role,
        target: `${selection.target.id}/${selection.target.model}`,
        stream: streaming,
        temperature: options.temperature ?? 0.7,
        reasoning_effort: options.reasoningEffort ?? null,
        tools: (options.tools ?? []).map((t) => {
          const fn = (t as { function?: { name?: string } }).function;
          return fn?.name ?? 'unknown';
        }),
messages: summarizeMessages(options.messages),
  /* The summary above counts the conversation but cannot be audited. A question
     about where a wrong claim came from — which page the model read, what the
     page actually said, whether the model contradicted it — needs the prompt as
     sent, and the summary had no copy of it. The JSONL line grows with the
     context, so a long run produces a large file; that is the trade for being
     able to answer the question at all, and it is opt-in with the rest of the
     trace. */
  messages_full: options.messages,
  }, options.traceRound);
      traceLive(
        options.traceId,
        `ROUND ${options.traceRound ?? '?'} LLM INPUT (${selection.target.id}/${selection.target.model})`,
        formatMessagesFull(options.messages),
      );
    }
    /* `callSelectedTarget` reports a failure by returning `{ok:false}` rather
       than throwing, because it already handled the provider error. `withRetry`
       retries on a throw, so this adapter turns a retryable failure into one.
       An auth failure is deliberately not thrown: a revoked or wrong key will
       not fix itself, and retrying it five times just delays the real error. */
    const callOnce = async (): Promise<AttemptResult | null> => {
      attempts++;
      const r = await callSelectedTarget(selection.target, options, streaming, label);
      if (r === null || r.ok) return r;
      if (r.reason === 'auth') return r;
      const err = new Error(
        `${selection.target.id}/${selection.target.model} -> ${r.reason}${r.detail ? `: ${r.detail}` : ''}`,
      ) as Error & { retryable: true };
      err.retryable = true;
      throw err;
    };
    let retryAfter: number | undefined;
    const attempt = await withRetry(label, retryDelaysForFinalAnswer(retryDelays, options.finalAnswer), callOnce, {
      signal: options.signal,
      retryAfterMs: () => retryAfter,
      onRetry: (info) => {
        if (options.traceId) {
          traceEvent(options.traceId, 'llm.retry', {
            label,
            target: `${selection.target.id}/${selection.target.model}`,
            attempt: info.attempt,
            delay_ms: info.delayMs,
            reason: info.error,
          }, options.traceRound);
        }
      },
    });
    const result = attempt.ok ? (attempt.value ?? null) : null;
    if (result?.ok) {
      if (options.traceId) {
        /* Same shape the engine reads: choices[0].message. Anything else
           records empty fields while the run itself works fine. */
        const dataRec = asRecord(result.data);
        const choices = Array.isArray(dataRec.choices) ? dataRec.choices : [];
        const choiceMsg = asRecord(choices[0]);
        const choiceMessage = asRecord(choiceMsg.message ?? choiceMsg);
        const choiceCalls = Array.isArray(choiceMessage.tool_calls)
          ? choiceMessage.tool_calls.map((c) => {
            const fn = asRecord(asRecord(c).function);
            return { name: String(fn.name ?? 'unknown'), arguments: fn.arguments };
          })
          : [];
        traceEvent(options.traceId, 'llm.response', {
          label,
          target: `${selection.target.id}/${selection.target.model}`,
          text: typeof choiceMessage.content === 'string' ? choiceMessage.content : null,
          reasoning: choiceMessage.reasoning ?? choiceMessage.reasoning_content ?? null,
          tool_calls: choiceCalls,
          finish_reason: choiceMsg.finish_reason ?? choiceMsg.finishReason ?? null,
          usage: result.usage,
        }, options.traceRound);
        const calls = choiceCalls.length > 0
          ? choiceCalls.map((c) => `[tool_call ${c.name}]\n${typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments ?? {})}`).join('\n')
          : '(no tool calls)';
        const responseText = typeof choiceMessage.content === 'string' ? choiceMessage.content : null;
        const responseReasoning = choiceMessage.reasoning ?? choiceMessage.reasoning_content;
        traceLive(
          options.traceId,
          `ROUND ${options.traceRound ?? '?'} LLM OUTPUT (finish: ${String(choiceMsg.finish_reason ?? choiceMsg.finishReason ?? 'unknown')})`,
          `--- TEXT ---\n${responseText ?? '(no text)'}\n\n--- REASONING ---\n${typeof responseReasoning === 'string' && responseReasoning ? responseReasoning : '(none)'}\n\n--- TOOL CALLS ---\n${calls}`,
        );
      }
      smartRouting.recordOutcome(selection.leaseId, 'success', {
        observations: result.observations,
        usage: result.usage,
        detail: `${selection.target.id}/${selection.target.model}`,
      });
      smartRouting.saveSnapshot();
      return {
        data: result.data,
        fullContent: result.fullContent,
        model: selection.target.model,
        provider: selection.target.id,
        usage: result.usage,
      };
    }

    if (!attempt.ok) {
      /* withRetry exhausted its attempts and the error carries the real
         failure. Reporting it as "no enabled keys" sent the reader looking for
         a missing key while the provider was timing out (measured
         `j-mRe99qbCJUfv`). */
      const reason = attempt.error ?? `${selection.target.id}/${selection.target.model} failed after retries`;
      tried.push(reason);
      smartRouting.recordOutcome(selection.leaseId, 'transient-failure', { detail: reason });
    } else if (result === null) {
      tried.push(`${selection.target.id}/${selection.target.model} -> no enabled keys`);
      smartRouting.recordOutcome(selection.leaseId, 'transient-failure', { detail: 'Model skipped (no enabled key)' });
    } else {
      const kind = result.reason === 'auth' ? 'auth-failure' : result.reason === 'rate-limit' ? 'rate-limit' : 'transient-failure';
      tried.push(`${selection.target.id}/${selection.target.model} -> ${result.reason}${result.detail ? `: ${result.detail}` : ''}`);
      smartRouting.recordOutcome(selection.leaseId, kind, {
        observations: result.observations,
        detail: `${selection.target.id}/${selection.target.model} -> ${result.reason}`,
      });
    }
    /* Why a route was dropped is the single most useful line when a run ends
       badly, so failures are recorded as loudly as successes. */
    if (options.traceId) {
      traceEvent(options.traceId, 'llm.error', {
        label,
        target: `${selection.target.id}/${selection.target.model}`,
        reason: !attempt.ok
          ? (attempt.error ?? 'failed after retries')
          : result === null ? 'no enabled keys' : result.reason,
        tried_so_far: tried,
        observations: result && 'observations' in result ? result.observations : [],
      }, options.traceRound);
    }
    smartRouting.saveSnapshot();
  }

  /* "Exhausted" is only true when there was nothing left to try. A single route
     that stayed busy is a timeout, and saying otherwise sent the reader looking
     for a fallback model that does not exist. */
  const distinctRoutes = new Set(tried.map((item) => item.split(' -> ')[0]));
  const stillRoutable = distinctRoutes.size > 0 && distinctRoutes.size < configuredRouteCount();
  const summary = stillRoutable
    ? `${label} — the only configured route stayed unavailable for ${Math.round((Date.now() - startTime) / 1000)}s after ${attempts} attempts.`
    : `${label} — all targets exhausted or timed out after ${attempts} attempts.`;
  const exhausted = new Error(`${summary}\n${tried.map((item) => `  • ${item}`).join('\n')}`);
  if (options.traceId) {
    traceEvent(options.traceId, 'llm.error', {
      label,
      reason: stillRoutable ? 'only route unavailable' : 'all targets exhausted',
      attempts,
      elapsed_ms: Date.now() - startTime,
      tried,
    }, options.traceRound);
  }
  throw exhausted;
}

/**
 * How many routes are configured, used only to word the failure correctly.
 * A run with one provider and one model is the common case here, and it is the
 * case where "all targets exhausted" is the wrong thing to say.
 */
function configuredRouteCount(): number {
  try {
    const providers = loadSettings().providers;
    let count = 0;
    for (const provider of Object.values(providers)) {
      if (provider.enabled === false) continue;
      count += provider.models?.length ?? 0;
    }
    return count;
  } catch {
    return 0;
  }
}

export async function callLLM(options: LLMOptions): Promise<LLMResult> {
  return runLLM(options, false);
}

export async function callLLMStream(options: LLMOptions): Promise<LLMResult> {
  return runLLM(options, true);
}

export function stripThinkingTags(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*$/gi, '')
    .replace(/<\/?think>/gi, '')
    .trim();
}

/**
 * Reasoning that arrived embedded in `<think>` blocks rather than in a
 * dedicated field. Kept verbatim for the conversation: stripping it for
 * display must never delete the deliberation a thinking model works from.
 */
export function extractThinkBlockText(text: string): string | null {
  const blocks = [...text.matchAll(/<think>([\s\S]*?)(?:<\/think>|$)/gi)];
  const kept = blocks.map((block) => block[1].trim()).filter((part) => part.length > 0);
  return kept.length > 0 ? kept.join('\n\n') : null;
}

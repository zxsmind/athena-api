import { loadSettings } from './settings-store.js';
import { parseRetryAfterMs, recordRateLimitHit, recordRateLimitSuccess } from './engine/rate-signals.js';
import fs from 'fs';
import path from 'path';
import { buildLLMRequestBody } from './llm-utils.js';
import { smartRouting } from './smart-routing-bridge.js';

const LOG_FILE = path.resolve(process.cwd(), 'llm-errors.log');

function logError(label: string, target: string, status: number, body: string): void {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${label}] [${status}] ${target}\n${body}\n${'─'.repeat(80)}\n`;
  try { fs.appendFileSync(LOG_FILE, line, 'utf8'); } catch (e) { console.error('[logError] Failed to write log:', e); }
  console.error(`[${status}] ${label} (${target}):\n${body}`);
}

export type LLMRole = keyof import('./settings-store.js').ModelRouting;

export interface TargetReference {
  source: 'role' | 'provider';
  id: string;
  url: string;
  model: string;
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
  signal?: AbortSignal;
  responseFormat?: unknown;
}

export interface LLMResult {
  data?: unknown;
  fullContent?: string;
  model: string;
  provider: string;
}

function convertToGeminiBody(body: Record<string, unknown>, model: string, provider?: { reasoningEffort?: string; includeThoughts?: boolean; disabledThinkingModels?: string[] }): Record<string, unknown> {
  const messages = (body.messages || []) as Record<string, unknown>[];

  const systemParts: string[] = [];
  const chatMessages: Record<string, unknown>[] = [];
  for (const msg of messages) {
    if (msg.role === 'system') {
      systemParts.push(String(msg.content || ''));
    } else {
      chatMessages.push(msg);
    }
  }

  const toolCallIdToName = new Map<string, string>();
  for (const msg of chatMessages) {
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of (msg.tool_calls as Record<string, unknown>[])) {
        toolCallIdToName.set(tc.id as string, ((tc.function as Record<string, unknown>)?.name) as string);
      }
    }
  }

  const contents: Record<string, unknown>[] = [];
  for (const msg of chatMessages) {
    if (msg.role === 'tool') {
      const tcId = msg.tool_call_id as string;
      const funcName = toolCallIdToName.get(tcId) || 'unknown';
      const raw = msg.content;
      let response: Record<string, unknown> = { result: String(raw || '') };
      if (typeof raw === 'string') { try { const p = JSON.parse(raw); if (typeof p === 'object') response = p; } catch { /* tool payload is plain text */ } }
      contents.push({ role: 'user', parts: [{ functionResponse: { name: funcName, response } }] });
    } else if (msg.role === 'assistant') {
      const parts: Record<string, unknown>[] = [];
      if (msg.content) parts.push({ text: String(msg.content) });
      if (msg.tool_calls) {
        for (const tc of (msg.tool_calls as Record<string, unknown>[])) {
          const func = tc.function as Record<string, unknown> || {};
          let args: Record<string, unknown> = {};
          if (typeof func.arguments === 'string') { try { args = JSON.parse(func.arguments); } catch { /* provider returned malformed tool args */ } }
          else if (typeof func.arguments === 'object') args = func.arguments as Record<string, unknown>;
          parts.push({ functionCall: { name: func.name, args: args || {} } });
        }
      }
      contents.push({ role: 'model', parts });
    } else {
      const parts: Record<string, unknown>[] = [];
      if (msg.content) parts.push({ text: String(msg.content) });
      contents.push({ role: 'user', parts });
    }
  }

  const geminiBody: Record<string, unknown> = { contents };
  if (systemParts.length > 0) {
    geminiBody.system_instruction = { parts: [{ text: systemParts.join('\n') }] };
  }

  const genConfig: Record<string, unknown> = {};
  if (body.temperature != null) genConfig.temperature = body.temperature;
  if (body.max_completion_tokens != null) genConfig.maxOutputTokens = body.max_completion_tokens as number;

  const disabled = provider?.disabledThinkingModels;
  const isDisabled = Array.isArray(disabled) && disabled.includes(model);
  if (!isDisabled) {
    let budget = -1; // Default dynamic budget
    if (provider?.reasoningEffort === 'none' || provider?.reasoningEffort === 'minimal') {
      budget = 0; // Disable thinking
    } else if (provider?.reasoningEffort === 'low') {
      budget = 2048;
    } else if (provider?.reasoningEffort === 'medium') {
      budget = 8192;
    } else if (provider?.reasoningEffort === 'high') {
      budget = 16384;
    }
    genConfig.thinkingConfig = {
      thinkingBudget: budget,
      includeThoughts: budget !== 0,
    };
  } else {
    genConfig.thinkingConfig = {
      thinkingBudget: 0,
      includeThoughts: false,
    };
  }

  if (Object.keys(genConfig).length > 0) {
    geminiBody.generationConfig = genConfig;
  }

  if (body.tools) {
    const openAITools = body.tools as Record<string, unknown>[];
    geminiBody.tools = openAITools.map(t => ({
      functionDeclarations: [(t.function as Record<string, unknown>) || {}],
    }));
  }

  return geminiBody;
}

function buildGeminiUrl(baseUrl: string, model: string, stream: boolean): string {
  const base = baseUrl.replace(/\/+$/, '');
  return stream
    ? `${base}/models/${model}:streamGenerateContent?alt=sse`
    : `${base}/models/${model}:generateContent`;
}

function parseNonSseGeminiResponse(
  data: unknown,
  fullContentRef: { value: string },
  toolCallAccumulators: Map<number, Record<string, unknown>>,
  onToken?: (text: string) => void,
): void {
  const items = Array.isArray(data) ? data : [data];
  for (const item of items) {
    const candidates = (item as Record<string, unknown>)?.candidates as Record<string, unknown>[] | undefined;
    if (!candidates?.length) continue;
    const content = (candidates[0]?.content as Record<string, unknown> | undefined);
    const parts = content?.parts as Record<string, unknown>[] | undefined;
    if (!parts) continue;
    for (const part of parts) {
      if (part.text && !part.thought) {
        const text = String(part.text);
        fullContentRef.value += text;
        onToken?.(text);
      }
      const fc = part.functionCall as Record<string, unknown> | undefined;
      if (fc) {
        const tcIndex = toolCallAccumulators.size;
        toolCallAccumulators.set(tcIndex, {
          id: `call_${Date.now()}_${tcIndex}`,
          type: 'function',
          function: { name: fc.name as string, arguments: JSON.stringify(fc.args || {}) },
        });
      }
    }
  }
}

function parseNonSseOpenAiResponse(
  data: unknown,
  fullContentRef: { value: string },
  toolCallAccumulators: Map<number, Record<string, unknown>>,
  onToken?: (text: string) => void,
): void {
  const d = data as Record<string, unknown>;
  const choices = d.choices as Record<string, unknown>[] | undefined;
  if (!choices?.length) return;
  const msg = choices[0].message as Record<string, unknown> | undefined;
  if (!msg) return;
  if (msg.content) {
    const text = stripThinkingTags(String(msg.content));
    if (text) {
      fullContentRef.value += text;
      onToken?.(text);
    }
  }
  const toolCalls = msg.tool_calls as Record<string, unknown>[] | undefined;
  if (toolCalls) {
    for (const tc of toolCalls) {
      const tcIndex = toolCallAccumulators.size;
      toolCallAccumulators.set(tcIndex, {
        id: tc.id as string || `call_${Date.now()}_${tcIndex}`,
        type: 'function',
        function: tc.function as Record<string, unknown>,
      });
    }
  }
}

function normalizeGeminiResponse(data: unknown, model: string): unknown {
  const d = data as Record<string, unknown>;
  const candidates = (d.candidates || []) as unknown[];
  if (candidates.length === 0) return data;
  const c = candidates[0] as Record<string, unknown>;
  const content = c.content as Record<string, unknown> | undefined;
  const parts = (content?.parts || []) as Record<string, unknown>[];
  const text = parts.filter(p => !p.thought).map(p => String(p.text || '')).join('');
  const reasoning = parts.filter(p => p.thought).map(p => String(p.text || '')).join('');
  let finish = String(c.finishReason || 'stop');
  const toolCalls: Record<string, unknown>[] = [];
  for (const p of parts) {
    const pp = p as Record<string, unknown>;
    if (pp.functionCall) {
      const fc = pp.functionCall as Record<string, unknown>;
      toolCalls.push({
        id: `call_${Date.now()}_${toolCalls.length}`,
        type: 'function',
        function: { name: fc.name, arguments: JSON.stringify(fc.args || {}) },
      });
    }
  }
  if (toolCalls.length > 0 && finish === 'STOP') finish = 'tool_calls';
  const msg: Record<string, unknown> = { role: 'assistant', content: text || null };
  if (toolCalls.length > 0) msg.tool_calls = toolCalls;
  if (reasoning) msg.reasoning = reasoning;
  return {
    id: d.id || 'gemini-response',
    object: 'chat.completion',
    created: Date.now(),
    model,
    choices: [{ index: 0, message: msg, finish_reason: finish === 'STOP' ? 'stop' : (finish?.toLowerCase() || 'stop') }],
    usage: d.usage || {},
  };
}

export class ThinkStripper {
  private inThinkBlock = false;
  private streamBuffer = '';
  private onToken: (text: string) => void;
  private fullContentRef: { value: string };
  constructor(onToken: ((text: string) => void) | undefined, fullContentRef: { value: string }) {
    this.onToken = onToken || (() => {});
    this.fullContentRef = fullContentRef;
  }
  process(text: string) {
    this.streamBuffer += text;
    while (true) {
      if (!this.inThinkBlock) {
        const idx = this.streamBuffer.indexOf('<think>');
        if (idx !== -1) {
          const before = this.streamBuffer.slice(0, idx);
          if (before) { this.fullContentRef.value += before; this.onToken(before); }
          this.inThinkBlock = true;
          this.streamBuffer = this.streamBuffer.slice(idx + 7);
          continue;
        }
        const prefixes = ['<think', '<thin', '<thi', '<th', '<t', '<'];
        let matchedPrefix = false;
        for (const pfx of prefixes) {
          if (this.streamBuffer.endsWith(pfx)) {
            const pIdx = this.streamBuffer.length - pfx.length;
            const before = this.streamBuffer.slice(0, pIdx);
            if (before) { this.fullContentRef.value += before; this.onToken(before); }
            this.streamBuffer = this.streamBuffer.slice(pIdx);
            matchedPrefix = true; break;
          }
        }
        if (matchedPrefix) break;
        if (this.streamBuffer) { this.fullContentRef.value += this.streamBuffer; this.onToken(this.streamBuffer); this.streamBuffer = ''; }
        break;
      } else {
        const idx = this.streamBuffer.indexOf('</think>');
        if (idx !== -1) { this.inThinkBlock = false; this.streamBuffer = this.streamBuffer.slice(idx + 8); continue; }
        const prefixes = ['</think', '</thin', '</thi', '</th', '</t', '</', '<'];
        let matchedPrefix = false;
        for (const pfx of prefixes) {
          if (this.streamBuffer.endsWith(pfx)) { this.streamBuffer = this.streamBuffer.slice(this.streamBuffer.length - pfx.length); matchedPrefix = true; break; }
        }
        if (matchedPrefix) break;
        this.streamBuffer = '';
        break;
      }
    }
  }
  flush() { if (!this.inThinkBlock && this.streamBuffer) { this.fullContentRef.value += this.streamBuffer; this.onToken(this.streamBuffer); this.streamBuffer = ''; } }
}

export function stripThinkingTags(text: string): string {
  if (!text) return '';
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/<think>[\s\S]*/g, '');
}

function extractDeltaText(delta: unknown): string {
  if (!delta) return '';
  const d = delta as Record<string, unknown>;

  // Native Gemini streaming: candidates[0].content.parts[x].text
  const candidates = d.candidates as Record<string, unknown>[] | undefined;
  if (candidates?.length) {
    const c = candidates[0];
    const content = c?.content as Record<string, unknown> | undefined;
    const parts = content?.parts as Record<string, unknown>[] | undefined;
    if (parts?.length) {
      const textParts = parts.filter(p => !p.thought).map(p => String(p.text || ''));
      if (textParts.length > 0) return textParts.join('');
      const thoughtParts = parts.filter(p => p.thought).map(p => String(p.text || ''));
      if (thoughtParts.length > 0) return '';
    }
    return '';
  }

  // OpenAI-compatible format
  const GEMINI_CONTENT_FIELDS = ['content', 'text', 'message.content'];
  if (d.reasoning_content || d.reasoning || d.thought) {
    for (const path of GEMINI_CONTENT_FIELDS) {
      const val = path.split('.').reduce((o: Record<string, unknown> | undefined, k: string) => o?.[k] as Record<string, unknown> | undefined, d);
      if (val) return String(val);
    }
    return '';
  }
  for (const path of GEMINI_CONTENT_FIELDS) {
    const val = path.split('.').reduce((o: Record<string, unknown> | undefined, k: string) => o?.[k] as Record<string, unknown> | undefined, d);
    if (val) return String(val);
  }
  return '';
}

function makeRequestSignal(timeoutMs: number, external?: AbortSignal): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (external) {
    if (external.aborted) { controller.abort(); }
    else { external.addEventListener('abort', () => controller.abort(), { once: true }); }
  }
  return { signal: controller.signal, cleanup: () => clearTimeout(timer) };
}

import type { CapacityObservation } from '@mindbox/smart-routing-core';

type ProviderErrorKind = 'rate-limit' | 'auth' | 'transient';

type ProviderSuccess = { ok: true; data: unknown; provider: string; model: string; observations?: CapacityObservation[]; usage?: { tokens?: number; requests?: number } };
type ProviderFailure = { ok: false; reason: ProviderErrorKind; observations?: CapacityObservation[] };
type ProviderResult = ProviderSuccess | ProviderFailure | null;

function parseRateLimitHeaders(res: Response, scopeId: string): CapacityObservation[] {
  const obs: CapacityObservation[] = [];
  const now = new Date().toISOString();

  const reqLimit = res.headers.get('x-ratelimit-limit-requests');
  const reqRemaining = res.headers.get('x-ratelimit-remaining-requests');
  const reqReset = res.headers.get('x-ratelimit-reset-requests');
  if (reqLimit || reqRemaining || reqReset) {
    obs.push({
      scopeId,
      source: 'response-header',
      observedAt: now,
      request: {
        limit: reqLimit ? parseInt(reqLimit, 10) || null : null,
        remaining: reqRemaining ? parseInt(reqRemaining, 10) || null : null,
        resetAt: reqReset ? new Date(parseInt(reqReset, 10) * 1000).toISOString() : null,
      },
    });
  }

  const tokLimit = res.headers.get('x-ratelimit-limit-tokens');
  const tokRemaining = res.headers.get('x-ratelimit-remaining-tokens');
  const tokReset = res.headers.get('x-ratelimit-reset-tokens');
  if (tokLimit || tokRemaining || tokReset) {
    obs.push({
      scopeId,
      source: 'response-header',
      observedAt: now,
      tokens: {
        limit: tokLimit ? parseInt(tokLimit, 10) || null : null,
        remaining: tokRemaining ? parseInt(tokRemaining, 10) || null : null,
        resetAt: tokReset ? new Date(parseInt(tokReset, 10) * 1000).toISOString() : null,
      },
    });
  }

  return obs;
}

async function tryProvider(
  target: TargetReference,
  opts: LLMOptions,
  body: Record<string, unknown>,
  label: string,
  tried: string[],
): Promise<ProviderResult> {
  const model = target.model;

  const store = loadSettings();
  const provider = store.providers[target.id];
  if (!provider || provider.keys.length === 0) {
    tried.push(`${target.id}/${model} -> no keys`);
    return null;
  }

  const isGemini = target.id === 'gemini';
  const reqBody: Record<string, unknown> = isGemini
    ? convertToGeminiBody(body, model, provider)
    : { ...body, model, stream: false };

  if (!isGemini) {
    const supportsThinking = !provider.disabledThinkingModels || !provider.disabledThinkingModels.includes(model);
    if (supportsThinking && provider.reasoningEffort) {
      const allowedValues = target.id === 'groq' ? ['none', 'default'] : ['low', 'medium', 'high'];
      if (allowedValues.includes(provider.reasoningEffort)) {
        reqBody.reasoning_effort = provider.reasoningEffort;
      }
    }
  }

  const effectiveUrl = isGemini ? buildGeminiUrl(provider.url, model, false) : target.url;

  let lastError: ProviderErrorKind | null = null;
  let lastErrorObservations: CapacityObservation[] | null = null;

  for (const apiKey of provider.keys) {
    try {
      const { signal, cleanup } = makeRequestSignal(30000, opts.signal);
      try {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (isGemini) {
          headers['x-goog-api-key'] = apiKey;
        } else {
          headers['Authorization'] = `Bearer ${apiKey}`;
        }

        const res = await fetch(effectiveUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify(reqBody),
          signal,
        });

        if (res.status === 429) {
          const retryAfterMs = parseRetryAfterMs(res);
          recordRateLimitHit(retryAfterMs);
          tried.push(`${target.id}/${model} -> rate limited (key ${apiKey.slice(-6)})`);
          logError(label, effectiveUrl, 429, `Rate limited for ${model}. Key ending in: ${apiKey.slice(-6)}`);
          lastError = 'rate-limit';
          lastErrorObservations = [{
            scopeId: `${target.id}/${model}`,
            source: 'retry-after',
            observedAt: new Date().toISOString(),
            retryAfterSeconds: retryAfterMs && retryAfterMs > 0 ? retryAfterMs / 1000 : null,
          }];
          continue;
        }
        if (res.status === 401) {
          tried.push(`${target.id}/${model} -> unauthorized (key ${apiKey.slice(-6)})`);
          if (lastError !== 'rate-limit') lastError = 'auth';
          continue;
        }
        if (res.status === 400 || res.status === 404 || res.status === 413) {
          const errBody = await res.text().catch(() => '');
          tried.push(`${target.id}/${model} -> HTTP ${res.status}`);
          logError(label, effectiveUrl, res.status, `Model: ${model}\n${errBody}`);
          if (!lastError) lastError = 'transient';
          continue;
        }
        if (!res.ok) {
          const errBody = await res.text().catch(() => '');
          tried.push(`${target.id}/${model} -> HTTP ${res.status}`);
          logError(label, effectiveUrl, res.status, `Model: ${model}\n${errBody}`);
          if (!lastError) lastError = 'transient';
          continue;
        }

        let data: unknown = await res.json();
        if (isGemini || (data as Record<string, unknown>)?.candidates) {
          data = normalizeGeminiResponse(data, model);
        }

        const d = data as { choices?: { message?: { content?: string | null; tool_calls?: unknown }; finish_reason?: string }[] };
        const choice = d?.choices?.[0];
        const contentStr = choice?.message?.content;
        const hasContent = typeof contentStr === 'string' && contentStr.trim().length > 0;
        const hasToolCalls = Array.isArray(choice?.message?.tool_calls) && choice.message.tool_calls.length > 0;

        if (!hasContent && !hasToolCalls) {
          tried.push(`${target.id}/${model} -> empty content or safety block (finish_reason: ${choice?.finish_reason || 'unknown'})`);
          if (!lastError) lastError = 'transient';
          continue;
        }

        recordRateLimitSuccess();
        const obs = parseRateLimitHeaders(res, `${target.id}/${model}`);
        return { ok: true, data, provider: target.id, model, observations: obs.length > 0 ? obs : undefined };
      } finally {
        cleanup();
      }
    } catch (err: unknown) {
      tried.push(`${target.id}/${model} -> request failed`);
      logError(label, effectiveUrl, 0, `Model: ${model}\n${err instanceof Error ? err.message : String(err)}`);
      if (!lastError) lastError = 'transient';
    }
  }
  return lastError ? { ok: false, reason: lastError, observations: lastErrorObservations ?? undefined } : null;
}

async function tryProviderStream(
  target: TargetReference,
  opts: LLMOptions,
  body: Record<string, unknown>,
  label: string,
  tried: string[],
): Promise<ProviderSuccess & { fullContent?: string } | ProviderFailure | null> {
  const model = target.model;

  const store = loadSettings();
  const provider = store.providers[target.id];
  if (!provider || provider.keys.length === 0) {
    tried.push(`${target.id}/${model} -> no keys`);
    return null;
  }

  const isGemini = target.id === 'gemini';
  const reqBody: Record<string, unknown> = isGemini
    ? convertToGeminiBody(body, model, provider)
    : { ...body, model, stream: true };

  if (!isGemini) {
    const supportsThinking = !provider.disabledThinkingModels || !provider.disabledThinkingModels.includes(model);
    if (supportsThinking && provider.reasoningEffort) {
      const allowedValues = target.id === 'groq' ? ['none', 'default'] : ['low', 'medium', 'high'];
      if (allowedValues.includes(provider.reasoningEffort)) {
        reqBody.reasoning_effort = provider.reasoningEffort;
      }
    }
  }

  const effectiveUrl = isGemini ? buildGeminiUrl(provider.url, model, true) : target.url;

  let lastError: ProviderErrorKind | null = null;
  let lastErrorObservations: CapacityObservation[] | null = null;

  for (const apiKey of provider.keys) {
    try {
      const { signal, cleanup } = makeRequestSignal(opts.tools ? 60000 : 30000, opts.signal);
      try {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (isGemini) {
          headers['x-goog-api-key'] = apiKey;
        } else {
          headers['Authorization'] = `Bearer ${apiKey}`;
        }

        const res = await fetch(effectiveUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify(reqBody),
          signal,
        });

        if (res.status === 429) {
          const retryAfterMs = parseRetryAfterMs(res);
          recordRateLimitHit(retryAfterMs);
          tried.push(`${target.id}/${model} -> rate limited (key ${apiKey.slice(-6)})`);
          logError(label, effectiveUrl, 429, `Rate limited for ${model}. Key ending in: ${apiKey.slice(-6)}`);
          lastError = 'rate-limit';
          lastErrorObservations = [{
            scopeId: `${target.id}/${model}`,
            source: 'retry-after',
            observedAt: new Date().toISOString(),
            retryAfterSeconds: retryAfterMs && retryAfterMs > 0 ? retryAfterMs / 1000 : null,
          }];
          continue;
        }
        if (res.status === 401) {
          tried.push(`${target.id}/${model} -> unauthorized`);
          if (lastError !== 'rate-limit') lastError = 'auth';
          continue;
        }
        if (res.status === 400 || res.status === 404 || res.status === 413) {
          const errBody = await res.text().catch(() => '');
          tried.push(`${target.id}/${model} -> HTTP ${res.status}`);
          logError(label, effectiveUrl, res.status, `Model: ${model}\n${errBody}`);
          if (!lastError) lastError = 'transient';
          continue;
        }
        if (!res.ok) {
          const errBody = await res.text().catch(() => '');
          tried.push(`${target.id}/${model} -> HTTP ${res.status}`);
          logError(label, effectiveUrl, res.status, `Model: ${model}\n${errBody}`);
          if (!lastError) lastError = 'transient';
          continue;
        }

        let fullContent = '';
        const stripper = new ThinkStripper(opts.onToken, { value: '' });

        if (!res.body) {
          console.log(`[LLM] [${label}] ${target.id}/${model}: response body is empty (no stream)`);
          if (!lastError) lastError = 'transient';
          continue;
        }

        // Accumulators for tool calls and finish reason
        const toolCallAccumulators = new Map<number, Record<string, unknown>>();
        let lastFinishReason: string | null = null;
        let sseLinesSeen = 0;
        let jsonLinesParsed = 0;
        let jsonParseErrors = 0;
        let contentChunksSeen = 0;
        let toolCallChunksSeen = 0;
        let nonSseBuffer = '';

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            if (trimmed === 'data: [DONE]') {
              console.log(`[LLM] [${label}] ${target.id}/${model}: stream [DONE] received`);
              continue;
            }
            if (!trimmed.startsWith('data: ')) {
              nonSseBuffer += trimmed;
              console.log(`[LLM] [${label}] ${target.id}/${model}: non-SSE line (buffered): ${trimmed.slice(0, 200)}`);
              continue;
            }
            sseLinesSeen++;
            try {
              const json = JSON.parse(trimmed.slice(6));
              jsonLinesParsed++;

              const choiceFinish = json.choices?.[0]?.finish_reason as string | undefined;
              const candidateFinish = json.candidates?.[0]?.finishReason as string | undefined;
              if (choiceFinish) lastFinishReason = choiceFinish;
              if (candidateFinish) lastFinishReason = candidateFinish;

              if (isGemini) {
                const text = extractDeltaText(json);
                if (text) {
                  contentChunksSeen++;
                  stripper.process(text); fullContent += text;
                }
                const candidates = json.candidates as Record<string, unknown>[] | undefined;
                if (candidates?.length) {
                  const parts = (candidates[0]?.content as Record<string, unknown> | undefined)?.parts as Record<string, unknown>[] | undefined;
                  if (parts) {
                    for (const part of parts) {
                      const fc = part.functionCall as Record<string, unknown> | undefined;
                      if (fc) {
                        toolCallChunksSeen++;
                        const tcIndex = toolCallAccumulators.size;
                        toolCallAccumulators.set(tcIndex, {
                          id: `call_${Date.now()}_${tcIndex}`,
                          type: 'function',
                          function: { name: fc.name as string, arguments: JSON.stringify(fc.args || {}) },
                        });
                      }
                    }
                  }
                }
              } else {
                const delta = json.choices?.[0]?.delta;
                if (delta?.content) {
                  contentChunksSeen++;
                  const cleaned = stripThinkingTags(delta.content);
                  if (cleaned) { stripper.process(cleaned); fullContent += cleaned; }
                }
                if (delta?.tool_calls) {
                  toolCallChunksSeen++;
                  for (const tc of (delta.tool_calls as Record<string, unknown>[])) {
                    const idx = tc.index as number;
                    let acc = toolCallAccumulators.get(idx);
                    if (!acc) {
                      acc = { id: '', type: 'function', function: { name: '', arguments: '' } };
                      toolCallAccumulators.set(idx, acc);
                    }
                    if (tc.id) acc.id = tc.id as string;
                    const fn = acc.function as Record<string, unknown>;
                    const tcFn = tc.function as Record<string, unknown> | undefined;
                    if (tcFn?.name) fn.name = tcFn.name as string;
                    if (tcFn?.arguments) fn.arguments = (fn.arguments as string) + (tcFn.arguments as string);
                  }
                }
              }
            } catch (err) {
              jsonParseErrors++;
              console.log(`[LLM] [${label}] ${target.id}/${model}: malformed JSON in SSE line: ${trimmed.slice(0, 200)} — ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        }
        stripper.flush();

        if (sseLinesSeen === 0 && nonSseBuffer.trim().length > 0) {
          try {
            const parsed = JSON.parse(nonSseBuffer.trim());
            console.log(`[LLM] [${label}] ${target.id}/${model}: non-SSE fallback parse succeeded`);
            if (isGemini) {
              parseNonSseGeminiResponse(parsed, { value: fullContent }, toolCallAccumulators, opts.onToken);
            } else {
              parseNonSseOpenAiResponse(parsed, { value: fullContent }, toolCallAccumulators, opts.onToken);
            }
          } catch (err) {
            console.log(`[LLM] [${label}] ${target.id}/${model}: non-SSE fallback parse failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        console.log(`[LLM] [${label}] ${target.id}/${model}: stream summary — sseLines=${sseLinesSeen}, parsed=${jsonLinesParsed}, parseErrors=${jsonParseErrors}, contentChunks=${contentChunksSeen}, toolCallChunks=${toolCallChunksSeen}, finishReason=${lastFinishReason ?? '(none)'}, fullContentBytes=${fullContent.length}, toolCalls=${toolCallAccumulators.size}`);

        const hasContent = fullContent.trim().length > 0;
        const hasToolCalls = toolCallAccumulators.size > 0;
        if (!hasContent && !hasToolCalls) {
          tried.push(`${target.id}/${model} -> empty stream (finish_reason: ${lastFinishReason || 'unknown'})`);
          console.log(`[LLM] [${label}] ${target.id}/${model}: empty stream, will try next key/provider`);
          if (!lastError) lastError = 'transient';
          continue;
        }

        recordRateLimitSuccess();

        const accumulatedTools = Array.from(toolCallAccumulators.values());
        const finishReason = lastFinishReason || 'stop';
        const normalizedFinishReason = finishReason === 'STOP' ? 'stop' : (finishReason === 'TOOL_CALLS' ? 'tool_calls' : finishReason.toLowerCase());
        const message: Record<string, unknown> = { role: 'assistant', content: fullContent || null };
        if (accumulatedTools.length > 0) message.tool_calls = accumulatedTools;

        const data = {
          id: `stream-${model}-${Date.now()}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, message, finish_reason: normalizedFinishReason }],
        };

        const obs = parseRateLimitHeaders(res, `${target.id}/${model}`);
        return { ok: true, data, fullContent, provider: target.id, model, observations: obs.length > 0 ? obs : undefined };
      } finally {
        cleanup();
      }
    } catch (err: unknown) {
      tried.push(`${target.id}/${model} -> request failed`);
      logError(label, effectiveUrl, 0, `Model: ${model}\n${err instanceof Error ? err.message : String(err)}`);
      if (!lastError) lastError = 'transient';
    }
  }
  return lastError ? { ok: false, reason: lastError, observations: lastErrorObservations ?? undefined } : null;
}

async function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (signal?.aborted) throw new Error('cancelled');
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}

export async function callLLM(opts: LLMOptions): Promise<LLMResult> {
  const label = opts.label || 'callLLM';
  const body = buildLLMRequestBody(opts);
  const tried: string[] = [];
  const startTime = Date.now();
  const MAX_LOOP_MS = 120000;

  while (Date.now() - startTime < MAX_LOOP_MS) {
    if (opts.signal?.aborted) throw new Error(`${label} cancelled`);

    const selection = smartRouting.selectTarget(opts.role);
    if (!selection) {
      const waitMs = smartRouting.getMinRecoveryMs();
      if (waitMs && waitMs > 0) {
        await sleepWithSignal(Math.min(waitMs, 30000), opts.signal);
        continue;
      }
      throw new Error(`${label} — all targets are blocked or unavailable.\n${tried.map(r => `  • ${r}`).join('\n')}`);
    }

    if (opts.onModelSelected) {
      opts.onModelSelected(selection.target.model, selection.target.id);
    }

    const result = await tryProvider(selection.target, opts, body, label, tried);
    if (result && result.ok) {
      smartRouting.recordOutcome(selection.leaseId, 'success', {
        observations: result.observations,
        usage: result.usage,
        detail: `${selection.target.id}/${selection.target.model}`,
      });
      smartRouting.saveSnapshot();
      return { data: result.data, model: result.model, provider: result.provider };
    }

    if (result === null) {
      smartRouting.recordOutcome(selection.leaseId, 'transient-failure', { detail: 'Model skipped (no keys or unsupported)' });
    } else {
      const kind = result.reason === 'auth' ? 'auth-failure' : result.reason === 'transient' ? 'transient-failure' : result.reason;
      smartRouting.recordOutcome(selection.leaseId, kind, {
        observations: result.observations,
        detail: `${selection.target.id}/${selection.target.model} -> ${result.reason}`,
      });
    }
    smartRouting.saveSnapshot();
  }

  throw new Error(`${label} — all targets exhausted or timed out.\n${tried.map(r => `  • ${r}`).join('\n')}`);
}

export async function callLLMStream(opts: LLMOptions): Promise<LLMResult> {
  const label = opts.label || 'callLLMStream';
  const body = buildLLMRequestBody(opts);
  const tried: string[] = [];
  const startTime = Date.now();
  const MAX_LOOP_MS = 120000;

  while (Date.now() - startTime < MAX_LOOP_MS) {
    if (opts.signal?.aborted) throw new Error(`${label} cancelled`);

    const selection = smartRouting.selectTarget(opts.role);
    if (!selection) {
      const waitMs = smartRouting.getMinRecoveryMs();
      if (waitMs && waitMs > 0) {
        await sleepWithSignal(Math.min(waitMs, 30000), opts.signal);
        continue;
      }
      throw new Error(`${label} — all targets are blocked or unavailable.\n${tried.map(r => `  • ${r}`).join('\n')}`);
    }

    if (opts.onModelSelected) {
      opts.onModelSelected(selection.target.model, selection.target.id);
    }

    const result = await tryProviderStream(selection.target, opts, body, label, tried);
    if (result && result.ok) {
      smartRouting.recordOutcome(selection.leaseId, 'success', {
        observations: result.observations,
        usage: result.usage,
        detail: `${selection.target.id}/${selection.target.model}`,
      });
      smartRouting.saveSnapshot();
      return { data: result.data, fullContent: result.fullContent, model: result.model, provider: result.provider };
    }

    if (result === null) {
      smartRouting.recordOutcome(selection.leaseId, 'transient-failure', { detail: 'Model skipped (no keys or unsupported)' });
    } else {
      const kind = result.reason === 'auth' ? 'auth-failure' : result.reason === 'transient' ? 'transient-failure' : result.reason;
      smartRouting.recordOutcome(selection.leaseId, kind, {
        observations: result.observations,
        detail: `${selection.target.id}/${selection.target.model} -> ${result.reason}`,
      });
    }
    smartRouting.saveSnapshot();
  }

  throw new Error(`${label} — all targets exhausted or timed out.\n${tried.map(r => `  • ${r}`).join('\n')}`);
}

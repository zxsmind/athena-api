import { loadSettings } from './settings-store.js';
import { parseRetryAfterMs, recordRateLimitHit, recordRateLimitSuccess } from './engine/rate-signals.js';
import fs from 'fs';
import path from 'path';
import { resolveTargets, modelSupportsTools, buildLLMRequestBody, learnedNoToolCalling } from './llm-utils.js';

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

  const isFlash = /flash/i.test(model);
  const disabled = provider?.disabledThinkingModels;
  const isDisabled = Array.isArray(disabled) && disabled.includes(model);
  if (!isFlash && !isDisabled && provider?.reasoningEffort && ['low', 'medium', 'high'].includes(provider.reasoningEffort)) {
    genConfig.thinking_level = provider.reasoningEffort;
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
    ? `${base}/models/${model}:streamGenerateContent`
    : `${base}/models/${model}:generateContent`;
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

async function tryProvider(
  target: TargetReference,
  opts: LLMOptions,
  body: Record<string, unknown>,
  label: string,
  tried: string[],
): Promise<{ data: unknown; provider: string; model: string } | null> {
  const model = target.model;
  if (opts.tools && !modelSupportsTools(model)) {
    tried.push(`${target.id}/${model} -> skipped (no tool calling support)`);
    return null;
  }

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
    if (supportsThinking && provider.reasoningEffort && ['low', 'medium', 'high'].includes(provider.reasoningEffort)) {
      reqBody.reasoning_effort = provider.reasoningEffort;
    }
  }

  const effectiveUrl = isGemini ? buildGeminiUrl(provider.url, model, false) : target.url;

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
          recordRateLimitHit(parseRetryAfterMs(res));
          tried.push(`${target.id}/${model} -> rate limited (key ${apiKey.slice(-6)})`);
          logError(label, effectiveUrl, 429, `Rate limited for ${model}. Key ending in: ${apiKey.slice(-6)}`);
          continue;
        }
        if (res.status === 401) {
          tried.push(`${target.id}/${model} -> unauthorized (key ${apiKey.slice(-6)})`);
          continue;
        }
        if (res.status === 400 || res.status === 404 || res.status === 413) {
          const errBody = await res.text().catch(() => '');
          tried.push(`${target.id}/${model} -> HTTP ${res.status}`);
          logError(label, effectiveUrl, res.status, `Model: ${model}\n${errBody}`);
          if (res.status === 400 && opts.tools) learnedNoToolCalling.add(model);
          return null;
        }
        if (!res.ok) {
          const errBody = await res.text().catch(() => '');
          tried.push(`${target.id}/${model} -> HTTP ${res.status}`);
          logError(label, effectiveUrl, res.status, `Model: ${model}\n${errBody}`);
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
          continue;
        }

        recordRateLimitSuccess();
        return { data, provider: target.id, model };
      } finally {
        cleanup();
      }
    } catch (err: unknown) {
      tried.push(`${target.id}/${model} -> request failed`);
      logError(label, effectiveUrl, 0, `Model: ${model}\n${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return null;
}

async function tryProviderStream(
  target: TargetReference,
  opts: LLMOptions,
  body: Record<string, unknown>,
  label: string,
  tried: string[],
): Promise<{ data: unknown; fullContent: string; provider: string; model: string } | null> {
  const model = target.model;
  if (opts.tools && !modelSupportsTools(model)) {
    tried.push(`${target.id}/${model} -> skipped (no tool calling support)`);
    return null;
  }

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
    if (supportsThinking && provider.reasoningEffort && ['low', 'medium', 'high'].includes(provider.reasoningEffort)) {
      reqBody.reasoning_effort = provider.reasoningEffort;
    }
  }

  const effectiveUrl = isGemini ? buildGeminiUrl(provider.url, model, true) : target.url;

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
          recordRateLimitHit(parseRetryAfterMs(res));
          tried.push(`${target.id}/${model} -> rate limited (key ${apiKey.slice(-6)})`);
          logError(label, effectiveUrl, 429, `Rate limited for ${model}. Key ending in: ${apiKey.slice(-6)}`);
          continue;
        }
        if (res.status === 401) {
          tried.push(`${target.id}/${model} -> unauthorized`);
          continue;
        }
        if (res.status === 400 || res.status === 404 || res.status === 413) {
          const errBody = await res.text().catch(() => '');
          tried.push(`${target.id}/${model} -> HTTP ${res.status}`);
          logError(label, effectiveUrl, res.status, `Model: ${model}\n${errBody}`);
          if (res.status === 400 && opts.tools) learnedNoToolCalling.add(model);
          return null;
        }
        if (!res.ok) {
          const errBody = await res.text().catch(() => '');
          tried.push(`${target.id}/${model} -> HTTP ${res.status}`);
          logError(label, effectiveUrl, res.status, `Model: ${model}\n${errBody}`);
          continue;
        }

        let fullContent = '';
        const stripper = new ThinkStripper(opts.onToken, { value: '' });

        if (!res.body) return null;

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
            if (!trimmed || trimmed === 'data: [DONE]') continue;
            if (trimmed.startsWith('data: ')) {
              try {
                const json = JSON.parse(trimmed.slice(6));
                if (isGemini) {
                  const text = extractDeltaText(json);
                  if (text) { stripper.process(text); fullContent += text; }
                } else {
                  const delta = json.choices?.[0]?.delta;
                  if (delta?.content) {
                    const cleaned = stripThinkingTags(delta.content);
                    if (cleaned) { stripper.process(cleaned); fullContent += cleaned; }
                  }
                }
              } catch { /* skip malformed */ }
            }
          }
        }
        stripper.flush();

        recordRateLimitSuccess();
        return { data: null, fullContent, provider: target.id, model };
      } finally {
        cleanup();
      }
    } catch (err: unknown) {
      tried.push(`${target.id}/${model} -> request failed`);
      logError(label, effectiveUrl, 0, `Model: ${model}\n${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return null;
}

async function globalRetryBackoff(globalAttempt: number, opts: LLMOptions, label: string) {
  const backoffMs = Math.pow(2, globalAttempt) * 1000;
  console.log(`[LLM] [Deep Mode] All targets exhausted. Waiting ${backoffMs / 1000}s before global retry ${globalAttempt}...`);
  const startTime = Date.now();
  while (Date.now() - startTime < backoffMs) {
    if (opts.signal?.aborted) throw new Error(`${label} cancelled`);
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}

export async function callLLM(opts: LLMOptions): Promise<LLMResult> {
  const label = opts.label || 'callLLM';
  const { uniqTargets, tried } = resolveTargets(opts.role, label, opts.signal);
  const body = buildLLMRequestBody(opts);
  const maxGlobalAttempts = opts.role === 'deep' ? 5 : 1;
  for (let attempt = 0; attempt < maxGlobalAttempts; attempt++) {
    if (attempt > 0) await globalRetryBackoff(attempt, opts, label);
    for (const target of uniqTargets) {
      const result = await tryProvider(target, opts, body, label, tried);
      if (result) return result;
    }
  }
  throw new Error(`${label} — all targets failed after ${maxGlobalAttempts} global attempt(s).\n${tried.map(r => `  • ${r}`).join('\n')}`);
}

export async function callLLMStream(opts: LLMOptions): Promise<LLMResult> {
  const label = opts.label || 'callLLMStream';
  const { uniqTargets, tried } = resolveTargets(opts.role, label, opts.signal);
  const body = buildLLMRequestBody(opts);
  const maxGlobalAttempts = opts.role === 'deep' ? 5 : 1;
  for (let attempt = 0; attempt < maxGlobalAttempts; attempt++) {
    if (attempt > 0) await globalRetryBackoff(attempt, opts, label);
    for (const target of uniqTargets) {
      const result = await tryProviderStream(target, opts, body, label, tried);
      if (result) return result;
    }
  }
  throw new Error(`${label} — all targets failed after ${maxGlobalAttempts} global attempt(s).\n${tried.map(r => `  • ${r}`).join('\n')}`);
}

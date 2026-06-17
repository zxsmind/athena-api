import { loadSettings } from './settings-store.js';
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

function normalizeGeminiResponse(data: unknown, model: string): unknown {
  const d = data as Record<string, unknown>;
  const candidates = (d.candidates || []) as unknown[];
  if (candidates.length === 0) return data;
  const c = candidates[0] as Record<string, unknown>;
  const content = c.content as Record<string, unknown> | undefined;
  const parts = (content?.parts || []) as Record<string, unknown>[];
  const text = parts.map(p => String(p.text || '')).join('');
  const finish = String(c.finishReason || 'stop');
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
  const msg: Record<string, unknown> = { role: 'assistant', content: text || null };
  if (toolCalls.length > 0) msg.tool_calls = toolCalls;
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

const GEMINI_CONTENT_FIELDS = ['content', 'text', 'message.content'];
function extractDeltaText(delta: unknown): string {
  if (!delta) return '';
  const d = delta as Record<string, unknown>;
  if (d.reasoning_content || d.reasoning || d.thought) return '';
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

  for (const apiKey of provider.keys) {
    try {
      const { signal, cleanup } = makeRequestSignal(30000, opts.signal);
      try {
        const res = await fetch(target.url, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...body, model, stream: false }),
          signal,
        });

        if (res.status === 429) {
          tried.push(`${target.id}/${model} -> rate limited (key ${apiKey.slice(-6)})`);
          logError(label, target.url, 429, `Rate limited for ${model}. Key ending in: ${apiKey.slice(-6)}`);
          continue;
        }
        if (res.status === 401) {
          tried.push(`${target.id}/${model} -> unauthorized (key ${apiKey.slice(-6)})`);
          continue;
        }
        if (res.status === 400 || res.status === 404 || res.status === 413) {
          const errBody = await res.text().catch(() => '');
          tried.push(`${target.id}/${model} -> HTTP ${res.status}`);
          logError(label, target.url, res.status, `Model: ${model}\n${errBody}`);
          if (res.status === 400 && opts.tools) learnedNoToolCalling.add(model);
          return null; // Hard error, skip remaining keys
        }
        if (!res.ok) {
          tried.push(`${target.id}/${model} -> HTTP ${res.status}`);
          continue;
        }

        let data: unknown = await res.json();
        if (target.id === 'gemini' || (data as Record<string, unknown>)?.candidates) {
          data = normalizeGeminiResponse(data, model);
        }
        return { data, provider: target.id, model };
      } finally {
        cleanup();
      }
    } catch {
      tried.push(`${target.id}/${model} -> request failed`);
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

  for (const apiKey of provider.keys) {
    try {
      const { signal, cleanup } = makeRequestSignal(opts.tools ? 60000 : 30000, opts.signal);
      try {
        const res = await fetch(target.url, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...body, model, stream: true }),
          signal,
        });

        if (res.status === 429) {
          tried.push(`${target.id}/${model} -> rate limited (key ${apiKey.slice(-6)})`);
          logError(label, target.url, 429, `Rate limited for ${model}. Key ending in: ${apiKey.slice(-6)}`);
          continue;
        }
        if (res.status === 401) {
          tried.push(`${target.id}/${model} -> unauthorized`);
          continue;
        }
        if (res.status === 400 || res.status === 404 || res.status === 413) {
          const errBody = await res.text().catch(() => '');
          tried.push(`${target.id}/${model} -> HTTP ${res.status}`);
          logError(label, target.url, res.status, `Model: ${model}\n${errBody}`);
          if (res.status === 400 && opts.tools) learnedNoToolCalling.add(model);
          return null;
        }
        if (!res.ok) {
          tried.push(`${target.id}/${model} -> HTTP ${res.status}`);
          continue;
        }

        let fullContent = '';
        const stripper = new ThinkStripper(opts.onToken, { value: '' });
        const isGemini = target.id === 'gemini';

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

        return { data: null, fullContent, provider: target.id, model };
      } finally {
        cleanup();
      }
    } catch {
      tried.push(`${target.id}/${model} -> request failed`);
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

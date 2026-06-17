import { loadSettings } from './settings-store.js';
import fs from 'fs';
import path from 'path';
import { createSmartRoutingEngine, type RouteCandidate, type CapacityObservation, type RouteLease, type SelectionResult } from '@mindbox/smart-routing-core';
import { resolveTargets, modelSupportsTools, buildLLMRequestBody, learnedNoToolCalling } from './llm-utils.js';

const LOG_FILE = path.resolve(process.cwd(), 'llm-errors.log');

function logError(label: string, target: string, status: number, body: string): void {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${label}] [${status}] ${target}\n${body}\n${'─'.repeat(80)}\n`;
  try { fs.appendFileSync(LOG_FILE, line, 'utf8'); } catch (e) { console.error('[logError] Failed to write log:', e); }
  console.error(`[${status}] ${label} (${target}):\n${body}`);
}

let routingEngine = createSmartRoutingEngine();

export function initLLM() {
  const snapshot = routingEngine ? routingEngine.getSnapshot() : null;
  routingEngine = createSmartRoutingEngine(snapshot);
}

function buildCandidates(targets: TargetReference[]): RouteCandidate[] {
  return targets.map(t => ({
    routeId: `${t.id}::${t.model}`,
    sortKey: `${t.id}::${t.model}`,
    rotationGroupId: t.id,
    rotationIndex: 0,
    scopes: [{ scopeId: t.id, limits: { rpm: null, tpm: null, rpd: null, budgetMode: 'requests' as const, budgetLimit: null } }],
  }));
}

function recordRoutingOutcome(
  lease: RouteLease | undefined,
  kind: 'success' | 'rate-limit' | 'transient-failure' | 'auth-failure',
  durationMs: number,
  status?: number,
  observations?: CapacityObservation[],
) {
  try {
    if (!lease) return;
    routingEngine.recordOutcome({
      leaseId: lease.id,
      kind,
      settledAt: new Date().toISOString(),
      detail: status ? `HTTP ${status} ${durationMs}ms` : `${durationMs}ms`,
      observations: observations ?? [],
    });
  } catch { /* routing errors must not break request flow */ }
}

export type LLMRole = keyof import('./settings-store.js').ModelRouting;

export interface TargetReference {
  source: 'role' | 'provider';
  id: string;
  url: string;
  model: string;
}

export interface LLMOptions {
  messages: any[];
  temperature?: number;
  maxTokens?: number;
  tools?: any[];
  toolChoice?: 'auto' | 'none' | { type: 'function'; function: { name: string } };
  stream?: boolean;
  onToken?: (text: string) => void;
  onModelSelected?: (model: string, provider: string) => void;
  label?: string;
  role?: LLMRole;
  signal?: AbortSignal;
  responseFormat?: any;
}

export interface LLMResult {
  data?: any;
  fullContent?: string;
  model: string;
  provider: string;
}

function normalizeGeminiResponse(data: any, model: string): any {
  const candidates = data.candidates || [];
  if (candidates.length === 0) return data;
  const c = candidates[0];
  const parts = c.content?.parts || [];
  const text = parts.map((p: any) => p.text || '').join('');
  const finish = c.finishReason || 'stop';
  const toolCalls: any[] = [];
  for (const p of parts) {
    if (p.functionCall) {
      toolCalls.push({
        id: `call_${Date.now()}_${toolCalls.length}`,
        type: 'function',
        function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args || {}) },
      });
    }
  }
  const msg: any = { role: 'assistant', content: text || null };
  if (toolCalls.length > 0) msg.tool_calls = toolCalls;
  return {
    id: data.id || 'gemini-response',
    object: 'chat.completion',
    created: Date.now(),
    model,
    choices: [{ index: 0, message: msg, finish_reason: finish === 'STOP' ? 'stop' : finish?.toLowerCase() || 'stop' }],
    usage: data.usage || {},
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
function extractDeltaText(delta: any): string {
  if (!delta) return '';
  if (delta.reasoning_content || delta.reasoning || delta.thought) return '';
  for (const path of GEMINI_CONTENT_FIELDS) {
    const val = path.split('.').reduce((o, k) => o?.[k], delta);
    if (val) return val;
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
  body: Record<string, any>,
  label: string,
  signal: AbortSignal,
  tried: string[],
  lease?: RouteLease,
): Promise<{ data: any; provider: string; model: string } | null> {
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

  const keyCycle = [...provider.keys];
  let lastOutcome: { kind: 'rate-limit' | 'transient-failure' | 'auth-failure'; latencyMs: number; status?: number } | null = null;
  const observations: CapacityObservation[] = [];
  for (const apiKey of keyCycle) {
    const start = Date.now();
    try {
      const res = await fetch(target.url, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, model, stream: false }),
        signal,
      });

      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get('retry-after') || '5', 10);
        tried.push(`${target.id}/${model} -> rate limited (retry after ${retryAfter}s, key ${apiKey.slice(-6)})`);
        logError(label, target.url, 429, `Rate limited for ${model}. Key ending in: ${apiKey.slice(-6)}`);
        observations.push({ scopeId: target.id, source: 'http-response', observedAt: new Date().toISOString(), retryAfterSeconds: retryAfter });
        lastOutcome = { kind: 'rate-limit', latencyMs: Date.now() - start, status: 429 };
        continue;
      }
      if (res.status === 401) {
        tried.push(`${target.id}/${model} -> unauthorized (key ${apiKey.slice(-6)})`);
        lastOutcome = { kind: 'auth-failure', latencyMs: Date.now() - start, status: 401 };
        continue;
      }
      if (res.status === 400 || res.status === 404 || res.status === 413) {
        const errBody = await res.text().catch(() => '');
        tried.push(`${target.id}/${model} -> HTTP ${res.status}`);
        logError(label, target.url, res.status, `Model: ${model}\n${errBody}`);
        if (res.status === 400 && opts.tools) {
          learnedNoToolCalling.add(model);
        }
        recordRoutingOutcome(lease, 'transient-failure', Date.now() - start, res.status);
        return null; // Hard error, skip remaining keys
      }
      if (!res.ok) {
        tried.push(`${target.id}/${model} -> HTTP ${res.status}`);
        lastOutcome = { kind: 'transient-failure', latencyMs: Date.now() - start, status: res.status };
        continue;
      }

      let data: any = await res.json();
      if (target.id === 'gemini' || data.candidates) {
        data = normalizeGeminiResponse(data, model);
      }
      recordRoutingOutcome(lease, 'success', Date.now() - start, res.status);
      return { data, provider: target.id, model };
    } catch (err: any) {
      if (err.name === 'AbortError') throw err;
      tried.push(`${target.id}/${model} -> ${err.message}`);
      lastOutcome = { kind: 'transient-failure', latencyMs: Date.now() - start };
    }
  }
  if (lastOutcome) {
    recordRoutingOutcome(lease, lastOutcome.kind, lastOutcome.latencyMs, lastOutcome.status, observations.length > 0 ? observations : undefined);
  }
  return null;
}

async function tryProviderStream(
  target: TargetReference,
  opts: LLMOptions,
  body: Record<string, any>,
  label: string,
  signal: AbortSignal,
  tried: string[],
  lease?: RouteLease,
): Promise<{ data: any; fullContent: string; provider: string; model: string } | null> {
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

  const keyCycle = [...provider.keys];
  let lastOutcome: { kind: 'rate-limit' | 'transient-failure' | 'auth-failure'; latencyMs: number; status?: number } | null = null;
  const observations: CapacityObservation[] = [];
  for (const apiKey of keyCycle) {
    const start = Date.now();
    try {
      const res = await fetch(target.url, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, model, stream: true }),
        signal,
      });

      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get('retry-after') || '5', 10);
        tried.push(`${target.id}/${model} -> rate limited (retry after ${retryAfter}s)`);
        logError(label, target.url, 429, `Rate limited for ${model}. Key ending in: ${apiKey.slice(-6)}`);
        observations.push({ scopeId: target.id, source: 'http-response', observedAt: new Date().toISOString(), retryAfterSeconds: retryAfter });
        lastOutcome = { kind: 'rate-limit', latencyMs: Date.now() - start, status: 429 };
        continue;
      }
      if (res.status === 401) {
        tried.push(`${target.id}/${model} -> unauthorized`);
        lastOutcome = { kind: 'auth-failure', latencyMs: Date.now() - start, status: 401 };
        continue;
      }
      if (res.status === 400 || res.status === 404 || res.status === 413) {
        const errBody = await res.text().catch(() => '');
        tried.push(`${target.id}/${model} -> HTTP ${res.status}`);
        logError(label, target.url, res.status, `Model: ${model}\n${errBody}`);
        if (res.status === 400 && opts.tools) learnedNoToolCalling.add(model);
        recordRoutingOutcome(lease, 'transient-failure', Date.now() - start, res.status);
        return null;
      }
      if (!res.ok) {
        tried.push(`${target.id}/${model} -> HTTP ${res.status}`);
        lastOutcome = { kind: 'transient-failure', latencyMs: Date.now() - start, status: res.status };
        continue;
      }

      let fullContent = '';
      const stripper = new ThinkStripper(opts.onToken, { value: '' });
      const isGemini = target.id === 'gemini';

      if (!res.body) throw new Error('No response body');

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

      recordRoutingOutcome(lease, 'success', Date.now() - start, 200);
      return { data: null, fullContent, provider: target.id, model };
    } catch (err: any) {
      if (err.name === 'AbortError') throw err;
      tried.push(`${target.id}/${model} -> ${err.message}`);
      lastOutcome = { kind: 'transient-failure', latencyMs: Date.now() - start };
    }
  }
  if (lastOutcome) {
    recordRoutingOutcome(lease, lastOutcome.kind, lastOutcome.latencyMs, lastOutcome.status, observations.length > 0 ? observations : undefined);
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
  initLLM();
}

export async function callLLM(opts: LLMOptions): Promise<LLMResult> {
  const label = opts.label || 'callLLM';
  const { uniqTargets, tried } = resolveTargets(opts.role, label, opts.signal);
  const body = buildLLMRequestBody(opts);
  try {
    const maxGlobalAttempts = opts.role === 'deep' ? 5 : 1;
    for (let attempt = 0; attempt < maxGlobalAttempts; attempt++) {
      if (attempt > 0) await globalRetryBackoff(attempt, opts, label);
      for (const target of uniqTargets) {
        const candidate = buildCandidates([target])[0];
        let selection: SelectionResult | null = null;
        try {
          selection = routingEngine.selectRoute({ candidates: [candidate] });
        } catch { /* routing failure — try anyway */ }
        if (!selection) {
          tried.push(`${target.id}/${target.model} -> blocked (rate-limited)`);
          continue;
        }
        const { signal, cleanup } = makeRequestSignal(30000, opts.signal);
        try {
          const result = await tryProvider(target, opts, body, label, signal, tried, selection.lease);
          if (result) return result;
        } finally {
          cleanup();
        }
      }
    }
    throw new Error(`${label} — all targets failed after ${maxGlobalAttempts} global attempt(s).\n${tried.map(r => `  • ${r}`).join('\n')}`);
  } finally {
  }
}

export async function callLLMStream(opts: LLMOptions): Promise<LLMResult> {
  const label = opts.label || 'callLLMStream';
  const { uniqTargets, tried } = resolveTargets(opts.role, label, opts.signal);
  const body = buildLLMRequestBody(opts);
  try {
    const maxGlobalAttempts = opts.role === 'deep' ? 5 : 1;
    for (let attempt = 0; attempt < maxGlobalAttempts; attempt++) {
      if (attempt > 0) await globalRetryBackoff(attempt, opts, label);
      for (const target of uniqTargets) {
        const candidate = buildCandidates([target])[0];
        let selection: SelectionResult | null = null;
        try {
          selection = routingEngine.selectRoute({ candidates: [candidate] });
        } catch { /* routing failure — try anyway */ }
        if (!selection) {
          tried.push(`${target.id}/${target.model} -> blocked (rate-limited)`);
          continue;
        }
        const { signal, cleanup } = makeRequestSignal(opts.tools ? 60000 : 30000, opts.signal);
        try {
          const result = await tryProviderStream(target, opts, body, label, signal, tried, selection.lease);
          if (result) return result;
        } finally {
          cleanup();
        }
      }
    }
    throw new Error(`${label} — all targets failed after ${maxGlobalAttempts} global attempt(s).\n${tried.map(r => `  • ${r}`).join('\n')}`);
  } finally {
  }
}

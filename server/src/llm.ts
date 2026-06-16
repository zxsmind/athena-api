import { loadSettings, type ModelReference, type ModelRouting, type SettingsStore } from './settings-store.js';
import fs from 'fs';
import path from 'path';

const LOG_FILE = path.resolve(process.cwd(), 'llm-errors.log');

function logError(label: string, target: string, status: number, body: string): void {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${label}] [${status}] ${target}\n${body}\n${'─'.repeat(80)}\n`;
  try {
    fs.appendFileSync(LOG_FILE, line, 'utf8');
  } catch (e) {
    console.error('[logError] Failed to write log:', e);
  }
  console.error(`[${status}] ${label} (${target}):\n${body}`);
}

/* ── Provider key/model cycling with SmartRoutingEngine ── */

import { createSmartRoutingEngine, type RouteCandidate, type RouteScope, type CapacityObservation } from '@mindbox/smart-routing-core';

let routingEngine = createSmartRoutingEngine();

/* Models known to NOT support OpenAI-style tool calling */
const NO_TOOL_CALLING_MODELS = new Set(['groq/compound', 'groq/compound-mini']);

/* Learned at runtime — if a model returns 400 for tool calling, add it here */
const learnedNoToolCalling = new Set<string>();

function modelSupportsTools(model: string): boolean {
  return !NO_TOOL_CALLING_MODELS.has(model) && !learnedNoToolCalling.has(model);
}

export function initLLM() {
  const snapshot = routingEngine ? routingEngine.getSnapshot() : null;
  routingEngine = createSmartRoutingEngine(snapshot);
}

export type LLMRole = keyof ModelRouting;

export interface TargetReference {
  source: 'role' | 'provider';
  id: string;
  url: string;
  model: string;
}

function orderedProviderEntries(store: SettingsStore): Array<[string, SettingsStore['providers'][string]]> {
  const entries: Array<[string, SettingsStore['providers'][string]]> = [];
  const seen = new Set<string>();

  for (const id of store.providerOrder) {
    const provider = store.providers[id];
    if (!provider) continue;
    entries.push([id, provider]);
    seen.add(id);
  }

  for (const [id, provider] of Object.entries(store.providers)) {
    if (seen.has(id)) continue;
    entries.push([id, provider]);
  }

  return entries;
}

function resolveRoleTargetReferences(role?: LLMRole): { targets: TargetReference[]; skipped: string[] } {
  if (!role) return { targets: [], skipped: [] };
  const store = loadSettings();
  const routing = store.modelRouting?.[role];
  if (!routing) return { targets: [], skipped: [] };

  const refs = [routing.primary, ...routing.fallback];
  const targets: TargetReference[] = [];
  const skipped: string[] = [];

  for (const ref of refs) {
    const model = ref.model.trim();
    const preferredId = ref.providerId.trim();
    if (!model && !preferredId) continue;
    if (!model) {
      skipped.push(`empty model name for provider "${preferredId}"`);
      continue;
    }

    const checkProvider = (id: string) => {
      const provider = store.providers[id];
      if (!provider) return `provider "${id}" not found`;
      if (!provider.enabled) return `provider "${id}" is disabled`;
      if (provider.keys.length === 0) return `no API key configured for provider "${id}"`;
      return null;
    };

    if (preferredId) {
      const err = checkProvider(preferredId);
      if (err) {
        skipped.push(err);
      } else {
        const provider = store.providers[preferredId];
        const supportsModel = provider.models.length === 0 || provider.models.includes(model);
        if (!supportsModel) {
          skipped.push(`model "${model}" is not listed under provider "${preferredId}"`);
        } else {
          targets.push({ source: 'role', id: preferredId, url: provider.url, model });
        }
      }
    } else {
      let found = false;
      for (const [id, provider] of orderedProviderEntries(store)) {
        if (!provider.enabled) continue;
        if (provider.models.includes(model)) {
          const err = checkProvider(id);
          if (!err) {
            targets.push({ source: 'role', id, url: provider.url, model });
            found = true;
            break;
          }
        }
      }
      if (!found) {
        skipped.push(`model "${model}" not found in any enabled provider's model list`);
      }
    }
  }

  // De-duplicate
  const uniq: TargetReference[] = [];
  const seen = new Set<string>();
  for (const t of targets) {
    const key = `${t.id}::${t.model}`;
    if (!seen.has(key)) {
      seen.add(key);
      uniq.push(t);
    }
  }

  return { targets: uniq, skipped };
}

export function* iterateProviderReferences(): Generator<TargetReference> {
  const store = loadSettings();
  for (const [id, p] of orderedProviderEntries(store)) {
    if (!p.enabled || p.keys.length === 0 || p.models.length === 0) continue;
    for (const model of p.models) {
      yield {
        id,
        url: p.url,
        model,
        source: 'provider',
      };
    }
  }
}

/* ── LLM call options ── */

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
}

export interface LLMResult {
  data?: any;
  fullContent?: string;
  model: string;
  provider: string;
}

/* ── Normalize Gemini native response to OpenAI-compatible format ── */

function normalizeGeminiResponse(data: any, model: string): any {
  const candidates = data.candidates || [];
  if (candidates.length === 0) return data;

  const c = candidates[0];
  const parts = c.content?.parts || [];
  const text = parts.map((p: any) => p.text || '').join('');
  const finish = c.finishReason || 'stop';

  // Extract tool_calls from Gemini functionCall parts
  const toolCalls: any[] = [];
  for (const p of parts) {
    if (p.functionCall) {
      toolCalls.push({
        id: `call_${Date.now()}_${toolCalls.length}`,
        type: 'function',
        function: {
          name: p.functionCall.name,
          arguments: JSON.stringify(p.functionCall.args || {}),
        },
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
    choices: [{
      index: 0,
      message: msg,
      finish_reason: finish === 'STOP' ? 'stop' : finish?.toLowerCase() || 'stop',
    }],
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
          if (before) {
            this.fullContentRef.value += before;
            this.onToken(before);
          }
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
            if (before) {
              this.fullContentRef.value += before;
              this.onToken(before);
            }
            this.streamBuffer = this.streamBuffer.slice(pIdx);
            matchedPrefix = true;
            break;
          }
        }
        if (matchedPrefix) {
          break;
        }

        if (this.streamBuffer) {
          this.fullContentRef.value += this.streamBuffer;
          this.onToken(this.streamBuffer);
          this.streamBuffer = '';
        }
        break;
      } else {
        const idx = this.streamBuffer.indexOf('</think>');
        if (idx !== -1) {
          this.inThinkBlock = false;
          this.streamBuffer = this.streamBuffer.slice(idx + 8);
          continue;
        }

        const prefixes = ['</think', '</thin', '</thi', '</th', '</t', '</', '<'];
        let matchedPrefix = false;
        for (const pfx of prefixes) {
          if (this.streamBuffer.endsWith(pfx)) {
            const pIdx = this.streamBuffer.length - pfx.length;
            this.streamBuffer = this.streamBuffer.slice(pIdx);
            matchedPrefix = true;
            break;
          }
        }
        if (matchedPrefix) {
          break;
        }

        this.streamBuffer = '';
        break;
      }
    }
  }

  flush() {
    if (!this.inThinkBlock && this.streamBuffer) {
      this.fullContentRef.value += this.streamBuffer;
      this.onToken(this.streamBuffer);
      this.streamBuffer = '';
    }
  }
}

export function stripThinkingTags(text: string): string {
  if (!text) return '';
  let clean = text.replace(/<think>[\s\S]*?<\/think>/g, '');
  clean = clean.replace(/<think>[\s\S]*/g, '');
  return clean;
}

const GEMINI_CONTENT_FIELDS = ['content', 'text', 'message.content'];

function extractDeltaText(delta: any): string {
  if (!delta) return '';
  
  // Explicitly ignore reasoning/thought content so it never leaks/streams to the chat
  if (delta.reasoning_content || delta.reasoning || delta.thought) {
    return '';
  }

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
    if (external.aborted) {
      controller.abort();
    } else {
      external.addEventListener('abort', () => controller.abort(), { once: true });
    }
  }
  return {
    signal: controller.signal,
    cleanup: () => clearTimeout(timer),
  };
}

/* ── Non-streaming call ── */

export async function callLLM(opts: LLMOptions): Promise<LLMResult> {
  const maxRetries = 10;
  const label = opts.label || 'callLLM';
  const { targets: roleTargets, skipped: roleSkipped } = resolveRoleTargetReferences(opts.role);
  const tried: string[] = roleSkipped.map(r => `[config] ${r}`);

  if (opts.signal?.aborted) {
    throw new Error(`${label} cancelled`);
  }

  const targetList = [
    ...roleTargets,
    ...Array.from(iterateProviderReferences())
  ];

  // De-duplicate globally by provider+model
  const uniqTargets: TargetReference[] = [];
  const seenTargets = new Set<string>();
  for (const t of targetList) {
    const key = `${t.id}::${t.model}`;
    if (!seenTargets.has(key)) {
      seenTargets.add(key);
      uniqTargets.push(t);
    }
  }

  console.log(`[LLM] Resolved targets for role ${opts.role || '(none)'}:`, uniqTargets.map(t => `${t.id}/${t.model}`));

  if (uniqTargets.length === 0 && roleSkipped.length > 0) {
    throw new Error(`${label} — no usable targets. Config issues:\n${roleSkipped.map(r => `  • ${r}`).join('\n')}`);
  }

  const maxGlobalAttempts = opts.role === 'deep' ? 5 : 1;
  for (let globalAttempt = 0; globalAttempt < maxGlobalAttempts; globalAttempt++) {
    if (globalAttempt > 0) {
      const backoffMs = Math.pow(2, globalAttempt) * 1000; // 2s, 4s, 8s, 16s
      console.log(`[LLM] [Deep Mode] All targets exhausted. Waiting ${backoffMs / 1000}s before global retry ${globalAttempt}/${maxGlobalAttempts - 1}...`);
      const startTime = Date.now();
      while (Date.now() - startTime < backoffMs) {
        if (opts.signal?.aborted) {
          throw new Error(`${label} cancelled`);
        }
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      initLLM(); // Reset Smart Routing snapshot in case rate limits reset
    }

    for (const target of uniqTargets) {
      const model = target.model;

      // Skip models that don't support tool calling when tools are in the payload
      if (opts.tools && !modelSupportsTools(model)) {
        console.log(`[LLM] Skipping ${target.id}/${model} — does not support tool calling`);
        tried.push(`${target.id}/${model} -> skipped (no tool calling support)`);
        continue;
      }

      const store = loadSettings();
      const provider = store.providers[target.id];
      if (!provider || provider.keys.length === 0) continue;

      const keys = provider.keys;
      const candidates: RouteCandidate[] = keys.map((key, keyIdx) => {
        const routeId = `${target.id}/${model}/key_${keyIdx}`;
        return {
          routeId,
          sortKey: routeId,
          rotationGroupId: `${target.id}/${model}`,
          rotationIndex: keyIdx,
          scopes: [
            {
              scopeId: `${target.id}/${model}/key_${keyIdx}:aggregate`,
              limits: { rpm: null, tpm: null, rpd: null, budgetMode: 'requests', budgetLimit: null },
            },
          ],
        };
      });

      const keyMap = new Map<string, string>();
      keys.forEach((key, keyIdx) => {
        keyMap.set(`${target.id}/${model}/key_${keyIdx}`, key);
      });

      let consecutive413 = 0;

      for (let attempt = 0; attempt < maxRetries; attempt++) {
        if (opts.signal?.aborted) {
          throw new Error(`${label} cancelled`);
        }

        const selection = routingEngine.selectRoute({ candidates });
        if (!selection) {
          tried.push(`${target.id}/${model} -> all keys rate-limited or blocked by smart routing`);
          break; // try next fallback target reference
        }

        console.log(`[LLM] Trying key index ${selection.candidate.rotationIndex + 1}/${keys.length} for ${target.id}/${model}`);
        opts.onModelSelected?.(model, target.id);
        const currentKey = keyMap.get(selection.candidate.routeId)!;
        const scopeId = `${target.id}/${model}/key_${selection.candidate.rotationIndex}:aggregate`;

        const payload: any = {
          model,
          messages: opts.messages,
          temperature: opts.temperature ?? 0.1,
          max_completion_tokens: opts.maxTokens ?? 3200,
          stream: false,
        };
        if (opts.tools) {
          payload.tools = opts.tools;
          payload.tool_choice = opts.toolChoice ?? 'auto';
        }

        const headers = {
          'Authorization': `Bearer ${currentKey}`,
          'Content-Type': 'application/json',
        };

        let res: Response;
        const request = makeRequestSignal(30000, opts.signal);
        try {
          res = await fetch(target.url, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
            signal: request.signal,
          });
        } catch (err: any) {
          request.cleanup();
          if (opts.signal?.aborted) {
            routingEngine.recordOutcome({ leaseId: selection.lease.id, kind: 'released' });
            throw new Error(`${label} cancelled`);
          }
          if (err.name === 'TimeoutError' || err.name === 'AbortError') {
            console.log(`[Timeout] ${label} (${target.id}/${model}) timed out. Retry ${attempt + 1}/${maxRetries}`);
            routingEngine.recordOutcome({ leaseId: selection.lease.id, kind: 'transient-failure' });
            continue;
          }
          const errMsg = `${target.id}/${model} -> fetch error: ${err.message}`;
          tried.push(errMsg);
          console.warn(`[LLM] Fetch error on ${target.id}/${model}: ${err.message}`);
          routingEngine.recordOutcome({ leaseId: selection.lease.id, kind: 'transient-failure' });
          break;
        }
        request.cleanup();

        if (res.status === 401) {
          const body401 = await res.text().catch(() => '(unreadable)');
          logError(label, `${target.id}/${model}`, 401, body401);
          tried.push(`${target.id}/${model} -> 401: ${body401.slice(0, 120)}`);
          routingEngine.recordOutcome({
            leaseId: selection.lease.id,
            kind: 'auth-failure',
            detail: `401 Unauthorized: ${body401.slice(0, 150)}`,
          });
          break;
        }

        if (res.status === 429) {
          const body429 = await res.text().catch(() => '(unreadable)');
          logError(label, `${target.id}/${model}`, 429, body429);
          tried.push(`${target.id}/${model}[key:...${currentKey.slice(-6)}] -> 429: ${body429.slice(0, 100)}`);
          
          let retryAfterSeconds: number | undefined;
          const retryAfterHeader = res.headers.get('retry-after');
          if (retryAfterHeader) {
            const parsed = parseInt(retryAfterHeader, 10);
            if (!isNaN(parsed)) retryAfterSeconds = parsed;
          }
          if (!retryAfterSeconds && body429) {
            const match = /try again in (\d+(?:\.\d+)?)\s*s/i.exec(body429);
            if (match) {
              retryAfterSeconds = Math.ceil(parseFloat(match[1]));
            }
          }

          routingEngine.recordOutcome({
            leaseId: selection.lease.id,
            kind: 'rate-limit',
            observations: [{
              scopeId,
              source: 'provider-response',
              observedAt: new Date().toISOString(),
              retryAfterSeconds,
            }],
          });
          continue;
        }

        if (res.status === 400 || res.status === 404) {
          const body = await res.text();
          const errMsg = `${target.id}/${model} -> ${res.status}: ${body.slice(0, 100)}`;
          tried.push(errMsg);
          console.warn(`[LLM] Request failed on ${target.id}/${model} (Status ${res.status}): ${body}`);
          // Learn that this model doesn't support tool calling
          if (res.status === 400 && body.includes('tool calling') && body.includes('not supported')) {
            learnedNoToolCalling.add(model);
            console.log(`[LLM] Learned: ${model} does not support tool calling — will skip in future requests`);
          }
          routingEngine.recordOutcome({ leaseId: selection.lease.id, kind: 'released' });
          break;
        }

        if (res.status === 413) {
          consecutive413++;
          routingEngine.recordOutcome({ leaseId: selection.lease.id, kind: 'released' });
          if (consecutive413 >= 3) {
            throw new Error(`${label} request still too large after 3 trim attempts`);
          }
          tried.push(`${target.id}/${model} -> 413 Payload Too Large`);
          continue;
        }

        if (!res.ok) {
          const errMsg = `${target.id}/${model} -> ${res.status} ${res.statusText}`;
          tried.push(errMsg);
          console.warn(`[LLM] Non-OK response on ${target.id}/${model} (Status ${res.status}): ${res.statusText}`);
          routingEngine.recordOutcome({ leaseId: selection.lease.id, kind: 'transient-failure' });
          break;
        }

        let data: any;
        try {
          data = await res.json();
        } catch (err: any) {
          routingEngine.recordOutcome({ leaseId: selection.lease.id, kind: 'released' });
          throw new Error(`${label} JSON parse error: ${err.message}`);
        }

        routingEngine.recordOutcome({
          leaseId: selection.lease.id,
          kind: 'success',
          usage: { requests: 1 },
        });

        console.log(`[LLM] Success on ${target.id}/${model} using key index ${selection.candidate.rotationIndex + 1}/${keys.length}`);

        // Normalize Gemini native format to OpenAI-compatible
        if (!data.choices && data.candidates) {
          data = normalizeGeminiResponse(data, model);
        }

        if (data.choices?.[0]?.message?.content) {
          data.choices[0].message.content = stripThinkingTags(data.choices[0].message.content);
        }

        return { data, model, provider: target.id };
      }
      console.log(`[LLM] Failed on target ${target.id}/${model}, falling back to next target...`);
    }
  }

  const detail = tried.map(t => `  • ${t}`).join('\n');
  throw new Error(`${label}: ${detail}`);
}

/* ── Streaming call ── */

/* ── Streaming call ── */

export async function callLLMStream(opts: LLMOptions): Promise<LLMResult> {
  const maxRetries = 10;
  const label = opts.label || 'callLLMStream';
  const { targets: roleTargets, skipped: roleSkipped } = resolveRoleTargetReferences(opts.role);
  const tried: string[] = roleSkipped.map(r => `[config] ${r}`);

  if (opts.signal?.aborted) {
    throw new Error(`${label} cancelled`);
  }

  const targetList = [
    ...roleTargets,
    ...Array.from(iterateProviderReferences())
  ];

  // De-duplicate globally by provider+model
  const uniqTargets: TargetReference[] = [];
  const seenTargets = new Set<string>();
  for (const t of targetList) {
    const key = `${t.id}::${t.model}`;
    if (!seenTargets.has(key)) {
      seenTargets.add(key);
      uniqTargets.push(t);
    }
  }

  console.log(`[LLM] Resolved targets for role ${opts.role || '(none)'}:`, uniqTargets.map(t => `${t.id}/${t.model}`));

  if (uniqTargets.length === 0 && roleSkipped.length > 0) {
    throw new Error(`${label} — no usable targets. Config issues:\n${roleSkipped.map(r => `  • ${r}`).join('\n')}`);
  }

  const maxGlobalAttempts = opts.role === 'deep' ? 5 : 1;
  for (let globalAttempt = 0; globalAttempt < maxGlobalAttempts; globalAttempt++) {
    if (globalAttempt > 0) {
      const backoffMs = Math.pow(2, globalAttempt) * 1000; // 2s, 4s, 8s, 16s
      console.log(`[LLM] [Deep Mode] All targets exhausted. Waiting ${backoffMs / 1000}s before global retry ${globalAttempt}/${maxGlobalAttempts - 1}...`);
      const startTime = Date.now();
      while (Date.now() - startTime < backoffMs) {
        if (opts.signal?.aborted) {
          throw new Error(`${label} cancelled`);
        }
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      initLLM(); // Reset Smart Routing snapshot in case rate limits reset
    }

    for (const target of uniqTargets) {
      const model = target.model;

      // Skip models that don't support tool calling when tools are in the payload
      if (opts.tools && !modelSupportsTools(model)) {
        console.log(`[LLM] Skipping ${target.id}/${model} — does not support tool calling`);
        tried.push(`${target.id}/${model} -> skipped (no tool calling support)`);
        continue;
      }

      const store = loadSettings();
      const provider = store.providers[target.id];
      if (!provider || provider.keys.length === 0) continue;

      const keys = provider.keys;
      const candidates: RouteCandidate[] = keys.map((key, keyIdx) => {
        const routeId = `${target.id}/${model}/key_${keyIdx}`;
        return {
          routeId,
          sortKey: routeId,
          rotationGroupId: `${target.id}/${model}`,
          rotationIndex: keyIdx,
          scopes: [
            {
              scopeId: `${target.id}/${model}/key_${keyIdx}:aggregate`,
              limits: { rpm: null, tpm: null, rpd: null, budgetMode: 'requests', budgetLimit: null },
            },
          ],
        };
      });

      const keyMap = new Map<string, string>();
      keys.forEach((key, keyIdx) => {
        keyMap.set(`${target.id}/${model}/key_${keyIdx}`, key);
      });

      let consecutive413 = 0;
      let consecutiveStreamInterruptions = 0;

      for (let attempt = 0; attempt < maxRetries; attempt++) {
        if (opts.signal?.aborted) {
          throw new Error(`${label} cancelled`);
        }

        const selection = routingEngine.selectRoute({ candidates });
        if (!selection) {
          tried.push(`${target.id}/${model} -> all keys rate-limited or blocked by smart routing`);
          break; // try next fallback target reference
        }

        console.log(`[LLM] Trying key index ${selection.candidate.rotationIndex + 1}/${keys.length} for ${target.id}/${model}`);
        opts.onModelSelected?.(model, target.id);
        const currentKey = keyMap.get(selection.candidate.routeId)!;
        const scopeId = `${target.id}/${model}/key_${selection.candidate.rotationIndex}:aggregate`;

        const payload: any = {
          model,
          messages: opts.messages,
          temperature: opts.temperature ?? 0,
          max_completion_tokens: opts.maxTokens ?? 3200,
          stream: true,
        };
        if (opts.tools) {
          payload.tools = opts.tools;
          payload.tool_choice = opts.toolChoice ?? 'auto';
        }

        const headers = {
          'Authorization': `Bearer ${currentKey}`,
          'Content-Type': 'application/json',
        };

        let res: Response;
        const request = makeRequestSignal(30000, opts.signal);
        try {
          res = await fetch(target.url, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
            signal: request.signal,
          });
        } catch (err: any) {
          request.cleanup();
          if (opts.signal?.aborted) {
            routingEngine.recordOutcome({ leaseId: selection.lease.id, kind: 'released' });
            throw new Error(`${label} cancelled`);
          }
          if (err.name === 'TimeoutError' || err.name === 'AbortError') {
            console.log(`[Timeout] ${label} (${target.id}/${model}) timed out. Retry ${attempt + 1}/${maxRetries}`);
            routingEngine.recordOutcome({ leaseId: selection.lease.id, kind: 'transient-failure' });
            continue;
          }
          const errMsg = `${target.id}/${model} -> fetch error: ${err.message}`;
          tried.push(errMsg);
          console.warn(`[LLM] Fetch error on ${target.id}/${model}: ${err.message}`);
          routingEngine.recordOutcome({ leaseId: selection.lease.id, kind: 'transient-failure' });
          break;
        }
        request.cleanup();

        if (res.status === 401) {
          const body401 = await res.text().catch(() => '(unreadable)');
          logError(label, `${target.id}/${model}`, 401, body401);
          tried.push(`${target.id}/${model} -> 401: ${body401.slice(0, 120)}`);
          routingEngine.recordOutcome({
            leaseId: selection.lease.id,
            kind: 'auth-failure',
            detail: `401 Unauthorized: ${body401.slice(0, 150)}`,
          });
          break;
        }

        if (res.status === 429) {
          const body429 = await res.text().catch(() => '(unreadable)');
          logError(label, `${target.id}/${model}`, 429, body429);
          tried.push(`${target.id}/${model}[key:...${currentKey.slice(-6)}] -> 429: ${body429.slice(0, 100)}`);
          
          let retryAfterSeconds: number | undefined;
          const retryAfterHeader = res.headers.get('retry-after');
          if (retryAfterHeader) {
            const parsed = parseInt(retryAfterHeader, 10);
            if (!isNaN(parsed)) retryAfterSeconds = parsed;
          }
          if (!retryAfterSeconds && body429) {
            const match = /try again in (\d+(?:\.\d+)?)\s*s/i.exec(body429);
            if (match) {
              retryAfterSeconds = Math.ceil(parseFloat(match[1]));
            }
          }

          routingEngine.recordOutcome({
            leaseId: selection.lease.id,
            kind: 'rate-limit',
            observations: [{
              scopeId,
              source: 'provider-response',
              observedAt: new Date().toISOString(),
              retryAfterSeconds,
            }],
          });
          continue;
        }

        if (res.status === 400 || res.status === 404) {
          const body = await res.text();
          const errMsg = `${target.id}/${model} -> ${res.status}: ${body.slice(0, 100)}`;
          tried.push(errMsg);
          console.warn(`[LLM] Request failed on ${target.id}/${model} (Status ${res.status}): ${body}`);
          routingEngine.recordOutcome({ leaseId: selection.lease.id, kind: 'released' });
          break;
        }

        if (res.status === 413) {
          consecutive413++;
          routingEngine.recordOutcome({ leaseId: selection.lease.id, kind: 'released' });
          if (consecutive413 >= 3) {
            throw new Error(`${label} request still too large after 3 trim attempts`);
          }
          tried.push(`${target.id}/${model} -> 413 Payload Too Large`);
          continue;
        }

        if (!res.ok) {
          const errMsg = `${target.id}/${model} -> ${res.status} ${res.statusText}`;
          tried.push(errMsg);
          console.warn(`[LLM] Non-OK response on ${target.id}/${model} (Status ${res.status}): ${res.statusText}`);
          routingEngine.recordOutcome({ leaseId: selection.lease.id, kind: 'transient-failure' });
          break;
        }

        if (!res.body) {
          routingEngine.recordOutcome({ leaseId: selection.lease.id, kind: 'released' });
          throw new Error('No response body for stream');
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        const fullContentRef = { value: '' };
        const stripper = new ThinkStripper(opts.onToken, fullContentRef);
        let streamError = false;
        let sawSse = false;
        let sawDone = false;

        while (true) {
          let readResult: ReadableStreamReadResult<Uint8Array>;
          try {
            readResult = await reader.read();
          } catch (err: any) {
            console.log(`[Stream read error] ${label}: ${err.message}. Retrying...`);
            streamError = true;
            break;
          }

          const { done, value } = readResult;
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            sawSse = true;
            const jsonStr = line.slice(6).trim();
            if (jsonStr === '[DONE]') {
              sawDone = true;
              continue;
            }

            try {
              const chunk = JSON.parse(jsonStr);
              if (chunk.candidates && !chunk.choices) {
                sawDone = true;
                const parts = chunk.candidates?.[0]?.content?.parts || [];
                for (const p of parts) {
                  if (p.text) {
                    stripper.process(p.text);
                  }
                }
                continue;
              }
              const delta = chunk.choices?.[0]?.delta;
              const text = extractDeltaText(delta);
              if (text) {
                stripper.process(text);
              }
            } catch { /* skip malformed */ }
          }
        }

        stripper.flush();
        let fullContent = fullContentRef.value;

        if (streamError || (sawSse && !sawDone)) {
          // If we already received substantial content, treat it as success — Groq sometimes
          // closes the connection without sending [DONE] (especially on long responses).
          if (fullContent && fullContent.length >= 100) {
            console.log(`[Stream interrupted but usable] ${label} (${target.id}/${model}): got ${fullContent.length} chars, no [DONE] — treating as success`);
            routingEngine.recordOutcome({
              leaseId: selection.lease.id,
              kind: 'success',
              usage: { requests: 1 },
            });
            return { fullContent, model, provider: target.id };
          }

          consecutiveStreamInterruptions++;
          if (sawSse && !sawDone) {
            console.log(`[Stream interrupted] ${label} (${target.id}/${model}): connection closed prematurely without [DONE] (${consecutiveStreamInterruptions} consecutive)`);
            tried.push(`${target.id}/${model} -> stream interrupted prematurely`);
          }
          routingEngine.recordOutcome({ leaseId: selection.lease.id, kind: 'transient-failure' });
          // After 2 consecutive stream interruptions on the same model, it's likely a model-level
          // issue (e.g. TPM limit on underlying model), not a key-level issue. Stop burning keys.
          if (consecutiveStreamInterruptions >= 2) {
            console.log(`[LLM] ${consecutiveStreamInterruptions} consecutive stream interruptions on ${target.id}/${model} — likely model-level issue, skipping to next target`);
            break;
          }
          continue;
        }

        // Fallback: no SSE → try JSON body (non-streaming response)
        if (!fullContent && buffer.trim()) {
          try {
            const json = JSON.parse(buffer);
            const text = json.choices?.[0]?.message?.content || json.choices?.[0]?.text || '';
            if (text) {
              fullContent = stripThinkingTags(text);
            }
          } catch { /* not JSON either */ }
        }

        if (!fullContent) {
          // Streaming returned empty — try non-streaming fallback
          console.log(`[${label}] streaming empty, trying non-streaming fallback for ${target.id}/${model}`);
          try {
            const fallbackRequest = makeRequestSignal(60000, opts.signal);
            const fallbackRes = await fetch(target.url, {
              method: 'POST',
              headers,
              body: JSON.stringify({ ...payload, stream: false }),
              signal: fallbackRequest.signal,
            });
            fallbackRequest.cleanup();
            if (fallbackRes.ok) {
              const fallbackData = await fallbackRes.json();
              let text = fallbackData.choices?.[0]?.message?.content
                || fallbackData.choices?.[0]?.text
                || fallbackData.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join('')
                || '';
              if (text) {
                text = stripThinkingTags(text);
                console.log(`[${label}] non-streaming fallback OK (${text.length} chars)`);
                opts.onToken?.(text);
                routingEngine.recordOutcome({
                  leaseId: selection.lease.id,
                  kind: 'success',
                  usage: { requests: 1 },
                });
                return { fullContent: text, model, provider: target.id };
              }
              console.log(`[${label}] fallback response: ${JSON.stringify(fallbackData).slice(0, 1000)}`);
              tried.push(`${target.id}/${model} -> non-streaming fallback response has no content field. Full response: ${JSON.stringify(fallbackData).slice(0, 300)}`);
              routingEngine.recordOutcome({ leaseId: selection.lease.id, kind: 'released' });
            } else {
              const errText = await fallbackRes.text().catch(() => '');
              tried.push(`${target.id}/${model} -> non-streaming fallback HTTP ${fallbackRes.status}: ${errText.slice(0, 200)}`);
              routingEngine.recordOutcome({ leaseId: selection.lease.id, kind: 'released' });
            }
          } catch (err: any) {
            if (opts.signal?.aborted) {
              routingEngine.recordOutcome({ leaseId: selection.lease.id, kind: 'released' });
              throw new Error(`${label} cancelled`);
            }
            tried.push(`${target.id}/${model} -> non-streaming fallback error: ${err.message}`);
            routingEngine.recordOutcome({ leaseId: selection.lease.id, kind: 'transient-failure' });
          }

          break;
        }

        routingEngine.recordOutcome({
          leaseId: selection.lease.id,
          kind: 'success',
          usage: { requests: 1 },
        });

        console.log(`[LLM] Success on ${target.id}/${model} using key index ${selection.candidate.rotationIndex + 1}/${keys.length}`);

        return { fullContent, model, provider: target.id };
      }
      console.log(`[LLM] Failed on target ${target.id}/${model}, falling back to next target...`);
    }
  }

  const detail = tried.map(t => `  • ${t}`).join('\n');
  throw new Error(`${label}: ${detail}`);
}

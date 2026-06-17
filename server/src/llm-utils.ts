import { loadSettings } from './settings-store.js';
import type { LLMRole, LLMOptions, TargetReference } from './llm.js';

export function resolveTargets(
  role: LLMRole | undefined,
  label: string,
  optsSignal?: AbortSignal,
): { uniqTargets: TargetReference[]; tried: string[] } {
  const { targets: roleTargets, skipped: roleSkipped } = resolveRoleTargetReferences(role);
  const tried: string[] = roleSkipped.map(r => `[config] ${r}`);

  if (optsSignal?.aborted) throw new Error(`${label} cancelled`);

  const targetList = roleTargets.length > 0 ? roleTargets : Array.from(iterateProviderReferences());

  const uniqTargets: TargetReference[] = [];
  const seenTargets = new Set<string>();
  for (const t of targetList) {
    const key = `${t.id}::${t.model}`;
    if (!seenTargets.has(key)) {
      seenTargets.add(key);
      uniqTargets.push(t);
    }
  }

  console.log(`[LLM] Resolved targets for role ${role || '(none)'}:`, uniqTargets.map(t => `${t.id}/${t.model}`));

  if (uniqTargets.length === 0 && roleSkipped.length > 0) {
    throw new Error(`${label} — no usable targets. Config issues:\n${roleSkipped.map(r => `  • ${r}`).join('\n')}`);
  }

  return { uniqTargets, tried };
}

export function resolveRoleTargetReferences(role?: LLMRole): { targets: TargetReference[]; skipped: string[] } {
  if (!role) return { targets: [], skipped: [] };
  const store = loadSettings();
  const route = store.modelRouting?.[role];
  if (!route) return { targets: [], skipped: [] };
  const skipped: string[] = [];
  const targets: TargetReference[] = [];

  const addRef = (ref: { providerId: string; model: string }, sourceLabel: string) => {
    const pid = ref.providerId || Object.keys(store.providers).find(p => store.providers[p].enabled) || '';
    if (!pid) { skipped.push(`${sourceLabel}: no providerId`); return; }
    const provider = store.providers[pid];
    if (!provider) { skipped.push(`${sourceLabel}: provider "${pid}" not found`); return; }
    if (!provider.enabled) { skipped.push(`${sourceLabel}: provider "${pid}" is disabled`); return; }
    const model = ref.model;
    if (!model) { skipped.push(`${sourceLabel}: no model`); return; }
    targets.push({ source: 'role', id: pid, url: provider.url, model });
  };

  addRef(route.primary, `${role}.primary`);
  for (let i = 0; i < (route.fallback || []).length; i++) {
    addRef(route.fallback[i], `${role}.fallback[${i}]`);
  }
  return { targets, skipped };
}

export function* iterateProviderReferences(): Generator<TargetReference> {
  const store = loadSettings();
  for (const pid of store.providerOrder || []) {
    const provider = store.providers[pid];
    if (!provider?.enabled) continue;
    for (const model of provider.models || []) {
      yield { source: 'provider', id: pid, url: provider.url, model };
    }
  }
}

export const NO_TOOL_CALLING_MODELS = new Set(['groq/compound', 'groq/compound-mini']);
export const learnedNoToolCalling = new Set<string>();

export function modelSupportsTools(model: string): boolean {
  return !NO_TOOL_CALLING_MODELS.has(model) && !learnedNoToolCalling.has(model);
}

export function buildLLMRequestBody(opts: LLMOptions): Record<string, unknown> {
  const body: Record<string, unknown> = {
    messages: opts.messages,
    temperature: opts.temperature ?? 0.7,
    max_completion_tokens: opts.maxTokens ?? 3200,
  };
  if (opts.tools) body.tools = opts.tools;
  if (opts.toolChoice) body.tool_choice = opts.toolChoice;
  if (opts.responseFormat) body.response_format = opts.responseFormat;
  return body;
}



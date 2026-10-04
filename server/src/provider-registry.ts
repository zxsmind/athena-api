import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { LanguageModel } from 'ai';
import { getCachedModelsDevProvider } from './models-dev.js';
import type { ProviderState } from './settings-store.js';

/**
 * The provider system. There is deliberately no provider name in this file.
 *
 * Providers come from the models.dev catalog: each entry carries its display
 * name, API endpoint, key env vars, runtime `npm` package, and model list.
 * Settings only overlay onto catalog ids — enabled flags, keys, a model
 * whitelist, a baseURL override, and the models that need the inline tool-call
 * fallback. Adding a provider means configuring its catalog id and key;
 * nothing here changes.
 *
 * A catalog-unknown id is still usable when settings declare its runtime
 * (`npm`, endpoint, model ids), exactly like a custom provider entry.
 */

export interface ApiKeySource {
  key: string;
  /** Where the key came from. Settings keys rotate; env supplies one key. */
  source: 'settings' | 'env';
  envName?: string;
}

export interface ResolvedProvider {
  /** Catalog id (`anthropic`, `google`, `openrouter`, …) or custom id. */
  id: string;
  displayName: string;
  /** AI SDK package that speaks this provider. Always from data, never code. */
  npm: string;
  apiKeys: ApiKeySource[];
  baseURL: string | undefined;
  headers?: Record<string, string>;
  custom: boolean;
}

export interface UnavailableProvider {
  id: string;
  reason: string;
}

/** Result of resolving a provider id against the catalog and settings. */
export type ProviderResolution = { ok: true; provider: ResolvedProvider } | { ok: false; error: UnavailableProvider };

function firstNonEmptyEnv(names: readonly string[] | undefined): ApiKeySource | null {
  if (!names) return null;
  for (const name of names) {
    const value = process.env[name];
    if (value && value.trim().length > 0) return { key: value, source: 'env', envName: name };
  }
  return null;
}

/**
 * Merges one provider id from the catalog and the settings overlay.
 *
 * Key order follows the connection precedence: configured keys first (they
 * rotate), then the first non-empty catalog-declared environment variable.
 */
export function resolveProvider(providerId: string, state?: ProviderState): ProviderResolution {
  const catalog = getCachedModelsDevProvider(providerId);
  const npm = state?.npm ?? catalog?.npm;
  if (!npm) {
    return {
      ok: false,
      error: {
        id: providerId,
        reason: `provider "${providerId}" is not in the model catalog and settings declare no runtime package (npm) for it`,
      },
    };
  }
  if (!SUPPORTED_PACKAGES[npm]) {
    return {
      ok: false,
      error: {
        id: providerId,
        reason: `provider "${providerId}" needs package "${npm}", which is not installed`,
      },
    };
  }
  const apiKeys: ApiKeySource[] = (state?.keys ?? [])
    .filter((key): key is string => typeof key === 'string' && key.length > 0)
    .map((key) => ({ key, source: 'settings' as const }));
  if (apiKeys.length === 0) {
    const fromEnv = firstNonEmptyEnv(state?.env ?? catalog?.env);
    if (fromEnv) apiKeys.push(fromEnv);
  }
  if (apiKeys.length === 0) {
    return {
      ok: false,
      error: {
        id: providerId,
        reason: `provider "${providerId}" has no API key: add one to settings or set ${(state?.env ?? catalog?.env ?? []).join(' / ') || 'its key variable'}`,
      },
    };
  }
  return {
    ok: true,
    provider: {
      id: providerId,
      displayName: state?.name ?? catalog?.name ?? providerId,
      npm,
      apiKeys,
      baseURL: state?.url ?? catalog?.api ?? undefined,
      custom: !catalog,
    },
  };
}

interface PackageFactory {
  createModel: (resolved: ResolvedProvider, apiKey: string, modelId: string, fetch: typeof globalThis.fetch) => LanguageModel;
}

/**
 * The only place that knows how to construct an AI SDK provider object.
 *
 * Keyed by **package name**, not by provider: every provider whose catalog
 * entry names one of these packages works with zero additional code. A new
 * package needs one entry here; a new provider needs none.
 */
const SUPPORTED_PACKAGES: Record<string, PackageFactory> = {
  '@ai-sdk/openai-compatible': {
    createModel: (resolved, apiKey, modelId, fetch) =>
      createOpenAICompatible({
        name: resolved.id,
        apiKey,
        baseURL: stripChatCompletions(resolved.baseURL ?? ''),
        includeUsage: true,
        ...(resolved.headers ? { headers: resolved.headers } : {}),
        fetch: fetch as typeof fetch,
      }).chatModel(modelId),
  },
  '@ai-sdk/google': {
    createModel: (resolved, apiKey, modelId, fetch) =>
      createGoogleGenerativeAI({ apiKey, baseURL: resolved.baseURL, fetch: fetch as typeof fetch }).chat(modelId),
  },
  '@ai-sdk/openai': {
    createModel: (resolved, apiKey, modelId, fetch) =>
      createOpenAI({ apiKey, baseURL: resolved.baseURL, fetch: fetch as typeof fetch }).languageModel(modelId),
  },
  '@ai-sdk/anthropic': {
    createModel: (resolved, apiKey, modelId, fetch) =>
      createAnthropic({ apiKey, baseURL: resolved.baseURL, fetch: fetch as typeof fetch }).languageModel(modelId),
  },
  '@openrouter/ai-sdk-provider': {
    createModel: (resolved, apiKey, modelId, fetch) =>
      createOpenRouter({ apiKey, baseURL: resolved.baseURL, fetch: fetch as typeof fetch }).languageModel(modelId),
  },
};

function stripChatCompletions(rawUrl: string): string {
  return rawUrl.replace(/\/chat\/completions\/?$/i, '').replace(/\/+$/, '');
}

/** True when the named runtime package is installed and usable. */
export function isPackageSupported(npm: string): boolean {
  return npm in SUPPORTED_PACKAGES;
}

/** Installed runtime packages a custom provider can use, sorted. */
export function listSupportedPackages(): string[] {
  return Object.keys(SUPPORTED_PACKAGES).sort();
}

/**
 * Builds the AI SDK language model for one provider id and model id.
 * Returns null with a reason when the provider cannot run, so callers route
 * around it instead of crashing. Pass an explicit `apiKey` to rotate through
 * several keys; otherwise the first resolved key is used.
 */
export function createLanguageModel(
  providerId: string,
  modelId: string,
  state: ProviderState | undefined,
  fetch: typeof globalThis.fetch,
  apiKey?: string,
): { ok: true; model: LanguageModel; resolved: ResolvedProvider } | { ok: false; error: UnavailableProvider } {
  const resolution = resolveProvider(providerId, state);
  if (!resolution.ok) return resolution;
  const { provider } = resolution;
  const key = apiKey ?? provider.apiKeys[0]?.key ?? '';
  const factory = SUPPORTED_PACKAGES[provider.npm];
  if (!factory) {
    return { ok: false, error: { id: providerId, reason: `package "${provider.npm}" is not supported` } };
  }
  return { ok: true, model: factory.createModel(provider, key, modelId, fetch), resolved: provider };
}

/**
 * How a model asks for a tool.
 *
 * `native` is the only mode the API supports. `inline` exists for endpoints that
 * ignore the `tools` field and write the call into the text body as JSON or XML;
 * those models must be declared in settings because the catalog cannot tell us.
 * `unknown` means the model was never shown to call a tool, so routing treats it
 * as unusable for tool work rather than guessing.
 */
export type ToolCallMode = 'native' | 'inline' | 'unsupported' | 'unknown';

/**
 * Resolves a model's tool-call mode from the catalog, with the settings
 * declaration winning. A custom provider's explicitly listed models are assumed
 * native-capable: the operator declared them usable, and the catalog has no
 * opinion about an endpoint it never saw.
 */
export function toolCallMode(providerId: string, modelId: string, state?: ProviderState): ToolCallMode {
  const declared = state?.inlineToolCallModels ?? [];
  if (declared.includes(modelId)) return 'inline';
  const catalog = getCachedModelsDevProvider(providerId);
  const metadata = catalog?.models?.[modelId];
  if (metadata?.tool_call === true) return 'native';
  if (metadata?.tool_call === false) return 'unsupported';
  if (!catalog && state?.npm && (state.models ?? []).includes(modelId)) return 'native';
  return 'unknown';
}

/** True when this model can be used for a call that needs tools. */
export function canUseTools(providerId: string, modelId: string, state?: ProviderState): boolean {
  const mode = toolCallMode(providerId, modelId, state);
  return mode === 'native' || mode === 'inline';
}

/** True when this model writes its tool call into the text body. */
export function usesInlineToolCalls(providerId: string, modelId: string, state?: ProviderState): boolean {
  return toolCallMode(providerId, modelId, state) === 'inline';
}

/** True when the resolved runtime package shapes reasoning options the Google way. */
export function usesGoogleOptions(npm: string): boolean {
  return npm === '@ai-sdk/google';
}

export interface RoutableModel {
  providerId: string;
  model: string;
  state: ProviderState | undefined;
}

/**
 * Every model the router may offer, derived from data alone: enabled settings
 * entries joined against the catalog (or a custom provider's explicit list),
 * in the configured order with unlisted providers appended in catalog order.
 */
export function listRoutableModels(
  settings: { providerOrder: string[]; providers: Record<string, ProviderState> },
  catalogIds: string[],
): RoutableModel[] {
  const ordered = [...settings.providerOrder.filter((id) => settings.providers[id]?.enabled)];
  for (const id of [...catalogIds, ...Object.keys(settings.providers)]) {
    if (settings.providers[id]?.enabled && !ordered.includes(id)) ordered.push(id);
  }
  const catalogModelsOf = (pid: string): string[] => {
    const state = settings.providers[pid];
    if (!state) return [];
    const catalog = getCachedModelsDevProvider(pid);
    if (catalog?.models) {
      const ids = Object.keys(catalog.models);
      return state.models.length > 0 ? ids.filter((id) => state.models.includes(id)) : ids;
    }
    /* Custom provider: only the explicitly listed models exist. */
    return state.npm ? [...state.models] : [];
  };
  return ordered.flatMap((pid) =>
    catalogModelsOf(pid).map((model) => ({ providerId: pid, model, state: settings.providers[pid] })),
  );
}

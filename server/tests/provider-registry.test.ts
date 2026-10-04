import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { getDataPath } from '../src/storage.js';
import {
  canUseTools,
  createLanguageModel,
  isPackageSupported,
  listRoutableModels,
  resolveProvider,
  toolCallMode,
  usesInlineToolCalls,
  type ProviderState,
} from '../src/provider-registry.js';

/**
 * Writes a minimal catalog into this test file's own data directory, so all
 * lookups run against a known snapshot instead of the network or whatever
 * happens to be cached on the developer's machine.
 */
function seedCatalog(): void {
  mkdirSync(getDataPath(), { recursive: true });
  writeFileSync(
    getDataPath('models.dev-cache.json'),
    JSON.stringify({
      fetchedAt: new Date().toISOString(),
      providers: {
        google: {
          id: 'google',
          name: 'Google',
          npm: '@ai-sdk/google',
          env: ['GOOGLE_API_KEY'],
          models: {
            'gemini-2.5-pro': { id: 'gemini-2.5-pro', tool_call: true, cost: { input: 1.25, output: 10 } },
          },
        },
        groq: {
          id: 'groq',
          name: 'Groq',
          npm: '@ai-sdk/openai-compatible',
          api: 'https://api.groq.com/openai/v1',
          env: ['GROQ_API_KEY'],
          models: {
            'llama-3.3-70b': { id: 'llama-3.3-70b', tool_call: true, cost: { input: 0.59, output: 0.79 } },
            'no-tools-model': { id: 'no-tools-model', tool_call: false },
          },
        },
        anthropic: {
          id: 'anthropic',
          name: 'Anthropic',
          npm: '@ai-sdk/anthropic',
          env: ['ANTHROPIC_API_KEY'],
          models: {
            'claude-sonnet-4-5': { id: 'claude-sonnet-4-5', tool_call: true },
          },
        },
        exotic: {
          id: 'exotic',
          name: 'Exotic',
          npm: '@vendor/no-such-package',
          env: ['EXOTIC_API_KEY'],
          models: {
            'exotic-1': { id: 'exotic-1', tool_call: true },
          },
        },
      },
    }),
  );
}

seedCatalog();

function state(over: Partial<ProviderState> = {}): ProviderState {
  return { enabled: true, keys: [], models: [], ...over };
}

describe('resolveProvider', () => {
  it('resolves everything from the catalog when settings only enable', () => {
    const r = resolveProvider('groq', state({ keys: ['gsk_1'] }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.provider.npm).toBe('@ai-sdk/openai-compatible');
    expect(r.provider.baseURL).toBe('https://api.groq.com/openai/v1');
    expect(r.provider.displayName).toBe('Groq');
    expect(r.provider.apiKeys).toEqual([{ key: 'gsk_1', source: 'settings' }]);
    expect(r.provider.custom).toBe(false);
  });

  it('lets settings override the endpoint and the name', () => {
    const r = resolveProvider('groq', state({ keys: ['k'], url: 'https://proxy.example/v1', name: 'Proxy' }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.provider.baseURL).toBe('https://proxy.example/v1');
    expect(r.provider.displayName).toBe('Proxy');
  });

  it('falls back to the catalog-declared environment variable', () => {
    process.env.GROQ_API_KEY = 'env-key-1';
    try {
      const r = resolveProvider('groq', state());
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.provider.apiKeys).toEqual([{ key: 'env-key-1', source: 'env', envName: 'GROQ_API_KEY' }]);
    } finally {
      delete process.env.GROQ_API_KEY;
    }
  });

  it('prefers settings keys over the environment', () => {
    process.env.GROQ_API_KEY = 'env-key-1';
    try {
      const r = resolveProvider('groq', state({ keys: ['a', 'b'] }));
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.provider.apiKeys.map((k) => k.key)).toEqual(['a', 'b']);
    } finally {
      delete process.env.GROQ_API_KEY;
    }
  });

  it('reports a missing key instead of failing later', () => {
    const r = resolveProvider('groq', state());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.reason).toMatch(/no API key/);
  });

  it('resolves a keyless provider flagged anonymous', () => {
    /* Anonymous endpoints serve key callers: the SDK omits the Authorization
       header on an empty key, so resolution succeeds with no keys. */
    const r = resolveProvider('groq', state({ anonymous: true }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.provider.apiKeys).toEqual([]);
  });

  it('prefers an explicit key over anonymous', () => {
    const r = resolveProvider('groq', state({ keys: ['k'], anonymous: true }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.provider.apiKeys).toEqual([{ key: 'k', source: 'settings' }]);
  });

  it('reports an uninstalled runtime package by name', () => {
    const r = resolveProvider('exotic', state({ keys: ['k'] }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.reason).toMatch(/@vendor\/no-such-package/);
  });

  it('supports a catalog-unknown provider declared in settings', () => {
    const r = resolveProvider(
      'self-hosted',
      state({ keys: ['k'], npm: '@ai-sdk/openai-compatible', url: 'http://127.0.0.1:11434/v1', models: ['llama2'] }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.provider.custom).toBe(true);
    expect(r.provider.npm).toBe('@ai-sdk/openai-compatible');
    expect(r.provider.baseURL).toBe('http://127.0.0.1:11434/v1');
  });

  it('rejects a catalog-unknown provider with no declared runtime', () => {
    const r = resolveProvider('mystery', state({ keys: ['k'] }));
    expect(r.ok).toBe(false);
  });
});

describe('createLanguageModel', () => {
  it('builds a model for every installed package without naming a provider', async () => {
    const seen = new Set<string>();
    for (const [providerId, npm, model] of [
      ['groq', '@ai-sdk/openai-compatible', 'llama-3.3-70b'],
      ['google', '@ai-sdk/google', 'gemini-2.5-pro'],
      ['anthropic', '@ai-sdk/anthropic', 'claude-sonnet-4-5'],
    ] as const) {
      const created = createLanguageModel(providerId, model, state({ keys: ['k'] }), fetch);
      expect(created.ok).toBe(true);
      if (!created.ok) continue;
      expect(created.resolved.npm).toBe(npm);
      seen.add(npm);
    }
    expect(seen.size).toBe(3);
  });

  it('uses the passed key instead of the first resolved one', () => {
    const created = createLanguageModel('groq', 'llama-3.3-70b', state({ keys: ['first', 'second'] }), fetch, 'second');
    expect(created.ok).toBe(true);
  });

  it('refuses a provider whose package is not installed', () => {
    const created = createLanguageModel('exotic', 'exotic-1', state({ keys: ['k'] }), fetch);
    expect(created.ok).toBe(false);
  });
});

describe('isPackageSupported', () => {
  it('accepts installed packages and rejects the rest', () => {
    expect(isPackageSupported('@ai-sdk/openai-compatible')).toBe(true);
    expect(isPackageSupported('@ai-sdk/google')).toBe(true);
    expect(isPackageSupported('@ai-sdk/openai')).toBe(true);
    expect(isPackageSupported('@ai-sdk/anthropic')).toBe(true);
    expect(isPackageSupported('@openrouter/ai-sdk-provider')).toBe(true);
    expect(isPackageSupported('@vendor/no-such-package')).toBe(false);
  });
});

describe('tool call mode', () => {
  it('trusts an explicit inline declaration over the catalog', () => {
    expect(toolCallMode('groq', 'llama-3.3-70b', state({ inlineToolCallModels: ['llama-3.3-70b'] }))).toBe('inline');
  });

  it('reports a model absent from the catalog and undeclared as unknown', () => {
    expect(toolCallMode('groq', 'never-heard-of-it', state())).toBe('unknown');
  });

  it('refuses to guess that an unknown model can use tools', () => {
    expect(canUseTools('groq', 'never-heard-of-it', state())).toBe(false);
  });

  it('reads native support from the catalog', () => {
    expect(toolCallMode('groq', 'llama-3.3-70b', state())).toBe('native');
    expect(canUseTools('groq', 'llama-3.3-70b', state())).toBe(true);
    expect(usesInlineToolCalls('groq', 'llama-3.3-70b', state())).toBe(false);
  });

  it('refuses a cataloged model whose catalog entry forbids tool calls', () => {
    expect(toolCallMode('groq', 'no-tools-model', state())).toBe('unsupported');
    expect(canUseTools('groq', 'no-tools-model', state())).toBe(false);
  });

  it('treats a custom provider explicitly listed models as native-capable', () => {
    const custom = state({ npm: '@ai-sdk/openai-compatible', models: ['llama2'] });
    expect(toolCallMode('self-hosted', 'llama2', custom)).toBe('native');
    expect(canUseTools('self-hosted', 'llama2', custom)).toBe(true);
  });

  it('marks only declared models as inline', () => {
    expect(usesInlineToolCalls('groq', 'llama-3.3-70b', state({ inlineToolCallModels: ['llama-3.3-70b'] }))).toBe(true);
    expect(usesInlineToolCalls('groq', 'llama-3.3-70b', state())).toBe(false);
  });
});

describe('listRoutableModels', () => {
  it('lists enabled providers in the configured order', () => {
    const settings = {
      providerOrder: ['groq'],
      providers: {
        groq: state({ keys: ['k'] }),
        anthropic: state({ keys: ['k'] }),
      },
    };
    const ids = listRoutableModels(settings, ['google', 'groq', 'anthropic']).map((m) => m.providerId);
    expect(ids[0]).toBe('groq');
    expect(new Set(ids)).toEqual(new Set(['groq', 'anthropic']));
  });

  it('applies the model whitelist and skips disabled providers', () => {
    const settings = {
      providerOrder: [],
      providers: {
        groq: state({ keys: ['k'], models: ['llama-3.3-70b'] }),
        google: state({ keys: ['k'], enabled: false }),
      },
    };
    const models = listRoutableModels(settings, ['google', 'groq']);
    expect(models.map((m) => m.model)).toEqual(['llama-3.3-70b']);
  });

  it('includes a custom provider explicitly listed models', () => {
    const settings = {
      providerOrder: [],
      providers: {
        'self-hosted': state({ keys: ['k'], npm: '@ai-sdk/openai-compatible', models: ['llama2'] }),
      },
    };
    expect(listRoutableModels(settings, ['groq'])).toEqual([
      { providerId: 'self-hosted', model: 'llama2', state: settings.providers['self-hosted'] },
    ]);
  });
});

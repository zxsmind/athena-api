import { afterEach, describe, expect, it, vi } from 'vitest';
import { callLLM, callLLMStream } from '../src/llm.js';
import { loadSettings, saveSettings } from '../src/settings-store.js';

function configure(id: string, fallback = false): void {
  const settings = loadSettings();
  settings.providers = {
    [id]: { enabled: true, keys: ['key-1', 'key-2'], models: ['model'], npm: '@ai-sdk/openai-compatible', url: `https://${id}.example/v1` },
    ...(fallback ? { backup: { enabled: true, keys: ['key'], models: ['model'], npm: '@ai-sdk/openai-compatible', url: 'https://backup.example/v1' } } : {}),
  };
  settings.providerOrder = [id, ...(fallback ? ['backup'] : [])];
  settings.modelRouting.default = {
    primary: { providerId: id, model: 'model' },
    fallback: fallback ? [{ providerId: 'backup', model: 'model' }] : [],
  };
  saveSettings(settings);
}

afterEach(() => vi.unstubAllGlobals());

describe('rejected LLM requests', () => {
  it.each([404, 422])('does not repeat a %s across keys or route recovery', async (status) => {
    configure(`rejected-${status}`);
    const request = vi.fn(async () => Response.json({ error: { message: 'Endpoint rejected request' } }, { status }));
    vi.stubGlobal('fetch', request);
    await expect(callLLMStream({ messages: [{ role: 'user', content: 'hello' }], role: 'default' }))
      .rejects.toThrow('Endpoint rejected request');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('continues to a configured fallback after a missing endpoint', async () => {
    configure('missing', true);
    const request = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      if (String(input).includes('missing.example')) {
        return Response.json({ error: { message: 'No endpoints found' } }, { status: 404 });
      }
      return Response.json({
        id: 'reply', model: 'model', created: 1,
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    });
    vi.stubGlobal('fetch', request);
    const result = await callLLM({ messages: [{ role: 'user', content: 'hello' }], role: 'default' });
    expect(result.provider).toBe('backup');
    expect(request).toHaveBeenCalledTimes(2);
  });
});

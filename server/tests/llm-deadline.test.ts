import { afterEach, describe, expect, it, vi } from 'vitest';
import { callLLM } from '../src/llm.js';
import { loadSettings, saveSettings } from '../src/settings-store.js';

function configure(id: string): void {
  const settings = loadSettings();
  settings.providers = {
    [id]: { enabled: true, keys: ['key-1'], models: ['model'], npm: '@ai-sdk/openai-compatible', url: `https://${id}.example/v1` },
  };
  settings.providerOrder = [id];
  settings.modelRouting.default = { primary: { providerId: id, model: 'model' }, fallback: [] };
  saveSettings(settings);
}

const okBody = {
  id: 'reply', model: 'model', created: 1,
  choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

/** A provider that accepts the request and then never answers it. Honours the
 *  abort signal, as fetch does, so the call can actually be ended. */
function hangingFetch() {
  return vi.fn((_input: unknown, init?: { signal?: AbortSignal }) => new Promise<never>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('The operation was aborted')));
  }));
}

afterEach(() => vi.unstubAllGlobals());

describe('the caller bounds the call', () => {
  it('ends a call that never answers at the deadline it was given', async () => {
    configure('deadline-hang');
    const request = hangingFetch();
    vi.stubGlobal('fetch', request);
    /* Non-streaming, so there is no idle timer to fall back on: the bound the
       caller supplied is the only thing that can end this call. Without one it
       would sit here forever. */
    await expect(callLLM({
      messages: [{ role: 'user', content: 'hello' }],
      role: 'default',
      deadlineMs: 40,
    })).rejects.toThrow(/used its full \d+s budget after \d+ attempts/);
    expect(request).toHaveBeenCalled();
  });

  it('names the budget instead of blaming the targets', async () => {
    /* The old wording ended the run with "all targets exhausted", which sent
       readers looking for a fallback model that does not exist when the real
       fact was that the call had spent the time it was given. */
    configure('deadline-wording');
    vi.stubGlobal('fetch', hangingFetch());
    await expect(callLLM({
      messages: [{ role: 'user', content: 'hello' }],
      role: 'default',
      deadlineMs: 40,
      label: 'probe',
    })).rejects.toThrow(/^probe — used its full/);
  });

  it('reports what the call cost, so a budget can be read against it', async () => {
    configure('deadline-metrics');
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(okBody)));
    const result = await callLLM({
      messages: [{ role: 'user', content: 'hello' }],
      role: 'default',
      reasoningEffort: 'low',
    });
    /* A wall-clock promise is only meaningful next to these two numbers, which
       is why they ride on the result instead of only into the trace. */
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.reasoningEffort).toBe('low');
  });

  it('reports the effort a provider floor raised the request to', async () => {
    configure('deadline-floor');
    const settings = loadSettings();
    settings.providers['deadline-floor'].reasoningEffort = 'xhigh';
    saveSettings(settings);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(okBody)));
    const result = await callLLM({
      messages: [{ role: 'user', content: 'hello' }],
      role: 'default',
      reasoningEffort: 'low',
    });
    /* The mode asked for low; the provider made it xhigh. A budget sized from
       what was requested would have been sized for the wrong call. */
    expect(result.reasoningEffort).toBe('xhigh');
  });

  it('reports no effort for a model the provider never lets think', async () => {
    configure('deadline-disabled');
    const settings = loadSettings();
    settings.providers['deadline-disabled'].reasoningEffort = 'xhigh';
    settings.providers['deadline-disabled'].disabledThinkingModels = ['model'];
    saveSettings(settings);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(okBody)));
    const result = await callLLM({
      messages: [{ role: 'user', content: 'hello' }],
      role: 'default',
      reasoningEffort: 'xhigh',
    });
    expect(result.reasoningEffort).toBe('none');
  });
});

import { describe, expect, it } from 'vitest';
import { applyReasoningFloor, modelProviderOptions, type TargetReference } from '../src/llm.js';
import type { SettingsStore } from '../src/settings-store.js';

type ProviderState = SettingsStore['providers'][string];

const sovinfra = (overrides: Partial<ProviderState> = {}): ProviderState =>
  ({ enabled: true, keys: ['k'], models: ['qwen3.8-27b'], ...overrides }) as ProviderState;

const target = (id: string): TargetReference => ({ source: 'provider', id, url: '', model: 'qwen3.8-27b' });

describe('reasoning effort on the wire', () => {
  it('uses the generic package namespace for openai-compatible endpoints', () => {
    /* The package reads providerOptions.openaiCompatible; a custom provider id
       never arrived, so the effort died in the SDK while traces labelled it. */
    expect(
      modelProviderOptions(target('sovinfra'), sovinfra(), '@ai-sdk/openai-compatible', 'low'),
    ).toEqual({ openaiCompatible: { reasoningEffort: 'low' } });
  });

  it('keeps the provider id namespace for first-party packages', () => {
    expect(
      modelProviderOptions(target('openai'), sovinfra(), '@ai-sdk/openai', 'low'),
    ).toEqual({ openai: { reasoningEffort: 'low' } });
  });

  it('sends nothing without an effort or for a non-thinking model', () => {
    expect(
      modelProviderOptions(target('sovinfra'), sovinfra(), '@ai-sdk/openai-compatible', undefined),
    ).toBeUndefined();
    expect(
      modelProviderOptions(
        target('sovinfra'),
        sovinfra({ disabledThinkingModels: ['qwen3.8-27b'] }),
        '@ai-sdk/openai-compatible',
        'low',
      ),
    ).toBeUndefined();
  });

  it('lifts a disabled round effort up to the provider floor', () => {
    /* Kilo rejects disabled reasoning, so its settings declare a floor and
       instant rounds travel as low instead of failing at the endpoint. */
    expect(
      modelProviderOptions(target('kilo'), sovinfra({ reasoningEffort: 'low' }), '@ai-sdk/openai-compatible', 'none'),
    ).toEqual({ openaiCompatible: { reasoningEffort: 'low' } });
  });

  it('never lowers a round that already clears the floor', () => {
    expect(
      modelProviderOptions(target('kilo'), sovinfra({ reasoningEffort: 'low' }), '@ai-sdk/openai-compatible', 'xhigh'),
    ).toEqual({ openaiCompatible: { reasoningEffort: 'xhigh' } });
  });

  it('sends medium for SovInfra low rounds while preserving xhigh rounds', () => {
    const provider = sovinfra({ reasoningEffort: 'medium' });
    expect(modelProviderOptions(target('sovinfra'), provider, '@ai-sdk/openai-compatible', 'low'))
      .toEqual({ openaiCompatible: { reasoningEffort: 'medium' } });
    expect(modelProviderOptions(target('sovinfra'), provider, '@ai-sdk/openai-compatible', 'xhigh'))
      .toEqual({ openaiCompatible: { reasoningEffort: 'xhigh' } });
  });
});

describe('applyReasoningFloor', () => {
  it('passes the round through when no floor is set', () => {
    expect(applyReasoningFloor('none', undefined)).toBe('none');
    expect(applyReasoningFloor(undefined, undefined)).toBeUndefined();
  });

  it('rounds a non-wire floor up to the nearest wire value', () => {
    expect(applyReasoningFloor('none', 'minimal')).toBe('low');
    expect(applyReasoningFloor('none', 'high')).toBe('xhigh');
  });
});

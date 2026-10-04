import { describe, expect, it } from 'vitest';
import { auditConfiguration } from '../src/startup-guard.js';
import type { SettingsStore } from '../src/settings-store.js';

const base = (): SettingsStore => ({
  port: 39921,
  host: '0.0.0.0',
  providers: {},
  searchProviders: {},
} as unknown as SettingsStore);

const withProvider = (overrides: Record<string, unknown> = {}): SettingsStore => ({
  ...base(),
  providers: { anthropic: { enabled: true, keys: ['sk-test'], models: [], ...overrides } },
} as unknown as SettingsStore);

describe('auditConfiguration', () => {
  it('blocks a completely empty configuration', () => {
    const audit = auditConfiguration(base());
    expect(audit.ready).toBe(false);
    expect(audit.blockers).toHaveLength(1);
    expect(audit.blockers[0]).toMatch(/No LLM provider is configured/);
  });

  it('blocks when every provider is disabled', () => {
    const audit = auditConfiguration(withProvider({ enabled: false }));
    expect(audit.ready).toBe(false);
  });

  it('blocks when providers exist but hold no key', () => {
    const audit = auditConfiguration(withProvider({ keys: [] }));
    expect(audit.ready).toBe(false);
  });

  it('is ready with one enabled provider that has a key', () => {
    const audit = auditConfiguration(withProvider());
    expect(audit.ready).toBe(true);
    expect(audit.providers).toEqual(['anthropic']);
    expect(audit.blockers).toEqual([]);
  });

  it('counts every usable provider, not just the first', () => {
    const settings = withProvider() as unknown as {
      providers: Record<string, { enabled: boolean; keys: string[]; models: string[] }>;
    };
    settings.providers.openai = { enabled: true, keys: ['sk-openai'], models: [] };
    const audit = auditConfiguration(settings as unknown as SettingsStore);
    expect(audit.providers).toEqual(['anthropic', 'openai']);
  });

  it('treats a missing search backend as a warning, not a blocker', () => {
    const audit = auditConfiguration(withProvider());
    expect(audit.ready).toBe(true);
    expect(audit.warnings).toHaveLength(1);
    expect(audit.warnings[0]).toMatch(/503/);
  });

  it('reports no warnings once a search backend has a key', () => {
    const settings = withProvider() as unknown as {
      searchProviders: Record<string, { keys: string[]; url?: string; zone?: string }>;
    };
    settings.searchProviders = { serper: { keys: ['serper-key'] } };
    const audit = auditConfiguration(settings as unknown as SettingsStore);
    expect(audit.warnings).toEqual([]);
    expect(audit.searches).toEqual(['serper']);
  });

  it('ignores a search backend whose key list is empty', () => {
    const settings = withProvider() as unknown as {
      searchProviders: Record<string, { keys: string[] }>;
    };
    settings.searchProviders = { serper: { keys: [] } };
    expect(auditConfiguration(settings as unknown as SettingsStore).warnings).toHaveLength(1);
  });
});

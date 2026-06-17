import React from 'react';

export type TabKey = 'general' | 'providers' | 'models' | 'advanced' | 'api';

export interface ProviderConfig {
  enabled: boolean;
  name: string;
  keys: string[];
  models: string[];
  url: string;
  label: string;
}

export interface ModelReference {
  providerId: string;
  model: string;
}

export interface ModelRoute {
  primary: ModelReference;
  fallback: ModelReference[];
}

export interface ModelRouting {
  title: ModelRoute;
  reasoning: ModelRoute;
  instant: ModelRoute;
  deep: ModelRoute;
}

export interface ApiSettingsData {
  defaultMaxConcurrent: number;
  maxActiveJobs: number;
  maxActiveBatches: number;
  maxEventsPerJob: number;
  maxEventsPerBatch: number;
  maxRetentionMinutes: number;
  defaultMode: 'quick' | 'deep';
}

export interface SettingsData {
  version: number;
  port: number;
  host: string;
  providerOrder: string[];
  providers: Record<string, ProviderConfig>;
  serper: { keys: string[]; url: string };
  research: {
    maxCreditsPerQuery: number;
    maxFollowUpQueries: number;
  };
  modelRouting: ModelRouting;
  api: ApiSettingsData;
  thinkingStripPatterns: string;
  maxSources: number;
  deepIterations: number;
}

export const PROVIDER_KEYS = ['groq', 'gemini', 'vercel', 'openrouter', 'custom'] as const;
export const PROVIDER_LABELS: Record<(typeof PROVIDER_KEYS)[number], string> = {
  groq: 'Groq',
  gemini: 'Gemini',
  vercel: 'Vercel AI Gateway',
  openrouter: 'OpenRouter',
  custom: 'Custom',
};

export const ROLE_LABELS: Record<keyof ModelRouting, string> = {
  title: 'Title',
  reasoning: 'Reasoning',
  instant: 'Instant',
  deep: 'Deep',
};

export const PROVIDER_OPTIONS = PROVIDER_KEYS.map(key => ({ value: key, label: PROVIDER_LABELS[key] }));

export const TABS: { key: TabKey; label: string; icon: React.ReactNode }[] = [
  { key: 'general', label: 'General', icon: React.createElement('span', { dangerouslySetInnerHTML: { __html: '⚙' } }) as any },
  { key: 'providers', label: 'Providers', icon: React.createElement('span', { dangerouslySetInnerHTML: { __html: '🔑' } }) as any },
  { key: 'models', label: 'Models', icon: React.createElement('span', { dangerouslySetInnerHTML: { __html: '💻' } }) as any },
  { key: 'advanced', label: 'Advanced', icon: React.createElement('span', { dangerouslySetInnerHTML: { __html: '⚡' } }) as any },
  { key: 'api', label: 'API', icon: React.createElement('span', { dangerouslySetInnerHTML: { __html: '🖥' } }) as any },
];

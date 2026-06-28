import React from 'react';

export type TabKey = 'general' | 'providers' | 'models' | 'advanced' | 'api';

export interface ProviderConfig {
  enabled: boolean;
  name: string;
  keys: string[];
  models: string[];
  url: string;
  label: string;
  reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high';
  includeThoughts?: boolean;
  disabledThinkingModels?: string[];
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

export type DeepDepth = 'low' | 'med' | 'high' | 'ultra';

export interface ResearchDepthPresetConfig {
  budgetCredits: number;
  maxRounds: number;
  minCooldownMs: number;
  maxCooldownMs: number;
  notebookCadenceRawBlocks: number;
  minIndependentSourcesForKeyClaims: number;
  contradictionPass: boolean;
  primarySourcePreference: boolean;
  exhaustiveGapReview: boolean;
  checkpointEveryRounds: number;
}

export interface ResearchDepthsSettings {
  defaultDepth: DeepDepth;
  presets: Record<DeepDepth, ResearchDepthPresetConfig>;
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
  research: Record<string, unknown>;
  researchDepths: ResearchDepthsSettings;
  modelRouting: ModelRouting;
  api: ApiSettingsData;
  thinkingStripPatterns: string;
  maxSources: number;
  deepIterations: number;
  showDebugContext?: boolean;
  autocompleteCount: number;
  notebookEnabled: boolean;
}

export const DEPTH_LABELS: Record<DeepDepth, string> = {
  low: 'Deep Low',
  med: 'Deep Med',
  high: 'Deep High',
  ultra: 'Deep Ultra',
};

export const DEPTH_KEYS: DeepDepth[] = ['low', 'med', 'high', 'ultra'];

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

export const TABS: { key: TabKey; label: string; icon?: React.ReactNode }[] = [
  { key: 'general', label: 'General' },
  { key: 'providers', label: 'Providers' },
  { key: 'models', label: 'Models' },
  { key: 'advanced', label: 'Advanced' },
  { key: 'api', label: 'API' },
];

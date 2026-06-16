import React, { useEffect, useState, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  X,
  Plus,
  Trash2,
  Check,
  AlertCircle,
  Settings2,
  Hash,
  Globe,
  Key,
  Cpu,
  Search,
  Brain,
  SlidersHorizontal,
  Server,
  Boxes,
  Gauge,
  Layers,
  ChevronUp,
  ChevronDown,
  FileText,
  ExternalLink,
} from 'lucide-react';

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
}

interface ProviderConfig {
  enabled: boolean;
  name: string;
  keys: string[];
  models: string[];
  url: string;
  label: string;
}

interface ModelReference {
  providerId: string;
  model: string;
}

interface ModelRoute {
  primary: ModelReference;
  fallback: ModelReference[];
}

interface ModelRouting {
  title: ModelRoute;
  reasoning: ModelRoute;
  instant: ModelRoute;
  deep: ModelRoute;
}

interface ApiSettingsData {
  defaultMaxConcurrent: number;
  maxActiveJobs: number;
  maxActiveBatches: number;
  maxEventsPerJob: number;
  maxEventsPerBatch: number;
  maxRetentionMinutes: number;
  defaultMode: 'quick' | 'deep';
}

interface SettingsData {
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

type TabKey = 'general' | 'providers' | 'models' | 'advanced' | 'api';

const PROVIDER_KEYS = ['groq', 'gemini', 'vercel', 'openrouter', 'custom'] as const;
const PROVIDER_LABELS: Record<(typeof PROVIDER_KEYS)[number], string> = {
  groq: 'Groq',
  gemini: 'Gemini',
  vercel: 'Vercel AI Gateway',
  openrouter: 'OpenRouter',
  custom: 'Custom',
};

const ROLE_LABELS: Record<keyof ModelRouting, string> = {
  title: 'Title',
  reasoning: 'Reasoning',
  instant: 'Instant',
  deep: 'Deep',
};

const PROVIDER_OPTIONS = PROVIDER_KEYS.map(key => ({ value: key, label: PROVIDER_LABELS[key] }));

const TABS: { key: TabKey; label: string; icon: React.ReactNode }[] = [
  { key: 'general', label: 'General', icon: <Settings2 size={13} /> },
  { key: 'providers', label: 'Providers', icon: <Key size={13} /> },
  { key: 'models', label: 'Models', icon: <Cpu size={13} /> },
  { key: 'advanced', label: 'Advanced', icon: <SlidersHorizontal size={13} /> },
  { key: 'api', label: 'API', icon: <Server size={13} /> },
];

export default function SettingsModal({ open, onClose }: SettingsModalProps) {
  const [data, setData] = useState<SettingsData | null>(null);
  const [activeTab, setActiveTab] = useState<TabKey>('general');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'ok' | 'error'; text: string } | null>(null);
  const [dirty, setDirty] = useState(false);
  const [promptConfig, setPromptConfig] = useState<{
    open: boolean;
    title: string;
    placeholder: string;
    isPassword: boolean;
    value: string;
    onSubmit: (val: string) => void;
  }>({
    open: false,
    title: '',
    placeholder: '',
    isPassword: false,
    value: '',
    onSubmit: () => {},
  });

  useEffect(() => {
    if (!open) return;
    fetch('/api/settings')
      .then(r => r.json())
      .then(d => {
        setData(d);
        setActiveTab('general');
        setDirty(false);
        setMessage(null);
      })
      .catch(() => setMessage({ type: 'error', text: 'Failed to load settings' }));
  }, [open]);

  const save = useCallback(async (currentData: SettingsData) => {
    setSaving(true);
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(currentData),
      });
      if (!res.ok) throw new Error('Save failed');
      setDirty(false);
      setMessage(null);
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message || 'Save failed' });
    } finally {
      setSaving(false);
    }
  }, []);

  const currentDataRef = React.useRef<SettingsData | null>(null);
  const dirtyRef = React.useRef(false);

  useEffect(() => {
    currentDataRef.current = data;
    dirtyRef.current = dirty;
  }, [data, dirty]);

  // Debounced auto-save
  useEffect(() => {
    if (!data || !dirty) return;

    const timer = setTimeout(() => {
      save(data);
    }, 600);

    return () => clearTimeout(timer);
  }, [data, dirty, save]);

  // Immediate save on unmount (e.g. modal closed)
  useEffect(() => {
    return () => {
      if (dirtyRef.current && currentDataRef.current) {
        fetch('/api/settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(currentDataRef.current),
          keepalive: true,
        }).catch(err => console.error('Failed to auto-save on unmount:', err));
      }
    };
  }, []);

  if (!open) return null;

  const patchData = (patch: Partial<SettingsData>) => {
    if (!data) return;
    setData({ ...data, ...patch });
    setDirty(true);
  };

  const patchModelRouting = (patch: Partial<ModelRouting>) => {
    if (!data) return;
    setData({ ...data, modelRouting: { ...data.modelRouting, ...patch } });
    setDirty(true);
  };

  const updateProvider = (key: string, patch: Partial<ProviderConfig>) => {
    if (!data) return;
    setData({
      ...data,
      providers: { ...data.providers, [key]: { ...data.providers[key], ...patch } },
    });
    setDirty(true);
  };

  const moveProvider = (key: string, direction: -1 | 1) => {
    if (!data) return;
    const index = data.providerOrder.indexOf(key);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= data.providerOrder.length) return;
    const nextOrder = [...data.providerOrder];
    [nextOrder[index], nextOrder[target]] = [nextOrder[target], nextOrder[index]];
    setData({ ...data, providerOrder: nextOrder });
    setDirty(true);
  };

  const toggleProvider = (key: string) => {
    if (!data) return;
    const p = data.providers[key];
    const newEnabled = !p.enabled;
    let newOrder = [...data.providerOrder];
    if (newEnabled && !newOrder.includes(key)) {
      newOrder.push(key);
    } else if (!newEnabled) {
      newOrder = newOrder.filter(k => k !== key);
    }
    setData({
      ...data,
      providerOrder: newOrder,
      providers: { ...data.providers, [key]: { ...p, enabled: newEnabled } },
    });
    setDirty(true);
  };

  const addFallbackRef = (role: keyof ModelRouting) => {
    if (!data) return;
    const route = data.modelRouting[role];
    patchModelRouting({
      [role]: {
        ...route,
        fallback: [...route.fallback, { providerId: '', model: '' }],
      },
    } as Partial<ModelRouting>);
  };

  const removeFallbackRef = (role: keyof ModelRouting, idx: number) => {
    if (!data) return;
    const route = data.modelRouting[role];
    patchModelRouting({
      [role]: {
        ...route,
        fallback: route.fallback.filter((_, i) => i !== idx),
      },
    } as Partial<ModelRouting>);
  };

  const updateRoute = (role: keyof ModelRouting, patch: Partial<ModelRoute>) => {
    if (!data) return;
    patchModelRouting({
      [role]: patch as ModelRoute,
    } as Partial<ModelRouting>);
  };

  const showPrompt = (title: string, placeholder: string, isPassword: boolean, onSubmit: (val: string) => void) => {
    setPromptConfig({
      open: true,
      title,
      placeholder,
      isPassword,
      value: '',
      onSubmit: (val) => {
        onSubmit(val.trim());
        setPromptConfig(prev => ({ ...prev, open: false }));
      },
    });
  };

  const addKey = (provider: string) => {
    showPrompt('Add API Key', 'Enter API key...', true, (val) => {
      if (!val) return;
      const keys = [...data!.providers[provider].keys, val];
      updateProvider(provider, { keys });
    });
  };

  const removeKey = (provider: string, idx: number) => {
    const keys = data!.providers[provider].keys.filter((_, i) => i !== idx);
    updateProvider(provider, { keys });
  };

  const addModel = (provider: string) => {
    showPrompt('Add Model Name', 'Enter model name...', false, (val) => {
      if (!val) return;
      const models = [...data!.providers[provider].models, val];
      updateProvider(provider, { models });
    });
  };

  const removeModel = (provider: string, idx: number) => {
    const models = data!.providers[provider].models.filter((_, i) => i !== idx);
    updateProvider(provider, { models });
  };

  const addSerperKey = () => {
    if (!data) return;
    showPrompt('Add Serper API Key', 'Enter Serper API key...', true, (val) => {
      if (!val) return;
      patchData({ serper: { ...data.serper, keys: [...data.serper.keys, val] } });
    });
  };

  const removeSerperKey = (idx: number) => {
    if (!data) return;
    patchData({ serper: { ...data.serper, keys: data.serper.keys.filter((_, j) => j !== idx) } });
  };

  const renderTab = () => {
    if (!data) {
      return (
        <div style={{ textAlign: 'center', padding: 40, color: 'var(--athena-text-3)', fontSize: 12 }}>
          Loading...
        </div>
      );
    }

    if (activeTab === 'general') {
      return (
        <>
          <Section title="Application">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <InputRow
                icon={<Globe size={12} />}
                label="Host"
                value={data.host}
                onChange={v => patchData({ host: v })}
                placeholder="0.0.0.0"
              />
              <InputRow
                icon={<Hash size={12} />}
                label="Port"
                value={String(data.port)}
                onChange={v => patchData({ port: parseInt(v, 10) || 3001 })}
                placeholder="3001"
              />
            </div>
          </Section>

          <InfoPanel
            icon={<Brain size={13} />}
            title="General Settings Scope"
            text="This tab stays for application-wide settings. Provider credentials, task-specific model choices, research behavior, and API capabilities live in their own tabs."
          />
        </>
      );
    }

    if (activeTab === 'providers') {
      return (
        <>
          <Section title="Provider Priority">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
              {data.providerOrder.map((key, index) => {
                const p = data.providers[key];
                if (!p) return null;
                return (
                  <div key={key} style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 8,
                    padding: '7px 10px',
                    borderRadius: 8,
                    border: '0.5px solid var(--athena-border)',
                    background: p.enabled ? 'rgba(var(--athena-accent-rgb), 0.04)' : 'rgba(var(--athena-accent-rgb), 0.02)',
                    opacity: p.enabled ? 1 : 0.6,
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                      <span style={{
                        width: 18,
                        textAlign: 'center',
                        fontSize: 9,
                        color: 'var(--athena-text-3)',
                        flexShrink: 0,
                      }}>
                        {index + 1}
                      </span>
                      <span style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--athena-text)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {p.label}
                      </span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <button
                        onClick={() => moveProvider(key, -1)}
                        disabled={index === 0}
                        style={iconButtonStyle(index === 0)}
                        aria-label={`Move ${p.label} up`}
                      >
                        <ChevronUp size={11} />
                      </button>
                      <button
                        onClick={() => moveProvider(key, 1)}
                        disabled={index === data.providerOrder.length - 1}
                        style={iconButtonStyle(index === data.providerOrder.length - 1)}
                        aria-label={`Move ${p.label} down`}
                      >
                        <ChevronDown size={11} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
              {PROVIDER_KEYS.map(key => {
                const p = data.providers[key];
                return (
                  <button key={key} onClick={() => toggleProvider(key)} style={{
                    display: 'flex', alignItems: 'center', gap: 5,
                    padding: '6px 10px', borderRadius: 8, cursor: 'pointer',
                    fontSize: 10.5, fontWeight: 600, fontFamily: 'inherit',
                    border: p.enabled
                      ? '0.5px solid rgba(var(--athena-accent-rgb), 0.4)'
                      : '0.5px solid var(--athena-border)',
                    background: p.enabled
                      ? 'rgba(var(--athena-accent-rgb), 0.07)'
                      : 'transparent',
                    color: p.enabled ? 'var(--athena-text)' : 'var(--athena-text-3)',
                    transition: 'all 140ms var(--ease-out)',
                  }}>
                    {p.enabled ? <Check size={11} /> : <Plus size={11} />}
                    {p.label}
                  </button>
                );
              })}
            </div>
            <div style={{ fontSize: 9.5, color: 'var(--athena-text-3)', lineHeight: 1.5 }}>
              Enabled providers are tried in the order shown above. Ordering now persists in Settings Schema v2.
            </div>
          </Section>

          {PROVIDER_KEYS.map(key => {
            const p = data.providers[key];
            if (!p.enabled) return null;
            return (
              <Section key={key} title={p.label}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <InputRow
                    icon={<Globe size={12} />}
                    label="API URL"
                    value={p.url}
                    onChange={v => updateProvider(key, { url: v })}
                    placeholder="https://api.example.com/v1/chat/completions"
                  />

                  {key === 'custom' && (
                    <InputRow
                      icon={<Hash size={12} />}
                      label="Display Name"
                      value={p.name}
                      onChange={v => updateProvider(key, { name: v })}
                      placeholder="custom"
                    />
                  )}

                  <ListSection
                    icon={<Key size={12} />}
                    label="API Keys"
                    items={p.keys}
                    onAdd={() => addKey(key)}
                    onRemove={i => removeKey(key, i)}
                    emptyText="No API keys configured"
                    maskItems
                  />
                </div>
              </Section>
            );
          })}
        </>
      );
    }

    if (activeTab === 'models') {
      return (
        <>
          <Section title="Task Routing">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {(Object.keys(ROLE_LABELS) as (keyof ModelRouting)[]).map(role => (
                <div key={role} style={{
                  padding: '10px 12px',
                  border: '0.5px solid var(--athena-border)',
                  borderRadius: 10,
                  background: 'rgba(var(--athena-accent-rgb), 0.025)',
                }}>
                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 10,
                    marginBottom: 8,
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <Gauge size={12} style={{ color: 'var(--athena-text-3)' }} />
                      <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--athena-text)' }}>
                        {ROLE_LABELS[role]}
                      </span>
                    </div>
                    <span style={{ fontSize: 9.5, color: 'var(--athena-text-3)' }}>
                      Primary + fallback chain
                    </span>
                  </div>
                  <ModelRouteEditor
                    route={data.modelRouting[role]}
                    providers={data.providers}
                    onChange={route => updateRoute(role, route)}
                    onAddFallback={() => addFallbackRef(role)}
                    onRemoveFallback={idx => removeFallbackRef(role, idx)}
                  />
                </div>
              ))}
            </div>
          </Section>

          <Section title="Provider Models">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {PROVIDER_KEYS.map(key => {
                const p = data.providers[key];
                return (
                  <div key={key} style={{
                    padding: '10px 12px',
                    border: '0.5px solid var(--athena-border)',
                    borderRadius: 10,
                    background: 'rgba(var(--athena-accent-rgb), 0.025)',
                    opacity: p.enabled ? 1 : 0.62,
                  }}>
                    <div style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      marginBottom: 8,
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <Cpu size={12} style={{ color: 'var(--athena-text-3)' }} />
                        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--athena-text)' }}>{p.label}</span>
                      </div>
                      <span style={{ fontSize: 9.5, color: p.enabled ? 'var(--athena-text-2)' : 'var(--athena-text-3)' }}>
                        {p.enabled ? 'Enabled' : 'Disabled'}
                      </span>
                    </div>
                    <ListSection
                      icon={<Layers size={12} />}
                      label="Models"
                      items={p.models}
                      onAdd={() => addModel(key)}
                      onRemove={i => removeModel(key, i)}
                      emptyText="No models configured"
                    />
                  </div>
                );
              })}
            </div>
          </Section>
        </>
      );
    }

    if (activeTab === 'advanced') {
      return (
        <>
          <Section title="Search API">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <InputRow
                icon={<Globe size={12} />}
                label="Serper URL"
                value={data.serper.url}
                onChange={v => patchData({ serper: { ...data.serper, url: v } })}
                placeholder="https://google.serper.dev/search"
              />
              <ListSection
                icon={<Key size={12} />}
                label="Serper Keys"
                items={data.serper.keys}
                onAdd={addSerperKey}
                onRemove={removeSerperKey}
                emptyText="No Serper API keys configured"
                maskItems
              />
            </div>
          </Section>

          <Section title="Research Controls">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <InputRow
                icon={<Hash size={12} />}
                label="Max Sources"
                value={String(data.maxSources)}
                onChange={v => patchData({ maxSources: parseInt(v, 10) || 8 })}
                placeholder="8"
              />
              <InputRow
                icon={<Search size={12} />}
                label="Deep Iterations"
                value={String(data.deepIterations)}
                onChange={v => patchData({ deepIterations: parseInt(v, 10) || 3 })}
                placeholder="3"
              />
              <InputRow
                icon={<Cpu size={12} />}
                label="Thinking Strip"
                value={data.thinkingStripPatterns}
                onChange={v => patchData({ thinkingStripPatterns: v })}
                placeholder="<think>.*?</think>"
              />
            </div>
          </Section>

          <Section title="Research Budget">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <InputRow
                icon={<Boxes size={12} />}
                label="Max Credits"
                value={String(data.research.maxCreditsPerQuery)}
                onChange={v => patchData({ research: { ...data.research, maxCreditsPerQuery: parseInt(v, 10) || 20 } })}
                placeholder="20"
              />
              <InputRow
                icon={<Search size={12} />}
                label="Follow-ups"
                value={String(data.research.maxFollowUpQueries)}
                onChange={v => patchData({ research: { ...data.research, maxFollowUpQueries: parseInt(v, 10) || 3 } })}
                placeholder="3"
              />
            </div>
          </Section>

          <InfoPanel
            icon={<Boxes size={13} />}
            title="Research Budget"
            text="Credits are enforced per query. Follow-up query limits cap deep research expansion before synthesis."
          />
        </>
      );
    }

    return (
      <>
        <Section title="Job & Batch Limits">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <InputRow
              icon={<Server size={12} />}
              label="Max Active Jobs"
              value={String(data.api.maxActiveJobs)}
              onChange={v => patchData({ api: { ...data.api, maxActiveJobs: parseInt(v, 10) || 50 } })}
              placeholder="50"
            />
            <InputRow
              icon={<Server size={12} />}
              label="Max Active Batches"
              value={String(data.api.maxActiveBatches)}
              onChange={v => patchData({ api: { ...data.api, maxActiveBatches: parseInt(v, 10) || 50 } })}
              placeholder="50"
            />
            <InputRow
              icon={<Server size={12} />}
              label="Max Events / Job"
              value={String(data.api.maxEventsPerJob)}
              onChange={v => patchData({ api: { ...data.api, maxEventsPerJob: parseInt(v, 10) || 250 } })}
              placeholder="250"
            />
            <InputRow
              icon={<Server size={12} />}
              label="Max Events / Batch"
              value={String(data.api.maxEventsPerBatch)}
              onChange={v => patchData({ api: { ...data.api, maxEventsPerBatch: parseInt(v, 10) || 300 } })}
              placeholder="300"
            />
            <InputRow
              icon={<Server size={12} />}
              label="Retention (minutes)"
              value={String(data.api.maxRetentionMinutes)}
              onChange={v => patchData({ api: { ...data.api, maxRetentionMinutes: parseInt(v, 10) || 1440 } })}
              placeholder="1440"
            />
          </div>
        </Section>

        <Section title="Batch Defaults">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <InputRow
              icon={<Server size={12} />}
              label="Max Concurrent"
              value={String(data.api.defaultMaxConcurrent)}
              onChange={v => patchData({ api: { ...data.api, defaultMaxConcurrent: parseInt(v, 10) || 2 } })}
              placeholder="2"
            />
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ flexShrink: 0, color: 'var(--athena-text-3)', display: 'flex' }}><Cpu size={12} /></span>
              <span style={{ flexShrink: 0, fontSize: 10.5, color: 'var(--athena-text-2)', width: 92 }}>
                Default Mode
              </span>
              <select
                value={data.api.defaultMode}
                onChange={e => patchData({ api: { ...data.api, defaultMode: e.target.value as 'quick' | 'deep' } })}
                style={{
                  flex: 1, minWidth: 0, padding: '6px 8px', borderRadius: 6, border: '0.5px solid var(--athena-border)',
                  background: 'var(--glass-bg)', color: 'var(--athena-text)', fontSize: 10.5,
                  fontFamily: 'inherit', outline: 'none', appearance: 'none',
                }}
              >
                <option value="quick">Quick</option>
                <option value="deep">Deep</option>
              </select>
            </div>
          </div>
        </Section>

        <Section title="Available Capabilities">
          <CapabilityGrid
            items={[
              ['OpenAI-compatible endpoints', 'Supported through provider base URLs'],
              ['Custom provider capabilities', 'Supported through provider metadata'],
              ['Research job polling', 'Supported with /research-jobs/:id'],
              ['Research job events', 'Supported with /research-jobs/:id/events'],
              ['Cancellation', 'Supported with /research-jobs/:id/cancel'],
              ['Batch requests', 'Supported with /research-batches'],
            ]}
          />
        </Section>

        <Section title="Documentation">
          <a
            href="/docs/API.md"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '10px 12px', borderRadius: 10, textDecoration: 'none',
              border: '0.5px solid var(--athena-border)',
              background: 'rgba(var(--athena-accent-rgb), 0.025)',
              color: 'var(--athena-text)',
              transition: 'background 120ms',
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(var(--athena-accent-rgb), 0.06)'; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(var(--athena-accent-rgb), 0.025)'; }}
          >
            <FileText size={14} style={{ color: 'var(--athena-text-2)', flexShrink: 0 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 10.5, fontWeight: 700, marginBottom: 2 }}>Full API Reference</div>
              <div style={{ fontSize: 9.5, color: 'var(--athena-text-3)' }}>
                Complete endpoint documentation with request/response schemas, SSE events, budget system, and provider routing
              </div>
            </div>
            <ExternalLink size={12} style={{ color: 'var(--athena-text-3)', flexShrink: 0 }} />
          </a>
        </Section>
      </>
    );
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 100,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(0,0,0,0.25)',
        WebkitBackdropFilter: 'blur(6px)',
        backdropFilter: 'blur(6px)',
        animation: 'fade-in 160ms var(--ease-out) both',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        className="glass-panel-settings"
        style={{
          width: '94%', maxWidth: 880, height: 620, maxHeight: '90vh',
          display: 'flex', flexDirection: 'column',
          animation: 'scale-in 200ms var(--ease-spring) both',
        }}
      >
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '16px 18px 12px',
          borderBottom: '0.5px solid var(--athena-border)',
          flexShrink: 0,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Settings2 size={15} style={{ color: 'var(--athena-text-2)' }} />
            <h2 className="font-outfit" style={{ fontSize: 14, fontWeight: 600, margin: 0, color: 'var(--athena-text)' }}>
              Settings
            </h2>
            {saving && (
              <span style={{ fontSize: 9.5, color: 'var(--athena-text-3)', marginLeft: 6, fontStyle: 'italic', display: 'flex', alignItems: 'center', gap: 4 }}>
                <span style={{ width: 4, height: 4, borderRadius: '50%', backgroundColor: 'var(--athena-accent)', display: 'inline-block' }} />
                Saving...
              </span>
            )}
          </div>
          <button onClick={onClose} aria-label="Close settings" style={{
            background: 'none', border: 'none', cursor: 'pointer',
            color: 'var(--athena-text-3)', padding: 4, borderRadius: 6, display: 'flex',
          }}>
            <X size={14} />
          </button>
        </div>

        <div style={{
          display: 'grid',
          gridTemplateColumns: '168px minmax(0, 1fr)',
          minHeight: 0,
          flex: 1,
        }}>
          <nav style={{
            padding: 12,
            borderRight: '0.5px solid var(--athena-border)',
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            minHeight: 0,
          }}>
            {TABS.map(tab => {
              const active = activeTab === tab.key;
              return (
                <button
                  key={tab.key}
                  onClick={() => setActiveTab(tab.key)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    width: '100%',
                    padding: '8px 10px',
                    borderRadius: 8,
                    border: active ? '0.5px solid rgba(var(--athena-accent-rgb), 0.22)' : '0.5px solid transparent',
                    background: active ? 'rgba(var(--athena-accent-rgb), 0.07)' : 'transparent',
                    color: active ? 'var(--athena-text)' : 'var(--athena-text-2)',
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                    fontSize: 11,
                    fontWeight: active ? 700 : 600,
                    textAlign: 'left',
                    transition: 'all 140ms var(--ease-out)',
                  }}
                >
                  <span style={{ display: 'flex', color: active ? 'var(--athena-text)' : 'var(--athena-text-3)' }}>
                    {tab.icon}
                  </span>
                  {tab.label}
                </button>
              );
            })}
          </nav>

          <div style={{ minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            <div style={{ flex: 1, overflow: 'hidden auto', padding: '16px 18px 18px' }}>
              {renderTab()}

              {message && message.type === 'error' && (
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  marginTop: 10,
                  fontSize: 10.5,
                  color: '#ef4444',
                }}>
                  <AlertCircle size={12} />
                  {message.text}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
      <PromptDialog
        open={promptConfig.open}
        title={promptConfig.title}
        placeholder={promptConfig.placeholder}
        isPassword={promptConfig.isPassword}
        value={promptConfig.value}
        onChange={val => setPromptConfig(prev => ({ ...prev, value: val }))}
        onClose={() => setPromptConfig(prev => ({ ...prev, open: false }))}
        onSubmit={() => promptConfig.onSubmit(promptConfig.value)}
      />
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div className="font-mono" style={{
        fontSize: 9, fontWeight: 500, letterSpacing: '0.14em',
        textTransform: 'uppercase', color: 'var(--athena-text-3)', marginBottom: 10,
      }}>
        {title}
      </div>
      {children}
    </div>
  );
}

function InputRow({
  icon, label, value, onChange, placeholder,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ flexShrink: 0, color: 'var(--athena-text-3)', display: 'flex' }}>{icon}</span>
      <span style={{
        flexShrink: 0, fontSize: 10.5, color: 'var(--athena-text-2)', width: 92,
      }}>
        {label}
      </span>
      <input
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        style={{
          flex: 1, minWidth: 0, padding: '6px 8px', borderRadius: 6, border: '0.5px solid var(--athena-border)',
          background: 'var(--glass-bg)', color: 'var(--athena-text)', fontSize: 10.5,
          fontFamily: 'inherit', outline: 'none',
        }}
      />
    </div>
  );
}

function ListSection({
  icon, label, items, onAdd, onRemove, emptyText, maskItems = false,
}: {
  icon: React.ReactNode;
  label: string;
  items: string[];
  onAdd: () => void;
  onRemove: (idx: number) => void;
  emptyText: string;
  maskItems?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(true);
  const visibleItems = collapsed ? items.slice(0, 2) : items;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ color: 'var(--athena-text-3)', display: 'flex' }}>{icon}</span>
          <span style={{ fontSize: 10.5, color: 'var(--athena-text-2)' }}>
            {label} {items.length > 0 && <span style={{ color: 'var(--athena-text-3)' }}>({items.length})</span>}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          {items.length > 2 && (
            <button onClick={() => setCollapsed(!collapsed)} style={{
              background: 'none', border: 'none', cursor: 'pointer',
              color: 'var(--athena-text-3)', fontSize: 9.5, padding: '2px 6px',
              borderRadius: 4, fontFamily: 'inherit',
            }}>
              {collapsed ? 'Show all' : 'Collapse'}
            </button>
          )}
          <button onClick={onAdd} style={{
            display: 'flex', alignItems: 'center', gap: 3,
            background: 'none', border: 'none', cursor: 'pointer',
            color: 'var(--athena-accent)', fontSize: 9.5, padding: '2px 6px',
            borderRadius: 4, fontFamily: 'inherit',
          }}>
            <Plus size={10} /> Add
          </button>
        </div>
      </div>
      {items.length === 0 ? (
        <div style={{ fontSize: 10, color: 'var(--athena-text-3)', padding: '4px 0' }}>
          {emptyText}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginLeft: 18 }}>
          {visibleItems.map((item, idx) => {
            const originalIndex = idx;
            const display = maskItems ? maskSecret(item) : item;
            return (
              <div key={`${item}-${idx}`} style={{
                display: 'flex', alignItems: 'center', gap: 4,
                padding: '4px 6px', borderRadius: 5,
                background: 'rgba(var(--athena-accent-rgb), 0.03)',
                border: '0.5px solid var(--athena-border)',
              }}>
                <span style={{
                  flex: 1, minWidth: 0, fontSize: 9.5, fontFamily: '"JetBrains Mono", monospace',
                  color: 'var(--athena-text-2)', overflow: 'hidden', textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}>
                  {display.length > 44 ? display.slice(0, 42) + '...' : display}
                </span>
                <button onClick={() => onRemove(originalIndex)} aria-label={`Remove ${label}`} style={{
                  background: 'none', border: 'none', cursor: 'pointer',
                  color: 'var(--athena-text-3)', padding: 2, borderRadius: 3, display: 'flex',
                  flexShrink: 0,
                }}>
                  <Trash2 size={10} />
                </button>
              </div>
            );
          })}
          {collapsed && items.length > 2 && (
            <div style={{ fontSize: 9, color: 'var(--athena-text-3)', padding: '2px 6px' }}>
              +{items.length - 2} more
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function InfoPanel({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) {
  return (
    <div style={{
      display: 'flex',
      gap: 9,
      padding: '10px 12px',
      borderRadius: 10,
      border: '0.5px solid var(--athena-border)',
      background: 'rgba(var(--athena-accent-rgb), 0.035)',
      color: 'var(--athena-text-2)',
    }}>
      <span style={{ color: 'var(--athena-text-3)', display: 'flex', marginTop: 1 }}>{icon}</span>
      <div>
        <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--athena-text)', marginBottom: 3 }}>{title}</div>
        <div style={{ fontSize: 10, lineHeight: 1.55 }}>{text}</div>
      </div>
    </div>
  );
}

function CapabilityGrid({ items }: { items: [string, string][] }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8 }}>
      {items.map(([title, detail]) => (
        <div key={title} style={{
          padding: '10px 11px',
          borderRadius: 10,
          border: '0.5px solid var(--athena-border)',
          background: 'rgba(var(--athena-accent-rgb), 0.025)',
        }}>
          <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--athena-text)', marginBottom: 4 }}>
            {title}
          </div>
          <div style={{ fontSize: 9.5, lineHeight: 1.45, color: 'var(--athena-text-3)' }}>
            {detail}
          </div>
        </div>
      ))}
    </div>
  );
}

function ModelRouteEditor({
  route,
  providers,
  onChange,
  onAddFallback,
  onRemoveFallback,
}: {
  route: ModelRoute;
  providers: Record<string, ProviderConfig>;
  onChange: (route: ModelRoute) => void;
  onAddFallback: () => void;
  onRemoveFallback: (idx: number) => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <ModelReferenceRow
        label="Primary"
        value={route.primary}
        providers={providers}
        onChange={next => onChange({ ...route, primary: next })}
      />

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 2 }}>
        <span style={{ fontSize: 9.5, color: 'var(--athena-text-3)' }}>Fallbacks</span>
        <button onClick={onAddFallback} style={linkButtonStyle}>
          <Plus size={10} /> Add fallback
        </button>
      </div>

      {route.fallback.length === 0 ? (
        <div style={{ fontSize: 9.5, color: 'var(--athena-text-3)', padding: '2px 0 0' }}>
          No fallback configured
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {route.fallback.map((item, idx) => (
            <ModelReferenceRow
              key={`${item.providerId}-${item.model}-${idx}`}
              label={`Fallback ${idx + 1}`}
              value={item}
              providers={providers}
              onChange={next => {
                const fallback = route.fallback.map((current, i) => (i === idx ? next : current));
                onChange({ ...route, fallback });
              }}
              onRemove={() => onRemoveFallback(idx)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ModelReferenceRow({
  label,
  value,
  onChange,
  onRemove,
  providers,
}: {
  label: string;
  value: ModelReference;
  onChange: (value: ModelReference) => void;
  onRemove?: () => void;
  providers: Record<string, ProviderConfig>;
}) {
  const allModels = React.useMemo(() => {
    if (value.providerId) {
      return providers[value.providerId]?.models || [];
    }
    return Object.values(providers)
      .filter(p => p.enabled)
      .flatMap(p => p.models);
  }, [value.providerId, providers]);

  const hasModels = allModels.length > 0;

  const providerOptions = React.useMemo(() => [
    { value: '', label: 'Any provider' },
    ...PROVIDER_OPTIONS,
  ], []);

  const modelOptions = React.useMemo(() => [
    { value: '', label: 'Select a model' },
    ...allModels.map(m => ({ value: m, label: m })),
    ...(value.model && !allModels.includes(value.model) ? [{ value: value.model, label: `${value.model} (custom)` }] : []),
  ], [allModels, value.model]);

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '76px 120px minmax(0, 1fr) auto',
      gap: 6,
      alignItems: 'center',
    }}>
      <span style={{ fontSize: 9.5, color: 'var(--athena-text-3)' }}>{label}</span>
      <CustomSelect
        value={value.providerId}
        options={providerOptions}
        placeholder="Any provider"
        onChange={nextProvider => onChange({ ...value, providerId: nextProvider })}
      />
      {hasModels ? (
        <CustomSelect
          value={value.model}
          options={modelOptions}
          placeholder="Select a model"
          onChange={nextModel => onChange({ ...value, model: nextModel })}
        />
      ) : (
        <input
          value={value.model}
          onChange={e => onChange({ ...value, model: e.target.value })}
          placeholder="model name"
          style={inputStyle}
        />
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        {onRemove && (
          <button onClick={onRemove} style={iconButtonStyle(false)} aria-label={`Remove ${label}`}>
            <Trash2 size={10} />
          </button>
        )}
      </div>
    </div>
  );
}

function maskSecret(value: string): string {
  if (value.length <= 8) return '****';
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

const inputStyle: React.CSSProperties = {
  minWidth: 0,
  padding: '6px 8px',
  borderRadius: 6,
  border: '0.5px solid var(--athena-border)',
  background: 'var(--glass-bg)',
  color: 'var(--athena-text)',
  fontSize: 10.5,
  fontFamily: 'inherit',
  outline: 'none',
};

const selectStyle: React.CSSProperties = {
  ...inputStyle,
  appearance: 'none',
};

const linkButtonStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  color: 'var(--athena-accent)',
  fontSize: 9.5,
  padding: '2px 0',
  fontFamily: 'inherit',
};

function iconButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    width: 20,
    height: 20,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 6,
    border: '0.5px solid var(--athena-border)',
    background: 'rgba(var(--athena-accent-rgb), 0.03)',
    color: 'var(--athena-text-3)',
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.45 : 1,
  };
}

function PromptDialog({
  open,
  title,
  placeholder,
  isPassword,
  value,
  onChange,
  onClose,
  onSubmit,
}: {
  open: boolean;
  title: string;
  placeholder: string;
  isPassword?: boolean;
  value: string;
  onChange: (val: string) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const inputRef = React.useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      const timer = setTimeout(() => inputRef.current?.focus(), 50);
      return () => clearTimeout(timer);
    }
  }, [open]);

  if (!open) return null;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      onSubmit();
    } else if (e.key === 'Escape') {
      onClose();
    }
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 200,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0,0,0,0.4)',
        backdropFilter: 'blur(4px)',
        WebkitBackdropFilter: 'blur(4px)',
        animation: 'fade-in 140ms var(--ease-out) both',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: '90%',
          maxWidth: 400,
          background: 'var(--glass-bg)',
          border: '0.5px solid var(--athena-border)',
          borderRadius: 14,
          padding: '16px 18px',
          boxShadow: '0 20px 40px rgba(0, 0, 0, 0.35)',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          animation: 'scale-in 180ms var(--ease-spring) both',
        }}
      >
        <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--athena-text)' }}>
          {title}
        </div>
        <input
          ref={inputRef}
          type={isPassword ? 'password' : 'text'}
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={placeholder}
          onKeyDown={handleKeyDown}
          style={{
            width: '100%',
            padding: '8px 10px',
            borderRadius: 8,
            border: '0.5px solid var(--athena-border)',
            background: 'rgba(var(--athena-accent-rgb), 0.02)',
            color: 'var(--athena-text)',
            fontSize: 11,
            outline: 'none',
          }}
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
          <button
            onClick={onClose}
            style={{
              padding: '6px 12px',
              borderRadius: 6,
              border: '0.5px solid var(--athena-border)',
              background: 'transparent',
              color: 'var(--athena-text-2)',
              fontSize: 10.5,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Cancel
          </button>
          <button
            onClick={onSubmit}
            disabled={!value.trim()}
            style={{
              padding: '6px 14px',
              borderRadius: 6,
              border: '0.5px solid rgba(var(--athena-accent-rgb), 0.35)',
              background: 'rgba(var(--athena-accent-rgb), 0.08)',
              color: 'var(--athena-text)',
              fontSize: 10.5,
              fontWeight: 700,
              cursor: 'pointer',
              fontFamily: 'inherit',
              opacity: value.trim() ? 1 : 0.5,
            }}
          >
            Add
          </button>
        </div>
      </div>
    </div>
  );
}

interface DropdownOption {
  value: string;
  label: string;
}

function CustomSelect({
  value,
  options,
  placeholder,
  onChange,
  style,
}: {
  value: string;
  options: DropdownOption[];
  placeholder?: string;
  onChange: (val: string) => void;
  style?: React.CSSProperties;
}) {
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0, width: 0 });

  const doClose = useCallback(() => {
    setClosing(true);
    setTimeout(() => { setClosing(false); setOpen(false); }, 100);
  }, []);

  const updatePosition = useCallback(() => {
    if (btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      const panelHeight = Math.min(200, options.length * 30 + 10);
      const spaceBelow = window.innerHeight - r.bottom;
      const spaceAbove = r.top;
      const showAbove = spaceBelow < panelHeight && spaceAbove > spaceBelow;
      
      setPos({
        top: showAbove ? r.top - panelHeight - 4 : r.bottom + 4,
        left: r.left,
        width: r.width,
      });
    }
  }, [options.length]);

  useEffect(() => {
    if (!open || closing) return;
    function handleClick(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node) &&
          btnRef.current && !btnRef.current.contains(e.target as Node)) {
        doClose();
      }
    }
    function handleReposition() {
      updatePosition();
    }
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('scroll', handleReposition, { capture: true });
    window.addEventListener('resize', handleReposition);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('scroll', handleReposition, { capture: true });
      window.removeEventListener('resize', handleReposition);
    };
  }, [open, closing, doClose, updatePosition]);

  const handleOpen = () => {
    if (open) { doClose(); return; }
    updatePosition();
    setOpen(true);
  };

  const selectedOption = options.find(o => o.value === value);
  const displayLabel = selectedOption ? selectedOption.label : placeholder || value || 'Select option';

  return (
    <>
      <button
        ref={btnRef}
        onClick={handleOpen}
        style={{
          ...selectStyle,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 6,
          cursor: 'pointer',
          textAlign: 'left',
          width: '100%',
          ...style,
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
          {displayLabel}
        </span>
        <ChevronDown size={11} style={{ opacity: 0.5, flexShrink: 0 }} />
      </button>

      {(open || closing) && createPortal(
        <div
          ref={panelRef}
          style={{
            position: 'fixed',
            top: pos.top,
            left: pos.left,
            width: pos.width,
            maxHeight: 200,
            overflowY: 'auto',
            padding: 4,
            borderRadius: 8,
            background: 'var(--glass-bg-strong)',
            backdropFilter: 'var(--blur-glass-strong)',
            WebkitBackdropFilter: 'var(--blur-glass-strong)',
            border: '0.5px solid var(--athena-border)',
            boxShadow: 'var(--glass-shadow)',
            zIndex: 99999,
            animation: closing ? 'scale-out 100ms var(--ease-out) both' : 'scale-in 100ms var(--ease-out) both',
          }}
        >
          {options.map(opt => (
            <button
              key={opt.value}
              onClick={() => { onChange(opt.value); doClose(); }}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '6px 8px',
                border: 'none',
                borderRadius: 5,
                background: value === opt.value ? 'rgba(var(--athena-accent-rgb), 0.08)' : 'transparent',
                cursor: 'pointer',
                fontSize: 10.5,
                fontWeight: value === opt.value ? 600 : 500,
                color: value === opt.value ? 'var(--athena-text)' : 'var(--athena-text-2)',
                fontFamily: 'inherit',
                textAlign: 'left',
                transition: 'background 100ms',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
              onMouseEnter={e => { if (value !== opt.value) (e.currentTarget as HTMLElement).style.background = 'rgba(var(--athena-accent-rgb), 0.04)'; }}
              onMouseLeave={e => { if (value !== opt.value) (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
            >
              {opt.label}
            </button>
          ))}
        </div>,
        document.body
      )}
    </>
  );
}

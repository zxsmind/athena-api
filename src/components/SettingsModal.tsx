import { useEffect, useState, useCallback, useRef } from 'react';
import useMediaQuery from '@mui/material/useMediaQuery';
import { Section, InputRow, ListSection, InfoPanel, CapabilityGrid } from './settings/SharedComponents';
import { ModelRouteEditor } from './settings/ModelEditor';
import { PromptDialog } from './settings/PromptDialog';
import type { SettingsData, ModelRouting, ModelRoute, ProviderConfig, TabKey } from './settings/types';
import { PROVIDER_KEYS, PROVIDER_LABELS, ROLE_LABELS, TABS } from './settings/types';

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
}

const SETTINGS_ICONS: Record<string, any> = {};

export default function SettingsModal({ open, onClose }: SettingsModalProps) {
  const [data, setData] = useState<SettingsData | null>(null);
  const [activeTab, setActiveTab] = useState<TabKey>('general');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'ok' | 'error'; text: string } | null>(null);
  const [dirty, setDirty] = useState(false);
  const [promptConfig, setPromptConfig] = useState<{
    open: boolean; title: string; placeholder: string; isPassword: boolean;
    value: string; onSubmit: (val: string) => void;
  }>({ open: false, title: '', placeholder: '', isPassword: false, value: '', onSubmit: () => {} });

  const isMobile = useMediaQuery('(max-width: 1023px)');

  useEffect(() => {
    if (!open) return;
    fetch('/api/settings').then(r => r.json()).then(d => {
      setData(d); setActiveTab('general'); setDirty(false); setMessage(null);
    }).catch(() => setMessage({ type: 'error', text: 'Failed to load settings' }));
  }, [open]);

  const save = useCallback(async (currentData: SettingsData) => {
    setSaving(true);
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(currentData),
      });
      if (!res.ok) throw new Error('Save failed');
      setDirty(false); setMessage(null);
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message || 'Save failed' });
    } finally { setSaving(false); }
  }, []);

  const currentDataRef = useRef<SettingsData | null>(null);
  const dirtyRef = useRef(false);
  useEffect(() => { currentDataRef.current = data; dirtyRef.current = dirty; }, [data, dirty]);

  useEffect(() => {
    if (!data || !dirty) return;
    const timer = setTimeout(() => save(data), 600);
    return () => clearTimeout(timer);
  }, [data, dirty, save]);

  useEffect(() => {
    return () => {
      if (dirtyRef.current && currentDataRef.current) {
        fetch('/api/settings', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(currentDataRef.current), keepalive: true,
        }).catch(err => console.error('Failed to auto-save on unmount:', err));
      }
    };
  }, []);

  if (!open) return null;

  const patchData = (patch: Partial<SettingsData>) => {
    if (!data) return;
    setData({ ...data, ...patch }); setDirty(true);
  };

  const patchModelRouting = (patch: Partial<ModelRouting>) => {
    if (!data) return;
    setData({ ...data, modelRouting: { ...data.modelRouting, ...patch } }); setDirty(true);
  };

  const updateProvider = (key: string, patch: Partial<ProviderConfig>) => {
    if (!data) return;
    setData({ ...data, providers: { ...data.providers, [key]: { ...data.providers[key], ...patch } } });
    setDirty(true);
  };

  const moveProvider = (key: string, direction: -1 | 1) => {
    if (!data) return;
    const index = data.providerOrder.indexOf(key);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= data.providerOrder.length) return;
    const nextOrder = [...data.providerOrder];
    [nextOrder[index], nextOrder[target]] = [nextOrder[target], nextOrder[index]];
    setData({ ...data, providerOrder: nextOrder }); setDirty(true);
  };

  const toggleProvider = (key: string) => {
    if (!data) return;
    const p = data.providers[key];
    const newEnabled = !p.enabled;
    let newOrder = [...data.providerOrder];
    if (newEnabled && !newOrder.includes(key)) newOrder.push(key);
    else if (!newEnabled) newOrder = newOrder.filter(k => k !== key);
    setData({ ...data, providerOrder: newOrder, providers: { ...data.providers, [key]: { ...p, enabled: newEnabled } } });
    setDirty(true);
  };

  const addFallbackRef = (role: keyof ModelRouting) => {
    if (!data) return;
    const route = data.modelRouting[role];
    patchModelRouting({ [role]: { ...route, fallback: [...route.fallback, { providerId: '', model: '' }] } } as Partial<ModelRouting>);
  };

  const removeFallbackRef = (role: keyof ModelRouting, idx: number) => {
    if (!data) return;
    const route = data.modelRouting[role];
    patchModelRouting({ [role]: { ...route, fallback: route.fallback.filter((_, i) => i !== idx) } } as Partial<ModelRouting>);
  };

  const updateRoute = (role: keyof ModelRouting, patch: Partial<ModelRoute>) => {
    if (!data) return;
    patchModelRouting({ [role]: patch } as Partial<ModelRouting>);
  };

  const showPrompt = (title: string, placeholder: string, isPassword: boolean, onSubmit: (val: string) => void) => {
    setPromptConfig({ open: true, title, placeholder, isPassword, value: '', onSubmit: (val) => { onSubmit(val.trim()); setPromptConfig(prev => ({ ...prev, open: false })); } });
  };

  const addKey = (provider: string) => showPrompt('Add API Key', 'Enter API key...', true, (val) => { if (val) updateProvider(provider, { keys: [...data!.providers[provider].keys, val] }); });
  const removeKey = (provider: string, idx: number) => updateProvider(provider, { keys: data!.providers[provider].keys.filter((_, i) => i !== idx) });
  const addModel = (provider: string) => showPrompt('Add Model Name', 'Enter model name...', false, (val) => { if (val) updateProvider(provider, { models: [...data!.providers[provider].models, val] }); });
  const removeModel = (provider: string, idx: number) => updateProvider(provider, { models: data!.providers[provider].models.filter((_, i) => i !== idx) });
  const addSerperKey = () => showPrompt('Add Serper API Key', 'Enter Serper API key...', true, (val) => { if (val && data) patchData({ serper: { ...data.serper, keys: [...data.serper.keys, val] } }); });
  const removeSerperKey = (idx: number) => { if (data) patchData({ serper: { ...data.serper, keys: data.serper.keys.filter((_, j) => j !== idx) } }); };

  const renderTab = () => {
    if (!data) {
      return <div style={{ textAlign: 'center', padding: 40, color: 'var(--athena-text-3)', fontSize: 12 }}>Loading...</div>;
    }

    if (activeTab === 'general') {
      return (
        <>
          <Section title="Application">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <InputRow label="Host" value={data.host} onChange={v => patchData({ host: v })} placeholder="0.0.0.0" />
              <InputRow icon={<span>#</span>} label="Port" value={String(data.port)} onChange={v => patchData({ port: parseInt(v, 10) || 3001 })} placeholder="3001" />
            </div>
          </Section>
              <InfoPanel title="General Settings Scope" text="This tab stays for application-wide settings. Provider credentials, task-specific model choices, research behavior, and API capabilities live in their own tabs." />
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
                  <div key={key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '7px 10px', borderRadius: 8, border: '0.5px solid var(--athena-border)', background: p.enabled ? 'rgba(var(--athena-accent-rgb), 0.04)' : 'rgba(var(--athena-accent-rgb), 0.02)', opacity: p.enabled ? 1 : 0.6 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                      <span style={{ width: 18, textAlign: 'center', fontSize: 9, color: 'var(--athena-text-3)', flexShrink: 0 }}>{index + 1}</span>
                      <span style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--athena-text)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.label}</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <button onClick={() => moveProvider(key, -1)} disabled={index === 0} style={{ width: 20, height: 20, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: 6, border: '0.5px solid var(--athena-border)', background: 'rgba(var(--athena-accent-rgb), 0.03)', color: 'var(--athena-text-3)', cursor: index === 0 ? 'default' : 'pointer', opacity: index === 0 ? 0.45 : 1 }}>▲</button>
                      <button onClick={() => moveProvider(key, 1)} disabled={index === data.providerOrder.length - 1} style={{ width: 20, height: 20, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: 6, border: '0.5px solid var(--athena-border)', background: 'rgba(var(--athena-accent-rgb), 0.03)', color: 'var(--athena-text-3)', cursor: index === data.providerOrder.length - 1 ? 'default' : 'pointer', opacity: index === data.providerOrder.length - 1 ? 0.45 : 1 }}>▼</button>
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
                    display: 'flex', alignItems: 'center', gap: 5, padding: '6px 10px', borderRadius: 8, cursor: 'pointer',
                    fontSize: 10.5, fontWeight: 600, fontFamily: 'inherit',
                    border: p.enabled ? '0.5px solid rgba(var(--athena-accent-rgb), 0.4)' : '0.5px solid var(--athena-border)',
                    background: p.enabled ? 'rgba(var(--athena-accent-rgb), 0.07)' : 'transparent',
                    color: p.enabled ? 'var(--athena-text)' : 'var(--athena-text-3)',
                    transition: 'all 140ms var(--ease-out)',
                  }}>
                    {p.enabled ? <span>✓</span> : <span>+</span>}
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
                  <InputRow label="API URL" value={p.url} onChange={v => updateProvider(key, { url: v })} placeholder="https://api.example.com/v1/chat/completions" />
                  {key === 'custom' && <InputRow label="Display Name" value={p.name} onChange={v => updateProvider(key, { name: v })} placeholder="custom" />}
                  <ListSection label="API Keys" items={p.keys} onAdd={() => addKey(key)} onRemove={i => removeKey(key, i)} emptyText="No API keys configured" maskItems />
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
                <div key={role} style={{ padding: '10px 12px', border: '0.5px solid var(--athena-border)', borderRadius: 10, background: 'rgba(var(--athena-accent-rgb), 0.025)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ color: 'var(--athena-text-3)' }}>📊</span>
                      <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--athena-text)' }}>{ROLE_LABELS[role]}</span>
                    </div>
                    <span style={{ fontSize: 9.5, color: 'var(--athena-text-3)' }}>Primary + fallback chain</span>
                  </div>
                  <ModelRouteEditor route={data.modelRouting[role]} providers={data.providers} onChange={route => updateRoute(role, route)} onAddFallback={() => addFallbackRef(role)} onRemoveFallback={idx => removeFallbackRef(role, idx)} />
                </div>
              ))}
            </div>
          </Section>
          <Section title="Provider Models">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {PROVIDER_KEYS.map(key => {
                const p = data.providers[key];
                return (
                  <div key={key} style={{ padding: '10px 12px', border: '0.5px solid var(--athena-border)', borderRadius: 10, background: 'rgba(var(--athena-accent-rgb), 0.025)', opacity: p.enabled ? 1 : 0.62 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ color: 'var(--athena-text-3)' }}>💻</span>
                        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--athena-text)' }}>{p.label}</span>
                      </div>
                      <span style={{ fontSize: 9.5, color: p.enabled ? 'var(--athena-text-2)' : 'var(--athena-text-3)' }}>{p.enabled ? 'Enabled' : 'Disabled'}</span>
                    </div>
                    <ListSection icon={<span>📚</span>} label="Models" items={p.models} onAdd={() => addModel(key)} onRemove={i => removeModel(key, i)} emptyText="No models configured" />
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
              <InputRow label="Serper URL" value={data.serper.url} onChange={v => patchData({ serper: { ...data.serper, url: v } })} placeholder="https://google.serper.dev/search" />
              <ListSection label="Serper Keys" items={data.serper.keys} onAdd={addSerperKey} onRemove={removeSerperKey} emptyText="No Serper API keys configured" maskItems />
            </div>
          </Section>
          <Section title="Research Controls">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <InputRow icon={<span>#</span>} label="Max Sources" value={String(data.maxSources)} onChange={v => patchData({ maxSources: parseInt(v, 10) || 8 })} placeholder="8" />
              <InputRow label="Deep Iterations" value={String(data.deepIterations)} onChange={v => patchData({ deepIterations: parseInt(v, 10) || 3 })} placeholder="3" />
              <InputRow label="Thinking Strip" value={data.thinkingStripPatterns} onChange={v => patchData({ thinkingStripPatterns: v })} placeholder="<think>.*?</think>" />
            </div>
          </Section>
          <Section title="Research Budget">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <InputRow label="Max Credits" value={String(data.research.maxCreditsPerQuery)} onChange={v => patchData({ research: { ...data.research, maxCreditsPerQuery: parseInt(v, 10) || 20 } })} placeholder="20" />
              <InputRow label="Follow-ups" value={String(data.research.maxFollowUpQueries)} onChange={v => patchData({ research: { ...data.research, maxFollowUpQueries: parseInt(v, 10) || 3 } })} placeholder="3" />
            </div>
          </Section>
          <InfoPanel title="Research Budget" text="Credits are enforced per query. Follow-up query limits cap deep research expansion before synthesis." />
        </>
      );
    }

    return (
      <>
        <Section title="Job & Batch Limits">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <InputRow icon={<span>🖥</span>} label="Max Active Jobs" value={String(data.api.maxActiveJobs)} onChange={v => patchData({ api: { ...data.api, maxActiveJobs: parseInt(v, 10) || 50 } })} placeholder="50" />
            <InputRow icon={<span>🖥</span>} label="Max Active Batches" value={String(data.api.maxActiveBatches)} onChange={v => patchData({ api: { ...data.api, maxActiveBatches: parseInt(v, 10) || 50 } })} placeholder="50" />
            <InputRow icon={<span>🖥</span>} label="Max Events / Job" value={String(data.api.maxEventsPerJob)} onChange={v => patchData({ api: { ...data.api, maxEventsPerJob: parseInt(v, 10) || 250 } })} placeholder="250" />
            <InputRow icon={<span>🖥</span>} label="Max Events / Batch" value={String(data.api.maxEventsPerBatch)} onChange={v => patchData({ api: { ...data.api, maxEventsPerBatch: parseInt(v, 10) || 300 } })} placeholder="300" />
            <InputRow icon={<span>🖥</span>} label="Retention (minutes)" value={String(data.api.maxRetentionMinutes)} onChange={v => patchData({ api: { ...data.api, maxRetentionMinutes: parseInt(v, 10) || 1440 } })} placeholder="1440" />
          </div>
        </Section>
        <Section title="Batch Defaults">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <InputRow icon={<span>🖥</span>} label="Max Concurrent" value={String(data.api.defaultMaxConcurrent)} onChange={v => patchData({ api: { ...data.api, defaultMaxConcurrent: parseInt(v, 10) || 2 } })} placeholder="2" />
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ flexShrink: 0, color: 'var(--athena-text-3)', display: 'flex' }}>💻</span>
              <span style={{ flexShrink: 0, fontSize: 10.5, color: 'var(--athena-text-2)', width: 92 }}>Default Mode</span>
              <select value={data.api.defaultMode} onChange={e => patchData({ api: { ...data.api, defaultMode: e.target.value as 'quick' | 'deep' } })} style={{ flex: 1, minWidth: 0, padding: '6px 8px', borderRadius: 6, border: '0.5px solid var(--athena-border)', background: 'var(--glass-bg)', color: 'var(--athena-text)', fontSize: 10.5, fontFamily: 'inherit', outline: 'none', appearance: 'none' }}>
                <option value="quick">Quick</option>
                <option value="deep">Deep</option>
              </select>
            </div>
          </div>
        </Section>
        <Section title="Available Capabilities">
          <CapabilityGrid items={[
            ['OpenAI-compatible endpoints', 'Supported through provider base URLs'],
            ['Custom provider capabilities', 'Supported through provider metadata'],
            ['Research job polling', 'Supported with /research-jobs/:id'],
            ['Research job events', 'Supported with /research-jobs/:id/events'],
            ['Cancellation', 'Supported with /research-jobs/:id/cancel'],
            ['Batch requests', 'Supported with /research-batches'],
          ]} />
        </Section>
        <Section title="Documentation">
          <a href="/docs/API.md" target="_blank" rel="noopener noreferrer" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderRadius: 10, textDecoration: 'none', border: '0.5px solid var(--athena-border)', background: 'rgba(var(--athena-accent-rgb), 0.025)', color: 'var(--athena-text)', transition: 'background 120ms' }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(var(--athena-accent-rgb), 0.06)'; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(var(--athena-accent-rgb), 0.025)'; }}
          >
            <span style={{ fontSize: 14, color: 'var(--athena-text-2)', flexShrink: 0 }}>📄</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 10.5, fontWeight: 700, marginBottom: 2 }}>Full API Reference</div>
              <div style={{ fontSize: 9.5, color: 'var(--athena-text-3)' }}>Complete endpoint documentation with request/response schemas, SSE events, budget system, and provider routing</div>
            </div>
            <span style={{ color: 'var(--athena-text-3)', flexShrink: 0 }}>↗</span>
          </a>
        </Section>
      </>
    );
  };

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, zIndex: 1002, display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(0,0,0,0.25)', WebkitBackdropFilter: 'blur(6px)', backdropFilter: 'blur(6px)',
      animation: 'fade-in 160ms var(--ease-out) both',
    }}>
      <div onClick={e => e.stopPropagation()} className="glass-panel-settings" style={{
        width: isMobile ? '96%' : '94%', maxWidth: isMobile ? '100%' : 880,
        height: isMobile ? 'auto' : 620, maxHeight: '90vh',
        display: 'flex', flexDirection: 'column',
        animation: 'scale-in 200ms var(--ease-spring) both',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: isMobile ? '12px 14px 10px' : '16px 18px 12px', borderBottom: '0.5px solid var(--athena-border)', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ color: 'var(--athena-text-2)' }}>⚙</span>
            <h2 className="font-outfit" style={{ fontSize: isMobile ? 13 : 14, fontWeight: 600, margin: 0, color: 'var(--athena-text)' }}>Settings</h2>
            {saving && <span style={{ fontSize: 9.5, color: 'var(--athena-text-3)', marginLeft: 6, fontStyle: 'italic', display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ width: 4, height: 4, borderRadius: '50%', backgroundColor: 'var(--athena-accent)', display: 'inline-block' }} /> Saving...
            </span>}
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--athena-text-3)', padding: 4, borderRadius: 6, display: 'flex' }}>
            <span>✕</span>
          </button>
        </div>

        {isMobile ? (
          <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
            <nav style={{ display: 'flex', gap: 4, padding: '8px 12px', overflow: 'auto', flexShrink: 0, borderBottom: '0.5px solid var(--athena-border)' }}>
              {TABS.map(tab => {
                const active = activeTab === tab.key;
                return (
                  <button key={tab.key} onClick={() => setActiveTab(tab.key)} style={{
                    flexShrink: 0, padding: '6px 12px', borderRadius: 8,
                    border: active ? '0.5px solid rgba(var(--athena-accent-rgb), 0.22)' : '0.5px solid transparent',
                    background: active ? 'rgba(var(--athena-accent-rgb), 0.07)' : 'transparent',
                    color: active ? 'var(--athena-text)' : 'var(--athena-text-2)',
                    cursor: 'pointer', fontFamily: 'inherit', fontSize: 10.5,
                    fontWeight: active ? 700 : 600,
                    transition: 'all 140ms var(--ease-out)',
                  }}>
                    {tab.label}
                  </button>
                );
              })}
            </nav>
            <div style={{ flex: 1, overflow: 'hidden auto', padding: '12px 14px 14px' }}>
              {renderTab()}
              {message && message.type === 'error' && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 10, fontSize: 10.5, color: '#ef4444' }}>
                  <span>⚠</span> {message.text}
                </div>
              )}
            </div>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: '168px minmax(0, 1fr)', minHeight: 0, flex: 1 }}>
            <nav style={{ padding: 12, borderRight: '0.5px solid var(--athena-border)', display: 'flex', flexDirection: 'column', gap: 4, minHeight: 0 }}>
              {TABS.map(tab => {
                const active = activeTab === tab.key;
                return (
                  <button key={tab.key} onClick={() => setActiveTab(tab.key)} style={{
                    display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                    padding: '8px 10px', borderRadius: 8,
                    border: active ? '0.5px solid rgba(var(--athena-accent-rgb), 0.22)' : '0.5px solid transparent',
                    background: active ? 'rgba(var(--athena-accent-rgb), 0.07)' : 'transparent',
                    color: active ? 'var(--athena-text)' : 'var(--athena-text-2)',
                    cursor: 'pointer', fontFamily: 'inherit', fontSize: 11,
                    fontWeight: active ? 700 : 600, textAlign: 'left',
                    transition: 'all 140ms var(--ease-out)',
                  }}>
                    <span style={{ display: 'flex', color: active ? 'var(--athena-text)' : 'var(--athena-text-3)' }}>{SETTINGS_ICONS[tab.key]}</span>
                    {tab.label}
                  </button>
                );
              })}
            </nav>
            <div style={{ minHeight: 0, display: 'flex', flexDirection: 'column' }}>
              <div style={{ flex: 1, overflow: 'hidden auto', padding: '16px 18px 18px' }}>
                {renderTab()}
                {message && message.type === 'error' && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 10, fontSize: 10.5, color: '#ef4444' }}>
                    <span>⚠</span> {message.text}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
      <PromptDialog open={promptConfig.open} title={promptConfig.title} placeholder={promptConfig.placeholder} isPassword={promptConfig.isPassword} value={promptConfig.value} onChange={val => setPromptConfig(prev => ({ ...prev, value: val }))} onClose={() => setPromptConfig(prev => ({ ...prev, open: false }))} onSubmit={() => promptConfig.onSubmit(promptConfig.value)} />
    </div>
  );
}

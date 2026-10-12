import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Trash2 } from 'lucide-react';
import { Page } from '../components/Page';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Field,
  Input,
  Select,
  Spinner,
  Textarea,
  useToast,
} from '../components/ui';
import {
  ApiError,
  getSettings,
  models,
  updateSettings,
  type OperatorSettings,
  type ResearchModeId,
  type SettingsPatch,
  type SettingsProviderState,
} from '../lib/api';

const MODE_LABELS: Record<ResearchModeId, string> = {
  instant: 'instant',
  default: 'default',
  deep: 'deep',
  max: 'max',
};

/**
 * Every setting, editable from the browser.
 *
 * Until now the only writer of `settings.yaml` was the CLI on the machine the
 * server runs on, so a console operator could look at a setting but not change
 * it. This is that write surface: one document held in a draft, and one Save
 * that sends the whole thing. Secrets travel as masks — send a mask back to keep
 * the key it stands for, send a new value to replace it.
 */
export function AdminSettings() {
  const toast = useToast();

  const [settings, setSettings] = useState<OperatorSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<OperatorSettings | null>(null);
  const [deletedProviders, setDeletedProviders] = useState<string[]>([]);
  const [deletedSearch, setDeletedSearch] = useState<string[]>([]);

  const load = useCallback(async () => {
    try {
      const value = await getSettings();
      setSettings(value);
      setDraft(structuredClone(value));
      setDeletedProviders([]);
      setDeletedSearch([]);
      setError(null);
      return value;
    } catch (loadError) {
      setError(loadError instanceof ApiError ? loadError.message : 'Settings could not be loaded.');
      return null;
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const patch = useMemo(() => (draft ? buildPatch(draft, deletedProviders, deletedSearch) : null), [draft, deletedProviders, deletedSearch]);
  const savedPatch = useMemo(() => (settings ? buildPatch(settings, [], []) : null), [settings]);
  const dirty = patch !== null && JSON.stringify(patch) !== JSON.stringify(savedPatch);

  const edit = (mutate: (next: OperatorSettings) => void) => {
    setDraft((current) => {
      if (!current) return current;
      const next = structuredClone(current);
      mutate(next);
      return next;
    });
  };

  const save = async () => {
    if (!patch) return;
    setSaving(true);
    try {
      const fresh = await updateSettings(patch);
      setSettings(fresh);
      setDraft(structuredClone(fresh));
      setDeletedProviders([]);
      setDeletedSearch([]);
      toast('Settings saved. The running server picked them up.');
    } catch (saveError) {
      toast(saveError instanceof ApiError ? saveError.message : 'Settings could not be saved.', 'danger');
    } finally {
      setSaving(false);
    }
  };

  if (error) {
    return (
      <Page title="Settings" description="Everything this deployment runs on.">
        <Card className="p-[32px] text-center">
          <p className="text-[13px] text-[var(--danger)]">{error}</p>
          <div className="mt-[14px]">
            <Button onClick={() => void load()}>Try again</Button>
          </div>
        </Card>
      </Page>
    );
  }

  if (!settings || !draft) {
    return (
      <Page title="Settings" description="Everything this deployment runs on.">
        <Card className="p-[48px] flex justify-center">
          <Spinner label="Loading settings…" />
        </Card>
      </Page>
    );
  }

  return (
    <Page
      title="Settings"
      description="Provider keys, search backends, defaults and limits. Saved changes take effect immediately — no restart."
      actions={
        dirty ? (
          <>
            <Button
              onClick={() => {
                setDraft(structuredClone(settings));
                setDeletedProviders([]);
                setDeletedSearch([]);
              }}
            >
              Discard
            </Button>
            <Button variant="primary" loading={saving} onClick={() => void save()}>
              Save changes
            </Button>
          </>
        ) : (
          <Badge tone="ok">saved</Badge>
        )
      }
    >
      {!settings.readiness.ready && (
        <Card className="px-[16px] py-[14px] border-[var(--warn)]">
          <p className="text-[13px] font-medium text-[var(--warn)]">This server will not answer every request yet.</p>
          <ul className="mt-[6px] flex flex-col gap-[3px] text-[13px] text-[var(--gray-600)] list-disc pl-[18px]">
            {settings.readiness.problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
            {settings.readiness.hints.map((hint) => (
              <li key={hint}>{hint}</li>
            ))}
          </ul>
        </Card>
      )}

      <ProvidersSection draft={draft} settings={settings} edit={edit} setDeleted={setDeletedProviders} />
      <SearchSection draft={draft} settings={settings} edit={edit} setDeleted={setDeletedSearch} />
      <RoutingSection draft={draft} settings={settings} edit={edit} />
      <GeneralSection draft={draft} edit={edit} />
      <ApiSection draft={draft} edit={edit} />
      <ServerSection settings={settings} />
    </Page>
  );
}

/* ── Providers ───────────────────────────────────────────────────────────── */

function ProvidersSection({
  draft,
  settings,
  edit,
  setDeleted,
}: {
  draft: OperatorSettings;
  settings: OperatorSettings;
  edit: (mutate: (next: OperatorSettings) => void) => void;
  setDeleted: (ids: (previous: string[]) => string[]) => void;
}) {
  const catalogIds = draft.providerOrder.filter((id) => draft.providers[id]);
  const available = settings.catalog.providers.filter((entry) => !draft.providers[entry.id]);
  const [adding, setAdding] = useState('');

  const add = () => {
    const id = adding || available[0]?.id;
    if (!id || draft.providers[id]) return;
    edit((next) => {
      next.providers[id] = { enabled: true, keys: [], keyCount: 0, servesWholeCatalog: true, models: [] };
      next.providerOrder = [...next.providerOrder, id];
    });
    setAdding('');
  };

  const remove = (id: string) => {
    edit((next) => {
      delete next.providers[id];
      next.providerOrder = next.providerOrder.filter((entry) => entry !== id);
    });
    setDeleted((previous) => [...previous, id]);
  };

  return (
    <Card>
      <CardHeader
        title="LLM providers"
        description="Keys stay on the server: the console only ever sees the last four characters."
        actions={
          available.length > 0 && (
            <div className="flex items-center gap-[8px]">
              <Select value={adding} onChange={(event) => setAdding(event.target.value)} className="w-[240px] h-[32px] text-[13px]">
                <option value="">Add a provider…</option>
                {available.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name} ({entry.id})
                  </option>
                ))}
              </Select>
              <Button size="sm" onClick={add}>
                <Plus size={13} />
                Add
              </Button>
            </div>
          )
        }
      />
      <div className="flex flex-col">
        {catalogIds.length === 0 && (
          <div className="p-[32px] text-center text-[13px] text-[var(--gray-500)]">
            No provider yet. Add one above — it needs a key before the server will call it.
          </div>
        )}
        {catalogIds.map((id) => (
          <ProviderRow
            key={id}
            id={id}
            provider={draft.providers[id]}
            edited={JSON.stringify(draft.providers[id]) !== JSON.stringify(settings.providers[id])}
            edit={edit}
            onRemove={() => remove(id)}
          />
        ))}
      </div>
    </Card>
  );
}

function ProviderRow({
  id,
  provider,
  edited,
  edit,
  onRemove,
}: {
  id: string;
  provider: SettingsProviderState;
  edited: boolean;
  edit: (mutate: (next: OperatorSettings) => void) => void;
  onRemove: () => void;
}) {
  const [newKey, setNewKey] = useState('');

  const setKeys = (keys: string[]) => {
    edit((next) => {
      const target = next.providers[id];
      if (target) target.keys = keys;
    });
  };

  const addKey = () => {
    const value = newKey.trim();
    if (!value) return;
    setKeys([...provider.keys, value]);
    setNewKey('');
  };

  return (
    <div className="px-[20px] py-[16px] border-b border-[var(--border)] last:border-0 flex flex-col gap-[10px]">
      <div className="flex flex-wrap items-center justify-between gap-[12px]">
        <div className="flex items-center gap-[10px]">
          <span className="text-[14px] font-medium">{provider.name ?? id}</span>
          <span className="text-[12px] font-mono text-[var(--gray-500)]">{id}</span>
          {provider.keyCount === 0 && <Badge tone="warn">no key</Badge>}
          {provider.keyCount > 1 && <Badge>{provider.keyCount} keys</Badge>}
          {!provider.enabled && <Badge tone="danger">disabled</Badge>}
          {edited && <Badge tone="warn">edited</Badge>}
        </div>
        <div className="flex items-center gap-[8px]">
          <Button size="sm" onClick={() => edit((next) => { const p = next.providers[id]; if (p) p.enabled = !p.enabled; })}>
            {provider.enabled ? 'Disable' : 'Enable'}
          </Button>
          <Button size="sm" variant="danger" onClick={onRemove}>
            <Trash2 size={13} />
            Remove
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap gap-[8px] items-center">
        {provider.keys.map((key, index) => (
          <span
            key={`${key}-${index}`}
            className="inline-flex items-center gap-[8px] h-[28px] px-[10px] rounded-full border border-[var(--border-strong)] bg-[var(--background-200)] font-mono text-[12px]"
          >
            {key}
            <button
              type="button"
              aria-label={`Remove key ${index + 1}`}
              className="text-[var(--gray-500)] hover:text-[var(--danger)]"
              onClick={() => setKeys(provider.keys.filter((_, position) => position !== index))}
            >
              ×
            </button>
          </span>
        ))}
        {provider.keys.length === 0 && (
          <span className="text-[12px] text-[var(--gray-500)]">No key stored for this provider.</span>
        )}
      </div>

      <div className="flex flex-wrap items-end gap-[8px]">
        <div className="w-[340px] max-w-full">
          <Field label="Add a key">
            {(inputId) => (
              <Input
                id={inputId}
                value={newKey}
                onChange={(event: ChangeEvent<HTMLInputElement>) => setNewKey(event.target.value)}
                onKeyDown={(event) => event.key === 'Enter' && addKey()}
                placeholder="paste a new key"
                className="h-[34px] text-[12px] font-mono"
                spellCheck={false}
              />
            )}
          </Field>
        </div>
        <Button size="sm" onClick={addKey} disabled={!newKey.trim()}>
          Add key
        </Button>
        <div className="w-[280px] max-w-full ml-auto">
          <Field label="Base URL override" hint="Leave empty for the catalog endpoint.">
            {(inputId) => (
              <Input
                id={inputId}
                value={provider.url ?? ''}
                onChange={(event) => edit((next) => { const p = next.providers[id]; if (p) p.url = event.target.value || undefined; })}
                placeholder="https://api.example.com/v1"
                className="h-[34px] text-[12px] font-mono"
                spellCheck={false}
              />
            )}
          </Field>
        </div>
        <div className="w-[140px]">
          <Field label="Models">
            {(inputId) => (
              <Input
                id={inputId}
                readOnly
                value={provider.servesWholeCatalog ? 'all' : String(provider.models.length)}
                className="h-[34px] text-[12px] font-mono text-[var(--gray-600)]"
              />
            )}
          </Field>
        </div>
        <Link to="/admin/models" className="text-[12px] text-[var(--accent)] hover:underline self-end pb-[9px]">
          Choose models →
        </Link>
      </div>
    </div>
  );
}

/* ── Search backends ─────────────────────────────────────────────────────── */

function SearchSection({
  draft,
  settings,
  edit,
  setDeleted,
}: {
  draft: OperatorSettings;
  settings: OperatorSettings;
  edit: (mutate: (next: OperatorSettings) => void) => void;
  setDeleted: (ids: (previous: string[]) => string[]) => void;
}) {
  const configured = draft.searchProviderOrder.filter((id) => draft.searchProviders[id]);
  const available = settings.catalog.search.filter((entry) => !draft.searchProviders[entry.id]);
  const [adding, setAdding] = useState('');

  const add = () => {
    const entry = available.find((item) => item.id === adding) ?? available[0];
    if (!entry || draft.searchProviders[entry.id]) return;
    edit((next) => {
      next.searchProviders[entry.id] = {
        keys: [],
        keyCount: 0,
        ...(entry.keyless ? { keyless: true } : {}),
      };
      next.searchProviderOrder = [...next.searchProviderOrder, entry.id];
    });
    setAdding('');
  };

  const remove = (id: string) => {
    edit((next) => {
      delete next.searchProviders[id];
      next.searchProviderOrder = next.searchProviderOrder.filter((entry) => entry !== id);
    });
    setDeleted((previous) => [...previous, id]);
  };

  return (
    <Card>
      <CardHeader
        title="Search backends"
        description="At least one backend with a key — or a keyless one — or search and research answer 503."
        actions={
          available.length > 0 && (
            <div className="flex items-center gap-[8px]">
              <Select value={adding} onChange={(event) => setAdding(event.target.value)} className="w-[240px] h-[32px] text-[13px]">
                <option value="">Add a backend…</option>
                {available.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name}
                  </option>
                ))}
              </Select>
              <Button size="sm" onClick={add}>
                <Plus size={13} />
                Add
              </Button>
            </div>
          )
        }
      />
      <div className="flex flex-col">
        {configured.length === 0 && (
          <div className="p-[32px] text-center text-[13px] text-[var(--gray-500)]">
            No search backend yet. Add one above, or search will refuse to answer.
          </div>
        )}
        {configured.map((id) => {
          const backend = draft.searchProviders[id];
          const entry = settings.catalog.search.find((item) => item.id === id);
          return (
            <div key={id} className="px-[20px] py-[14px] border-b border-[var(--border)] last:border-0 flex flex-col gap-[10px]">
              <div className="flex flex-wrap items-center justify-between gap-[12px]">
                <div className="flex items-center gap-[10px]">
                  <span className="text-[14px] font-medium">{entry?.name ?? id}</span>
                  <span className="text-[12px] font-mono text-[var(--gray-500)]">{id}</span>
                  {backend.keyless && <Badge tone="ok">keyless</Badge>}
                  {backend.keyCount > 0 && <Badge>{backend.keyCount} keys</Badge>}
                </div>
                <Button size="sm" variant="danger" onClick={() => remove(id)}>
                  <Trash2 size={13} />
                  Remove
                </Button>
              </div>

              <div className="flex flex-wrap gap-[8px] items-center">
                {backend.keys.map((key, index) => (
                  <span
                    key={`${key}-${index}`}
                    className="inline-flex items-center gap-[8px] h-[28px] px-[10px] rounded-full border border-[var(--border-strong)] bg-[var(--background-200)] font-mono text-[12px]"
                  >
                    {key}
                    <button
                      type="button"
                      aria-label={`Remove key ${index + 1}`}
                      className="text-[var(--gray-500)] hover:text-[var(--danger)]"
                      onClick={() =>
                        edit((next) => {
                          const target = next.searchProviders[id];
                          if (target) target.keys = target.keys.filter((_, position) => position !== index);
                        })
                      }
                    >
                      ×
                    </button>
                  </span>
                ))}
                {backend.keys.length === 0 && !backend.keyless && (
                  <span className="text-[12px] text-[var(--gray-500)]">No key stored yet.</span>
                )}
              </div>

              <div className="flex flex-wrap items-end gap-[8px]">
                <div className="w-[340px] max-w-full">
                  <Field label="Add a key">
                    {(inputId) => (
                      <SearchKeyInput
                        id={inputId}
                        onAdd={(value) =>
                          edit((next) => {
                            const target = next.searchProviders[id];
                            if (target) target.keys = [...target.keys, value];
                          })
                        }
                      />
                    )}
                  </Field>
                </div>
                {entry?.needsZone && (
                  <div className="w-[220px]">
                    <Field label="Zone" hint="Bright Data only.">
                      {(inputId) => (
                        <Input
                          id={inputId}
                          value={backend.zone ?? ''}
                          onChange={(event) =>
                            edit((next) => {
                              const target = next.searchProviders[id];
                              if (target) target.zone = event.target.value || undefined;
                            })
                          }
                          placeholder="zone name"
                          className="h-[34px] text-[12px] font-mono"
                        />
                      )}
                    </Field>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function SearchKeyInput({ id, onAdd }: { id: string; onAdd: (value: string) => void }) {
  const [value, setValue] = useState('');
  const commit = () => {
    const trimmed = value.trim();
    if (!trimmed) return;
    onAdd(trimmed);
    setValue('');
  };
  return (
    <Input
      id={id}
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={(event) => event.key === 'Enter' && commit()}
      onBlur={commit}
      placeholder="paste a new key"
      className="h-[34px] text-[12px] font-mono"
      spellCheck={false}
    />
  );
}

/* ── Routing ─────────────────────────────────────────────────────────────── */

function RoutingSection({
  draft,
  settings,
  edit,
}: {
  draft: OperatorSettings;
  settings: OperatorSettings;
  edit: (mutate: (next: OperatorSettings) => void) => void;
}) {
  const readyProviders = draft.providerOrder.filter((id) => draft.providers[id]);
  const [catalogs, setCatalogs] = useState<Record<string, string[]>>({});
  const requested = useRef<Set<string>>(new Set());

  const ensureCatalog = useCallback(async (id: string) => {
    if (!id || requested.current.has(id)) return;
    requested.current.add(id);
    try {
      const response = await models(id);
      setCatalogs((current) => ({ ...current, [id]: response.providers[0]?.models.map((model) => model.id) ?? [] }));
    } catch {
      /* Suggestions only: a missing catalog must not stop an operator from
         typing a model id by hand. */
      setCatalogs((current) => ({ ...current, [id]: [] }));
    }
  }, []);

  /* Every provider a route may point at gets its model list, once. The ids
     travel as a string so this effect does not re-run per render. */
  const providerKey = readyProviders.join(',');
  useEffect(() => {
    for (const id of providerKey.split(',').filter(Boolean)) void ensureCatalog(id);
  }, [providerKey, ensureCatalog]);

  const setPrimary = (mode: ResearchModeId, providerId: string, model: string) => {
    edit((next) => {
      next.modelRouting[mode] = { primary: { providerId, model }, fallback: next.modelRouting[mode].fallback };
    });
  };

  return (
    <Card>
      <CardHeader
        title="Default model per mode"
        description="Each research mode starts from its own route. The fallback list is only consulted when the primary refuses."
      />
      <div className="px-[20px] py-[16px] flex flex-col gap-[14px]">
        {settings.modes.map((mode) => {
          const route = draft.modelRouting[mode];
          const listId = `models-for-${mode}`;
          return (
            <div key={mode} className="flex flex-wrap items-end gap-[10px]">
              <div className="w-[110px]">
                <Field label={MODE_LABELS[mode]}>
                  {() => <span className="text-[13px] font-mono text-[var(--gray-500)]">{mode} mode</span>}
                </Field>
              </div>
              <div className="w-[240px]">
                <Select
                  value={route.primary.providerId}
                  onChange={(event) =>
                    setPrimary(mode, event.target.value, pickFirstModel(catalogs[event.target.value], route.primary.model))
                  }
                  className="h-[36px] text-[13px]"
                >
                  <option value="">Not set</option>
                  {readyProviders.map((id) => (
                    <option key={id} value={id}>
                      {draft.providers[id]?.name ?? id}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="flex-1 min-w-[220px]">
                <Input
                  list={listId}
                  value={route.primary.model}
                  onChange={(event) => setPrimary(mode, route.primary.providerId, event.target.value)}
                  placeholder="model id"
                  className="h-[36px] text-[13px] font-mono"
                  spellCheck={false}
                  disabled={!route.primary.providerId}
                />
                <datalist id={listId}>
                  {(catalogs[route.primary.providerId] ?? []).map((modelId) => (
                    <option key={modelId} value={modelId} />
                  ))}
                </datalist>
              </div>
              {!route.primary.providerId && (
                <span className="text-[12px] text-[var(--gray-500)] pb-[9px]">falls back to catalog selection</span>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function pickFirstModel(ids: string[] | undefined, keep: string): string {
  if (!ids) return keep;
  return ids.includes(keep) ? keep : ids[0] ?? '';
}

/* ── General / API / server ──────────────────────────────────────────────── */

function GeneralSection({
  draft,
  edit,
}: {
  draft: OperatorSettings;
  edit: (mutate: (next: OperatorSettings) => void) => void;
}) {
  const set = <K extends keyof OperatorSettings['general']>(key: K, value: OperatorSettings['general'][K]) =>
    edit((next) => {
      next.general[key] = value;
    });

  return (
    <Card>
      <CardHeader title="Research" description="How much the engine gathers, and what it is allowed to show." />
      <div className="px-[20px] py-[16px] grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-[16px]">
        <NumberField
          label="Max sources"
          hint="Cited per answer."
          min={1}
          max={50}
          value={draft.general.maxSources}
          onCommit={(value) => set('maxSources', value)}
        />
        <NumberField
          label="Deep iterations"
          hint="Rounds a deep run may spend."
          min={1}
          max={20}
          value={draft.general.deepIterations}
          onCommit={(value) => set('deepIterations', value)}
        />
        <NumberField
          label="Autocomplete count"
          hint="Suggestions per keystroke."
          min={0}
          max={25}
          value={draft.general.autocompleteCount}
          onCommit={(value) => set('autocompleteCount', value)}
        />
        <div className="sm:col-span-2 lg:col-span-3">
          <Field label="Title model" hint="Model used for section titles. Empty means the mode default.">
            {(id) => (
              <Input
                id={id}
                value={draft.general.titleModel}
                onChange={(event) => set('titleModel', event.target.value)}
                placeholder="leave empty for the default"
                className="font-mono text-[13px]"
                spellCheck={false}
              />
            )}
          </Field>
        </div>
        <div className="sm:col-span-2 lg:col-span-3">
          <Field label="Thinking strip patterns" hint="Regexes removed from provider output before the answer is shown.">
            {(id) => (
              <Textarea
                id={id}
                value={draft.general.thinkingStripPatterns}
                onChange={(event) => set('thinkingStripPatterns', event.target.value)}
                placeholder="one pattern per line"
                className="min-h-[64px] font-mono text-[12px]"
              />
            )}
          </Field>
        </div>
        <label className="inline-flex items-center gap-[8px] text-[13px] cursor-pointer">
          <input
            type="checkbox"
            checked={draft.general.showDebugContext}
            onChange={(event) => set('showDebugContext', event.target.checked)}
            className="h-[15px] w-[15px] accent-[var(--accent)]"
          />
          Show debug context
        </label>
      </div>
    </Card>
  );
}

function ApiSection({
  draft,
  edit,
}: {
  draft: OperatorSettings;
  edit: (mutate: (next: OperatorSettings) => void) => void;
}) {
  const set = <K extends keyof OperatorSettings['api']>(key: K, value: OperatorSettings['api'][K]) =>
    edit((next) => {
      next.api[key] = value;
    });

  return (
    <Card>
      <CardHeader title="API limits" description="Ceilings the server enforces regardless of plan." />
      <div className="px-[20px] py-[16px] grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-[16px]">
        <NumberField
          label="Concurrent requests"
          hint="Per key, at once."
          min={1}
          max={64}
          value={draft.api.defaultMaxConcurrent}
          onCommit={(value) => set('defaultMaxConcurrent', value)}
        />
        <NumberField
          label="Active jobs"
          hint="Research jobs at once."
          min={1}
          max={10000}
          value={draft.api.maxActiveJobs}
          onCommit={(value) => set('maxActiveJobs', value)}
        />
        <NumberField
          label="Retention"
          hint="Minutes before job data is swept."
          min={1}
          max={525600}
          value={draft.api.maxRetentionMinutes}
          onCommit={(value) => set('maxRetentionMinutes', value)}
        />
        <div className="sm:col-span-2 lg:col-span-3">
          <Field label="Default research mode" hint="The mode a request gets when it names none.">
            {(id) => (
              <Select
                id={id}
                value={draft.api.defaultMode}
                onChange={(event) => set('defaultMode', event.target.value as OperatorSettings['api']['defaultMode'])}
                className="max-w-[320px]"
              >
                <option value="default">default</option>
                <option value="deep">deep</option>
                <option value="max">max</option>
              </Select>
            )}
          </Field>
        </div>
      </div>
    </Card>
  );
}

function ServerSection({ settings }: { settings: OperatorSettings }) {
  return (
    <Card>
      <CardHeader
        title="Server"
        description="Both are read-only here: they decide where the socket binds, so changing them means editing settings.yaml and restarting."
      />
      <div className="px-[20px] py-[16px] flex flex-wrap gap-[24px]">
        <div>
          <p className="text-[13px] text-[var(--gray-600)]">Listening on</p>
          <p className="text-[14px] font-mono">
            {settings.server.host}:{settings.server.port}
          </p>
        </div>
        <div>
          <p className="text-[13px] text-[var(--gray-600)]">Settings file</p>
          <p className="text-[14px] font-mono">&lt;data dir&gt;/settings.yaml</p>
        </div>
      </div>
    </Card>
  );
}

/* ── Shared bits ─────────────────────────────────────────────────────────── */

function NumberField({
  label,
  hint,
  value,
  min,
  max,
  onCommit,
}: {
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  onCommit: (value: number) => void;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);

  const commit = () => {
    const parsed = Number(text);
    if (Number.isFinite(parsed) && Number.isInteger(parsed) && parsed >= min && parsed <= max) onCommit(parsed);
    else setText(String(value));
  };

  return (
    <Field label={label} hint={hint}>
      {(id) => (
        <Input
          id={id}
          inputMode="numeric"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => event.key === 'Enter' && commit()}
          className="font-mono text-[13px]"
        />
      )}
    </Field>
  );
}

/**
 * The document as the server will read it. Sent whole on Save: the endpoint
 * merges section by section, so a section that is present replaces and one that
 * is absent is left alone.
 */
function buildPatch(
  doc: OperatorSettings,
  deletedProviders: string[],
  deletedSearch: string[],
): SettingsPatch {
  return {
    providers: {
      ...doc.providers,
      ...Object.fromEntries(deletedProviders.map((id) => [id, null])),
    },
    providerOrder: doc.providerOrder,
    searchProviders: {
      ...doc.searchProviders,
      ...Object.fromEntries(deletedSearch.map((id) => [id, null])),
    },
    searchProviderOrder: doc.searchProviderOrder,
    modelRouting: doc.modelRouting,
    api: doc.api,
    general: doc.general,
  };
}

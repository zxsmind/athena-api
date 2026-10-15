import { useCallback, useEffect, useMemo, useState } from 'react';
import { Page } from '../components/Page';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  Input,
  Select,
  Spinner,
  Table,
  Td,
  Tr,
  useToast,
} from '../components/ui';
import {
  ApiError,
  getSettings,
  models,
  updateSettings,
  type CatalogModel,
  type CatalogProvider,
  type OperatorSettings,
  type ResearchModeId,
  type SettingsProviderState,
} from '../lib/api';

const PAGE_SIZE = 60;

const MODE_LABELS: Record<ResearchModeId, string> = {
  instant: 'instant',
  default: 'default',
  deep: 'deep',
  max: 'max',
};

/**
 * The catalog, and what this deployment serves of it.
 *
 * Two things used to be wrong here: the endpoint returned nothing for a
 * configured server (an empty whitelist was read as "no models" rather than
 * "every model"), and the page could only read. It can now choose what a
 * provider serves and where a mode's default model points.
 */
export function AdminModels() {
  const toast = useToast();

  const [settings, setSettings] = useState<OperatorSettings | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [providerId, setProviderId] = useState('');
  const [catalog, setCatalog] = useState<CatalogProvider | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [wholeCatalog, setWholeCatalog] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [visible, setVisible] = useState(PAGE_SIZE);
  const [saving, setSaving] = useState(false);

  const loadSettings = useCallback(async () => {
    try {
      const value = await getSettings();
      setSettings(value);
      setSettingsError(null);
      return value;
    } catch (error) {
      setSettingsError(error instanceof ApiError ? error.message : 'Settings could not be loaded.');
      return null;
    }
  }, []);

  useEffect(() => {
    void loadSettings().then((value) => {
      if (value) setProviderId(defaultProvider(value));
    });
  }, [loadSettings]);

  /* Provider choice drives a fresh catalog fetch; the saved whitelist decides
     which mode the editor starts in. */
  useEffect(() => {
    if (!providerId) return;
    let cancelled = false;
    setCatalog(null);
    setCatalogError(null);
    setVisible(PAGE_SIZE);
    models(providerId)
      .then((response) => {
        if (cancelled) return;
        setCatalog(response.providers[0] ?? null);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setCatalogError(error instanceof ApiError ? error.message : 'The catalog could not be loaded.');
      });
    return () => {
      cancelled = true;
    };
  }, [providerId]);

  useEffect(() => {
    if (!settings || !providerId) return;
    const state = settings.providers[providerId];
    const whitelist = state?.models ?? [];
    setWholeCatalog(whitelist.length === 0);
    setSelected(new Set(whitelist));
  }, [settings, providerId]);

  const rows = useMemo(() => {
    if (!catalog) return [];
    const needle = query.trim().toLowerCase();
    return catalog.models.filter(
      (model) => !needle || model.id.toLowerCase().includes(needle) || (model.name ?? '').toLowerCase().includes(needle),
    );
  }, [catalog, query]);

  const shown = rows.slice(0, visible);

  const savedState = settings?.providers[providerId];
  const savedWhitelist = savedState?.models ?? [];
  const dirty =
    !settings ||
    wholeCatalog !== (savedWhitelist.length === 0) ||
    (!wholeCatalog && sortedKey(selected) !== sortedKey(new Set(savedWhitelist)));

  const toggleModel = (model: CatalogModel, checked: boolean) => {
    /* The whitelist and the default routes are set in two different places, so
       unchecking a model some mode starts from is how they end up
       contradicting each other: the mode would point at something this provider
       no longer serves, and the server refuses the save. Stop it here instead,
       naming the mode that is in the way. */
    if (!checked && model.default_modes.length > 0) {
      toast(
        `${model.id} starts ${model.default_modes.join(', ')} mode. Point ${model.default_modes[0]} at another model first — "Set as default…" on that row, or Settings → Default model per mode.`,
        'danger',
      );
      return;
    }
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(model.id);
      else next.delete(model.id);
      return next;
    });
    setVisible(PAGE_SIZE);
  };

  /** Adds or removes every model the current filter matches, in one step. */
const selectMatching = (checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      for (const model of rows) {
        if (checked) next.add(model.id);
        else next.delete(model.id);
      }
      return next;
    });
  };

  const save = async () => {
    if (!settings || !providerId) return;
    if (!wholeCatalog && selected.size === 0) {
      toast('Pick at least one model, or switch back to “All catalog models”.', 'danger');
      return;
    }
    setSaving(true);
    try {
      const current = settings.providers[providerId];
      const next: SettingsProviderState = {
        enabled: current?.enabled ?? true,
        keys: current?.keys ?? [],
        keyCount: current?.keyCount ?? 0,
        servesWholeCatalog: wholeCatalog,
        models: wholeCatalog ? [] : [...selected],
      };
      const fresh = await updateSettings({ providers: { [providerId]: next } });
      setSettings(fresh);
      toast(
        wholeCatalog
          ? `${providerId} serves every model in its catalog.`
          : `${providerId} now serves ${selected.size} models.`,
      );
    } catch (error) {
      toast(error instanceof ApiError ? error.message : 'The selection could not be saved.', 'danger');
    } finally {
      setSaving(false);
    }
  };

  const setDefaultFor = async (mode: ResearchModeId, model: CatalogModel) => {
    if (!settings) return;
    try {
      const fresh = await updateSettings({
        modelRouting: { [mode]: { primary: { providerId, model: model.id } } },
      });
      setSettings(fresh);
      toast(`${MODE_LABELS[mode]} mode now defaults to ${model.id}.`);
    } catch (error) {
      toast(error instanceof ApiError ? error.message : 'The default model could not be saved.', 'danger');
    }
  };

  if (settingsError) {
    return (
      <Page title="Models" description="What this deployment serves, and what each mode defaults to.">
        <Card className="p-[32px] text-center">
          <p className="text-[13px] text-[var(--danger)]">{settingsError}</p>
          <div className="mt-[14px]">
            <Button onClick={() => void loadSettings()}>Try again</Button>
          </div>
        </Card>
      </Page>
    );
  }

  if (!settings) {
    return (
      <Page title="Models" description="What this deployment serves, and what each mode defaults to.">
        <Card className="p-[48px] flex justify-center">
          <Spinner label="Loading settings…" />
        </Card>
      </Page>
    );
  }

  return (
    <Page
      title="Models"
      description="Pick which models each provider serves, and which model each research mode starts from."
      actions={
        dirty ? (
          <Button variant="primary" loading={saving} onClick={() => void save()}>
            Save selection
          </Button>
        ) : (
          <Badge tone="ok">saved</Badge>
        )
      }
    >
      <div className="flex flex-wrap items-center gap-[12px]">
        <Select value={providerId} onChange={(event) => setProviderId(event.target.value)} className="w-[300px]">
          <optgroup label="Configured providers">
            {settings.catalog.providers
              .filter((entry) => entry.configured)
              .map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name} ({entry.id})
                </option>
              ))}
          </optgroup>
          <optgroup label="All catalog providers">
            {settings.catalog.providers
              .filter((entry) => !entry.configured)
              .map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name} ({entry.modelCount} models)
                </option>
              ))}
          </optgroup>
        </Select>
        <Input
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setVisible(PAGE_SIZE);
          }}
          placeholder="Filter by model id or name…"
          className="w-[260px] font-mono text-[12px]"
        />
        <span className="text-[12px] font-mono text-[var(--gray-500)]">
          {rows.length} {query ? 'matching' : 'in catalog'}
        </span>
      </div>

      {savedState?.keyCount === 0 && (
        <Card className="px-[16px] py-[12px] border-[var(--warn)]">
          <p className="text-[13px] text-[var(--warn)]">
            <span className="font-medium">{providerId}</span> has no API key yet, so no request will reach it.
            Add one in Settings → Providers.
          </p>
        </Card>
      )}

      <Card className="px-[16px] py-[14px] flex flex-wrap items-center gap-[20px]">
        <span className="text-[13px] font-medium text-[var(--gray-700)]">What this provider serves</span>
        <label className="inline-flex items-center gap-[8px] text-[13px] cursor-pointer">
          <input
            type="radio"
            name="serving-mode"
            checked={wholeCatalog}
            onChange={() => setWholeCatalog(true)}
            className="h-[15px] w-[15px] accent-[var(--accent)]"
          />
          All catalog models
          <span className="text-[var(--gray-500)]">— new models are picked up automatically</span>
        </label>
        <label className="inline-flex items-center gap-[8px] text-[13px] cursor-pointer">
          <input
            type="radio"
            name="serving-mode"
            checked={!wholeCatalog}
            onChange={() => {
              /* Not the whole catalog. Arriving from "All catalog models" with
                 three hundred models ticked is not a choice, it is a chore with
                 a checkbox on every row; and the useful default is the short
                 list an operator can trim. The models a mode actually starts
                 from are ticked, because dropping one of those is refused
                 anyway — a run pointed at a model this provider stopped serving
                 fails every call. */
              if (selected.size === 0) {
                const inUse = new Set<string>();
                for (const route of Object.values(settings.modelRouting)) {
                  if (route.primary.providerId === providerId) inUse.add(route.primary.model);
                  for (const fallback of route.fallback) {
                    if (fallback.providerId === providerId) inUse.add(fallback.model);
                  }
                }
                setSelected(new Set([...inUse].filter((id) => (catalog?.models ?? []).some((model) => model.id === id))));
              }
              setWholeCatalog(false);
            }}
            className="h-[15px] w-[15px] accent-[var(--accent)]"
          />
          Only selected models
          <span className="text-[var(--gray-500)]">— {selected.size} selected</span>
        </label>
        {!wholeCatalog && selected.size > 0 && (
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
            Clear selection
          </Button>
        )}
        {!wholeCatalog && (
          <>
            {/* Bulk actions follow the filter. The catalog is far too long to
                settle by clicking rows one at a time, and the filter is how an
                operator narrows it to the handful they are choosing between. */}
            <Button size="sm" variant="ghost" disabled={rows.length === 0} onClick={() => selectMatching(true)}>
              Select {query.trim() ? 'matching' : 'all'}
            </Button>
            <Button size="sm" variant="ghost" disabled={rows.length === 0} onClick={() => selectMatching(false)}>
              Clear {query.trim() ? 'matching' : 'all'}
            </Button>
          </>
        )}
        {wholeCatalog && (
          <span className="text-[12px] text-[var(--gray-500)]">
            Every model is served, so there is nothing to tick. Switch to “Only selected models” to narrow it.
          </span>
        )}
      </Card>

      <Card className="overflow-hidden">
        {catalogError && <div className="p-[32px] text-center text-[13px] text-[var(--danger)]">{catalogError}</div>}
        {!catalog && !catalogError && (
          <div className="p-[32px] text-center text-[13px] text-[var(--gray-500)]">Loading the catalog…</div>
        )}
        {catalog && rows.length === 0 && (
          <div className="p-[48px] text-center text-[13px] text-[var(--gray-500)]">
            {query ? 'No models match the filter.' : 'This provider lists no models in the catalog.'}
          </div>
        )}
        {catalog && shown.length > 0 && (
          <>
            <Table head={['serve', 'model', 'reasoning', 'tools', 'context', 'max out', 'in $/M', 'out $/M', 'default for']}>
              {shown.map((model) => (
                <Tr key={model.id}>
                  <Td>
                    <Checkbox
                      checked={wholeCatalog || selected.has(model.id)}
                      disabled={wholeCatalog}
                      onChange={(checked) => toggleModel(model, checked)}
                      label={<span className="sr-only">{model.id}</span>}
                    />
                  </Td>
                  <Td mono className="font-medium">
                    {model.id}
                    {model.default_modes.length > 0 && (
                      <span className="ml-[8px] inline-flex gap-[4px]">
                        {model.default_modes.map((mode) => (
                          <Badge key={mode} tone="ok">
                            {mode}
                          </Badge>
                        ))}
                      </span>
                    )}
                  </Td>
                  <Td mono>{model.reasoning ? 'yes' : '—'}</Td>
                  <Td mono>{model.tool_call ? 'yes' : '—'}</Td>
                  <Td mono className="text-[var(--gray-600)]">{model.context ? formatCount(model.context) : '—'}</Td>
                  <Td mono className="text-[var(--gray-600)]">{model.max_output ? formatCount(model.max_output) : '—'}</Td>
                  <Td mono className="text-[var(--gray-600)]">{model.cost?.input?.toFixed(2) ?? '—'}</Td>
                  <Td mono className="text-[var(--gray-600)]">{model.cost?.output?.toFixed(2) ?? '—'}</Td>
                  <Td>
                    <Select
                      value=""
                      onChange={(event) => {
                        if (event.target.value) void setDefaultFor(event.target.value as ResearchModeId, model);
                      }}
                      className="w-[124px] h-[30px] text-[12px]"
                    >
                      <option value="">Set as default…</option>
                      {settings.modes.map((mode) => (
                        <option key={mode} value={mode}>
                          {MODE_LABELS[mode]} mode
                        </option>
                      ))}
                    </Select>
                  </Td>
                </Tr>
              ))}
            </Table>
            {rows.length > shown.length && (
              <div className="flex items-center justify-between gap-[12px] px-[16px] py-[12px] border-t border-[var(--border)]">
                <span className="text-[12px] font-mono text-[var(--gray-500)]">
                  Showing {shown.length} of {rows.length}
                </span>
                <Button size="sm" onClick={() => setVisible((current) => current + PAGE_SIZE)}>
                  Show more
                </Button>
              </div>
            )}
          </>
        )}
      </Card>
    </Page>
  );
}

/** The provider to open first: the one the router will reach first, if any. */
function defaultProvider(settings: OperatorSettings): string {
  const withKey = settings.providerOrder.find((id) => (settings.providers[id]?.keyCount ?? 0) > 0);
  return withKey ?? settings.providerOrder[0] ?? settings.catalog.providers[0]?.id ?? '';
}

function sortedKey(values: Set<string>): string {
  return [...values].sort().join('\n');
}

function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return String(value);
}

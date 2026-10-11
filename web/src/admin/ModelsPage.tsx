import { useEffect, useMemo, useState } from 'react';
import { Page } from '../components/Page';
import { Badge, Card, Input, Select, Table, Td, Tr } from '../components/ui';
import { models, type CatalogModel, type CatalogProvider } from '../lib/api';

export function AdminModels() {
  const [providers, setProviders] = useState<CatalogProvider[] | null>(null);
  const [fetchedAt, setFetchedAt] = useState('');
  const [providerFilter, setProviderFilter] = useState('');
  const [query, setQuery] = useState('');

  useEffect(() => {
    let cancelled = false;
    models()
      .then((response) => {
        if (cancelled) return;
        setProviders(response.providers);
        setFetchedAt(response.fetched_at);
      })
      .catch(() => {
        if (!cancelled) setProviders([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const rows = useMemo(() => {
    if (!providers) return [];
    const needle = query.trim().toLowerCase();
    const out: Array<{ provider: string; model: CatalogModel; configured: boolean }> = [];
    for (const provider of providers) {
      if (providerFilter && provider.id !== providerFilter) continue;
      const configured = new Set(provider.configured_models);
      for (const model of provider.models) {
        if (needle && !model.id.toLowerCase().includes(needle)) continue;
        out.push({ provider: provider.id, model, configured: configured.has(model.id) });
      }
    }
    return out.slice(0, 400);
  }, [providers, providerFilter, query]);

  return (
    <Page
      title="Models"
      description="The models.dev catalog with the server's overlay: which models of each provider are configured on this deployment."
      actions={fetchedAt ? <span className="text-[11px] font-mono text-[var(--gray-500)]">cached {fetchedAt.slice(0, 16).replace('T', ' ')}</span> : undefined}
    >
      <div className="flex flex-wrap items-center gap-[12px]">
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filter by model id…"
          className="w-[260px] font-mono text-[12px]"
        />
        <Select value={providerFilter} onChange={(event) => setProviderFilter(event.target.value)} className="w-[220px]">
          <option value="">All providers</option>
          {providers?.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.id}
              {provider.configured_models.length > 0 ? ` (${provider.configured_models.length} configured)` : ''}
            </option>
          ))}
        </Select>
        <span className="text-[12px] font-mono text-[var(--gray-500)]">{rows.length} models</span>
      </div>

      <Card className="overflow-hidden">
        {providers === null && <div className="p-[32px] text-center text-[13px] text-[var(--gray-500)]">Loading the catalog…</div>}
        {providers !== null && rows.length === 0 && (
          <div className="p-[48px] text-center text-[13px] text-[var(--gray-500)]">No models match the filter.</div>
        )}
        {rows.length > 0 && (
          <Table head={['provider', 'model', 'reasoning', 'tools', 'context', 'max out', 'in $/M', 'out $/M']}>
            {rows.map(({ provider, model, configured }) => (
              <Tr key={`${provider}/${model.id}`}>
                <Td mono className="text-[var(--gray-500)]">{provider}</Td>
                <Td mono className="font-medium">
                  {model.id}
                  {configured && (
                    <span className="ml-[8px]">
                      <Badge tone="ok">configured</Badge>
                    </span>
                  )}
                </Td>
                <Td mono>{model.reasoning ? 'yes' : '—'}</Td>
                <Td mono>{model.tool_call ? 'yes' : '—'}</Td>
                <Td mono className="text-[var(--gray-600)]">{model.context ? formatCount(model.context) : '—'}</Td>
                <Td mono className="text-[var(--gray-600)]">{model.max_output ? formatCount(model.max_output) : '—'}</Td>
                <Td mono className="text-[var(--gray-600)]">{model.cost?.input?.toFixed(2) ?? '—'}</Td>
                <Td mono className="text-[var(--gray-600)]">{model.cost?.output?.toFixed(2) ?? '—'}</Td>
              </Tr>
            ))}
          </Table>
        )}
      </Card>
    </Page>
  );
}

function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1000)}K`;
  return String(value);
}

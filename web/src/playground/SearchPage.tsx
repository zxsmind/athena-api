import { useState } from 'react';
import { motion } from 'framer-motion';
import { Page } from '../components/Page';
import { Badge, Button, Card, CodeBlock, Field, Input, Select, Spinner, useToast } from '../components/ui';
import { ApiError, search, type SearchResponse } from '../lib/api';

const SEARCH_TYPES = ['search', 'news', 'images', 'videos', 'places', 'shopping', 'scholar', 'patents'];
const TIME_RANGES = ['day', 'week', 'month', 'year'];

function domainList(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function SearchPage() {
  const toast = useToast();
  const [query, setQuery] = useState('');
  const [type, setType] = useState('search');
  const [count, setCount] = useState(8);
  const [country, setCountry] = useState('us');
  const [language, setLanguage] = useState('en');
  const [timeRange, setTimeRange] = useState('');
  const [depth, setDepth] = useState('passages');
  const [include, setInclude] = useState('');
  const [exclude, setExclude] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<SearchResponse | null>(null);

  const submit = async () => {
    if (!query.trim()) return;
    setLoading(true);
    setResult(null);
    try {
      const response = await search({
        query: query.trim(),
        type: type as 'search',
        count,
        country: country.trim() || undefined,
        language: language.trim() || undefined,
        time_range: (timeRange || null) as 'day' | null,
        depth: depth as 'passages',
        include_domains: domainList(include),
        exclude_domains: domainList(exclude),
      });
      setResult(response);
    } catch (error) {
      toast(
        error instanceof ApiError
          ? `${error.code}: ${error.message}`
          : error instanceof Error
            ? error.message
            : 'Search failed.',
        'danger',
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <Page
      title="Search"
      description="Deterministic ranked web results through the configured provider chain. No model, no reasoning — one provider call."
      actions={result ? <Badge>{`${result.results.length} results · ${result.metadata.elapsed_ms}ms`}</Badge> : undefined}
    >
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)] gap-[16px] items-start">
        <Card className="p-[16px] flex flex-col gap-[14px]">
          <Field label="Query">
            {(id) => (
              <Input
                id={id}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => event.key === 'Enter' && void submit()}
                placeholder="solid state battery energy density 2026"
              />
            )}
          </Field>
          <div className="grid grid-cols-2 gap-[10px]">
            <Field label="Type">
              {(id) => (
                <Select id={id} value={type} onChange={(event) => setType(event.target.value)}>
                  {SEARCH_TYPES.map((item) => (
                    <option key={item} value={item}>{item}</option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Count">
              {(id) => (
                <Input
                  id={id}
                  type="number"
                  min={1}
                  max={20}
                  value={count}
                  onChange={(event) => setCount(Number(event.target.value))}
                />
              )}
            </Field>
            <Field label="Country">
              {(id) => <Input id={id} value={country} maxLength={2} onChange={(event) => setCountry(event.target.value)} />}
            </Field>
            <Field label="Language">
              {(id) => <Input id={id} value={language} maxLength={3} onChange={(event) => setLanguage(event.target.value)} />}
            </Field>
            <Field label="Time range">
              {(id) => (
                <Select id={id} value={timeRange} onChange={(event) => setTimeRange(event.target.value)}>
                  <option value="">any</option>
                  {TIME_RANGES.map((item) => (
                    <option key={item} value={item}>{item}</option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Depth">
              {(id) => (
                <Select id={id} value={depth} onChange={(event) => setDepth(event.target.value)}>
                  <option value="links">links</option>
                  <option value="passages">passages</option>
                  <option value="full">full (costs more)</option>
                </Select>
              )}
            </Field>
          </div>
          <Field label="Include domains" hint="Comma-separated, up to 30.">
            {(id) => <Input id={id} value={include} onChange={(event) => setInclude(event.target.value)} placeholder="nature.com, science.org" />}
          </Field>
          <Field label="Exclude domains">
            {(id) => <Input id={id} value={exclude} onChange={(event) => setExclude(event.target.value)} placeholder="pinterest.com" />}
          </Field>
          <Button variant="primary" loading={loading} onClick={() => void submit()}>
            {loading ? 'Searching…' : 'Run search'}
          </Button>
        </Card>

        <div className="flex flex-col gap-[12px] min-w-0">
          {loading && <Card className="p-[24px]"><Spinner label="Calling the provider chain…" /></Card>}
          {!loading && !result && (
            <Card className="p-[24px] text-center text-[13px] text-[var(--gray-500)]">
              Results appear here. The query is sent as the API would send it.
            </Card>
          )}
          {result && (
            <>
              <Card className="flex flex-wrap items-center gap-x-[18px] gap-y-[6px] px-[14px] py-[10px] text-[12px] font-mono text-[var(--gray-600)]">
                <span>provider <span className="text-[var(--foreground)]">{result.metadata.provider}</span></span>
                <span>depth <span className="text-[var(--foreground)]">{result.applied.depth}</span></span>
                <span>country <span className="text-[var(--foreground)]">{result.applied.country}</span></span>
                <span>language <span className="text-[var(--foreground)]">{result.applied.language}</span></span>
                <span>time_range <span className="text-[var(--foreground)]">{result.applied.time_range ?? 'any'}</span></span>
              </Card>
              <div className="flex flex-col gap-[8px]">
                {result.results.map((item, index) => (
                  <motion.a
                    key={`${item.url}-${index}`}
                    href={item.url}
                    target="_blank"
                    rel="noreferrer"
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.2, delay: Math.min(index * 0.03, 0.24) }}
                  >
                    <Card className="p-[14px] hover:border-[var(--border-strong)] transition-colors duration-120 cursor-pointer">
                      <div className="flex items-baseline justify-between gap-[10px]">
                        <p className="text-[13px] font-medium truncate">{item.title || item.url}</p>
                        {item.date && <span className="text-[11px] font-mono text-[var(--gray-500)] shrink-0">{item.date}</span>}
                      </div>
                      <p className="text-[12px] font-mono text-[var(--gray-500)] truncate mt-[2px]">{item.url}</p>
                      {item.snippet && <p className="text-[13px] text-[var(--gray-700)] mt-[6px] line-clamp-2">{item.snippet}</p>}
                    </Card>
                  </motion.a>
                ))}
              </div>
              <CodeBlock code={JSON.stringify(result, null, 2)} language="json" />
            </>
          )}
        </div>
      </div>
    </Page>
  );
}

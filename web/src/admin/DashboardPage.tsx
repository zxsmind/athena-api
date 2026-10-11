import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Page } from '../components/Page';
import { Badge, Card, Select, Table, Td, Tr } from '../components/ui';
import { analytics, type AnalyticsRollup } from '../lib/api';

export function AdminDashboard() {
  const [days, setDays] = useState(7);
  const [data, setData] = useState<AnalyticsRollup | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    analytics(days)
      .then((rollup) => {
        if (!cancelled) {
          setData(rollup);
          setError(null);
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : 'Analytics unavailable.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [days]);

  const peak = data ? Math.max(1, ...data.byDay.map((day) => day.requests)) : 1;

  return (
    <Page
      title="Dashboard"
      description="Usage rollups for the selected window. Everything here is local-network and admin-key gated on the server."
      actions={
        <Select value={days} onChange={(event) => setDays(Number(event.target.value))} className="w-[120px]">
          <option value={1}>Last 24 h</option>
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
        </Select>
      }
    >
      {loading && <Card className="p-[32px] text-center text-[13px] text-[var(--gray-500)]">Loading rollups…</Card>}
      {error && <Card className="p-[16px] border-[var(--danger)]!"><p className="text-[13px] text-[var(--danger)]">{error}</p></Card>}

      {data && (
        <div className="flex flex-col gap-[16px]">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-[12px]">
            <Stat label="Requests" value={data.requests.toLocaleString()} />
            <Stat label="Errors" value={data.errors.toLocaleString()} tone={data.errors > 0 ? 'warn' : 'neutral'} />
            <Stat label="Avg latency" value={`${data.averageDurationMs} ms`} />
            <Stat
              label="Error rate"
              value={data.requests > 0 ? `${((data.errors / data.requests) * 100).toFixed(2)}%` : '—'}
            />
          </div>

          <Card className="overflow-hidden">
            <div className="px-[16px] py-[12px] border-b border-[var(--border)] flex items-center justify-between">
              <h3 className="text-[13px] font-semibold tracking-tight">Requests by day</h3>
              <span className="text-[11px] font-mono text-[var(--gray-500)]">{data.byDay.length} days</span>
            </div>
            <div className="p-[16px] flex flex-col gap-[8px]">
              {data.byDay.map((day, index) => (
                <motion.div
                  key={day.day}
                  className="flex items-center gap-[12px]"
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.22, delay: Math.min(index * 0.03, 0.3) }}
                >
                  <span className="text-[12px] font-mono text-[var(--gray-500)] w-[84px] shrink-0">{day.day}</span>
                  <div className="flex-1 h-[14px] rounded-[4px] bg-[var(--gray-100)] overflow-hidden">
                    <motion.div
                      className="h-full rounded-[4px] bg-[var(--foreground)]"
                      initial={{ width: 0 }}
                      animate={{ width: `${(day.requests / peak) * 100}%` }}
                      transition={{ type: 'spring', stiffness: 120, damping: 22, delay: index * 0.03 }}
                    />
                  </div>
                  <span className="text-[12px] font-mono text-[var(--gray-700)] w-[64px] text-right shrink-0">
                    {day.requests.toLocaleString()}
                    {day.errors > 0 && <span className="text-[var(--danger)]"> · {day.errors} err</span>}
                  </span>
                </motion.div>
              ))}
            </div>
          </Card>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-[16px]">
            <Card className="overflow-hidden">
              <div className="px-[16px] py-[12px] border-b border-[var(--border)]">
                <h3 className="text-[13px] font-semibold tracking-tight">Requests by route</h3>
              </div>
              <Table head={['route', 'requests', 'errors']}>
                {data.byRoute.map((row) => (
                  <Tr key={row.route}>
                    <Td mono>{row.route}</Td>
                    <Td mono>{row.requests.toLocaleString()}</Td>
                    <Td mono className={row.errors > 0 ? 'text-[var(--danger)]' : ''}>
                      {row.errors.toLocaleString()}
                    </Td>
                  </Tr>
                ))}
              </Table>
            </Card>

            <Card className="overflow-hidden">
              <div className="px-[16px] py-[12px] border-b border-[var(--border)]">
                <h3 className="text-[13px] font-semibold tracking-tight">Requests by key</h3>
              </div>
              <Table head={['key', 'id', 'requests', 'errors']}>
                {data.byKey.map((row) => (
                  <Tr key={row.id}>
                    <Td>
                      {row.name}
                      <span className="ml-[8px] font-mono text-[11px] text-[var(--gray-500)]">{row.prefix}…</span>
                    </Td>
                    <Td mono className="text-[var(--gray-500)]">{row.id}</Td>
                    <Td mono>{row.requests.toLocaleString()}</Td>
                    <Td mono className={row.errors > 0 ? 'text-[var(--danger)]' : ''}>
                      {row.errors.toLocaleString()}
                    </Td>
                  </Tr>
                ))}
              </Table>
            </Card>
          </div>
        </div>
      )}
    </Page>
  );
}

function Stat({ label, value, tone = 'neutral' }: { label: string; value: string; tone?: 'neutral' | 'warn' }) {
  return (
    <Card className="px-[16px] py-[14px] flex flex-col gap-[4px]">
      <span className="text-[12px] text-[var(--gray-600)]">{label}</span>
      <span className="flex items-center gap-[8px]">
        <span className="text-[22px] font-semibold tabular-nums tracking-tight">{value}</span>
        {tone === 'warn' && <Badge tone="warn">errors</Badge>}
      </span>
    </Card>
  );
}

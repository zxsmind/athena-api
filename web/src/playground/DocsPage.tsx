import { Page } from '../components/Page';
import { Card } from '../components/ui';

const endpoints = [
  ['GET', '/health', 'Liveness probe. No authentication.'],
  ['POST', '/search', 'Ranked results. query, type, count, country, language, time_range, depth, include/exclude domains.'],
  ['POST', '/contents', 'Readable text for 1–20 URLs, each with a sha-256 digest.'],
  ['POST', '/research', 'Start an agentic job. Returns 202 with job_id and the two stream URLs.'],
  ['GET', '/jobs', 'Recent jobs for this key (loopback sees every API job).'],
  ['GET', '/jobs/:id', 'Snapshot: status, progress counters, result.'],
  ['GET', '/jobs/:id/events', 'SSE replay from Last-Event-ID.'],
  ['POST', '/jobs/:id/cancel', 'Stop a running job and release its slot.'],
  ['POST', '/jobs/:id/pause', 'Checkpoint and release the slot.'],
  ['POST', '/jobs/:id/resume', 'Continue a paused job from its checkpoint.'],
  ['GET', '/models', 'The models.dev catalog with the server overlay.'],
  ['GET', '/analytics', 'Usage rollups. Admin key, local network only.'],
];

const errors = [
  ['UNAUTHORIZED', '401', 'Missing, unknown, or revoked key'],
  ['NOT_FOUND', '404', 'No such research job'],
  ['CONCURRENCY_LIMIT', '429', 'Too many jobs running for this key'],
  ['SEARCH_NOT_CONFIGURED', '503', 'No search backend has a key on the server'],
  ['SCHEMA_VIOLATION', '400', 'Body failed schema validation'],
  ['LOCAL_MANAGEMENT_ONLY', '403', 'Key management is not exposed publicly'],
];

const modes = [
  ['instant', 'none', '15', '15', '200K', '5 min'],
  ['default', 'low', '40', '40', '600K', '20 min'],
  ['deep', 'medium', '120', '120', '1M', '90 min'],
  ['max', 'xhigh', '400', '400', '10M', '4 h'],
];

export function DocsPage() {
  return (
    <Page
      title="API Reference"
      description="The public contract, condensed. Every failure carries the same shape: { error: { code, message, details?, retryable } }."
    >
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-[16px] items-start">
        <Card className="overflow-hidden">
          <div className="px-[16px] py-[12px] border-b border-[var(--border)]">
            <h2 className="text-[14px] font-semibold tracking-tight">Endpoints</h2>
          </div>
          <table className="w-full text-[13px]">
            <tbody>
              {endpoints.map(([method, path, note]) => (
                <tr key={path + method} className="border-b border-[var(--border)] last:border-0">
                  <td className="px-[16px] py-[10px] font-mono text-[11px] text-[var(--gray-500)] w-[56px]">{method}</td>
                  <td className="px-[12px] py-[10px] font-mono text-[12px] whitespace-nowrap">{path}</td>
                  <td className="px-[16px] py-[10px] text-[var(--gray-600)]">{note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>

        <div className="flex flex-col gap-[16px]">
          <Card className="overflow-hidden">
            <div className="px-[16px] py-[12px] border-b border-[var(--border)]">
              <h2 className="text-[14px] font-semibold tracking-tight">Error codes</h2>
            </div>
            <table className="w-full text-[13px]">
              <tbody>
                {errors.map(([code, status, cause]) => (
                  <tr key={code} className="border-b border-[var(--border)] last:border-0">
                    <td className="px-[16px] py-[10px] font-mono text-[12px] whitespace-nowrap">{code}</td>
                    <td className="px-[12px] py-[10px] font-mono text-[11px] text-[var(--gray-500)]">{status}</td>
                    <td className="px-[16px] py-[10px] text-[var(--gray-600)]">{cause}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          <Card className="overflow-hidden">
            <div className="px-[16px] py-[12px] border-b border-[var(--border)]">
              <h2 className="text-[14px] font-semibold tracking-tight">Research modes</h2>
            </div>
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-[var(--border)] text-[11px] font-semibold uppercase tracking-wider text-[var(--gray-500)]">
                  <th className="px-[16px] py-[8px] text-left">mode</th>
                  <th className="px-[16px] py-[8px] text-left">effort</th>
                  <th className="px-[16px] py-[8px] text-left">search</th>
                  <th className="px-[16px] py-[8px] text-left">fetch</th>
                  <th className="px-[16px] py-[8px] text-left">tokens</th>
                  <th className="px-[16px] py-[8px] text-left">wall clock</th>
                </tr>
              </thead>
              <tbody>
                {modes.map((row) => (
                  <tr key={row[0]} className="border-b border-[var(--border)] last:border-0">
                    {row.map((cell, index) => (
                      <td key={index} className={`px-[16px] py-[10px] ${index === 0 ? 'font-mono text-[12px] font-medium' : 'font-mono text-[12px] text-[var(--gray-600)]'}`}>
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          <Card className="p-[16px] text-[13px] text-[var(--gray-600)] flex flex-col gap-[6px]">
            <h2 className="text-[14px] font-semibold tracking-tight text-[var(--foreground)]">Billing, briefly</h2>
            <p>A job reserves a concurrency slot at creation and releases it on any terminal state — completed, failed, cancelled or declined.</p>
            <p>Cache-read tokens are billed at a fraction of a fresh input token and do not count against the research ceiling.</p>
            <p>Tokens are billed only when the provider reported usage; an unpriced model is reported, never guessed.</p>
          </Card>
        </div>
      </div>
    </Page>
  );
}

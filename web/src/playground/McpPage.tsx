import { useMemo, useState } from 'react';
import { Page } from '../components/Page';
import { Badge, Card, CodeBlock, Field, Input } from '../components/ui';
import { getApiKey, maskedKey } from '../lib/storage';

function baseUrl(): string {
  return window.location.origin;
}

export function McpPage() {
  const [host, setHost] = useState(baseUrl());
  const key = getApiKey();

  const httpConfig = useMemo(
    () =>
      JSON.stringify(
        {
          mcpServers: {
            athena: {
              type: 'streamable-http',
              url: `${host.replace(/\/+$/, '')}/v1/mcp`,
              headers: { Authorization: `Bearer ${key || 'ath_…'}` },
            },
          },
        },
        null,
        2,
      ),
    [host, key],
  );

  const stdioConfig = useMemo(
    () =>
      JSON.stringify(
        {
          mcpServers: {
            athena: {
              command: 'athena',
              args: ['mcp'],
            },
          },
        },
        null,
        2,
      ),
    [],
  );

  const toolList = [
    ['athena_search', 'POST /v1/search'],
    ['athena_read_contents', 'POST /v1/contents'],
    ['athena_start_research', 'POST /v1/research'],
    ['athena_list_jobs', 'GET /v1/jobs'],
    ['athena_get_job', 'GET /v1/jobs/:id'],
    ['athena_cancel_job', 'POST /v1/jobs/:id/cancel'],
    ['athena_pause_job', 'POST /v1/jobs/:id/pause'],
    ['athena_resume_job', 'POST /v1/jobs/:id/resume'],
  ] as const;

  return (
    <Page
      title="MCP Connect"
      description="The same tools over the Model Context Protocol. Remote clients present the bearer key; a client on the same machine may omit it."
      actions={<Badge tone={key ? 'ok' : 'neutral'}>{key ? maskedKey(key) : 'No API key'}</Badge>}
    >
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-[16px] items-start">
        <Card className="p-[16px] flex flex-col gap-[12px]">
          <div className="flex flex-col gap-[4px]">
            <h2 className="text-[14px] font-semibold tracking-tight">Streamable HTTP</h2>
            <p className="text-[13px] text-[var(--gray-600)]">
              For a remote client (another machine, an IDE plugin). Point it at the server with the bearer key.
            </p>
          </div>
          <Field label="Server origin" hint="What the client can reach. Behind a proxy, use the public hostname.">
            {(id) => (
              <Input id={id} value={host} onChange={(event) => setHost(event.target.value)} className="font-mono text-[12px]" />
            )}
          </Field>
          <CodeBlock code={httpConfig} language="json" />
          <p className="text-[12px] text-[var(--gray-500)]">
            The Host header must be in <span className="font-mono">server.mcpAllowedHosts</span> (default: localhost, 127.0.0.1, [::1]).
            Connecting over a Tailscale IP? Add that IP to the list in <span className="font-mono">config.yaml</span> and restart —
            otherwise the endpoint answers <span className="font-mono">Invalid Host</span>.
          </p>
        </Card>

        <Card className="p-[16px] flex flex-col gap-[12px]">
          <div className="flex flex-col gap-[4px]">
            <h2 className="text-[14px] font-semibold tracking-tight">Local stdio</h2>
            <p className="text-[13px] text-[var(--gray-600)]">
              Launches <span className="font-mono">athena mcp</span> on the server itself, using the same data directory and settings.
              Carries the same scope as loopback access.
            </p>
          </div>
          <CodeBlock code={stdioConfig} language="json" />
          <p className="text-[12px] text-[var(--gray-500)]">
            Requires <span className="font-mono">npm run link:cli</span> so the <span className="font-mono">athena</span> command exists on PATH.
          </p>
        </Card>

        <Card className="lg:col-span-2 overflow-hidden">
          <div className="px-[16px] py-[12px] border-b border-[var(--border)]">
            <h2 className="text-[14px] font-semibold tracking-tight">Tool catalog</h2>
          </div>
          <table className="w-full text-[13px]">
            <tbody>
              {toolList.map(([tool, route]) => (
                <tr key={tool} className="border-b border-[var(--border)] last:border-0">
                  <td className="px-[16px] py-[10px] font-mono text-[12px]">{tool}</td>
                  <td className="px-[16px] py-[10px] font-mono text-[12px] text-[var(--gray-600)]">{route}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>
    </Page>
  );
}

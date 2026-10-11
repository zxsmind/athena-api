import { Card } from '../components/ui';
import { Page } from '../components/Page';
import { Badge } from '../components/ui';

export function AdminOps() {
  return (
    <Page
      title="Ops"
      description="Runtime surfaces for the operator: log tail, per-job traces and the database integrity check."
    >
      <Card className="p-[24px] flex flex-col gap-[10px] max-w-[560px]">
        <Badge tone="warn">Phase 3</Badge>
        <p className="text-[14px] font-medium">This panel waits on two local-only endpoints.</p>
        <p className="text-[13px] text-[var(--gray-600)]">
          The CLI already exposes each of these — <span className="font-mono">athena logs</span>,{' '}
          <span className="font-mono">athena trace &lt;jobId&gt;</span> and <span className="font-mono">athena repair</span>.
          Moving them into the console needs <span className="font-mono">GET /v1/logs</span>,{' '}
          <span className="font-mono">GET /v1/traces/:jobId</span> and <span className="font-mono">POST /v1/repair</span>,
          each on the same local-network + admin-key rule as <span className="font-mono">/v1/analytics</span>.
        </p>
        <p className="text-[13px] text-[var(--gray-600)]">
          No server change ships before that, so today this panel intentionally stays empty.
        </p>
      </Card>
    </Page>
  );
}

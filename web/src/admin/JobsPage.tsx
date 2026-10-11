import { useCallback, useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Ban, Pause, Play } from 'lucide-react';
import { Page } from '../components/Page';
import { Badge, Button, Card, EmptyState, Gauge, Table, Td, Tr, useToast } from '../components/ui';
import { ApiError, cancelJob, listJobs, pauseJob, resumeJob, type JobStatus, type PublicJob } from '../lib/api';

function statusTone(status: JobStatus): 'neutral' | 'live' | 'ok' | 'warn' | 'danger' {
  if (['running', 'searching', 'planning', 'reviewing', 'synthesizing'].includes(status)) return 'live';
  if (status === 'completed') return 'ok';
  if (status === 'failed' || status === 'cancelled') return 'danger';
  if (status === 'paused' || status === 'declined') return 'warn';
  return 'neutral';
}

const ACTIVE: JobStatus[] = ['queued', 'running', 'searching', 'planning', 'reviewing', 'synthesizing'];

export function AdminJobs() {
  const toast = useToast();
  const [jobs, setJobs] = useState<PublicJob[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setJobs((await listJobs(50)).jobs);
    } catch (error) {
      toast(error instanceof ApiError ? error.message : 'Jobs could not be loaded.', 'danger');
      setJobs([]);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  /* Loopback access sees every API job, so the list itself is the live view:
     refresh while anything is in flight. */
  useEffect(() => {
    if (!jobs?.some((job) => ACTIVE.includes(job.status))) return;
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [jobs, load]);

  const act = async (action: 'cancel' | 'pause' | 'resume', jobId: string) => {
    setBusy(true);
    try {
      if (action === 'cancel') await cancelJob(jobId);
      else if (action === 'pause') await pauseJob(jobId);
      else await resumeJob(jobId);
      await load();
    } catch (error) {
      toast(error instanceof ApiError ? error.message : 'The action failed.', 'danger');
    } finally {
      setBusy(false);
    }
  };

  const detail = jobs?.find((job) => job.job_id === selected) ?? null;

  return (
    <Page
      title="Jobs"
      description="Every research job the API has started, newest first. Loopback sees all of them; a key would see only its own."
    >
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,360px)] gap-[16px] items-start">
        <Card className="overflow-hidden">
          {jobs === null && <div className="p-[32px] text-center text-[13px] text-[var(--gray-500)]">Loading jobs…</div>}
          {jobs?.length === 0 && <EmptyState title="No jobs yet" hint="Start one from the Research playground." />}
          {jobs && jobs.length > 0 && (
            <Table head={['job', 'query', 'mode', 'status', 'elapsed']}>
              {jobs.map((job) => (
                <Tr
                  key={job.job_id}
                  className={`cursor-pointer ${selected === job.job_id ? 'bg-[var(--background-200)]' : ''}`}
                  onClick={() => setSelected(job.job_id === selected ? null : job.job_id)}
                >
                  <Td mono className="text-[var(--gray-500)]">{job.job_id.slice(0, 12)}</Td>
                  <Td className="max-w-[240px] truncate">{job.query}</Td>
                  <Td mono>{job.mode}</Td>
                  <Td>
                    <Badge tone={statusTone(job.status)} pulse={ACTIVE.includes(job.status)}>
                      {job.status}
                    </Badge>
                  </Td>
                  <Td mono className="text-[var(--gray-500)]">
                    {job.progress?.elapsed_ms ? `${Math.round(job.progress.elapsed_ms / 1000)}s` : '—'}
                  </Td>
                </Tr>
              ))}
            </Table>
          )}
        </Card>

        {detail && (
          <motion.div initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.2 }}>
            <Card className="p-[16px] flex flex-col gap-[14px]">
              <div className="flex items-center justify-between gap-[8px]">
                <Badge tone={statusTone(detail.status)} pulse={ACTIVE.includes(detail.status)}>{detail.status}</Badge>
                <span className="text-[11px] font-mono text-[var(--gray-500)]">{detail.job_id}</span>
              </div>
              <p className="text-[13px]">{detail.query}</p>

              <div className="grid grid-cols-2 gap-[10px]">
                <Gauge used={detail.progress?.used_search_calls ?? null} limit={detail.progress?.search_calls_limit ?? null} label="Searches" />
                <Gauge used={detail.progress?.used_fetch_calls ?? null} limit={detail.progress?.fetch_calls_limit ?? null} label="Page reads" />
                <Gauge used={detail.progress?.used_tokens ?? null} limit={detail.progress?.token_limit ?? null} label="Tokens" />
                <Gauge
                  used={detail.progress?.elapsed_ms ? Math.round(detail.progress.elapsed_ms / 1000) : null}
                  limit={null}
                  label="Elapsed (s)"
                />
              </div>

              {detail.error && (
                <p className="text-[12px] text-[var(--danger)] border border-[var(--danger)] rounded-[var(--radius-1)] px-[10px] py-[8px]">
                  {detail.error}
                </p>
              )}

              {detail.result && (
                <div className="flex flex-col gap-[8px]">
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-[var(--gray-500)]">Answer</p>
                  <p className="text-[12px] text-[var(--gray-700)] max-h-[180px] overflow-y-auto whitespace-pre-wrap">
                    {detail.result.answer}
                  </p>
                  <p className="text-[11px] font-mono text-[var(--gray-500)]">{detail.result.sources.length} sources</p>
                </div>
              )}

              <div className="flex items-center gap-[8px] pt-[4px] border-t border-[var(--border)]">
                {ACTIVE.includes(detail.status) && (
                  <>
                    <Button size="sm" loading={busy} onClick={() => void act('pause', detail.job_id)}><Pause size={13} />Pause</Button>
                    <Button size="sm" loading={busy} onClick={() => void act('cancel', detail.job_id)}><Ban size={13} />Cancel</Button>
                  </>
                )}
                {detail.status === 'paused' && (
                  <Button size="sm" variant="primary" loading={busy} onClick={() => void act('resume', detail.job_id)}>
                    <Play size={13} />Resume
                  </Button>
                )}
              </div>
            </Card>
          </motion.div>
        )}
      </div>
    </Page>
  );
}

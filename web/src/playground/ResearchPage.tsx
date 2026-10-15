import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Activity,
  Ban,
  BookOpenCheck,
  Globe,
  Hourglass,
  Pause,
  Play,
  Search,
  Sparkles,
} from 'lucide-react';
import { Page } from '../components/Page';
import { Badge, Button, Card, Field, Gauge, Select, Textarea, Tabs, useToast } from '../components/ui';
import {
  ApiError,
  cancelJob,
  getJob,
  pauseJob,
  resumeJob,
  startResearch,
  type JobProgress,
  type JobStatus,
  type PublicJob,
} from '../lib/api';
import { streamEvents } from '../lib/sse';

type Mode = 'instant' | 'default' | 'deep' | 'max';
type Length = 'short' | 'long' | 'exhaustive';
type Verbosity = 'summary' | 'detailed';

interface StepEvent {
  type: string;
  query?: string;
  note?: string;
  model?: string;
  duration_ms?: number;
  result_count?: number;
}

interface ProgressNote {
  headline: string;
  body: string;
  round: number;
}

const stepIcon = (type: string) => {
  if (type === 'search') return Search;
  if (type === 'webpage') return Globe;
  if (type === 'answer') return Sparkles;
  return Activity;
};

/** One line in the event log, already reduced to something readable. */
interface LogEntry {
  key: number;
  /** The event's own type, as the engine published it. */
  type: string;
  /** What happened, in one phrase. */
  summary: string;
  /** The rest of the line: a query, a note body, an error message. */
  detail?: string;
  /** A note from the agent is not a machine event and is styled as one. */
  note?: boolean;
}

/**
 * One event as one readable row.
 *
 * Every event the run publishes is listed, not only the tool calls: the notes
 * the agent writes are the part a person watching actually wants, and they used
 * to appear nowhere in this panel. Tokens are the exception — one row per
 * streamed chunk would bury everything else, so they stay a counter.
 */
function describeEvent(type: string, payload: Record<string, unknown>): LogEntry | null {
  const text = (value: unknown): string | undefined => (typeof value === 'string' && value.length > 0 ? value : undefined);
  switch (type) {
    case 'step': {
      const step = payload as unknown as StepEvent;
      const what = step.type === 'webpage' ? 'page read' : step.type === 'answer' ? 'answer' : step.type;
      const bits: string[] = [];
      if (step.result_count !== undefined) bits.push(`${step.result_count} results`);
      if (step.duration_ms !== undefined) bits.push(`${step.duration_ms}ms`);
      return {
        key: 0,
        type: what,
        summary: [what, ...bits].join(' · '),
        detail: step.note ?? step.query ?? step.model,
      };
    }
    case 'progress_note': {
      const note = payload as unknown as ProgressNote;
      return { key: 0, type: 'note', summary: text(note.headline) ?? 'progress note', detail: text(note.body), note: true };
    }
    case 'sources': {
      const sources = Array.isArray(payload) ? payload : [];
      return { key: 0, type: 'sources', summary: `${sources.length} sources collected` };
    }
    case 'progress':
      return { key: 0, type: 'progress', summary: 'budget updated' };
    case 'status':
      return { key: 0, type: 'status', summary: text(payload.status) ?? 'status' };
    case 'done':
      return { key: 0, type: 'done', summary: 'answer ready' };
    case 'error':
      return { key: 0, type: 'error', summary: text(payload.message) ?? 'error' };
    case 'token':
      return null;
    default:
      return { key: 0, type, summary: type };
  }
}

function statusTone(status: JobStatus): 'neutral' | 'live' | 'ok' | 'warn' | 'danger' {
  if (status === 'running' || status === 'searching' || status === 'planning' || status === 'reviewing' || status === 'synthesizing') return 'live';
  if (status === 'completed') return 'ok';
  if (status === 'queued') return 'neutral';
  if (status === 'failed' || status === 'cancelled') return 'danger';
  return 'warn';
}

function jobActive(status: JobStatus): boolean {
  return ['queued', 'running', 'searching', 'planning', 'reviewing', 'synthesizing'].includes(status);
}

interface SourceLink {
  index: number;
  title: string | null;
  url: string;
}

/** Answer text with [N] citations resolved into chips against the source list. */
function AnswerBody({ answer, sources }: { answer: string; sources: SourceLink[] }) {
  const parts = answer.split(/(\[\d+(?:,\s*\d+)*\])/g);
  return (
    <div className="text-[14px] leading-relaxed">
      {parts.map((part, index) => {
        const match = /^\[(\d+(?:,\s*\d+)*)\]$/.exec(part);
        if (!match) return <span key={index}>{part}</span>;
        const numbers = match[1].split(',').map((value) => Number(value.trim()));
        return (
          <span key={index} className="inline-flex gap-[2px] mx-[1px] align-baseline">
            {numbers.map((number) => {
              const known = sources.some((source) => source.index === number);
              return (
                <a
                  key={number}
                  href={`#source-${number}`}
                  className="inline-flex items-center justify-center min-w-[16px] h-[16px] px-[4px] rounded-[4px] text-[11px] font-mono no-underline"
                  style={{
                    background: known ? 'var(--foreground)' : 'var(--gray-200)',
                    color: known ? 'var(--background)' : 'var(--gray-600)',
                  }}
                  title={sources.find((source) => source.index === number)?.url ?? 'No such source'}
                >
                  {number}
                </a>
              );
            })}
          </span>
        );
      })}
    </div>
  );
}

export function ResearchPage() {
  const toast = useToast();
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<Mode>('deep');
  const [length, setLength] = useState<Length>('long');
  const [verbosity, setVerbosity] = useState<Verbosity>('detailed');

  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<PublicJob | null>(null);
  const [steps, setSteps] = useState<StepEvent[]>([]);
  const [notes, setNotes] = useState<ProgressNote[]>([]);
  /* One row per event, in the order they arrived, of every kind the run
     publishes. The panel is called an event stream, so it shows the stream:
     the notes the agent wrote, the sources it found, the budget it spent —
     not one row per tool call with the rest of the run missing. */
  const [log, setLog] = useState<LogEntry[]>([]);
  const [tokenCount, setTokenCount] = useState(0);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  /* One entry per event, in arrival order. A ref holds the counter so the
     recorder never closes over a stale one. */
  const logKey = useRef(0);
  const record = useCallback((type: string, payload: Record<string, unknown>) => {
    const entry = describeEvent(type, payload);
    if (!entry) return;
    entry.key = ++logKey.current;
    setLog((current) => [...current, entry]);
  }, []);

  /* Snapshot poll: gauges and terminal status even after the stream ends. */
  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const snapshot = await getJob(jobId);
        if (!cancelled) setJob(snapshot);
      } catch {
        /* the stream surfaces real errors; polling stays quiet */
      }
    };
    void poll();
    const timer = setInterval(() => {
      if (!jobActive(job?.status ?? 'queued')) return;
      void poll();
    }, 1500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [jobId, job?.status]);

  /* SSE stream for the job's events, with reconnect semantics left to the
     snapshot poll; the stream itself is single-shot per job. */
  useEffect(() => {
    if (!jobId) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setStreamError(null);
    void streamEvents(`/jobs/${jobId}/events`, {
      signal: controller.signal,
      onEvent: (event) => {
        /* The stream sends the stored event, not the payload: every `data:`
           frame is `{ type, data, timestamp }`. Reading the envelope as if it
           were the payload is what made every row say "step" with nothing in
           it, and the progress notes render as empty cards. */
        const envelope = event.data as { data?: unknown } | null;
        const payload = (envelope && typeof envelope === 'object' && 'data' in envelope ? envelope.data : envelope) as Record<string, unknown>;
        record(event.event, payload);
        if (event.event === 'step') {
          setSteps((current) => [...current, payload as unknown as StepEvent]);
        } else if (event.event === 'progress_note') {
          setNotes((current) => [...current, payload as unknown as ProgressNote]);
        } else if (event.event === 'token') {
          setTokenCount((current) => current + 1);
        } else if (event.event === 'error') {
          setStreamError(typeof payload.message === 'string' ? payload.message : 'The stream reported an error.');
        } else if (event.event === 'done') {
          void getJob(jobId).then(setJob).catch(() => undefined);
        }
      },
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) {
        setStreamError(error instanceof Error ? error.message : 'The event stream ended unexpectedly.');
      }
    });
    return () => controller.abort();
  }, [jobId]);

  const submit = async () => {
    if (!query.trim()) return;
    setStarting(true);
    setJob(null);
    setSteps([]);
    setNotes([]);
    setLog([]);
    setTokenCount(0);
    try {
      const accepted = await startResearch({ query: query.trim(), mode, response_length: mode === 'instant' ? 'short' : length, verbosity });
      setJobId(accepted.job_id);
      /* The snapshot poll fills the rest within a beat; the optimistic echo
         keeps the panel from flashing empty before the first poll lands. */
      setJob({
        job_id: accepted.job_id,
        query: query.trim(),
        mode: accepted.mode,
        status: accepted.status as JobStatus,
        progress: {
          round: null,
          used_search_calls: 0,
          search_calls_limit: 0,
          used_fetch_calls: 0,
          fetch_calls_limit: 0,
          used_turns: null,
          used_tokens: 0,
          token_limit: 0,
          elapsed_ms: null,
        },
      } as PublicJob);
    } catch (error) {
      toast(
        error instanceof ApiError
          ? `${error.code}: ${error.message}`
          : error instanceof Error
            ? error.message
            : 'The research job could not be started.',
        'danger',
      );
    } finally {
      setStarting(false);
    }
  };

  const act = async (action: 'cancel' | 'pause' | 'resume') => {
    if (!jobId) return;
    try {
      const updated = action === 'cancel' ? await cancelJob(jobId) : action === 'pause' ? await pauseJob(jobId) : await resumeJob(jobId);
      setJob(updated);
      toast(action === 'cancel' ? 'Job cancelled.' : action === 'pause' ? 'Job paused; its slot is released.' : 'Job resumed from its checkpoint.');
    } catch (error) {
      toast(error instanceof ApiError ? error.message : 'Action failed.', 'danger');
    }
  };

  const progress: JobProgress | null = job?.progress ?? null;
  const sourceCount = steps.filter((step) => step.type === 'webpage' || step.type === 'search').length;
  const lastStep = steps[steps.length - 1];

  return (
    <Page
      title="Research"
      description="An agentic run that searches, reads pages and answers with inline citations. Watch the budget as the job spends it."
      actions={job && job.status ? <Badge tone={statusTone(job.status)} pulse={jobActive(job.status)}>{job.status}</Badge> : undefined}
    >
      <div className="flex flex-col gap-[16px]">
        <Card className="p-[16px] flex flex-col gap-[14px]">
          <Field label="Question">
            {(id) => (
              <Textarea
                id={id}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Which countries operate digital nomad visas in 2026, and what income do they require?"
                className="min-h-[72px]"
              />
            )}
          </Field>
          <div className="flex flex-wrap items-end gap-[16px]">
            <div className="flex flex-col gap-[6px]">
              <span className="text-[13px] font-medium text-[var(--gray-700)]">Mode</span>
              <Tabs value={mode} onChange={setMode} tabs={[
                { id: 'instant', label: 'instant' },
                { id: 'default', label: 'default' },
                { id: 'deep', label: 'deep' },
                { id: 'max', label: 'max' },
              ]} />
            </div>
            {mode !== 'instant' && (
              <div className="w-[160px]">
                <Field label="Answer length">
                  {(id) => (
                    <Select id={id} value={length} onChange={(event) => setLength(event.target.value as Length)}>
                      <option value="short">short</option>
                      <option value="long">long</option>
                      <option value="exhaustive">exhaustive</option>
                    </Select>
                  )}
                </Field>
              </div>
            )}
            <div className="w-[160px]">
              <Field label="Visibility">
                {(id) => (
                  <Select id={id} value={verbosity} onChange={(event) => setVerbosity(event.target.value as Verbosity)}>
                    <option value="summary">summary</option>
                    <option value="detailed">detailed</option>
                  </Select>
                )}
              </Field>
            </div>
            <Button variant="primary" loading={starting} onClick={() => void submit()} disabled={Boolean(jobActive(job?.status ?? 'completed'))}>
              {starting ? 'Starting…' : 'Start research'}
            </Button>
          </div>
        </Card>

        {!jobId && (
          <Card className="p-[32px] text-center text-[13px] text-[var(--gray-500)]">
            The run starts in the background. This page streams its events, counters and the final answer with its sources.
          </Card>
        )}

        {jobId && (
          <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,340px)] gap-[16px] items-start">
            <div className="flex flex-col gap-[12px] min-w-0">
              <Card className="p-[14px] flex flex-col gap-[12px]">
                <div className="flex flex-wrap items-center justify-between gap-[10px]">
                  <div className="flex items-center gap-[10px] min-w-0">
                    <Badge tone={statusTone(job?.status ?? 'queued')} pulse={jobActive(job?.status ?? 'queued')}>
                      {job?.status ?? 'queued'}
                    </Badge>
                    <span className="text-[12px] font-mono text-[var(--gray-500)] truncate">{jobId}</span>
                  </div>
                  <div className="flex items-center gap-[8px]">
                    {jobActive(job?.status ?? 'queued') && (
                      <>
                        <Button size="sm" onClick={() => void act('pause')}><Pause size={13} />Pause</Button>
                        <Button size="sm" onClick={() => void act('cancel')}><Ban size={13} />Cancel</Button>
                      </>
                    )}
                    {job?.status === 'paused' && (
                      <Button size="sm" variant="primary" onClick={() => void act('resume')}><Play size={13} />Resume</Button>
                    )}
                  </div>
                </div>
                {job?.query && <p className="text-[13px] text-[var(--gray-700)]">{job.query}</p>}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-[12px] pt-[4px]">
                  <Gauge used={progress?.used_search_calls ?? null} limit={progress?.search_calls_limit ?? null} label="Searches" />
                  <Gauge used={progress?.used_fetch_calls ?? null} limit={progress?.fetch_calls_limit ?? null} label="Page reads" />
                  <div className="flex flex-col gap-[5px] min-w-0">
    <span className="text-[12px] text-[var(--gray-600)]">Cost (USD)</span>
    <span className="font-mono tabular-nums text-[12px] text-[var(--gray-700)]">
      {progress?.cost_usd != null ? progress.cost_usd.toFixed(6) : '—'}
    </span>
  </div>
                  <Gauge
                    used={progress?.elapsed_ms ? Math.round(progress.elapsed_ms / 1000) : null}
                    limit={null}
                    label="Elapsed (s)"
                  />
                </div>
              </Card>

              {notes.length > 0 && (
                <div className="flex flex-col gap-[8px]">
                  {notes.map((note, index) => (
                    <motion.div
                      key={`${note.round}-${index}`}
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.24 }}
                    >
                      <Card className="p-[14px] border-l-[3px]!" style={{ borderLeftColor: 'var(--live)' }}>
                        <div className="flex items-baseline justify-between gap-[8px]">
                          <p className="text-[13px] font-semibold">{note.headline}</p>
                          <span className="text-[11px] font-mono text-[var(--gray-500)] shrink-0">round {note.round}</span>
                        </div>
                        <p className="text-[13px] text-[var(--gray-700)] mt-[4px]">{note.body}</p>
                      </Card>
                    </motion.div>
                  ))}
                </div>
              )}

              {job?.error && (
                <Card className="p-[14px] border-[var(--danger)]!">
                  <p className="text-[13px] font-medium text-[var(--danger)]">Run failed</p>
                  <p className="text-[13px] text-[var(--gray-700)] mt-[4px]">{job.error}</p>
                </Card>
              )}
              {streamError && !job?.error && (
                <Card className="p-[14px] border-[var(--warn)]!">
                  <p className="text-[13px] text-[var(--gray-700)]">{streamError}</p>
                </Card>
              )}

              {job?.result && (
                <Card className="overflow-hidden">
                  <div className="flex items-center gap-[8px] px-[16px] py-[12px] border-b border-[var(--border)]">
                    <BookOpenCheck size={15} className="text-[var(--gray-500)]" />
                    <h3 className="text-[14px] font-semibold tracking-tight">Answer</h3>
                  </div>
                  <div className="px-[20px] py-[16px]">
                    <AnswerBody answer={job.result.answer} sources={job.result.sources} />
                    {job.result.sources.length > 0 && (
                      <div className="mt-[16px] pt-[14px] border-t border-[var(--border)] flex flex-col gap-[6px]">
                        <p className="text-[11px] font-semibold uppercase tracking-wider text-[var(--gray-500)]">Sources</p>
                        {job.result.sources.map((source) => (
                          <p key={source.index} id={`source-${source.index}`} className="text-[12px] flex gap-[8px]">
                            <span className="font-mono text-[var(--gray-500)] shrink-0">[{source.index}]</span>
                            <a href={source.url} target="_blank" rel="noreferrer" className="text-[var(--live)] hover:underline truncate">
                              {source.title || source.url}
                            </a>
                          </p>
                        ))}
                      </div>
                    )}
                  </div>
                </Card>
              )}
            </div>

            <div className="flex flex-col gap-[12px]">
              <Card className="p-[14px] flex flex-col gap-[10px]">
                <div className="flex items-center justify-between">
                  <h3 className="text-[13px] font-semibold tracking-tight">Event stream</h3>
                  <span className="text-[11px] font-mono text-[var(--gray-500)]">
                    {log.length} events · {tokenCount} chunks
                  </span>
                </div>
                <div className="flex flex-col max-h-[480px] overflow-y-auto">
                  <AnimatePresence initial={false}>
                    {log.length === 0 && (
                      <p className="text-[12px] text-[var(--gray-500)] py-[12px]">Waiting for the first engine event…</p>
                    )}
                    {log.map((entry) => {
                      const Icon = entry.note ? Sparkles : stepIcon(entry.type);
                      return (
                        <motion.div
                          key={entry.key}
                          layout
                          initial={{ opacity: 0, x: -8 }}
                          animate={{ opacity: 1, x: 0 }}
                          transition={{ duration: 0.18 }}
                          className="flex items-start gap-[8px] py-[8px] border-b border-[var(--border)] last:border-0"
                        >
                          <Icon
                            size={13}
                            className={`mt-[2px] shrink-0 ${entry.note ? 'text-[var(--live)]' : entry.type === 'error' ? 'text-[var(--danger)]' : 'text-[var(--gray-500)]'}`}
                          />
                          <div className="min-w-0 flex-1">
                            <p className="text-[12px] font-mono text-[var(--gray-600)]">{entry.summary}</p>
                            {entry.detail && (
                              <p className={`text-[12px] text-[var(--gray-700)] ${entry.note ? '' : 'truncate'}`}>{entry.detail}</p>
                            )}
                          </div>
                        </motion.div>
                      );
                    })}
                  </AnimatePresence>
                </div>
              </Card>

              <Card className="p-[14px] flex flex-col gap-[8px] text-[12px]">
                <div className="flex items-center gap-[8px] text-[var(--gray-600)]">
                  <Hourglass size={13} />
                  <span>
                    {lastStep ? 'Streaming live' : 'Connecting'} · {sourceCount} provider calls · {notes.length} notes
                  </span>
                </div>
                <p className="text-[var(--gray-500)]">
                  Reconnecting with <span className="font-mono">Last-Event-ID</span> resumes the stream without losing events.
                </p>
              </Card>
            </div>
          </div>
        )}
      </div>
    </Page>
  );
}

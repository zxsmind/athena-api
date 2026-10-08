import { createHash } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { hostHeaderValidation, originValidation } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { isLocalManagementRequest, isLoopbackRequest } from './access.js';
import { isAdminKey } from './admin-auth.js';
import { ApiPlatformStore, publicApiKey, type KeyPlan } from './api-platform-store.js';
import { Meter } from './application/meter.js';
import {
  cancelResearchJob,
  createResearchJob,
  getResearchJob,
  listResearchJobs,
  pauseResearchJob,
  resumeResearchJob,
  subscribeResearchJob,
  type ResearchJobRecord,
} from './research-jobs.js';
import { extractPageContent, searchResults, isSearchProviderConfigured, SearchProviderNotConfiguredError } from './search/index.js';
import { loadSettings } from './settings-store.js';
import { getConfig } from './config/load.js';
import {
  DEFAULT_RESEARCH_MODE,
  RESEARCH_MODES,
  DEFAULT_RESEARCH_VERBOSITY,
  DEFAULT_RESPONSE_LENGTH,
  RESEARCH_VERBOSITIES,
  RESPONSE_LENGTHS,
  resolveResearchPreset,
  reasoningEffortForMode,
} from './engine/modes.js';
import { getModelsDevSnapshot, listConfiguredModelsDevProviders } from './models-dev.js';

const SearchSchema = z.object({
  query: z.string().trim().min(1).max(2000),
  type: z.enum(['search', 'news', 'images', 'videos', 'places', 'shopping', 'scholar', 'patents']).default('search'),
  count: z.number().int().min(1).max(20).default(8),
  country: z.string().trim().regex(/^[a-z]{2}$/i).optional(),
  language: z.string().trim().regex(/^[a-z]{2,3}$/i).optional(),
  time_range: z.enum(['day', 'week', 'month', 'year']).nullable().default(null),
  depth: z.enum(['links', 'passages', 'full']).default('passages'),
  include_domains: z.array(z.string().trim().min(1).max(253)).max(30).default([]),
  exclude_domains: z.array(z.string().trim().min(1).max(253)).max(30).default([]),
});

const ContentsSchema = z.object({
  urls: z.array(z.string().trim().min(1).max(2048)).min(1).max(20),
});

const ResearchSchema = z.object({
  query: z.string().trim().min(1).max(8000),
  mode: z.enum(RESEARCH_MODES).default(DEFAULT_RESEARCH_MODE),
  /** How long the answer should be. Independent of verbosity below. */
  response_length: z.enum(RESPONSE_LENGTHS).default(DEFAULT_RESPONSE_LENGTH),
  /** What the caller sees while the job runs. Does not change the answer. */
  verbosity: z.enum(RESEARCH_VERBOSITIES).default(DEFAULT_RESEARCH_VERBOSITY),
});

const CreateKeySchema = z.object({
  name: z.string().trim().min(1).max(80),
  plan: z.enum(['free', 'paid', 'enterprise']).default('free'),
});

interface ApiV1Dependencies {
  store: ApiPlatformStore;
  startResearchJob: (id: string) => Promise<void> | void;
  /**
   * Shared with the job runner. Both must use the same instance, otherwise the
   * concurrency slot a job reserves at creation is released on a different
   * object and the key stays blocked.
   */
  meter?: Meter;
}

export interface AthenaMcpDependencies {
  usage: Meter;
  apiKeyId: string | null;
  keyPlan: KeyPlan | null;
  startResearchJob: (id: string) => Promise<void> | void;
}

class ApiOperationError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly retryable = status >= 500,
  ) {
    super(message);
    this.name = 'ApiOperationError';
  }
}

function sendError(res: Response, status: number, code: string, message: string, details?: unknown, retryable = status >= 500): void {
  res.status(status).json({
    error: { code, message, ...(details === undefined ? {} : { details }), retryable },
  });
}

function routeTemplate(path: string): string {
  if (/^\/jobs\/[^/]+\/events$/.test(path)) return '/v1/jobs/:id/events';
  if (/^\/jobs\/[^/]+$/.test(path)) return '/v1/jobs/:id';
  if (/^\/jobs\/[^/]+\/(cancel|pause|resume)$/.test(path)) return '/v1/jobs/:id/:action';
  if (/^\/keys\/[^/]+$/.test(path)) return '/v1/keys/:id';
  return `/v1${path === '/' ? '' : path}`;
}

/** One indexed source link. The endpoint serves this and nothing else per source. */
export interface PublicSourceLink {
  index: number;
  title: string | null;
  url: string;
}

export function publicSources(sources: unknown): PublicSourceLink[] {
  if (!Array.isArray(sources)) return [];
  return sources.map((source: Record<string, unknown>, i: number) => ({
    index: typeof source.source_index === 'number' ? source.source_index : i + 1,
    title: typeof source.title === 'string' ? source.title : null,
    url: typeof source.url === 'string' ? source.url : '',
  }));
}

/** Job progress as flat snake_case counters. The persisted runtime holds the
 * engine's live camelCase counters (needed to resume a job); the display
 * snapshot only travels on the event stream. This reads both shapes and emits
 * one: ledgers, epochs, and nulls never leave the process. */
export function publicProgress(runtime: ResearchJobRecord['runtime']): unknown {
  if (!runtime || typeof runtime !== 'object') return runtime;
  const state = runtime as unknown as { round?: unknown; budget?: Record<string, unknown> };
  const budget = state.budget ?? {};
  const num = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;
  const pick = (...keys: string[]): number | null => {
    for (const key of keys) {
      const value = num(budget[key]);
      if (value !== null) return value;
    }
    return null;
  };
  const out: Record<string, number> = {};
  const put = (key: string, value: number | null): void => {
    if (value !== null) out[key] = key === 'used_cpu_seconds' ? Math.round(value / 100) / 10 : value;
  };
  put('round', num(state.round));
  put('used_search_calls', pick('used_search_calls', 'usedSearchCalls'));
  put('search_calls_limit', pick('search_calls_limit'));
  put('used_fetch_calls', pick('used_fetch_calls', 'usedFetchCalls'));
  put('fetch_calls_limit', pick('fetch_calls_limit'));
  put('used_turns', pick('usedTurns'));
  put('used_tokens', pick('used_tokens', 'usedTokens'));
  put('token_limit', pick('token_limit'));
  put('elapsed_ms', pick('elapsed_ms'));
  return out;
}

/** A finished job's payload: the prose answer plus indexed source links. */
export function publicResult(result: ResearchJobRecord['result']): unknown {
  if (!result || typeof result !== 'object') return result;
  const record = result as unknown as Record<string, unknown>;
  return {
    answer: typeof record.answer === 'string' ? record.answer : '',
    sources: publicSources(record.sources),
  };
}

export function publicJob(job: ResearchJobRecord) {
  return {
    job_id: job.id,
    query: job.query,
    mode: job.mode,
    status: job.status,
    created_at: job.createdAt,
    updated_at: job.updatedAt,
    started_at: job.startedAt,
    finished_at: job.finishedAt,
    progress: publicProgress(job.runtime),
    result: publicResult(job.result),
    note: job.note,
    error: job.error,
  };
}

function getApiResearchJob(id: string, apiKeyId?: string | null): ResearchJobRecord | undefined {
  const job = getResearchJob(id);
  if (!job?.researchApi) return undefined;
  return apiKeyId && job.apiKeyId !== apiKeyId ? undefined : job;
}

function streamJobEvents(req: Request, res: Response, jobId: string, apiKeyId?: string | null): void {
  const job = getApiResearchJob(jobId, apiKeyId);
  if (!job) {
    sendError(res, 404, 'NOT_FOUND', 'Research job was not found.');
    return;
  }

  const rawCursor = req.header('Last-Event-ID') ?? String(req.query.after ?? '0');
  const parsedCursor = Number(rawCursor);
  let cursor = Math.max(0, Number.isFinite(parsedCursor) ? parsedCursor : 0);
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let unsubscribe = () => {};

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const close = () => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    unsubscribe();
    res.end();
  };

  const flush = (current: ResearchJobRecord) => {
    if (closed || res.writableEnded) return;
    for (const event of current.events) {
      const eventId = event.seq ?? 0;
      if (eventId <= cursor) continue;
      cursor = eventId;
      if (event.type === 'context') continue;
      try {
        const payload = event.type === 'error' ? { ...event, finalContext: undefined } : event;
        res.write(`id: ${eventId}\nevent: ${event.type}\ndata: ${JSON.stringify(payload)}\n\n`);
      } catch {
        close();
        return;
      }
    }
    if (['completed', 'failed', 'cancelled', 'paused', 'declined'].includes(current.status)) close();
  };

  unsubscribe = subscribeResearchJob(jobId, flush);
  req.on('close', close);
  res.on('error', close);
  flush(job);
  if (!closed) heartbeat = setInterval(() => {
    if (closed || res.writableEnded) return close();
    try { res.write(': keep-alive\n\n'); } catch { close(); }
  }, getConfig().server.sseHeartbeatMs);
}

function requestSignal(req: Request, res: Response): AbortSignal {
  const controller = new AbortController();
  req.once('aborted', () => controller.abort());
  res.once('close', () => {
    if (!res.writableEnded) controller.abort();
  });
  return controller.signal;
}

type SearchInput = z.infer<typeof SearchSchema>;
type ContentsInput = z.infer<typeof ContentsSchema>;
type ResearchInput = z.infer<typeof ResearchSchema>;

async function runSearch(input: SearchInput, signal: AbortSignal | undefined, usage: Meter, apiKeyId: string | null) {
  const started = Date.now();
  const country = input.country ?? getConfig().search.defaultCountry;
  const language = input.language ?? getConfig().search.defaultLanguage;
  try {
    const result = await searchResults(input.query, input.type, signal, input.count, {
      country,
      language,
      timeRange: input.time_range,
      depth: input.depth,
      includeDomains: input.include_domains,
      excludeDomains: input.exclude_domains,
    });
    usage.chargeSearch(apiKeyId);
    return {
      query: input.query,
      query_used: result.queryText,
      type: input.type,
      results: result.results,
      applied: { country, language, time_range: input.time_range, depth: input.depth },
      metadata: { provider: result.provider ?? 'unknown', count: result.results.length, elapsed_ms: Date.now() - started },
    };
  } catch (error: unknown) {
    if (error instanceof SearchProviderNotConfiguredError) {
      throw new ApiOperationError(
        503,
        'SEARCH_NOT_CONFIGURED',
        'No search provider is configured. Add an API key for one of the search providers before searching or starting research.',
        undefined,
        false,
      );
    }
    throw new ApiOperationError(502, 'SEARCH_PROVIDER_ERROR', error instanceof Error ? error.message : 'Search provider failed.');
  }
}

async function runContents(input: ContentsInput, signal: AbortSignal | undefined, usage: Meter, apiKeyId: string | null) {
  const results = await Promise.all(input.urls.map(async (url) => {
    const extracted = await extractPageContent(url, signal);
    if (extracted.error || !extracted.content) return { ok: false as const, url, error: extracted.error ?? 'No readable content found.' };
    return {
      ok: true as const,
      document: {
        url,
        title: extracted.title,
        content: extracted.content,
        content_digest: createHash('sha256').update(extracted.content).digest('hex'),
      },
    };
  }));
  const documents = results.flatMap((result) => result.ok ? [result.document] : []);
  usage.chargeContents(apiKeyId, documents.length);
  return {
    documents,
    failed: results.flatMap((result) => result.ok ? [] : [{ url: result.url, error: result.error }]),
  };
}

interface ResearchContext {
  usage: Meter;
  apiKeyId: string | null;
  keyPlan: KeyPlan | null;
  startResearchJob: (id: string) => Promise<void> | void;
}

function startApiResearch(input: ResearchInput, context: ResearchContext) {
  if (!isSearchProviderConfigured()) {
    throw new ApiOperationError(
      503,
      'SEARCH_NOT_CONFIGURED',
      'No search provider is configured. Add an API key for one of the search providers before searching or starting research.',
      undefined,
      false,
    );
  }
  const reasoningEffort = reasoningEffortForMode(input.mode);
  if (!context.usage.acquireJobSlot(context.apiKeyId, context.keyPlan)) {
    throw new ApiOperationError(429, 'CONCURRENCY_LIMIT', 'Too many research jobs are already running for this key.', {
      max_concurrent_jobs: context.usage.jobSlotLimit(context.keyPlan),
      active_jobs: context.usage.activeJobCount(context.apiKeyId),
    }, false);
  }
  try {
    const job = createResearchJob({
      query: input.query,
      mode: input.mode,
      preset: resolveResearchPreset(input.mode),
      reasoningEffort,
      responseLength: input.response_length,
      verbosity: input.verbosity,
      researchApi: true,
      apiKeyId: context.apiKeyId ?? undefined,
    });
    void Promise.resolve(context.startResearchJob(job.id)).catch((error) => console.error('[api-research-job]', error));
    return { job, reasoningEffort };
  } catch (error: unknown) {
    context.usage.releaseJobSlot(context.apiKeyId);
    throw new ApiOperationError(500, 'JOB_CREATE_FAILED', error instanceof Error ? error.message : 'Research job could not be created.');
  }
}

function researchAccepted(input: ResearchInput, job: ResearchJobRecord, reasoningEffort: string) {
  return {
    job_id: job.id,
    status: 'queued',
    mode: input.mode,
    reasoning_effort: reasoningEffort,
    response_length: input.response_length,
    verbosity: input.verbosity,
    streams: { snapshot: `/v1/jobs/${job.id}`, events: `/v1/jobs/${job.id}/events` },
  };
}

function listApiResearchJobs(limit: number, apiKeyId?: string | null) {
  return listResearchJobs()
    .filter((job) => job.researchApi && (!apiKeyId || job.apiKeyId === apiKeyId))
    .slice(0, limit)
    .map(publicJob);
}

function getPublicApiResearchJob(id: string, apiKeyId?: string | null) {
  const job = getApiResearchJob(id, apiKeyId);
  if (!job) throw new ApiOperationError(404, 'NOT_FOUND', 'Research job was not found.', undefined, false);
  return job;
}

function cancelApiResearchJob(id: string, apiKeyId?: string | null) {
  getPublicApiResearchJob(id, apiKeyId);
  const job = cancelResearchJob(id);
  if (!job) throw new ApiOperationError(404, 'NOT_FOUND', 'Research job was not found.', undefined, false);
  return publicJob(job);
}

function pauseApiResearchJob(id: string, apiKeyId?: string | null) {
  getPublicApiResearchJob(id, apiKeyId);
  const job = pauseResearchJob(id);
  if (!job) throw new ApiOperationError(400, 'JOB_NOT_PAUSABLE', 'Research job cannot be paused in its current state.', undefined, false);
  return publicJob(job);
}

function resumeApiResearchJob(id: string, context: ResearchContext) {
  getPublicApiResearchJob(id, context.apiKeyId);
  if (!context.usage.acquireJobSlot(context.apiKeyId, context.keyPlan)) {
    throw new ApiOperationError(429, 'CONCURRENCY_LIMIT', 'Too many research jobs are already running for this key.', {
      max_concurrent_jobs: context.usage.jobSlotLimit(context.keyPlan),
      active_jobs: context.usage.activeJobCount(context.apiKeyId),
    }, false);
  }
  const job = resumeResearchJob(id);
  if (!job) {
    context.usage.releaseJobSlot(context.apiKeyId);
    throw new ApiOperationError(400, 'JOB_NOT_RESUMABLE', 'Research job cannot be resumed in its current state.', undefined, false);
  }
  void Promise.resolve(context.startResearchJob(job.id)).catch((error) => console.error('[api-research-resume]', error));
  return publicJob(job);
}

function mcpSuccess(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

function mcpFailure(error: unknown, fallbackCode: string) {
  const result = error instanceof ApiOperationError
    ? { code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }), retryable: error.retryable }
    : { code: fallbackCode, message: error instanceof Error ? error.message : 'MCP operation failed.', retryable: true };
  return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: result }) }] };
}

export function createAthenaMcpServer(context: AthenaMcpDependencies): McpServer {
    const server = new McpServer({ name: 'athena', version: '0.1.0' });
    const researchContext: ResearchContext = {
      usage: context.usage,
      apiKeyId: context.apiKeyId,
      keyPlan: context.keyPlan,
      startResearchJob: context.startResearchJob,
    };
    const jobSchema = z.object({ job_id: z.string().trim().min(1).max(128) });
    server.registerTool('athena_search', {
      description: 'Search the web with Athena and return ranked results with provider metadata.',
      inputSchema: SearchSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    }, async (input, ctx) => {
      try { return mcpSuccess(await runSearch(input, ctx.mcpReq.signal, context.usage, context.apiKeyId)); }
      catch (error: unknown) { return mcpFailure(error, 'SEARCH_PROVIDER_ERROR'); }
    });
    server.registerTool('athena_read_contents', {
      description: 'Read and extract the main text from one or more web pages.',
      inputSchema: ContentsSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    }, async (input, ctx) => {
      try { return mcpSuccess(await runContents(input, ctx.mcpReq.signal, context.usage, context.apiKeyId)); }
      catch (error: unknown) { return mcpFailure(error, 'CONTENTS_PROVIDER_ERROR'); }
    });
    server.registerTool('athena_start_research', {
      description: 'Start an Athena research job and return its job_id.',
      inputSchema: ResearchSchema,
      annotations: { openWorldHint: true },
    }, async (input) => {
      try {
        const { job, reasoningEffort } = startApiResearch(input, researchContext);
        return mcpSuccess(researchAccepted(input, job, reasoningEffort));
      } catch (error: unknown) { return mcpFailure(error, 'JOB_CREATE_FAILED'); }
    });
    server.registerTool('athena_list_jobs', {
      description: 'List recent Athena research jobs available to this API key.',
      inputSchema: z.object({ limit: z.number().int().min(1).max(100).default(20) }),
      annotations: { readOnlyHint: true },
    }, async ({ limit }) => mcpSuccess({ jobs: listApiResearchJobs(limit, context.apiKeyId) }));
    server.registerTool('athena_get_job', {
      description: 'Get the status, progress, or result of an Athena research job.',
      inputSchema: jobSchema,
      annotations: { readOnlyHint: true },
    }, async ({ job_id }) => {
      try { return mcpSuccess(publicJob(getPublicApiResearchJob(job_id, context.apiKeyId))); }
      catch (error: unknown) { return mcpFailure(error, 'NOT_FOUND'); }
    });
    server.registerTool('athena_cancel_job', {
      description: 'Cancel an active Athena research job.',
      inputSchema: jobSchema,
      annotations: { destructiveHint: true },
    }, async ({ job_id }) => {
      try { return mcpSuccess(cancelApiResearchJob(job_id, context.apiKeyId)); }
      catch (error: unknown) { return mcpFailure(error, 'NOT_FOUND'); }
    });
    server.registerTool('athena_pause_job', {
      description: 'Pause a running Athena research job.',
      inputSchema: jobSchema,
      /* Neither destructive nor read-only: the job keeps its evidence and can be
         resumed, but it does change job state. A client filtering on hints needs
         to see that, which silence does not tell it. */
      annotations: { openWorldHint: true },
    }, async ({ job_id }) => {
      try { return mcpSuccess(pauseApiResearchJob(job_id, context.apiKeyId)); }
      catch (error: unknown) { return mcpFailure(error, 'JOB_NOT_PAUSABLE'); }
    });
    server.registerTool('athena_resume_job', {
      description: 'Resume a paused Athena research job.',
      inputSchema: jobSchema,
      annotations: { openWorldHint: true },
    }, async ({ job_id }) => {
      try { return mcpSuccess(resumeApiResearchJob(job_id, researchContext)); }
      catch (error: unknown) { return mcpFailure(error, 'JOB_NOT_RESUMABLE'); }
    });
    return server;
}

function createMcpHttpHandler(context: AthenaMcpDependencies) {
  return toNodeHandler(createMcpHandler(() => createAthenaMcpServer(context)));
}

export function createApiV1Router({ store, startResearchJob, meter }: ApiV1Dependencies) {
  const router = Router();
  const usage = meter ?? new Meter(store);
  const mcpAllowedHosts = getConfig().server.mcpAllowedHosts;

  router.use('/mcp', hostHeaderValidation(mcpAllowedHosts), originValidation(mcpAllowedHosts));

  router.use(async (req, res, next) => {
    const startedAt = Date.now();
    let apiKeyId: string | null = null;
    let keyPlan: KeyPlan | null = null;
    const route = routeTemplate(req.path);
    res.once('finish', () => {
      try {
        store.recordRequest({
          at: new Date().toISOString(),
          method: req.method,
          route,
          status: res.statusCode,
          durationMs: Date.now() - startedAt,
          apiKeyId,
        });
      } catch (error) {
        console.error('api analytics write failed:', error instanceof Error ? error.message : String(error));
      }
    });

    const loopback = isLoopbackRequest(req);
    const localManagement = isLocalManagementRequest(req);
    const keyManagement = req.path === '/keys' || req.path.startsWith('/keys/');
    const analyticsManagement = req.path === '/analytics';
    if ((keyManagement || analyticsManagement) && !localManagement) {
      sendError(res, 403, 'LOCAL_MANAGEMENT_ONLY', 'Key management and usage analytics are available from the local network only.');
      return;
    }
    /* Local alone is not enough: anyone on the same private network could
       otherwise mint API keys. Management routes need the admin secret too. */
    if (keyManagement || analyticsManagement) {
      const presented = req.header('x-admin-key');
      if (!isAdminKey(presented)) {
        sendError(res, 401, 'UNAUTHORIZED', 'This route needs the admin key in the X-Admin-Key header.');
        return;
      }
    }

    /* A presented key is always metered, whatever the source address. Presenting
       an invalid one is an error, never a silent downgrade to an anonymous
       request: otherwise a bad token from loopback would be served for free. */
    const token = req.path === '/health' ? null : req.header('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1] ?? null;
    const key = token ? store.findActiveBySecret(token) : null;

    if (req.path !== '/health' && token && !key) {
      sendError(res, 401, 'UNAUTHORIZED', 'The supplied API key is not valid or has been revoked.');
      return;
    }

    if (req.path !== '/health' && !key && !loopback && !((keyManagement || analyticsManagement) && localManagement)) {
      sendError(res, 401, 'UNAUTHORIZED', 'A valid Athena API key is required.');
      return;
    }

    if (key) {
      apiKeyId = key.id;
      keyPlan = key.plan;

      const refusal = usage.admit(key.id, key.plan);
      if (refusal) {
        if (refusal.reason === 'rate_limit') {
          res.setHeader('retry-after', String(refusal.retryAfterSeconds ?? 1));
          sendError(res, 429, 'RATE_LIMITED', 'Request rate exceeded for this plan.', {
            retry_after_seconds: refusal.retryAfterSeconds ?? 1,
          });
          return;
        }
        sendError(res, 429, 'BUDGET_EXHAUSTED', 'Daily credit budget for this key is exhausted.', refusal.balance);
        return;
      }

      store.touchApiKey(key.id);
    }
    res.locals.apiKeyId = apiKeyId;
    res.locals.keyPlan = keyPlan;
    next();
  });

  router.all('/mcp', (req, res) => {
    const mcpHandler = createMcpHttpHandler({
      usage,
      apiKeyId: (res.locals.apiKeyId as string | null) ?? null,
      keyPlan: (res.locals.keyPlan as KeyPlan | null) ?? null,
      startResearchJob,
    });
    void Promise.resolve(mcpHandler(req, res, req.body)).catch((error: unknown) => {
      console.error('[mcp]', error instanceof Error ? error.message : String(error));
      if (res.headersSent) {
        res.end();
        return;
      }
      sendError(res, 500, 'MCP_INTERNAL_ERROR', 'MCP request could not be completed.');
    });
  });

  router.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'athena-api', version: 'v1' });
  });

  router.get('/keys', (_req, res) => {
    res.json({ keys: store.listApiKeys().map(publicApiKey) });
  });

  router.post('/keys', (req, res) => {
    const parsed = CreateKeySchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, 400, 'SCHEMA_VIOLATION', 'Key request did not match the endpoint schema.', parsed.error.issues);
      return;
    }
    try {
      const created = store.createApiKey(parsed.data.name, parsed.data.plan);
      res.status(201).json({ key: publicApiKey(created.record), secret: created.secret });
    } catch (error) {
      sendError(res, 400, 'INVALID_KEY_NAME', error instanceof Error ? error.message : 'Invalid key name.');
    }
  });

  router.delete('/keys/:id', (req, res) => {
    if (!store.revokeApiKey(req.params.id)) {
      sendError(res, 404, 'NOT_FOUND', 'API key was not found or was already revoked.');
      return;
    }
    res.json({ revoked: true });
  });

  router.get('/analytics', (req, res) => {
    const days = Math.max(1, Math.min(90, Math.trunc(Number(req.query.days) || 7)));
    res.json({ window_days: days, generated_at: new Date().toISOString(), ...store.summarize(days) });
  });

  router.get('/models', async (req, res) => {
    try {
      const settings = loadSettings();
      const requested = typeof req.query.provider === 'string' ? req.query.provider : null;
      const snapshot = await getModelsDevSnapshot({ refresh: req.query.refresh === 'true' });
      /* The catalog is the list. Settings only overlay which models of each
         provider are configured, so all 200+ catalog providers are visible
         without any code naming them. */
      const providerIds = requested ? [requested] : Object.keys(snapshot.providers);
      const providers = listConfiguredModelsDevProviders(providerIds)
        .filter((provider) => !requested || provider.id === requested)
        .map((provider) => {
          const configuredModels = new Set(settings.providers[provider.id]?.models ?? []);
          const catalogModels = Object.values(provider.models ?? {});
          const filtered = requested ? catalogModels : catalogModels.filter((model) => configuredModels.has(model.id));
          return {
            id: provider.id,
            name: provider.name,
            npm: provider.npm,
            api: provider.api,
            doc: provider.doc,
            configured_models: [...configuredModels],
            models: filtered.map((model) => ({
              id: model.id,
              name: model.name,
              reasoning: model.reasoning ?? false,
              tool_call: model.tool_call ?? false,
              structured_output: model.structured_output ?? false,
              attachment: model.attachment ?? false,
              context: model.limit?.context,
              max_output: model.limit?.output,
              cost: model.cost,
              release_date: model.release_date,
              last_updated: model.last_updated,
            })),
          };
        });
      res.json({ source: 'models.dev', fetched_at: snapshot.fetchedAt, providers });
    } catch (error) {
      sendError(res, 502, 'MODEL_CATALOG_UNAVAILABLE', error instanceof Error ? error.message : 'Model catalog is unavailable.');
    }
  });

  router.post('/search', async (req, res) => {
    const parsed = SearchSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, 400, 'SCHEMA_VIOLATION', 'Search request did not match the endpoint schema.', parsed.error.issues);
      return;
    }
    const signal = requestSignal(req, res);
    try {
      res.json(await runSearch(parsed.data, signal, usage, (res.locals.apiKeyId as string | null) ?? null));
    } catch (error) {
      if (error instanceof ApiOperationError) {
        sendError(res, error.status, error.code, error.message, error.details, error.retryable);
        return;
      }
      sendError(res, 502, 'SEARCH_PROVIDER_ERROR', error instanceof Error ? error.message : 'Search provider failed.');
    }
  });

  router.post('/contents', async (req, res) => {
    const parsed = ContentsSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, 400, 'SCHEMA_VIOLATION', 'Contents request did not match the endpoint schema.', parsed.error.issues);
      return;
    }
    const result = await runContents(parsed.data, requestSignal(req, res), usage, (res.locals.apiKeyId as string | null) ?? null);
    res.json(result);
  });

  router.post('/research', (req, res) => {
    const parsed = ResearchSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, 400, 'SCHEMA_VIOLATION', 'Research request did not match the endpoint schema.', parsed.error.issues);
      return;
    }
    try {
      const { job, reasoningEffort } = startApiResearch(parsed.data, {
        usage,
        apiKeyId: (res.locals.apiKeyId as string | null) ?? null,
        keyPlan: (res.locals.keyPlan as KeyPlan | null) ?? null,
        startResearchJob,
      });
      res.status(202).json(researchAccepted(parsed.data, job, reasoningEffort));
    } catch (error) {
      if (error instanceof ApiOperationError) {
        sendError(res, error.status, error.code, error.message, error.details, error.retryable);
        return;
      }
      sendError(res, 500, 'JOB_CREATE_FAILED', error instanceof Error ? error.message : 'Research job could not be created.');
    }
  });

  router.get('/jobs', (req, res) => {
    const limit = Math.max(1, Math.min(100, Math.trunc(Number(req.query.limit) || 20)));
    res.json({ jobs: listApiResearchJobs(limit, (res.locals.apiKeyId as string | null) ?? null) });
  });

  router.get('/jobs/:id', (req, res) => {
    try {
      res.json(publicJob(getPublicApiResearchJob(req.params.id, (res.locals.apiKeyId as string | null) ?? null)));
    } catch (error) {
      if (error instanceof ApiOperationError) sendError(res, error.status, error.code, error.message, error.details, error.retryable);
      else sendError(res, 500, 'JOB_READ_FAILED', error instanceof Error ? error.message : 'Research job could not be read.');
    }
  });

  router.get('/jobs/:id/events', (req, res) => streamJobEvents(req, res, req.params.id, (res.locals.apiKeyId as string | null) ?? null));

  router.post('/jobs/:id/cancel', (req, res) => {
    try { res.json(cancelApiResearchJob(req.params.id, (res.locals.apiKeyId as string | null) ?? null)); }
    catch (error) {
      if (error instanceof ApiOperationError) sendError(res, error.status, error.code, error.message, error.details, error.retryable);
      else sendError(res, 500, 'JOB_CANCEL_FAILED', error instanceof Error ? error.message : 'Research job could not be cancelled.');
    }
  });

  router.post('/jobs/:id/pause', (req, res) => {
    try { res.json(pauseApiResearchJob(req.params.id, (res.locals.apiKeyId as string | null) ?? null)); }
    catch (error) {
      if (error instanceof ApiOperationError) sendError(res, error.status, error.code, error.message, error.details, error.retryable);
      else sendError(res, 500, 'JOB_PAUSE_FAILED', error instanceof Error ? error.message : 'Research job could not be paused.');
    }
  });

  router.post('/jobs/:id/resume', (req, res) => {
    try {
      res.json(resumeApiResearchJob(req.params.id, {
        usage,
        apiKeyId: (res.locals.apiKeyId as string | null) ?? null,
        keyPlan: (res.locals.keyPlan as KeyPlan | null) ?? null,
        startResearchJob,
      }));
    } catch (error) {
      if (error instanceof ApiOperationError) sendError(res, error.status, error.code, error.message, error.details, error.retryable);
      else sendError(res, 500, 'JOB_RESUME_FAILED', error instanceof Error ? error.message : 'Research job could not be resumed.');
    }
  });

  return router;
}

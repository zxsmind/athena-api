import { createHash } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
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
  type ResearchMode,
} from './engine/modes.js';
import { getModelsDevSnapshot, listConfiguredModelsDevProviders } from './models-dev.js';

const SearchSchema = z.object({
  query: z.string().trim().min(1).max(2000),
  type: z.enum(['search', 'news', 'images', 'videos', 'places', 'shopping', 'scholar', 'patents']).default('search'),
  count: z.number().int().min(1).max(20).default(8),
  country: z.string().trim().regex(/^[a-z]{2}$/i).default(getConfig().search.defaultCountry),
  language: z.string().trim().regex(/^[a-z]{2,3}$/i).default(getConfig().search.defaultLanguage),
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

function sendError(res: Response, status: number, code: string, message: string, details?: unknown, retryable = status >= 500): void {
  res.status(status).json({
    error: { code, message, ...(details === undefined ? {} : { details }), retryable },
  });
}

function sendSearchNotConfigured(res: Response): void {
  sendError(
    res,
    503,
    'SEARCH_NOT_CONFIGURED',
    'No search provider is configured. Add an API key for one of the search providers before searching or starting research.',
    undefined,
    false,
  );
}

function routeTemplate(path: string): string {
  if (/^\/jobs\/[^/]+\/events$/.test(path)) return '/v1/jobs/:id/events';
  if (/^\/jobs\/[^/]+$/.test(path)) return '/v1/jobs/:id';
  if (/^\/jobs\/[^/]+\/(cancel|pause|resume)$/.test(path)) return '/v1/jobs/:id/:action';
  if (/^\/keys\/[^/]+$/.test(path)) return '/v1/keys/:id';
  return `/v1${path === '/' ? '' : path}`;
}

function publicJob(job: ResearchJobRecord) {
  return {
    job_id: job.id,
    query: job.query,
    mode: job.mode,
      reasoning_effort: job.reasoningEffort,
    verbosity: job.verbosity ?? 'summary',
    status: job.status,
    created_at: job.createdAt,
    updated_at: job.updatedAt,
    started_at: job.startedAt,
    finished_at: job.finishedAt,
    progress: job.runtime,
    result: job.result,
    error: job.error,
  };
}

function getApiResearchJob(id: string): ResearchJobRecord | undefined {
  const job = getResearchJob(id);
  return job?.researchApi ? job : undefined;
}

function streamJobEvents(req: Request, res: Response, jobId: string): void {
  const job = getApiResearchJob(jobId);
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

export function createApiV1Router({ store, startResearchJob, meter }: ApiV1Dependencies) {
  const router = Router();
  const usage = meter ?? new Meter(store);

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
    const input = parsed.data;
    const started = Date.now();
    const signal = requestSignal(req, res);
    try {
      const result = await searchResults(input.query, input.type, signal, input.count, {
        country: input.country,
        language: input.language,
        timeRange: input.time_range,
        depth: input.depth,
        includeDomains: input.include_domains,
        excludeDomains: input.exclude_domains,
      });
      res.json({
        query: input.query,
        query_used: result.queryText,
        type: input.type,
        results: result.results,
        applied: { country: input.country, language: input.language, time_range: input.time_range, depth: input.depth },
        metadata: { provider: result.provider ?? 'unknown', count: result.results.length, elapsed_ms: Date.now() - started },
      });
      usage.chargeSearch((res.locals.apiKeyId as string | null) ?? null);
    } catch (error) {
      if (error instanceof SearchProviderNotConfiguredError) {
        sendSearchNotConfigured(res);
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
    const signal = requestSignal(req, res);
    const results = await Promise.all(parsed.data.urls.map(async (url) => {
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
    res.json({
      documents,
      failed: results.flatMap((result) => result.ok ? [] : [{ url: result.url, error: result.error }]),
    });
    /* Only pages that were actually extracted are billed. */
    usage.chargeContents((res.locals.apiKeyId as string | null) ?? null, documents.length);
  });

  router.post('/research', (req, res) => {
    const parsed = ResearchSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, 400, 'SCHEMA_VIOLATION', 'Research request did not match the endpoint schema.', parsed.error.issues);
      return;
    }
    const input = parsed.data;
    if (!isSearchProviderConfigured()) {
      sendSearchNotConfigured(res);
      return;
    }
    const mode: ResearchMode = input.mode;
    /* Effort is a property of the mode, not something the caller chooses. */
    const reasoningEffort = reasoningEffortForMode(mode);
    const verbosity = input.verbosity;
    const apiKeyId = (res.locals.apiKeyId as string | null) ?? null;
    const keyPlan = (res.locals.keyPlan as KeyPlan | null) ?? null;
    /* A research job holds a concurrency slot for its whole run, so the limit is
       checked before the job is created rather than by the job registry. */
    if (!usage.acquireJobSlot(apiKeyId, keyPlan)) {
      sendError(res, 429, 'CONCURRENCY_LIMIT', 'Too many research jobs are already running for this key.', {
        max_concurrent_jobs: usage.jobSlotLimit(keyPlan),
        active_jobs: usage.activeJobCount(apiKeyId),
      });
      return;
    }
    try {
      const preset = resolveResearchPreset(mode);
      const job = createResearchJob({
        query: input.query,
        mode,
        preset,
        reasoningEffort,
        responseLength: input.response_length,
        verbosity,
        researchApi: true,
        apiKeyId: apiKeyId ?? undefined,
      });
      void Promise.resolve(startResearchJob(job.id)).catch((error) => console.error('[api-research-job]', error));
      res.status(202).json({
        job_id: job.id,
        status: 'queued',
        mode,
        reasoning_effort: reasoningEffort,
        response_length: input.response_length,
        verbosity,
        streams: { snapshot: `/v1/jobs/${job.id}`, events: `/v1/jobs/${job.id}/events` },
      });
    } catch (error) {
      /* The job was never created, so the slot it reserved must go back. */
      usage.releaseJobSlot(apiKeyId);
      sendError(res, 500, 'JOB_CREATE_FAILED', error instanceof Error ? error.message : 'Research job could not be created.');
    }
  });

  router.get('/jobs', (req, res) => {
    const limit = Math.max(1, Math.min(100, Math.trunc(Number(req.query.limit) || 20)));
    res.json({ jobs: listResearchJobs().filter((job) => job.researchApi).slice(0, limit).map(publicJob) });
  });

  router.get('/jobs/:id', (req, res) => {
    const job = getApiResearchJob(req.params.id);
    if (!job) {
      sendError(res, 404, 'NOT_FOUND', 'Research job was not found.');
      return;
    }
    res.json(publicJob(job));
  });

  router.get('/jobs/:id/events', (req, res) => streamJobEvents(req, res, req.params.id));

  router.post('/jobs/:id/cancel', (req, res) => {
    if (!getApiResearchJob(req.params.id)) {
      sendError(res, 404, 'NOT_FOUND', 'Research job was not found.');
      return;
    }
    const job = cancelResearchJob(req.params.id);
    if (!job) {
      sendError(res, 404, 'NOT_FOUND', 'Research job was not found.');
      return;
    }
    res.json(publicJob(job));
  });

  router.post('/jobs/:id/pause', (req, res) => {
    if (!getApiResearchJob(req.params.id)) {
      sendError(res, 404, 'NOT_FOUND', 'Research job was not found.');
      return;
    }
    const job = pauseResearchJob(req.params.id);
    if (!job) {
      sendError(res, 400, 'JOB_NOT_PAUSABLE', 'Research job cannot be paused in its current state.');
      return;
    }
    res.json(publicJob(job));
  });

  router.post('/jobs/:id/resume', (req, res) => {
    if (!getApiResearchJob(req.params.id)) {
      sendError(res, 404, 'NOT_FOUND', 'Research job was not found.');
      return;
    }
    const job = resumeResearchJob(req.params.id);
    if (!job) {
      sendError(res, 400, 'JOB_NOT_RESUMABLE', 'Research job cannot be resumed in its current state.');
      return;
    }
    void Promise.resolve(startResearchJob(job.id)).catch((error) => console.error('[api-research-resume]', error));
    res.json(publicJob(job));
  });

  return router;
}

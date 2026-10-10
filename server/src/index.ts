import express, { type Request, type Response } from 'express';
import cors from 'cors';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ApiPlatformStore } from './api-platform-store.js';
import { createApiV1Router } from './api-v1.js';
import { applyRuntimeLimits, recoverInterruptedResearchJobs, runResearchJob } from './application/research-runner.js';
import { Meter } from './application/meter.js';
import { getConfig, initConfig } from './config/load.js';
import { DATA_DIR, getDataPath, resolvedDataDir } from './storage.js';
import { configureLogger, logger } from './logger.js';
import { assertConfigured, type ConfigAudit } from './startup-guard.js';
import { catalogIntervalMsFromHours, setCatalogRefreshIntervalMs, startCatalogRefresh } from './models-dev.js';
import { retentionWindows, startRetentionSweeper, sweepRetention } from './application/retention.js';
import { enableTrace } from './trace.js';
import { closeAllSandboxes } from './sandbox/manager.js';

/**
 * Composition root. The HTTP surface is exactly `/v1` plus a liveness probe;
 * everything else the product needs lives in `api-v1.ts`.
 */
initConfig(getDataPath('config.yaml'));
configureLogger(getConfig().logging);
/* Opt-in per-job execution trace. Reads the same config, so tracing can be
   turned on without a restart flag. */
if (getConfig().logging.trace) {
  enableTrace({
    maxValueChars: getConfig().logging.traceValueChars,
    maxEventsPerKind: getConfig().logging.traceMaxEventsPerKind,
  });
  logger.info('execution trace enabled', { dir: 'traces' });
}

/* Fails fast and explains itself. Must run before the listener opens, so an
   unconfigured deployment never looks healthy. */
const lastAudit: ConfigAudit = assertConfigured();

/* The models.dev catalog refreshes on a fixed cadence in the background. It
   never blocks a request and never fails the process. */
const catalogIntervalMs = catalogIntervalMsFromHours(getConfig().catalog.refreshIntervalHours);
setCatalogRefreshIntervalMs(catalogIntervalMs);
startCatalogRefresh({
  intervalMs: catalogIntervalMs,
  onEvent: (event) => {
    if (event.type === 'scheduled') {
      logger.info(`models.dev catalog refresh scheduled`, { at: event.at, inMs: event.delayMs });
    } else if (event.type === 'refreshed') {
      logger.info(`models.dev catalog refreshed`, { providers: event.providers });
    } else if (event.type === 'failed') {
      logger.warn(`models.dev catalog refresh failed, keeping the cached snapshot`, { reason: event.reason });
    }
  },
});

const app = express();
app.disable('x-powered-by');

/* CORS is opt-in. Empty (the default) means disabled: a client carrying a
   bearer key does not need CORS at all, so an unset list must never behave as
   "every origin allowed". Each entry is a deliberate public-surface choice. */
if (getConfig().server.corsOrigins.length > 0) {
  app.use(cors({ origin: getConfig().server.corsOrigins }));
}

/* Minimum security headers. There is no HTML surface to defend, so the set is
   deliberately small: nosniff keeps a JSON body from being sniffed as HTML if
   it is ever opened directly, and no-referrer keeps job ids out of the logs of
   any host a client links onward. */
app.use((_req: Request, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

app.use(express.json({ limit: getConfig().server.jsonBodyLimit }));
/* Parser errors use the same JSON contract as the routes, without dumping the
   submitted body or an Express stack trace to the caller. */
app.use(((error, _req, res, next) => {
  if (error?.type === 'entity.parse.failed') {
    res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Request body must be valid JSON.', retryable: false } });
  } else if (error?.type === 'entity.too.large') {
    res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body exceeds the configured limit.', retryable: false } });
  } else {
    next(error);
  }
}) as express.ErrorRequestHandler);

/* Final error handler: an unexpected throw answers in the API's JSON contract,
   not Express's default HTML page, and the detail goes to the log only. */
app.use(((error: unknown, _req: Request, res: Response, next: (err?: unknown) => void) => {
  logger.error('unhandled request error', { error: error instanceof Error ? error.message : String(error) });
  /* Response already streaming: delegate to the default terminal handler,
     which only closes the connection. */
  if (res.headersSent) {
    next(error);
    return;
  }
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.', retryable: true } });
}) as express.ErrorRequestHandler);

/* Data retention from config.yaml: one pass at boot, then hourly. Nothing
   running is ever touched; logs rotate under their own limits. */
const retention = retentionWindows();
sweepRetention(retention.pausedTtlMs, retention.retentionMs, retention.maxDataBytes);
startRetentionSweeper(retention.pausedTtlMs, retention.retentionMs, retention.maxDataBytes);

const apiStore = new ApiPlatformStore();
const meter = new Meter(apiStore);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

/* One Meter for the whole process: the router admits and charges with it, and
   the job runner releases the concurrency slots it took. */
app.use('/v1', createApiV1Router({
  store: apiStore,
  startResearchJob: (jobId: string) => runResearchJob(jobId, meter),
  meter,
}));

app.use('/v1', (_req, res) => {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Unknown API route.', retryable: false } });
});

/* Optional static directory for a future playground; absent in a pure API deploy. */
const publicDir = join(dirname(fileURLToPath(import.meta.url)), 'public');
if (existsSync(publicDir)) {
  app.use(express.static(publicDir, { maxAge: '1d' }));
}

applyRuntimeLimits();
recoverInterruptedResearchJobs();

const server = app.listen(getConfig().server.port, getConfig().server.host, () => {
  const config = getConfig();
  const audit = lastAudit;
  logger.info(`athena listening on http://${config.server.host}:${config.server.port}`);
  logger.info(`data directory ${DATA_DIR} (${resolvedDataDir.reason})`, { providers: audit.providers.length, searchBackends: audit.searches.length });
});

function shutdown(signal: string): void {
  logger.info(`shutdown requested: ${signal}`);
  /* Live code-execution interpreters are child processes; without this they
     outlive the server that owns them. */
  closeAllSandboxes();
  server.close(() => process.exit(0));
  /* Keep-alive SSE streams and slow clients hold the close callback open for
     as long as they stay connected, which a restart must not owe to the
     slowest of them. The exit is therefore bounded. */
  setTimeout(() => process.exit(0), 10_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

import express from 'express';
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
app.use(cors());
app.use(express.json({ limit: getConfig().server.jsonBodyLimit }));

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
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

import { appConfigSchema, type AppConfig } from './schema.js';

/**
 * The single source of default values. Every field appears here; adding a
 * tunable to the schema without a default is a type error by construction.
 */
export const defaultConfig: AppConfig = {
  server: {
    host: '0.0.0.0',
    port: 39921,
    jsonBodyLimit: '1mb',
    sseHeartbeatMs: 15_000,
    trustedProxies: [],
  },
  storage: {
    maxActiveJobs: 50,
    maxActiveBatches: 10,
    maxEventsPerJob: 500,
    maxEventsPerBatch: 500,
    retentionMinutes: 1440,
    sqliteBusyTimeoutMs: 5_000,
  },
  logging: {
    file: 'athena.log',
    maxFileBytes: 10 * 1024 * 1024,
    keepFiles: 3,
    /* Both sinks are on by default: the file gives rotation and history, and
       stdout is what a developer watching `npm run dev` and a container log
       driver actually see. Set this to false for a file-only daemon. */
    echoToStdout: true,
    /* Tracing is opt-in: it records full prompts, reasoning, and fetched page
       content, which is exactly what you want when a run misbehaves and exactly
       what you do not want sitting around on a normal day. */
    trace: false,
    traceValueChars: 4_000,
    traceMaxEventsPerKind: 5_000,
  },
  catalog: {
    refreshIntervalHours: 12,
  },
  search: {
    baseUrl: 'https://google.serper.dev/search',
    requestTimeoutMs: 30_000,
    defaultResultCount: 8,
    defaultCountry: 'us',
    defaultLanguage: 'en',
    fullExtractionLimit: 10,
    extractionContextChars: 3_000,
    extractionSnippetChars: 500,
  },
  research: {
    /* Hard guard, well above the largest mode so it can never be the binding
       limit. `max` alone allows 200 steps. */
    maxTotalTurns: 600,
    /* Tool-call thresholds are scaled per mode in `modes.ts`. These are the
       fallback used when a mode does not state its own. */
    wrapUpToolCalls: 20,
    forceAnswerToolCalls: 30,
    /* Backoff before retrying a failed search or fetch. The last entry is the
       final attempt: after it the call is dropped and the real reason is
       recorded rather than retried forever. */
    retryDelaysMs: [1_000, 2_000, 4_000, 6_000, 10_000],
    maxQueriesPerSearchCall: 12,
    toolWaitHeartbeatMs: 10_000,
    historyMessageLimit: 12,
    snippetPreviewChars: 400,
    stallTimeoutMs: 1_200_000,
  },
  compaction: {
    enabled: false,
    triggerTokens: 60_000,
    keepRecentRounds: 4,
    stateMaxChars: 60_000,
    summaryEnabled: false,
  },
  sandbox: {
    /* Off until the phase gates pass; a job only pays for an interpreter when
       it actually calls run_code. */
    enabled: false,
    backend: 'pyodide',
    timeoutMs: 60_000,
    maxOutputChars: 8_000,
    maxConcurrent: 4,
  },
  report: {
    extractionInputChars: 20_000,
    evidenceSnippetChars: 400,
    claimPassMaxTokens: 4_000,
    defaultSectionHeading: 'Research findings',
  },
  pricing: {
    searchRequest: 0.007,
    contentsPage: 0.001,
    researchSearchCall: 0.007,
    researchFetchCall: 0.001,
    researchCpuSecond: 0.0001,
  },
  plans: {
    free: { dailyCredits: 1, maxBillableTokensPerJob: 600_000, maxConcurrentJobs: 5, overrunCredits: 0.25, requestsPerSecond: 10, requestsPerMinute: 30 },
    paid: { dailyCredits: 50, maxBillableTokensPerJob: 10_000_000, maxConcurrentJobs: 20, overrunCredits: 1, requestsPerSecond: 60, requestsPerMinute: 200 },
    enterprise: { dailyCredits: 500, maxBillableTokensPerJob: null, maxConcurrentJobs: 100, overrunCredits: 5, requestsPerSecond: null, requestsPerMinute: null },
  },
  modes: {
    instant: {
      maxSteps: 8,
      maxSearchCalls: 15,
      maxFetchCalls: 15,
      maxBillableTokens: 200_000,
      maxWallClockMs: 300_000,
      minFetchCalls: 10,
      minSearchCalls: 4,
      wrapUpToolCalls: 8,
      forceAnswerToolCalls: 12,
      minIndependentSources: 2,
      checkpointEverySteps: 0,
    },
    default: {
      maxSteps: 20,
      maxSearchCalls: 40,
      maxFetchCalls: 40,
      maxBillableTokens: 600_000,
      maxWallClockMs: 1_200_000,
      minFetchCalls: 15,
      minSearchCalls: 8,
      wrapUpToolCalls: 20,
      forceAnswerToolCalls: 30,
      minIndependentSources: 2,
      checkpointEverySteps: 0,
    },
    deep: {
      maxSteps: 60,
      maxSearchCalls: 120,
      maxFetchCalls: 120,
      maxBillableTokens: 1_000_000,
      maxWallClockMs: 5_400_000,
      minFetchCalls: 30,
      minSearchCalls: 20,
      wrapUpToolCalls: 60,
      forceAnswerToolCalls: 90,
      minIndependentSources: 3,
      checkpointEverySteps: 2,
    },
    max: {
      maxSteps: 200,
      maxSearchCalls: 400,
      maxFetchCalls: 400,
      maxBillableTokens: 10_000_000,
      maxWallClockMs: 14_400_000,
      minFetchCalls: 80,
      minSearchCalls: 50,
      wrapUpToolCalls: 200,
      forceAnswerToolCalls: 300,
      minIndependentSources: 3,
      checkpointEverySteps: 2,
    },
  },
};

export function validateConfig(input: unknown): AppConfig {
  return appConfigSchema.parse(input);
}

import { z } from 'zod';

/**
 * Every tunable value in Athena lives here. Nothing in the research path may
 * read a tunable from a literal; a value that is not in this schema does not
 * exist. Defaults are declared once, in one place, and are overridable through
 * the config file or environment variables (see `./load.ts`).
 */

const positiveInt = z.number().int().positive();

export const searchConfigSchema = z.object({
  /** Provider endpoint and per-request deadlines. */
  baseUrl: z.string().url(),
  requestTimeoutMs: positiveInt,
  /** Default result count when a request omits one. */
  defaultResultCount: z.number().int().min(1).max(20),
  defaultCountry: z.string().length(2),
  defaultLanguage: z.string().min(2).max(3),
  /** How many results `depth: full` extracts before returning. */
  fullExtractionLimit: positiveInt,
  /** Page payload sizes kept in context and in the source registry. */
  extractionContextChars: positiveInt,
  extractionSnippetChars: positiveInt,
});

export const researchLimitsSchema = z.object({
  /**
   * Hard safety ceiling on model turns for one job. Set well above the largest
   * mode so it is never the binding limit; a mode is meant to stop its own run.
   */
  maxTotalTurns: positiveInt,
  /**
   * Fallback wrap-up threshold, in tool calls. A mode overrides this with its
   * own `wrapUpToolCalls`.
   */
  wrapUpToolCalls: positiveInt,
  /**
   * Fallback force-answer threshold, in tool calls. Past it the model loses its
   * tools and must write an answer. A mode overrides this.
   */
  forceAnswerToolCalls: positiveInt,
  /**
   * Backoff before retrying a failed search or fetch. The engine tries once, then
   * once per delay, then gives up and records the real failure reason. A
   * successful call never waits.
   */
  retryDelaysMs: z.array(positiveInt),
  /** Maximum queries a single web_search call may carry. */
  maxQueriesPerSearchCall: positiveInt,
  /** Search/extract heartbeat cadence while waiting on providers. */
  toolWaitHeartbeatMs: positiveInt,
  /** Chat history window handed to the model. */
  historyMessageLimit: positiveInt,
  /** Snippet preview length inside the ledger. */
  snippetPreviewChars: positiveInt,
  /**
   * Silence after which a running job is declared stalled and failed. Must
   * clear the longest legitimate quiet spell: a single model call can take
   * up to fifteen minutes (exhaustive final answer), so anything below that
   * would kill healthy runs.
   */
  stallTimeoutMs: positiveInt,
});

  /**
   * Lossless offload (Tier 1) plus the summarization tier behind its own flag.
   * All values provisional until tuned on real traces.
   */
export const compactionConfigSchema = z.object({
  /** Master switch. Off means no offload pass, no emergency retry. */
  enabled: z.boolean(),
  /** Absolute usage at which a proactive offload pass runs. */
  triggerTokens: positiveInt,
  /** Newest rounds kept raw, results included. */
  keepRecentRounds: positiveInt,
  /** Gate rejects a merged state larger than this (Tier 2). */
  stateMaxChars: positiveInt,
  /** Summarization tier. Off until Tier 1 is observed sufficient or not. */
  summaryEnabled: z.boolean(),
});

export const sandboxConfigSchema = z.object({
  /** Off by default: the classic tool path is unchanged until a phase gate passes. */
  enabled: z.boolean(),
  /** Only the Pyodide backend ships; Deno was measured in P0 and parked (D2). */
  backend: z.literal('pyodide'),
  /** Wall-clock cap per program. A timed-out run kills the interpreter. */
  timeoutMs: positiveInt,
  /** Ceiling on the tool message a program returns to the model. */
  maxOutputChars: positiveInt,
  /** Simultaneous sandbox executions; the rest queue (D5). */
  maxConcurrent: positiveInt,
});

export const reportConfigSchema = z.object({
  /** Answer text handed to the claim extraction prompt. */
  extractionInputChars: positiveInt,
  /** Snippet length quoted to the extraction prompt. */
  evidenceSnippetChars: positiveInt,
  /** Output token ceiling for the extraction call. */
  claimPassMaxTokens: positiveInt,
  /** Section heading used when the model does not supply one. */
  defaultSectionHeading: z.string().min(1),
});

export const serverConfigSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65_535),
  /** JSON body ceiling for the HTTP API. */
  jsonBodyLimit: z.string().min(2),
  /** SSE keep-alive cadence. */
  sseHeartbeatMs: positiveInt,
  /**
   * Reverse proxies whose X-Forwarded-For the server believes, as IPs or
   * CIDR ranges (`127.0.0.1`, `10.0.0.0/8`). Empty (the default) means the
   * socket peer is always the client: a same-host proxy then looks like
   * loopback and its traffic skips key auth, so only list a proxy here when
   * one actually fronts the server. Anything else must come from its own
   * address, which a spoofed header cannot fake.
   */
  trustedProxies: z.array(z.string().min(1)).default([]),
});

export const storageConfigSchema = z.object({
  maxActiveJobs: positiveInt,
  maxActiveBatches: positiveInt,
  maxEventsPerJob: positiveInt,
  maxEventsPerBatch: positiveInt,
  /** Retention applied to persisted job/event rows. */
  retentionMinutes: positiveInt,
  /** Busy timeout for the SQLite connection. */
  sqliteBusyTimeoutMs: positiveInt,
});

export const catalogConfigSchema = z.object({
  /**
   * How often the models.dev catalog is refreshed in the background, in hours.
   * The refresh is lazy plus scheduled: it never blocks a request, and a failed
   * refresh keeps serving the previous snapshot.
   */
  refreshIntervalHours: positiveInt,
});

export const loggingConfigSchema = z.object({
  /** Destination file, relative to the data directory. */
  file: z.string().min(1),
  /** Hard cap per log file; the writer rotates at this size. */
  maxFileBytes: z.number().int().positive(),
  /** Rotated files kept next to the active one. */
  keepFiles: z.number().int().min(0),
  /**
   * Also echo lines to stdout. On by default so `npm run dev` and container log
   * drivers show something. The file is still written in parallel, and
   * `athena logs` reads it. Turn this off for a file-only daemon.
   */
  echoToStdout: z.boolean(),
  /**
   * Write a per-job JSON Lines execution trace: every provider attempt, tool
   * call, reasoning block and budget event. Off by
   * default, because a trace holds full prompts and fetched page content.
   */
  trace: z.boolean(),
  /** Characters kept per value inside a trace line. */
  traceValueChars: z.number().int().positive(),
  /** Ceiling on events of one kind per job, so a retry loop cannot fill the disk. */
  traceMaxEventsPerKind: z.number().int().positive(),
});

export const pricingConfigSchema = z.object({
  /**
   * One credit is one US dollar. Rates are credits per unit of work.
   * Token cost is not listed here: it is priced per model from the provider
   * catalog, because every model has its own input, cache and output rate.
   */
  searchRequest: z.number().min(0),
  contentsPage: z.number().min(0),
  researchSearchCall: z.number().min(0),
  researchFetchCall: z.number().min(0),
  /** Credits per sandbox execution second. Provisional until measured. */
  researchCpuSecond: z.number().min(0),
});

export const planSchema = z.object({
  /** Daily credit allowance. Credits are US dollars. */
  dailyCredits: z.number().min(0),
  /**
   * Ceiling on billable tokens for a single research job. Null means no plan
   * ceiling, so the mode's own limit applies. A job is charged the lower of this
   * and the mode's `maxBillableTokens`, so a cheap plan cannot buy an expensive
   * run just by asking for it.
   */
  maxBillableTokensPerJob: positiveInt.nullable(),
  /** Ceiling on simultaneous running research jobs. */
  maxConcurrentJobs: z.number().int().min(1),
  /** How far the balance may go negative before new requests are refused. */
  overrunCredits: z.number().min(0),
  /** Sustained request rate. Null means unlimited. */
  requestsPerSecond: z.number().int().min(1).nullable(),
  /** Request ceiling per minute. Null means unlimited. */
  requestsPerMinute: z.number().int().min(1).nullable(),
});

/**
 * What one research mode is allowed to spend, plus the quality bar its prompt
 * asks for. The ceilings are enforced by the engine; the quality flags are
 * instructions injected into the prompt.
 */
export const researchModeConfigSchema = z.object({
  /** LLM rounds the agent may run. */
  maxSteps: positiveInt,
  /** web_search calls. */
  maxSearchCalls: positiveInt,
  /** fetch_url page reads. */
  maxFetchCalls: positiveInt,
  /**
   * Cumulative billable tokens for one job. Cache reads are excluded, because
   * they are re-reads of a prefix the provider already has and cost a fraction
   * of a fresh input token.
   *
   * This is a spend limit, not a context limit. The context is bounded by the
   * model's own window, so a long job legitimately bills far more than its
   * largest prompt.
   */
  maxBillableTokens: positiveInt,
  maxWallClockMs: positiveInt,
  /**
   * Page reads required before an answer is accepted. The engine bounces an
   * early answer with one evidence-floor message back instead of taking it, so
   * a run cannot stop on snippets alone. Set high on purpose: a request with
   * nothing to research exits through decline_request instead of starving
   * below the floor.
   */
  minFetchCalls: z.number().int().min(0),
  /**
   * Search calls required before an answer is accepted. Same gate as page
   * reads: breadth is owed, not just depth. Provisional until measured.
   */
  minSearchCalls: z.number().int().min(0),
  /** Tool calls after which the model is nudged to wrap up. */
  wrapUpToolCalls: positiveInt,
  /** Tool calls after which the model loses its tools and must answer. */
  forceAnswerToolCalls: positiveInt,
  /** Injected into the prompt as the number of sources a key claim needs. */
  minIndependentSources: z.number().int().min(1),
  /** Steps between durable checkpoints. Zero disables checkpointing. */
  checkpointEverySteps: z.number().int().min(0),
});

export const appConfigSchema = z.object({
  server: serverConfigSchema,
  storage: storageConfigSchema,
  logging: loggingConfigSchema,
  catalog: catalogConfigSchema,
  search: searchConfigSchema,
  research: researchLimitsSchema,
  compaction: compactionConfigSchema,
  sandbox: sandboxConfigSchema,
  report: reportConfigSchema,
  pricing: pricingConfigSchema,
  /** Per-plan daily budgets, selected when a key is created. */
  plans: z.record(z.string(), planSchema),
  /**
   * Ceilings and quality bar per research mode. The keys are fixed so a typo in
   * config.yaml fails validation instead of silently falling back.
   */
  modes: z.object({
    instant: researchModeConfigSchema,
    default: researchModeConfigSchema,
    deep: researchModeConfigSchema,
    max: researchModeConfigSchema,
  }),
});

export type ServerConfig = z.infer<typeof serverConfigSchema>;
export type StorageConfig = z.infer<typeof storageConfigSchema>;
export type LoggingConfig = z.infer<typeof loggingConfigSchema>;
export type CatalogConfig = z.infer<typeof catalogConfigSchema>;
export type SearchConfig = z.infer<typeof searchConfigSchema>;
export type ResearchLimits = z.infer<typeof researchLimitsSchema>;
export type CompactionConfig = z.infer<typeof compactionConfigSchema>;
export type SandboxConfig = z.infer<typeof sandboxConfigSchema>;
export type ReportConfig = z.infer<typeof reportConfigSchema>;
export type PricingConfig = z.infer<typeof pricingConfigSchema>;
export type PlanConfig = z.infer<typeof planSchema>;
export type ResearchModeConfig = z.infer<typeof researchModeConfigSchema>;
export type AppConfig = z.infer<typeof appConfigSchema>;

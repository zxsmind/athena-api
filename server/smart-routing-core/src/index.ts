import { randomUUID } from 'node:crypto'

export const SMART_ROUTING_ENGINE_NAME = 'toomanyidiots'
export const SMART_ROUTING_ENGINE_VERSION = '0.5.0'
export const SMART_ROUTING_ENGINE_LABEL = `${SMART_ROUTING_ENGINE_NAME} ${SMART_ROUTING_ENGINE_VERSION}`
export const SMART_ROUTING_SNAPSHOT_VERSION = 2

export type SmartRoutingBudgetMode = 'requests' | 'usd'
export type SmartRoutingBlockedReason =
  | 'cooldown'
  | 'rpm'
  | 'tpm'
  | 'rpd'
  | 'budget-requests'
  | 'budget-usd'
  | 'rate-limit'
  | 'transient-failure'
export type SmartRoutingFailureKind = 'rate-limit' | 'transient-failure' | 'auth' | 'released'
export type SmartRoutingWatchEventKind =
  | 'selected'
  | 'success'
  | 'rate-limit'
  | 'auth-failure'
  | 'transient-failure'
  | 'recovered'
export type QuotaHypothesisKind = 'rpm' | 'tpm' | 'rpd' | 'budget'
export type RecoveryHypothesisSource = 'telemetry' | 'behavioral' | 'mixed'
export type ProbationStatus = 'closed' | 'probation' | 'healthy'
export type QuotaVerificationStatus = 'pending' | 'verified' | 'rejected'
export type QuotaVerificationProbeKind = 'low-request' | 'low-token' | 'day-reset'
export type EvidenceRecordKind =
  | 'selected'
  | 'leased'
  | 'success'
  | 'rate-limit'
  | 'transient-failure'
  | 'auth-failure'
  | 'released'

export interface SmartRoutingEngineRecord {
  name: string
  version: string
  label: string
}

export interface CapacityLimitProfile {
  rpm: number | null
  tpm: number | null
  rpd: number | null
  budgetMode: SmartRoutingBudgetMode
  budgetLimit: number | null
}

export interface RouteScope {
  scopeId: string
  limits: CapacityLimitProfile
}

export interface RouteCandidate {
  routeId: string
  sortKey: string
  rotationGroupId: string
  rotationIndex: number
  scopes: RouteScope[]
}

export interface RouteForecast {
  expectedRequests?: number
  expectedTokens?: number
  expectedCostUsd?: number | null
}

export interface SelectionRequest {
  candidates: RouteCandidate[]
  forecast?: RouteForecast | null
  now?: string | null
  leaseTtlMs?: number | null
  rotationPolicy?: RotationPolicy | null
}

export interface RouteLeaseReservation {
  scopeId: string
  expectedRequests: number
  expectedTokens: number
  expectedCostUsd: number
}

export interface RouteLease {
  id: string
  routeId: string
  sortKey: string
  rotationGroupId: string
  createdAt: string
  expiresAt: string
  routeScopes: RouteScope[]
  reservations: RouteLeaseReservation[]
}

export interface SelectionResult {
  candidate: RouteCandidate
  lease: RouteLease
  score: number
  usableCandidateCount: number
}

export interface CapacityObservationDimension {
  limit?: number | null
  remaining?: number | null
  resetAt?: string | null
  confidence?: number | null
}

export interface CapacityObservationAttribution {
  subjectId: string | null
  subjectLabel: string | null
  viaId: string | null
  viaLabel: string | null
}

export interface CapacityObservation {
  scopeId: string
  source: string
  observedAt: string
  attribution?: CapacityObservationAttribution | null
  request?: CapacityObservationDimension | null
  tokens?: CapacityObservationDimension | null
  dayRequest?: CapacityObservationDimension | null
  retryAfterSeconds?: number | null
}

export interface BehavioralEvidence {
  scopeId: string
  observedAt?: string | null
  requestCount?: number | null
  tokenCount?: number | null
  costUsd?: number | null
  windowMs?: number | null
  correlationKeyCount?: number | null
  correlationRateLimitedCount?: number | null
  detail?: string | null
}

export interface LearnedCapacityDimension {
  limit: number | null
  remaining: number | null
  resetAt: string | null
  observedAt: string | null
  source: string | null
  confidence: number | null
}

export interface LearnedRetryAfterRecord {
  seconds: number | null
  observedAt: string | null
  source: string | null
}

export interface LearnedCapacityProfile {
  request: LearnedCapacityDimension | null
  tokens: LearnedCapacityDimension | null
  dayRequest: LearnedCapacityDimension | null
  retryAfter: LearnedRetryAfterRecord | null
}

export interface SmartRoutingWatchEvent {
  id: string
  kind: SmartRoutingWatchEventKind
  createdAt: string
  detail: string
  nextEligibleAt: string | null
}

export interface EvidenceRecord {
  id: string
  scopeId: string
  rotationGroupId: string
  routeId: string
  leaseId: string | null
  kind: EvidenceRecordKind
  occurredAt: string
  requestCount: number
  tokenCount: number
  costUsd: number
  windowMs: number | null
  correlationKeyCount: number | null
  correlationRateLimitedCount: number | null
  detail: string
}

export interface BurstEpisode {
  id: string
  startedAt: string
  endedAt: string
  requestCount: number
  tokenCount: number
  boundaryKind: Exclude<EvidenceRecordKind, 'selected' | 'leased'>
  windowMs: number
}

export interface QuotaHypothesis {
  kind: QuotaHypothesisKind
  lowerBound: number | null
  upperBound: number | null
  confidence: number
  evidenceWeight: number
  lastUpdatedAt: string | null
  verificationPlan: QuotaVerificationPlan | null
}

export interface QuotaVerificationPlan {
  hypothesisKind: Exclude<QuotaHypothesisKind, 'budget'>
  verifyAfter: string | null
  status: QuotaVerificationStatus
  probeKind: QuotaVerificationProbeKind
  attemptCount: number
  lastAttemptAt: string | null
}

export interface RecoveryHypothesis {
  earliestSafeRetryAt: string | null
  expectedRecoveryWindowMs: number | null
  confidence: number
  source: RecoveryHypothesisSource | null
}

export interface ProbationState {
  status: ProbationStatus
  maxBurstRequests: number | null
  maxBurstTokens: number | null
  escalationLevel: number
  enteredAt: string | null
}

export interface ProviderPressureState {
  rotationGroupId: string
  pressureScore: number
  recentRateLimitCount: number
  recentAffectedRouteCount: number
  confidence: number
  lastUpdatedAt: string | null
}

export interface RouteScopeRuntime {
  scopeId: string
  minuteWindowStartedAt: string | null
  minuteRequestCount: number
  minuteTokenCount: number
  dayWindowStartedAt: string | null
  dayRequestCount: number
  dayUsdTotal: number
  blockedUntil: string | null
  blockedReason: SmartRoutingBlockedReason | null
  nextEligibleAt: string | null
  estimatedMinuteResetAt: string | null
  estimatedDayResetAt: string | null
  availabilityScore: number | null
  lastSelectionReason: string | null
  lastSelectionScore: number | null
  learnedCapacity: LearnedCapacityProfile | null
  lastObservationAttribution: CapacityObservationAttribution | null
  lastUsedAt: string | null
  lastSelectedAt: string | null
  lastRateLimitAt: string | null
  lastAuthFailureAt: string | null
  lastFailureAt: string | null
  lastFailureKind: SmartRoutingFailureKind | null
  consecutiveRateLimitCount: number
  consecutiveTransientFailureCount: number
  quotaHypotheses: Record<QuotaHypothesisKind, QuotaHypothesis>
  recoveryHypothesis: RecoveryHypothesis | null
  probationState: ProbationState | null
  recentBurst: BurstEpisode | null
  watchEvents: SmartRoutingWatchEvent[]
}

export interface RotationGroupRuntime {
  nextRotationIndex: number
  incumbentRotationIndex: number | null
}

export type RotationPolicy = 'balanced' | 'sticky-incumbent'

export interface SmartRoutingEngineSnapshot {
  version: number
  scopes: Record<string, RouteScopeRuntime>
  activeLeases: Record<string, RouteLease>
  rotationGroups: Record<string, RotationGroupRuntime>
  evidenceLedger: EvidenceRecord[]
  providerPressure: Record<string, ProviderPressureState>
}

export interface RouteUsage {
  requests?: number
  tokens?: number
  costUsd?: number | null
}

export interface RouteOutcome {
  leaseId: string
  kind: 'success' | 'rate-limit' | 'transient-failure' | 'auth-failure' | 'released'
  settledAt?: string | null
  usage?: RouteUsage | null
  observations?: CapacityObservation[] | null
  behavioralEvidence?: BehavioralEvidence[] | null
  affectedScopeIds?: string[] | null
  detail?: string | null
}

export interface SelectionAnnotation {
  scopeIds: string[]
  reason: string
  score: number | null
  selectedAt?: string | null
}

export interface SmartRoutingScopeDebugSummary {
  blockedReason: SmartRoutingBlockedReason | null
  nextEligibleAt: string | null
  effectiveLimits: CapacityLimitProfile
  limitSources: {
    rpm: SmartRoutingLimitSource
    tpm: SmartRoutingLimitSource
    rpd: SmartRoutingLimitSource
    budgetLimit: SmartRoutingLimitSource
  }
  quotaHypotheses: Record<QuotaHypothesisKind, QuotaHypothesis>
  recoveryHypothesis: RecoveryHypothesis | null
  probationState: ProbationState | null
  recentBurst: BurstEpisode | null
  availabilityScore: number | null
}

export type SmartRoutingLimitSource = 'manual' | 'learned' | 'verified' | 'inferred' | 'none'

export interface SmartRoutingDebugSummary {
  engine: SmartRoutingEngineRecord
  activeLeaseCount: number
  providerPressure: Record<string, ProviderPressureState>
  scopes: Record<string, SmartRoutingScopeDebugSummary>
}

const DEFAULT_LEASE_TTL_MS = 2 * 60_000
const LEASE_SETTLEMENT_GRACE_MS = 24 * 60 * 60_000
const WATCH_EVENT_LIMIT = 32
const BASE_TRANSIENT_BLOCK_MS = 15_000
const BASE_RATE_LIMIT_BLOCK_MS = 60_000
const MAX_SMART_BLOCK_MS = 15 * 60_000
const EVIDENCE_LEDGER_LIMIT = 512
const BURST_EPISODE_GAP_MS = 2 * 60_000
const PROVIDER_PRESSURE_WINDOW_MS = 2 * 60_000
const INFERENCE_DAY_WINDOW_MS = 24 * 60 * 60_000
const HYPOTHESIS_CONFIDENCE_THRESHOLD = 0.55
const HYPOTHESIS_DOMINANCE_TOLERANCE = 0.05
const PROBATION_SUCCESS_THRESHOLD = 3

function buildEngineRecord(): SmartRoutingEngineRecord {
  return {
    name: SMART_ROUTING_ENGINE_NAME,
    version: SMART_ROUTING_ENGINE_VERSION,
    label: SMART_ROUTING_ENGINE_LABEL,
  }
}

function nowIso() {
  return new Date().toISOString()
}

function toIsoTimestamp(timestamp: number | null) {
  return timestamp != null && Number.isFinite(timestamp) && timestamp > 0
    ? new Date(timestamp).toISOString()
    : null
}

function parseTimestamp(value: string | null | undefined) {
  if (!value) {
    return 0
  }

  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : 0
}

function normalizeNullableNumber(value: unknown) {
  if (value == null || value === '') {
    return null
  }

  const nextValue =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number(value.trim())
        : Number.NaN

  return Number.isFinite(nextValue) ? nextValue : null
}

function normalizePositiveInteger(value: unknown, fallback = 0) {
  const numericValue = normalizeNullableNumber(value)

  if (numericValue == null) {
    return fallback
  }

  return Math.max(0, Math.trunc(numericValue))
}

function createEmptyLimitProfile(): CapacityLimitProfile {
  return {
    rpm: null,
    tpm: null,
    rpd: null,
    budgetMode: 'requests',
    budgetLimit: null,
  }
}

function clampUnit(value: number) {
  if (!Number.isFinite(value)) {
    return 0
  }

  return Math.max(0, Math.min(1, value))
}

function createEmptyQuotaHypothesis(kind: QuotaHypothesisKind): QuotaHypothesis {
  return {
    kind,
    lowerBound: null,
    upperBound: null,
    confidence: 0,
    evidenceWeight: 0,
    lastUpdatedAt: null,
    verificationPlan: null,
  }
}

function createEmptyQuotaHypotheses() {
  return {
    rpm: createEmptyQuotaHypothesis('rpm'),
    tpm: createEmptyQuotaHypothesis('tpm'),
    rpd: createEmptyQuotaHypothesis('rpd'),
    budget: createEmptyQuotaHypothesis('budget'),
  } satisfies Record<QuotaHypothesisKind, QuotaHypothesis>
}

function normalizeLimitProfile(input?: Partial<CapacityLimitProfile> | null): CapacityLimitProfile {
  return {
    rpm: normalizeNullableNumber(input?.rpm),
    tpm: normalizeNullableNumber(input?.tpm),
    rpd: normalizeNullableNumber(input?.rpd),
    budgetMode: input?.budgetMode === 'usd' ? 'usd' : 'requests',
    budgetLimit: normalizeNullableNumber(input?.budgetLimit),
  }
}

function createEmptyScopeRuntime(scopeId: string): RouteScopeRuntime {
  return {
    scopeId,
    minuteWindowStartedAt: null,
    minuteRequestCount: 0,
    minuteTokenCount: 0,
    dayWindowStartedAt: null,
    dayRequestCount: 0,
    dayUsdTotal: 0,
    blockedUntil: null,
    blockedReason: null,
    nextEligibleAt: null,
    estimatedMinuteResetAt: null,
    estimatedDayResetAt: null,
    availabilityScore: null,
    lastSelectionReason: null,
    lastSelectionScore: null,
    learnedCapacity: null,
    lastObservationAttribution: null,
    lastUsedAt: null,
    lastSelectedAt: null,
    lastRateLimitAt: null,
    lastAuthFailureAt: null,
    lastFailureAt: null,
    lastFailureKind: null,
    consecutiveRateLimitCount: 0,
    consecutiveTransientFailureCount: 0,
    quotaHypotheses: createEmptyQuotaHypotheses(),
    recoveryHypothesis: null,
    probationState: null,
    recentBurst: null,
    watchEvents: [],
  }
}

function normalizeObservationAttribution(
  input?: Partial<CapacityObservationAttribution> | null,
): CapacityObservationAttribution | null {
  if (!input) {
    return null
  }

  const attribution: CapacityObservationAttribution = {
    subjectId:
      typeof input.subjectId === 'string' && input.subjectId.trim()
        ? input.subjectId.trim()
        : null,
    subjectLabel:
      typeof input.subjectLabel === 'string' && input.subjectLabel.trim()
        ? input.subjectLabel.trim()
        : null,
    viaId:
      typeof input.viaId === 'string' && input.viaId.trim() ? input.viaId.trim() : null,
    viaLabel:
      typeof input.viaLabel === 'string' && input.viaLabel.trim()
        ? input.viaLabel.trim()
        : null,
  }

  return attribution.subjectId || attribution.subjectLabel || attribution.viaId || attribution.viaLabel
    ? attribution
    : null
}

function normalizeQuotaHypothesis(
  input: Partial<QuotaHypothesis> | null | undefined,
  kind: QuotaHypothesisKind,
): QuotaHypothesis {
  return {
    kind,
    lowerBound: normalizeNullableNumber(input?.lowerBound),
    upperBound: normalizeNullableNumber(input?.upperBound),
    confidence: clampUnit(normalizeNullableNumber(input?.confidence) ?? 0),
    evidenceWeight: Math.max(0, normalizeNullableNumber(input?.evidenceWeight) ?? 0),
    lastUpdatedAt:
      typeof input?.lastUpdatedAt === 'string' && input.lastUpdatedAt.trim()
        ? input.lastUpdatedAt.trim()
        : null,
    verificationPlan:
      kind === 'budget'
        ? null
        : normalizeQuotaVerificationPlan(
            input?.verificationPlan as Partial<QuotaVerificationPlan> | null | undefined,
            kind,
          ),
  }
}

function normalizeQuotaVerificationPlan(
  input: Partial<QuotaVerificationPlan> | null | undefined,
  kind: Exclude<QuotaHypothesisKind, 'budget'>,
): QuotaVerificationPlan | null {
  if (!input) {
    return null
  }

  const probeKind =
    input.probeKind === 'low-token' ||
    input.probeKind === 'day-reset' ||
    input.probeKind === 'low-request'
      ? input.probeKind
      : kind === 'tpm'
        ? 'low-token'
        : kind === 'rpd'
          ? 'day-reset'
          : 'low-request'
  const status =
    input.status === 'verified' || input.status === 'rejected' || input.status === 'pending'
      ? input.status
      : 'pending'

  return {
    hypothesisKind: kind,
    verifyAfter:
      typeof input.verifyAfter === 'string' && input.verifyAfter.trim()
        ? input.verifyAfter.trim()
        : null,
    status,
    probeKind,
    attemptCount: normalizePositiveInteger(input.attemptCount),
    lastAttemptAt:
      typeof input.lastAttemptAt === 'string' && input.lastAttemptAt.trim()
        ? input.lastAttemptAt.trim()
        : null,
  }
}

function normalizeRecoveryHypothesis(
  input?: Partial<RecoveryHypothesis> | null,
): RecoveryHypothesis | null {
  if (!input) {
    return null
  }

  const hypothesis: RecoveryHypothesis = {
    earliestSafeRetryAt:
      typeof input.earliestSafeRetryAt === 'string' && input.earliestSafeRetryAt.trim()
        ? input.earliestSafeRetryAt.trim()
        : null,
    expectedRecoveryWindowMs: normalizeNullableNumber(input.expectedRecoveryWindowMs),
    confidence: clampUnit(normalizeNullableNumber(input.confidence) ?? 0),
    source:
      input.source === 'telemetry' || input.source === 'behavioral' || input.source === 'mixed'
        ? input.source
        : null,
  }

  return hypothesis.earliestSafeRetryAt != null ||
    hypothesis.expectedRecoveryWindowMs != null ||
    hypothesis.confidence > 0 ||
    hypothesis.source != null
    ? hypothesis
    : null
}

function normalizeProbationState(input?: Partial<ProbationState> | null): ProbationState | null {
  if (!input) {
    return null
  }

  const state: ProbationState = {
    status:
      input.status === 'closed' || input.status === 'probation' || input.status === 'healthy'
        ? input.status
        : 'healthy',
    maxBurstRequests: normalizeNullableNumber(input.maxBurstRequests),
    maxBurstTokens: normalizeNullableNumber(input.maxBurstTokens),
    escalationLevel: normalizePositiveInteger(input.escalationLevel),
    enteredAt:
      typeof input.enteredAt === 'string' && input.enteredAt.trim()
        ? input.enteredAt.trim()
        : null,
  }

  return state.enteredAt != null ||
    state.escalationLevel > 0 ||
    state.maxBurstRequests != null ||
    state.maxBurstTokens != null ||
    state.status !== 'healthy'
    ? state
    : null
}

function normalizeBurstEpisode(input?: Partial<BurstEpisode> | null): BurstEpisode | null {
  if (!input) {
    return null
  }

  const boundaryKind =
    input.boundaryKind === 'success' ||
    input.boundaryKind === 'rate-limit' ||
    input.boundaryKind === 'transient-failure' ||
    input.boundaryKind === 'auth-failure' ||
    input.boundaryKind === 'released'
      ? input.boundaryKind
      : null

  if (!boundaryKind) {
    return null
  }

  return {
    id: typeof input.id === 'string' && input.id.trim() ? input.id.trim() : randomUUID(),
    startedAt:
      typeof input.startedAt === 'string' && input.startedAt.trim() ? input.startedAt.trim() : nowIso(),
    endedAt:
      typeof input.endedAt === 'string' && input.endedAt.trim() ? input.endedAt.trim() : nowIso(),
    requestCount: normalizePositiveInteger(input.requestCount),
    tokenCount: normalizePositiveInteger(input.tokenCount),
    boundaryKind,
    windowMs: Math.max(0, normalizeNullableNumber(input.windowMs) ?? 0),
  }
}

function normalizeEvidenceRecord(input?: Partial<EvidenceRecord> | null): EvidenceRecord | null {
  if (!input) {
    return null
  }

  const scopeId = typeof input.scopeId === 'string' && input.scopeId.trim() ? input.scopeId.trim() : ''
  const rotationGroupId =
    typeof input.rotationGroupId === 'string' && input.rotationGroupId.trim()
      ? input.rotationGroupId.trim()
      : ''
  const routeId = typeof input.routeId === 'string' && input.routeId.trim() ? input.routeId.trim() : ''
  const kind =
    input.kind === 'selected' ||
    input.kind === 'leased' ||
    input.kind === 'success' ||
    input.kind === 'rate-limit' ||
    input.kind === 'transient-failure' ||
    input.kind === 'auth-failure' ||
    input.kind === 'released'
      ? input.kind
      : null

  if (!scopeId || !rotationGroupId || !routeId || !kind) {
    return null
  }

  return {
    id: typeof input.id === 'string' && input.id.trim() ? input.id.trim() : randomUUID(),
    scopeId,
    rotationGroupId,
    routeId,
    leaseId: typeof input.leaseId === 'string' && input.leaseId.trim() ? input.leaseId.trim() : null,
    kind,
    occurredAt:
      typeof input.occurredAt === 'string' && input.occurredAt.trim() ? input.occurredAt.trim() : nowIso(),
    requestCount: normalizePositiveInteger(input.requestCount),
    tokenCount: normalizePositiveInteger(input.tokenCount),
    costUsd: Math.max(0, normalizeNullableNumber(input.costUsd) ?? 0),
    windowMs: normalizeNullableNumber(input.windowMs),
    correlationKeyCount: normalizeNullableNumber(input.correlationKeyCount),
    correlationRateLimitedCount: normalizeNullableNumber(input.correlationRateLimitedCount),
    detail: typeof input.detail === 'string' ? input.detail.trim() : '',
  }
}

function normalizeProviderPressureState(
  input?: Partial<ProviderPressureState> | null,
  rotationGroupId?: string,
): ProviderPressureState | null {
  const resolvedGroupId =
    typeof input?.rotationGroupId === 'string' && input.rotationGroupId.trim()
      ? input.rotationGroupId.trim()
      : typeof rotationGroupId === 'string' && rotationGroupId.trim()
        ? rotationGroupId.trim()
        : ''

  if (!resolvedGroupId) {
    return null
  }

  return {
    rotationGroupId: resolvedGroupId,
    pressureScore: clampUnit(normalizeNullableNumber(input?.pressureScore) ?? 0),
    recentRateLimitCount: normalizePositiveInteger(input?.recentRateLimitCount),
    recentAffectedRouteCount: normalizePositiveInteger(input?.recentAffectedRouteCount),
    confidence: clampUnit(normalizeNullableNumber(input?.confidence) ?? 0),
    lastUpdatedAt:
      typeof input?.lastUpdatedAt === 'string' && input.lastUpdatedAt.trim()
        ? input.lastUpdatedAt.trim()
        : null,
  }
}

function normalizeLearnedDimension(
  input?: Partial<LearnedCapacityDimension> | null,
): LearnedCapacityDimension | null {
  if (!input) {
    return null
  }

  const dimension: LearnedCapacityDimension = {
    limit: normalizeNullableNumber(input.limit),
    remaining: normalizeNullableNumber(input.remaining),
    resetAt: typeof input.resetAt === 'string' && input.resetAt.trim() ? input.resetAt.trim() : null,
    observedAt:
      typeof input.observedAt === 'string' && input.observedAt.trim() ? input.observedAt.trim() : null,
    source: typeof input.source === 'string' && input.source.trim() ? input.source.trim() : null,
    confidence: normalizeNullableNumber(input.confidence),
  }

  return (
    dimension.limit != null ||
    dimension.remaining != null ||
    dimension.resetAt != null ||
    dimension.observedAt != null ||
    dimension.source != null ||
    dimension.confidence != null
  )
    ? dimension
    : null
}

function normalizeRetryAfter(
  input?: Partial<LearnedRetryAfterRecord> | null,
): LearnedRetryAfterRecord | null {
  if (!input) {
    return null
  }

  const record: LearnedRetryAfterRecord = {
    seconds: normalizeNullableNumber(input.seconds),
    observedAt:
      typeof input.observedAt === 'string' && input.observedAt.trim() ? input.observedAt.trim() : null,
    source: typeof input.source === 'string' && input.source.trim() ? input.source.trim() : null,
  }

  return record.seconds != null || record.observedAt != null || record.source != null
    ? record
    : null
}

function normalizeLearnedCapacity(
  input?: Partial<LearnedCapacityProfile> | null,
): LearnedCapacityProfile | null {
  if (!input) {
    return null
  }

  const profile: LearnedCapacityProfile = {
    request: normalizeLearnedDimension(input.request),
    tokens: normalizeLearnedDimension(input.tokens),
    dayRequest: normalizeLearnedDimension(input.dayRequest),
    retryAfter: normalizeRetryAfter(input.retryAfter),
  }

  return profile.request || profile.tokens || profile.dayRequest || profile.retryAfter
    ? profile
    : null
}

function normalizeWatchEvents(events: unknown): SmartRoutingWatchEvent[] {
  if (!Array.isArray(events)) {
    return []
  }

  return events
    .map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return null
      }

      const event = entry as Partial<SmartRoutingWatchEvent>
      const kind = event.kind
      const normalizedKind: SmartRoutingWatchEventKind =
        kind === 'selected' ||
        kind === 'success' ||
        kind === 'rate-limit' ||
        kind === 'auth-failure' ||
        kind === 'transient-failure' ||
        kind === 'recovered'
          ? kind
          : 'recovered'
      const detail = typeof event.detail === 'string' ? event.detail.trim() : ''

      if (!detail) {
        return null
      }

      return {
        id: typeof event.id === 'string' && event.id.trim() ? event.id.trim() : randomUUID(),
        kind: normalizedKind,
        createdAt:
          typeof event.createdAt === 'string' && event.createdAt.trim()
            ? event.createdAt.trim()
            : nowIso(),
        detail,
        nextEligibleAt:
          typeof event.nextEligibleAt === 'string' && event.nextEligibleAt.trim()
            ? event.nextEligibleAt.trim()
            : null,
      } satisfies SmartRoutingWatchEvent
    })
    .filter((event): event is SmartRoutingWatchEvent => event != null)
    .slice(-WATCH_EVENT_LIMIT)
}

function normalizeScopeRuntime(input: Partial<RouteScopeRuntime> | null | undefined, scopeId: string) {
  const inputQuotaHypotheses =
    input?.quotaHypotheses && typeof input.quotaHypotheses === 'object' && !Array.isArray(input.quotaHypotheses)
      ? input.quotaHypotheses
      : null

  return {
    ...createEmptyScopeRuntime(scopeId),
    scopeId,
    minuteWindowStartedAt:
      typeof input?.minuteWindowStartedAt === 'string' && input.minuteWindowStartedAt.trim()
        ? input.minuteWindowStartedAt.trim()
        : null,
    minuteRequestCount: normalizePositiveInteger(input?.minuteRequestCount),
    minuteTokenCount: normalizePositiveInteger(input?.minuteTokenCount),
    dayWindowStartedAt:
      typeof input?.dayWindowStartedAt === 'string' && input.dayWindowStartedAt.trim()
        ? input.dayWindowStartedAt.trim()
        : null,
    dayRequestCount: normalizePositiveInteger(input?.dayRequestCount),
    dayUsdTotal: Math.max(0, normalizeNullableNumber(input?.dayUsdTotal) ?? 0),
    blockedUntil:
      typeof input?.blockedUntil === 'string' && input.blockedUntil.trim()
        ? input.blockedUntil.trim()
        : null,
    blockedReason:
      input?.blockedReason === 'cooldown' ||
      input?.blockedReason === 'rpm' ||
      input?.blockedReason === 'tpm' ||
      input?.blockedReason === 'rpd' ||
      input?.blockedReason === 'budget-requests' ||
      input?.blockedReason === 'budget-usd' ||
      input?.blockedReason === 'rate-limit' ||
      input?.blockedReason === 'transient-failure'
        ? input.blockedReason
        : null,
    nextEligibleAt:
      typeof input?.nextEligibleAt === 'string' && input.nextEligibleAt.trim()
        ? input.nextEligibleAt.trim()
        : null,
    estimatedMinuteResetAt:
      typeof input?.estimatedMinuteResetAt === 'string' && input.estimatedMinuteResetAt.trim()
        ? input.estimatedMinuteResetAt.trim()
        : null,
    estimatedDayResetAt:
      typeof input?.estimatedDayResetAt === 'string' && input.estimatedDayResetAt.trim()
        ? input.estimatedDayResetAt.trim()
        : null,
    availabilityScore: normalizeNullableNumber(input?.availabilityScore),
    lastSelectionReason:
      typeof input?.lastSelectionReason === 'string' && input.lastSelectionReason.trim()
        ? input.lastSelectionReason.trim()
        : null,
    lastSelectionScore: normalizeNullableNumber(input?.lastSelectionScore),
    learnedCapacity: normalizeLearnedCapacity(input?.learnedCapacity),
    lastObservationAttribution: normalizeObservationAttribution(input?.lastObservationAttribution),
    lastUsedAt:
      typeof input?.lastUsedAt === 'string' && input.lastUsedAt.trim() ? input.lastUsedAt.trim() : null,
    lastSelectedAt:
      typeof input?.lastSelectedAt === 'string' && input.lastSelectedAt.trim()
        ? input.lastSelectedAt.trim()
        : null,
    lastRateLimitAt:
      typeof input?.lastRateLimitAt === 'string' && input.lastRateLimitAt.trim()
        ? input.lastRateLimitAt.trim()
        : null,
    lastAuthFailureAt:
      typeof input?.lastAuthFailureAt === 'string' && input.lastAuthFailureAt.trim()
        ? input.lastAuthFailureAt.trim()
        : null,
    lastFailureAt:
      typeof input?.lastFailureAt === 'string' && input.lastFailureAt.trim()
        ? input.lastFailureAt.trim()
        : null,
    lastFailureKind:
      input?.lastFailureKind === 'rate-limit' ||
      input?.lastFailureKind === 'transient-failure' ||
      input?.lastFailureKind === 'auth' ||
      input?.lastFailureKind === 'released'
        ? input.lastFailureKind
        : null,
    consecutiveRateLimitCount: normalizePositiveInteger(input?.consecutiveRateLimitCount),
    consecutiveTransientFailureCount: normalizePositiveInteger(input?.consecutiveTransientFailureCount),
    quotaHypotheses: {
      rpm: normalizeQuotaHypothesis(inputQuotaHypotheses?.rpm as Partial<QuotaHypothesis>, 'rpm'),
      tpm: normalizeQuotaHypothesis(inputQuotaHypotheses?.tpm as Partial<QuotaHypothesis>, 'tpm'),
      rpd: normalizeQuotaHypothesis(inputQuotaHypotheses?.rpd as Partial<QuotaHypothesis>, 'rpd'),
      budget: normalizeQuotaHypothesis(inputQuotaHypotheses?.budget as Partial<QuotaHypothesis>, 'budget'),
    },
    recoveryHypothesis: normalizeRecoveryHypothesis(input?.recoveryHypothesis),
    probationState: normalizeProbationState(input?.probationState),
    recentBurst: normalizeBurstEpisode(input?.recentBurst),
    watchEvents: normalizeWatchEvents(input?.watchEvents),
  } satisfies RouteScopeRuntime
}

function normalizeLease(input: Partial<RouteLease> | null | undefined): RouteLease | null {
  if (!input) {
    return null
  }

  const id = typeof input.id === 'string' && input.id.trim() ? input.id.trim() : ''
  const routeId =
    typeof input.routeId === 'string' && input.routeId.trim() ? input.routeId.trim() : ''
  const rotationGroupId =
    typeof input.rotationGroupId === 'string' && input.rotationGroupId.trim()
      ? input.rotationGroupId.trim()
      : ''

  if (!id || !routeId || !rotationGroupId) {
    return null
  }

  const reservations = Array.isArray(input.reservations)
    ? input.reservations
        .map((reservation) => {
          if (!reservation || typeof reservation !== 'object' || Array.isArray(reservation)) {
            return null
          }

          const typedReservation = reservation as Partial<RouteLeaseReservation>
          const scopeId =
            typeof typedReservation.scopeId === 'string' && typedReservation.scopeId.trim()
              ? typedReservation.scopeId.trim()
              : ''

          if (!scopeId) {
            return null
          }

          return {
            scopeId,
            expectedRequests: Math.max(
              0,
              Math.trunc(normalizeNullableNumber(typedReservation.expectedRequests) ?? 0),
            ),
            expectedTokens: Math.max(
              0,
              Math.trunc(normalizeNullableNumber(typedReservation.expectedTokens) ?? 0),
            ),
            expectedCostUsd: Math.max(0, normalizeNullableNumber(typedReservation.expectedCostUsd) ?? 0),
          } satisfies RouteLeaseReservation
        })
        .filter((reservation): reservation is RouteLeaseReservation => reservation != null)
    : []

  if (reservations.length === 0) {
    return null
  }

  return {
    id,
    routeId,
    sortKey: typeof input.sortKey === 'string' && input.sortKey.trim() ? input.sortKey.trim() : routeId,
    rotationGroupId,
    createdAt:
      typeof input.createdAt === 'string' && input.createdAt.trim() ? input.createdAt.trim() : nowIso(),
    expiresAt:
      typeof input.expiresAt === 'string' && input.expiresAt.trim() ? input.expiresAt.trim() : nowIso(),
    routeScopes: Array.isArray(input.routeScopes)
      ? input.routeScopes
          .map((scope) => {
            if (!scope || typeof scope !== 'object' || Array.isArray(scope)) {
              return null
            }

            const typedScope = scope as Partial<RouteScope>
            const scopeId =
              typeof typedScope.scopeId === 'string' && typedScope.scopeId.trim()
                ? typedScope.scopeId.trim()
                : ''

            if (!scopeId) {
              return null
            }

            return {
              scopeId,
              limits: normalizeLimitProfile(typedScope.limits),
            } satisfies RouteScope
          })
          .filter((scope): scope is RouteScope => scope != null)
      : [],
    reservations,
  }
}

export function createEmptySmartRoutingSnapshot(): SmartRoutingEngineSnapshot {
  return {
    version: SMART_ROUTING_SNAPSHOT_VERSION,
    scopes: {},
    activeLeases: {},
    rotationGroups: {},
    evidenceLedger: [],
    providerPressure: {},
  }
}

export function normalizeSmartRoutingSnapshot(
  input?: Partial<SmartRoutingEngineSnapshot> | null,
): SmartRoutingEngineSnapshot {
  const nextSnapshot = createEmptySmartRoutingSnapshot()

  if (!input || typeof input !== 'object') {
    return nextSnapshot
  }

  if (input.scopes && typeof input.scopes === 'object' && !Array.isArray(input.scopes)) {
    for (const [scopeId, runtime] of Object.entries(input.scopes)) {
      nextSnapshot.scopes[scopeId] = normalizeScopeRuntime(
        runtime as Partial<RouteScopeRuntime>,
        scopeId,
      )
    }
  }

  if (
    input.rotationGroups &&
    typeof input.rotationGroups === 'object' &&
    !Array.isArray(input.rotationGroups)
  ) {
    for (const [groupId, runtime] of Object.entries(input.rotationGroups)) {
      const typedRuntime = runtime as Partial<RotationGroupRuntime>
      nextSnapshot.rotationGroups[groupId] = {
        nextRotationIndex: normalizePositiveInteger(typedRuntime.nextRotationIndex),
        incumbentRotationIndex:
          typedRuntime.incumbentRotationIndex == null
            ? null
            : normalizePositiveInteger(typedRuntime.incumbentRotationIndex),
      }
    }
  }

  if (
    input.activeLeases &&
    typeof input.activeLeases === 'object' &&
    !Array.isArray(input.activeLeases)
  ) {
    for (const [leaseId, lease] of Object.entries(input.activeLeases)) {
      const normalizedLease = normalizeLease(lease as Partial<RouteLease>)

      if (normalizedLease) {
        nextSnapshot.activeLeases[leaseId] = normalizedLease
      }
    }
  }

  if (Array.isArray(input.evidenceLedger)) {
    nextSnapshot.evidenceLedger = input.evidenceLedger
      .map((record) => normalizeEvidenceRecord(record as Partial<EvidenceRecord>))
      .filter((record): record is EvidenceRecord => record != null)
      .slice(-EVIDENCE_LEDGER_LIMIT)
  }

  if (
    input.providerPressure &&
    typeof input.providerPressure === 'object' &&
    !Array.isArray(input.providerPressure)
  ) {
    for (const [rotationGroupId, state] of Object.entries(input.providerPressure)) {
      const normalizedState = normalizeProviderPressureState(
        state as Partial<ProviderPressureState>,
        rotationGroupId,
      )

      if (normalizedState) {
        nextSnapshot.providerPressure[rotationGroupId] = normalizedState
      }
    }
  }

  return nextSnapshot
}

export function serializeSmartRoutingSnapshot(
  snapshot: SmartRoutingEngineSnapshot,
): SmartRoutingEngineSnapshot {
  return structuredClone(normalizeSmartRoutingSnapshot(snapshot))
}

function appendWatchEvent(
  runtime: RouteScopeRuntime,
  input: {
    kind: SmartRoutingWatchEventKind
    detail: string
    createdAt: string
    nextEligibleAt?: string | null
  },
) {
  const detail = input.detail.trim()

  if (!detail) {
    return
  }

  runtime.watchEvents = [
    ...runtime.watchEvents,
    {
      id: randomUUID(),
      kind: input.kind,
      createdAt: input.createdAt,
      detail,
      nextEligibleAt: input.nextEligibleAt ?? null,
    },
  ].slice(-WATCH_EVENT_LIMIT)
}

function appendEvidenceRecord(
  snapshot: SmartRoutingEngineSnapshot,
  record: EvidenceRecord,
) {
  snapshot.evidenceLedger = [...snapshot.evidenceLedger, record].slice(-EVIDENCE_LEDGER_LIMIT)
}

function getScopeEvidenceSince(
  snapshot: SmartRoutingEngineSnapshot,
  scopeId: string,
  currentTimestamp: number,
  windowMs: number,
) {
  const threshold = currentTimestamp - windowMs
  return snapshot.evidenceLedger.filter(
    (record) => record.scopeId === scopeId && parseTimestamp(record.occurredAt) >= threshold,
  )
}

function getScopeEvidenceBetween(
  snapshot: SmartRoutingEngineSnapshot,
  scopeId: string,
  sinceTimestamp: number,
  untilTimestamp: number,
) {
  return snapshot.evidenceLedger.filter((record) => {
    const timestamp = parseTimestamp(record.occurredAt)
    return record.scopeId === scopeId && timestamp >= sinceTimestamp && timestamp <= untilTimestamp
  })
}

function sumEvidenceRequests(records: EvidenceRecord[]) {
  return records.reduce((total, record) => total + record.requestCount, 0)
}

function sumEvidenceTokens(records: EvidenceRecord[]) {
  return records.reduce((total, record) => total + record.tokenCount, 0)
}

function updateQuotaHypothesis(
  hypothesis: QuotaHypothesis,
  input: {
    lowerBound?: number | null
    upperBound?: number | null
    confidence: number
    evidenceWeight: number
    observedAt: string
  },
) {
  const lowerBound = normalizeNullableNumber(input.lowerBound)
  const upperBound = normalizeNullableNumber(input.upperBound)

  if (lowerBound != null) {
    hypothesis.lowerBound = Math.max(hypothesis.lowerBound ?? 0, Math.max(0, lowerBound))
  }

  if (upperBound != null) {
    hypothesis.upperBound = chooseMoreConservativeValue(hypothesis.upperBound, Math.max(0, upperBound))
  }

  if (
    hypothesis.upperBound != null &&
    hypothesis.lowerBound != null &&
    hypothesis.lowerBound > hypothesis.upperBound
  ) {
    hypothesis.lowerBound = hypothesis.upperBound
  }

  hypothesis.confidence = clampUnit(
    Math.max(hypothesis.confidence, normalizeNullableNumber(input.confidence) ?? 0),
  )
  hypothesis.evidenceWeight = Math.max(
    hypothesis.evidenceWeight,
    normalizeNullableNumber(input.evidenceWeight) ?? 0,
  )
  hypothesis.lastUpdatedAt = input.observedAt
}

function getInferredQuotaLimit(hypothesis: QuotaHypothesis) {
  if (hypothesis.confidence < HYPOTHESIS_CONFIDENCE_THRESHOLD) {
    return null
  }

  return hypothesis.lowerBound
}

function isDominantQuotaHypothesis(
  runtime: RouteScopeRuntime,
  kind: Exclude<QuotaHypothesisKind, 'budget'>,
) {
  const hypothesis = runtime.quotaHypotheses[kind]
  const strongestConfidence = Math.max(
    runtime.quotaHypotheses.rpm.confidence,
    runtime.quotaHypotheses.tpm.confidence,
    runtime.quotaHypotheses.rpd.confidence,
  )

  return hypothesis.confidence + HYPOTHESIS_DOMINANCE_TOLERANCE >= strongestConfidence
}

function getActionableInferredQuotaLimit(
  runtime: RouteScopeRuntime,
  kind: Exclude<QuotaHypothesisKind, 'budget'>,
) {
  const hypothesis = runtime.quotaHypotheses[kind]
  const limit = getInferredQuotaLimit(hypothesis)

  if (limit == null) {
    return null
  }

  if (!isDominantQuotaHypothesis(runtime, kind)) {
    return null
  }

  const verificationPlan = hypothesis.verificationPlan

  if (verificationPlan?.status === 'rejected') {
    return null
  }

  if (verificationPlan?.status === 'verified') {
    return limit
  }

  if (verificationPlan?.status === 'pending') {
    return runtime.probationState?.status === 'probation' || runtime.lastFailureKind === 'rate-limit'
      ? limit
      : null
  }

  return limit
}

function resolveQuotaVerificationProbeKind(
  kind: Exclude<QuotaHypothesisKind, 'budget'>,
): QuotaVerificationProbeKind {
  if (kind === 'tpm') {
    return 'low-token'
  }

  if (kind === 'rpd') {
    return 'day-reset'
  }

  return 'low-request'
}

function resolveQuotaVerificationTimestamp(
  runtime: RouteScopeRuntime,
  kind: Exclude<QuotaHypothesisKind, 'budget'>,
  settledAt: string,
) {
  const settledTimestamp = parseTimestamp(settledAt)
  const learnedReset =
    kind === 'rpm'
      ? runtime.learnedCapacity?.request?.resetAt
      : kind === 'tpm'
        ? runtime.learnedCapacity?.tokens?.resetAt
        : runtime.learnedCapacity?.dayRequest?.resetAt
  const learnedResetTimestamp = parseTimestamp(learnedReset)

  if (learnedResetTimestamp > settledTimestamp) {
    return learnedReset ?? null
  }

  const inferredResetTimestamp =
    kind === 'rpd'
      ? getNextDayWindowTimestamp(runtime.dayWindowStartedAt ?? settledAt)
      : getNextMinuteWindowTimestamp(runtime.minuteWindowStartedAt ?? settledAt)

  if (inferredResetTimestamp > settledTimestamp) {
    return toIsoTimestamp(inferredResetTimestamp)
  }

  if (settledTimestamp <= 0) {
    return null
  }

  return toIsoTimestamp(settledTimestamp + (kind === 'rpd' ? 24 * 60 * 60_000 : 60_000))
}

function refreshQuotaVerificationPlans(runtime: RouteScopeRuntime, settledAt: string) {
  for (const kind of ['rpm', 'tpm', 'rpd'] satisfies Array<Exclude<QuotaHypothesisKind, 'budget'>>) {
    const hypothesis = runtime.quotaHypotheses[kind]

    if (
      hypothesis.confidence < HYPOTHESIS_CONFIDENCE_THRESHOLD ||
      hypothesis.lowerBound == null ||
      !isDominantQuotaHypothesis(runtime, kind)
    ) {
      continue
    }

    if (hypothesis.verificationPlan?.status === 'verified') {
      continue
    }

    hypothesis.verificationPlan = {
      hypothesisKind: kind,
      verifyAfter: resolveQuotaVerificationTimestamp(runtime, kind, settledAt),
      status: 'pending',
      probeKind: resolveQuotaVerificationProbeKind(kind),
      attemptCount: Math.max(1, (hypothesis.verificationPlan?.attemptCount ?? 0) + 1),
      lastAttemptAt: settledAt,
    }
  }
}

function settleDueQuotaVerificationPlans(
  runtime: RouteScopeRuntime,
  settledAt: string,
  status: Exclude<QuotaVerificationStatus, 'pending'>,
) {
  const settledTimestamp = parseTimestamp(settledAt)

  if (settledTimestamp <= 0) {
    return
  }

  for (const kind of ['rpm', 'tpm', 'rpd'] satisfies Array<Exclude<QuotaHypothesisKind, 'budget'>>) {
    const hypothesis = runtime.quotaHypotheses[kind]
    const verificationPlan = hypothesis.verificationPlan

    if (verificationPlan?.status !== 'pending') {
      continue
    }

    const verifyAfterTimestamp = parseTimestamp(verificationPlan.verifyAfter)

    if (verifyAfterTimestamp <= 0 || settledTimestamp < verifyAfterTimestamp) {
      continue
    }

    hypothesis.verificationPlan = {
      ...verificationPlan,
      status,
      lastAttemptAt: settledAt,
    }
    hypothesis.confidence = clampUnit(
      status === 'verified' ? hypothesis.confidence + 0.15 : hypothesis.confidence - 0.15,
    )
    hypothesis.lastUpdatedAt = settledAt
  }
}

function inferBurstEpisode(
  snapshot: SmartRoutingEngineSnapshot,
  scopeId: string,
  currentAt: string,
  boundaryKind: Exclude<EvidenceRecordKind, 'selected' | 'leased'>,
) {
  const currentTimestamp = parseTimestamp(currentAt)
  const evidence = getScopeEvidenceSince(snapshot, scopeId, currentTimestamp, BURST_EPISODE_GAP_MS)
    .filter((record) => record.kind !== 'selected' && record.kind !== 'leased')
    .sort((left, right) => parseTimestamp(left.occurredAt) - parseTimestamp(right.occurredAt))

  if (evidence.length === 0) {
    return null
  }

  const startedAt = evidence[0]!.occurredAt
  const endedAt = evidence[evidence.length - 1]!.occurredAt

  return {
    id: randomUUID(),
    startedAt,
    endedAt,
    requestCount: sumEvidenceRequests(evidence),
    tokenCount: sumEvidenceTokens(evidence),
    boundaryKind,
    windowMs: Math.max(0, parseTimestamp(endedAt) - parseTimestamp(startedAt)),
  } satisfies BurstEpisode
}

function inferProviderPressure(
  snapshot: SmartRoutingEngineSnapshot,
  rotationGroupId: string,
  currentAt: string,
) {
  const currentTimestamp = parseTimestamp(currentAt)
  const threshold = currentTimestamp - PROVIDER_PRESSURE_WINDOW_MS
  const recentRateLimits = snapshot.evidenceLedger.filter((record) => {
    const timestamp = parseTimestamp(record.occurredAt)
    return (
      record.rotationGroupId === rotationGroupId &&
      record.kind === 'rate-limit' &&
      timestamp >= threshold &&
      timestamp <= currentTimestamp
    )
  })
  const recentRoutes = new Set(
    snapshot.evidenceLedger
      .filter((record) => {
        const timestamp = parseTimestamp(record.occurredAt)
        return (
          record.rotationGroupId === rotationGroupId &&
          timestamp >= threshold &&
          timestamp <= currentTimestamp
        )
      })
      .map((record) => record.routeId),
  )
  const affectedRouteCount = new Set(recentRateLimits.map((record) => record.routeId)).size
  const pressureScore = clampUnit(
    (affectedRouteCount / Math.max(1, recentRoutes.size)) * 0.7 +
      Math.min(recentRateLimits.length / 5, 1) * 0.3,
  )
  const confidence = clampUnit(
    (affectedRouteCount / Math.max(1, recentRoutes.size)) * 0.8 +
      Math.min(recentRateLimits.length / 3, 1) * 0.2,
  )

  snapshot.providerPressure[rotationGroupId] = {
    rotationGroupId,
    pressureScore,
    recentRateLimitCount: recentRateLimits.length,
    recentAffectedRouteCount: affectedRouteCount,
    confidence,
    lastUpdatedAt: currentAt,
  }
}

function inferBehavioralHypotheses(
  runtime: RouteScopeRuntime,
  snapshot: SmartRoutingEngineSnapshot,
  input: {
    scopeId: string
    settledAt: string
    usage: ReturnType<typeof normalizeForecast>
    rateLimited: boolean
  },
) {
  const currentTimestamp = parseTimestamp(input.settledAt)
  const minuteEvidence = getScopeEvidenceSince(snapshot, input.scopeId, currentTimestamp, 60_000).filter(
    (record) => record.kind === 'success' || record.kind === 'rate-limit',
  )
  const dayEvidence = getScopeEvidenceSince(
    snapshot,
    input.scopeId,
    currentTimestamp,
    INFERENCE_DAY_WINDOW_MS,
  ).filter((record) => record.kind === 'success' || record.kind === 'rate-limit')
  const minuteRequests = sumEvidenceRequests(minuteEvidence)
  const minuteTokens = sumEvidenceTokens(minuteEvidence)
  const dayRequests = sumEvidenceRequests(dayEvidence)
  const dayTokens = sumEvidenceTokens(dayEvidence)
  const minuteShare = minuteRequests / Math.max(1, dayRequests)
  const tokenShare = minuteTokens / Math.max(1, dayTokens)

  if (input.rateLimited) {
    settleDueQuotaVerificationPlans(runtime, input.settledAt, 'rejected')

    const rpmConfidence = clampUnit(0.15 + minuteShare * 0.65 + Math.min(minuteRequests / 10, 1) * 0.2)
    const rpdConfidence = clampUnit(
      0.15 + (1 - minuteShare) * 0.55 + Math.min(dayRequests / 10, 1) * 0.3,
    )
    const tpmConfidence = minuteTokens > 0
      ? clampUnit(0.1 + tokenShare * 0.55 + Math.min(minuteTokens / 60_000, 1) * 0.35)
      : 0

    updateQuotaHypothesis(runtime.quotaHypotheses.rpm, {
      lowerBound: Math.max(1, minuteRequests - input.usage.expectedRequests),
      upperBound: minuteRequests,
      confidence: rpmConfidence,
      evidenceWeight: minuteRequests,
      observedAt: input.settledAt,
    })
    updateQuotaHypothesis(runtime.quotaHypotheses.rpd, {
      lowerBound: Math.max(1, dayRequests - input.usage.expectedRequests),
      upperBound: dayRequests,
      confidence: rpdConfidence,
      evidenceWeight: dayRequests,
      observedAt: input.settledAt,
    })

    if (minuteTokens > 0) {
      updateQuotaHypothesis(runtime.quotaHypotheses.tpm, {
        lowerBound: Math.max(1, minuteTokens - input.usage.expectedTokens),
        upperBound: minuteTokens,
        confidence: tpmConfidence,
        evidenceWeight: minuteTokens,
        observedAt: input.settledAt,
      })
    }

    refreshQuotaVerificationPlans(runtime, input.settledAt)
  } else {
    settleDueQuotaVerificationPlans(runtime, input.settledAt, 'verified')
  }

  if (runtime.lastRateLimitAt) {
    const lastRateLimitTimestamp = parseTimestamp(runtime.lastRateLimitAt)

    if (lastRateLimitTimestamp > 0 && currentTimestamp > lastRateLimitTimestamp) {
      const observedRecoveryWindowMs = currentTimestamp - lastRateLimitTimestamp
      const currentRecoveryWindow = normalizeNullableNumber(
        runtime.recoveryHypothesis?.expectedRecoveryWindowMs,
      )
      runtime.recoveryHypothesis = {
        earliestSafeRetryAt: input.settledAt,
        expectedRecoveryWindowMs:
          currentRecoveryWindow == null
            ? observedRecoveryWindowMs
            : Math.max(currentRecoveryWindow, observedRecoveryWindowMs),
        confidence: clampUnit((runtime.recoveryHypothesis?.confidence ?? 0.2) + 0.15),
        source:
          runtime.recoveryHypothesis?.source === 'telemetry' ? 'mixed' : 'behavioral',
      }
    }
  }
}

function updateProbationState(
  runtime: RouteScopeRuntime,
  snapshot: SmartRoutingEngineSnapshot,
  input: {
    scopeId: string
    settledAt: string
    usage: ReturnType<typeof normalizeForecast>
    kind: RouteOutcome['kind']
  },
) {
  if (input.kind === 'rate-limit') {
    const actionableRpm = getActionableInferredQuotaLimit(runtime, 'rpm')
    const actionableTpm = getActionableInferredQuotaLimit(runtime, 'tpm')

    runtime.probationState = {
      status: 'probation',
      maxBurstRequests:
        actionableRpm ??
        (actionableTpm == null ? Math.max(1, input.usage.expectedRequests) : null),
      maxBurstTokens:
        actionableTpm ??
        (actionableRpm == null && input.usage.expectedTokens > 0
          ? input.usage.expectedTokens
          : null),
      escalationLevel: (runtime.probationState?.escalationLevel ?? 0) + 1,
      enteredAt: input.settledAt,
    }
    return
  }

  if (input.kind !== 'success' || runtime.probationState?.status !== 'probation') {
    return
  }

  const enteredAt = parseTimestamp(runtime.probationState.enteredAt)
  const successesSinceProbation =
    enteredAt > 0
      ? getScopeEvidenceBetween(snapshot, input.scopeId, enteredAt, parseTimestamp(input.settledAt)).filter(
          (record) => record.kind === 'success',
        ).length
      : 0

  if (successesSinceProbation >= PROBATION_SUCCESS_THRESHOLD) {
    runtime.probationState = {
      ...runtime.probationState,
      status: 'healthy',
    }
  }
}

function getAdaptiveBlockMs(baseMs: number, failureCount: number) {
  const exponent = Math.max(0, Math.min(failureCount - 1, 4))
  return Math.min(baseMs * 2 ** exponent, MAX_SMART_BLOCK_MS)
}

function resetMinuteWindowIfNeeded(runtime: RouteScopeRuntime, currentDate: Date) {
  const currentMinuteBucket = currentDate.toISOString().slice(0, 16)
  const runtimeMinuteBucket = runtime.minuteWindowStartedAt?.slice(0, 16)

  if (runtimeMinuteBucket === currentMinuteBucket) {
    return
  }

  runtime.minuteWindowStartedAt = currentDate.toISOString()
  runtime.minuteRequestCount = 0
  runtime.minuteTokenCount = 0
}

function resetDayWindowIfNeeded(runtime: RouteScopeRuntime, currentDate: Date) {
  const currentDayBucket = currentDate.toISOString().slice(0, 10)
  const runtimeDayBucket = runtime.dayWindowStartedAt?.slice(0, 10) ?? null

  if (runtimeDayBucket === currentDayBucket) {
    return
  }

  runtime.dayWindowStartedAt = currentDate.toISOString()
  runtime.dayRequestCount = 0
  runtime.dayUsdTotal = 0
}

function getNextMinuteWindowTimestamp(startedAt: string | null | undefined) {
  if (!startedAt) {
    return 0
  }

  const nextWindowDate = new Date(startedAt)

  if (Number.isNaN(nextWindowDate.getTime())) {
    return 0
  }

  nextWindowDate.setUTCSeconds(0, 0)
  nextWindowDate.setUTCMinutes(nextWindowDate.getUTCMinutes() + 1)
  return nextWindowDate.getTime()
}

function getNextDayWindowTimestamp(startedAt: string | null | undefined) {
  if (!startedAt) {
    return 0
  }

  const nextWindowDate = new Date(startedAt)

  if (Number.isNaN(nextWindowDate.getTime())) {
    return 0
  }

  nextWindowDate.setUTCHours(0, 0, 0, 0)
  nextWindowDate.setUTCDate(nextWindowDate.getUTCDate() + 1)
  return nextWindowDate.getTime()
}

function normalizeForecast(input?: RouteForecast | RouteUsage | null) {
  const forecastLike = input as (RouteForecast & RouteUsage) | null | undefined
  return {
    expectedRequests: Math.max(
      1,
      Math.trunc(
        normalizeNullableNumber(forecastLike?.expectedRequests ?? forecastLike?.requests) ?? 1,
      ),
    ),
    expectedTokens: Math.max(
      0,
      Math.trunc(
        normalizeNullableNumber(forecastLike?.expectedTokens ?? forecastLike?.tokens) ?? 0,
      ),
    ),
    expectedCostUsd: Math.max(
      0,
      normalizeNullableNumber(forecastLike?.expectedCostUsd ?? forecastLike?.costUsd) ?? 0,
    ),
  }
}

function getRemainingRatio(limit: number | null, currentValue: number) {
  if (limit == null || limit <= 0) {
    return 1
  }

  return Math.max(0, (limit - currentValue) / limit)
}

function chooseMoreConservativeValue(currentValue: number | null, nextValue: number | null) {
  if (currentValue == null) {
    return nextValue
  }

  if (nextValue == null) {
    return currentValue
  }

  return Math.min(currentValue, nextValue)
}

function chooseLaterTimestamp(
  currentValue: string | null | undefined,
  nextValue: string | null | undefined,
) {
  const currentTimestamp = parseTimestamp(currentValue ?? null)
  const nextTimestamp = parseTimestamp(nextValue ?? null)

  if (currentTimestamp <= 0) {
    return nextValue ?? null
  }

  if (nextTimestamp <= 0) {
    return currentValue ?? null
  }

  return nextTimestamp >= currentTimestamp ? nextValue ?? null : currentValue ?? null
}

function mergeLearnedDimension(
  currentValue: LearnedCapacityDimension | null,
  observation: CapacityObservationDimension | null | undefined,
  source: string,
  observedAt: string,
) {
  if (!observation) {
    return currentValue
  }

  const limit = normalizeNullableNumber(observation.limit)
  const remaining = normalizeNullableNumber(observation.remaining)
  const confidence = normalizeNullableNumber(observation.confidence)
  const resetAt =
    typeof observation.resetAt === 'string' && observation.resetAt.trim()
      ? observation.resetAt.trim()
      : null

  if (limit == null && remaining == null && resetAt == null && confidence == null) {
    return currentValue
  }

  return {
    limit: chooseMoreConservativeValue(currentValue?.limit ?? null, limit),
    remaining: chooseMoreConservativeValue(currentValue?.remaining ?? null, remaining),
    resetAt: chooseLaterTimestamp(currentValue?.resetAt ?? null, resetAt),
    observedAt: chooseLaterTimestamp(currentValue?.observedAt ?? null, observedAt),
    source: source.trim() || (currentValue?.source ?? null),
    confidence: Math.max(currentValue?.confidence ?? 0, confidence ?? 0) || null,
  } satisfies LearnedCapacityDimension
}

function ensureLearnedCapacity(runtime: RouteScopeRuntime) {
  if (runtime.learnedCapacity) {
    return runtime.learnedCapacity
  }

  runtime.learnedCapacity = {
    request: null,
    tokens: null,
    dayRequest: null,
    retryAfter: null,
  }
  return runtime.learnedCapacity
}

function applyCapacityObservation(runtime: RouteScopeRuntime, observation: CapacityObservation) {
  const learnedCapacity = ensureLearnedCapacity(runtime)
  const observationAttribution = normalizeObservationAttribution(observation.attribution)

  if (observationAttribution) {
    runtime.lastObservationAttribution = observationAttribution
  }

  learnedCapacity.request = mergeLearnedDimension(
    learnedCapacity.request,
    observation.request,
    observation.source,
    observation.observedAt,
  )
  learnedCapacity.tokens = mergeLearnedDimension(
    learnedCapacity.tokens,
    observation.tokens,
    observation.source,
    observation.observedAt,
  )
  learnedCapacity.dayRequest = mergeLearnedDimension(
    learnedCapacity.dayRequest,
    observation.dayRequest,
    observation.source,
    observation.observedAt,
  )

  if (normalizeNullableNumber(observation.retryAfterSeconds) != null) {
    const nextSeconds = Math.max(0, normalizeNullableNumber(observation.retryAfterSeconds) ?? 0)
    const currentSeconds = learnedCapacity.retryAfter?.seconds ?? null
    const currentObservedAt = learnedCapacity.retryAfter?.observedAt ?? null

    learnedCapacity.retryAfter = {
      seconds: currentSeconds == null ? nextSeconds : Math.max(currentSeconds, nextSeconds),
      observedAt: chooseLaterTimestamp(currentObservedAt, observation.observedAt),
      source: observation.source.trim() || (learnedCapacity.retryAfter?.source ?? null),
    }
  }

  if (learnedCapacity.request?.limit != null && learnedCapacity.request.remaining != null) {
    runtime.minuteRequestCount = Math.max(
      runtime.minuteRequestCount,
      Math.max(0, learnedCapacity.request.limit - learnedCapacity.request.remaining),
    )
  }

  if (learnedCapacity.tokens?.limit != null && learnedCapacity.tokens.remaining != null) {
    runtime.minuteTokenCount = Math.max(
      runtime.minuteTokenCount,
      Math.max(0, learnedCapacity.tokens.limit - learnedCapacity.tokens.remaining),
    )
  }

  if (learnedCapacity.dayRequest?.limit != null && learnedCapacity.dayRequest.remaining != null) {
    runtime.dayRequestCount = Math.max(
      runtime.dayRequestCount,
      Math.max(0, learnedCapacity.dayRequest.limit - learnedCapacity.dayRequest.remaining),
    )
  }

  runtime.estimatedMinuteResetAt = chooseLaterTimestamp(
    runtime.estimatedMinuteResetAt,
    learnedCapacity.request?.resetAt ?? learnedCapacity.tokens?.resetAt ?? null,
  )
  runtime.estimatedDayResetAt = chooseLaterTimestamp(
    runtime.estimatedDayResetAt,
    learnedCapacity.dayRequest?.resetAt ?? null,
  )
}

function hasAuthoritativeUsageObservation(
  observation: CapacityObservationDimension | null | undefined,
) {
  return (
    normalizeNullableNumber(observation?.limit) != null &&
    normalizeNullableNumber(observation?.remaining) != null
  )
}

function collectAuthoritativeObservationDimensions(observations: CapacityObservation[]) {
  const dimensionsByScope = new Map<
    string,
    { request: boolean; tokens: boolean; dayRequest: boolean }
  >()

  for (const observation of observations) {
    const current = dimensionsByScope.get(observation.scopeId) ?? {
      request: false,
      tokens: false,
      dayRequest: false,
    }

    current.request =
      current.request || hasAuthoritativeUsageObservation(observation.request)
    current.tokens = current.tokens || hasAuthoritativeUsageObservation(observation.tokens)
    current.dayRequest =
      current.dayRequest || hasAuthoritativeUsageObservation(observation.dayRequest)

    dimensionsByScope.set(observation.scopeId, current)
  }

  return dimensionsByScope
}

function resolveEffectiveLimit(configuredValue: number | null, learnedValue: number | null) {
  if (configuredValue == null) {
    return learnedValue
  }

  if (learnedValue == null) {
    return configuredValue
  }

  return Math.min(configuredValue, learnedValue)
}

function resolveConfiguredOrAutomaticLimit(
  configuredValue: number | null,
  learnedValue: number | null,
  inferredValue: number | null,
) {
  if (configuredValue != null) {
    return configuredValue
  }

  return resolveEffectiveLimit(learnedValue, inferredValue)
}

function resolveEffectiveLimits(limits: CapacityLimitProfile, runtime: RouteScopeRuntime) {
  const learnedCapacity = runtime.learnedCapacity

  return {
    rpm: resolveConfiguredOrAutomaticLimit(
      limits.rpm,
      learnedCapacity?.request?.limit ?? null,
      getActionableInferredQuotaLimit(runtime, 'rpm'),
    ),
    tpm: resolveConfiguredOrAutomaticLimit(
      limits.tpm,
      learnedCapacity?.tokens?.limit ?? null,
      getActionableInferredQuotaLimit(runtime, 'tpm'),
    ),
    rpd: resolveConfiguredOrAutomaticLimit(
      limits.rpd,
      learnedCapacity?.dayRequest?.limit ?? null,
      getActionableInferredQuotaLimit(runtime, 'rpd'),
    ),
    budgetMode: limits.budgetMode,
    budgetLimit: resolveConfiguredOrAutomaticLimit(
      limits.budgetLimit,
      null,
      getInferredQuotaLimit(runtime.quotaHypotheses.budget),
    ),
  } satisfies CapacityLimitProfile
}

function resolveAutomaticLimitSource(
  runtime: RouteScopeRuntime,
  kind: Exclude<QuotaHypothesisKind, 'budget'>,
): SmartRoutingLimitSource {
  const learnedCapacity = runtime.learnedCapacity
  const learnedLimit =
    kind === 'rpm'
      ? learnedCapacity?.request?.limit
      : kind === 'tpm'
        ? learnedCapacity?.tokens?.limit
        : learnedCapacity?.dayRequest?.limit

  if (learnedLimit != null) {
    return 'learned'
  }

  if (getActionableInferredQuotaLimit(runtime, kind) == null) {
    return 'none'
  }

  return runtime.quotaHypotheses[kind].verificationPlan?.status === 'verified'
    ? 'verified'
    : 'inferred'
}

function resolveAutomaticBudgetLimitSource(runtime: RouteScopeRuntime): SmartRoutingLimitSource {
  return getInferredQuotaLimit(runtime.quotaHypotheses.budget) == null ? 'none' : 'inferred'
}

function isLeaseExpired(lease: RouteLease, currentTimestamp: number) {
  return parseTimestamp(lease.expiresAt) <= currentTimestamp
}

function getReservationsByScope(snapshot: SmartRoutingEngineSnapshot, currentTimestamp: number) {
  const reservationsByScope = new Map<
    string,
    { expectedRequests: number; expectedTokens: number; expectedCostUsd: number }
  >()

  for (const lease of Object.values(snapshot.activeLeases)) {
    if (isLeaseExpired(lease, currentTimestamp)) {
      continue
    }

    for (const reservation of lease.reservations) {
      const currentReservation = reservationsByScope.get(reservation.scopeId) ?? {
        expectedRequests: 0,
        expectedTokens: 0,
        expectedCostUsd: 0,
      }

      currentReservation.expectedRequests += reservation.expectedRequests
      currentReservation.expectedTokens += reservation.expectedTokens
      currentReservation.expectedCostUsd += reservation.expectedCostUsd
      reservationsByScope.set(reservation.scopeId, currentReservation)
    }
  }

  return reservationsByScope
}

function resolveLearnedResetTimestamp(runtime: RouteScopeRuntime, reason: SmartRoutingBlockedReason) {
  if (runtime.recoveryHypothesis?.earliestSafeRetryAt) {
    return runtime.recoveryHypothesis.earliestSafeRetryAt
  }

  if (reason === 'rpm') {
    return runtime.learnedCapacity?.request?.resetAt ?? null
  }

  if (reason === 'tpm') {
    return runtime.learnedCapacity?.tokens?.resetAt ?? null
  }

  if (reason === 'rpd' || reason === 'budget-requests') {
    return runtime.learnedCapacity?.dayRequest?.resetAt ?? null
  }
          
  if (reason === 'rate-limit') {
    const retryAfterRecord = runtime.learnedCapacity?.retryAfter
    const retryAfterTimestamp =
      retryAfterRecord?.seconds != null
        ? parseTimestamp(retryAfterRecord.observedAt) + retryAfterRecord.seconds * 1000
        : 0

    if (retryAfterTimestamp > 0 && retryAfterRecord?.observedAt != null) {
      return new Date(retryAfterTimestamp).toISOString()
    }

    return (
      runtime.learnedCapacity?.request?.resetAt ??
      runtime.learnedCapacity?.tokens?.resetAt ??
      runtime.learnedCapacity?.dayRequest?.resetAt ??
      null
    )
  }

  return null
}

function getRotationDistance(
  candidateRotationIndex: number,
  nextRotationIndex: number,
  orderedRotationIndices: number[],
) {
  if (orderedRotationIndices.length === 0) {
    return 0
  }

  const sortedIndices = orderedRotationIndices.slice().sort((left, right) => left - right)
  const candidatePosition = sortedIndices.indexOf(candidateRotationIndex)

  if (candidatePosition < 0) {
    return sortedIndices.length
  }

  const anchorPosition = sortedIndices.findIndex((value) => value >= nextRotationIndex)

  return (candidatePosition - (anchorPosition >= 0 ? anchorPosition : 0) + sortedIndices.length) % sortedIndices.length
}

function normalizeRotationPolicy(input: RotationPolicy | null | undefined): RotationPolicy {
  return input === 'sticky-incumbent' ? 'sticky-incumbent' : 'balanced'
}

function isIncumbentRotationIndex(
  candidateRotationIndex: number,
  incumbentRotationIndex: number | null | undefined,
) {
  return incumbentRotationIndex != null && candidateRotationIndex === incumbentRotationIndex
}

function computeAvailabilityScore(input: {
  limits: CapacityLimitProfile
  runtime: RouteScopeRuntime
  reservations: { expectedRequests: number; expectedTokens: number; expectedCostUsd: number }
  forecast: ReturnType<typeof normalizeForecast>
  currentTimestamp: number
}) {
  const projectedMinuteRequests =
    input.runtime.minuteRequestCount +
    input.reservations.expectedRequests +
    input.forecast.expectedRequests
  const projectedMinuteTokens =
    input.runtime.minuteTokenCount +
    input.reservations.expectedTokens +
    input.forecast.expectedTokens
  const projectedDayRequests =
    input.runtime.dayRequestCount +
    input.reservations.expectedRequests +
    input.forecast.expectedRequests
  const projectedDayUsd =
    input.runtime.dayUsdTotal +
    input.reservations.expectedCostUsd +
    input.forecast.expectedCostUsd

  const resetPenaltyTarget = Math.max(
    parseTimestamp(input.runtime.nextEligibleAt),
    parseTimestamp(input.runtime.estimatedMinuteResetAt),
    parseTimestamp(input.runtime.estimatedDayResetAt),
  )
  const resetPenalty =
    resetPenaltyTarget > input.currentTimestamp
      ? Math.min((resetPenaltyTarget - input.currentTimestamp) / 60_000, 5) * 0.05
      : 0

  return (
    getRemainingRatio(input.limits.rpm, projectedMinuteRequests) +
    getRemainingRatio(input.limits.tpm, projectedMinuteTokens) +
    getRemainingRatio(input.limits.rpd, projectedDayRequests) +
    getRemainingRatio(
      input.limits.budgetMode === 'requests' ? input.limits.budgetLimit : null,
      projectedDayRequests,
    ) +
    getRemainingRatio(
      input.limits.budgetMode === 'usd' ? input.limits.budgetLimit : null,
      projectedDayUsd,
    ) -
    input.runtime.consecutiveRateLimitCount * 0.4 -
    input.runtime.consecutiveTransientFailureCount * 0.25 -
    resetPenalty
  )
}

function inferRateLimitRecoveryTimestamp(
  limits: CapacityLimitProfile,
  runtime: RouteScopeRuntime,
  nowTimestamp: number,
) {
  const candidateTimestamps: number[] = []

  for (const timestampText of [
    resolveLearnedResetTimestamp(runtime, 'rate-limit'),
    runtime.learnedCapacity?.request?.resetAt ?? null,
    runtime.learnedCapacity?.tokens?.resetAt ?? null,
    runtime.learnedCapacity?.dayRequest?.resetAt ?? null,
  ]) {
    const timestamp = parseTimestamp(timestampText)

    if (timestamp > nowTimestamp) {
      candidateTimestamps.push(timestamp)
    }
  }

  if ((limits.rpm != null || limits.tpm != null) && runtime.minuteWindowStartedAt) {
    const nextMinuteTimestamp = getNextMinuteWindowTimestamp(runtime.minuteWindowStartedAt)

    if (nextMinuteTimestamp > nowTimestamp) {
      candidateTimestamps.push(nextMinuteTimestamp)
    }
  }

  if ((limits.rpd != null || limits.budgetLimit != null) && runtime.dayWindowStartedAt) {
    const nextDayTimestamp = getNextDayWindowTimestamp(runtime.dayWindowStartedAt)

    if (nextDayTimestamp > nowTimestamp) {
      candidateTimestamps.push(nextDayTimestamp)
    }
  }

  if (candidateTimestamps.length > 0) {
    return Math.max(...candidateTimestamps)
  }

  return nowTimestamp + getAdaptiveBlockMs(BASE_RATE_LIMIT_BLOCK_MS, runtime.consecutiveRateLimitCount + 1)
}

function inferTransientRecoveryTimestamp(runtime: RouteScopeRuntime, nowTimestamp: number) {
  return (
    nowTimestamp +
    getAdaptiveBlockMs(
      BASE_TRANSIENT_BLOCK_MS,
      runtime.consecutiveTransientFailureCount + 1,
    )
  )
}

class SmartRoutingEngine {
  private snapshot: SmartRoutingEngineSnapshot
  readonly engine: SmartRoutingEngineRecord

  constructor(snapshot?: Partial<SmartRoutingEngineSnapshot> | null) {
    this.engine = buildEngineRecord()
    this.snapshot = normalizeSmartRoutingSnapshot(snapshot)
  }

  getSnapshot() {
    return serializeSmartRoutingSnapshot(this.snapshot)
  }

  private ensureScopeRuntime(scopeId: string) {
    const existingScope = this.snapshot.scopes[scopeId]

    if (existingScope) {
      return existingScope
    }

    const nextScope = createEmptyScopeRuntime(scopeId)
    this.snapshot.scopes[scopeId] = nextScope
    return nextScope
  }

  private garbageCollectExpiredLeases(currentDate: Date) {
    const currentTimestamp = currentDate.getTime()
    const expiredLeaseIds = Object.entries(this.snapshot.activeLeases)
      .filter(([, lease]) => parseTimestamp(lease.expiresAt) + LEASE_SETTLEMENT_GRACE_MS <= currentTimestamp)
      .map(([leaseId]) => leaseId)

    for (const leaseId of expiredLeaseIds) {
      delete this.snapshot.activeLeases[leaseId]
    }
  }

  annotateSelection(input: SelectionAnnotation) {
    const selectedAt =
      typeof input.selectedAt === 'string' && input.selectedAt.trim()
        ? input.selectedAt.trim()
        : nowIso()

    for (const scopeId of input.scopeIds) {
      const runtime = this.ensureScopeRuntime(scopeId)
      runtime.lastSelectedAt = selectedAt
      runtime.lastSelectionReason = input.reason
      runtime.lastSelectionScore = input.score
      appendEvidenceRecord(this.snapshot, {
        id: randomUUID(),
        scopeId,
        rotationGroupId: 'selection',
        routeId: scopeId,
        leaseId: null,
        kind: 'selected',
        occurredAt: selectedAt,
        requestCount: 0,
        tokenCount: 0,
        costUsd: 0,
        windowMs: null,
        correlationKeyCount: null,
        correlationRateLimitedCount: null,
        detail: input.reason,
      })
      appendWatchEvent(runtime, {
        kind: 'selected',
        detail: input.reason,
        createdAt: selectedAt,
      })
    }
  }

  private evaluateCandidate(
    candidate: RouteCandidate,
    forecast: ReturnType<typeof normalizeForecast>,
    reservationsByScope: Map<
      string,
      { expectedRequests: number; expectedTokens: number; expectedCostUsd: number }
    >,
    currentDate: Date,
  ) {
    let score = 0
    inferProviderPressure(this.snapshot, candidate.rotationGroupId, currentDate.toISOString())
    const providerPressure = this.snapshot.providerPressure[candidate.rotationGroupId] ?? null

    for (const scope of candidate.scopes) {
      const runtime = this.ensureScopeRuntime(scope.scopeId)
      resetMinuteWindowIfNeeded(runtime, currentDate)
      resetDayWindowIfNeeded(runtime, currentDate)
      runtime.estimatedMinuteResetAt = toIsoTimestamp(
        getNextMinuteWindowTimestamp(runtime.minuteWindowStartedAt),
      )
      runtime.estimatedDayResetAt = toIsoTimestamp(getNextDayWindowTimestamp(runtime.dayWindowStartedAt))

      const cooldownTimestamp = parseTimestamp(runtime.blockedUntil)

      if (cooldownTimestamp > currentDate.getTime()) {
        runtime.nextEligibleAt = runtime.blockedUntil
        runtime.availabilityScore = null
        return null
      }

      const effectiveLimits = resolveEffectiveLimits(scope.limits, runtime)
      const probationLimits =
        runtime.probationState?.status === 'probation'
          ? {
              rpm: resolveEffectiveLimit(
                effectiveLimits.rpm,
                normalizeNullableNumber(runtime.probationState.maxBurstRequests),
              ),
              tpm: resolveEffectiveLimit(
                effectiveLimits.tpm,
                normalizeNullableNumber(runtime.probationState.maxBurstTokens),
              ),
            }
          : null
      const effectiveRpm = probationLimits?.rpm ?? effectiveLimits.rpm
      const effectiveTpm = probationLimits?.tpm ?? effectiveLimits.tpm
      const reservations = reservationsByScope.get(scope.scopeId) ?? {
        expectedRequests: 0,
        expectedTokens: 0,
        expectedCostUsd: 0,
      }
      const projectedMinuteRequests =
        runtime.minuteRequestCount + reservations.expectedRequests + forecast.expectedRequests
      const projectedMinuteTokens =
        runtime.minuteTokenCount + reservations.expectedTokens + forecast.expectedTokens
      const projectedDayRequests =
        runtime.dayRequestCount + reservations.expectedRequests + forecast.expectedRequests
      const projectedDayUsd =
        runtime.dayUsdTotal + reservations.expectedCostUsd + forecast.expectedCostUsd

      if (effectiveRpm != null && projectedMinuteRequests > effectiveRpm) {
        const nextEligibleTimestamp = Math.max(
          parseTimestamp(resolveLearnedResetTimestamp(runtime, 'rpm')),
          getNextMinuteWindowTimestamp(runtime.minuteWindowStartedAt),
        )
        runtime.blockedReason = 'rpm'
        runtime.nextEligibleAt = toIsoTimestamp(nextEligibleTimestamp)
        runtime.availabilityScore = null
        return null
      }

      if (effectiveTpm != null && projectedMinuteTokens > effectiveTpm) {
        const nextEligibleTimestamp = Math.max(
          parseTimestamp(resolveLearnedResetTimestamp(runtime, 'tpm')),
          getNextMinuteWindowTimestamp(runtime.minuteWindowStartedAt),
        )
        runtime.blockedReason = 'tpm'
        runtime.nextEligibleAt = toIsoTimestamp(nextEligibleTimestamp)
        runtime.availabilityScore = null
        return null
      }

      if (effectiveLimits.rpd != null && projectedDayRequests > effectiveLimits.rpd) {
        const nextEligibleTimestamp = Math.max(
          parseTimestamp(resolveLearnedResetTimestamp(runtime, 'rpd')),
          getNextDayWindowTimestamp(runtime.dayWindowStartedAt),
        )
        runtime.blockedReason = 'rpd'
        runtime.nextEligibleAt = toIsoTimestamp(nextEligibleTimestamp)
        runtime.availabilityScore = null
        return null
      }

      if (
        effectiveLimits.budgetLimit != null &&
        effectiveLimits.budgetMode === 'requests' &&
        projectedDayRequests > effectiveLimits.budgetLimit
      ) {
        const nextEligibleTimestamp = Math.max(
          parseTimestamp(resolveLearnedResetTimestamp(runtime, 'budget-requests')),
          getNextDayWindowTimestamp(runtime.dayWindowStartedAt),
        )
        runtime.blockedReason = 'budget-requests'
        runtime.nextEligibleAt = toIsoTimestamp(nextEligibleTimestamp)
        runtime.availabilityScore = null
        return null
      }

      if (
        effectiveLimits.budgetLimit != null &&
        effectiveLimits.budgetMode === 'usd' &&
        projectedDayUsd > effectiveLimits.budgetLimit
      ) {
        runtime.blockedReason = 'budget-usd'
        runtime.nextEligibleAt = toIsoTimestamp(getNextDayWindowTimestamp(runtime.dayWindowStartedAt))
        runtime.availabilityScore = null
        return null
      }

      runtime.blockedReason = null
      runtime.nextEligibleAt = null
      runtime.availabilityScore = computeAvailabilityScore({
        limits: {
          ...effectiveLimits,
          rpm: effectiveRpm,
          tpm: effectiveTpm,
        },
        runtime,
        reservations,
        forecast,
        currentTimestamp: currentDate.getTime(),
      })
      if (providerPressure) {
        runtime.availabilityScore -= providerPressure.pressureScore * 0.6
      }
      if (runtime.probationState?.status === 'probation') {
        runtime.availabilityScore -= 0.2 + runtime.probationState.escalationLevel * 0.1
      }
      score += runtime.availabilityScore
    }

    return score
  }

  selectRoute(input: SelectionRequest): SelectionResult | null {
    const currentDate =
      typeof input.now === 'string' && input.now.trim() ? new Date(input.now.trim()) : new Date()
    this.garbageCollectExpiredLeases(currentDate)
    const forecast = normalizeForecast(input.forecast)
    const rotationPolicy = normalizeRotationPolicy(input.rotationPolicy)
    const reservationsByScope = getReservationsByScope(this.snapshot, currentDate.getTime())
    const rotationIndices = [...new Set(input.candidates.map((candidate) => candidate.rotationIndex))]
    const scoredCandidates = input.candidates
      .map((candidate) => {
        const score = this.evaluateCandidate(candidate, forecast, reservationsByScope, currentDate)

        if (score == null) {
          return null
        }

        const rotationGroup = this.snapshot.rotationGroups[candidate.rotationGroupId] ?? {
          nextRotationIndex: 0,
          incumbentRotationIndex: null,
        }
        const rotationDistance = getRotationDistance(
          candidate.rotationIndex,
          rotationGroup.nextRotationIndex,
          rotationIndices,
        )
        const incumbentPreference =
          rotationPolicy === 'sticky-incumbent' &&
          isIncumbentRotationIndex(
            candidate.rotationIndex,
            rotationGroup.incumbentRotationIndex,
          )
            ? 0
            : 1

        return {
          candidate,
          score,
          incumbentPreference,
          rotationDistance,
        }
      })
      .filter(
        (
          candidate,
        ): candidate is {
          candidate: RouteCandidate
          score: number
          incumbentPreference: number
          rotationDistance: number
        } =>
          candidate != null,
      )
      .sort((left, right) => {
        return (
          left.incumbentPreference - right.incumbentPreference ||
          right.score - left.score ||
          left.rotationDistance - right.rotationDistance ||
          left.candidate.sortKey.localeCompare(right.candidate.sortKey)
        )
      })

    const winner = scoredCandidates[0]

    if (!winner) {
      return null
    }

    const createdAt = currentDate.toISOString()
    const expiresAt = new Date(
      currentDate.getTime() +
        Math.max(1_000, Math.trunc(normalizeNullableNumber(input.leaseTtlMs) ?? DEFAULT_LEASE_TTL_MS)),
    ).toISOString()
    const lease: RouteLease = {
      id: randomUUID(),
      routeId: winner.candidate.routeId,
      sortKey: winner.candidate.sortKey,
      rotationGroupId: winner.candidate.rotationGroupId,
      createdAt,
      expiresAt,
      routeScopes: winner.candidate.scopes.map((scope) => ({
        scopeId: scope.scopeId,
        limits: normalizeLimitProfile(scope.limits),
      })),
      reservations: winner.candidate.scopes.map((scope) => ({
        scopeId: scope.scopeId,
        expectedRequests: forecast.expectedRequests,
        expectedTokens: forecast.expectedTokens,
        expectedCostUsd: forecast.expectedCostUsd,
      })),
    }

    this.snapshot.activeLeases[lease.id] = lease
    this.snapshot.rotationGroups[winner.candidate.rotationGroupId] = {
      nextRotationIndex: winner.candidate.rotationIndex + 1,
      incumbentRotationIndex: winner.candidate.rotationIndex,
    }
    for (const reservation of lease.reservations) {
      appendEvidenceRecord(this.snapshot, {
        id: randomUUID(),
        scopeId: reservation.scopeId,
        rotationGroupId: lease.rotationGroupId,
        routeId: lease.routeId,
        leaseId: lease.id,
        kind: 'leased',
        occurredAt: createdAt,
        requestCount: reservation.expectedRequests,
        tokenCount: reservation.expectedTokens,
        costUsd: reservation.expectedCostUsd,
        windowMs: null,
        correlationKeyCount: null,
        correlationRateLimitedCount: null,
        detail: `Reserved capacity for ${lease.routeId}.`,
      })
    }

    return {
      candidate: winner.candidate,
      lease,
      score: winner.score,
      usableCandidateCount: scoredCandidates.length,
    }
  }

  recordOutcome(input: RouteOutcome) {
    const lease = this.snapshot.activeLeases[input.leaseId]

    if (!lease) {
      return
    }

    const settledAt =
      typeof input.settledAt === 'string' && input.settledAt.trim()
        ? input.settledAt.trim()
        : nowIso()
    const currentDate = new Date(settledAt)
    delete this.snapshot.activeLeases[input.leaseId]

    const usage = normalizeForecast(input.usage)
    const observations = Array.isArray(input.observations) ? input.observations : []
    const authoritativeObservationDimensions =
      collectAuthoritativeObservationDimensions(observations)
    const behavioralEvidence = Array.isArray(input.behavioralEvidence)
      ? input.behavioralEvidence.filter(
          (evidence): evidence is BehavioralEvidence =>
            Boolean(evidence && typeof evidence === 'object' && !Array.isArray(evidence)),
        )
      : []
    const affectedScopeIds = new Set(
      Array.isArray(input.affectedScopeIds) && input.affectedScopeIds.length > 0
        ? input.affectedScopeIds
        : lease.reservations.map((reservation) => reservation.scopeId),
    )

    for (const reservation of lease.reservations) {
      const runtime = this.ensureScopeRuntime(reservation.scopeId)
      resetMinuteWindowIfNeeded(runtime, currentDate)
      resetDayWindowIfNeeded(runtime, currentDate)
      runtime.estimatedMinuteResetAt = toIsoTimestamp(
        getNextMinuteWindowTimestamp(runtime.minuteWindowStartedAt),
      )
      runtime.estimatedDayResetAt = toIsoTimestamp(getNextDayWindowTimestamp(runtime.dayWindowStartedAt))
    }

    for (const observation of observations) {
      const runtime = this.ensureScopeRuntime(observation.scopeId)
      applyCapacityObservation(runtime, observation)
    }

    for (const reservation of lease.reservations) {
      if (
        (input.kind === 'rate-limit' || input.kind === 'transient-failure') &&
        !affectedScopeIds.has(reservation.scopeId)
      ) {
        continue
      }

      const evidence =
        behavioralEvidence.find((entry) => entry.scopeId === reservation.scopeId) ??
        behavioralEvidence[0] ??
        null
      appendEvidenceRecord(this.snapshot, {
        id: randomUUID(),
        scopeId: reservation.scopeId,
        rotationGroupId: lease.rotationGroupId,
        routeId: lease.routeId,
        leaseId: lease.id,
        kind: input.kind,
        occurredAt: settledAt,
        requestCount: Math.max(
          usage.expectedRequests,
          normalizePositiveInteger(evidence?.requestCount, usage.expectedRequests),
        ),
        tokenCount: Math.max(
          usage.expectedTokens,
          normalizePositiveInteger(evidence?.tokenCount, usage.expectedTokens),
        ),
        costUsd: Math.max(
          usage.expectedCostUsd,
          Math.max(0, normalizeNullableNumber(evidence?.costUsd) ?? usage.expectedCostUsd),
        ),
        windowMs: normalizeNullableNumber(evidence?.windowMs),
        correlationKeyCount: normalizeNullableNumber(evidence?.correlationKeyCount),
        correlationRateLimitedCount: normalizeNullableNumber(evidence?.correlationRateLimitedCount),
        detail: evidence?.detail?.trim() || input.detail?.trim() || '',
      })
    }

    switch (input.kind) {
      case 'success':
        for (const reservation of lease.reservations) {
          const runtime = this.ensureScopeRuntime(reservation.scopeId)
          const authoritativeDimensions =
            authoritativeObservationDimensions.get(reservation.scopeId)

          if (!authoritativeDimensions?.request) {
            runtime.minuteRequestCount += usage.expectedRequests
          }
          if (!authoritativeDimensions?.tokens) {
            runtime.minuteTokenCount += usage.expectedTokens
          }
          if (!authoritativeDimensions?.dayRequest) {
            runtime.dayRequestCount += usage.expectedRequests
          }
          runtime.dayUsdTotal += usage.expectedCostUsd
          runtime.lastUsedAt = settledAt
          runtime.blockedUntil = null
          runtime.blockedReason = null
          runtime.nextEligibleAt = null
          runtime.lastFailureAt = null
          runtime.lastFailureKind = null
          runtime.consecutiveRateLimitCount = 0
          runtime.consecutiveTransientFailureCount = 0
          runtime.availabilityScore = Math.max(runtime.availabilityScore ?? 0, 0)
          runtime.recentBurst = inferBurstEpisode(
            this.snapshot,
            reservation.scopeId,
            settledAt,
            'success',
          )
          inferBehavioralHypotheses(runtime, this.snapshot, {
            scopeId: reservation.scopeId,
            settledAt,
            usage,
            rateLimited: false,
          })
          updateProbationState(runtime, this.snapshot, {
            scopeId: reservation.scopeId,
            settledAt,
            usage,
            kind: input.kind,
          })
          appendWatchEvent(runtime, {
            kind: 'success',
            detail: input.detail?.trim() || `Route ${lease.routeId} completed successfully.`,
            createdAt: settledAt,
          })
        }
        break

      case 'rate-limit':
        for (const reservation of lease.reservations) {
          if (!affectedScopeIds.has(reservation.scopeId)) {
            continue
          }

          const runtime = this.ensureScopeRuntime(reservation.scopeId)
          runtime.lastFailureAt = settledAt
          runtime.lastFailureKind = 'rate-limit'
          runtime.consecutiveRateLimitCount += 1
          runtime.consecutiveTransientFailureCount = 0
          runtime.recentBurst = inferBurstEpisode(
            this.snapshot,
            reservation.scopeId,
            settledAt,
            'rate-limit',
          )
          inferBehavioralHypotheses(runtime, this.snapshot, {
            scopeId: reservation.scopeId,
            settledAt,
            usage,
            rateLimited: true,
          })
          runtime.lastRateLimitAt = settledAt
          const priorRecoveryHypothesis = runtime.recoveryHypothesis
          const routeScope =
            lease.routeScopes.find((scope) => scope.scopeId === reservation.scopeId) ?? null
          const inferredTimestamp = inferRateLimitRecoveryTimestamp(
            resolveEffectiveLimits(routeScope?.limits ?? createEmptyLimitProfile(), runtime),
            runtime,
            currentDate.getTime(),
          )
          runtime.blockedUntil = toIsoTimestamp(inferredTimestamp)
          runtime.blockedReason = 'rate-limit'
          runtime.nextEligibleAt = runtime.blockedUntil
          runtime.recoveryHypothesis = {
            earliestSafeRetryAt: runtime.blockedUntil,
            expectedRecoveryWindowMs:
              parseTimestamp(runtime.blockedUntil) > currentDate.getTime()
                ? parseTimestamp(runtime.blockedUntil) - currentDate.getTime()
                : getAdaptiveBlockMs(BASE_RATE_LIMIT_BLOCK_MS, runtime.consecutiveRateLimitCount + 1),
            confidence:
              observations.length > 0 || runtime.learnedCapacity?.retryAfter != null ? 0.95 : 0.35,
            source:
              observations.length > 0 || runtime.learnedCapacity?.retryAfter != null
                ? 'telemetry'
                : 'behavioral',
          }
          const currentRecoveryWindowMs = runtime.recoveryHypothesis.expectedRecoveryWindowMs
          if (
            priorRecoveryHypothesis?.expectedRecoveryWindowMs != null &&
            currentRecoveryWindowMs != null &&
            priorRecoveryHypothesis.expectedRecoveryWindowMs > currentRecoveryWindowMs
          ) {
            runtime.recoveryHypothesis = {
              ...runtime.recoveryHypothesis,
              expectedRecoveryWindowMs: priorRecoveryHypothesis.expectedRecoveryWindowMs,
              confidence: Math.max(
                runtime.recoveryHypothesis.confidence,
                priorRecoveryHypothesis.confidence,
              ),
            }
          }
          updateProbationState(runtime, this.snapshot, {
            scopeId: reservation.scopeId,
            settledAt,
            usage,
            kind: input.kind,
          })
          appendWatchEvent(runtime, {
            kind: 'rate-limit',
            detail:
              input.detail?.trim() ||
              `Route ${lease.routeId} hit a rate limit on scope ${reservation.scopeId}.`,
            createdAt: settledAt,
            nextEligibleAt: runtime.nextEligibleAt,
          })
        }
        inferProviderPressure(this.snapshot, lease.rotationGroupId, settledAt)
        break

      case 'transient-failure':
        for (const reservation of lease.reservations) {
          if (!affectedScopeIds.has(reservation.scopeId)) {
            continue
          }

          const runtime = this.ensureScopeRuntime(reservation.scopeId)
          runtime.lastFailureAt = settledAt
          runtime.lastFailureKind = 'transient-failure'
          runtime.consecutiveTransientFailureCount += 1
          runtime.consecutiveRateLimitCount = 0

          runtime.blockedUntil = toIsoTimestamp(
            inferTransientRecoveryTimestamp(runtime, currentDate.getTime()),
          )
          runtime.blockedReason = 'transient-failure'
          runtime.nextEligibleAt = runtime.blockedUntil
          runtime.recentBurst = inferBurstEpisode(
            this.snapshot,
            reservation.scopeId,
            settledAt,
            'transient-failure',
          )
          runtime.recoveryHypothesis = {
            earliestSafeRetryAt: runtime.blockedUntil,
            expectedRecoveryWindowMs:
              parseTimestamp(runtime.blockedUntil) > currentDate.getTime()
                ? parseTimestamp(runtime.blockedUntil) - currentDate.getTime()
                : getAdaptiveBlockMs(BASE_TRANSIENT_BLOCK_MS, runtime.consecutiveTransientFailureCount + 1),
            confidence: 0.4,
            source: 'behavioral',
          }
          appendWatchEvent(runtime, {
            kind: 'transient-failure',
            detail:
              input.detail?.trim() ||
              `Route ${lease.routeId} entered watched recovery after a transient failure.`,
            createdAt: settledAt,
            nextEligibleAt: runtime.nextEligibleAt,
          })
        }
        break

      case 'auth-failure':
        for (const reservation of lease.reservations) {
          const runtime = this.ensureScopeRuntime(reservation.scopeId)
          runtime.lastAuthFailureAt = settledAt
          runtime.lastFailureAt = settledAt
          runtime.lastFailureKind = 'auth'
          runtime.consecutiveRateLimitCount = 0
          runtime.consecutiveTransientFailureCount = 0
          runtime.blockedUntil = toIsoTimestamp(currentDate.getTime() + 30_000)
          runtime.blockedReason = 'cooldown'
          runtime.nextEligibleAt = runtime.blockedUntil
          appendWatchEvent(runtime, {
            kind: 'auth-failure',
            detail: input.detail?.trim() || `Route ${lease.routeId} was rejected by the upstream provider.`,
            createdAt: settledAt,
            nextEligibleAt: runtime.nextEligibleAt,
          })
        }
        break

      case 'released':
        for (const reservation of lease.reservations) {
          const runtime = this.ensureScopeRuntime(reservation.scopeId)
          runtime.lastFailureAt = settledAt
          runtime.lastFailureKind = 'released'
          runtime.recentBurst = inferBurstEpisode(
            this.snapshot,
            reservation.scopeId,
            settledAt,
            'released',
          )
          appendWatchEvent(runtime, {
            kind: 'recovered',
            detail: input.detail?.trim() || `Released stale lease for route ${lease.routeId}.`,
            createdAt: settledAt,
          })
        }
        break
    }

    this.garbageCollectExpiredLeases(currentDate)
  }
}

export function buildSmartRoutingDebugSummary(
  snapshot: Partial<SmartRoutingEngineSnapshot> | SmartRoutingEngineSnapshot | null | undefined,
): SmartRoutingDebugSummary {
  const normalizedSnapshot = normalizeSmartRoutingSnapshot(snapshot)

  return {
    engine: buildEngineRecord(),
    activeLeaseCount: Object.keys(normalizedSnapshot.activeLeases).length,
    providerPressure: structuredClone(normalizedSnapshot.providerPressure),
    scopes: Object.fromEntries(
      Object.entries(normalizedSnapshot.scopes).map(([scopeId, runtime]) => [
        scopeId,
        {
          blockedReason: runtime.blockedReason,
          nextEligibleAt: runtime.nextEligibleAt,
          effectiveLimits: resolveEffectiveLimits(createEmptyLimitProfile(), runtime),
          limitSources: {
            rpm: resolveAutomaticLimitSource(runtime, 'rpm'),
            tpm: resolveAutomaticLimitSource(runtime, 'tpm'),
            rpd: resolveAutomaticLimitSource(runtime, 'rpd'),
            budgetLimit: resolveAutomaticBudgetLimitSource(runtime),
          },
          quotaHypotheses: structuredClone(runtime.quotaHypotheses),
          recoveryHypothesis: runtime.recoveryHypothesis ? structuredClone(runtime.recoveryHypothesis) : null,
          probationState: runtime.probationState ? structuredClone(runtime.probationState) : null,
          recentBurst: runtime.recentBurst ? structuredClone(runtime.recentBurst) : null,
          availabilityScore: runtime.availabilityScore,
        } satisfies SmartRoutingScopeDebugSummary,
      ]),
    ),
  }
}

export function createSmartRoutingEngine(snapshot?: Partial<SmartRoutingEngineSnapshot> | null) {
  return new SmartRoutingEngine(snapshot)
}

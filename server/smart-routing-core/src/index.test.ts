import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createEmptySmartRoutingSnapshot,
  createSmartRoutingEngine,
  SMART_ROUTING_ENGINE_LABEL,
  type CapacityObservation,
  type RouteCandidate,
} from './index.js'

function createCandidate(input: {
  routeId: string
  rotationIndex: number
  rpm?: number | null
  tpm?: number | null
  rpd?: number | null
}) {
  return {
    routeId: input.routeId,
    sortKey: input.routeId,
    rotationGroupId: 'group-a',
    rotationIndex: input.rotationIndex,
    scopes: [
      {
        scopeId: `${input.routeId}:aggregate`,
        limits: {
          rpm: input.rpm ?? null,
          tpm: input.tpm ?? null,
          rpd: input.rpd ?? null,
          budgetMode: 'requests',
          budgetLimit: null,
        },
      },
    ],
  } satisfies RouteCandidate
}

test('engine metadata exposes toomanyidiots 0.5 label', () => {
  const engine = createSmartRoutingEngine(createEmptySmartRoutingSnapshot())
  assert.equal(engine.engine.label, SMART_ROUTING_ENGINE_LABEL)
})

test('equal-health routes rotate fairly with deterministic ordering', () => {
  const engine = createSmartRoutingEngine()
  const candidates = [
    createCandidate({ routeId: 'route-a', rotationIndex: 0 }),
    createCandidate({ routeId: 'route-b', rotationIndex: 1 }),
    createCandidate({ routeId: 'route-c', rotationIndex: 2 }),
  ]

  const first = engine.selectRoute({ candidates })
  assert.equal(first?.candidate.routeId, 'route-a')
  engine.recordOutcome({ leaseId: first!.lease.id, kind: 'success' })

  const second = engine.selectRoute({ candidates })
  assert.equal(second?.candidate.routeId, 'route-b')
  engine.recordOutcome({ leaseId: second!.lease.id, kind: 'success' })

  const third = engine.selectRoute({ candidates })
  assert.equal(third?.candidate.routeId, 'route-c')
})

test('sticky-incumbent policy keeps the healthy incumbent hot until it becomes unavailable', () => {
  const engine = createSmartRoutingEngine()
  const candidates = [
    createCandidate({ routeId: 'route-a', rotationIndex: 0, rpm: 2 }),
    createCandidate({ routeId: 'route-b', rotationIndex: 1, rpm: 2 }),
  ]

  const first = engine.selectRoute({
    candidates,
    forecast: { expectedRequests: 1 },
    rotationPolicy: 'sticky-incumbent',
  })
  assert.equal(first?.candidate.routeId, 'route-a')
  engine.recordOutcome({ leaseId: first!.lease.id, kind: 'success' })

  const second = engine.selectRoute({
    candidates,
    forecast: { expectedRequests: 1 },
    rotationPolicy: 'sticky-incumbent',
  })
  assert.equal(second?.candidate.routeId, 'route-a')
  engine.recordOutcome({ leaseId: second!.lease.id, kind: 'success' })

  const third = engine.selectRoute({
    candidates,
    forecast: { expectedRequests: 1 },
    rotationPolicy: 'sticky-incumbent',
  })
  assert.equal(third?.candidate.routeId, 'route-b')
})

test('active leases reserve capacity and prevent over-selection', () => {
  const engine = createSmartRoutingEngine()
  const candidates = [
    createCandidate({ routeId: 'route-a', rotationIndex: 0, rpm: 1 }),
    createCandidate({ routeId: 'route-b', rotationIndex: 1, rpm: 1 }),
  ]

  const first = engine.selectRoute({ candidates, forecast: { expectedRequests: 1 } })
  assert.equal(first?.candidate.routeId, 'route-a')

  const second = engine.selectRoute({ candidates, forecast: { expectedRequests: 1 } })
  assert.equal(second?.candidate.routeId, 'route-b')

  const third = engine.selectRoute({ candidates, forecast: { expectedRequests: 1 } })
  assert.equal(third, null)
})

test('learned minute limits block the route before the next call', () => {
  const engine = createSmartRoutingEngine()
  const candidates = [createCandidate({ routeId: 'route-a', rotationIndex: 0 })]
  const selection = engine.selectRoute({ candidates })
  assert.ok(selection)

  const observation: CapacityObservation = {
    scopeId: 'route-a:aggregate',
    source: 'response-header',
    observedAt: new Date().toISOString(),
    request: {
      limit: 1,
      remaining: 0,
      resetAt: new Date(Date.now() + 60_000).toISOString(),
      confidence: 1,
    },
  }

  engine.recordOutcome({
    leaseId: selection!.lease.id,
    kind: 'success',
    observations: [observation],
  })

  assert.equal(engine.selectRoute({ candidates }), null)
})

test('manual configured limits stay authoritative when learned limits are lower', () => {
  const engine = createSmartRoutingEngine()
  const candidates = [createCandidate({ routeId: 'route-a', rotationIndex: 0, rpm: 100 })]
  const selection = engine.selectRoute({ candidates })
  assert.ok(selection)

  engine.recordOutcome({
    leaseId: selection!.lease.id,
    kind: 'success',
    observations: [
      {
        scopeId: 'route-a:aggregate',
        source: 'response-header',
        observedAt: new Date().toISOString(),
        request: {
          limit: 1,
          remaining: 0,
          resetAt: new Date(Date.now() + 60_000).toISOString(),
          confidence: 1,
        },
      },
    ],
  })

  assert.ok(engine.selectRoute({ candidates }))
})

test('conflicting observations merge conservatively', () => {
  const engine = createSmartRoutingEngine()
  const candidates = [createCandidate({ routeId: 'route-a', rotationIndex: 0 })]
  const first = engine.selectRoute({ candidates })
  const secondObservation: CapacityObservation = {
    scopeId: 'route-a:aggregate',
    source: 'header-b',
    observedAt: new Date().toISOString(),
    request: {
      limit: 10,
      remaining: 2,
      resetAt: new Date(Date.now() + 60_000).toISOString(),
      confidence: 1,
    },
  }

  engine.recordOutcome({
    leaseId: first!.lease.id,
    kind: 'success',
    observations: [
      {
        scopeId: 'route-a:aggregate',
        source: 'header-a',
        observedAt: new Date().toISOString(),
        request: {
          limit: 100,
          remaining: 50,
          resetAt: new Date(Date.now() + 20_000).toISOString(),
          confidence: 0.5,
        },
      },
    ],
  })

  const second = engine.selectRoute({ candidates })
  engine.recordOutcome({
    leaseId: second!.lease.id,
    kind: 'success',
    observations: [secondObservation],
  })

  const learned = engine.getSnapshot().scopes['route-a:aggregate']?.learnedCapacity?.request
  assert.equal(learned?.limit, 10)
  assert.equal(learned?.remaining, 2)
})

test('explicit telemetry teaches rpm tpm and rpd without double-counting usage', () => {
  const learnedAt = '2026-04-11T00:00:10.000Z'
  const minuteResetAt = '2026-04-11T00:01:00.000Z'
  const dayResetAt = '2026-04-12T00:00:00.000Z'
  const candidates = [createCandidate({ routeId: 'route-a', rotationIndex: 0 })]
  const engine = createSmartRoutingEngine()
  const selection = engine.selectRoute({
    candidates,
    now: learnedAt,
    forecast: { expectedRequests: 1, expectedTokens: 1_024 },
  })

  assert.ok(selection)

  engine.recordOutcome({
    leaseId: selection!.lease.id,
    kind: 'success',
    settledAt: learnedAt,
    usage: { requests: 1, tokens: 1_024 },
    observations: [
      {
        scopeId: 'route-a:aggregate',
        source: 'response-header',
        observedAt: learnedAt,
        request: {
          limit: 5,
          remaining: 4,
          resetAt: minuteResetAt,
          confidence: 1,
        },
        tokens: {
          limit: 25_000,
          remaining: 23_976,
          resetAt: minuteResetAt,
          confidence: 1,
        },
        dayRequest: {
          limit: 50,
          remaining: 49,
          resetAt: dayResetAt,
          confidence: 1,
        },
      },
    ],
  })

  const learnedRuntime = engine.getSnapshot().scopes['route-a:aggregate']
  assert.equal(learnedRuntime.learnedCapacity?.request?.limit, 5)
  assert.equal(learnedRuntime.learnedCapacity?.tokens?.limit, 25_000)
  assert.equal(learnedRuntime.learnedCapacity?.dayRequest?.limit, 50)
  assert.equal(learnedRuntime.minuteRequestCount, 1)
  assert.equal(learnedRuntime.minuteTokenCount, 1_024)
  assert.equal(learnedRuntime.dayRequestCount, 1)

  const reloadedEngine = createSmartRoutingEngine(engine.getSnapshot())

  const rpmBlocked = reloadedEngine.selectRoute({
    candidates,
    now: '2026-04-11T00:00:20.000Z',
    forecast: { expectedRequests: 5, expectedTokens: 1 },
  })
  assert.equal(rpmBlocked, null)
  assert.equal(reloadedEngine.getSnapshot().scopes['route-a:aggregate']?.blockedReason, 'rpm')

  const tpmBlocked = reloadedEngine.selectRoute({
    candidates,
    now: '2026-04-11T00:01:10.000Z',
    forecast: { expectedRequests: 1, expectedTokens: 25_001 },
  })
  assert.equal(tpmBlocked, null)
  assert.equal(reloadedEngine.getSnapshot().scopes['route-a:aggregate']?.blockedReason, 'tpm')

  for (let requestIndex = 0; requestIndex < 49; requestIndex += 1) {
    const now = new Date(Date.parse('2026-04-11T00:02:10.000Z') + requestIndex * 60_000).toISOString()
    const success = reloadedEngine.selectRoute({
      candidates,
      now,
      forecast: { expectedRequests: 1, expectedTokens: 1 },
    })
    assert.ok(success)
    reloadedEngine.recordOutcome({
      leaseId: success!.lease.id,
      kind: 'success',
      settledAt: now,
      usage: { requests: 1, tokens: 1 },
    })
  }

  const rpdBlocked = reloadedEngine.selectRoute({
    candidates,
    now: '2026-04-11T01:00:10.000Z',
    forecast: { expectedRequests: 1, expectedTokens: 1 },
  })
  assert.equal(rpdBlocked, null)
  assert.equal(reloadedEngine.getSnapshot().scopes['route-a:aggregate']?.blockedReason, 'rpd')
})

test('rate-limit recovery prefers the most conservative timestamp', () => {
  const engine = createSmartRoutingEngine()
  const candidates = [createCandidate({ routeId: 'route-a', rotationIndex: 0, rpm: 1 })]
  const selection = engine.selectRoute({ candidates })
  assert.ok(selection)

  engine.recordOutcome({
    leaseId: selection!.lease.id,
    kind: 'rate-limit',
    observations: [
      {
        scopeId: 'route-a:aggregate',
        source: 'provider-error',
        observedAt: new Date().toISOString(),
        request: {
          limit: 1,
          remaining: 0,
          resetAt: new Date(Date.now() + 90_000).toISOString(),
          confidence: 1,
        },
        retryAfterSeconds: 30,
      },
    ],
  })

  const blockedUntil = engine.getSnapshot().scopes['route-a:aggregate']?.blockedUntil
  assert.equal(blockedUntil != null, true)
  assert.ok(Date.parse(blockedUntil!) >= Date.now() + 85_000)
})

test('behavioral recovery learning preserves the inter-rate-limit window', () => {
  const engine = createSmartRoutingEngine()
  const candidates = [createCandidate({ routeId: 'route-a', rotationIndex: 0 })]
  const first = engine.selectRoute({
    candidates,
    now: '2026-04-11T10:00:00.000Z',
  })
  assert.ok(first)

  engine.recordOutcome({
    leaseId: first!.lease.id,
    kind: 'rate-limit',
    settledAt: '2026-04-11T10:00:00.000Z',
    usage: { requests: 1 },
  })

  const second = engine.selectRoute({
    candidates,
    now: '2026-04-11T10:02:00.000Z',
  })
  assert.ok(second)

  engine.recordOutcome({
    leaseId: second!.lease.id,
    kind: 'rate-limit',
    settledAt: '2026-04-11T10:02:00.000Z',
    usage: { requests: 1 },
  })

  const recoveryWindow =
    engine.getSnapshot().scopes['route-a:aggregate']?.recoveryHypothesis?.expectedRecoveryWindowMs
  assert.ok((recoveryWindow ?? 0) >= 120_000)
})

test('retry-after learned without observedAt never creates an epoch reset timestamp', () => {
  const snapshot = createEmptySmartRoutingSnapshot()
  const engine = createSmartRoutingEngine(snapshot)
  const candidates = [createCandidate({ routeId: 'route-a', rotationIndex: 0 })]
  const first = engine.selectRoute({
    candidates,
    now: '2026-04-11T10:00:00.000Z',
  })
  assert.ok(first)

  engine.recordOutcome({
    leaseId: first!.lease.id,
    kind: 'rate-limit',
    settledAt: '2026-04-11T10:00:00.000Z',
    observations: [
      {
        scopeId: 'route-a:aggregate',
        source: 'provider-error',
        observedAt: '2026-04-11T10:00:00.000Z',
        retryAfterSeconds: 60,
      },
    ],
  })

  const learnedSnapshot = engine.getSnapshot()
  const runtime = learnedSnapshot.scopes['route-a:aggregate']
  assert.ok(runtime?.learnedCapacity?.retryAfter)
  runtime!.learnedCapacity!.retryAfter!.observedAt = null

  const reloaded = createSmartRoutingEngine(learnedSnapshot)
  const second = reloaded.selectRoute({
    candidates,
    now: '2026-04-11T10:02:00.000Z',
  })
  assert.ok(second)

  reloaded.recordOutcome({
    leaseId: second!.lease.id,
    kind: 'rate-limit',
    settledAt: '2026-04-11T10:02:00.000Z',
  })

  const blockedUntil = reloaded.getSnapshot().scopes['route-a:aggregate']?.blockedUntil
  assert.equal(blockedUntil?.startsWith('1970-'), false)
})

test('auth failure leaves a durable audit trail in the snapshot', () => {
  const engine = createSmartRoutingEngine()
  const candidates = [createCandidate({ routeId: 'route-a', rotationIndex: 0 })]
  const selection = engine.selectRoute({ candidates })
  assert.ok(selection)

  engine.recordOutcome({
    leaseId: selection!.lease.id,
    kind: 'auth-failure',
    detail: 'Provider rejected the credential.',
  })

  const runtime = engine.getSnapshot().scopes['route-a:aggregate']
  assert.equal(runtime?.lastFailureKind, 'auth')
  assert.equal(runtime?.watchEvents[runtime.watchEvents.length - 1]?.kind, 'auth-failure')
})

test('transient failures decay into a watched recovery block', () => {
  const engine = createSmartRoutingEngine()
  const candidates = [createCandidate({ routeId: 'route-a', rotationIndex: 0 })]
  const selection = engine.selectRoute({ candidates })
  assert.ok(selection)

  engine.recordOutcome({
    leaseId: selection!.lease.id,
    kind: 'transient-failure',
  })

  const runtime = engine.getSnapshot().scopes['route-a:aggregate']
  assert.equal(runtime?.blockedReason, 'transient-failure')
  assert.equal(runtime?.nextEligibleAt != null, true)
})

test('telemetry-free short bursts infer a conservative rpm hypothesis', () => {
  const engine = createSmartRoutingEngine()
  const candidates = [createCandidate({ routeId: 'route-a', rotationIndex: 0 })]
  const startedAt = Date.parse('2026-04-09T10:00:00.000Z')

  for (let index = 0; index < 4; index += 1) {
    const now = new Date(startedAt + index * 5_000).toISOString()
    const selection = engine.selectRoute({ candidates, now })
    assert.ok(selection)
    engine.recordOutcome({
      leaseId: selection!.lease.id,
      kind: 'success',
      settledAt: now,
      usage: { requests: 1 },
      behavioralEvidence: [
        {
          scopeId: 'route-a:aggregate',
          observedAt: now,
          requestCount: 1,
        },
      ],
    })
  }

  const rateLimitedAt = new Date(startedAt + 25_000).toISOString()
  const rateLimitedSelection = engine.selectRoute({ candidates, now: rateLimitedAt })
  assert.ok(rateLimitedSelection)
  engine.recordOutcome({
    leaseId: rateLimitedSelection!.lease.id,
    kind: 'rate-limit',
    settledAt: rateLimitedAt,
    usage: { requests: 1 },
    behavioralEvidence: [
      {
        scopeId: 'route-a:aggregate',
        observedAt: rateLimitedAt,
        requestCount: 1,
      },
    ],
  })

  const runtime = engine.getSnapshot().scopes['route-a:aggregate']
  assert.ok(runtime.quotaHypotheses.rpm.confidence >= 0.55)
  assert.equal(runtime.quotaHypotheses.rpm.upperBound, 5)
  assert.equal(runtime.quotaHypotheses.rpm.verificationPlan?.status, 'pending')
  assert.equal(runtime.quotaHypotheses.rpm.verificationPlan?.probeKind, 'low-request')
  assert.equal(runtime.quotaHypotheses.rpm.verificationPlan?.verifyAfter, '2026-04-09T10:01:00.000Z')
  assert.equal(runtime.nextEligibleAt, '2026-04-09T10:01:00.000Z')
  assert.equal(engine.selectRoute({ candidates, now: new Date(startedAt + 30_000).toISOString() }), null)

  const verifiedAfterMinuteReset = engine.selectRoute({
    candidates,
    now: new Date(startedAt + 61_000).toISOString(),
    forecast: { expectedRequests: 1 },
  })
  assert.ok(verifiedAfterMinuteReset)
  engine.recordOutcome({
    leaseId: verifiedAfterMinuteReset!.lease.id,
    kind: 'success',
    settledAt: new Date(startedAt + 61_000).toISOString(),
    usage: { requests: 1 },
  })

  assert.equal(
    engine.getSnapshot().scopes['route-a:aggregate']?.quotaHypotheses.rpm.verificationPlan?.status,
    'verified',
  )
})

test('telemetry-free long-horizon exhaustion favors rpd over rpm', () => {
  const engine = createSmartRoutingEngine()
  const candidates = [createCandidate({ routeId: 'route-a', rotationIndex: 0 })]
  const startedAt = Date.parse('2026-04-09T00:00:00.000Z')

  for (let index = 0; index < 9; index += 1) {
    const now = new Date(startedAt + index * 60 * 60_000).toISOString()
    const selection = engine.selectRoute({ candidates, now })
    assert.ok(selection)
    engine.recordOutcome({
      leaseId: selection!.lease.id,
      kind: 'success',
      settledAt: now,
      usage: { requests: 1 },
      behavioralEvidence: [
        {
          scopeId: 'route-a:aggregate',
          observedAt: now,
          requestCount: 1,
        },
      ],
    })
  }

  const rateLimitedAt = new Date(startedAt + 9 * 60 * 60_000).toISOString()
  const selection = engine.selectRoute({ candidates, now: rateLimitedAt })
  assert.ok(selection)
  engine.recordOutcome({
    leaseId: selection!.lease.id,
    kind: 'rate-limit',
    settledAt: rateLimitedAt,
    usage: { requests: 1 },
    behavioralEvidence: [
      {
        scopeId: 'route-a:aggregate',
        observedAt: rateLimitedAt,
        requestCount: 1,
      },
    ],
  })

  const runtime = engine.getSnapshot().scopes['route-a:aggregate']
  assert.ok(runtime.quotaHypotheses.rpd.confidence > runtime.quotaHypotheses.rpm.confidence)
  assert.ok((runtime.quotaHypotheses.rpd.lowerBound ?? 0) >= 9)
  assert.equal(runtime.quotaHypotheses.rpd.verificationPlan?.status, 'pending')
  assert.equal(runtime.quotaHypotheses.rpd.verificationPlan?.probeKind, 'day-reset')
  assert.equal(runtime.nextEligibleAt, '2026-04-10T00:00:00.000Z')
})

test('token-heavy rate limits infer a tpm hypothesis without telemetry', () => {
  const engine = createSmartRoutingEngine()
  const candidates = [createCandidate({ routeId: 'route-a', rotationIndex: 0 })]
  const startedAt = Date.parse('2026-04-09T12:00:00.000Z')

  for (let index = 0; index < 2; index += 1) {
    const now = new Date(startedAt + index * 10_000).toISOString()
    const selection = engine.selectRoute({ candidates, now })
    assert.ok(selection)
    engine.recordOutcome({
      leaseId: selection!.lease.id,
      kind: 'success',
      settledAt: now,
      usage: { requests: 1, tokens: 30_000 },
      behavioralEvidence: [
        {
          scopeId: 'route-a:aggregate',
          observedAt: now,
          requestCount: 1,
          tokenCount: 30_000,
        },
      ],
    })
  }

  const rateLimitedAt = new Date(startedAt + 25_000).toISOString()
  const selection = engine.selectRoute({ candidates, now: rateLimitedAt })
  assert.ok(selection)
  engine.recordOutcome({
    leaseId: selection!.lease.id,
    kind: 'rate-limit',
    settledAt: rateLimitedAt,
    usage: { requests: 1, tokens: 30_000 },
    behavioralEvidence: [
      {
        scopeId: 'route-a:aggregate',
        observedAt: rateLimitedAt,
        requestCount: 1,
        tokenCount: 30_000,
      },
    ],
  })

  const runtime = engine.getSnapshot().scopes['route-a:aggregate']
  assert.ok(runtime.quotaHypotheses.tpm.confidence >= 0.55)
  assert.ok(runtime.quotaHypotheses.tpm.confidence > runtime.quotaHypotheses.rpm.confidence)
  assert.ok((runtime.quotaHypotheses.tpm.upperBound ?? 0) >= 90_000)
  assert.equal(runtime.quotaHypotheses.tpm.verificationPlan?.status, 'pending')
  assert.equal(runtime.quotaHypotheses.tpm.verificationPlan?.probeKind, 'low-token')

  const lowTokenBurstAfterMinuteReset = engine.selectRoute({
    candidates,
    now: new Date(startedAt + 61_000).toISOString(),
    forecast: { expectedRequests: 3, expectedTokens: 3 },
  })
  assert.ok(lowTokenBurstAfterMinuteReset)
})

test('provider pressure rises when multiple routes rate-limit together', () => {
  const engine = createSmartRoutingEngine()
  const candidates = [
    createCandidate({ routeId: 'route-a', rotationIndex: 0 }),
    createCandidate({ routeId: 'route-b', rotationIndex: 1 }),
  ]
  const firstAt = '2026-04-09T13:00:00.000Z'
  const secondAt = '2026-04-09T13:00:20.000Z'

  const first = engine.selectRoute({ candidates, now: firstAt })
  assert.ok(first)
  engine.recordOutcome({
    leaseId: first!.lease.id,
    kind: 'rate-limit',
    settledAt: firstAt,
    usage: { requests: 1 },
    behavioralEvidence: [
      {
        scopeId: `${first!.candidate.routeId}:aggregate`,
        observedAt: firstAt,
        requestCount: 1,
      },
    ],
  })

  const second = engine.selectRoute({ candidates, now: secondAt })
  assert.ok(second)
  engine.recordOutcome({
    leaseId: second!.lease.id,
    kind: 'rate-limit',
    settledAt: secondAt,
    usage: { requests: 1 },
    behavioralEvidence: [
      {
        scopeId: `${second!.candidate.routeId}:aggregate`,
        observedAt: secondAt,
        requestCount: 1,
      },
    ],
  })

  const pressure = engine.getSnapshot().providerPressure['group-a']
  assert.ok((pressure?.pressureScore ?? 0) > 0)
  assert.ok((pressure?.recentAffectedRouteCount ?? 0) >= 2)
})

test('sparse rotation indices still advance deterministically', () => {
  const engine = createSmartRoutingEngine()
  const candidates = [
    createCandidate({ routeId: 'route-a', rotationIndex: 0 }),
    createCandidate({ routeId: 'route-c', rotationIndex: 2 }),
  ]

  const first = engine.selectRoute({ candidates, now: '2026-04-11T10:00:00.000Z' })
  assert.equal(first?.candidate.routeId, 'route-a')
  engine.recordOutcome({ leaseId: first!.lease.id, kind: 'success' })

  const second = engine.selectRoute({ candidates, now: '2026-04-11T10:00:01.000Z' })
  assert.equal(second?.candidate.routeId, 'route-c')
  engine.recordOutcome({ leaseId: second!.lease.id, kind: 'success' })

  const third = engine.selectRoute({ candidates, now: '2026-04-11T10:00:02.000Z' })
  assert.equal(third?.candidate.routeId, 'route-a')
})

test('late outcomes still settle after lease ttl while the lease remains retained', () => {
  const engine = createSmartRoutingEngine()
  const candidates = [createCandidate({ routeId: 'route-a', rotationIndex: 0 })]

  const first = engine.selectRoute({
    candidates,
    now: '2026-04-11T10:00:00.000Z',
    leaseTtlMs: 1_000,
  })
  assert.ok(first)

  const second = engine.selectRoute({
    candidates,
    now: '2026-04-11T10:00:02.000Z',
    leaseTtlMs: 1_000,
  })
  assert.ok(second)

  engine.recordOutcome({
    leaseId: first!.lease.id,
    kind: 'success',
    settledAt: '2026-04-11T10:00:03.000Z',
  })

  const snapshot = engine.getSnapshot()
  assert.equal(
    snapshot.evidenceLedger.filter((record) => record.scopeId === 'route-a:aggregate' && record.kind === 'success').length,
    1,
  )
  assert.equal(Object.keys(snapshot.activeLeases).includes(second!.lease.id), true)
})

test('rate-limit outcomes only punish explicitly affected scopes', () => {
  const engine = createSmartRoutingEngine()
  const candidates: RouteCandidate[] = [
    {
      routeId: 'route-a',
      sortKey: 'route-a',
      rotationGroupId: 'group-a',
      rotationIndex: 0,
      scopes: [
        {
          scopeId: 'route-a:aggregate',
          limits: {
            rpm: null,
            tpm: null,
            rpd: null,
            budgetMode: 'requests',
            budgetLimit: null,
          },
        },
        {
          scopeId: 'route-a:model-a',
          limits: {
            rpm: 1,
            tpm: null,
            rpd: null,
            budgetMode: 'requests',
            budgetLimit: null,
          },
        },
      ],
    },
  ]

  const selection = engine.selectRoute({ candidates, now: '2026-04-11T11:00:00.000Z' })
  assert.ok(selection)

  engine.recordOutcome({
    leaseId: selection!.lease.id,
    kind: 'rate-limit',
    settledAt: '2026-04-11T11:00:01.000Z',
    affectedScopeIds: ['route-a:model-a'],
    behavioralEvidence: [
      {
        scopeId: 'route-a:aggregate',
        observedAt: '2026-04-11T11:00:01.000Z',
        requestCount: 1,
      },
      {
        scopeId: 'route-a:model-a',
        observedAt: '2026-04-11T11:00:01.000Z',
        requestCount: 1,
      },
    ],
  })

  const snapshot = engine.getSnapshot()
  const aggregateRuntime = snapshot.scopes['route-a:aggregate']
  const modelRuntime = snapshot.scopes['route-a:model-a']

  assert.equal(aggregateRuntime?.lastRateLimitAt ?? null, null)
  assert.equal(aggregateRuntime?.blockedUntil ?? null, null)
  assert.equal(modelRuntime?.lastRateLimitAt, '2026-04-11T11:00:01.000Z')
  assert.equal(modelRuntime?.blockedReason, 'rate-limit')
  assert.equal(
    snapshot.evidenceLedger.filter(
      (record) => record.scopeId === 'route-a:aggregate' && record.kind === 'rate-limit',
    ).length,
    0,
  )
  assert.equal(
    snapshot.evidenceLedger.filter(
      (record) => record.scopeId === 'route-a:model-a' && record.kind === 'rate-limit',
    ).length,
    1,
  )
})

test('transient failures only increment explicitly affected scopes', () => {
  const engine = createSmartRoutingEngine()
  const candidates: RouteCandidate[] = [
    {
      routeId: 'route-a',
      sortKey: 'route-a',
      rotationGroupId: 'group-a',
      rotationIndex: 0,
      scopes: [
        {
          scopeId: 'route-a:aggregate',
          limits: {
            rpm: null,
            tpm: null,
            rpd: null,
            budgetMode: 'requests',
            budgetLimit: null,
          },
        },
        {
          scopeId: 'route-a:model-a',
          limits: {
            rpm: null,
            tpm: null,
            rpd: null,
            budgetMode: 'requests',
            budgetLimit: null,
          },
        },
      ],
    },
  ]

  const selection = engine.selectRoute({ candidates, now: '2026-04-11T12:00:00.000Z' })
  assert.ok(selection)

  engine.recordOutcome({
    leaseId: selection!.lease.id,
    kind: 'transient-failure',
    settledAt: '2026-04-11T12:00:01.000Z',
    affectedScopeIds: ['route-a:model-a'],
  })

  const snapshot = engine.getSnapshot()
  const aggregateRuntime = snapshot.scopes['route-a:aggregate']
  const modelRuntime = snapshot.scopes['route-a:model-a']

  assert.equal(aggregateRuntime?.consecutiveTransientFailureCount ?? 0, 0)
  assert.equal(aggregateRuntime?.lastFailureKind ?? null, null)
  assert.equal(modelRuntime?.consecutiveTransientFailureCount, 1)
  assert.equal(modelRuntime?.lastFailureKind, 'transient-failure')
  assert.equal(
    snapshot.evidenceLedger.filter(
      (record) => record.scopeId === 'route-a:aggregate' && record.kind === 'transient-failure',
    ).length,
    0,
  )
  assert.equal(
    snapshot.evidenceLedger.filter(
      (record) => record.scopeId === 'route-a:model-a' && record.kind === 'transient-failure',
    ).length,
    1,
  )
})

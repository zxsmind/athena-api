import {
  createSmartRoutingEngine,
  createEmptySmartRoutingSnapshot,
  serializeSmartRoutingSnapshot,
  normalizeSmartRoutingSnapshot,
} from '@mindbox/smart-routing-core';
import type {
  RouteCandidate,
  RouteScope,
  CapacityObservation,
  BehavioralEvidence,
  SmartRoutingEngineSnapshot,
} from '@mindbox/smart-routing-core';
import { loadSettings } from './settings-store.js';
import type { LLMRole, TargetReference } from './llm.js';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_PATH = resolve(__dirname, '..', 'data', 'smart-routing-snapshot.json');

function loadSnapshotFromDisk(): SmartRoutingEngineSnapshot | null {
  if (!existsSync(SNAPSHOT_PATH)) return null;
  try {
    const raw = readFileSync(SNAPSHOT_PATH, 'utf-8');
    return normalizeSmartRoutingSnapshot(JSON.parse(raw));
  } catch {
    console.warn('[SmartRoutingBridge] Corrupt snapshot, starting fresh');
    return null;
  }
}

function saveSnapshotToDisk(snapshot: SmartRoutingEngineSnapshot): void {
  try {
    writeFileSync(SNAPSHOT_PATH, JSON.stringify(serializeSmartRoutingSnapshot(snapshot)), 'utf-8');
  } catch (err) {
    console.error('[SmartRoutingBridge] Failed to save snapshot:', err);
  }
}

export class SmartRoutingBridge {
  private engine: ReturnType<typeof createSmartRoutingEngine>;

  constructor() {
    const snapshot = loadSnapshotFromDisk() ?? createEmptySmartRoutingSnapshot();
    this.engine = createSmartRoutingEngine(snapshot);
    console.log(`[SmartRoutingBridge] Initialized with ${Object.keys(snapshot.scopes).length} known scopes`);
  }

  buildCandidates(role?: LLMRole): {
    candidates: RouteCandidate[];
    providerMap: Map<string, TargetReference>;
  } {
    const store = loadSettings();
    const candidates: RouteCandidate[] = [];
    const providerMap = new Map<string, TargetReference>();
    const providerOrder = store.providerOrder || Object.keys(store.providers);
    let index = 0;

    for (const pid of providerOrder) {
      const provider = store.providers[pid];
      if (!provider?.enabled) continue;
      for (const model of provider.models || []) {
        const routeId = `${pid}/${model}`;
        const scope: RouteScope = {
          scopeId: routeId,
          limits: { rpm: null, tpm: null, rpd: null, budgetMode: 'requests', budgetLimit: null },
        };
        candidates.push({
          routeId,
          sortKey: pid,
          rotationGroupId: pid,
          rotationIndex: index,
          scopes: [scope],
        });
        providerMap.set(routeId, {
          source: 'provider',
          id: pid,
          url: provider.url,
          model,
        });
        index++;
      }
    }
    return { candidates, providerMap };
  }

  selectTarget(role?: LLMRole): {
    target: TargetReference;
    leaseId: string;
    routeId: string;
  } | null {
    const { candidates, providerMap } = this.buildCandidates(role);
    if (candidates.length === 0) {
      return null;
    }

    const result = this.engine.selectRoute({
      candidates,
      forecast: { expectedRequests: 1, expectedTokens: 0 },
      rotationPolicy: 'balanced',
    });
    if (!result) {
      return null;
    }

    const target = providerMap.get(result.candidate.routeId);
    if (!target) {
      return null;
    }

    return {
      target,
      leaseId: result.lease.id,
      routeId: result.candidate.routeId,
    };
  }

  recordOutcome(
    leaseId: string,
    kind: 'success' | 'rate-limit' | 'transient-failure' | 'auth-failure',
    extra?: {
      usage?: { tokens?: number; requests?: number };
      retryAfterMs?: number;
      observations?: CapacityObservation[];
      behavioralEvidence?: BehavioralEvidence[];
      detail?: string;
    },
  ): void {
    this.engine.recordOutcome({
      leaseId,
      kind,
      settledAt: new Date().toISOString(),
      usage: extra?.usage ? { requests: extra.usage.requests ?? 1, tokens: extra.usage.tokens ?? 0 } : { requests: 1, tokens: 0 },
      observations: extra?.observations,
      behavioralEvidence: extra?.behavioralEvidence,
      detail: extra?.detail,
    });
  }

  getMinRecoveryMs(): number | null {
    const snapshot = this.engine.getSnapshot();
    const now = Date.now();
    let minMs: number | null = null;
    for (const runtime of Object.values(snapshot.scopes)) {
      if (runtime.blockedUntil) {
        const ms = new Date(runtime.blockedUntil).getTime() - now;
        if (ms > 0) {
          minMs = minMs === null ? ms : Math.min(minMs, ms);
        }
      }
    }
    return minMs;
  }

  isAnyRouteAvailable(role?: LLMRole): boolean {
    const { candidates } = this.buildCandidates(role);
    if (candidates.length === 0) return false;
    const result = this.engine.selectRoute({
      candidates,
      forecast: { expectedRequests: 1, expectedTokens: 0 },
      rotationPolicy: 'balanced',
    });
    return result !== null;
  }

  saveSnapshot(): void {
    saveSnapshotToDisk(this.engine.getSnapshot());
  }

  getSnapshot(): SmartRoutingEngineSnapshot {
    return this.engine.getSnapshot();
  }
}

export const smartRouting = new SmartRoutingBridge();

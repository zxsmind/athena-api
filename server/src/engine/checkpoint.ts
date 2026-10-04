import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from 'fs';
import { resolve } from 'path';
import type { BudgetState, ReasoningEffort, ResearchPreset, ResearchVerbosity } from './modes.js';
import type { SourceWithIndex } from './types.js';
import { getDataPath } from '../storage.js';

const checkpointDir = getDataPath('research-checkpoints');

export interface ResearchCheckpoint {
  jobId: string;
  query: string;
  /** Carries the mode inside it, so a resume never needs a second field. */
  preset: ResearchPreset;
  budget: BudgetState;
  reasoningEffort?: ReasoningEffort;
  verbosity?: ResearchVerbosity;
  researchApi?: boolean;
  round: number;
  sourceMap: SourceWithIndex[];
  /** The model's explicit sandbox `state` (D4), or null when it never ran code. */
  sandboxState?: string | null;
  lastUpdatedAt: string;
}

function ensureDir(): void {
  if (!existsSync(checkpointDir)) mkdirSync(checkpointDir, { recursive: true });
}

function checkpointPath(jobId: string): string {
  return resolve(checkpointDir, `${jobId}.json`);
}

export function saveResearchCheckpoint(data: ResearchCheckpoint): void {
  ensureDir();
  writeFileSync(checkpointPath(data.jobId), JSON.stringify(data, null, 2), 'utf-8');
}

export function loadResearchCheckpoint(jobId: string): ResearchCheckpoint | null {
  const path = checkpointPath(jobId);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as ResearchCheckpoint;
    /* A checkpoint written before usage was tracked per model resumes with an
       empty ledger. Its token counts stay, but nothing new is claimed as
       reported, so a resumed job is never billed for unreported tokens. */
    return { ...parsed, budget: { ...parsed.budget, tokenLedger: parsed.budget.tokenLedger ?? {} } };
  } catch {
    return null;
  }
}

export function deleteResearchCheckpoint(jobId: string): void {
  const path = checkpointPath(jobId);
  if (existsSync(path)) {
    try { unlinkSync(path); } catch { /* ignore */ }
  }
}

export function listResearchCheckpoints(): ResearchCheckpoint[] {
  if (!existsSync(checkpointDir)) return [];
  const files = readdirSync(checkpointDir).filter(f => f.endsWith('.json'));
  const checkpoints: ResearchCheckpoint[] = [];
  for (const file of files) {
    const jobId = file.replace(/\.json$/, '');
    const cp = loadResearchCheckpoint(jobId);
    if (cp) checkpoints.push(cp);
  }
  return checkpoints.sort((a, b) => b.lastUpdatedAt.localeCompare(a.lastUpdatedAt));
}

export function cleanupStaleCheckpoints(maxAgeMs: number): number {
  if (maxAgeMs <= 0) return 0;
  const now = Date.now();
  let removed = 0;
  for (const cp of listResearchCheckpoints()) {
    const age = now - new Date(cp.lastUpdatedAt).getTime();
    if (Number.isFinite(age) && age > maxAgeMs) {
      deleteResearchCheckpoint(cp.jobId);
      removed++;
    }
  }
  return removed;
}

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import type { DeepDepth, ResolvedResearchPreset } from './depth-presets.js';
import type { SourceWithIndex } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const checkpointDir = resolve(__dirname, '..', '..', 'data', 'research-checkpoints');

export interface ResearchCheckpoint {
  jobId: string;
  query: string;
  depth: DeepDepth;
  preset: ResolvedResearchPreset;
  notebookId: string;
  usedCredits: number;
  remainingCredits: number;
  round: number;
  sourceMap: SourceWithIndex[];
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
    return JSON.parse(readFileSync(path, 'utf-8')) as ResearchCheckpoint;
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

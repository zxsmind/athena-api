import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export type NotebookClaimStatus = 'unverified' | 'single-source' | 'verified' | 'conflicting';
export type NotebookClaimConfidence = 'low' | 'medium' | 'high';

export interface NotebookClaim {
  text: string;
  status: NotebookClaimStatus;
  sourceUrls: string[];
  confidence: NotebookClaimConfidence;
}

export interface NotebookWriteArgs {
  topic?: string;
  summary?: string;
  verified_claims?: string[];
  open_questions?: string[];
  resolved_questions?: string[];
  contradictions?: string[];
  source_urls?: string[];
  next_actions?: string[];
  resolved_next_actions?: string[];
  claims?: NotebookClaim[];
}

export interface NotebookEntry {
  id: string;
  round: number;
  timestamp: string;
  topic: string;
  summary: string;
  verifiedClaims: string[];
  openQuestions: string[];
  contradictions: string[];
  sourceUrls: string[];
  nextActions: string[];
  claims: NotebookClaim[];
}

export interface ResearchNotebook {
  id: string;
  query: string;
  createdAt: string;
  updatedAt: string;
  entries: NotebookEntry[];
  latestSummary: string;
  verifiedClaims: string[];
  openQuestions: string[];
  contradictions: string[];
  nextActions: string[];
  claims: NotebookClaim[];
  path: string;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map(item => item.trim())
    .filter(Boolean);
}

function unique(items: string[]): string[] {
  return Array.from(new Set(items));
}

function normalizeClaims(value: unknown): NotebookClaim[] {
  if (!Array.isArray(value)) return [];
  const statuses: NotebookClaimStatus[] = ['unverified', 'single-source', 'verified', 'conflicting'];
  const confidences: NotebookClaimConfidence[] = ['low', 'medium', 'high'];
  return value
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    .map((item) => {
      const text = typeof item.text === 'string' ? item.text.trim() : '';
      if (!text) return null;
      const status = statuses.includes(item.status as NotebookClaimStatus) ? item.status as NotebookClaimStatus : 'unverified';
      const confidence = confidences.includes(item.confidence as NotebookClaimConfidence) ? item.confidence as NotebookClaimConfidence : 'low';
      return {
        text,
        status,
        confidence,
        sourceUrls: normalizeStringArray(item.sourceUrls ?? item.source_urls),
      };
    })
    .filter((item): item is NotebookClaim => item !== null);
}

function mergeClaims(existing: NotebookClaim[], incoming: NotebookClaim[]): NotebookClaim[] {
  const byText = new Map<string, NotebookClaim>();
  for (const claim of existing) byText.set(claim.text.toLowerCase(), claim);
  for (const claim of incoming) byText.set(claim.text.toLowerCase(), claim);
  return Array.from(byText.values());
}

function removeResolvedItems(items: string[], resolved: string[]): string[] {
  if (resolved.length === 0) return items;
  const resolvedSet = new Set(resolved.map(r => r.toLowerCase().trim()));
  return items.filter(item => !resolvedSet.has(item.toLowerCase().trim()));
}

export function createNotebook(query: string): ResearchNotebook {
  const now = new Date().toISOString();
  const dir = resolve(__dirname, '..', '..', 'data', 'notebooks');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const id = randomUUID();
  return {
    id,
    query,
    createdAt: now,
    updatedAt: now,
    entries: [],
    latestSummary: '',
    verifiedClaims: [],
    openQuestions: [],
    contradictions: [],
    nextActions: [],
    claims: [],
    path: resolve(dir, `${id}.json`),
  };
}

export function appendNotebookEntry(
  notebook: ResearchNotebook,
  args: NotebookWriteArgs,
  round: number,
): NotebookEntry {
  const now = new Date().toISOString();
  const entry: NotebookEntry = {
    id: randomUUID(),
    round,
    timestamp: now,
    topic: typeof args.topic === 'string' && args.topic.trim() ? args.topic.trim() : `Round ${round + 1}`,
    summary: typeof args.summary === 'string' ? args.summary.trim() : '',
    verifiedClaims: normalizeStringArray(args.verified_claims),
    openQuestions: normalizeStringArray(args.open_questions),
    contradictions: normalizeStringArray(args.contradictions),
    sourceUrls: normalizeStringArray(args.source_urls),
    nextActions: normalizeStringArray(args.next_actions),
    claims: normalizeClaims(args.claims),
  };

  notebook.entries.push(entry);
  notebook.updatedAt = now;
  notebook.latestSummary = entry.summary || notebook.latestSummary;
  notebook.verifiedClaims = unique([...notebook.verifiedClaims, ...entry.verifiedClaims]);
  notebook.contradictions = unique([...notebook.contradictions, ...entry.contradictions]);
  notebook.claims = mergeClaims(notebook.claims, entry.claims);

  const resolvedQuestions = normalizeStringArray(args.resolved_questions);
  if (resolvedQuestions.length > 0) {
    notebook.openQuestions = removeResolvedItems(notebook.openQuestions, resolvedQuestions);
  }
  const incomingOpen = normalizeStringArray(args.open_questions);
  if (incomingOpen.length > 0) {
    notebook.openQuestions = unique([...notebook.openQuestions, ...incomingOpen]);
  }

  const resolvedActions = normalizeStringArray(args.resolved_next_actions);
  if (resolvedActions.length > 0) {
    notebook.nextActions = removeResolvedItems(notebook.nextActions, resolvedActions);
  }
  const incomingActions = normalizeStringArray(args.next_actions);
  if (incomingActions.length > 0) {
    notebook.nextActions = unique([...notebook.nextActions, ...incomingActions]);
  }

  persistNotebook(notebook);
  return entry;
}

export function loadNotebook(id: string): ResearchNotebook | null {
  const dir = resolve(__dirname, '..', '..', 'data', 'notebooks');
  const path = resolve(dir, `${id}.json`);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Omit<ResearchNotebook, 'path'>;
    return {
      ...raw,
      claims: raw.claims ?? [],
      path,
    };
  } catch {
    return null;
  }
}

export function persistNotebook(notebook: ResearchNotebook): void {
  const { path, ...serializable } = notebook;
  writeFileSync(path, JSON.stringify(serializable, null, 2), 'utf-8');
}

export function notebookContext(notebook: ResearchNotebook): string {
  return JSON.stringify({
    id: notebook.id,
    latestSummary: notebook.latestSummary,
    verifiedClaims: notebook.verifiedClaims,
    openQuestions: notebook.openQuestions,
    contradictions: notebook.contradictions,
    nextActions: notebook.nextActions,
    claims: notebook.claims.map(claim => ({
      text: claim.text,
      status: claim.status,
      confidence: claim.confidence,
      sourceUrls: claim.sourceUrls,
    })),
    entries: notebook.entries.map(entry => ({
      round: entry.round,
      topic: entry.topic,
      summary: entry.summary,
      sourceUrls: entry.sourceUrls,
      claims: entry.claims ?? [],
    })),
  }, null, 2);
}

export const WRITE_NOTEBOOK_TOOL = {
  type: 'function',
  function: {
    name: 'write_notebook',
    description: 'Deep Research only. Persist a structured research notebook update after reading search/fetch results. Use this before continuing to new searches and before writing the final answer. Include exact source URLs that support the notes.',
    parameters: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'Short label for this notebook update.' },
        summary: { type: 'string', description: 'Concise synthesis of what was learned from the latest raw results.' },
        verified_claims: { type: 'array', items: { type: 'string' }, description: 'Claims now supported by the cited source URLs.' },
        open_questions: { type: 'array', items: { type: 'string' }, description: 'New unresolved questions to add (merged with existing; does not replace the full list).' },
        resolved_questions: { type: 'array', items: { type: 'string' }, description: 'Open questions now answered or no longer material — removed from the notebook gap list.' },
        contradictions: { type: 'array', items: { type: 'string' }, description: 'Conflicts or reliability concerns found in the evidence.' },
        source_urls: { type: 'array', items: { type: 'string' }, description: 'Exact URLs used for this update.' },
        next_actions: { type: 'array', items: { type: 'string' }, description: 'New concrete next searches or fetches to add (merged with existing).' },
        resolved_next_actions: { type: 'array', items: { type: 'string' }, description: 'Completed next actions to remove from the notebook queue.' },
        claims: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              text: { type: 'string' },
              status: { type: 'string', enum: ['unverified', 'single-source', 'verified', 'conflicting'] },
              sourceUrls: { type: 'array', items: { type: 'string' } },
              confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
            },
            required: ['text'],
          },
          description: 'Structured claim verification records for high/ultra depth research.',
        },
      },
      required: ['topic', 'summary', 'source_urls'],
    },
  },
} as const;

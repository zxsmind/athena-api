import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { getDataPath } from '../storage.js';
import { logger } from '../logger.js';

/**
 * Per-job evidence store: the disk side of offload.
 *
 * Principle: compaction moves pointers, never deletes bytes. Every source the
 * run produces is written here at arrival, with its engine-assigned index, and
 * stays for the life of the job. A stub in the conversation points at a record
 * here; `recall_source` reads it back. When the job ends the directory goes
 * with it: the trace already holds the full conversation, so the store has no
 * post-mortem readers.
 */

export interface StoredSource {
  /** The N in [Source #N]. Assigned by the engine at fetch time, never renumbered. */
  sourceIndex: number;
  url: string;
  title?: string;
  kind: 'search_result' | 'page';
  /** True only for full page reads. Provenance survives offload through this. */
  fetched: boolean;
  tokens: number;
  /** Full raw text. */
  text: string;
  sha256: string;
  /** The round that produced it. */
  round: number;
}

export interface EvidenceStoreInput {
  sourceIndex: number;
  url: string;
  title?: string;
  kind: 'search_result' | 'page';
  fetched: boolean;
  text: string;
  round: number;
}

function jobDir(jobId: string): string {
  return resolve(getDataPath('evidence'), jobId);
}

function recordPath(jobId: string, sourceIndex: number): string {
  return resolve(jobDir(jobId), `${sourceIndex}.json`);
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export function storeEvidence(jobId: string, input: EvidenceStoreInput): StoredSource {
  /* A later search can return a page already read. Keep its full text and
     provenance; replacing it with a snippet would make recall lose evidence. */
  const existing = readEvidence(jobId, input.sourceIndex);
  if (existing?.fetched && !input.fetched) return existing;

  const record: StoredSource = {
    sourceIndex: input.sourceIndex,
    url: input.url,
    title: input.title,
    kind: input.kind,
    fetched: input.fetched,
    tokens: estimateTokens(input.text),
    text: input.text,
    sha256: createHash('sha256').update(input.text, 'utf-8').digest('hex'),
    round: input.round,
  };
  try {
    mkdirSync(jobDir(jobId), { recursive: true });
    writeFileSync(recordPath(jobId, input.sourceIndex), JSON.stringify(record), 'utf-8');
  } catch (err) {
    logger.warn('evidence store write failed', { jobId, error: (err as Error).message });
  }
  return record;
}

export function readEvidence(jobId: string, sourceIndex: number): StoredSource | null {
  const path = recordPath(jobId, sourceIndex);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as StoredSource;
  } catch {
    return null;
  }
}

export function listEvidence(jobId: string): StoredSource[] {
  const dir = jobDir(jobId);
  if (!existsSync(dir)) return [];
  const out: StoredSource[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    const index = Number(file.replace(/\.json$/, ''));
    if (!Number.isFinite(index)) continue;
    const record = readEvidence(jobId, index);
    if (record) out.push(record);
  }
  return out.sort((a, b) => a.sourceIndex - b.sourceIndex);
}

export function deleteEvidence(jobId: string): boolean {
  try {
    rmSync(jobDir(jobId), { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

export function evidenceFilePath(jobId: string): string {
  return jobDir(jobId);
}

export interface RecallSourceArgs {
  /** The N from [Source #N]. */
  source: number;
  /** Byte offset to continue from. */
  offset?: number;
  /** Maximum bytes to return in this call. */
  limit?: number;
}

export interface RecallSourceResult {
  content: string;
  truncated: boolean;
  nextOffset: number | null;
}

const RECALL_DEFAULT_LIMIT = 12_000;

/**
 * Reads a stored source back, paged by byte offset. Offsets count bytes, and
 * slicing counts characters, so the conversion walks the string: cutting a
 * multi-byte character in half produces invalid output and a next offset that
 * points inside a character. Both mistakes are silent, so both are tested.
 */
export function recallSource(jobId: string, args: RecallSourceArgs): RecallSourceResult {
  const index = Math.trunc(Number(args.source));
  const record = Number.isFinite(index) ? readEvidence(jobId, index) : null;
  if (!record) {
    return {
      content: `No stored source #${String(args.source)}. Sources seen so far are listed in the conversation as [Source #N].`,
      truncated: false,
      nextOffset: null,
    };
  }
  const text = record.text;
  const totalBytes = Buffer.byteLength(text, 'utf-8');
  const start = typeof args.offset === 'number' && Number.isFinite(args.offset)
    ? Math.max(0, Math.min(Math.trunc(args.offset), totalBytes))
    : 0;
  const requested = typeof args.limit === 'number' && Number.isFinite(args.limit) && args.limit > 0
    ? Math.trunc(args.limit)
    : RECALL_DEFAULT_LIMIT;
  const limit = Math.min(requested, totalBytes);
  const startChar = byteOffsetToCharIndex(text, start);
  const endChar = byteOffsetToCharIndex(text, Math.min(start + limit, totalBytes));
  const slice = text.slice(startChar, Math.max(startChar + 1, endChar));
  const consumed = Buffer.byteLength(slice, 'utf-8');
  const nextOffset = start + consumed < totalBytes ? start + consumed : null;
  const header = `[Source #${record.sourceIndex} | ${record.kind}${record.fetched ? ', fetched' : ''} | ${record.url}]`;
  let content = `${header}\n\n${slice}`;
  if (nextOffset !== null) {
    content = `${header}\n[More follows — call recall_source with offset ${nextOffset} to continue.]\n\n${slice}`;
  }
  return { content, truncated: nextOffset !== null, nextOffset };
}

function byteOffsetToCharIndex(text: string, byteOffset: number): number {
  if (byteOffset <= 0) return 0;
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    if (bytes >= byteOffset) return i;
    bytes += Buffer.byteLength(text[i], 'utf-8');
  }
  return text.length;
}

export const RECALL_SOURCE_TOOL = {
  type: 'function',
  function: {
    name: 'recall_source',
    description: 'Read a source that was cleared from your context. Returns its raw text. The number is the N from [Source #N]; it never changes.',
    parameters: {
      type: 'object',
      properties: {
        source: { type: 'number', description: 'The N from [Source #N]. Required.' },
        offset: { type: 'number', description: 'Byte offset to continue from. Omit to read from the start.' },
        limit: { type: 'number', description: 'Maximum bytes to return in this call. Omit for the default.' },
      },
      required: ['source'],
    },
  },
} as const;

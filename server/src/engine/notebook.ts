import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const NOTEBOOK_CONTEXT_MAX_BYTES = 10_240;
export const NOTEBOOK_READ_MAX_BYTES = 51_200;

export interface ResearchNotebook {
  id: string;
  query: string;
  createdAt: string;
  updatedAt: string;
  path: string;
  appendCount: number;
}

interface NotebookMeta {
  id: string;
  query: string;
  createdAt: string;
  updatedAt: string;
  appendCount: number;
}

export interface NotebookWriteArgs {
  content: string;
  heading?: string;
}

export interface NotebookReadArgs {
  full?: boolean;
}

export interface NotebookAppendResult {
  heading: string;
  bytesTotal: number;
}

function notebooksDir(): string {
  return resolve(__dirname, '..', '..', 'data', 'notebooks');
}

function mdPath(id: string): string {
  return resolve(notebooksDir(), `${id}.md`);
}

function metaPath(id: string): string {
  return resolve(notebooksDir(), `${id}.meta.json`);
}

function ensureDir(): void {
  const dir = notebooksDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function readMeta(id: string): NotebookMeta | null {
  const path = metaPath(id);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as NotebookMeta;
  } catch {
    return null;
  }
}

function writeMeta(meta: NotebookMeta): void {
  writeFileSync(metaPath(meta.id), JSON.stringify(meta, null, 2), 'utf-8');
}

function readBody(id: string): string {
  const path = mdPath(id);
  if (!existsSync(path)) return '';
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return '';
  }
}

function writeBody(id: string, body: string): void {
  writeFileSync(mdPath(id), body, 'utf-8');
}

function initialBody(query: string): string {
  return [
    '# Research Notebook',
    '',
    `**Query:** ${query.trim()}`,
    '',
    '---',
    '',
  ].join('\n');
}

function truncateTail(text: string, maxBytes: number): { text: string; truncated: boolean; totalBytes: number } {
  const totalBytes = Buffer.byteLength(text, 'utf-8');
  if (totalBytes <= maxBytes) {
    return { text, truncated: false, totalBytes };
  }
  let start = Math.max(0, text.length - maxBytes);
  while (start > 0 && Buffer.byteLength(text.slice(start), 'utf-8') > maxBytes) {
    start += 1;
  }
  if (start > 0) {
    const nextNewline = text.indexOf('\n', start);
    if (nextNewline !== -1 && nextNewline < start + 200) start = nextNewline + 1;
  }
  return {
    text: text.slice(start),
    truncated: true,
    totalBytes,
  };
}

function migrateLegacyJson(id: string): ResearchNotebook | null {
  const jsonFile = resolve(notebooksDir(), `${id}.json`);
  if (!existsSync(jsonFile)) return null;
  try {
    const raw = JSON.parse(readFileSync(jsonFile, 'utf-8')) as {
      id?: string;
      query?: string;
      createdAt?: string;
      updatedAt?: string;
      entries?: Array<{ topic?: string; summary?: string; round?: number }>;
      latestSummary?: string;
      openQuestions?: string[];
      nextActions?: string[];
    };
    const query = raw.query ?? '';
    const now = raw.updatedAt ?? new Date().toISOString();
    const lines = [initialBody(query).trimEnd()];
    for (const entry of raw.entries ?? []) {
      const heading = entry.topic?.trim() || `Round ${(entry.round ?? 0) + 1}`;
      lines.push('', `## ${heading}`, '', entry.summary?.trim() || '_No summary._', '', '---', '');
    }
    if ((raw.openQuestions?.length ?? 0) > 0 || (raw.nextActions?.length ?? 0) > 0) {
      lines.push('', '## Legacy state (migrated from JSON)', '');
      if (raw.openQuestions?.length) {
        lines.push('**Open questions**', ...raw.openQuestions.map(q => `- ${q}`), '');
      }
      if (raw.nextActions?.length) {
        lines.push('**Next actions**', ...raw.nextActions.map(a => `- ${a}`), '');
      }
      lines.push('---', '');
    }
    const body = `${lines.join('\n')}\n`;
    writeBody(id, body);
    const meta: NotebookMeta = {
      id,
      query,
      createdAt: raw.createdAt ?? now,
      updatedAt: now,
      appendCount: raw.entries?.length ?? 0,
    };
    writeMeta(meta);
    return { ...meta, path: mdPath(id) };
  } catch {
    return null;
  }
}

export function createNotebook(query: string): ResearchNotebook {
  ensureDir();
  const now = new Date().toISOString();
  const id = randomUUID();
  const meta: NotebookMeta = {
    id,
    query,
    createdAt: now,
    updatedAt: now,
    appendCount: 0,
  };
  writeBody(id, initialBody(query));
  writeMeta(meta);
  return { ...meta, path: mdPath(id) };
}

export function loadNotebook(id: string): ResearchNotebook | null {
  ensureDir();
  const meta = readMeta(id);
  if (meta && existsSync(mdPath(id))) {
    return { ...meta, path: mdPath(id) };
  }
  return migrateLegacyJson(id);
}

export function persistNotebook(notebook: ResearchNotebook): void {
  writeMeta({
    id: notebook.id,
    query: notebook.query,
    createdAt: notebook.createdAt,
    updatedAt: notebook.updatedAt,
    appendCount: notebook.appendCount,
  });
}

export function readNotebookBody(notebook: ResearchNotebook): string {
  return readBody(notebook.id);
}

export function appendNotebookContent(
  notebook: ResearchNotebook,
  args: NotebookWriteArgs,
  round: number,
): NotebookAppendResult {
  const content = typeof args.content === 'string' ? args.content.trim() : '';
  if (!content) {
    throw new Error('Notebook content is empty.');
  }
  const heading = typeof args.heading === 'string' && args.heading.trim()
    ? args.heading.trim()
    : `Round ${round + 1}`;
  const now = new Date().toISOString();
  const block = ['', `## ${heading}`, '', content, '', '---', ''].join('\n');
  const body = `${readBody(notebook.id).trimEnd()}${block}\n`;
  writeBody(notebook.id, body);
  notebook.updatedAt = now;
  notebook.appendCount += 1;
  persistNotebook(notebook);
  return {
    heading,
    bytesTotal: Buffer.byteLength(body, 'utf-8'),
  };
}

export function readNotebookForModel(
  notebook: ResearchNotebook,
  args: NotebookReadArgs = {},
): { content: string; truncated: boolean; totalBytes: number } {
  const body = readBody(notebook.id);
  const maxBytes = args.full ? NOTEBOOK_READ_MAX_BYTES : NOTEBOOK_CONTEXT_MAX_BYTES;
  const { text, truncated, totalBytes } = truncateTail(body, maxBytes);
  if (!truncated) {
    return { content: text, truncated: false, totalBytes };
  }
  const omitted = totalBytes - Buffer.byteLength(text, 'utf-8');
  const prefix = `[Notebook truncated — ${omitted} bytes omitted from the start. Total ${totalBytes} bytes. Use read_notebook with full=true if you need earlier sections.]\n\n`;
  return { content: prefix + text, truncated: true, totalBytes };
}

export function notebookContext(notebook: ResearchNotebook): string {
  const { content, truncated, totalBytes } = readNotebookForModel(notebook);
  const header = `[Notebook id=${notebook.id} | ${notebook.appendCount} update(s) | ${totalBytes} bytes${truncated ? ' | truncated for context' : ''}]\n\n`;
  return header + content;
}

export const WRITE_NOTEBOOK_TOOL = {
  type: 'function',
  function: {
    name: 'write_notebook',
    description: 'Deep Research only. Append a Markdown research note after reading search/fetch results. Write plain Markdown: findings, source URLs, open gaps, next steps. Do not use JSON.',
    parameters: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'Markdown note for this update: what you learned, supporting URLs, unresolved gaps, suggested next searches.',
        },
        heading: {
          type: 'string',
          description: 'Optional section heading (default: Round N).',
        },
      },
      required: ['content'],
    },
  },
} as const;

export const READ_NOTEBOOK_TOOL = {
  type: 'function',
  function: {
    name: 'read_notebook',
    description: 'Read the research notebook when context shows a truncated view or you need earlier sections.',
    parameters: {
      type: 'object',
      properties: {
        full: {
          type: 'boolean',
          description: 'If true, return more of the notebook (up to engine limit). Default returns the same working view as context.',
        },
      },
    },
  },
} as const;

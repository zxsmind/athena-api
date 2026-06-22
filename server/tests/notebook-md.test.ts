import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const NOTEBOOKS_DIR = resolve(__dirname, '..', 'data', 'notebooks');

import {
  NOTEBOOK_CONTEXT_MAX_BYTES,
  appendNotebookContent,
  createNotebook,
  loadNotebook,
  notebookContext,
  readNotebookForModel,
} from '../src/engine/notebook.js';

describe('markdown notebook', () => {
  const createdIds: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    for (const id of createdIds) {
      for (const ext of ['.md', '.meta.json']) {
        const p = resolve(NOTEBOOKS_DIR, `${id}${ext}`);
        if (existsSync(p)) rmSync(p);
      }
    }
    createdIds.length = 0;
  });

  it('creates and appends markdown content', () => {
    const notebook = createNotebook('EV market Turkey');
    createdIds.push(notebook.id);

    appendNotebookContent(notebook, {
      heading: 'Sales overview',
      content: '- 2024 sales grew\n- Source: https://example.com/report',
    }, 0);

    expect(notebook.appendCount).toBe(1);
    const body = readNotebookForModel(notebook, { full: true }).content;
    expect(body).toContain('## Sales overview');
    expect(body).toContain('https://example.com/report');
    expect(body).toContain('**Query:** EV market Turkey');
  });

  it('truncates context view at max bytes', () => {
    const notebook = createNotebook('long notebook');
    createdIds.push(notebook.id);

    const bigBlock = 'x'.repeat(NOTEBOOK_CONTEXT_MAX_BYTES + 500);
    appendNotebookContent(notebook, { content: bigBlock }, 0);
    appendNotebookContent(notebook, { content: 'recent tail marker' }, 1);

    const ctx = notebookContext(notebook);
    expect(ctx).toContain('truncated for context');
    expect(ctx).toContain('recent tail marker');
    expect(Buffer.byteLength(ctx, 'utf-8')).toBeLessThan(NOTEBOOK_CONTEXT_MAX_BYTES + 512);
  });

  it('loads notebook from disk after create', () => {
    const notebook = createNotebook('persist test');
    createdIds.push(notebook.id);
    appendNotebookContent(notebook, { content: 'saved note' }, 0);

    const loaded = loadNotebook(notebook.id);
    expect(loaded?.appendCount).toBe(1);
    expect(readNotebookForModel(loaded!, { full: true }).content).toContain('saved note');
  });
});

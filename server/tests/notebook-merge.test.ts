import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs', () => ({
  existsSync: () => true,
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  readFileSync: vi.fn(),
}));

import { appendNotebookEntry, createNotebook } from '../src/engine/notebook.js';

describe('notebook merge semantics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('merges open_questions and next_actions instead of replacing', () => {
    const notebook = createNotebook('test query');
    appendNotebookEntry(notebook, {
      topic: 'Batch 1',
      summary: 'First pass',
      source_urls: ['https://a.example'],
      open_questions: ['Sales figures?'],
      next_actions: ['Search 2024 EV sales Turkey'],
    }, 0);
    appendNotebookEntry(notebook, {
      topic: 'Batch 2',
      summary: 'Second pass',
      source_urls: ['https://b.example'],
      open_questions: ['Charging network size?'],
      next_actions: ['Search charging stations Turkey'],
    }, 1);

    expect(notebook.openQuestions).toEqual(['Sales figures?', 'Charging network size?']);
    expect(notebook.nextActions).toEqual(['Search 2024 EV sales Turkey', 'Search charging stations Turkey']);
  });

  it('removes resolved questions and actions', () => {
    const notebook = createNotebook('test query');
    appendNotebookEntry(notebook, {
      topic: 'Start',
      summary: 'Init',
      source_urls: ['https://a.example'],
      open_questions: ['Sales figures?', 'Brand share?'],
      next_actions: ['Search sales', 'Search brands'],
    }, 0);
    appendNotebookEntry(notebook, {
      topic: 'Update',
      summary: 'Partial',
      source_urls: ['https://b.example'],
      resolved_questions: ['Sales figures?'],
      resolved_next_actions: ['Search sales'],
    }, 1);

    expect(notebook.openQuestions).toEqual(['Brand share?']);
    expect(notebook.nextActions).toEqual(['Search brands']);
  });

  it('merges claims by text (case-insensitive)', () => {
    const notebook = createNotebook('test query');
    appendNotebookEntry(notebook, {
      topic: 'Claims',
      summary: 'v1',
      source_urls: ['https://a.example'],
      claims: [{ text: 'EV share is 8%', status: 'unverified', confidence: 'low', sourceUrls: [] }],
    }, 0);
    appendNotebookEntry(notebook, {
      topic: 'Claims update',
      summary: 'v2',
      source_urls: ['https://b.example'],
      claims: [{ text: 'ev share is 8%', status: 'verified', confidence: 'high', sourceUrls: ['https://b.example'] }],
    }, 1);

    expect(notebook.claims).toHaveLength(1);
    expect(notebook.claims[0].status).toBe('verified');
    expect(notebook.claims[0].confidence).toBe('high');
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

describe('conversation research persistence', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'athena-db-'));
    process.env.ATHENA_DATA_DIR = tempDir;
  });

  afterEach(async () => {
    delete process.env.ATHENA_DATA_DIR;
    await rm(tempDir, { recursive: true, force: true });
  });

  it('stores mode and depth when creating a conversation', async () => {
    const { createConversation, getConversations } = await import('../src/db.js');
    await createConversation('conv-1', 'test query', 'deep', 'high');
    const list = await getConversations();
    expect(list[0]).toMatchObject({ id: 'conv-1', mode: 'deep', depth: 'high' });
  });

  it('updates conversation research settings', async () => {
    const { createConversation, updateConversationResearch, getConversations } = await import('../src/db.js');
    await createConversation('conv-2', 'another query', 'quick');
    await updateConversationResearch('conv-2', 'deep', 'ultra');
    const list = await getConversations();
    expect(list[0]).toMatchObject({ mode: 'deep', depth: 'ultra' });
  });

  it('clears depth when switching to quick mode', async () => {
    const { createConversation, updateConversationResearch, getConversations } = await import('../src/db.js');
    await createConversation('conv-3', 'query', 'deep', 'med');
    await updateConversationResearch('conv-3', 'quick');
    const list = await getConversations();
    expect(list[0].mode).toBe('quick');
    expect(list[0].depth).toBeUndefined();
  });
});

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { Message } from './schemas.js';
import type { DeepDepth } from './engine/depth-presets.js';
import { normalizeDeepDepth } from './engine/depth-presets.js';

export type ConversationMode = 'quick' | 'deep';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.ATHENA_DATA_DIR ?? join(__dirname, '..', 'data');
const DB_FILE = join(DATA_DIR, 'db.json');

export interface ConversationMeta {
  id: string;
  query: string;
  title: string | null;
  timestamp: string;
  mode?: ConversationMode;
  depth?: DeepDepth;
}

interface DbData {
  conversations: ConversationMeta[];
  messages: Record<string, Message[]>;
}

/* ── Simple async lock: all read-modify-write operations serialize on dbLock ── */
let dbLock: Promise<unknown> = Promise.resolve();

function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const p = dbLock.then(() => fn());
  dbLock = p.catch(() => {});
  return p;
}

async function ensureDir() {
  if (!existsSync(DATA_DIR)) {
    await mkdir(DATA_DIR, { recursive: true });
  }
}

async function readDb(): Promise<DbData> {
  await ensureDir();
  try {
    const raw = await readFile(DB_FILE, 'utf-8');
    return JSON.parse(raw) as DbData;
  } catch {
    return { conversations: [], messages: {} };
  }
}

async function writeDb(data: DbData): Promise<void> {
  await ensureDir();
  await writeFile(DB_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

export async function getConversations(): Promise<ConversationMeta[]> {
  const db = await readDb();
  return db.conversations;
}

function normalizeConversationMode(value: unknown): ConversationMode {
  return value === 'deep' ? 'deep' : 'quick';
}

export async function createConversation(
  id: string,
  query: string,
  mode?: ConversationMode,
  depth?: DeepDepth,
): Promise<ConversationMeta[]> {
  return withLock(async () => {
    const db = await readDb();
    const exists = db.conversations.find(c => c.id === id);
    if (exists) return db.conversations;
    const normalizedMode = normalizeConversationMode(mode);
    const entry: ConversationMeta = {
      id,
      query,
      title: null,
      timestamp: new Date().toISOString(),
      mode: normalizedMode,
      depth: normalizedMode === 'deep' ? normalizeDeepDepth(depth) : undefined,
    };
    db.conversations.unshift(entry);
    await writeDb(db);
    return db.conversations;
  });
}

export async function updateConversationResearch(
  id: string,
  mode: ConversationMode,
  depth?: DeepDepth,
): Promise<void> {
  return withLock(async () => {
    const db = await readDb();
    const conv = db.conversations.find(c => c.id === id);
    if (!conv) return;
    const normalizedMode = normalizeConversationMode(mode);
    conv.mode = normalizedMode;
    if (normalizedMode === 'deep') {
      conv.depth = normalizeDeepDepth(depth);
    } else {
      delete conv.depth;
    }
    await writeDb(db);
  });
}

export async function getMessages(conversationId: string): Promise<Message[]> {
  const db = await readDb();
  return db.messages[conversationId] || [];
}

export async function saveMessages(conversationId: string, messages: Message[]): Promise<void> {
  return withLock(async () => {
    const db = await readDb();
    db.messages[conversationId] = messages;
    await writeDb(db);
  });
}

export async function updateConversationTitle(id: string, title: string): Promise<void> {
  return withLock(async () => {
    const db = await readDb();
    const conv = db.conversations.find(c => c.id === id);
    if (conv) {
      conv.title = title;
      await writeDb(db);
    }
  });
}

export async function deleteConversation(id: string): Promise<void> {
  return withLock(async () => {
    const db = await readDb();
    db.conversations = db.conversations.filter(c => c.id !== id);
    delete db.messages[id];
    await writeDb(db);
  });
}

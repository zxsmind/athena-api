import express from 'express';
import cors from 'cors';
import { getPublicConfig, getPort } from './config.js';
import { callLLM, callLLMStream } from './llm.js';
import { getSettings, saveSettings } from './settings.js';
import type { SettingsData } from './settings.js';
import { agenticResearchStream } from './engine.js';
import type { SearchRequest } from './schemas.js';
import type { EngineEvent } from './engine.js';
import { loadSettings } from './settings-store.js';
import {
  createResearchJob,
  getResearchJob,
  attachResearchJobController,
  markResearchJobRunning,
  markResearchJobDone,
  markResearchJobFailed,
  appendResearchJobEvent,
  cancelResearchJob,
  setResearchJobStatus,
  subscribeResearchJob,
  applyAPISettings as applyJobAPISettings,
  type ResearchJobRequest,
  type ResearchJobStatus,
} from './research-jobs.js';
import {
  createResearchBatch,
  getResearchBatch,
  listResearchBatches,
  attachResearchBatchController,
  markResearchBatchRunning,
  markResearchBatchDone,
  markResearchBatchFailed,
  cancelResearchBatch,
  subscribeResearchBatch,
  updateResearchBatchItem,
  storeResearchBatchResult,
  failResearchBatchItem,
  appendResearchBatchEvent,
  applyAPISettings as applyBatchAPISettings,
  type ResearchBatchRequest,
} from './research-batches.js';
import {
  getConversations,
  createConversation,
  getMessages,
  saveMessages,
  updateConversationTitle,
  deleteConversation,
} from './db.js';

function applyAPISettingsFromStore() {
  const s = loadSettings();
  if (s.api) {
    applyJobAPISettings({ maxActiveJobs: s.api.maxActiveJobs, maxEventsPerJob: s.api.maxEventsPerJob });
    applyBatchAPISettings({ maxActiveBatches: s.api.maxActiveBatches, maxEventsPerBatch: s.api.maxEventsPerBatch });
  }
}

const app = express();

const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:5173,http://localhost:5174,http://localhost:5175').split(',');
app.use(cors({
  origin: allowedOrigins,
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.get('/config', (_req, res) => {
  res.json(getPublicConfig());
});

app.get('/settings', (_req, res) => {
  try {
    const settings = getSettings();
    res.json(settings);
  } catch (err: unknown) {
    res.status(500).json({ detail: (err as Error).message });
  }
});

app.put('/settings', (req, res) => {
  try {
    const data = req.body as SettingsData;
    saveSettings(data);
    applyAPISettingsFromStore();
    res.json({ ok: true });
  } catch (err: unknown) {
    res.status(500).json({ detail: (err as Error).message });
  }
});

/* â”€â”€ Research jobs â”€â”€ */
app.post('/research-jobs', async (req, res) => {
  const { query, history, mode } = req.body as ResearchJobRequest;
  if (!query || !query.trim()) {
    res.status(400).json({ detail: 'Query is required' });
    return;
  }

  const settings = loadSettings();
  const job = createResearchJob({
    query: query.trim(),
    history,
    mode: mode || settings.api?.defaultMode || 'quick',
  });
  runResearchJob(job.id).catch(err => console.error('[research-job]', err));
  res.status(202).json(job);
});

app.get('/research-jobs/:id', (req, res) => {
  const job = getResearchJob(req.params.id);
  if (!job) {
    res.status(404).json({ detail: 'Job not found' });
    return;
  }
  res.json(job);
});

function createSSEEndpoint<T extends { events: { type: string }[]; status: string }>(
  getRecord: (id: string) => T | undefined,
  subscribe: (id: string, cb: (record: T) => void) => () => void,
) {
  return (req: express.Request, res: express.Response) => {
    const id = String(req.params.id);
    const record = getRecord(id);
    if (!record) {
      res.status(404).json({ detail: 'Not found' });
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    const sentEvents = new Set<unknown>();
    const send = (event: string, data: object) => {
      try {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch {
        // Client disconnected.
      }
    };

    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { try { res.end(); } catch { /* client may have disconnected */ } }, 30000);
    };

    const flush = (current: T) => {
      for (const ev of current.events) {
        if (!sentEvents.has(ev)) {
          send(ev.type, ev);
          sentEvents.add(ev);
        }
      }
      if (current.status !== 'running') resetIdle();
    };

    flush(record);
    if (record.status === 'running') {
      const unsubscribe = subscribe(id, flush);
      req.on('close', unsubscribe);
    } else {
      resetIdle();
    }
  };
}

app.get('/research-jobs/:id/events', createSSEEndpoint(getResearchJob, subscribeResearchJob));

app.post('/research-jobs/:id/cancel', (req, res) => {
  const job = cancelResearchJob(req.params.id);
  if (!job) {
    res.status(404).json({ detail: 'Job not found' });
    return;
  }
  res.json(job);
});

app.get('/research-batches', (_req, res) => {
  const list = listResearchBatches().map(b => {
    return {
      id: b.id,
      queries: b.queries,
      history: b.history,
      mode: b.mode,
      maxConcurrent: b.maxConcurrent,
      sharedCredits: b.sharedCredits,
      perItemCredits: b.perItemCredits,
      status: b.status,
      createdAt: b.createdAt,
      updatedAt: b.updatedAt,
      startedAt: b.startedAt,
      finishedAt: b.finishedAt,
      cancelled: b.cancelled,
      items: b.items.map(i => ({
        id: i.id, query: i.query, status: i.status, error: i.error,
        startedAt: i.startedAt, finishedAt: i.finishedAt,
      })),
    };
  });
  res.json(list);
});

app.post('/research-batches', async (req, res) => {
  const { queries, history, mode, maxConcurrent, sharedCredits, perItemCredits } = req.body as ResearchBatchRequest;
  const normalizedQueries = Array.isArray(queries) ? queries.map(q => String(q).trim()).filter(q => q.length > 0) : [];
  if (normalizedQueries.length === 0) {
    res.status(400).json({ detail: 'queries array is required' });
    return;
  }

  const settings = loadSettings();
  const batch = createResearchBatch({
    queries: normalizedQueries,
    history,
    mode: mode || settings.api?.defaultMode || 'quick',
    maxConcurrent: maxConcurrent ?? settings.api?.defaultMaxConcurrent ?? 2,
    sharedCredits,
    perItemCredits,
  });
  runResearchBatch(batch.id).catch(err => console.error('[research-batch]', err));
  res.status(202).json(batch);
});

app.get('/research-batches/:id', (req, res) => {
  const batch = getResearchBatch(req.params.id);
  if (!batch) {
    res.status(404).json({ detail: 'Batch not found' });
    return;
  }
  res.json(batch);
});

app.get('/research-batches/:id/events', createSSEEndpoint(getResearchBatch, subscribeResearchBatch));

app.post('/research-batches/:id/cancel', (req, res) => {
  const batch = cancelResearchBatch(req.params.id);
  if (!batch) {
    res.status(404).json({ detail: 'Batch not found' });
    return;
  }
  res.json(batch);
});

/* ── Conversations ── */
app.get('/conversations', async (_req, res) => {
  const list = await getConversations();
  res.json(list);
});

app.post('/conversations', async (req, res) => {
  const { id, query } = req.body as { id: string; query: string };
  if (!id || !query) {
    res.status(400).json({ detail: 'id and query required' });
    return;
  }
  await createConversation(id, query);

  await generateTitle(id, query);

  const updatedList = await getConversations();
  res.json(updatedList);
});

async function generateTitle(conversationId: string, query: string) {
  const prompt = `Generate a short title (max 7 words) for this search query. The title must be in the SAME language as the query. Reply with ONLY the title, no quotes, no punctuation, no explanation.\n\nQuery: "${query}"\n\nTitle:`;

  try {
    const { data } = await callLLM({
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      maxTokens: 30,
      role: 'title',
      label: 'title-gen',
    });
    const result = data as { choices?: { message?: { content?: string } }[]; model?: string } | undefined;
    const rawContent = result?.choices?.[0]?.message?.content;
    console.log(`[title-gen] response model=${result?.model} content=${JSON.stringify(rawContent)}`);
    const title = rawContent?.trim().replace(/^["'\s]+|["'\s]+$/g, '') || query;
    if (title) {
      await updateConversationTitle(conversationId, title.slice(0, 60));
    }
  } catch (err: any) {
    console.error(`[title-gen] failed:`, err?.message || err);
    console.error(`[title-gen] full error:`, JSON.stringify(err, Object.getOwnPropertyNames(err)));
  }
}

const STEP_TO_STATUS: Record<string, string> = {
  plan: 'planning',
  search: 'searching',
  analyze: 'searching',
  review: 'reviewing',
  synthesize: 'synthesizing',
};

async function runResearchJob(jobId: string) {
  const job = markResearchJobRunning(jobId);
  if (!job) return;

  const controller = new AbortController();
  attachResearchJobController(jobId, controller);

  try {
    await agenticResearchStream(
      job.query,
      job.history,
      (event: EngineEvent) => {
        if (controller.signal.aborted) return;
        switch (event.type) {
          case 'step': {
            appendResearchJobEvent(jobId, { type: 'step', data: event.data, timestamp: new Date().toISOString() });
            const granular = STEP_TO_STATUS[event.data.type];
            if (granular) setResearchJobStatus(jobId, granular as ResearchJobStatus);
            break;
          }
          case 'token':
            appendResearchJobEvent(jobId, { type: 'token', text: event.text, timestamp: new Date().toISOString() });
            break;
          case 'sources':
            appendResearchJobEvent(jobId, { type: 'sources', sources: event.sources, timestamp: new Date().toISOString() });
            break;
          case 'done':
            markResearchJobDone(jobId, event.response);
            break;
          case 'error':
            markResearchJobFailed(jobId, event.message);
            break;
        }
      },
      job.mode,
      {
        signal: controller.signal,
        onProgress: () => {},
      },
    );
  } catch (err: unknown) {
    if (controller.signal.aborted) {
      cancelResearchJob(jobId);
      return;
    }
    markResearchJobFailed(jobId, (err as Error)?.message || 'Research job failed');
  }
}

async function runResearchBatch(batchId: string) {
  const batch = markResearchBatchRunning(batchId);
  if (!batch) return;

  const controller = new AbortController();
  attachResearchBatchController(batchId, controller);
  const settings = loadSettings();
  const perItemBudget = Math.max(1, batch.perItemCredits || settings.research.maxCreditsPerQuery);
  let sharedRemaining = Math.max(1, batch.sharedCredits || perItemBudget * batch.items.length);
  const pending = [...batch.items];
  const active = new Set<Promise<void>>();

  const launchNext = async (): Promise<void> => {
    if (controller.signal.aborted) return;
    if (pending.length === 0) return;
    if (active.size >= batch.maxConcurrent) return;

    const item = pending.shift();
    if (!item) return;

    const allocated = Math.min(perItemBudget, sharedRemaining);
    if (allocated <= 0) {
      failResearchBatchItem(batchId, item.id, 'Batch research budget exhausted');
      return launchNext();
    }
    sharedRemaining -= allocated;

    updateResearchBatchItem(batchId, item.id, {
      status: 'running',
      startedAt: new Date().toISOString(),
    });

    const task = agenticResearchStream(
      item.query,
      batch.history,
      (event: EngineEvent) => {
        if (controller.signal.aborted) return;
        const timestamp = new Date().toISOString();
        switch (event.type) {
          case 'step':
            appendResearchBatchEvent(batchId, {
              type: 'step',
              itemId: item.id,
              note: event.data.note,
              query: event.data.query,
              model: event.data.model,
              timestamp,
            });
            break;
          case 'token':
            appendResearchBatchEvent(batchId, { type: 'token', itemId: item.id, text: event.text, timestamp });
            break;
          case 'sources':
            appendResearchBatchEvent(batchId, { type: 'sources', itemId: item.id, sources: event.sources, timestamp });
            break;
          case 'done':
            storeResearchBatchResult(batchId, item.id, event.response);
            break;
          case 'error':
            failResearchBatchItem(batchId, item.id, event.message);
            break;
        }
      },
      batch.mode,
      {
        signal: controller.signal,
        budget: { remainingCredits: allocated },
      },
    );

    active.add(task);

    task.then(() => {
      if (!controller.signal.aborted) {
        const current = getResearchBatch(batchId);
        const doneItem = current?.items.find(entry => entry.id === item.id);
        if (doneItem && doneItem.status === 'running') {
          updateResearchBatchItem(batchId, item.id, {
            status: 'completed',
            finishedAt: new Date().toISOString(),
          });
        }
      }
    }).catch((err: unknown) => {
      if (controller.signal.aborted) return;
      failResearchBatchItem(batchId, item.id, (err as Error)?.message || 'Batch item failed');
    }).finally(() => {
      active.delete(task);
    });

    if (!controller.signal.aborted && pending.length > 0) {
      void launchNext();
    }
  };

  const drain = async () => {
    while (!controller.signal.aborted && (pending.length > 0 || active.size > 0)) {
      while (!controller.signal.aborted && pending.length > 0 && active.size < batch.maxConcurrent) {
        await launchNext();
      }
      if (active.size > 0) {
        await Promise.race(Array.from(active));
      }
    }
  };

  try {
    await drain();
    if (controller.signal.aborted) {
      cancelResearchBatch(batchId);
      return;
    }
    markResearchBatchDone(batchId);
  } catch (err: unknown) {
    if (controller.signal.aborted) {
      cancelResearchBatch(batchId);
      return;
    }
    markResearchBatchFailed(batchId, (err as Error)?.message || 'Batch research failed');
  }
}

/* ── Messages ── */
app.get('/conversations/:id/messages', async (req, res) => {
  const msgs = await getMessages(req.params.id);
  res.json(msgs);
});

app.put('/conversations/:id/messages', async (req, res) => {
  const { messages } = req.body as { messages: unknown[] };
  await saveMessages(req.params.id, messages as import('./schemas.js').Message[]);
  res.json({ ok: true });
});

/* ── Conversation management ── */
app.put('/conversations/:id/rename', async (req, res) => {
  const { title } = req.body as { title: string };
  if (!title || !title.trim()) {
    res.status(400).json({ detail: 'title required' });
    return;
  }
  await updateConversationTitle(req.params.id, title.trim());
  res.json({ ok: true });
});

app.delete('/conversations/:id', async (req, res) => {
  await deleteConversation(req.params.id);
  res.json({ ok: true });
});

/* ── Search (creates job, returns ID — frontend streams via /research-jobs/:id/events) ── */
app.post('/search', async (req, res) => {
  const { query, history, mode } = req.body as SearchRequest;
  if (!query || !query.trim()) {
    res.status(400).json({ detail: 'Query is required' });
    return;
  }

  const settings = loadSettings();
  const job = createResearchJob({
    query: query.trim(),
    history,
    mode: (mode || settings.api?.defaultMode || 'quick') as 'quick' | 'deep',
  });
  runResearchJob(job.id).catch(err => console.error('[research-job]', err));
  res.status(202).json({ id: job.id });
});

app.get('/autocomplete', async (req, res) => {
  const q = (req.query.q as string || '').trim();
  if (q.length < 2) {
    res.json({ suggestions: [] });
    return;
  }

  try {
    const resp = await fetch(`https://suggestqueries.google.com/complete/search?client=firefox&q=${encodeURIComponent(q)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    const data: unknown = await resp.json();
    const arr = data as unknown[];
    const suggestions = Array.isArray(arr[1]) ? arr[1] as unknown[] : [];
    res.json({ suggestions: suggestions.slice(0, 6) });
  } catch {
    res.json({ suggestions: [] });
  }
});

app.get('/ping', (_req, res) => {
  res.json({ version: 2, note: 'new code running' });
});

app.post('/test-llm', async (req, res) => {
  const { messages } = req.body || {};
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    res.json({ error: 'Provide messages array' });
    return;
  }

  const stepLabel = req.query.label as string || 'test';

  /* Test non-streaming */
  try {
    const result = await callLLM({ messages, temperature: 0.1, maxTokens: 100, label: `test-nostream-${stepLabel}` });
    res.json({ ok: true, mode: 'non-streaming', data: result.data, model: result.model, provider: result.provider });
  } catch (err: unknown) {
    /* Fallback: try streaming */
    try {
      let content = '';
      const result = await callLLMStream({
        messages, temperature: 0.1, maxTokens: 100, label: `test-stream-${stepLabel}`,
        onToken: (t) => { content += t; },
      });
      res.json({ ok: true, mode: 'streaming', fullContent: content || result.fullContent, model: result.model, provider: result.provider });
    } catch (err2: unknown) {
      res.json({ ok: false, error: (err as Error).message, error2: (err2 as Error).message });
    }
  }
});

applyAPISettingsFromStore();

app.listen(getPort(), () => {
  console.log(`ATHENA-001 server running on http://localhost:${getPort()}`);
});

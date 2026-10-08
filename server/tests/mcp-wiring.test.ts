import { describe, expect, it } from 'vitest';
import express from 'express';
import { createApiV1Router } from '../src/api-v1.js';
import { ApiPlatformStore } from '../src/api-platform-store.js';
import { Meter } from '../src/application/meter.js';
import { createResearchJob } from '../src/research-jobs.js';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

interface Harness {
  url: string;
  close: () => Promise<void>;
  keyId: string;
  secret: string;
  store: ApiPlatformStore;
}

/** Same shape as api-v1-wiring's harness, so MCP runs through the real router
 *  over a real socket: the host/origin guard, the key middleware and the tool
 *  handlers are all exercised end to end rather than mocked. */
async function startHarness(): Promise<Harness> {
  const store = new ApiPlatformStore();
  const meter = new Meter(store);
  const app = express();
  app.use(express.json());
  app.use('/v1', createApiV1Router({ store, startResearchJob: () => undefined, meter }));
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  const { record, secret } = store.createApiKey('mcp-integration', 'free');
  return {
    url: `http://127.0.0.1:${port}/v1`,
    keyId: record.id,
    secret,
    store,
    close: () => new Promise((resolve) => { server.close(() => resolve()); }),
  };
}

const auth = (secret: string) => ({ Authorization: `Bearer ${secret}` });

/** A JSON-RPC request as a Streamable HTTP client sends it. The server answers
 *  with an SSE frame rather than bare JSON, so the payload is unwrapped here the
 *  way a client library would do it. */
async function mcpCall(
  harness: Harness,
  method: string,
  params?: unknown,
  headers: Record<string, string> = {},
) {
  const res = await fetch(`${harness.url}/mcp`, {
    method: 'POST',
    /* Streamable HTTP requires the client to offer both a JSON response and an
       SSE stream; without the Accept header the server answers 406 rather than
       speaking MCP. A real client always sends it, so the test does too. */
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Math.floor(Math.random() * 1e9),
      method,
      ...(params === undefined ? {} : { params }),
    }),
  });
  const text = await res.text();
  const frame = text.split('\n').find((line) => line.startsWith('data: '));
  const parsed = frame
    ? JSON.parse(frame.slice(6)) as { result?: { content?: Array<{ text: string }>; isError?: boolean }; error?: unknown }
    : null;
  const body = parsed?.result?.content?.[0]?.text ? JSON.parse(parsed.result.content[0].text) as Record<string, never> : null;
  return {
    status: res.status,
    payload: body as { job_id?: string; error?: { code: string; retryable: boolean } } | null,
    isError: parsed?.result?.isError === true,
  };
}

/** The tool catalog as a client sees it after a tools/list round trip. */
async function listTools(harness: Harness) {
  const res = await fetch(`${harness.url}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Math.floor(Math.random() * 1e9), method: 'tools/list' }),
  });
  const text = await res.text();
  const frame = text.split('\n').find((line) => line.startsWith('data: '));
  const parsed = JSON.parse(frame!.slice(6)) as { result: { tools: Array<{ name: string; annotations?: Record<string, boolean> }> } };
  return parsed.result.tools;
}

describe('MCP over Streamable HTTP', () => {
  it('advertises exactly the eight Athena tools over tools/list', async () => {
    /* Renaming or dropping a tool silently breaks every configured client, so
       the catalog itself is pinned rather than left to individual assertions. */
    const h = await startHarness();
    try {
      const tools = await listTools(h);
      expect(tools.map((t) => t.name)).toEqual([
        'athena_search',
        'athena_read_contents',
        'athena_start_research',
        'athena_list_jobs',
        'athena_get_job',
        'athena_cancel_job',
        'athena_pause_job',
        'athena_resume_job',
      ]);
    } finally {
      await h.close();
    }
  });

  it('tells pause and resume what they may do', async () => {
    /* A client filters on these hints; without them a pause looks like an
       undefined call to a client that only sends what it can classify. */
    const h = await startHarness();
    try {
      const tools = await listTools(h);
      for (const name of ['athena_pause_job', 'athena_resume_job']) {
        expect(tools.find((t) => t.name === name)?.annotations).toBeDefined();
      }
    } finally {
      await h.close();
    }
  });

  it('rejects a request whose Origin is not an allowed host', async () => {
    const h = await startHarness();
    try {
      const foreign = await mcpCall(h, 'tools/list', undefined, { origin: 'https://evil.example' });
      expect(foreign.status).toBe(403);
      const allowed = await mcpCall(h, 'tools/list', undefined, { origin: 'http://127.0.0.1' });
      expect(allowed.status).toBe(200);
    } finally {
      await h.close();
    }
  });

  it('keeps one key away from another key job', async () => {
    const h = await startHarness();
    try {
      const other = h.store.createApiKey('other-key', 'free');
      const mine = createResearchJob({ query: 'mine', mode: 'instant', researchApi: true, apiKeyId: h.keyId });
      const theirs = createResearchJob({ query: 'theirs', mode: 'instant', researchApi: true, apiKeyId: other.record.id });

      /* The harness key asks for the other key's job: a tool error, not the job.
         Without key scoping this returns another key's query and sources to
         whoever holds a valid key. */
      const read = await mcpCall(h, 'tools/call', { name: 'athena_get_job', arguments: { job_id: theirs.id } }, auth(h.secret));
      expect(read.isError).toBe(true);
      expect(read.payload?.error?.code).toBe('NOT_FOUND');

      /* Same for the operations that change job state. */
      for (const name of ['athena_cancel_job', 'athena_pause_job', 'athena_resume_job']) {
        const res = await mcpCall(h, 'tools/call', { name, arguments: { job_id: theirs.id } }, auth(h.secret));
        expect(res.isError).toBe(true);
        expect(res.payload?.error?.code).toBe('NOT_FOUND');
      }

      /* Each owner still reaches its own job, so the isolation is scoping rather
         than a blanket failure. */
      const mineRead = await mcpCall(h, 'tools/call', { name: 'athena_get_job', arguments: { job_id: mine.id } }, auth(h.secret));
      expect(mineRead.isError).toBe(false);
      expect(mineRead.payload?.job_id).toBe(mine.id);

      const theirsRead = await mcpCall(h, 'tools/call', { name: 'athena_get_job', arguments: { job_id: theirs.id } }, auth(other.secret));
      expect(theirsRead.isError).toBe(false);
      expect(theirsRead.payload?.job_id).toBe(theirs.id);
    } finally {
      await h.close();
    }
  });

  it('maps a failing operation onto the tool error shape', async () => {
    const h = await startHarness();
    try {
      /* No search provider is configured in a test environment, so the shared
         guard rejects before any provider is contacted. */
      const res = await mcpCall(h, 'tools/call', { name: 'athena_start_research', arguments: { query: 'q', mode: 'instant' } });
      expect(res.status).toBe(200);
      expect(res.isError).toBe(true);
      expect(res.payload?.error?.code).toBe('SEARCH_NOT_CONFIGURED');
      expect(res.payload?.error?.retryable).toBe(false);
    } finally {
      await h.close();
    }
  });
});

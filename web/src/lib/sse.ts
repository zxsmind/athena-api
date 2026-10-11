/**
 * Server-Sent Events over fetch. The browser's EventSource cannot set an
 * Authorization header, and every job stream is key-gated, so the stream is
 * consumed by hand: one reader loop that parses the `id`/`event`/`data`
 * fields and `Last-Event-ID` resume.
 */

import { getApiKey } from './storage';

export interface SseEvent {
  id: string | null;
  event: string;
  data: unknown;
}

export async function streamEvents(
  path: string,
  handlers: {
    lastEventId?: string;
    signal?: AbortSignal;
    onEvent: (event: SseEvent) => void;
    onOpen?: () => void;
  },
): Promise<void> {
  const headers = new Headers({ Accept: 'text/event-stream' });
  const key = getApiKey();
  if (key) headers.set('Authorization', `Bearer ${key}`);
  if (handlers.lastEventId) headers.set('Last-Event-ID', handlers.lastEventId);

  const response = await fetch(`/v1${path}`, { headers, signal: handlers.signal });
  if (!response.ok || !response.body) {
    const payload = (await response.json().catch(() => null)) as
      | { error?: { message?: string } }
      | null;
    throw new Error(payload?.error?.message ?? `Stream failed with status ${response.status}.`);
  }
  handlers.onOpen?.();

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const chunk = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = parseChunk(chunk);
        if (event) handlers.onEvent(event);
        boundary = buffer.indexOf('\n\n');
      }
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
}

function parseChunk(chunk: string): SseEvent | null {
  let id: string | null = null;
  let event = 'message';
  const dataLines: string[] = [];

  for (const line of chunk.split('\n')) {
    if (line.startsWith(':')) continue;
    const separator = line.indexOf(':');
    const field = separator === -1 ? line : line.slice(0, separator);
    let value = separator === -1 ? '' : line.slice(separator + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'id') id = value;
    else if (field === 'event') event = value;
    else if (field === 'data') dataLines.push(value);
  }

  if (dataLines.length === 0 && id === null) return null;
  const raw = dataLines.join('\n');
  let data: unknown = raw;
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    /* keep the raw string; the consumer logs it as-is */
  }
  return { id, event, data };
}

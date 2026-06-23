import { loadSettings } from './settings-store.js';
import type { SearchResult } from './schemas.js';

let serperCycle: string[] = [];
let serperIndex = 0;
let serperInitialized = false;

const TYPE_ENDPOINTS: Record<string, string> = {
  search: 'https://google.serper.dev/search',
  news: 'https://google.serper.dev/news',
  images: 'https://google.serper.dev/images',
  videos: 'https://google.serper.dev/videos',
  places: 'https://google.serper.dev/places',
  shopping: 'https://google.serper.dev/shopping',
  scholar: 'https://google.serper.dev/scholar',
  patents: 'https://google.serper.dev/patents',
};

export function resetSerper() {
  serperInitialized = false;
}

function initSerper() {
  if (serperInitialized) return;
  const store = loadSettings();
  serperCycle = store.serper.keys;
  serperIndex = 0;
  serperInitialized = true;
}

function nextSerperKey(): string {
  if (serperCycle.length === 0) return '';
  const val = serperCycle[serperIndex];
  serperIndex = (serperIndex + 1) % serperCycle.length;
  return val;
}

function serperEndpoint(type: string): string {
  return TYPE_ENDPOINTS[type] || TYPE_ENDPOINTS.search;
}

function extractOrganic(data: unknown): unknown[] {
  const d = data as Record<string, unknown>;
  if (d.organic) return d.organic as unknown[];
  if (d.results) return d.results as unknown[];
  if (d.articles) return d.articles as unknown[];
  if (d.items) return d.items as unknown[];
  if (Array.isArray(data)) return data;
  return [];
}

export async function fetchResults(
  query: string,
  type: string = 'search',
  signal?: AbortSignal,
  limit?: number,
): Promise<{ results: SearchResult[]; queryText: string }> {
  initSerper();
  const store = loadSettings();
  const maxSources = limit !== undefined ? limit : (store.general.maxSources || 8);
  const key = nextSerperKey();
  if (!key) {
    throw new Error('No Serper API keys configured');
  }

  const endpoint = serperEndpoint(type);
  const body: Record<string, unknown> = { q: query, gl: 'us', hl: 'en', num: maxSources };
  const { signal: timeoutSignal, clean } = signalWithTimeout(signal, SEARCH_TIMEOUT_MS);

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'X-API-KEY': key,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: timeoutSignal,
    });

    if (!res.ok) {
      throw new Error(`Serper API error (${type}): ${res.status} ${res.statusText}`);
    }

    const data: unknown = await res.json();

    const organic = extractOrganic(data);
    const results: SearchResult[] = organic
      .slice(0, maxSources)
      .map((item: unknown, i: number) => { const it = item as Record<string, unknown>; return ({
        id: (it.position as number) ?? i + 1,
        title: String(it.title || ''),
        url: String(it.link || it.url || ''),
        snippet: (it.snippet || it.description || null) as string | null,
        date: (it.date || null) as string | null,
      }); });

    const queryText = ((data as Record<string, unknown>)?.searchParameters as Record<string, unknown>)?.q as string || query;
    return { results, queryText };
  } catch (err: unknown) {
    // user cancellation: propagate
    if (signal?.aborted) throw err;
    // timeout or other error: convert to meaningful message
    const message = (err as Error).name === 'AbortError'
      ? `Search timed out after ${SEARCH_TIMEOUT_MS / 1000}s`
      : (err as Error).message || 'Search failed';
    throw new Error(message);
  } finally {
    clean();
  }
}

const SEARCH_TIMEOUT_MS = 30_000;
const FETCH_TIMEOUT_MS = 30_000;

function signalWithTimeout(signal: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; clean: () => void } {
  if (signal?.aborted) return { signal, clean: () => {} };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const clean = () => { clearTimeout(timer); };
  if (!signal) return { signal: ctrl.signal, clean };
  const onAbort = () => { clearTimeout(timer); ctrl.abort(); };
  signal.addEventListener('abort', onAbort, { once: true });
  return {
    signal: ctrl.signal,
    clean: () => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); },
  };
}

const BLOCKED_HOSTS = [
  'localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]',
  '10.', '172.16.', '172.17.', '172.18.', '172.19.', '172.20.', '172.21.', '172.22.', '172.23.', '172.24.', '172.25.', '172.26.', '172.27.', '172.28.', '172.29.', '172.30.', '172.31.',
  '192.168.',
  '169.254.',
  '100.64.', '100.65.', '100.66.', '100.67.', '100.68.', '100.69.', '100.70.', '100.71.', '100.72.', '100.73.', '100.74.', '100.75.', '100.76.', '100.77.', '100.78.', '100.79.', '100.80.', '100.81.', '100.82.', '100.83.', '100.84.', '100.85.', '100.86.', '100.87.', '100.88.', '100.89.', '100.90.', '100.91.', '100.92.', '100.93.', '100.94.', '100.95.', '100.96.', '100.97.', '100.98.', '100.99.', '100.100.', '100.101.', '100.102.', '100.103.', '100.104.', '100.105.', '100.106.', '100.107.', '100.108.', '100.109.', '100.110.', '100.111.', '100.112.', '100.113.', '100.114.', '100.115.', '100.116.', '100.117.', '100.118.', '100.119.', '100.120.', '100.121.', '100.122.', '100.123.', '100.124.', '100.125.', '100.126.', '100.127.',
  'metadata.google.internal', '169.254.169.254',
];

function isBlockedUrl(urlString: string): boolean {
  try {
    const url = new URL(urlString);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return true;
    const hostname = url.hostname.toLowerCase();
    return BLOCKED_HOSTS.some(blocked => hostname === blocked || hostname.startsWith(blocked) || hostname.endsWith(blocked));
  } catch {
    return true;
  }
}

export async function fetchPageContent(
  url: string,
  signal?: AbortSignal,
): Promise<{ title: string; content: string; error?: string }> {
  if (isBlockedUrl(url)) {
    return { title: url, content: '', error: 'Blocked URL: internal or private addresses are not allowed' };
  }

  try {
    const { signal: timeoutSignal, clean } = signalWithTimeout(signal, FETCH_TIMEOUT_MS);

    try {
      const res = await fetch(url, {
        signal: timeoutSignal,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ATHENA/1.0)' },
      });

      if (!res.ok) {
        return {
          title: url,
          content: '',
          error: `HTTP ${res.status}: ${res.statusText}`,
        };
      }

      const contentType = res.headers.get('content-type') || '';
      const isPdf = contentType.includes('application/pdf') || url.toLowerCase().match(/\.pdf($|[?#])/);
      if (isPdf) {
        try {
          const { PDFParse } = await import('pdf-parse');
          const ab = await res.arrayBuffer();
          const u8 = new Uint8Array(ab);
          const parser = new PDFParse(u8);
          const data = await parser.getText();
          const text = (data?.text || '').trim();
          return { title: url, content: text.slice(0, 8000) || '[PDF text was empty]' };
        } catch (pdfErr: unknown) {
          return {
            title: url,
            content: '',
            error: `PDF parse failed: ${(pdfErr as Error).message}`,
          };
        }
      }

      const html = await res.text();
      const title = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim() || url;
      const text = html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&[a-z]+;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 3000);

      return { title, content: text };
    } finally {
      clean();
    }
  } catch (err: unknown) {
    // AbortError from user cancellation should propagate
    if (signal?.aborted) throw err;
    return {
      title: url,
      content: '',
      error: (err as Error).message || 'Fetch failed',
    };
  }
}

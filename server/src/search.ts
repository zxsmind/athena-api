import { loadSettings } from './settings-store.js';
import { config } from './config.js';
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

function extractOrganic(data: any): any[] {
  if (data.organic) return data.organic;
  if (data.results) return data.results;
  if (data.articles) return data.articles;
  if (data.items) return data.items;
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
  const body: Record<string, any> = { q: query, gl: 'us', hl: 'en', num: maxSources };

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'X-API-KEY': key,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    throw new Error(`Serper API error (${type}): ${res.status} ${res.statusText}`);
  }

  const data: any = await res.json();

  const organic = extractOrganic(data);
  const results: SearchResult[] = organic
    .slice(0, maxSources)
    .map((item: any, i: number) => ({
      id: item.position ?? i + 1,
      title: item.title || '',
      url: item.link || item.url || '',
      snippet: item.snippet || item.description || null,
      date: item.date || null,
    }));

  const queryText = data.searchParameters?.q || query;
  return { results, queryText };
}

export async function fetchPageContent(
  url: string,
  signal?: AbortSignal,
): Promise<{ title: string; content: string; error?: string }> {
  try {
    const res = await fetch(url, {
      signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ATHENA/1.0)' },
    });

    if (!res.ok) {
      return {
        title: url,
        content: '',
        error: `HTTP ${res.status}: ${res.statusText}`,
      };
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
  } catch (err: any) {
    // AbortError should still propagate so the agent can be cancelled cleanly
    if (err.name === 'AbortError') throw err;
    return {
      title: url,
      content: '',
      error: err.message,
    };
  }
}

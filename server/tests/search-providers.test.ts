import { describe, expect, it, vi, beforeEach } from 'vitest';
import { loadSettings, saveSettings, resetSettingsCache } from '../src/settings-store.js';
import { resetConfigForTests } from '../src/config/load.js';
import {
  SearchProviderNotConfiguredError,
  isSearchProviderConfigured,
  listSearchProviders,
  resetSearchProviders,
  searchResults,
} from '../src/search/index.js';

let lastRequest: { url: string; init: RequestInit } | null = null;

function mockFetchJson(payload: unknown, ok = true, status = 200) {
  lastRequest = null;
  return vi.fn(async (url: unknown, init?: RequestInit) => {
    lastRequest = { url: String(url), init: init ?? {} };
    return {
      ok,
      status,
      statusText: ok ? 'OK' : 'Error',
      headers: new Headers(),
      json: async () => payload,
      text: async () => '',
    } as unknown as Response;
  });
}

function setSearchKeys(entries: Record<string, { keys: string[]; url?: string; zone?: string }>): void {
  resetSettingsCache();
  resetSearchProviders();
  const settings = loadSettings();
  settings.searchProviders = JSON.parse(JSON.stringify(entries));
  settings.searchProviderOrder = [];
  saveSettings(settings);
}

function authHeader(init: RequestInit): Record<string, string> {
  return ((init.headers ?? {}) as Record<string, string>);
}

beforeEach(() => {
  resetSettingsCache();
  resetSearchProviders();
  resetConfigForTests();
  vi.unstubAllGlobals();
});

describe('serper', () => {
  it('posts the query with X-API-KEY and maps organic results', async () => {
    setSearchKeys({ serper: { keys: ['k1'] } });
    vi.stubGlobal('fetch', mockFetchJson({
      organic: [{ position: 2, title: 'T', link: 'https://example.com/a', snippet: 'S' }],
      searchParameters: { q: 'q echoed' },
    }));

    const outcome = await searchResults('hello', 'search', undefined, 5, {});
    expect(lastRequest?.url).toBe('https://google.serper.dev/search');
    expect(authHeader(lastRequest!.init)['X-API-KEY']).toBe('k1');
    expect(JSON.parse(String(lastRequest!.init.body)).q).toBe('hello');
    expect(outcome.results).toMatchObject([{ id: 2, title: 'T', url: 'https://example.com/a', snippet: 'S' }]);
    expect(outcome.queryText).toBe('q echoed');
    expect(outcome.provider).toBe('serper');
  });

  it('rotates through several keys', async () => {
    setSearchKeys({ serper: { keys: ['k1', 'k2'] } });
    vi.stubGlobal('fetch', mockFetchJson({ organic: [] }));
    await searchResults('a', 'search', undefined, 1, {});
    const first = authHeader(lastRequest!.init)['X-API-KEY'];
    await searchResults('b', 'search', undefined, 1, {});
    const second = authHeader(lastRequest!.init)['X-API-KEY'];
    expect([first, second].sort()).toEqual(['k1', 'k2']);
  });
});

describe('youcom', () => {
  it('posts to ydc-index with X-API-Key and joins snippets', async () => {
    setSearchKeys({ youcom: { keys: ['k'] } });
    vi.stubGlobal('fetch', mockFetchJson({
      results: { web: [{ url: 'https://example.com', title: 'T', description: 'D', snippets: ['s1', 's2'] }] },
    }));

    const outcome = await searchResults('q', 'search', undefined, 3, {});
    expect(lastRequest?.url).toBe('https://ydc-index.io/v1/search');
    expect(authHeader(lastRequest!.init)['X-API-Key']).toBe('k');
    expect(JSON.parse(String(lastRequest!.init.body))).toMatchObject({ query: 'q', count: 3 });
    expect(outcome.results[0].snippet).toContain('D');
    expect(outcome.results[0].snippet).toContain('s1');
    expect(outcome.provider).toBe('youcom');
  });
});

describe('serpapi', () => {
  it('gets search.json with the key as a query param', async () => {
    setSearchKeys({ serpapi: { keys: ['k'] } });
    vi.stubGlobal('fetch', mockFetchJson({
      organic_results: [{ position: 1, title: 'T', link: 'https://example.com', snippet: 'S' }],
    }));

    const outcome = await searchResults('q', 'search', undefined, 5, { country: 'de', language: 'de' });
    const url = new URL(lastRequest!.url);
    expect(`${url.origin}${url.pathname}`).toBe('https://serpapi.com/search.json');
    expect(url.searchParams.get('api_key')).toBe('k');
    expect(url.searchParams.get('engine')).toBe('google');
    expect(url.searchParams.get('q')).toBe('q');
    expect(url.searchParams.get('gl')).toBe('de');
    expect(outcome.results).toMatchObject([{ title: 'T', url: 'https://example.com', snippet: 'S' }]);
    expect(outcome.provider).toBe('serpapi');
  });
});

describe('tavily', () => {
  it('posts with Bearer auth and clamps to 20 results', async () => {
    setSearchKeys({ tavily: { keys: ['k'] } });
    vi.stubGlobal('fetch', mockFetchJson({
      query: 'q', results: [{ title: 'T', url: 'https://example.com', content: 'C', score: 0.9 }],
    }));

    const outcome = await searchResults('q', 'search', undefined, 50, { timeRange: 'week' });
    expect(lastRequest?.url).toBe('https://api.tavily.com/search');
    expect(authHeader(lastRequest!.init).Authorization).toBe('Bearer k');
    expect(JSON.parse(String(lastRequest!.init.body))).toMatchObject({
      query: 'q', search_depth: 'basic', max_results: 20, time_range: 'week',
    });
    expect(outcome.results).toMatchObject([{ title: 'T', snippet: 'C' }]);
    expect(outcome.provider).toBe('tavily');
  });
});

describe('linkup', () => {
  it('posts q/depth/outputType with Bearer auth', async () => {
    setSearchKeys({ linkup: { keys: ['k'] } });
    vi.stubGlobal('fetch', mockFetchJson({ results: [{ name: 'T', url: 'https://example.com', content: 'C' }] }));

    const outcome = await searchResults('q', 'search', undefined, 4, {});
    expect(lastRequest?.url).toBe('https://api.linkup.so/v1/search');
    expect(JSON.parse(String(lastRequest!.init.body))).toMatchObject({
      q: 'q', depth: 'default', outputType: 'searchResults', maxResults: 4,
    });
    expect(outcome.results).toMatchObject([{ title: 'T', snippet: 'C' }]);
    expect(outcome.provider).toBe('linkup');
  });
});

describe('brave', () => {
  it('gets with X-Subscription-Token and maps web results', async () => {
    setSearchKeys({ brave: { keys: ['k'] } });
    vi.stubGlobal('fetch', mockFetchJson({
      query: { original: 'q' },
      web: { results: [{ title: 'T', url: 'https://example.com', description: 'D' }] },
    }));

    const outcome = await searchResults('q', 'search', undefined, 5, { country: 'de', language: 'de' });
    const url = new URL(lastRequest!.url);
    expect(`${url.origin}${url.pathname}`).toBe('https://api.search.brave.com/res/v1/web/search');
    expect(url.searchParams.get('q')).toBe('q');
    expect(url.searchParams.get('country')).toBe('DE');
    expect(url.searchParams.get('search_lang')).toBe('de');
    expect(authHeader(lastRequest!.init)['X-Subscription-Token']).toBe('k');
    expect(outcome.results).toMatchObject([{ title: 'T', snippet: 'D' }]);
    expect(outcome.provider).toBe('brave');
  });
});

describe('parallel', () => {
  it('posts objective plus search queries with x-api-key', async () => {
    setSearchKeys({ parallel: { keys: ['k'] } });
    vi.stubGlobal('fetch', mockFetchJson({
      results: [{ url: 'https://example.com', title: 'T', publish_date: '2024-01-15', excerpts: ['e1', 'e2'] }],
    }));

    const outcome = await searchResults('q', 'search', undefined, 5, {});
    expect(lastRequest?.url).toBe('https://api.parallel.ai/v1/search');
    expect(authHeader(lastRequest!.init)['x-api-key']).toBe('k');
    expect(JSON.parse(String(lastRequest!.init.body))).toMatchObject({
      objective: 'q', search_queries: ['q'], max_results: 5,
    });
    expect(outcome.results[0].snippet).toContain('e1');
    expect(outcome.results[0].date).toBe('2024-01-15');
    expect(outcome.provider).toBe('parallel');
  });
});

describe('octen', () => {
  it('posts with x-api-key and reads data.results highlights', async () => {
    setSearchKeys({ octen: { keys: ['k'] } });
    vi.stubGlobal('fetch', mockFetchJson({
      code: 0, msg: 'success',
      data: { query: 'q', results: [{ title: 'T', url: 'https://example.com', highlight: 'H', time_published: '2024-10-15T00:00:00Z' }] },
    }));

    const outcome = await searchResults('q', 'search', undefined, 5, {});
    expect(lastRequest?.url).toBe('https://api.octen.ai/search');
    expect(authHeader(lastRequest!.init)['x-api-key']).toBe('k');
    const body = JSON.parse(String(lastRequest!.init.body));
    expect(body.query).toBe('q');
    expect(body.highlight).toMatchObject({ enable: true });
    expect(outcome.results).toMatchObject([{ title: 'T', snippet: 'H', date: '2024-10-15T00:00:00Z' }]);
    expect(outcome.provider).toBe('octen');
  });

  it('treats a non-zero business code as a failure', async () => {
    setSearchKeys({ octen: { keys: ['k'] } });
    vi.stubGlobal('fetch', mockFetchJson({ code: 400, msg: 'Missing parameter query' }));
    await expect(searchResults('q', 'search', undefined, 5, {})).rejects.toThrow(/Octen API error/);
  });
});

describe('firecrawl', () => {
  it('posts to v2/search and reads data.web', async () => {
    setSearchKeys({ firecrawl: { keys: ['k'] } });
    vi.stubGlobal('fetch', mockFetchJson({
      success: true, data: { web: [{ url: 'https://example.com', title: 'T', description: 'D', position: 1 }] },
    }));

    const outcome = await searchResults('q', 'search', undefined, 3, {});
    expect(lastRequest?.url).toBe('https://api.firecrawl.dev/v2/search');
    expect(authHeader(lastRequest!.init).Authorization).toBe('Bearer k');
    expect(JSON.parse(String(lastRequest!.init.body))).toMatchObject({ query: 'q', limit: 3 });
    expect(outcome.results).toMatchObject([{ title: 'T', snippet: 'D' }]);
    expect(outcome.provider).toBe('firecrawl');
  });

  it('treats success:false as a failure', async () => {
    setSearchKeys({ firecrawl: { keys: ['k'] } });
    vi.stubGlobal('fetch', mockFetchJson({ success: false, error: 'nope' }));
    await expect(searchResults('q', 'search', undefined, 3, {})).rejects.toThrow(/Firecrawl API error/);
  });
});

describe('exa', () => {
  it('posts with highlights and maps them to snippets', async () => {
    setSearchKeys({ exa: { keys: ['k'] } });
    vi.stubGlobal('fetch', mockFetchJson({
      results: [{ title: 'T', url: 'https://example.com', publishedDate: '2023-11-16', highlights: ['h1', 'h2'] }],
    }));

    const outcome = await searchResults('q', 'search', undefined, 5, {});
    expect(lastRequest?.url).toBe('https://api.exa.ai/search');
    expect(authHeader(lastRequest!.init).Authorization).toBe('Bearer k');
    const body = JSON.parse(String(lastRequest!.init.body));
    expect(body.numResults).toBe(5);
    expect(body.contents).toMatchObject({ highlights: true });
    expect(outcome.results[0].snippet).toContain('h1');
    expect(outcome.results[0].date).toBe('2023-11-16');
    expect(outcome.provider).toBe('exa');
  });
});

describe('brightdata', () => {
  it('needs both a key and a zone', async () => {
    setSearchKeys({ brightdata: { keys: ['k'] } });
    expect(isSearchProviderConfigured()).toBe(false);
    await expect(searchResults('q', 'search', undefined, 5, {})).rejects.toBeInstanceOf(SearchProviderNotConfiguredError);
  });

  it('posts the zone plus a Google URL with parsed JSON output', async () => {
    setSearchKeys({ brightdata: { keys: ['k'], zone: 'serp_api1' } });
    vi.stubGlobal('fetch', mockFetchJson({
      query: 'pizza', organic: [{ link: 'https://example.com', title: 'T', description: 'D', global_rank: 1 }],
    }));

    const outcome = await searchResults('pizza', 'search', undefined, 5, {});
    expect(lastRequest?.url).toBe('https://api.brightdata.com/request');
    expect(authHeader(lastRequest!.init).Authorization).toBe('Bearer k');
    const body = JSON.parse(String(lastRequest!.init.body));
    expect(body.zone).toBe('serp_api1');
    expect(body.format).toBe('json');
    expect(String(body.url)).toContain('google.com/search');
    expect(outcome.results).toMatchObject([{ title: 'T', url: 'https://example.com', snippet: 'D' }]);
    expect(outcome.provider).toBe('brightdata');
  });
});

describe('serply', () => {
  it('gets with X-Api-Key and maps results', async () => {
    setSearchKeys({ serply: { keys: ['k'] } });
    vi.stubGlobal('fetch', mockFetchJson({
      query: 'q', results: [{ title: 'T', description: 'D', link: 'https://example.com', position: 1 }],
    }));

    const outcome = await searchResults('q', 'search', undefined, 5, {});
    const url = new URL(lastRequest!.url);
    expect(`${url.origin}${url.pathname}`).toBe('https://api.serply.io/v1/search');
    expect(url.searchParams.get('q')).toBe('q');
    expect(authHeader(lastRequest!.init)['X-Api-Key']).toBe('k');
    expect(outcome.results).toMatchObject([{ title: 'T', snippet: 'D' }]);
    expect(outcome.provider).toBe('serply');
  });
});

describe('valyu', () => {
  it('posts with x-api-key (not Bearer) and web search type', async () => {
    setSearchKeys({ valyu: { keys: ['k'] } });
    vi.stubGlobal('fetch', mockFetchJson({
      success: true, query: 'q', results: [{ title: 'T', url: 'https://example.com', content: 'C' }],
    }));

    const outcome = await searchResults('q', 'search', undefined, 5, {});
    expect(lastRequest?.url).toBe('https://api.valyu.ai/v1/search');
    const headers = authHeader(lastRequest!.init);
    expect(headers['x-api-key']).toBe('k');
    expect(headers.Authorization).toBeUndefined();
    expect(JSON.parse(String(lastRequest!.init.body))).toMatchObject({
      query: 'q', search_type: 'web', max_num_results: 5,
    });
    expect(outcome.results).toMatchObject([{ title: 'T', snippet: 'C' }]);
    expect(outcome.provider).toBe('valyu');
  });

  it('treats success:false as a failure', async () => {
    setSearchKeys({ valyu: { keys: ['k'] } });
    vi.stubGlobal('fetch', mockFetchJson({ success: false, error: 'nope' }));
    await expect(searchResults('q', 'search', undefined, 5, {})).rejects.toThrow(/Valyu API error/);
  });
});

describe('jina', () => {
  it('gets s.jina.ai with Bearer auth and JSON accept', async () => {
    setSearchKeys({ jina: { keys: ['k'] } });
    vi.stubGlobal('fetch', mockFetchJson({
      data: [{ url: 'https://example.com', title: 'T', content: 'C' }],
    }));

    const outcome = await searchResults('q', 'search', undefined, 5, {});
    const url = new URL(lastRequest!.url);
    expect(url.origin).toBe('https://s.jina.ai');
    expect(url.searchParams.get('q')).toBe('q');
    expect(authHeader(lastRequest!.init).Authorization).toBe('Bearer k');
    expect(authHeader(lastRequest!.init).Accept).toBe('application/json');
    expect(outcome.results).toMatchObject([{ title: 'T', snippet: 'C' }]);
    expect(outcome.provider).toBe('jina');
  });
});

describe('registry', () => {
  it('reports nothing configured without keys', async () => {
    setSearchKeys({});
    expect(isSearchProviderConfigured()).toBe(false);
    expect(listSearchProviders()).toEqual([]);
    await expect(searchResults('q', 'search', undefined, 5, {})).rejects.toBeInstanceOf(
      SearchProviderNotConfiguredError,
    );
  });

  it('falls through to the next provider when one fails', async () => {
    setSearchKeys({ serper: { keys: ['bad'] }, tavily: { keys: ['good'] } });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown, init?: RequestInit) => {
        lastRequest = { url: String(url), init: init ?? {} };
        if (String(url).includes('serper')) {
          return { ok: false, status: 500, statusText: 'Error', headers: new Headers(), json: async () => ({}), text: async () => '' } as unknown as Response;
        }
        return {
          ok: true, status: 200, statusText: 'OK', headers: new Headers(),
          json: async () => ({ results: [{ title: 'T', url: 'https://example.com', content: 'C' }] }),
          text: async () => '',
        } as unknown as Response;
      }),
    );

    const outcome = await searchResults('q', 'search', undefined, 5, {});
    expect(outcome.provider).toBe('tavily');
    expect(outcome.results).toHaveLength(1);
  });

  it('fails when every configured provider fails', async () => {
    setSearchKeys({ serper: { keys: ['bad'] } });
    vi.stubGlobal('fetch', mockFetchJson({}, false, 500));
    await expect(searchResults('q', 'search', undefined, 5, {})).rejects.toThrow(/Serper API error/);
  });

  it('applies links depth uniformly by stripping snippets', async () => {
    setSearchKeys({ tavily: { keys: ['k'] } });
    vi.stubGlobal('fetch', mockFetchJson({
      results: [{ title: 'T', url: 'https://example.com', content: 'C' }],
    }));

    const outcome = await searchResults('q', 'search', undefined, 5, { depth: 'links' });
    expect(outcome.results[0].snippet).toBeNull();
  });

  it('applies the configured try order', async () => {
    resetSettingsCache();
    resetSearchProviders();
    const settings = loadSettings();
    settings.searchProviders = { serper: { keys: ['a'] }, tavily: { keys: ['b'] } };
    settings.searchProviderOrder = ['tavily', 'serper'];
    saveSettings(settings);
    vi.stubGlobal('fetch', mockFetchJson({ results: [{ title: 'T', url: 'https://example.com', content: 'C' }] }));

    const outcome = await searchResults('q', 'search', undefined, 5, {});
    expect(outcome.provider).toBe('tavily');
  });
});

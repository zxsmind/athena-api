import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  extractPageContent,
  isBlockedUrl,
  setDnsLookupForTests,
  type DnsRecord,
} from '../src/search/extract.js';
import { resetConfigForTests } from '../src/config/load.js';

const publicDns = async (host: string): Promise<DnsRecord[]> => {
  if (host === 'example.com') return [{ address: '93.184.216.34', family: 4 }];
  if (host === 'internal.example') return [{ address: '10.9.9.9', family: 4 }];
  if (host === 'mixed.example') {
    return [
      { address: '93.184.216.34', family: 4 },
      { address: '192.168.1.7', family: 4 },
    ];
  }
  throw Object.assign(new Error(`ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
};

function htmlResponse(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Redirect',
    headers: new Headers({ 'content-type': 'text/html', ...headers }),
    text: async () => body,
    arrayBuffer: async () => new ArrayBuffer(0),
  } as unknown as Response;
}

beforeEach(() => {
  resetConfigForTests();
  setDnsLookupForTests(publicDns);
  vi.unstubAllGlobals();
});

afterEach(() => {
  setDnsLookupForTests(null);
  vi.unstubAllGlobals();
});

describe('isBlockedUrl', () => {
  it.each([
    'http://127.0.0.1/',
    'http://0x7f.0.0.1/',
    'http://2130706433/',
    'http://0177.0.0.1/',
    'http://127.1/',
    'http://10.0.0.5/',
    'http://192.168.1.1/',
    'http://169.254.169.254/',
    'http://[::1]/',
    'http://localhost:3000/',
    'http://metadata.google.internal/',
    'ftp://example.com/file',
  ])('blocks %s', (url) => {
    expect(isBlockedUrl(url)).toBe(true);
  });

  it.each([
    'https://example.com/',
    'http://93.184.216.34/',
  ])('allows %s', (url) => {
    expect(isBlockedUrl(url)).toBe(false);
  });
});

describe('extractPageContent redirects', () => {
  it('refuses a redirect into an internal address', async () => {
    const seen: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      seen.push(String(url));
      if (String(url).includes('example.com')) {
        return htmlResponse('', 302, { location: 'http://127.0.0.1/secret' });
      }
      return htmlResponse('<html><body>never</body></html>');
    }));

    const out = await extractPageContent('https://example.com/go');
    expect(out.error).toMatch(/internal/);
    /* The internal hop was never requested. */
    expect(seen).toEqual(['https://example.com/go']);
  });

  it('refuses a name that resolves to an internal address', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => htmlResponse('<html><body>x</body></html>')));
    const out = await extractPageContent('https://internal.example/');
    expect(out.error).toMatch(/internal address 10\.9\.9\.9/);
  });

  it('rejects a mixed public/private record set whole', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => htmlResponse('<html><body>x</body></html>')));
    const out = await extractPageContent('https://mixed.example/');
    expect(out.error).toMatch(/internal address/);
  });

  it('follows a public redirect chain', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      if (String(url) === 'https://example.com/a') {
        return htmlResponse('', 301, { location: '/b' });
      }
      return htmlResponse('<html><head><title>T</title></head><body>hello world</body></html>');
    }));
    setDnsLookupForTests(async () => [{ address: '93.184.216.34', family: 4 }]);

    const out = await extractPageContent('https://example.com/a');
    expect(out.error).toBeUndefined();
    expect(out.content).toContain('hello world');
  });
});

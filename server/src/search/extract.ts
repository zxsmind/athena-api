import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import { getConfig } from '../config/load.js';
import { signalWithTimeout } from './http.js';

const BLOCKED_HOSTS = [
  'localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]',
  '10.', '172.16.', '172.17.', '172.18.', '172.19.', '172.20.', '172.21.', '172.22.', '172.23.', '172.24.', '172.25.', '172.26.', '172.27.', '172.28.', '172.29.', '172.30.', '172.31.',
  '192.168.',
  '169.254.',
  '100.64.', '100.65.', '100.66.', '100.67.', '100.68.', '100.69.', '100.70.', '100.71.', '100.72.', '100.73.', '100.74.', '100.75.', '100.76.', '100.77.', '100.78.', '100.79.', '100.80.', '100.81.', '100.82.', '100.83.', '100.84.', '100.85.', '100.86.', '100.87.', '100.88.', '100.89.', '100.90.', '100.91.', '100.92.', '100.93.', '100.94.', '100.95.', '100.96.', '100.97.', '100.98.', '100.99.', '100.100.', '100.101.', '100.102.', '100.103.', '100.104.', '100.105.', '100.106.', '100.107.', '100.108.', '100.109.', '100.110.', '100.111.', '100.112.', '100.113.', '100.114.', '100.115.', '100.116.', '100.117.', '100.118.', '100.119.', '100.120.', '100.121.', '100.122.', '100.123.', '100.124.', '100.125.', '100.126.', '100.127.',
  'metadata.google.internal', '169.254.169.254',
];

/**
 * Extraction never touches loopback, private, or cloud-metadata addresses.
 * Any new fetch behavior must go through this check.
 */
export function isBlockedUrl(urlString: string): boolean {
  try {
    const url = new URL(urlString);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return true;
    const hostname = url.hostname.toLowerCase();
    return BLOCKED_HOSTS.some(blocked => hostname === blocked || hostname.startsWith(blocked) || hostname.endsWith(blocked));
  } catch {
    return true;
  }
}

export async function extractPageContent(
  url: string,
  signal?: AbortSignal,
): Promise<{ title: string; content: string; error?: string }> {
  if (isBlockedUrl(url)) {
    return { title: url, content: '', error: 'Blocked URL: internal or private addresses are not allowed' };
  }

  try {
    const { signal: timeoutSignal, clean } = signalWithTimeout(signal, getConfig().search.requestTimeoutMs);

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
      const contentLength = Number(res.headers.get('content-length') ?? 0);
      if (contentLength > 5 * 1024 * 1024) {
        return { title: url, content: '', error: 'Page exceeds the 5 MiB extraction limit' };
      }
      const isPdf = contentType.includes('application/pdf') || url.toLowerCase().match(/\.pdf($|[?#])/);
      if (isPdf) {
        try {
          const { PDFParse } = await import('pdf-parse');
          const ab = await res.arrayBuffer();
          const u8 = new Uint8Array(ab);
          const parser = new PDFParse(u8);
          const data = await parser.getText();
          const text = (data?.text || '').trim();
          return { title: url, content: text.slice(0, getConfig().search.extractionContextChars) || '[PDF text was empty]' };
        } catch (pdfErr: unknown) {
          return {
            title: url,
            content: '',
            error: `PDF parse failed: ${(pdfErr as Error).message}`,
          };
        }
      }

      const html = await res.text();
      if (Buffer.byteLength(html, 'utf8') > 5 * 1024 * 1024) {
        return { title: url, content: '', error: 'Page exceeds the 5 MiB extraction limit' };
      }
      const { document } = parseHTML(html);
      const article = new Readability(document).parse();
      const title = article?.title?.trim() || document.querySelector('title')?.textContent?.trim() || url;
      const content = (article?.textContent || document.body?.textContent || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 12_000);
      return { title, content: content || '[No readable page text found]' };
    } finally {
      clean();
    }
  } catch (err: unknown) {
    // AbortError from user cancellation should propagate
    if (signal?.aborted) throw err;
    return {
      title: url,
      content: '',
      error: (err as Error).message || 'Page extraction failed',
    };
  }
}

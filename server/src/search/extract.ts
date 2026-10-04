import { isIP } from 'node:net';
import { lookup as systemLookup } from 'node:dns/promises';
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import { getConfig } from '../config/load.js';
import { signalWithTimeout } from './http.js';

const BLOCKED_HOSTNAMES = [
  'localhost',
  'metadata.google.internal',
];

/** Suffixes blocked with their subdomains (`evil.example` covers `a.evil.example`). */
const BLOCKED_SUFFIXES = [
  '.localhost',
  '.internal',
  '.local',
  '.lan',
  '.home',
  '.corp',
  '.metadata.google.internal',
];

const MAX_REDIRECTS = 5;
const DNS_TIMEOUT_MS = 5_000;

/** Injectable resolver; production uses the system DNS. */
export interface DnsRecord {
  address: string;
  family: number;
}
let dnsLookup: (host: string) => Promise<DnsRecord[]> = (host) =>
  systemLookup(host, { all: true, verbatim: true });
/** Overrides the DNS resolver; used in tests. */
export function setDnsLookupForTests(fn: ((host: string) => Promise<DnsRecord[]>) | null): void {
  dnsLookup = fn ?? ((host) => systemLookup(host, { all: true, verbatim: true }));
}

/** One numeric part in decimal, hex (`0x..`), or octal (`0..`) form. */
function parseNumericPart(part: string, max: number): number | null {
  let value: number;
  if (/^0x[0-9a-f]+$/i.test(part)) value = parseInt(part, 16);
  else if (/^0[0-9]+$/.test(part)) {
    if (!/^[0-7]+$/.test(part.slice(1)) && part.length > 1) return null;
    value = parseInt(part, 8);
  } else if (/^[0-9]+$/.test(part)) value = parseInt(part, 10);
  else return null;
  return Number.isSafeInteger(value) && value >= 0 && value <= max ? value : null;
}

/**
 * `inet_aton` number forms to dotted canonical: `2130706433`, `0x7f.0.0.1`,
 * `0177.0.0.1`, `127.1` all mean 127.0.0.1. Null when not numeric.
 */
function numericHostnameToIpv4(host: string): string | null {
  if (!/^[0-9a-fx.]+$/i.test(host)) return null;
  const parts = host.split('.');
  if (parts.length < 1 || parts.length > 4) return null;
  const widths = parts.length === 1 ? [32] : parts.length === 2 ? [8, 24] : parts.length === 3 ? [8, 8, 16] : [8, 8, 8, 8];
  let full = 0;
  for (let i = 0; i < parts.length; i += 1) {
    const max = 2 ** widths[i] - 1;
    const value = parseNumericPart(parts[i], max);
    if (value === null) return null;
    full = full * 2 ** widths[i] + value;
  }
  if (full > 0xffffffff) return null;
  return [(full >>> 24) & 255, (full >>> 16) & 255, (full >>> 8) & 255, full & 255].join('.');
}

function ipv4Blocked(dotted: string): boolean {
  const bytes = dotted.split('.').map(Number);
  if (bytes.length !== 4 || bytes.some((b) => !Number.isInteger(b) || b < 0 || b > 255)) return true;
  const [a, b] = bytes;
  return a === 0 || a === 10 || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 0 || b === 2 || b === 88 || b === 168))
    || (a === 198 && (b === 18 || b === 19 || b === 51))
    || (a === 203 && b === 0)
    || a >= 224;
}

function ipv6Blocked(address: string): boolean {
  const lower = address.toLowerCase().split('%')[0] ?? '';
  if (lower === '::1' || lower === '::') return true;
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return ipv4Blocked(mapped[1]);
  if (isIP(lower) !== 6) return true;
  return lower.startsWith('fc') || lower.startsWith('fd')
    || /^fe[89ab]/.test(lower)
    || lower.startsWith('ff')
    || lower === '64:ff9b::'
    || lower.startsWith('64:ff9b::')
    || lower.startsWith('2001:db8:');
}

/** Literal/numeric checks on one hostname. True means "do not fetch". */
function isBlockedLiteral(host: string): boolean {
  /* WHATWG keeps IPv6 brackets on .hostname (`[::1]`); strip them first so a
     public literal is not mistaken for an unparseable name. */
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  const numeric = numericHostnameToIpv4(bare);
  if (numeric) return ipv4Blocked(numeric);
  if (isIP(bare) === 4) return ipv4Blocked(bare);
  if (isIP(bare) === 6 || bare.includes(':')) return ipv6Blocked(bare);
  return false;
}

/** True when the host is an IP literal in any form (after bracket strip). */
function isIpLiteral(host: string): boolean {
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  return numericHostnameToIpv4(bare) !== null || isIP(bare) !== 0;
}

/**
 * Static hostname check, no network. Catches literals in any radix plus the
 * well-known internal names; DNS-owning attackers (rebinding, odd records)
 * are caught per-hop by {@link assertResolvablePublic}.
 */
export function isBlockedUrl(urlString: string): boolean {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return true;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return true;
  const host = url.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.includes(host)) return true;
  if (BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  return isBlockedLiteral(host);
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Fail-closed DNS check: every address the name resolves to must be public.
 * `fetch` follows redirects on its own and connects wherever they point, so
 * each hop is validated here before it is requested. A record set that mixes
 * public and private addresses (the DNS-rebinding shape) is rejected whole.
 * Residual risk: a name whose records change between this check and connect
 * (short-TTL swap). Killing that needs connection pinning, which plain fetch
 * cannot do; the redirect chain and literal checks above still hold.
 */
async function assertResolvablePublic(host: string): Promise<void> {
  if (isBlockedLiteral(host)) throw new Error(`Blocked URL: internal address ${host}`);
  /* A public literal needs no DNS round-trip; it was range-checked above. */
  if (isIpLiteral(host)) return;
  let addresses: DnsRecord[];
  try {
    addresses = await withTimeout(dnsLookup(host), DNS_TIMEOUT_MS, `DNS lookup timed out for ${host}`);
  } catch (err) {
    throw new Error(`Blocked URL: cannot resolve ${host} (${(err as Error).message})`);
  }
  if (addresses.length === 0) throw new Error(`Blocked URL: ${host} resolves to nothing`);
  for (const record of addresses) {
    const ip = record.address;
    const blocked = record.family === 6 ? ipv6Blocked(ip) : ipv4Blocked(ip);
    if (blocked) throw new Error(`Blocked URL: ${host} resolves to internal address ${ip}`);
  }
}

async function assertFetchableUrl(urlString: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    throw new Error('Blocked URL: not a valid http(s) URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Blocked URL: only http(s) fetch is allowed');
  }
  const host = url.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.includes(host)) throw new Error(`Blocked URL: internal hostname ${host}`);
  if (BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    throw new Error(`Blocked URL: internal hostname ${host}`);
  }
  await assertResolvablePublic(url.hostname);
  return url;
}

export async function extractPageContent(
  url: string,
  signal?: AbortSignal,
): Promise<{ title: string; content: string; error?: string }> {
  let current: URL;
  try {
    current = await assertFetchableUrl(url);
  } catch (err: unknown) {
    return { title: url, content: '', error: (err as Error).message };
  }

  try {
    const { signal: timeoutSignal, clean } = signalWithTimeout(signal, getConfig().search.requestTimeoutMs);

    /* Redirects are followed by hand, not by fetch: each hop is validated
       like the first URL, so a `/go?u=...` shortener cannot smuggle an
       internal address past the initial check. */
    let res: Response | null = null;
    try {
      for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        const attempt = await fetch(current.toString(), {
          signal: timeoutSignal,
          redirect: 'manual',
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ATHENA/1.0)' },
        });
        const location = attempt.headers.get('location');
        if (attempt.status >= 300 && attempt.status < 400 && location) {
          await attempt.arrayBuffer().catch(() => undefined);
          if (hop === MAX_REDIRECTS) {
            return { title: url, content: '', error: `Too many redirects (over ${MAX_REDIRECTS})` };
          }
          try {
            current = await assertFetchableUrl(new URL(location, current).toString());
          } catch (err: unknown) {
            return { title: url, content: '', error: (err as Error).message };
          }
          continue;
        }
        res = attempt;
        break;
      }
      if (!res) return { title: url, content: '', error: 'No response from page' };

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

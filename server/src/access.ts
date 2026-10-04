import { isIP } from 'node:net';
import type { Request } from 'express';
import { getConfig } from './config/load.js';

function isLoopbackAddress(address: string): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function isPrivateIpv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [first, second] = parts;
  return first === 10
    || first === 127
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || (first === 169 && second === 254)
    || (first === 100 && second >= 64 && second <= 127)
    || first === 0;
}

function isPrivateIpv6(address: string): boolean {
  const normalized = address.toLowerCase().split('%')[0] ?? '';
  return normalized === '::1'
    || normalized.startsWith('fc')
    || normalized.startsWith('fd')
    || /^fe[89ab]/.test(normalized);
}

function ipv4ToInt(address: string): number | null {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return ((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3];
}

/** True for an exact IP or an IPv4 CIDR entry. IPv6 trusts exact matches only. */
function proxyMatches(entry: string, peer: string): boolean {
  const normalized = entry.trim();
  if (!normalized.includes('/')) return normalized.toLowerCase() === peer.toLowerCase();
  const [base, bitsRaw] = normalized.split('/');
  const bits = Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const baseInt = ipv4ToInt(base);
  const peerInt = ipv4ToInt(peer);
  if (baseInt === null || peerInt === null) return false;
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return ((baseInt & mask) >>> 0) === ((peerInt & mask) >>> 0);
}

function isTrustedProxy(peer: string, trusted: readonly string[]): boolean {
  return trusted.some((entry) => proxyMatches(entry, peer));
}

/**
 * The address auth decisions use. By default the socket peer: headers are
 * sender-controlled and never believed. Only when the peer itself is a
 * configured `server.trustedProxies` entry is X-Forwarded-For consulted, and
 * then the chain is walked from the server side — every trusted hop is
 * stripped and the first untrusted address is the client. A spoofed header
 * from a direct connection is ignored entirely.
 */
export function clientAddress(req: Request): string {
  const peer = req.socket.remoteAddress ?? '';
  const trusted = getConfig().server.trustedProxies ?? [];
  if (!isTrustedProxy(peer, trusted)) return peer;
  const header = req.header('x-forwarded-for');
  if (!header) return peer;
  const chain = header.split(',').map((part) => part.trim()).filter((part) => part.length > 0);
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    if (!isTrustedProxy(chain[i], trusted)) return chain[i];
  }
  return chain[0] ?? peer;
}

export function isLocalManagementRequest(req: Request): boolean {
  const address = clientAddress(req);
  if (isLoopbackAddress(address)) return true;
  const ipv4Mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1];
  const candidate = ipv4Mapped ?? address;
  const version = isIP(candidate);
  if (version === 4) return isPrivateIpv4(candidate);
  if (version === 6) return isPrivateIpv6(candidate);
  return false;
}

export function isLoopbackRequest(req: Request): boolean {
  return isLoopbackAddress(clientAddress(req));
}

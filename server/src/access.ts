import { isIP } from 'node:net';
import type { Request } from 'express';

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

export function isLocalManagementRequest(req: Request): boolean {
  const address = req.socket.remoteAddress ?? '';
  if (isLoopbackAddress(address)) return true;
  const ipv4Mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1];
  const candidate = ipv4Mapped ?? address;
  const version = isIP(candidate);
  if (version === 4) return isPrivateIpv4(candidate);
  if (version === 6) return isPrivateIpv6(candidate);
  return false;
}

export function isLoopbackRequest(req: Request): boolean {
  return isLoopbackAddress(req.socket.remoteAddress ?? '');
}

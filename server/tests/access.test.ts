import { afterEach, describe, expect, it } from 'vitest';
import type { Request } from 'express';
import { clientAddress, isLocalManagementRequest, isLoopbackRequest } from '../src/access.js';
import { defaultConfig } from '../src/config/defaults.js';
import { resetConfigForTests, setConfig } from '../src/config/load.js';

function req(peer: string, xff?: string): Request {
  return {
    socket: { remoteAddress: peer },
    header: (name: string) => (name.toLowerCase() === 'x-forwarded-for' ? xff : undefined),
  } as unknown as Request;
}

function trust(proxies: string[]): void {
  setConfig({ ...defaultConfig, server: { ...defaultConfig.server, trustedProxies: proxies } });
}

afterEach(() => {
  resetConfigForTests();
});

describe('client address', () => {
  it('uses the socket peer when no proxy is trusted', () => {
    /* A spoofed header from a direct connection is ignored entirely. */
    expect(clientAddress(req('203.0.113.7', '127.0.0.1'))).toBe('203.0.113.7');
    expect(isLoopbackRequest(req('203.0.113.7', '127.0.0.1'))).toBe(false);
  });

  it('walks the forwarded chain from the server side', () => {
    trust(['127.0.0.1']);
    /* nginx appended itself last; the client is the first untrusted hop. */
    expect(clientAddress(req('127.0.0.1', '203.0.113.7, 127.0.0.1'))).toBe('203.0.113.7');
    expect(isLoopbackRequest(req('127.0.0.1', '203.0.113.7, 127.0.0.1'))).toBe(false);
  });

  it('sees a local client through a trusted proxy', () => {
    trust(['127.0.0.1']);
    expect(clientAddress(req('127.0.0.1', '192.168.1.20, 127.0.0.1'))).toBe('192.168.1.20');
    expect(isLocalManagementRequest(req('127.0.0.1', '192.168.1.20, 127.0.0.1'))).toBe(true);
  });

  it('matches CIDR ranges', () => {
    trust(['10.0.0.0/8']);
    expect(clientAddress(req('10.4.5.6', '203.0.113.7, 10.4.5.6'))).toBe('203.0.113.7');
    /* Same header from an untrusted peer: ignored. */
    expect(clientAddress(req('203.0.113.9', '192.168.1.20, 10.4.5.6'))).toBe('203.0.113.9');
  });

  it('ignores a malformed CIDR instead of trusting', () => {
    trust(['10.0.0.0/99']);
    expect(clientAddress(req('10.4.5.6', '127.0.0.1'))).toBe('10.4.5.6');
  });
});

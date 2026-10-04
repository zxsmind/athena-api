import { describe, expect, it } from 'vitest';
import { defaultConfig, validateConfig } from '../src/config/defaults.js';

describe('logging defaults', () => {
  it('writes the log file and echoes to stdout by default', () => {
    expect(defaultConfig.logging.file).toBe('athena.log');
    expect(defaultConfig.logging.echoToStdout).toBe(true);
  });

  it('caps a single log file at ten megabytes', () => {
    expect(defaultConfig.logging.maxFileBytes).toBe(10 * 1024 * 1024);
  });

  it('keeps a few rotated files', () => {
    expect(defaultConfig.logging.keepFiles).toBe(3);
  });
});

describe('catalog defaults', () => {
  it('refreshes the models.dev catalog every twelve hours', () => {
    expect(defaultConfig.catalog.refreshIntervalHours).toBe(12);
  });
});

describe('server defaults', () => {
  it('binds 0.0.0.0 on port 39921', () => {
    expect(defaultConfig.server.host).toBe('0.0.0.0');
    expect(defaultConfig.server.port).toBe(39921);
  });

  it('trusts no proxy headers by default', () => {
    expect(defaultConfig.server.trustedProxies).toEqual([]);
  });
});

describe('plan defaults', () => {
  it('matches the agreed concurrency ceilings', () => {
    expect(defaultConfig.plans.free.maxConcurrentJobs).toBe(5);
    expect(defaultConfig.plans.paid.maxConcurrentJobs).toBe(20);
    expect(defaultConfig.plans.enterprise.maxConcurrentJobs).toBe(100);
  });

  it('leaves enterprise rate unlimited', () => {
    expect(defaultConfig.plans.enterprise.requestsPerSecond).toBeNull();
    expect(defaultConfig.plans.enterprise.requestsPerMinute).toBeNull();
  });
});

describe('validateConfig', () => {
  it('rejects a non-positive catalog interval', () => {
    expect(() => validateConfig({ ...defaultConfig, catalog: { refreshIntervalHours: 0 } })).toThrow();
  });

  it('rejects a non-positive log cap', () => {
    expect(() => validateConfig({ ...defaultConfig, logging: { ...defaultConfig.logging, maxFileBytes: 0 } })).toThrow();
  });
});

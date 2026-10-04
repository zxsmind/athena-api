import { describe, expect, it } from 'vitest';
import { defaultConfig, validateConfig } from '../src/config/defaults.js';

describe('sandbox defaults', () => {
  it('stays off until the phase gates pass', () => {
    expect(defaultConfig.sandbox.enabled).toBe(false);
  });

  it('defaults to the backend P0 selected', () => {
    expect(defaultConfig.sandbox.backend).toBe('pyodide');
  });

  it('caps one program at a minute and the returned text at 8k characters', () => {
    expect(defaultConfig.sandbox.timeoutMs).toBe(60_000);
    expect(defaultConfig.sandbox.maxOutputChars).toBe(8_000);
  });
});

describe('sandbox validation', () => {
  it('rejects a backend that was not measured', () => {
    expect(() => validateConfig({ ...defaultConfig, sandbox: { ...defaultConfig.sandbox, backend: 'vm' } })).toThrow();
  });

  it('rejects a non-positive execution timeout', () => {
    expect(() => validateConfig({ ...defaultConfig, sandbox: { ...defaultConfig.sandbox, timeoutMs: 0 } })).toThrow();
  });
});

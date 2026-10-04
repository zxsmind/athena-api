import { describe, expect, it } from 'vitest';
import { ApiPlatformStore, KEY_NAME_PATTERN, KEY_NAME_MAX_LENGTH, normalizeKeyName } from '../src/api-platform-store.js';
import { checkKeyName } from '../src/cli/admin.js';

describe('normalizeKeyName', () => {
  it('accepts uppercase letters, digits, and spaces', () => {
    expect(normalizeKeyName('Acme Production Key 01')).toBe('Acme Production Key 01');
  });

  it('collapses repeated spaces and trims the ends', () => {
    expect(normalizeKeyName('  Acme   Key  ')).toBe('Acme Key');
  });

  it('accepts inner punctuation that reads well in a terminal', () => {
    expect(normalizeKeyName("Team's Key_01 @eu+west&north")).toBe("Team's Key_01 @eu+west&north");
  });

  it('rejects an empty or whitespace-only name', () => {
    expect(normalizeKeyName('')).toBeNull();
    expect(normalizeKeyName('   ')).toBeNull();
  });

  it('trims a leading space instead of rejecting the name', () => {
    expect(normalizeKeyName(' key')).toBe('key');
  });

  it('collapses newlines and tabs into single spaces', () => {
    expect(normalizeKeyName('key\nsecond')).toBe('key second');
    expect(normalizeKeyName('key\tsecond')).toBe('key second');
  });

  it('rejects a name that starts with punctuation', () => {
    expect(normalizeKeyName('-key')).toBeNull();
    expect(normalizeKeyName('/key')).toBeNull();
  });

  it('rejects embedded control characters that are not whitespace', () => {
    expect(normalizeKeyName('key\u0000second')).toBeNull();
    expect(normalizeKeyName('key\u0007bell')).toBeNull();
  });

  it('rejects names longer than the limit', () => {
    expect(normalizeKeyName('a'.repeat(KEY_NAME_MAX_LENGTH))).toBe('a'.repeat(KEY_NAME_MAX_LENGTH));
    expect(normalizeKeyName('a'.repeat(KEY_NAME_MAX_LENGTH + 1))).toBeNull();
  });

  it('exposes the rule for reuse', () => {
    expect(KEY_NAME_PATTERN.test('Key 1')).toBe(true);
    expect(KEY_NAME_PATTERN.test('Key/1')).toBe(true);
    expect(KEY_NAME_PATTERN.test('Key:1')).toBe(false);
  });
});

describe('checkKeyName', () => {
  it('returns null for a valid name and a message otherwise', () => {
    expect(checkKeyName('Acme Key 01')).toBeNull();
    expect(checkKeyName('')).toMatch(/required/i);
  });
});

describe('createApiKey name requirement', () => {
  it('stores the normalized name and refuses an empty one', () => {
    const store = new ApiPlatformStore(':memory:');
    try {
      const { record } = store.createApiKey('  Acme   Key 01 ', 'paid');
      expect(record.name).toBe('Acme Key 01');
      expect(record.plan).toBe('paid');
      expect(() => store.createApiKey('   ', 'free')).toThrow(/name is required/i);
    } finally {
      store.close();
    }
  });
});

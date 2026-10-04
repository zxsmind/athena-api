/**
 * Round-robin key rotation. Keys are read fresh on every call through
 * `readKeys`, so a settings change takes effect without a restart and no stale
 * snapshot can serve a removed key. `reset` only rewinds the counter.
 */
export interface KeyRing {
  next(): string;
  reset(): void;
}

export function createKeyRing(readKeys: () => string[]): KeyRing {
  let index = 0;
  return {
    next(): string {
      const keys = readKeys().filter((key) => typeof key === 'string' && key.length > 0);
      if (keys.length === 0) return '';
      const key = keys[index % keys.length];
      index += 1;
      return key;
    },
    reset(): void {
      index = 0;
    },
  };
}

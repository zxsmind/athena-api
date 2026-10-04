import { describe, expect, it } from 'vitest';
import { extractThinkBlockText } from '../src/llm.js';

describe('extractThinkBlockText', () => {
  it('keeps embedded deliberation that never had a field of its own', () => {
    expect(extractThinkBlockText('plain text')).toBeNull();
    expect(extractThinkBlockText('Answer <think>because reasons</think> done')).toBe('because reasons');
  });

  it('joins several blocks and takes an unclosed tail', () => {
    expect(extractThinkBlockText('<think>first</think> mid <think>second')).toBe('first\n\nsecond');
  });

  it('ignores empty blocks', () => {
    expect(extractThinkBlockText('<think>   </think>ok')).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { temperatureForRound } from '../src/engine/history.js';

describe('sampling temperature', () => {
  it('is fixed for every round, with no environment lever', () => {
    /* Near-greedy sampling starves exploration: at 0.1 the likeliest
       continuation of partial evidence is the answer. The constant follows
       the thinking-model spec, and no env var may silently move it. */
    expect(temperatureForRound(0)).toBe(1);
    expect(temperatureForRound(7)).toBe(1);
    /* The old env lever is gone: even set, it must not move the constant. */
    process.env.ATHENA_TEMPERATURE = '0.1';
    try {
      expect(temperatureForRound(3)).toBe(1);
    } finally {
      delete process.env.ATHENA_TEMPERATURE;
    }
  });
});

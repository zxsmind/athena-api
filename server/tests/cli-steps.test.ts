import { describe, expect, it } from 'vitest';
import { BACK_CHOICE, BACK_LABEL, applyStep, createStepMachine } from '../src/cli/steps.js';

const STEPS = ['server', 'llm', 'search', 'review'] as const;

describe('createStepMachine', () => {
  it('starts on the first step', () => {
    const m = createStepMachine(STEPS);
    expect(m.current).toBe('server');
    expect(m.atStart).toBe(true);
  });

  it('walks forward through every step', () => {
    const m = createStepMachine(STEPS);
    expect(m.next()).toBe('continue');
    expect(m.current).toBe('llm');
    expect(m.next()).toBe('continue');
    expect(m.current).toBe('search');
    expect(m.next()).toBe('continue');
    expect(m.current).toBe('review');
    expect(m.next()).toBe('finish');
  });

  it('walks backward', () => {
    const m = createStepMachine(STEPS);
    m.next();
    m.next();
    expect(m.current).toBe('search');
    expect(m.back()).toBe('continue');
    expect(m.current).toBe('llm');
    expect(m.back()).toBe('continue');
    expect(m.current).toBe('server');
  });

  it('aborts when going back from the first step', () => {
    const m = createStepMachine(STEPS);
    expect(m.back()).toBe('abort');
    expect(m.current).toBe('server');
  });

  it('is no longer at the start after moving', () => {
    const m = createStepMachine(STEPS);
    m.next();
    expect(m.atStart).toBe(false);
  });

  it('jumps to a step and clamps out-of-range targets', () => {
    const m = createStepMachine(STEPS);
    m.goto(2);
    expect(m.current).toBe('search');
    m.goto(99);
    expect(m.current).toBe('review');
    m.goto(-5);
    expect(m.current).toBe('server');
  });

  it('honours a starting index', () => {
    const m = createStepMachine(STEPS, 2);
    expect(m.current).toBe('search');
  });

  it('refuses an empty step list', () => {
    expect(() => createStepMachine([])).toThrow();
  });

  it('can revisit a step after moving forward again', () => {
    const m = createStepMachine(STEPS);
    m.next();
    m.next();
    m.back();
    m.next();
    expect(m.current).toBe('search');
  });
});

describe('applyStep', () => {
  it('advances on next', () => {
    const m = createStepMachine(STEPS);
    expect(applyStep(m, 'next')).toBe('continue');
    expect(m.current).toBe('llm');
  });

  it('goes back on back', () => {
    const m = createStepMachine(STEPS);
    m.next();
    m.next();
    expect(applyStep(m, 'back')).toBe('continue');
    expect(m.current).toBe('llm');
  });

  it('reports abort when back is impossible', () => {
    const m = createStepMachine(STEPS);
    expect(applyStep(m, 'back')).toBe('abort');
  });
});

describe('back affordance', () => {
  it('uses a sentinel that cannot collide with a real choice', () => {
    expect(BACK_CHOICE).toBe('__back__');
    expect(BACK_CHOICE.startsWith('__')).toBe(true);
  });

  it('has a label', () => {
    expect(BACK_LABEL).toMatch(/back/i);
  });
});
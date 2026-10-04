/**
 * Minimal step machine for the setup wizard.
 *
 * The library in use ignores the Escape key, so back navigation is offered as an
 * explicit choice in list prompts instead. The machine holds no terminal state
 * of its own, which keeps the flow testable without a TTY.
 */

/** Sentinel choice value that means "return to the previous step". */
export const BACK_CHOICE = '__back__';

export type StepResult = 'next' | 'back';

export type StepMove = 'continue' | 'finish' | 'abort';

export interface StepMachine<T> {
  readonly steps: readonly T[];
  readonly current: T;
  /** True on the first step, where there is nothing to go back to. */
  readonly atStart: boolean;
  /** Advances one step, or reports the wizard is finished. */
  next(): StepMove;
  /** Goes back one step, or aborts when already at the first step. */
  back(): StepMove;
  /** Jumps to a step by index, clamped to the valid range. */
  goto(index: number): void;
}

export function createStepMachine<T>(steps: readonly T[], startIndex = 0): StepMachine<T> {
  if (steps.length === 0) throw new Error('a step machine needs at least one step');
  let index = Math.min(Math.max(startIndex, 0), steps.length - 1);

  return {
    steps,
    get current() { return steps[index]; },
    get atStart() { return index === 0; },
    next() {
      index += 1;
      return index >= steps.length ? 'finish' : 'continue';
    },
    back() {
      if (index === 0) return 'abort';
      index -= 1;
      return 'continue';
    },
    goto(target) {
      index = Math.min(Math.max(target, 0), steps.length - 1);
    },
  };
}

/**
 * Applies a step's outcome to the machine. Anything other than an explicit
 * `back` advances, which keeps call sites free of branching.
 */
export function applyStep(machine: StepMachine<unknown>, result: StepResult): StepMove {
  return result === 'back' ? machine.back() : machine.next();
}

/** Label for the back choice, so every prompt offers it identically. */
export const BACK_LABEL = '← Back to the previous step';
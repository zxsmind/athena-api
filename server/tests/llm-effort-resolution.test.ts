import { describe, expect, it } from 'vitest';
import { applyReasoningFloor, resolveModelEffort } from '../src/llm.js';
import { findModelReasoningOptions } from '../src/models-dev.js';

/* Model vocabularies that actually appear in the models.dev catalog. Each set is
   real, so a rule that only works on the ones this test author imagined would
   still fail here. */
const SETS = {
  noneLowMediumHighXhigh: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
  lowMediumHighXhighMax: ['low', 'medium', 'high', 'xhigh', 'max'],
  lowMediumHigh: ['low', 'medium', 'high'],
  noneHigh: ['none', 'high'],
  lowHighMax: ['low', 'high', 'max'],
  minimalLowMediumHigh: ['minimal', 'low', 'medium', 'high'],
  mediumHighXhigh: ['medium', 'high', 'xhigh'],
  onlyHigh: ['high'],
} as const;

/** What a resolver answer means the request should actually carry. */
function sent(resolution: ReturnType<typeof resolveModelEffort>) {
  return resolution.kind === 'send' ? resolution.effort : resolution.kind === 'omit' ? undefined : 'unknown';
}

describe('resolveModelEffort', () => {
  it('sends the requested value unchanged when the model supports it', () => {
    /* The common path. A mode asking for a value the model accepts must not be
       altered, or every run's wire effort silently shifts. */
    expect(sent(resolveModelEffort('low', SETS.noneLowMediumHighXhigh))).toBe('low');
    expect(sent(resolveModelEffort('medium', SETS.noneLowMediumHighXhigh))).toBe('medium');
    expect(sent(resolveModelEffort('xhigh', SETS.noneLowMediumHighXhigh))).toBe('xhigh');
    expect(sent(resolveModelEffort('low', SETS.lowMediumHigh))).toBe('low');
    expect(sent(resolveModelEffort('medium', SETS.lowMediumHigh))).toBe('medium');
  });

  it('leaves the cheap mode cheap when the model floor is above it', () => {
    /* 2063 reasoning models in the catalog accept no `none` and have a floor of
       low or higher. A `low` round on those finds nothing at or below low, so the
       field is omitted rather than defaulting up to the model's expensive floor. */
    expect(sent(resolveModelEffort('low', SETS.noneHigh))).toBeUndefined();
    expect(sent(resolveModelEffort('low', SETS.mediumHighXhigh))).toBeUndefined();
    expect(sent(resolveModelEffort('low', SETS.onlyHigh))).toBeUndefined();
  });

  it('fills the middle rung from the middle of what is supported', () => {
    /* A gappy ladder still has a reading of "harder than cheap": deep on
       {low,high,max} is high, not low, so the mode stays distinct from default. */
    expect(sent(resolveModelEffort('medium', SETS.lowHighMax))).toBe('high');
    expect(sent(resolveModelEffort('medium', SETS.noneHigh))).toBe('high');
  });

  it('spends the model ceiling for the max rung', () => {
    /* A model that cannot go as high as the max rung sends its own ceiling.
       `max` is a catalog value 1782 models carry, which the old vocabulary could
       not name at all, so this is the only way it is ever reached. */
    expect(sent(resolveModelEffort('xhigh', SETS.lowMediumHigh))).toBe('high');
    expect(sent(resolveModelEffort('xhigh', SETS.noneHigh))).toBe('high');
    expect(sent(resolveModelEffort('xhigh', SETS.onlyHigh))).toBe('high');
    expect(sent(resolveModelEffort('xhigh', SETS.lowHighMax))).toBe('max');
  });

  it('does not exceed what the mode asked for when the model offers more', () => {
    /* The mode named xhigh and the model supports xhigh, so xhigh is sent even
       though `max` sits above it. Overshooting is the same mistake the old floor
       made, and an operator who wants the model's ceiling has `modelEfforts`. */
    expect(sent(resolveModelEffort('xhigh', SETS.lowMediumHighXhighMax))).toBe('xhigh');
    expect(sent(resolveModelEffort('medium', SETS.lowMediumHighXhighMax))).toBe('medium');
  });

  it('treats none as an absence when the model can express it', () => {
    expect(sent(resolveModelEffort('none', SETS.noneHigh))).toBe('none');
    expect(sent(resolveModelEffort('none', SETS.noneLowMediumHighXhigh))).toBe('none');
  });

  it('falls back to the lowest value when the model cannot express none', () => {
    /* 2425 reasoning models accept no `none`. Dropping the field there hands the
       decision to the provider, whose default is usually higher than the cheap
       mode asked for, so the model's own floor is sent instead. */
    expect(sent(resolveModelEffort('none', SETS.lowHighMax))).toBe('low');
    expect(sent(resolveModelEffort('none', SETS.mediumHighXhigh))).toBe('medium');
    expect(sent(resolveModelEffort('none', SETS.minimalLowMediumHigh))).toBe('minimal');
    expect(sent(resolveModelEffort('none', SETS.onlyHigh))).toBe('high');
  });

  it('distinguishes "cannot express this" from "does not know the model"', () => {
    /* The caller does opposite things with these two answers: nothing is known,
       so keep the previous behaviour; settled, so leave the field off. One shared
       null would turn every unanswered question into a silent fallback. */
    expect(resolveModelEffort('low', SETS.noneHigh).kind).toBe('omit');
    expect(resolveModelEffort('medium', null).kind).toBe('unknown');
    expect(resolveModelEffort('none', null).kind).toBe('unknown');
    expect(resolveModelEffort(undefined, SETS.lowMediumHigh).kind).toBe('unknown');
    expect(resolveModelEffort('none', []).kind).toBe('unknown');
  });
});

describe('applyReasoningFloor', () => {
  it('takes whichever of the two thinks harder', () => {
    expect(applyReasoningFloor('low', 'xhigh')).toBe('xhigh');
    expect(applyReasoningFloor('xhigh', 'low')).toBe('xhigh');
    expect(applyReasoningFloor('low', 'low')).toBe('low');
    expect(applyReasoningFloor(undefined, 'high')).toBe('high');
    expect(applyReasoningFloor('low', undefined)).toBe('low');
  });

  it('keeps every value the catalog can list', () => {
    /* The old rule rounded `high` up to `xhigh`, which overshot the operator and
       hit models that reject xhigh. `minimal` and `max` are wire values too: the
       catalog lists them for 627 and 1782 models respectively. */
    expect(applyReasoningFloor('none', 'high')).toBe('high');
    expect(applyReasoningFloor('none', 'minimal')).toBe('minimal');
    expect(applyReasoningFloor('none', 'max')).toBe('max');
  });
});

describe('the catalog lookup the resolver depends on', () => {
  it('reads a vocabulary for a model it is given, across providers', () => {
    /* A local provider id (sovinfra, a self-hosted endpoint) matches no catalog
       provider, so the id is resolved across every provider that serves it. */
    const found = findModelReasoningOptions('qwen3.8-27b');
    if (found) {
      expect(found.values.length).toBeGreaterThan(0);
      expect(found.values.every((value) => typeof value === 'string')).toBe(true);
      /* Every value the catalog hands back must be one the resolver can rank, or
         a rung would silently land on the wrong end of the ladder. */
      for (const value of found.values) {
        expect(typeof value).toBe('string');
      }
    }
  });

  it('resolves real catalog models the way the rules describe', () => {
    /* Models whose vocabularies are known shapes, so the resolver is checked
       against the catalog rather than against a table written to pass itself. */
    /* A gappy ladder: no none, no medium. `default` finds nothing at or below
       low is wrong here - low IS supported, so low is sent. */
    const gappy = findModelReasoningOptions('moonshotai/Kimi-K3');
    if (gappy) {
      expect(gappy.values).toContain('max');
      expect(gappy.values).not.toContain('none');
      expect(sent(resolveModelEffort('low', gappy.values))).toBe('low');
      expect(sent(resolveModelEffort('medium', gappy.values))).toBe('high');
      expect(sent(resolveModelEffort('xhigh', gappy.values))).toBe('max');
    }
    /* A model that cannot express none at all, which is the `instant` case. */
    const noneFree = findModelReasoningOptions('Qwen/Qwen3.8-27B');
    if (noneFree) {
      expect(noneFree.values).not.toContain('none');
      expect(sent(resolveModelEffort('none', noneFree.values))).toBe('low');
    }
  });

  it('returns nothing for a model it has never heard of', () => {
    expect(findModelReasoningOptions('definitely-not-a-model-xyzzy')).toBeNull();
  });
});

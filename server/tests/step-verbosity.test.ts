import { describe, expect, it } from 'vitest';
import { stepContentForVerbosity } from '../src/engine.js';
import { RESEARCH_VERBOSITIES } from '../src/engine/modes.js';

describe('stepContentForVerbosity', () => {
  it('gives only the note for summary', () => {
    expect(stepContentForVerbosity({
      text: '**Checking fees**\n\nFound the tariff table.',
      reasoning: 'I should verify this against the primary source.',
      verbosity: 'summary',
    })).toEqual({
      note: '**Checking fees**\n\nFound the tariff table.',
      reasoning: null,
    });
  });

  it('reports both in separate fields when text and reasoning differ', () => {
    expect(stepContentForVerbosity({
      text: '**Checking fees**',
      reasoning: 'Verify against primary source.',
      verbosity: 'detailed',
    })).toEqual({
      note: '**Checking fees**',
      reasoning: 'Verify against primary source.',
    });
  });

  it('falls back to the reasoning for the note when the provider sends no text', () => {
    expect(stepContentForVerbosity({
      text: null,
      reasoning: 'I need to check the tariff table.',
      verbosity: 'summary',
    })).toEqual({ note: 'I need to check the tariff table.', reasoning: null });
  });

  it('does not report the same string as both note and reasoning', () => {
    expect(stepContentForVerbosity({
      text: null,
      reasoning: 'I need to check the tariff table.',
      verbosity: 'detailed',
    })).toEqual({ note: 'I need to check the tariff table.', reasoning: null });
  });

  it('rejects max, which used to be a third value and no longer exists', () => {
    expect(RESEARCH_VERBOSITIES).toEqual(['summary', 'detailed']);
  });

  it('treats an absent verbosity like detailed, preserving old behavior', () => {
    const out = stepContentForVerbosity({ text: 'n', reasoning: 'r', verbosity: undefined });
    expect(out).toEqual({ note: 'n', reasoning: 'r' });
  });

  it('trims and drops empty or non-string values', () => {
    expect(stepContentForVerbosity({ text: '   ', reasoning: 42, verbosity: 'detailed' }))
      .toEqual({ note: null, reasoning: null });
    expect(stepContentForVerbosity({ text: null, reasoning: null, verbosity: 'summary' }))
      .toEqual({ note: null, reasoning: null });
  });
});
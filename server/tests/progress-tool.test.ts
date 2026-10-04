import { describe, expect, it } from 'vitest';
import {
  REPORT_PROGRESS_TOOL,
  REPORT_PROGRESS_TOOL_NAME,
  REPORT_PROGRESS_RESULT,
  progressNoteFrom,
} from '../src/engine/progress.js';

describe('report_progress tool', () => {
  it('publishes the note the model wrote instead of asking it for prose', () => {
    const note = progressNoteFrom(
      { headline: 'Mapping the landscape', body: 'Initial searches confirm Japan JPY 10M/yr and Korea USD 2,728/mo, with discrepancies.' },
      3,
    );
    expect(note).toEqual({
      headline: 'Mapping the landscape',
      body: 'Initial searches confirm Japan JPY 10M/yr and Korea USD 2,728/mo, with discrepancies.',
      round: 3,
    });
  });

  it('trims the fields so a note never carries stray whitespace', () => {
    const note = progressNoteFrom({ headline: '  Checking fees  ', body: '\n Found the tariff table. \n' }, 0);
    expect(note?.headline).toBe('Checking fees');
    expect(note?.body).toBe('Found the tariff table.');
  });

  it('publishes nothing rather than an empty note', () => {
    expect(progressNoteFrom({ headline: '', body: 'something' }, 0)).toBeNull();
    expect(progressNoteFrom({ headline: '  ', body: 'something' }, 0)).toBeNull();
    expect(progressNoteFrom({ headline: 'Something', body: '   ' }, 0)).toBeNull();
  });

  it('survives arguments that are not the expected shape', () => {
    expect(progressNoteFrom(null, 0)).toBeNull();
    expect(progressNoteFrom('a string', 0)).toBeNull();
    expect(progressNoteFrom(undefined, 0)).toBeNull();
    expect(progressNoteFrom({ headline: 42, body: true }, 0)).toBeNull();
  });

  it('requires both fields and accepts a headline longer than the guidance', () => {
    const fn = REPORT_PROGRESS_TOOL.function;
    expect(REPORT_PROGRESS_TOOL_NAME).toBe('report_progress');
    expect(fn.parameters.required).toEqual(['headline', 'body']);
    /* The guidance says two to six words, but nothing rejects a longer one:
       refusing the call would cost a turn to explain the refusal. */
    const long = progressNoteFrom({ headline: 'A very long headline that runs well past six words', body: 'Body.' }, 0);
    expect(long?.headline).toContain('well past six words');
  });

  it('acknowledges the call without echoing the note back to the model', () => {
    expect(REPORT_PROGRESS_RESULT).toBe('ok');
  });

  it('asks for substance by describing a good note, not by prohibiting a bad one', () => {
    const body = REPORT_PROGRESS_TOOL.function.parameters.properties.body.description;
    expect(body).toMatch(/naming the specific figure/);
    /* Two prohibition attempts were measured: each one made the model write
       fewer notes, and one silenced it entirely across five turns. */
    expect(body).not.toMatch(/worthless|never|do not/);
  });
});
/**
 * Progress reporting.
 *
 * The status note the user sees while a job runs is a tool call, not prose in
 * the model's text. That decision is measured, not stylistic: asked to narrate
 * in its normal text, this model produced a well-formed note on roughly one turn
 * in seventeen inside the real prompt, while the same instruction in a short
 * isolated prompt worked almost every time. The 9,649-character prompt simply
 * overwhelmed the rule. As a tool the shape is decided here rather than
 * negotiated with the model, and the note cannot be mistaken for part of the
 * answer.
 *
 * Defining the tool is not sufficient on its own. The first version defined it
 * here and said nothing in the system prompt, and five runs produced zero calls
 * while `create_plan`, `write_notebook` and `recall_source` were all used. A tool
 * the prompt never mentions is a tool whose purpose has to be inferred, and this
 * one has no self-evident reason to exist next to `web_search`. Both places now
 * name it: the system prompt sets the cadence and the quality bar, the schema
 * says why it exists and when to reach for it.
 *
 * Three consequences follow from it being a tool call:
 *   - the model never spends output tokens on it, so the final answer is the
 *     only thing in `text`;
 *   - the arguments sit in the assistant message, so the note survives as long
 *     as the conversation does;
 *   - it must not consume budget, count as a turn, or be charged a credit.
 */

/**
 * The tool the model calls to publish a status note.
 *
 * The `body` description carries the substance requirement, phrased as what a
 * good note contains rather than as a prohibition. Prohibitions were measured:
 * telling the model a lazy note is worthless silenced it entirely, five turns out
 * of five. The `headline` length is advisory and not enforced, because rejecting
 * a call costs a turn to say so.
 *
 * The tool description names the cadence because the schema is what the model
 * reads at the moment it decides what to call, and it was the only place the
 * tool was mentioned at all. With the note defined here but absent from the
 * system prompt, five runs produced zero calls while every other tool in the
 * list was used: the model will use a tool whose purpose it can infer, and skips
 * one it has to be told about elsewhere.
 */
export const REPORT_PROGRESS_TOOL = {
  type: 'function',
  function: {
    name: 'report_progress',
    description:
      'Publish a status update to the user while research continues. Call this every two to four rounds of searching, in the same response as your other tools so it costs nothing extra. The user sees this and nothing else until you answer, so a run with no note looks like a hang. It is not part of your answer and never appears there.',
    parameters: {
      type: 'object',
      properties: {
        headline: {
          type: 'string',
          description: 'Two to six words naming what you are working on right now.',
        },
        body: {
          type: 'string',
          description:
            'Two to four sentences in the language of the request. Say what the results just gave you, naming the specific figure, source, disagreement between sources, or dead end; what is still open; and what you will do next. A reader should learn something concrete from this, not only that you are still working.',
        },
      },
      required: ['headline', 'body'],
    },
  },
} as const;

export const REPORT_PROGRESS_TOOL_NAME = 'report_progress';

/** What the engine publishes for a progress call. */
export interface ProgressNote {
  headline: string;
  body: string;
  round: number;
}

/** The tool result. Nothing is echoed back: the note is not a search result. */
export const REPORT_PROGRESS_RESULT = 'ok';

/**
 * Normalises a progress call into a publishable note, or returns null when the
 * arguments carry nothing a reader could use. Both fields are required by the
 * schema, but a model can still send an empty string or whitespace, and
 * publishing a blank note is worse than publishing none.
 */
export function progressNoteFrom(args: unknown, round: number): ProgressNote | null {
  if (args === null || typeof args !== 'object') return null;
  const record = args as Record<string, unknown>;
  const rawHeadline = typeof record.headline === 'string' ? record.headline.trim() : '';
  const rawBody = typeof record.body === 'string' ? record.body.trim() : '';
  if (!rawHeadline || !rawBody) return null;
  return { headline: rawHeadline, body: rawBody, round };
}
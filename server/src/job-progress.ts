/**
 * One reading of "how far along is this job", shared by every surface.
 *
 * The REST snapshot, the SSE stream and the MCP progress notifications used to
 * each describe a run their own way, and only two of them described it at all:
 * an MCP client got a job_id and had to poll a snapshot it could not see
 * changing. Progress is one fact about the job, so it gets one projection here
 * and every surface renders that. Nothing in this file reads the store or the
 * engine; it only turns counters into a line of text and a fraction, so a
 * surface cannot invent a second, disagreeing version of "how is it going".
 */

export interface ProgressCounters {
  round?: number | null;
  used_search_calls?: number | null;
  search_calls_limit?: number | null;
  used_fetch_calls?: number | null;
  fetch_calls_limit?: number | null;
  used_steps?: number | null;
  step_limit?: number | null;
  used_tokens?: number | null;
  token_limit?: number | null;
  cost_usd?: number | null;
  elapsed_ms?: number | null;
}

export interface ProgressDescription {
  /** The same line every surface shows, e.g. `round 3/8 · 4/15 searches`. */
  message: string;
  /** Units of work finished, or null when the job has no step ceiling to count. */
  progress: number | null;
  /** Units of work the mode promised, or null when it declares none. */
  total: number | null;
}

function ratio(value: unknown): string | null {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : null;
}

function pair(used: unknown, limit: unknown, label: string, parts: string[]): void {
  const done = ratio(used);
  if (done === null) return;
  parts.push(limit === null || limit === undefined ? `${done} ${label}` : `${done}/${ratio(limit)} ${label}`);
}

/**
 * Money is formatted to micro-dollars because that is the resolution the cost
 * accounting keeps. A cheaper number would read as an exact price for a job
 * that cost fractions of a cent, and a rounded one would hide the difference
 * between a cheap run and a free one.
 */
function money(cost: unknown): string | null {
  return typeof cost === 'number' && Number.isFinite(cost) ? `$${cost.toFixed(6)}` : null;
}

/**
 * Steps are the unit a run actually spends, so they are what the fraction is
 * measured in. Wall clock and money are reported alongside as text, never as
 * the denominator: a run that thinks for ninety seconds has not done less work,
 * it has spent the same budget more slowly.
 */
export function describeJobProgress(counters: ProgressCounters): ProgressDescription {
  const parts: string[] = [];
  const round = ratio(counters.round);
  const stepLimit = ratio(counters.step_limit);
  if (round !== null) parts.push(stepLimit === null ? `round ${round}` : `round ${round}/${stepLimit}`);
  pair(counters.used_search_calls, counters.search_calls_limit, 'searches', parts);
  pair(counters.used_fetch_calls, counters.fetch_calls_limit, 'page reads', parts);

  const elapsed = counters.elapsed_ms;
  if (typeof elapsed === 'number' && Number.isFinite(elapsed)) {
    parts.push(`${Math.max(0, Math.round(elapsed / 1000))}s`);
  }
  const cost = money(counters.cost_usd);
  if (cost !== null) parts.push(cost);

  const usedSteps = counters.used_steps;
  const total = counters.step_limit;
  return {
    message: parts.length > 0 ? parts.join(' · ') : 'starting',
    progress: typeof usedSteps === 'number' && Number.isFinite(usedSteps) ? usedSteps : null,
    total: typeof total === 'number' && Number.isFinite(total) ? total : null,
  };
}
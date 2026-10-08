/**
 * The v1 research contract's structured report, built from the prose answer,
 * the run's sources, and the extraction pass. Shared by both engines so the
 * report does not fork with the loop.
 */
import type { ResearchReport } from './report.js';
import type { ReasoningEffort, ResearchPreset } from './modes.js';
import type { ResearchRunOptions, SourceWithIndex } from './types.js';
import type { Source } from '../schemas.js';
import { extractClaims } from './report-llm.js';
import { buildEvidenceRegistry, buildResearchReport } from './report.js';

export async function buildReportForRun(
  query: string,
  answer: string,
  sources: Source[],
  options: ResearchRunOptions,
  preset: ResearchPreset,
  reasoningEffort: ReasoningEffort | undefined,
  signal: AbortSignal | undefined,
  /* What is left of the job's promise. The extraction runs after the answer is
     written, so it cannot have a budget of its own without either exceeding the
     promise or being cut off by a number picked before the run started. */
  deadlineMs: number,
): Promise<ResearchReport> {
  const sourceList = sources as SourceWithIndex[];
  const registry = Array.from(buildEvidenceRegistry(sourceList).values());
  const callOptions = {
    signal,
    deadlineMs,
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };

  const claims = await extractClaims({ answer, registry, ...callOptions });

  return buildResearchReport({
    question: query,
    mode: options.mode ?? preset.mode,
    reasoningEffort: reasoningEffort ?? 'xhigh',
    sources: sourceList,
    claims,
  });
}

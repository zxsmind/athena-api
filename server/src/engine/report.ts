import type { SourceWithIndex } from './types.js';
import type { ReasoningEffort, ResearchMode } from './modes.js';

export const RESEARCH_REPORT_FORMAT = 'athena-research-report/v1' as const;

export interface ReportSource {
  id: string;
  url: string;
  title: string | null;
  domain: string;
  snippet: string | null;
  source_index: number;
}

export interface ReportFinding {
  id: string;
  text: string;
  citation_ids: string[];
  section: string;
}

export interface ReportSection {
  heading: string;
  findings: ReportFinding[];
}

export interface ReportGap {
  reason: string;
  text: string;
  citation_ids: string[];
}

export interface ResearchReport {
  format: typeof RESEARCH_REPORT_FORMAT;
  question: string;
  mode: ResearchMode;
  reasoning_effort: ReasoningEffort;
  sections: ReportSection[];
  sources: ReportSource[];
  gaps: ReportGap[];
  summary: {
    findings: number;
    citedFindings: number;
    sources: number;
    gaps: number;
  };
}

export interface ExtractedClaim {
  text: string;
  citation_ids: string[];
  section?: string;
}

const DEFAULT_SECTION = 'Research findings';

export function evidenceId(index: number): string {
  return `ev_${String(index).padStart(3, '0')}`;
}

/** Deterministic job-local evidence registry derived from the job's source list. */
export function buildEvidenceRegistry(sources: SourceWithIndex[]): Map<number, ReportSource> {
  const registry = new Map<number, ReportSource>();
  for (const source of sources) {
    registry.set(source.source_index, {
      id: evidenceId(source.source_index),
      url: source.url,
      title: source.title,
      domain: source.domain,
      snippet: source.snippet ?? null,
      source_index: source.source_index,
    });
  }
  return registry;
}

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

export interface AssembledReport {
  sections: ReportSection[];
  gaps: ReportGap[];
}

/**
 * Server-side claim validation. A finding survives only when it cites at least
 * one evidence ID that exists in this job's registry; fabricated IDs are
 * dropped, and every unsupported claim is preserved as an explicit gap.
 */
export function assembleClaims(
  claims: ExtractedClaim[],
  registry: Map<number, ReportSource>,
): AssembledReport {
  const knownIds = new Set(Array.from(registry.values(), (source) => source.id));
  const groups = new Map<string, ReportFinding[]>();
  const gaps: ReportGap[] = [];
  let counter = 0;

  /* A second model used to grade every claim against the cited evidence, and a
     claim it could not confirm was dropped from the report. It was removed
     rather than repaired, for three measured reasons.

     It judged on less than the model it graded. The extractor saw the whole
     page; the audit saw `snippet.slice(0, 400)` of it. A verifier holding 400
     characters of a 40,000-character page cannot tell a real number from a
     plausible one, so its "uncertain" was often a statement about its own
     reading, not about the claim.

     It could not confirm a claim it was never shown. An inaccessible source,
     a paywall, a PDF, a page behind a login: these produce no evidence string,
     and "unverifiable" for a reachable-but-thin page is the same verdict as for
     one that was never fetched.

     And it deleted rather than corrected. A rejected claim left a gap record and
     vanished from the answer with nothing in the response saying so, which is a
     worse failure than the misstatement it was meant to catch.

     A claim the reader cannot check is a problem worth fixing, and the fix is
     the source index the answer already carries. Removing the audit also removes
     two model calls from every `max` run, on a feature that had never been
     measured against a known-bad answer. */
  for (const claim of claims) {
    const text = cleanText(claim.text);
    if (!text) continue;
    counter += 1;
    const id = `cl_${counter}`;
    const valid = Array.from(new Set((claim.citation_ids ?? []).filter((value) => knownIds.has(value))));

    if (valid.length === 0) {
      gaps.push({ reason: 'uncited_claim', text, citation_ids: [] });
      continue;
    }

    const finding: ReportFinding = {
      id,
      text,
      citation_ids: valid,
      section: cleanText(claim.section) || DEFAULT_SECTION,
    };
    const section = groups.get(finding.section) ?? [];
    section.push(finding);
    groups.set(finding.section, section);
  }

  return { sections: [...groups].map(([heading, findings]) => ({ heading, findings })), gaps };
}

export interface BuildReportInput {
  question: string;
  mode: ResearchMode;
  reasoningEffort: ReasoningEffort;
  sources: SourceWithIndex[];
  claims: ExtractedClaim[];
}

export function buildResearchReport(input: BuildReportInput): ResearchReport {
  const registry = buildEvidenceRegistry(input.sources);
  const assembled = assembleClaims(input.claims, registry);
  const findings = assembled.sections.flatMap((section) => section.findings);
  return {
    format: RESEARCH_REPORT_FORMAT,
    question: input.question,
    mode: input.mode,
    reasoning_effort: input.reasoningEffort,
    sections: assembled.sections,
    sources: Array.from(registry.values()),
    gaps: assembled.gaps,
    summary: {
      findings: findings.length,
      citedFindings: findings.filter((finding) => finding.citation_ids.length > 0).length,
      sources: registry.size,
      gaps: assembled.gaps.length,
    },
  };
}

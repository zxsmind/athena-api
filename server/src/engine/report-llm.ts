import { z } from 'zod';
import { callLLM } from '../llm.js';
import { evidenceId, type ExtractedClaim, type ReportSource } from './report.js';
import type { ReasoningEffort } from './modes.js';

const CLAIMS_SCHEMA = z.object({
  claims: z.array(z.object({
    text: z.string().min(1),
    citation_ids: z.array(z.string()).default([]),
    section: z.string().optional(),
  })),
});

function extractJson(raw: string): string {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return start >= 0 && end > start ? text.slice(start, end + 1) : text;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}

/** Reads assistant text out of the shared OpenAI-shaped LLM result. */
export function readAssistantText(data: unknown): string {
  const choices = Array.isArray(asRecord(data).choices) ? (asRecord(data).choices as unknown[]) : [];
  const message = asRecord(asRecord(choices[0]).message);
  return typeof message.content === 'string' ? message.content : '';
}

function registryBlock(registry: ReportSource[]): string {
  return registry
    .map((source) => `- ${source.id} | ${source.title ?? source.url} | ${source.url}\n  snippet: ${(source.snippet ?? '(no snippet)').slice(0, 400)}`)
    .join('\n');
}

const CLAIM_INSTRUCTIONS = `You convert a research answer into structured findings backed by an evidence registry.

Rules:
- Emit one finding per discrete factual claim. Keep each finding to one or two sentences.
- citation_ids may only contain evidence IDs listed below. Never invent an ID, URL, or title.
- If a claim is not supported by any listed evidence, still emit it but leave citation_ids empty. Athena turns unsupported claims into gaps.
- Group related findings under a short section heading.
- Reply with JSON only, in the form {"claims":[{"text":"...","citation_ids":["ev_001"],"section":"..."}]}. No prose, no code fences.`;

interface CallOptions {
  signal?: AbortSignal;
  reasoningEffort?: ReasoningEffort;
}

/**
 * Deterministic fallback: reuses the inline [N] markers already validated
 * against the source registry, so a failed extraction call still yields a
 * usable, evidence-bound report.
 */
export function deriveClaimsFromAnswer(answer: string, registry: ReportSource[]): ExtractedClaim[] {
  const byIndex = new Map(registry.map((source) => [source.source_index, source.id]));
  const cleanText = (sentence: string): string =>
    sentence
      .replace(/\[\d+(?:\s*,\s*\d+)*\]/g, '')
      .replace(/\s+/g, ' ')
      .replace(/\s+([,.;:!?])/g, '$1')
      .trim();
  const citationIdsOf = (sentence: string): string[] => {
    const markers = [...sentence.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)];
    return Array.from(new Set(markers
      .flatMap((marker) => marker[1].split(/\s*,\s*/))
      .map((value) => byIndex.get(Number(value)))
      .filter((value): value is string => Boolean(value))));
  };
  /* Markers trail their sentence ("...2026. [6][85]"), so a split between the
     period and the marker must not separate them. Measured: 50 valid markers
     orphaned into marker-only segments that were then discarded, wiping every
     citation from the report. */
  const out: ExtractedClaim[] = [];
  for (const raw of answer.split(/(?<=[.!?])\s+(?!\[\d)|\n+/)) {
    const sentence = raw.trim();
    if (sentence.length === 0) continue;
    const citation_ids = citationIdsOf(sentence);
    const text = cleanText(sentence);
    if (text.length === 0) {
      /* Leftover orphan (markers alone on a line): they belong to the claim
         before them, not to nothing. */
      const prev = out[out.length - 1];
      if (prev && citation_ids.length > 0) {
        prev.citation_ids = Array.from(new Set([...prev.citation_ids, ...citation_ids]));
      }
      continue;
    }
    out.push({ text, citation_ids });
  }
  return out;
}

/**
 * Turns the finished answer into discrete, evidence-bound findings.
 *
 * This reads the answer the model just wrote and links each claim to the
 * evidence it cites. It does not judge whether the evidence supports the claim.
 * That second pass existed here once, as `auditClaims`, and was removed: it read
 * 400 characters of each snippet rather than the page the model had actually
 * read, could not distinguish a thin source from an unfetched one, and deleted
 * claims it could not confirm instead of flagging them. See the note in
 * `assembleClaims`.
 */
export async function extractClaims(input: {
  answer: string;
  registry: ReportSource[];
} & CallOptions): Promise<ExtractedClaim[]> {
  const { answer, registry, signal, reasoningEffort } = input;
  if (answer.trim().length === 0 || registry.length === 0) return [];
  try {
    const result = await callLLM({
      messages: [
        { role: 'system', content: CLAIM_INSTRUCTIONS },
        {
          role: 'user',
          content: `Evidence registry:\n${registryBlock(registry)}\n\nResearch answer:\n${answer.slice(0, 20_000)}`,
        },
      ],
      temperature: 0,
      maxTokens: 4000,
      role: 'deep',
      label: 'claim-extraction',
      signal,
      ...(reasoningEffort ? { reasoningEffort } : {}),
    });
    const parsed = CLAIMS_SCHEMA.safeParse(JSON.parse(extractJson(readAssistantText(result.data))));
    if (!parsed.success || parsed.data.claims.length === 0) return deriveClaimsFromAnswer(answer, registry);
    /* Total citation wipeout: well-formed claims, none linked, while the prose
       carries markers that resolve. Measured on a default run: 50 valid [N]
       markers in the answer, zero cited findings, 103 gaps. The deterministic
       split maps markers correctly, so it wins whenever the model links
       nothing and it has something to link. */
    const knownIds = new Set(registry.map((source) => source.id));
    const linked = parsed.data.claims.filter((claim) =>
      (claim.citation_ids ?? []).some((id) => knownIds.has(id)),
    ).length;
    if (linked === 0) {
      const fallback = deriveClaimsFromAnswer(answer, registry);
      if (fallback.some((claim) => claim.citation_ids.length > 0)) return fallback;
    }
    return parsed.data.claims;
  } catch {
    return deriveClaimsFromAnswer(answer, registry);
  }
}

export { evidenceId };
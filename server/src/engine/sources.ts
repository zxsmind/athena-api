import type { Source } from '../schemas.js';
import type { SourceWithIndex } from './types.js';

/** Normalizes a URL for registry lookup so cosmetic differences do not create duplicates. */
export function normalizedSourceUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = '';
    return url.href.replace(/\/$/, '');
  } catch {
    return value.trim();
  }
}

export function toPublicSource(source: SourceWithIndex): Source {
  return {
    source_index: source.source_index,
    title: source.title,
    url: source.url,
    domain: source.domain,
    snippet: source.snippet,
  };
}

export function sourceListBlock(allSources: Map<string, SourceWithIndex>): string {
  if (allSources.size === 0) return 'No sources cited yet.';
  const sorted = Array.from(allSources.values()).sort((a, b) => a.source_index - b.source_index);
  return sorted.map(s => `- [Source #${s.source_index}] Title: "${s.title}" | URL: ${s.url}`).join('\n');
}

/**
 * Renders one tool result line. A failed retrieval is not a source — nothing
 * was retrieved — so it gets no `[Source #N]` marker, only plain failure text.
 * This keeps non-entities out of the entity pipeline: the clearing gate never
 * sees them, and citations can never point at them. The failure fact itself
 * stays readable, and the ledger re-surfaces it if the model retries.
 */
export function formatResultLine(
  result: { source_index?: number; title: string; url: string; snippet: string | null },
  position: number,
): string {
  const snippet = result.snippet || 'No content';
  if (!result.source_index) {
    return `${position}. Title: ${result.title}\nURL: ${result.url}\nSnippet: ${snippet}`;
  }
  return `${position}. [Source #${result.source_index}] Title: ${result.title}\nURL: ${result.url}\nSnippet: ${snippet}`;
}

/**
 * Opening chrome is removed rather than requested. The prompt has forbidden a
 * heading or a label such as "Short answer" before the opening prose since
 * 2026-10, and measured answers still shipped one: seven classic runs opened
 * with a label, and the first code-engine run opened with a title heading plus
 * an answer label. A rule the engine can enforce belongs in the engine. The
 * regex carries the Turkish label as data because the model produced it; it is
 * matched, never written.
 */
const OPENING_LABEL = /^(?:\*\*)?\s*(Kısa cevap|Short answer)\s*:?\s*(?:\*\*)?\s*/i;

function stripOpeningChrome(text: string): string {
  const lines = text.split('\n');
  while (lines.length > 0) {
    const first = lines[0].trim();
    if (first === '' || /^#{1,6}\s+/.test(first)) {
      lines.shift();
      continue;
    }
    break;
  }
  if (lines.length > 0) lines[0] = lines[0].replace(OPENING_LABEL, '');
  const stripped = lines.join('\n').trim();
  /* An answer that was only chrome is kept as it was; deleting it would turn a
     formatting problem into an empty answer. */
  return stripped.length > 0 ? stripped : text.trim();
}

/**
 * Removes citations and links that are not backed by this job's source registry.
 * A rendered citation therefore always points at a source the job actually returned.
 */
export function sanitizeResearchAnswer(answer: string, sources: Source[]): string {
  const sourceByUrl = new Map<string, number>();
  const validIndices = new Set<number>();
  sources.forEach((source, index) => {
    const sourceIndex = source.source_index ?? index + 1;
    sourceByUrl.set(normalizedSourceUrl(source.url), sourceIndex);
    validIndices.add(sourceIndex);
  });
  const citationForUrl = (url: string): string | null => {
    const sourceIndex = sourceByUrl.get(normalizedSourceUrl(url));
    return sourceIndex === undefined ? null : `[${sourceIndex}]`;
  };

  let output = answer.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/gi, (_match, label: string, url: string) => {
    return citationForUrl(url) ?? label;
  });
  /* Trailing sentence punctuation is captured separately so removing an
     unregistered URL does not also delete the period that ends the sentence. */
  output = output.replace(/https?:\/\/[^\s)\]}>]+/gi, (url) => {
    const trailing = url.match(/[.,;:!?]+$/)?.[0] ?? '';
    const bare = trailing ? url.slice(0, url.length - trailing.length) : url;
    return `${citationForUrl(bare) ?? ''}${trailing}`;
  });
  output = output.replace(/(?:\[|【)(\d+(?:\s*,\s*\d+)*)(?:†[^\]】]*)?(?:\]|】)/g, (_match, numbers: string) => {
    const valid = numbers.split(/\s*,\s*/).map(Number).filter((index) => validIndices.has(index));
    return valid.length ? `[${[...new Set(valid)].join(', ')}]` : '';
  });
  return stripOpeningChrome(output.replace(/[ \t]{2,}/g, ' ').replace(/\s+([,.;!?])/g, '$1').trim());
}

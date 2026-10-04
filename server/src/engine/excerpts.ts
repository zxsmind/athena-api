/**
 * Keyword excerpt selection for targeted page reads.
 *
 * The sandbox's `extract` answers a question from a page without returning
 * the whole page: the text is split into passages, each scored by keyword
 * overlap with the question, and the winners come back as quotes. Keyword
 * scoring first, per the plan; an embedding step or a small model only if
 * measurement demands it. Deterministic: same text and question, same
 * excerpts, so results are testable and cacheable.
 */

const TOKEN_PATTERN = /[a-z0-9]{3,}/g;

/** Content words of a question or passage. No stoplist: overlap with rare
 *  terms is exactly what ranks, and a list would be one more thing to drift. */
export function contentTokens(text: string): string[] {
  return text.toLowerCase().match(TOKEN_PATTERN) ?? [];
}

/** Splits body text into candidate passages on blank lines, merging a stub
 *  heading into what follows so it never becomes an excerpt of its own. Each
 *  slot merges once: without that, short passages chain into one blob. */
export function splitPassages(text: string): string[] {
  const raw = text.split(/\n\s*\n/).map((part) => part.replace(/\s+/g, ' ').trim()).filter((part) => part.length > 0);
  const out: { text: string; open: boolean }[] = [];
  for (const part of raw) {
    const prev = out[out.length - 1];
    if (prev !== undefined && prev.open && prev.text.length < 120) {
      prev.text = `${prev.text} ${part}`;
      if (prev.text.length >= 120) prev.open = false;
    } else {
      out.push({ text: part, open: part.length < 120 });
    }
  }
  return out.map((entry) => entry.text);
}

export interface ScoredExcerpt {
  text: string;
  score: number;
}

/** Ranks passages by shared content words with the question. Longer passages
 *  are not penalised: a thorough passage answering twice deserves to win. */
export function scorePassages(passages: string[], question: string): ScoredExcerpt[] {
  const wanted = new Set(contentTokens(question));
  if (wanted.size === 0) return passages.map((text) => ({ text, score: 0 }));
  return passages.map((text) => {
    const seen = new Set(contentTokens(text));
    let score = 0;
    for (const token of wanted) {
      if (seen.has(token)) score += 1;
    }
    return { text, score };
  });
}

export interface ExcerptSelection {
  excerpts: { text: string }[];
  /** Characters of page text the excerpts cover. */
  coveredChars: number;
}

/**
 * Top passages that mention the question's terms, within maxChars. Passages
 * scoring zero are skipped: when nothing matches, fewer excerpts beat filler.
 * With no question terms at all, the head of the page wins (snippet parity).
 */
export function selectExcerpts(text: string, question: string, maxChars: number, maxExcerpts = 4): ExcerptSelection {
  const passages = splitPassages(text);
  const ranked = scorePassages(passages, question)
    .map((entry, index) => ({ ...entry, index }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const budget = Math.max(0, maxChars);
  const excerpts: { text: string }[] = [];
  let coveredChars = 0;
  for (const entry of ranked) {
    if (excerpts.length >= maxExcerpts) break;
    if (entry.score <= 0) break;
    const room = budget - coveredChars;
    if (room <= 0) break;
    const slice = entry.text.slice(0, room);
    if (slice.trim().length === 0) continue;
    excerpts.push({ text: slice });
    coveredChars += slice.length;
  }
  if (excerpts.length === 0 && passages.length > 0 && budget > 0) {
    const slice = passages[0].slice(0, budget);
    if (slice.trim().length > 0) {
      excerpts.push({ text: slice });
      coveredChars = slice.length;
    }
  }
  return { excerpts, coveredChars };
}

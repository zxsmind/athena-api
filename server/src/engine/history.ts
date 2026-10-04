import { getConfig } from '../config/load.js';

export function domain(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return url; }
}

export function normalizeContent(content: string): string {
  return content.replace(/\s+/g, ' ').trim();
}

export function sanitizeHistory(
  history: { role: string; content: string }[] | undefined,
  currentQuery: string,
): { role: 'user' | 'assistant'; content: string }[] {
  if (!history?.length) return [];

  const current = normalizeContent(currentQuery);
  const clean = history
    .filter((h): h is { role: 'user' | 'assistant'; content: string } =>
      (h.role === 'user' || h.role === 'assistant') &&
      typeof h.content === 'string' && h.content.trim().length > 0 &&
      !h.content.startsWith('[Search result')
    );

  while (clean.length > 0 && clean[clean.length - 1].role === 'user' && normalizeContent(clean[clean.length - 1].content) === current) {
    clean.pop();
  }

  return clean.slice(-getConfig().research.historyMessageLimit);
}

/**
 * Sampling temperature, fixed for every round. Near-greedy sampling starves
 * exploration: at 0.1 the model overwhelmingly picks the most likely
 * continuation, and in an agentic loop the most likely continuation of "I
 * have some evidence" is writing the answer. Novel queries, follow-up angles
 * and contradiction chasing live in the distribution tail that low
 * temperature suppresses, so the constant follows the thinking-model spec
 * (1.0) rather than the old 0.3/0.1 split, whose rationale was never measured.
 */
export function temperatureForRound(round: number): number {
  void round;
  return 1;
}

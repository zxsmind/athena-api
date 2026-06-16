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
  mode: 'quick' | 'deep',
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

  if (mode === 'quick') {
    const users = clean.filter(h => h.role === 'user').slice(-3);
    const assts = clean.filter(h => h.role === 'assistant').slice(-3);
    const kept = new Set([...users, ...assts]);
    return clean.filter(h => kept.has(h));
  }

  return clean.slice(-12);
}

export function compactHistoryForSynthesis(history: { role: 'user' | 'assistant'; content: string }[]): string {
  if (history.length === 0) return 'No prior conversation context.';
  return history.slice(-6).map(h => {
    const content = normalizeContent(h.content).slice(0, h.role === 'assistant' ? 700 : 300);
    return `${h.role.toUpperCase()}: ${content}`;
  }).join('\n');
}

export function temperatureForRound(round: number): number {
  return round === 0 ? 0.3 : 0.1;
}

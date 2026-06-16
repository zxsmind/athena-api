import type { Source, Message } from './api';

export const STEP_LABELS: Record<string, string> = {
  plan: 'Plan',
  search: 'Search',
  reason: 'Reasoning',
  'plan-analyze': 'Plan & Analyze',
  analyze: 'Analyze',
  synthesize: 'Synthesis',
  extract: 'Extract',
  'deep-analyze': 'Deep Analysis',
  'follow-up': 'Follow-up',
  webpage: 'Page',
};

export function sanitizeUrl(url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  return '#';
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function formatTime(ms: number): string {
  return (ms / 1000).toFixed(2) + 's';
}

export function normalizeSearchQuery(q: string): string {
  return q.toLowerCase().replace(/\s+/g, ' ').trim();
}

export function displayQuery(q: string, type?: string): string {
  if (type === 'webpage') {
    try { return new URL(q).hostname; } catch { return q; }
  }
  return q;
}

export function getSourcesForMessage(msg: Message, index: number, messages: Message[]): Source[] | undefined {
  const hasOwnSources = msg.data?.steps?.some(s => s.type.startsWith('search') || s.type === 'webpage');
  if (hasOwnSources) return msg.data?.sources;
  for (let j = index - 1; j >= 0; j--) {
    const prev = messages[j];
    if (prev?.type === 'assistant' && prev.data?.sources && prev.data.sources.length > 0) {
      return prev.data.sources;
    }
  }
  return msg.data?.sources;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

export const CITATION_TOOLTIP_MAX_HEIGHT = 160;

export interface CitationTooltipItem {
  domain: string;
  title: string;
  snippet: string;
  url: string;
}

export interface CitationTooltipPosition {
  left: number;
  top: number;
}

export function estimateCitationTooltipSize(items: CitationTooltipItem[]): { width: number; height: number } {
  const width = clamp(
    items.reduce((max, item) => Math.max(max, item.title.length * 7 + 72, item.domain.length * 6 + 72), 200),
    200,
    320,
  );
  const height = Math.min(items.length * 44 + 16, CITATION_TOOLTIP_MAX_HEIGHT);
  return { width, height };
}

export function computeCitationTooltipPosition(
  badgeRect: DOMRect,
  tooltipSize: { width: number; height: number },
): CitationTooltipPosition {
  const margin = 8;
  const gap = 10;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const centeredLeft = badgeRect.left + badgeRect.width / 2 - tooltipSize.width / 2;
  const left = clamp(centeredLeft, margin, Math.max(margin, vw - tooltipSize.width - margin));

  const spaceAbove = badgeRect.top - margin;
  const spaceBelow = vh - badgeRect.bottom - margin;
  const fitsAbove = spaceAbove >= tooltipSize.height + gap;
  const fitsBelow = spaceBelow >= tooltipSize.height + gap;
  const placeAbove = fitsAbove || (!fitsBelow && spaceAbove >= spaceBelow);

  let top = placeAbove
    ? badgeRect.top - gap - tooltipSize.height
    : badgeRect.bottom + gap;

  top = clamp(top, margin, Math.max(margin, vh - tooltipSize.height - margin));

  return { left, top };
}

export const FAVICON_URL = 'https://icons.duckduckgo.com/ip3/${domain}.ico';
export const ABORT_TIMEOUT_MS = 120000;

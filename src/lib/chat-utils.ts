import type { Source, Message, SearchResponse, ResearchProgressState, ConversationMeta, SearchMode, DeepDepth } from './api';
import { getDefaultDepth, getDefaultMode } from '../hooks/useDefaultMode';

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
  notebook: 'Notebook',
  verification: 'Verification',
  cooldown: 'Pacing',
  budget: 'Budget',
  checkpoint: 'Checkpoint',
};

export function inferResearchFromMessages(messages: Message[]): { mode?: SearchMode; depth?: DeepDepth } {
  for (let i = messages.length - 1; i >= 0; i--) {
    const depth = messages[i]?.data?.research_depth;
    if (depth) return { mode: 'deep', depth };
  }
  return {};
}

export function resolveConversationResearch(options: {
  routeMode?: SearchMode;
  routeDepth?: DeepDepth;
  conversation?: Pick<ConversationMeta, 'mode' | 'depth'>;
  messages?: Message[];
}): { mode: SearchMode; depth: DeepDepth } {
  if (options.routeMode) {
    return {
      mode: options.routeMode,
      depth: options.routeDepth ?? (options.routeMode === 'deep' ? getDefaultDepth() : 'med'),
    };
  }
  if (options.conversation?.mode) {
    return {
      mode: options.conversation.mode,
      depth: options.conversation.depth ?? (options.conversation.mode === 'deep' ? getDefaultDepth() : 'med'),
    };
  }
  const inferred = inferResearchFromMessages(options.messages ?? []);
  if (inferred.mode) {
    return {
      mode: inferred.mode,
      depth: inferred.depth ?? getDefaultDepth(),
    };
  }
  return { mode: getDefaultMode(), depth: getDefaultDepth() };
}

export function mergeResearchProgress(
  data: SearchResponse | undefined,
  state: ResearchProgressState,
): SearchResponse {
  const limit = state.usedCredits + state.remainingCredits;
  const base: SearchResponse = data ?? {
    query: '',
    answer: '',
    sources: [],
    steps: [],
    results_count: 0,
    elapsed_ms: 0,
  };
  return {
    ...base,
    research_budget: {
      used: state.usedCredits,
      limit,
      exhausted: state.exhausted,
    },
    research_depth: state.depth ?? base.research_depth,
    research_notebook: state.notebookId
      ? {
          id: state.notebookId,
          path: base.research_notebook?.path ?? '',
          entries: state.notebookEntries ?? base.research_notebook?.entries ?? 0,
          updatedAt: base.research_notebook?.updatedAt ?? new Date().toISOString(),
          openQuestions: state.openQuestionsCount,
        }
      : base.research_notebook,
  };
}

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

export function copyToClipboard(text: string): void {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).catch(() => {});
  } else {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  }
}

export const FAVICON_URL = 'https://www.google.com/s2/favicons?domain=${domain}&sz=16';
export const FALLBACK_FAVICON = 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2216%22 height=%2216%22 viewBox=%220 0 24 24%22 fill=%22none%22 stroke=%22%23999%22 stroke-width=%222%22%3E%3Ccircle cx=%2212%22 cy=%2212%22 r=%2210%22/%3E%3Cline x1=%222%22 y1=%2212%22 x2=%2222%22 y2=%2212%22/%3E%3Cpath d=%22M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z%22/%3E%3C/svg%3E';
export const ABORT_TIMEOUT_MS = 120000;

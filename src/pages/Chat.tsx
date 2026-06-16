import { useState, useEffect, useRef, useCallback, useLayoutEffect, useId } from 'react';
import { createPortal } from 'react-dom';
import { useParams, useLocation } from 'react-router-dom';
import { RefreshCw, MoreHorizontal, Pencil, Loader2, Check, Copy } from 'lucide-react';
import SearchInput from '../components/SearchInput';
import { getDefaultMode } from '../hooks/useDefaultMode';
import ActivityModal from '../components/ActivityModal';
import { search, subscribeToJobEvents, fetchMessages, saveMessages, type Message, type SearchResponse, type Source } from '../lib/api';
import katex from 'katex';

const STEP_LABELS: Record<string, string> = {
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

/* ── Pick sources for citation rendering ── */
function getSourcesForMessage(msg: Message, index: number, messages: Message[]): Source[] | undefined {
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

/* ── Inline markdown (bold, italic, code, links, citations) ── */
function sanitizeUrl(url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  return '#';
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function MermaidBlock({ chart, onExpand }: { chart: string; onExpand?: (svg: string) => void }) {
  const containerId = useId().replace(/:/g, '');
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [svgHtml, setSvgHtml] = useState<string | null>(null);

  const handleClick = useCallback(() => {
    if (ref.current && !error) {
      onExpand?.(ref.current.innerHTML);
    }
  }, [onExpand, error]);

  useEffect(() => {
    let cancelled = false;

    async function renderDiagram() {
      try {
        const dark = document.documentElement.classList.contains('dark');
        const mermaidModule = await import('mermaid');
        const mermaid = mermaidModule.default;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: dark ? 'dark' : 'neutral',
          themeVariables: dark ? {
            fontFamily: '"Outfit", sans-serif',
            primaryColor: '#1e3058',
            primaryTextColor: '#e0e0f0',
            primaryBorderColor: '#3a5a8a',
            lineColor: '#5a7aaa',
            secondaryColor: '#182840',
            tertiaryColor: '#101828',
          } : {
            fontFamily: '"Outfit", sans-serif',
            primaryColor: '#e8ecf4',
            primaryTextColor: '#1a1a2e',
            primaryBorderColor: '#c0c8da',
            lineColor: '#8890a8',
            secondaryColor: '#f0f2f8',
            tertiaryColor: '#fafbfd',
          },
        });

        const { svg } = await mermaid.render(`mermaid-${containerId}`, chart);
        if (!cancelled) {
          const svgEl = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement as HTMLElement;

          svgEl.querySelectorAll('rect').forEach(r => {
            const w = parseFloat(r.getAttribute('width') || '0');
            const h = parseFloat(r.getAttribute('height') || '0');
            if (w > 20 && h > 20) {
              r.setAttribute('rx', '6');
              r.setAttribute('ry', '6');
            }
          });
          svgEl.querySelectorAll('polygon').forEach(p => p.setAttribute('stroke-linejoin', 'round'));

          setSvgHtml(svgEl.outerHTML);
          setError(null);
        }
      } catch (err: any) {
        if (!cancelled) {
          setError(err?.message || 'Mermaid diagram could not be rendered.');
        }
      }
    }

    setSvgHtml(null);
    setError(null);
    void renderDiagram();
    return () => { cancelled = true; };
  }, [chart, containerId]);

  return (
    <div ref={ref} className="mermaid-diagram" onClick={handleClick}>
      {error ? (
        <div className="mermaid-error">{error}</div>
      ) : svgHtml ? (
        <div dangerouslySetInnerHTML={{ __html: svgHtml }} />
      ) : (
        <div className="mermaid-loading">Loading diagram…</div>
      )}
    </div>
  );
}

function inlineMD(t: string, sources?: Source[]) {
  let html = t
    .replace(/\\\((.+?)\\\)/g, (_, m: string) => {
      try { const clean = m.replace(/[\u00A0\u202F\u2000-\u200F]/g, ' '); return katex.renderToString(clean, { throwOnError: false, strict: false }); }
      catch { return `\\(${m}\\)`; }
    })
    .replace(/\$([^$\s][^$]*[^$\s]|\S)\$/g, (full, m: string) => {
      // Skip if it looks like a price ($5.99) or plain number
      if (/^\d/.test(m)) return full;
      try { const clean = m.replace(/[\u00A0\u202F\u2000-\u200F]/g, ' '); return katex.renderToString(clean, { throwOnError: false, strict: false }); }
      catch { return full; }
    })
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/(\*\*|__)(.+?)\1/g, '<strong>$2</strong>')
    .replace(/(\*|_)(.+?)\1/g, '<em>$2</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, url) => `<a href="${sanitizeUrl(url)}" target="_blank" rel="noopener noreferrer">${text}</a>`);

  /* restore math placeholders as inline spans */
  if (sources && sources.length > 0) {
    html = html.replace(/(?:\[|【)(\d+(?:\s*,\s*\d+)*)(?:†[^\]】]*)?(?:\]|】)/g, (match, nums) => {
      const indices = nums.split(/\s*,\s*/).map((n: string) => parseInt(n, 10) - 1);
      const valid = indices.filter((i: number) => i >= 0 && i < sources.length);
      if (valid.length === 0) return match;

      if (valid.length === 1) {
        const i = valid[0];
        const src = sources[i];
        const label = src.title || src.domain;
        const domain = src.domain;
        const snippet = (src.snippet || '').replace(/"/g, '&quot;').slice(0, 120);
        return `<a href="${sanitizeUrl(src.url)}" target="_blank" rel="noopener noreferrer" class="citation-badge" data-indices="${i}" data-domain="${domain}" data-title="${label.replace(/"/g, '&quot;')}" data-snippet="${snippet}">
          <img src="https://www.google.com/s2/favicons?domain=${domain}&sz=16" width="12" height="12" loading="lazy" onerror="this.remove()" alt="" />
          <span class="citation-label">${label}</span>
        </a>`;
      }

      const multiCount = valid.length - 1;
      const src = sources[valid[0]];
      const allDomains = valid.map((i: number) => sources[i]?.domain || '').join(',');
      const allTitles = valid.map((i: number) => (sources[i]?.title || sources[i]?.domain || '').replace(/"/g, '&quot;')).join(' || ');
      const allSnippets = valid.map((i: number) => (sources[i]?.snippet || '').replace(/"/g, '&quot;').slice(0, 120)).join(' ||| ');
      const allUrls = valid.map((i: number) => sanitizeUrl(sources[i]?.url || '')).join(',');
      const label = src.title || src.domain;
      const domain = src.domain;
      return `<a href="${sanitizeUrl(src.url)}" target="_blank" rel="noopener noreferrer" class="citation-badge multi" data-index="${valid[0]}" data-indices="${valid.join(',')}" data-domain="${allDomains}" data-title="${allTitles}" data-snippet="${allSnippets}" data-url="${allUrls}">
        <img src="https://www.google.com/s2/favicons?domain=${domain}&sz=16" width="12" height="12" loading="lazy" onerror="this.remove()" alt="" />
        <span class="citation-label">${label}</span>
        <span class="citation-multi-count">+${multiCount}</span>
      </a>`;
    });
  }

  return html;
}

/* ── Block-level markdown ── */
function renderMarkdown(text: string, sources?: Source[], onDiagramClick?: (svg: string) => void) {
  const lines = text.split('\n');
  const nodes: React.ReactNode[] = [];
  let key = 0;
  let i = 0;

  while (i < lines.length) {
    const trimmed = lines[i].trim();

    /* blank line → skip */
    if (!trimmed) { i++; continue; }

    /* block math $$...$$ / \[...\] */
    const singleBlock = trimmed.match(/^\$\$(.+)\$\$$/) || trimmed.match(/^\\\[(.+)\\\]$/);
    if (singleBlock) {
      try {
        const html = katex.renderToString(singleBlock[1], { displayMode: true, throwOnError: false, strict: false });
        nodes.push(<div key={key++} className="math-block" dangerouslySetInnerHTML={{ __html: html }} />);
      } catch {
        nodes.push(<div key={key++} className="math-block">{singleBlock[1]}</div>);
      }
      i++;
      continue;
    }
    if (trimmed === '$$' || trimmed === '\\[') {
      const mathLines: string[] = [];
      const closer = trimmed === '$$' ? '$$' : '\\]';
      i++;
      while (i < lines.length && lines[i].trim() !== closer) {
        mathLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++;
      const math = mathLines.join('\n');
      try {
        const html = katex.renderToString(math, { displayMode: true, throwOnError: false, strict: false });
        nodes.push(<div key={key++} className="math-block" dangerouslySetInnerHTML={{ __html: html }} />);
      } catch {
        nodes.push(<div key={key++} className="math-block">{math}</div>);
      }
      continue;
    }

    /* fenced code block */
    if (trimmed.startsWith('```')) {
      const lang = trimmed.slice(3).trim().toLowerCase();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++;

      const code = codeLines.join('\n');
      if (lang === 'mermaid') {
        nodes.push(<MermaidBlock key={key++} chart={code} onExpand={onDiagramClick} />);
      } else if (lang === 'latex' || lang === 'math') {
        const math = code.replace(/^\s*\$\$\s*/gm, '').replace(/\s*\$\$\s*$/gm, '');
        try {
          const html = katex.renderToString(math, { displayMode: true, throwOnError: false, strict: false });
          nodes.push(<div key={key++} className="math-block" dangerouslySetInnerHTML={{ __html: html }} />);
        } catch {
          nodes.push(<div key={key++} className="math-block">{math}</div>);
        }
      } else {
        nodes.push(
          <div key={key++} className="code-block-wrapper">
            {lang && <div className="code-block-lang">{lang}</div>}
            <pre className="code-block">
              <code dangerouslySetInnerHTML={{ __html: escapeHtml(code) }} />
            </pre>
          </div>
        );
      }
      continue;
    }

    /* heading */
    if (/^#{1,3}\s/.test(trimmed)) {
      const level = trimmed.match(/^#+/)![0].length;
      const Tag = level === 1 ? 'h2' : 'h3';
      nodes.push(<Tag key={key++} dangerouslySetInnerHTML={{ __html: inlineMD(trimmed.replace(/^#+\s*/, ''), sources) }} />);
      i++;
      continue;
    }

    /* blockquote */
    if (/^>\s/.test(trimmed)) {
      nodes.push(<blockquote key={key++} dangerouslySetInnerHTML={{ __html: inlineMD(trimmed.replace(/^>\s*/, ''), sources) }} />);
      i++;
      continue;
    }

    /* bold-only line */
    if (/^(\*\*|__)(.+)\1$/.test(trimmed)) {
      const match = trimmed.match(/^(\*\*|__)(.+)\1$/);
      nodes.push(<p key={key++}><strong>{match![2]}</strong></p>);
      i++;
      continue;
    }

    /* unordered list — collect consecutive items */
    if (/^[-*]\s/.test(trimmed)) {
      const items: React.ReactNode[] = [];
      while (i < lines.length && /^[-*]\s/.test(lines[i].trim())) {
        items.push(<li key={items.length} dangerouslySetInnerHTML={{ __html: inlineMD(lines[i].trim().replace(/^[-*]\s+/, ''), sources) }} />);
        i++;
      }
      nodes.push(<ul key={key++}>{items}</ul>);
      continue;
    }

    /* ordered list */
    if (/^\d+\.\s/.test(trimmed)) {
      const items: React.ReactNode[] = [];
      while (i < lines.length && /^\d+\.\s/.test(lines[i].trim())) {
        items.push(<li key={items.length} dangerouslySetInnerHTML={{ __html: inlineMD(lines[i].trim().replace(/^\d+\.\s+/, ''), sources) }} />);
        i++;
      }
      nodes.push(<ol key={key++}>{items}</ol>);
      continue;
    }

    /* table — collect consecutive pipe lines */
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith('|') && lines[i].trim().endsWith('|')) {
        const row = lines[i].trim()
          .replace(/^\|/, '').replace(/\|$/, '')
          .split('|')
          .map(c => c.trim());
        /* skip separator row (---|---) */
        if (!row.every(c => /^[-:]+$/.test(c))) {
          rows.push(row);
        }
        i++;
      }
      if (rows.length > 0) {
        const header = rows[0];
        const body = rows.slice(1);
        nodes.push(
          <div key={key++} style={{
            borderRadius: 12,
            overflow: 'hidden',
            background: 'rgba(var(--athena-accent-rgb), 0.03)',
            border: '0.5px solid var(--athena-border)',
            backdropFilter: 'blur(8px)',
            WebkitBackdropFilter: 'blur(8px)',
            margin: '8px 0',
          }}>
            <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}>
              <thead>
                <tr>
                  {header.map((cell, ci) => (
                    <th key={ci} style={{
                      padding: '10px 12px 10px 14px',
                      textAlign: 'left',
                      fontWeight: 600,
                      color: 'var(--athena-text)',
                    }} dangerouslySetInnerHTML={{ __html: inlineMD(cell, sources) }} />
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr><td colSpan={header.length} style={{ height: '0.5px', background: 'var(--athena-border)', padding: 0 }} /></tr>
                {body.map((row, ri) => (
                  <tr key={ri} style={{ transition: 'background 120ms' }}
                    onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(var(--athena-accent-rgb), 0.04)'; }}
                    onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'none'; }}
                  >
                    {row.map((cell, ci) => (
                      <td key={ci} style={{
                        padding: '10px 12px 10px 14px',
                        color: 'var(--athena-text-2)',
                        borderBottom: ri < body.length - 1 ? '0.5px solid var(--athena-border)' : 'none',
                      }} dangerouslySetInnerHTML={{ __html: inlineMD(cell, sources) }} />
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
        continue;
      }
    }

    /* regular paragraph */
    nodes.push(<p key={key++} dangerouslySetInnerHTML={{ __html: inlineMD(trimmed, sources) }} />);
    i++;
  }

  return nodes;
}

function formatTime(ms: number): string {
  return (ms / 1000).toFixed(2) + 's';
}

function normalizeSearchQuery(q: string): string {
  return q.toLowerCase().replace(/\s+/g, ' ').trim();
}

function displayQuery(q: string, type?: string): string {
  if (type === 'webpage') {
    try { return new URL(q).hostname; } catch { return q; }
  }
  return q;
}

type CitationTooltipItem = { domain: string; title: string; snippet: string; url: string };
type CitationTooltipPosition = { left: number; top: number };
const CITATION_TOOLTIP_MAX_HEIGHT = 160;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

function estimateCitationTooltipSize(items: CitationTooltipItem[]): { width: number; height: number } {
  const width = clamp(
    items.reduce((max, item) => Math.max(max, item.title.length * 7 + 72, item.domain.length * 6 + 72), 200),
    200,
    320,
  );
  const height = Math.min(items.length * 44 + 16, CITATION_TOOLTIP_MAX_HEIGHT);
  return { width, height };
}

function computeCitationTooltipPosition(
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

/* ── Diagram fullscreen overlay ── */
function DiagramOverlay({ svg, onClose }: { svg: string; onClose: () => void }) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 999999,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(0,0,0,0.65)',
        backdropFilter: 'blur(24px) saturate(140%)',
        WebkitBackdropFilter: 'blur(24px) saturate(140%)',
        padding: '5vh 5vw',
        cursor: 'zoom-out',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        className="diagram-overlay-box"
        style={{
          width: '100%', height: '100%',
          maxWidth: '95vw', maxHeight: '90vh',
          overflow: 'auto',
          background: 'var(--athena-bg)',
          borderRadius: 16,
          padding: 24,
          boxShadow: '0 32px 80px rgba(0,0,0,0.5)',
          cursor: 'default',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    </div>
  );
}

/* ── Types ── */
interface ChatProps {
  chatMessages: Record<string, Message[]>;
  onUpdateMessages: React.Dispatch<React.SetStateAction<Record<string, Message[]>>>;
  conversations: { id: string; title: string | null; query: string; timestamp: Date }[];
}

/* ── Component ── */
export default function Chat({ chatMessages, onUpdateMessages, conversations }: ChatProps) {
  const { id } = useParams<{ id: string }>();
  const location = useLocation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const convId = id ?? '';

  const initialQuery = (location.state as { query?: string; mode?: 'quick' | 'deep' } | null)?.query ?? '';
  const initialMode = (location.state as { query?: string; mode?: 'quick' | 'deep' } | null)?.mode ?? getDefaultMode();
  const conversationMode = useRef(initialMode);

  const [messages, setMessages] = useState<Message[]>([]);
  const messagesRef = useRef<Message[]>([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [diagramSvg, setDiagramSvg] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [liveMs, setLiveMs] = useState(0);
  const [editIndex, setEditIndex] = useState(-1);
  const [editText, setEditText] = useState('');
  const [sourceExpanded, setSourceExpanded] = useState(false);
  const [panelOpacity, setPanelOpacity] = useState(0);
  const [panelSources, setPanelSources] = useState<Source[]>([]);
  const panelFadeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [copiedIndex, setCopiedIndex] = useState(-1);
  const [isSearching, setIsSearching] = useState(false);
  const editRef = useRef<HTMLParagraphElement>(null);
  const startTimeRef = useRef(0);
  const searchingRef = useRef(false);
  const searchStartRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const runGenRef = useRef(0);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const citationHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrolledRef = useRef(false);
  const [activeMsgIdx, setActiveMsgIdx] = useState(-1);
  const [modalMsgIdx, setModalMsgIdx] = useState(-1);


  /* Disable browser scroll restoration */
  useEffect(() => {
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  }, []);

  /* Keep messagesRef in sync */
  useEffect(() => { messagesRef.current = messages; }, [messages]);

  /* Track which message is most visible in the viewport */
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;

    function updateActive() {
      if (!container) return;
      const els = container.querySelectorAll<HTMLElement>('[data-msg-index]');
      if (els.length === 0) return;
      const containerRect = container.getBoundingClientRect();
      const cCenter = containerRect.top + containerRect.height / 2;

      let best = -1;
      let bestDist = Infinity;
      for (const el of els) {
        const idx = parseInt(el.getAttribute('data-msg-index') || '', 10);
        if (isNaN(idx)) continue;
        const rect = el.getBoundingClientRect();
        const eCenter = rect.top + rect.height / 2;
        const dist = Math.abs(eCenter - cCenter);
        if (dist < bestDist) { bestDist = dist; best = idx; }
      }
      if (best >= 0) setActiveMsgIdx(best);
    }

    updateActive();
    container.addEventListener('scroll', updateActive, { passive: true });
    const mut = new MutationObserver(updateActive);
    mut.observe(container, { childList: true, subtree: true });
    return () => { container.removeEventListener('scroll', updateActive); mut.disconnect(); };
  }, []);

  /* Fade-in / fade-out for right sources panel */
  useEffect(() => {
    const msg = activeMsgIdx >= 0 && activeMsgIdx < messages.length ? messages[activeMsgIdx] : null;
    const srcs = msg?.type === 'assistant' && msg.data ? msg.data.sources : [];
    if (srcs.length > 0) {
      if (panelFadeTimer.current) clearTimeout(panelFadeTimer.current);
      setPanelSources(srcs);
      setPanelOpacity(1);
    } else {
      setPanelOpacity(0);
      panelFadeTimer.current = setTimeout(() => setPanelSources([]), 200);
    }
    return () => { if (panelFadeTimer.current) clearTimeout(panelFadeTimer.current); };
  }, [activeMsgIdx, messages]);

  /* Restore scroll position after re-renders */

  /* Live timer: runs while last assistant message is loading */
  useEffect(() => {
    const last = messages[messages.length - 1];
    const isLoading = last?.type === 'assistant' && last.loading;

    if (isLoading) {
      if (startTimeRef.current === 0) {
        startTimeRef.current = Date.now();
      }

      /* Proactive timeout: auto-abort after 120s of loading */
      const abortTimer = setTimeout(() => {
        abortRef.current?.abort();
        searchingRef.current = false;
        searchStartRef.current = 0;
        setMessages(prev => {
          const updated = [...prev];
          const lastMsg = updated[updated.length - 1];
          if (lastMsg?.type === 'assistant' && lastMsg.loading) {
            updated[updated.length - 1] = {
              ...lastMsg,
              loading: false,
              error: 'Sunucu yanıt vermiyor. Lütfen tekrar deneyin.',
            };
          }
          return updated;
        });
      }, 120000);

      const id = setInterval(() => setLiveMs(Date.now() - startTimeRef.current), 50);
      return () => { clearInterval(id); clearTimeout(abortTimer); };
    } else {
      startTimeRef.current = 0;
    }
  }, [messages]);

  /* Abort search on unmount */
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      searchingRef.current = false;
    };
  }, []);

  /* Load messages on mount */
  useEffect(() => {
    if (!convId) return;
    const existing = chatMessages[convId];
    if (existing && existing.length > 0) {
      setMessages(existing);
      setLoaded(true);
    } else {
      fetchMessages(convId).then(msgs => {
        if (msgs.length > 0) {
          setMessages(msgs);
          onUpdateMessages(prev => ({ ...prev, [convId]: msgs }));
        }
        setLoaded(true);
      });
    }
  }, [convId]);

  /* Persist messages whenever they change */
  const persist = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    if (!convId || messages.length === 0) return;
    clearTimeout(persist.current);
    persist.current = setTimeout(() => {
      saveMessages(convId, messages);
      onUpdateMessages(prev => ({ ...prev, [convId]: messages }));
    }, 300);
    return () => clearTimeout(persist.current);
  }, [messages, convId, onUpdateMessages]);

  /* Citation tooltip — proper event-driven hover, no timers */
  const [citationTooltip, setCitationTooltip] = useState<{
    visible: boolean;
    rect: DOMRect;
    items: CitationTooltipItem[];
  }>({ visible: false, rect: new DOMRect(), items: [] });
  const [citationTooltipPos, setCitationTooltipPos] = useState<CitationTooltipPosition>({ left: 0, top: 0 });

  useEffect(() => {
    let activeBadge: HTMLElement | null = null;

    const hide = () => {
      if (citationHideTimerRef.current) {
        clearTimeout(citationHideTimerRef.current);
        citationHideTimerRef.current = null;
      }
      activeBadge = null;
      setCitationTooltip(prev => ({ ...prev, visible: false }));
    };

    const show = (badge: HTMLElement) => {
      activeBadge = badge;

      const rect = badge.getBoundingClientRect();
      const domains = (badge.dataset.domain || '').split(',').map(s => s.trim());
      const titles = (badge.dataset.title || '').split(' || ').map(s => s.trim());
      const snippets = (badge.dataset.snippet || '').split(' ||| ').map(s => s.trim());
      const urls = (badge.dataset.url || '').split(',').map(s => s.trim());

      const items = domains.map((domain, i) => ({
        domain,
        title: titles[i] || domain,
        snippet: snippets[i] || '',
        url: urls[i] || badge.getAttribute('href') || '',
      })).filter(item => item.domain || item.title);

      setCitationTooltip({ visible: true, rect, items });
      setCitationTooltipPos(computeCitationTooltipPosition(rect, estimateCitationTooltipSize(items)));
    };

    const isInBadge = (el: Element | null): boolean =>
      el instanceof HTMLElement && el.closest('.citation-badge') !== null;

    const isInTooltip = (el: Element | null): boolean =>
      el instanceof HTMLElement && el.closest('.citation-tooltip-react') !== null;

    const isHoveringCitation = (x: number, y: number): boolean => {
      const el = document.elementFromPoint(x, y);
      return isInBadge(el) || isInTooltip(el);
    };

    const onMouseOver = (e: MouseEvent) => {
      const badge = (e.target as HTMLElement).closest('.citation-badge') as HTMLElement | null;
      if (badge && badge !== activeBadge) {
        show(badge);
      }
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!citationTooltip.visible) return;
      if (isHoveringCitation(e.clientX, e.clientY)) {
        if (citationHideTimerRef.current) {
          clearTimeout(citationHideTimerRef.current);
          citationHideTimerRef.current = null;
        }
        return;
      }

      if (!citationHideTimerRef.current) {
        citationHideTimerRef.current = setTimeout(() => {
          citationHideTimerRef.current = null;
          hide();
        }, 140);
      }
    };

    document.addEventListener('mouseover', onMouseOver);
    document.addEventListener('mousemove', onMouseMove);

    return () => {
      if (citationHideTimerRef.current) {
        clearTimeout(citationHideTimerRef.current);
        citationHideTimerRef.current = null;
      }
      document.removeEventListener('mouseover', onMouseOver);
      document.removeEventListener('mousemove', onMouseMove);
    };
  }, [citationTooltip.visible]);

  useLayoutEffect(() => {
    if (!citationTooltip.visible || !tooltipRef.current) return;
    const box = tooltipRef.current.getBoundingClientRect();
    const next = computeCitationTooltipPosition(citationTooltip.rect, {
      width: box.width || estimateCitationTooltipSize(citationTooltip.items).width,
      height: box.height || estimateCitationTooltipSize(citationTooltip.items).height,
    });
    setCitationTooltipPos(prev =>
      prev.left === next.left && prev.top === next.top ? prev : next
    );
  }, [citationTooltip.visible, citationTooltip.rect, citationTooltip.items]);

  useEffect(() => {
    if (!citationTooltip.visible) return;
    const update = () => {
      const box = tooltipRef.current?.getBoundingClientRect();
      setCitationTooltipPos(
        computeCitationTooltipPosition(citationTooltip.rect, {
          width: box?.width || estimateCitationTooltipSize(citationTooltip.items).width,
          height: box?.height || estimateCitationTooltipSize(citationTooltip.items).height,
        })
      );
    };

    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [citationTooltip.visible, citationTooltip.rect, citationTooltip.items]);

  const runSearch = useCallback((q: string, history?: { role: string; content: string }[], mode?: 'quick' | 'deep') => {
    const myGen = ++runGenRef.current;

    if (searchingRef.current) searchingRef.current = false;

    const controller = new AbortController();
    abortRef.current = controller;

    searchingRef.current = true;
    setIsSearching(true);
    searchStartRef.current = Date.now();
    const searchStart = Date.now();

    let accumulatedAnswer = '';

    /* Token flush state */
    const flushRef = { current: undefined as ReturnType<typeof setTimeout> | undefined };
    const doFlush = () => {
      if (myGen !== runGenRef.current) return;
      setMessages(prev => {
        if (myGen !== runGenRef.current) return prev;
        const updated = [...prev];
        const last = updated[updated.length - 1];
        if (last?.type === 'assistant') {
          updated[updated.length - 1] = { ...last, content: accumulatedAnswer, streaming: true };
        }
        return updated;
      });
    };
    const scheduleFlush = () => {
      if (flushRef.current) return;
      flushRef.current = setTimeout(() => {
        flushRef.current = undefined;
        doFlush();
      }, 40);
    };

    const isStale = () => myGen !== runGenRef.current;

    search(q, history, mode, controller.signal)
      .then(({ id }) => {
        if (isStale()) return;

        const unsubscribe = subscribeToJobEvents(id, {
          onToken: (text) => {
            if (isStale()) return;
            accumulatedAnswer += text;
            scheduleFlush();
          },
          onStep: (step) => {
            if (isStale()) return;
            setMessages(prev => {
              if (myGen !== runGenRef.current) return prev;
              const updated = [...prev];
              const last = updated[updated.length - 1];
              if (last?.type !== 'assistant') return prev;

              let activeSteps = last.activeSteps || [];
              const matchIdx = activeSteps.findIndex(s => {
                if (s.type === step.type) {
                  if (step.type === 'search' || step.type === 'webpage') {
                    return s.query === step.query;
                  }
                  return true;
                }
                return false;
              });
              if (matchIdx >= 0) {
                activeSteps = activeSteps.map((s, idx) => idx === matchIdx ? { ...s, ...step } : s);
              } else {
                activeSteps = [...activeSteps, step];
              }

              let searches = last.searches || [];
              if ((step.type === 'search' || step.type === 'webpage') && step.query) {
                const targetQuery = normalizeSearchQuery(step.query!);
                if (step.duration_ms !== undefined) {
                  const matchIndex = [...searches].reverse().findIndex(s =>
                    s.status === 'searching' && normalizeSearchQuery(s.query) === targetQuery
                  );
                  const resolvedIndex = matchIndex >= 0
                    ? searches.length - 1 - matchIndex
                    : searches.map((s, idx) => (s.status === 'searching' ? idx : -1)).filter(idx => idx >= 0).pop();
                  if (resolvedIndex !== undefined && resolvedIndex !== null && resolvedIndex >= 0) {
                    searches = searches.map((s, idx) =>
                      idx === resolvedIndex ? { ...s, status: 'searched' as const, duration_ms: step.duration_ms, model: step.model } : s
                    );
                  }
                } else {
                  searches = [...searches, { query: step.query!, status: 'searching', type: step.type as 'search' | 'webpage', model: step.model }];
                }
              }

              updated[updated.length - 1] = {
                ...last,
                activeSteps,
                searches,
              };
              return updated;
            });
          },
          onSources: (sources) => {
            if (isStale()) return;
            setMessages(prev => {
              if (myGen !== runGenRef.current) return prev;
              const updated = [...prev];
              const last = updated[updated.length - 1];
              if (last?.type === 'assistant') {
                updated[updated.length - 1] = { ...last, searches: last.searches, data: { ...last.data, sources } as SearchResponse };
              }
              return updated;
            });
          },
          onDone: (response) => {
            if (isStale()) return;
            clearTimeout(flushRef.current);
            flushRef.current = undefined;
            accumulatedAnswer = response.answer;
            doFlush();

            const elapsed = response.elapsed_ms;
            setMessages(prev => {
              if (myGen !== runGenRef.current) return prev;
              const updated = [...prev];
              const last = updated[updated.length - 1];
                if (last?.type === 'assistant') {
                  const searches = (last.searches || []).map(s => {
                    if (!s.duration_ms) {
                      const step = response.steps.find(st =>
                        (st.type === 'search' || st.type === 'webpage') &&
                        st.query &&
                        normalizeSearchQuery(st.query) === normalizeSearchQuery(s.query)
                      ) || response.steps.find(st => st.type === 'search' || st.type === 'webpage');
                      return { ...s, duration_ms: step?.duration_ms, status: 'searched' as const };
                    }
                    return s;
                  });
                updated[updated.length - 1] = { ...last, searches, type: 'assistant', content: response.answer, data: response, loading: false, streaming: false, timerMs: elapsed };
              }
              return updated;
            });
            if (myGen === runGenRef.current) {
              searchingRef.current = false;
              searchStartRef.current = 0;
              setIsSearching(false);
            }
          },
          onError: (message) => {
            if (isStale()) return;
            clearTimeout(flushRef.current);
            flushRef.current = undefined;
            doFlush();

            const elapsed = Date.now() - searchStart;
            setMessages(prev => {
              if (myGen !== runGenRef.current) return prev;
              const updated = [...prev];
              const last = updated[updated.length - 1];
              if (last?.type === 'assistant') {
                updated[updated.length - 1] = { ...last, error: message, loading: false, timerMs: elapsed };
              }
              return updated;
            });
            if (myGen === runGenRef.current) {
              searchingRef.current = false;
              searchStartRef.current = 0;
              setIsSearching(false);
            }
          },
        }, controller.signal);

        controller.signal.addEventListener('abort', unsubscribe, { once: true });
      })
      .catch((err: Error) => {
        if (isStale() || err.name === 'AbortError') return;
        const elapsed = Date.now() - searchStart;
        setMessages(prev => {
          if (myGen !== runGenRef.current) return prev;
          const updated = [...prev];
          const last = updated[updated.length - 1];
          if (last?.type === 'assistant') {
            updated[updated.length - 1] = { ...last, error: err.message, loading: false, timerMs: elapsed };
          }
          return updated;
        });
        searchingRef.current = false;
        searchStartRef.current = 0;
        setIsSearching(false);
      });
  }, []);

  /* Initial search when new conversation */
  useEffect(() => {
    if (!initialQuery || !loaded || messages.length > 0) return;
    setMessages([{ type: 'user', content: initialQuery }, { type: 'assistant', content: '', loading: true }]);
    runSearch(initialQuery, undefined, conversationMode.current);
  }, [initialQuery, loaded, messages.length, runSearch]);

  useLayoutEffect(() => {
    if (scrollRef.current && messages.length > 0) {
      const smooth = scrolledRef.current;
      scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: smooth ? 'smooth' : 'instant' });
      scrolledRef.current = true;
    }
  }, [messages]);

  const handleFollowUp = useCallback((q: string) => {
    if (searchingRef.current) return;
    const currentMessages = messagesRef.current;
    const history = [...currentMessages]
      .filter(m => m.content && !m.loading)
      .map(m => ({ role: m.type === 'user' ? 'user' as const : 'assistant' as const, content: m.content }));

    setMessages(prev => [...prev, { type: 'user', content: q }, { type: 'assistant', content: '', loading: true }]);
    setTimeout(() => {
      runSearch(q, history, conversationMode.current);
    }, 0);
  }, [runSearch]);

  const retryLast = useCallback(() => {
    const currentMessages = messagesRef.current;
    const q = [...currentMessages].reverse().find(m => m.type === 'user')?.content;
    if (!q) return;

    setMessages(prev => {
      const updated = [...prev];
      const last = updated[updated.length - 1];
      if (last?.type === 'assistant') {
        updated[updated.length - 1] = { type: 'assistant', content: '', loading: true, timerMs: undefined };
      }
      return updated;
    });
    runSearch(q, [...currentMessages]
      .filter(m => m.content && !m.loading)
      .map(m => ({ role: m.type === 'user' ? 'user' as const : 'assistant' as const, content: m.content }))
    );
  }, [runSearch]);

  /* Listen for regenerate event from context menu */
  useEffect(() => {
    const handler = () => retryLast();
    window.addEventListener('athena:regenerate', handler);
    return () => window.removeEventListener('athena:regenerate', handler);
  }, [retryLast]);

  /* Focus contentEditable when edit mode activates */
  useEffect(() => {
    if (editIndex >= 0 && editRef.current) {
      editRef.current.focus();
      const range = document.createRange();
      range.selectNodeContents(editRef.current);
      const sel = window.getSelection();
      if (sel) { sel.removeAllRanges(); sel.addRange(range); }
    }
  }, [editIndex]);

  const handleEditSave = useCallback((index: number) => {
    const newText = editText.trim();
    if (!newText || index < 0) return;
    const currentMessages = messagesRef.current;
    const history = currentMessages.slice(0, index)
      .filter(m => m.content && !m.loading)
      .map(m => ({ role: m.type === 'user' ? 'user' as const : 'assistant' as const, content: m.content }));

    setMessages(prev => {
      const updated = prev.slice(0, index + 1);
      updated[index] = { ...updated[index], content: newText };
      updated.push({ type: 'assistant', content: '', loading: true });
      return updated;
    });

    runSearch(newText, history);
    setEditIndex(-1);
  }, [editText, runSearch]);

  const currentConv = conversations.find(c => c.id === convId);
  const title = currentConv?.title ?? currentConv?.query ?? '';

  return (
    <div
      style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative', isolation: 'isolate' }}
    >
      {/* Title */}
      {title && (
        <span
          data-ctx="title"
          style={{
            position: 'absolute',
            top: 14,
            right: 28,
            fontSize: 13,
            fontWeight: 400,
            color: 'var(--athena-text-3)',
            whiteSpace: 'nowrap',
            opacity: 0.7,
          }}
        >
          {title}
        </span>
      )}

        <div
          ref={scrollRef}
          style={{
            flex: 1,
            overflow: 'hidden auto',
            padding: '14px 28px 0',
            maxWidth: 720,
            margin: '0 auto',
            width: '100%',
          }}
        >
          {messages.map((msg, i) => {
            const displayMs = msg.loading ? liveMs : (msg.timerMs ?? liveMs);

            return (
              <div key={i} data-msg-index={i} data-msg-type={msg.type} className="message-block" style={{ marginBottom: 20, animation: 'fade-in-up 0.3s var(--ease-out) both' }}>
                {msg.type !== 'user' && msg.searches && msg.searches.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginBottom: 8, padding: '0 4px' }}>
                    {msg.searches.map((s, si) => (
                      <div key={si} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10.5, color: s.status === 'searching' ? 'var(--athena-text-3)' : 'var(--athena-text-2)', fontFamily: 'inherit' }}>
                        {s.status === 'searching' ? (
                          <Loader2 size={10} style={{ flexShrink: 0, animation: 'spin 1s linear infinite' }} />
                        ) : (
                          <Check size={10} style={{ flexShrink: 0 }} />
                        )}
                        <span style={{ opacity: s.status === 'searching' ? 0.8 : 0.6 }}>
                          {s.status === 'searching'
                            ? (s.type === 'webpage' ? 'Fetching' : 'Searching')
                            : (s.type === 'webpage' ? 'Fetched' : 'Searched')
                          }
                        </span>
                        <span style={{ color: 'var(--athena-text-2)', fontWeight: 450, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {displayQuery(s.query, s.type)}
                        </span>
                        {s.model && (
                          <span style={{
                            fontSize: 8,
                            color: 'var(--athena-text-3)',
                            background: 'rgba(var(--athena-accent-rgb), 0.04)',
                            padding: '1px 4px',
                            borderRadius: 3,
                            marginLeft: 2,
                          }}>
                            {s.model}
                          </span>
                        )}
                        {s.duration_ms !== undefined && (
                          <span style={{ fontSize: 9, opacity: 0.45, fontVariantNumeric: 'tabular-nums' }}>
                            {(s.duration_ms / 1000).toFixed(1)}s
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                {msg.type === 'user' ? (
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }} className="message-user">
                    <div
                      className="glass-panel"
                      style={{
                        padding: '10px 16px',
                        borderRadius: 18,
                        maxWidth: '70%',
                        background: 'rgba(var(--athena-accent-rgb), 0.08)',
                      }}
                    >
                      <p data-msg-content="true" ref={editIndex === i ? editRef : undefined}
                        contentEditable={editIndex === i}
                        suppressContentEditableWarning
                        onInput={e => setEditText((e.target as HTMLElement).innerText)}
                        onKeyDown={e => {
                          if (editIndex !== i) return;
                          if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault();
                            handleEditSave(i);
                          }
                          if (e.key === 'Escape') setEditIndex(-1);
                        }}
                        style={{
                          margin: editIndex === i ? -2 : 0, fontSize: 14, color: 'var(--athena-text)', lineHeight: 1.4,
                          outline: editIndex === i ? '0.5px solid rgba(var(--athena-accent-rgb), 0.3)' : 'none',
                          borderRadius: 4,
                          padding: editIndex === i ? '2px 4px' : 0,
                          caretColor: 'var(--athena-accent)',
                        }}
                      >
                        {msg.content}
                      </p>
                    </div>
                    {/* Edit/save footer (always in DOM, visible on hover) */}
                    <div style={{
                      display: 'flex', alignItems: 'center', gap: 6,
                      marginTop: 4,
                      opacity: editIndex === i ? 1 : 0, transition: 'opacity 0.15s',
                    }} className={editIndex !== i ? 'user-edit-actions' : ''}>
                      {editIndex === i ? (
                        <>
                          <button
                            onClick={() => setEditIndex(-1)}
                            style={{
                              background: 'none', border: '0.5px solid var(--athena-border)',
                              borderRadius: 5, padding: '2px 8px', fontSize: 9.5,
                              cursor: 'pointer', color: 'var(--athena-text-3)', fontFamily: 'inherit',
                            }}
                          >Cancel</button>
                          <button
                            onClick={() => handleEditSave(i)}
                            style={{
                              background: 'rgba(var(--athena-accent-rgb), 0.12)',
                              border: '0.5px solid rgba(var(--athena-accent-rgb), 0.2)',
                              borderRadius: 5, padding: '2px 8px', fontSize: 9.5,
                              cursor: 'pointer', color: 'var(--athena-accent)', fontFamily: 'inherit',
                            }}
                          >Save & Regenerate</button>
                        </>
                      ) : (
                        <button
                          onClick={() => { setEditIndex(i); setEditText(msg.content); }}
                          style={{
                            background: 'none', border: 'none', cursor: 'pointer',
                            padding: 1, color: 'var(--athena-text-3)', display: 'flex',
                          }}
                        >
                          <Pencil size={10} />
                        </button>
                      )}
                    </div>
                  </div>
                ) : msg.loading ? (
                  <>
                    {msg.streaming && msg.content && (
                      <div className="athena-prose" data-msg-content="true" style={{ opacity: 0.8 }}>
                        {renderMarkdown(msg.content, getSourcesForMessage(msg, i, messages), setDiagramSvg)}
                      </div>
                    )}
                    {msg.activeSteps && msg.activeSteps.length > 0 && (() => {
                      const latestStep = msg.activeSteps[msg.activeSteps.length - 1];
                      const label = latestStep.type === 'synthesize' ? 'Synthesizing' : (STEP_LABELS[latestStep.type] || 'Thinking');
                      return (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10.5, color: 'var(--athena-text-3)', marginBottom: 6, padding: '0 4px' }}>
                          <Loader2 size={10} style={{ flexShrink: 0, animation: 'spin 1s linear infinite' }} />
                          <span style={{ opacity: 0.8, textTransform: 'uppercase', fontSize: 9, fontWeight: 600, letterSpacing: '0.05em' }}>
                            {label}
                          </span>
                          {latestStep.model && (
                            <span style={{
                              fontSize: 8.5,
                              color: 'var(--athena-accent)',
                              background: 'rgba(var(--athena-accent-rgb), 0.06)',
                              padding: '1px 5px',
                              borderRadius: 3,
                              fontWeight: 500,
                            }}>
                              {latestStep.model}
                            </span>
                          )}
                        </div>
                      );
                    })()}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
                      <span style={{ fontSize: 10.5, color: 'var(--athena-text-3)', fontVariantNumeric: 'tabular-nums' }}>
                        {formatTime(displayMs)}
                      </span>
                      <button onClick={() => { setModalMsgIdx(i); setModalOpen(true); }} style={{
                        background: 'none', border: 'none', cursor: 'pointer',
                        padding: 1, color: 'var(--athena-text-3)', display: 'flex',
                        transition: 'color var(--duration-fast)',
                      }}
                        onMouseEnter={e => (e.currentTarget as HTMLElement).style.color = 'var(--athena-text-2)'}
                        onMouseLeave={e => (e.currentTarget as HTMLElement).style.color = 'var(--athena-text-3)'}
                      >
                        <MoreHorizontal size={11} />
                      </button>
                    </div>
                  </>
                ) : msg.error ? (
                  <div>
                    <p style={{ fontSize: 13, color: 'var(--athena-text-2)', margin: '0 0 12px' }}>{msg.error}</p>
                    <button
                      onClick={retryLast}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 5, padding: '6px 12px',
                        background: 'none', border: '0.5px solid var(--athena-border)',
                        borderRadius: 8, cursor: 'pointer', fontSize: 11, color: 'var(--athena-text-3)',
                        fontFamily: 'inherit', width: 'fit-content',
                      }}
                      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = 'var(--athena-text-2)'; (e.currentTarget as HTMLElement).style.borderColor = 'rgba(var(--athena-accent-rgb), 0.12)'; }}
                      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = 'var(--athena-text-3)'; (e.currentTarget as HTMLElement).style.borderColor = 'var(--athena-border)'; }}
                    >
                      <RefreshCw size={10} />
                      <span>Retry</span>
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="athena-prose" data-msg-content="true">
                      {renderMarkdown(msg.content, getSourcesForMessage(msg, i, messages), setDiagramSvg)}
                    </div>

                    {/* Footer: actions + timer (always in DOM, visible on hover) */}
                    <div style={{
                      display: 'flex', alignItems: 'center', gap: 6,
                      marginTop: 4,
                      opacity: 0, transition: 'opacity 0.15s',
                    }}
                      className="footer-actions"
                    >
                      {msg.data && msg.data.sources.length > 0 && (
                        <div style={{
                          display: 'inline-flex', alignItems: 'center', gap: 6,
                          padding: '1px 6px 1px 4px', borderRadius: 6,
                          background: 'rgba(var(--athena-accent-rgb), 0.04)',
                          border: '0.5px solid rgba(var(--athena-accent-rgb), 0.08)',
                          cursor: 'default', fontSize: 9.5,
                          color: 'var(--athena-text-3)', fontWeight: 500,
                        }}>
                          <div style={{ display: 'flex', alignItems: 'center' }}>
                            {msg.data.sources.slice(0, 4).map((src, i) => (
                              <img key={i}
                                src={`https://www.google.com/s2/favicons?domain=${src.domain}&sz=16`}
                                width={12} height={12} loading="lazy" alt=""
                                onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                                style={{
                                  borderRadius: 2, marginLeft: i === 0 ? 0 : -4,
                                  position: 'relative', zIndex: 4 - i,
                                  border: '0.5px solid var(--athena-bg)',
                                }} />
                            ))}
                            {msg.data.sources.length > 4 && (
                              <span style={{ marginLeft: 0, fontSize: 8, fontWeight: 600, color: 'var(--athena-text-3)' }}>
                                +{msg.data.sources.length - 4}
                              </span>
                            )}
                          </div>
                          Sources
                        </div>
                      )}
                      <button onClick={() => {
                        navigator.clipboard.writeText(msg.content);
                        setCopiedIndex(i);
                        setTimeout(() => setCopiedIndex(-1), 1200);
                      }} style={{
                        background: 'none', border: 'none', cursor: 'pointer',
                        padding: 1, color: 'var(--athena-text-3)', display: 'flex',
                        transition: 'color var(--duration-fast)',
                      }}
                        onMouseEnter={e => (e.currentTarget as HTMLElement).style.color = 'var(--athena-text-2)'}
                        onMouseLeave={e => (e.currentTarget as HTMLElement).style.color = 'var(--athena-text-3)'}
                      >
                        {copiedIndex === i ? <Check size={11} /> : <Copy size={11} />}
                      </button>
                      <button onClick={() => { setModalMsgIdx(i); setModalOpen(true); }} style={{
                        background: 'none', border: 'none', cursor: 'pointer',
                        padding: 1, color: 'var(--athena-text-3)', display: 'flex',
                        transition: 'color var(--duration-fast)',
                      }}
                        onMouseEnter={e => (e.currentTarget as HTMLElement).style.color = 'var(--athena-text-2)'}
                        onMouseLeave={e => (e.currentTarget as HTMLElement).style.color = 'var(--athena-text-3)'}
                      >
                        <MoreHorizontal size={11} />
                      </button>
                      <span style={{ fontSize: 9.5, color: 'var(--athena-text-3)', fontVariantNumeric: 'tabular-nums' }}>
                        {formatTime(displayMs)}
                      </span>
                      <button onClick={retryLast} style={{
                        background: 'none', border: 'none', cursor: 'pointer',
                        padding: 1, color: 'var(--athena-text-3)', display: 'flex',
                        transition: 'color var(--duration-fast)',
                      }}
                        onMouseEnter={e => (e.currentTarget as HTMLElement).style.color = 'var(--athena-text-2)'}
                        onMouseLeave={e => (e.currentTarget as HTMLElement).style.color = 'var(--athena-text-3)'}
                      >
                        <RefreshCw size={10} />
                      </button>
                    </div>
                  </>
              )}
            </div>
            );
          })}
        </div>

        <div style={{ flexShrink: 0, padding: '12px 28px 20px', maxWidth: 720, margin: '0 auto', width: '100%' }}>
          <SearchInput 
            onSubmit={handleFollowUp} 
            compact 
            dropdownUp 
            initialMode={conversationMode.current} 
            disabled={isSearching}
          />
        </div>

      <div style={{
        position: 'fixed',
        top: '50%',
        right: 16,
        transform: 'translateY(-50%)',
        width: 260,
        display: 'flex',
        flexDirection: 'column',
        zIndex: 999,
        transition: 'opacity 200ms ease',
        opacity: panelOpacity,
      }}>
        {panelSources.length > 0 && (() => {
          const totalCount = panelSources.length;
          const expanded = sourceExpanded;
          const items = expanded ? panelSources : panelSources.slice(0, 3);
          return (
            <div style={{
              background: 'var(--athena-bg)',
              border: '0.5px solid var(--athena-border)',
              borderRadius: 12,
              pointerEvents: 'auto',
              overflow: 'hidden',
              display: 'flex',
              flexDirection: 'column',
              boxShadow: '0 4px 24px rgba(0,0,0,0.06)',
              maxHeight: '70vh',
            }}>
              {/* Header */}
              <div style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '10px 12px 8px 14px',
                flexShrink: 0,
                fontSize: 10,
                color: 'var(--athena-text-3)',
                borderBottom: '0.5px solid var(--athena-border)',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center' }}>
                    {panelSources.slice(0, 4).map((s, i) => (
                      <img key={i}
                        src={`https://www.google.com/s2/favicons?domain=${s.domain}&sz=16`}
                        width={14} height={14} loading="lazy" alt=""
                        onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                        style={{
                          borderRadius: 2, marginLeft: i === 0 ? 0 : -4,
                          position: 'relative', zIndex: 4 - i,
                        }} />
                    ))}
                    {panelSources.length > 4 && (
                      <span style={{ marginLeft: 2, fontSize: 8, fontWeight: 600, color: 'var(--athena-text-3)' }}>
                        +{panelSources.length - 4}
                      </span>
                    )}
                  </div>
                  <span style={{ fontSize: 10, color: 'var(--athena-text-2)', whiteSpace: 'nowrap' }}>{totalCount} sources</span>
                </div>
              </div>

              <div style={{ height: '0.5px', background: 'var(--athena-border)', margin: '0 12px', flexShrink: 0 }} />

              {/* Source items */}
              <div style={{
                overflowY: 'auto',
                maxHeight: `calc(70vh - ${expanded && totalCount > 3 ? 100 : 80}px)`,
              }}>
                {items.map((src, i) => (
                  <div key={i}>
                    {i > 0 && <div style={{ height: '0.5px', background: 'var(--athena-border)', margin: '0 12px' }} />}
                    <a href={sanitizeUrl(src.url)} target="_blank" rel="noopener noreferrer" style={{
                      display: 'flex', gap: 8,
                      padding: '10px 12px 10px 14px',
                      textDecoration: 'none',
                      transition: 'background 120ms',
                    }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(var(--athena-accent-rgb), 0.04)'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}
                    >
                      {/* Thumbnail if image exists */}
                      {src.image && (
                        <div style={{
                          width: 48, height: 48,
                          borderRadius: 6,
                          overflow: 'hidden',
                          flexShrink: 0,
                          background: 'rgba(var(--athena-accent-rgb), 0.04)',
                        }}>
                          <img src={src.image} alt=""
                            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                            onError={(e) => { (e.target as HTMLImageElement).parentElement!.style.display = 'none'; }} />
                        </div>
                      )}
                      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <img src={`https://www.google.com/s2/favicons?domain=${src.domain}&sz=32`} width={14} height={14} loading="lazy" alt=""
                            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                            style={{ borderRadius: 2, flexShrink: 0 }} />
                          <span style={{ fontSize: 10, color: 'var(--athena-text-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {src.domain}
                          </span>
                        </div>
                        <div style={{
                          fontSize: 11.5, fontWeight: 600, color: 'var(--athena-text)',
                          lineHeight: 1.3,
                          display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
                        }}>
                          {src.title || src.domain}
                        </div>
                        {src.snippet && (
                          <div style={{
                            fontSize: 10, color: 'var(--athena-text-2)',
                            lineHeight: 1.4,
                            display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
                          }}>
                            {src.snippet}
                          </div>
                        )}
                      </div>
                    </a>
                  </div>
                ))}
              </div>

              {totalCount > 3 && (
                <>
                  <div style={{ height: '0.5px', background: 'var(--athena-border)', margin: '0 12px', flexShrink: 0 }} />
                  {/* Footer: Show all / Hide */}
                  <button
                    onClick={() => setSourceExpanded(!expanded)}
                    style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4,
                      padding: '8px 12px',
                      background: 'none', border: 'none', cursor: 'pointer',
                      fontSize: 10.5, fontWeight: 500, color: 'var(--athena-text-3)',
                      fontFamily: 'inherit', flexShrink: 0,
                      transition: 'background 120ms',
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(var(--athena-accent-rgb), 0.04)'; e.currentTarget.style.color = 'var(--athena-text-2)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = 'var(--athena-text-3)'; }}
                  >
                    {expanded ? 'Show less' : 'Show all'}
                    <span style={{ fontSize: 11, transform: expanded ? 'rotate(180deg) translateY(0.5px)' : 'translateY(0.5px)', display: 'inline-block' }}>→</span>
                  </button>
                </>
              )}
            </div>
          );
        })()}
      </div>

      {(() => {
        const modalMsg = modalMsgIdx >= 0 && modalMsgIdx < messages.length
          ? messages[modalMsgIdx]
          : activeMsgIdx >= 0 && activeMsgIdx < messages.length
          ? messages[activeMsgIdx]
          : null;
        return modalMsg?.type === 'assistant' ? (
          <ActivityModal
            open={modalOpen}
            onClose={() => setModalOpen(false)}
            steps={modalMsg.activeSteps || modalMsg.data?.steps || []}
            sources={modalMsg.data?.sources || []}
          />
        ) : null;
      })()}

      {citationTooltip.visible && (() => {
        return (
          <div
            className="citation-tooltip-react"
            ref={tooltipRef}
            style={{
              position: 'fixed',
              left: citationTooltipPos.left,
              top: citationTooltipPos.top,
              minWidth: 200,
              maxWidth: 'min(320px, calc(100vw - 16px))',
              maxHeight: `${CITATION_TOOLTIP_MAX_HEIGHT}px`,
              padding: '8px 10px',
              borderRadius: 8,
              background: 'var(--athena-bg)',
              border: '0.5px solid var(--athena-border)',
              boxShadow: '0 4px 16px rgba(0,0,0,0.08)',
              zIndex: 9999,
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
              pointerEvents: 'auto',
              animation: 'tooltip-in 0.12s ease both',
              overflow: 'hidden',
            }}
          >
            <div style={{ overflowY: 'auto', maxHeight: '100%', display: 'flex', flexDirection: 'column' }}>
              {citationTooltip.items.map((item, idx) => (
                <a
                  key={idx}
                  href={item.url || '#'}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 2,
                    textDecoration: 'none',
                    color: 'inherit',
                    padding: '4px 2px',
                    borderRadius: 6,
                    transition: 'background 120ms ease',
                  }}
                  onMouseEnter={e => { e.currentTarget.style.background = 'rgba(var(--athena-accent-rgb), 0.04)'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                >
                  {idx > 0 && <div style={{ height: 1, background: 'var(--athena-border)', margin: '1px 0' }} />}
                  <span className="tip-row">
                    <img
                      src={`https://www.google.com/s2/favicons?domain=${item.domain}&sz=16`}
                      width={14}
                      height={14}
                      loading="lazy" alt=""
                      onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                    />
                    <span className="tip-domain">{item.domain}</span>
                  </span>
                  <span className="tip-title">{item.title}</span>
                  {item.snippet && <span className="tip-snippet">{item.snippet}</span>}
                </a>
              ))}
            </div>
          </div>
        );
      })()}
      {diagramSvg && createPortal(<DiagramOverlay svg={diagramSvg} onClose={() => setDiagramSvg(null)} />, document.body)}
    </div>
  );
}

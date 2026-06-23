import { useState, useEffect, useRef, useCallback, useLayoutEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useParams, useLocation } from 'react-router-dom';
import useMediaQuery from '@mui/material/useMediaQuery';
import { Menu } from 'lucide-react';
import SearchInput from '../components/SearchInput';
import ActivityModal from '../components/ActivityModal';
import DiagramOverlay from '../components/DiagramOverlay';
import CitationTooltip from '../components/CitationTooltip';
import SourcesPanel from '../components/chat/SourcesPanel';
import { MessageUser, MessageLoading, MessageError, MessageComplete, MessageSearches } from '../components/chat/MessageComponents';
import { search, subscribeToJobEvents, fetchMessages, saveMessages, pauseResearchJob, resumeResearchJob, updateConversationResearch, BASE, type ConversationMeta, type DeepDepth, type Message, type SearchMode, type Source, type SearchResponse, type ResearchJobStatus } from '../lib/api';

type Conversation = Omit<ConversationMeta, 'timestamp'> & { timestamp: Date };
import { setDefaultDepth, setDefaultMode } from '../hooks/useDefaultMode';
import {
  normalizeSearchQuery,
  mergeResearchProgress,
  resolveConversationResearch,
  computeCitationTooltipPosition, estimateCitationTooltipSize,
  ABORT_TIMEOUT_MS, FALLBACK_FAVICON,
  copyToClipboard,
  type CitationTooltipItem, type CitationTooltipPosition,
} from '../lib/chat-utils';

interface ChatProps {
  chatMessages: Record<string, Message[]>;
  onUpdateMessages: React.Dispatch<React.SetStateAction<Record<string, Message[]>>>;
  conversations: Conversation[];
  onOpenSidebar?: () => void;
  onConversationResearchUpdate?: (id: string, mode: SearchMode, depth?: DeepDepth) => void;
}

export default function Chat({ chatMessages, onUpdateMessages, conversations, onOpenSidebar, onConversationResearchUpdate }: ChatProps) {
  const { id } = useParams<{ id: string }>();
  const location = useLocation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const convId = id ?? '';
  const isMobile = useMediaQuery('(max-width: 1023px)');

  const routeState = location.state as { query?: string; mode?: SearchMode; depth?: DeepDepth } | null;
  const initialQuery = routeState?.query ?? '';
  const currentConv = conversations.find(c => c.id === convId);

  const [messages, setMessages] = useState<Message[]>([]);
  const conversationMode = useRef<SearchMode>('quick');
  const conversationDepth = useRef<DeepDepth>('med');

  const research = useMemo(
    () => resolveConversationResearch({
      routeMode: routeState?.mode,
      routeDepth: routeState?.depth,
      conversation: currentConv,
      messages,
    }),
    [routeState?.mode, routeState?.depth, currentConv, messages],
  );

  useEffect(() => {
    conversationMode.current = research.mode;
    conversationDepth.current = research.depth;
  }, [research.mode, research.depth]);
  const messagesRef = useRef<Message[]>([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [diagramSvg, setDiagramSvg] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [liveMs, setLiveMs] = useState(0);
  const [editIndex, setEditIndex] = useState(-1);
  const [editText, setEditText] = useState('');

  const [panelSources, setPanelSources] = useState<Source[]>([]);
  const [panelClosing, setPanelClosing] = useState(false);
  const panelFadeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [mobileSourcesOpen, setMobileSourcesOpen] = useState(false);
  const [mobileSourcesClosing, setMobileSourcesClosing] = useState(false);
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
  const [debugContextEnabled, setDebugContextEnabled] = useState(false);

  useEffect(() => {
    if (!modalOpen) return;
    fetch(`${BASE}/settings`).then(r => r.json()).then(d => {
      setDebugContextEnabled(d.showDebugContext ?? false);
    }).catch(() => {});
  }, [modalOpen]);

  useEffect(() => {
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  }, []);

  useEffect(() => { messagesRef.current = messages; }, [messages]);

  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;

    function updateActive() {
      if (!container) return;
      const els = container.querySelectorAll<HTMLElement>('[data-msg-index]:not([data-msg-type="user"])');
      if (els.length === 0) return;
      const cRect = container.getBoundingClientRect();

      let best = -1;
      let bestRatio = 0;
      for (const el of els) {
        const idx = parseInt(el.getAttribute('data-msg-index') || '', 10);
        if (isNaN(idx)) continue;
        const r = el.getBoundingClientRect();
        const visibleTop = Math.max(r.top, cRect.top);
        const visibleBottom = Math.min(r.bottom, cRect.bottom);
        const visibleH = Math.max(0, visibleBottom - visibleTop);
        const ratio = visibleH / r.height;
        if (ratio > bestRatio) { bestRatio = ratio; best = idx; }
      }
      if (best >= 0) setActiveMsgIdx(best);
    }

    updateActive();
    container.addEventListener('scroll', updateActive, { passive: true });
    const mut = new MutationObserver(updateActive);
    mut.observe(container, { childList: true, subtree: true });
    return () => { container.removeEventListener('scroll', updateActive); mut.disconnect(); };
  }, []);

  useEffect(() => {
    const msg = activeMsgIdx >= 0 && activeMsgIdx < messages.length ? messages[activeMsgIdx] : null;
    const srcs = msg?.type === 'assistant' && msg.data ? msg.data.sources : [];
    if (srcs.length > 0) {
      if (panelFadeTimer.current) clearTimeout(panelFadeTimer.current);
      queueMicrotask(() => {
        setPanelSources(srcs);
        setPanelClosing(false);
      });
    } else {
      queueMicrotask(() => setPanelClosing(true));
      panelFadeTimer.current = setTimeout(() => { setPanelClosing(false); setPanelSources([]); }, 200);
    }
    return () => { if (panelFadeTimer.current) clearTimeout(panelFadeTimer.current); };
  }, [activeMsgIdx, messages]);

  useEffect(() => {
    const last = messages[messages.length - 1];
    const isLoading = last?.type === 'assistant' && last.loading;

    if (isLoading) {
      if (startTimeRef.current === 0) {
        startTimeRef.current = Date.now();
      }

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
              error: 'Server is not responding. Please try again.',
            };
          }
          return updated;
        });
      }, ABORT_TIMEOUT_MS);

      const id = setInterval(() => setLiveMs(Date.now() - startTimeRef.current), 50);
      return () => { clearInterval(id); clearTimeout(abortTimer); };
    } else {
      startTimeRef.current = 0;
    }
  }, [messages]);

  useEffect(() => {
    if (!convId) return;
    const existing = chatMessages[convId];
    if (existing && existing.length > 0) {
      queueMicrotask(() => {
        setMessages(existing);
        setLoaded(true);
      });
    } else {
      fetchMessages(convId).then(msgs => {
        if (msgs.length > 0) {
          setMessages(msgs);
          onUpdateMessages(prev => ({ ...prev, [convId]: msgs }));
        }
        setLoaded(true);
      }).catch(() => setLoaded(true));
    }
  }, [convId, chatMessages, onUpdateMessages]);

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
      if (badge && badge !== activeBadge) show(badge);
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
    queueMicrotask(() => {
      const box = tooltipRef.current!.getBoundingClientRect();
      const next = computeCitationTooltipPosition(citationTooltip.rect, {
        width: box.width || estimateCitationTooltipSize(citationTooltip.items).width,
        height: box.height || estimateCitationTooltipSize(citationTooltip.items).height,
      });
      setCitationTooltipPos(prev =>
        prev.left === next.left && prev.top === next.top ? prev : next
      );
    });
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

  // Badge hover → highlight preceding text via overlay div (avoids Chrome's cached-layer repaint issue)
  useEffect(() => {
    let mx = 0, my = 0;
    let overlays: HTMLDivElement[] = [];
    let activeText: HTMLElement | null = null;
    let lastRectCount = 0;

    const rmOverlays = () => {
      overlays.forEach(el => el.remove());
      overlays = [];
      lastRectCount = 0;
    };

    const mkOverlays = (t: HTMLElement) => {
      rmOverlays();
      activeText = t;
      const rects = t.getClientRects();
      const count = rects?.length || 0;
      if (!count || (count === 1 && (!rects![0].width || !rects![0].height))) {
        // fallback
        const br = t.getBoundingClientRect();
        if (br.width > 0 && br.height > 0) {
          const el = document.createElement('div');
          el.className = 'citation-overlay';
          el.style.cssText = 'position:fixed;pointer-events:none;z-index:9998;background:rgba(66,133,244,0.2);border-radius:3px';
          el.style.left = br.left + 'px';
          el.style.top = (br.top - 1) + 'px';
          el.style.width = br.width + 'px';
          el.style.height = (br.height + 2) + 'px';
          const container = scrollRef.current?.parentElement || document.body;
          container.appendChild(el);
          overlays.push(el);
          lastRectCount = 1;
        }
        return;
      }
      const container = scrollRef.current?.parentElement || document.body;
      for (let i = 0; i < count; i++) {
        const r = rects![i];
        if (r.width === 0 || r.height === 0) continue;
        const el = document.createElement('div');
        el.className = 'citation-overlay';
        el.style.cssText = 'position:fixed;pointer-events:none;z-index:9998;background:rgba(66,133,244,0.2);border-radius:3px';
        el.style.left = r.left + 'px';
        el.style.top = (r.top - 1) + 'px';
        el.style.width = r.width + 'px';
        el.style.height = (r.height + 2) + 'px';
        container.appendChild(el);
        overlays.push(el);
      }
      lastRectCount = count;
    };

    const upOverlays = (t: HTMLElement) => {
      if (overlays.length === 0) return;
      const rects = t.getClientRects();
      const count = rects?.length || 0;
      if (!count) {
        const br = t.getBoundingClientRect();
        if (overlays.length === 1) {
          overlays[0].style.left = br.left + 'px';
          overlays[0].style.top = (br.top - 1) + 'px';
          overlays[0].style.width = br.width + 'px';
          overlays[0].style.height = (br.height + 2) + 'px';
        }
        return;
      }
      if (count !== lastRectCount) { mkOverlays(t); return; }
      for (let i = 0; i < count && i < overlays.length; i++) {
        const r = rects![i];
        const o = overlays[i];
        o.style.left = r.left + 'px';
        o.style.top = (r.top - 1) + 'px';
        o.style.width = r.width + 'px';
        o.style.height = (r.height + 2) + 'px';
      }
    };

    const onMove = (e: MouseEvent) => { mx = e.clientX; my = e.clientY; };
    const onOver = (e: MouseEvent) => {
      const badge = (e.target as HTMLElement).closest('.citation-badge') as HTMLElement | null;
      const group = badge?.closest('.citation-group') as HTMLElement | null;
      const text = group?.querySelector('.citation-text') as HTMLElement | null;
      if (text && text !== activeText) { rmOverlays(); mkOverlays(text); }
    };
    const onOut = (e: MouseEvent) => {
      const badge = (e.target as HTMLElement).closest('.citation-badge') as HTMLElement | null;
      if (!badge) return;
      const related = e.relatedTarget as HTMLElement | null;
      if (!related || !badge.contains(related)) { rmOverlays(); activeText = null; }
    };
    const tick = () => {
      const el = document.elementFromPoint(mx, my);
      const badge = el?.closest('.citation-badge') as HTMLElement | null;
      const group = badge?.closest('.citation-group') as HTMLElement | null;
      const text = group?.querySelector('.citation-text') as HTMLElement | null;
      if (text && text !== activeText) { rmOverlays(); mkOverlays(text); }
      else if (text && overlays.length > 0) { upOverlays(text); }
      else if (!text && overlays.length > 0) { rmOverlays(); activeText = null; }
      requestAnimationFrame(tick);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseover', onOver);
    document.addEventListener('mouseout', onOut);
    requestAnimationFrame(tick);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseover', onOver);
      document.removeEventListener('mouseout', onOut);
      rmOverlays();
    };
  }, []);

  const runSearch = useCallback((q: string, history?: { role: string; content: string }[], mode?: SearchMode, depth?: DeepDepth) => {
    const effectiveMode = mode ?? conversationMode.current;
    const effectiveDepth = depth ?? conversationDepth.current;
    conversationMode.current = effectiveMode;
    conversationDepth.current = effectiveDepth;
    setDefaultMode(effectiveMode);
    if (effectiveMode === 'deep') setDefaultDepth(effectiveDepth);
    if (convId) {
      void updateConversationResearch(convId, effectiveMode, effectiveMode === 'deep' ? effectiveDepth : undefined)
        .then(() => onConversationResearchUpdate?.(convId, effectiveMode, effectiveMode === 'deep' ? effectiveDepth : undefined))
        .catch(() => {});
    }

    const myGen = ++runGenRef.current;
    if (searchingRef.current) searchingRef.current = false;

    const controller = new AbortController();
    abortRef.current = controller;
    searchingRef.current = true;
    setIsSearching(true);
    searchStartRef.current = Date.now();
    const searchStart = Date.now();

    let accumulatedAnswer = '';
    let pendingFinalContext: string | undefined;

    const flushRef = { current: undefined as ReturnType<typeof setTimeout> | undefined };
    const doFlush = () => {
      if (myGen !== runGenRef.current) return;
      setMessages(prev => {
        if (myGen !== runGenRef.current) return prev;
        const updated = [...prev];
        const last = updated[updated.length - 1];
        if (last?.type === 'assistant') {
          updated[updated.length - 1] = { ...last, content: accumulatedAnswer, streaming: true, error: undefined };
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

    search(q, history, effectiveMode, effectiveDepth, controller.signal, convId)
      .then(({ id }) => {
        if (isStale()) return;

        setMessages(prev => {
          if (myGen !== runGenRef.current) return prev;
          const updated = [...prev];
          const last = updated[updated.length - 1];
          if (last?.type === 'assistant') {
            updated[updated.length - 1] = { ...last, jobId: id, jobStatus: 'running', data: { ...(last.data || { query: q, answer: '', sources: [], steps: [], results_count: 0, elapsed_ms: 0 }), research_depth: effectiveMode === 'deep' ? effectiveDepth : undefined } as SearchResponse };
          }
          return updated;
        });

        const unsubscribe = subscribeToJobEvents(id, {
          onToken: (text) => {
            if (isStale()) return;
            accumulatedAnswer += text;
            scheduleFlush();
          },
          onMessageSegment: () => {
            if (isStale()) return;
            clearTimeout(flushRef.current);
            flushRef.current = undefined;
            setMessages(prev => {
              if (myGen !== runGenRef.current) return prev;
              const updated = [...prev];
              const last = updated[updated.length - 1];
              if (last?.type !== 'assistant') return prev;
              updated[updated.length - 1] = { ...last, content: accumulatedAnswer, streaming: false, error: undefined };
              updated.push({ type: 'assistant', content: '', loading: true, streaming: true, data: last.data, searches: last.searches, activeSteps: last.activeSteps });
              return updated;
            });
            accumulatedAnswer = '';
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
                activeSteps = activeSteps.map((s, idx) =>
                  idx === matchIdx
                    ? { ...s, ...step, duration_ms: step.duration_ms || s.duration_ms, result_count: step.result_count || s.result_count }
                    : s
                );
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
                  searches = [...searches, { query: step.query!, status: 'searching' as const, type: step.type as 'search' | 'webpage', model: step.model }];
                }
              }

              updated[updated.length - 1] = { ...last, activeSteps, searches };
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
          onContext: (finalContext) => {
            if (isStale()) return;
            pendingFinalContext = finalContext;
          },
          onStatus: (status: ResearchJobStatus) => {
            if (isStale()) return;
            if (status === 'paused') {
              searchingRef.current = false;
              searchStartRef.current = 0;
              setIsSearching(false);
            }
            setMessages(prev => {
              if (myGen !== runGenRef.current) return prev;
              const updated = [...prev];
              const last = updated[updated.length - 1];
              if (last?.type === 'assistant') {
                updated[updated.length - 1] = {
                  ...last,
                  jobStatus: status,
                  paused: status === 'paused',
                  loading: status !== 'paused' && status !== 'completed' && status !== 'failed' && status !== 'cancelled',
                  streaming: status !== 'paused' && last.streaming,
                };
              }
              return updated;
            });
          },
          onProgress: (state) => {
            if (isStale()) return;
            setMessages(prev => {
              if (myGen !== runGenRef.current) return prev;
              const updated = [...prev];
              const last = updated[updated.length - 1];
              if (last?.type !== 'assistant') return prev;
              updated[updated.length - 1] = {
                ...last,
                data: mergeResearchProgress(last.data, state),
              };
              return updated;
            });
          },
          onDone: (response) => {
            if (isStale()) return;
            clearTimeout(flushRef.current);
            flushRef.current = undefined;

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
                updated[updated.length - 1] = { ...last, searches, type: 'assistant', content: accumulatedAnswer || response.answer, data: { ...response, finalContext: pendingFinalContext || response.finalContext }, loading: false, streaming: false, timerMs: response.elapsed_ms, error: undefined };
              }
              return updated;
            });
            if (myGen === runGenRef.current) {
              searchingRef.current = false;
              searchStartRef.current = 0;
              setIsSearching(false);
            }
          },
          onError: (message, finalContext) => {
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
                const ctx = pendingFinalContext || finalContext;
                updated[updated.length - 1] = { ...last, error: message, loading: false, timerMs: elapsed, data: last.data ? { ...last.data, finalContext: ctx } : ctx ? { query: '', answer: '', sources: [], steps: [], results_count: 0, elapsed_ms: 0, finalContext: ctx } : undefined };
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
  }, [convId, onConversationResearchUpdate]);

  useEffect(() => {
    if (!initialQuery || !loaded || messages.length > 0) return;
    queueMicrotask(() => {
      setMessages([{ type: 'user', content: initialQuery }, { type: 'assistant', content: '', loading: true }]);
      runSearch(initialQuery, undefined, conversationMode.current, conversationDepth.current);
    });
  }, [initialQuery, loaded, messages.length, runSearch]);

  useLayoutEffect(() => {
    if (scrollRef.current && messages.length > 0) {
      const smooth = scrolledRef.current;
      scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: smooth ? 'smooth' : 'instant' });
      scrolledRef.current = true;
    }
  }, [messages]);

  const handlePauseJob = useCallback(async (jobId: string) => {
    await pauseResearchJob(jobId);
  }, []);

  const handleResumeJob = useCallback(async (jobId: string) => {
    const resumed = await resumeResearchJob(jobId);
    if (!resumed) return;
    searchingRef.current = true;
    setIsSearching(true);
    if (searchStartRef.current === 0) searchStartRef.current = Date.now();
    setMessages(prev => {
      const updated = [...prev];
      const last = updated[updated.length - 1];
      if (last?.type === 'assistant') {
        updated[updated.length - 1] = { ...last, loading: true, paused: false, streaming: true, jobStatus: 'running', jobId };
      }
      return updated;
    });
    const myGen = runGenRef.current;
    subscribeToJobEvents(jobId, {
      onStatus: (status) => {
        if (myGen !== runGenRef.current) return;
        if (status === 'paused') {
          searchingRef.current = false;
          searchStartRef.current = 0;
          setIsSearching(false);
        }
        setMessages(prev => {
          const updated = [...prev];
          const last = updated[updated.length - 1];
          if (last?.type === 'assistant') {
            updated[updated.length - 1] = {
              ...last,
              jobStatus: status,
              paused: status === 'paused',
              loading: status !== 'paused' && status !== 'completed' && status !== 'failed' && status !== 'cancelled',
            };
          }
          return updated;
        });
      },
      onProgress: (state) => {
        if (myGen !== runGenRef.current) return;
        setMessages(prev => {
          const updated = [...prev];
          const last = updated[updated.length - 1];
          if (last?.type !== 'assistant') return prev;
          updated[updated.length - 1] = {
            ...last,
            data: mergeResearchProgress(last.data, state),
          };
          return updated;
        });
      },
      onDone: (response) => {
        if (myGen !== runGenRef.current) return;
        setMessages(prev => {
          const updated = [...prev];
          const last = updated[updated.length - 1];
          if (last?.type === 'assistant') {
            updated[updated.length - 1] = { ...last, content: response.answer, data: response, loading: false, streaming: false, timerMs: response.elapsed_ms, paused: false };
          }
          return updated;
        });
        searchingRef.current = false;
        searchStartRef.current = 0;
        setIsSearching(false);
      },
      onError: (message) => {
        if (myGen !== runGenRef.current) return;
        setMessages(prev => {
          const updated = [...prev];
          const last = updated[updated.length - 1];
          if (last?.type === 'assistant') {
            updated[updated.length - 1] = { ...last, error: message, loading: false, paused: false };
          }
          return updated;
        });
        searchingRef.current = false;
        searchStartRef.current = 0;
        setIsSearching(false);
      },
    });
  }, []);

  const handleFollowUp = useCallback((q: string, mode?: SearchMode, depth?: DeepDepth) => {
    if (searchingRef.current) return;
    const resolvedMode = mode ?? conversationMode.current;
    const resolvedDepth = depth ?? conversationDepth.current;
    if (mode) conversationMode.current = mode;
    if (depth) conversationDepth.current = depth;
    const currentMessages = messagesRef.current;
    const history = [...currentMessages]
      .filter(m => m.content && !m.loading)
      .map(m => ({ role: m.type === 'user' ? 'user' as const : 'assistant' as const, content: m.content }));
    setMessages(prev => [...prev, { type: 'user', content: q }, { type: 'assistant', content: '', loading: true }]);
    setTimeout(() => runSearch(q, history, resolvedMode, resolvedDepth), 0);
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
      , conversationMode.current, conversationDepth.current
    );
  }, [runSearch]);

  useEffect(() => {
    const handler = () => retryLast();
    window.addEventListener('athena:regenerate', handler);
    return () => window.removeEventListener('athena:regenerate', handler);
  }, [retryLast]);

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
    runSearch(newText, history, conversationMode.current, conversationDepth.current);
    setEditIndex(-1);
  }, [editText, runSearch]);

  const title = currentConv?.title ?? currentConv?.query ?? '';

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative', isolation: 'isolate' }}>
      {!isMobile && title && (
        <span data-ctx="title" style={{
          position: 'absolute', top: 14, right: 'var(--chat-pad-x, 28px)',
          fontSize: 13, fontWeight: 400, color: 'var(--athena-text-3)',
          whiteSpace: 'nowrap', opacity: 0.7,
        }}>
          {title}
        </span>
      )}

      {isMobile && (
        <div style={{
          display: 'flex', alignItems: 'center', height: 48, flexShrink: 0,
          padding: '0 var(--chat-pad-x, 28px)',
          borderBottom: '0.5px solid var(--athena-border)',
          background: 'var(--athena-bg)',
          position: 'relative', zIndex: 10,
        }}>
          <button
            onClick={onOpenSidebar}
            title="Open sidebar"
            style={{
              width: 32, height: 32, borderRadius: 8, border: 'none',
              background: 'none', cursor: 'pointer', padding: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: 'var(--athena-text-2)',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--athena-border)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}
          >
            <Menu size={18} />
          </button>
          <span style={{
            flex: 1, textAlign: 'center',
            fontSize: 12.5, fontWeight: 500, color: 'var(--athena-text-2)',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            padding: '0 8px',
          }}>
            {title}
          </span>
          <div style={{ width: 32 }} />
        </div>
      )}

      <div ref={scrollRef} style={{
        flex: 1, overflow: 'hidden auto', padding: `14px 0 0`,
        width: '100%',
      }}>
        <div style={{ maxWidth: 720, margin: '0 auto', padding: '0 var(--chat-pad-x, 28px)' }}>
        {messages.map((msg, i) => {
          const displayMs = msg.loading ? liveMs : (msg.timerMs ?? liveMs);
          return (
            <div key={i} data-msg-index={i} data-msg-type={msg.type} className="message-block" style={{ marginBottom: 20 }} ref={el => {
              if (el && !el.dataset.animDone) {
                el.dataset.animDone = 'true';
                el.style.animation = 'fade-in-up 0.3s var(--ease-out) both';
                el.addEventListener('animationend', () => { el.style.animation = ''; }, { once: true });
              }
            }}>
              {msg.type !== 'user' && msg.searches && msg.searches.length > 0 && (
                <MessageSearches searches={msg.searches} />
              )}
              {msg.type === 'user' ? (
                <MessageUser
                  msg={msg} i={i} editIndex={editIndex}
                  editRef={editRef}
                  onEditStart={() => { setEditIndex(i); setEditText(msg.content); }}
                  onEditSave={() => handleEditSave(i)}
                  onEditCancel={() => setEditIndex(-1)}
                  onEditInput={(text) => setEditText(text)}
                  onEditKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleEditSave(i); }
                    if (e.key === 'Escape') setEditIndex(-1);
                  }}
                />
              ) : msg.loading ? (
                <MessageLoading
                  msg={msg} i={i} messages={messages}
                  displayMs={displayMs}
                  onDiagramClick={setDiagramSvg}
                  onOpenModal={() => { setModalMsgIdx(i); setModalOpen(true); }}
                  showJobControls={(msg.data?.research_depth === 'high' || msg.data?.research_depth === 'ultra') && !!msg.jobId}
                  onPause={msg.jobId ? () => { void handlePauseJob(msg.jobId!); } : undefined}
                  onResume={msg.jobId ? () => { void handleResumeJob(msg.jobId!); } : undefined}
                />
              ) : msg.error ? (
                <MessageError msg={msg} onRetry={retryLast} />
              ) : (
                <MessageComplete
                  msg={msg} i={i} messages={messages}
                  displayMs={displayMs}
                  copiedIndex={copiedIndex}
                  onDiagramClick={setDiagramSvg}
                  onCopy={() => {
                    copyToClipboard(msg.content);
                    setCopiedIndex(i);
                    setTimeout(() => setCopiedIndex(-1), 1200);
                  }}
                  onOpenModal={() => { setModalMsgIdx(i); setModalOpen(true); }}
                  onRetry={retryLast}
                />
              )}
            </div>
          );
        })}
      </div>
      </div>

      <div style={{ flexShrink: 0, padding: `12px var(--chat-pad-x, 28px) 20px`, maxWidth: 720, margin: '0 auto', width: '100%' }}>
        <SearchInput
          key={`${convId}-${research.mode}-${research.depth}`}
          onSubmit={handleFollowUp}
          compact
          dropdownUp
autoFocus
          initialMode={research.mode}
          initialDepth={research.depth}
          disabled={isSearching}
        />
      </div>

      {!isMobile && (panelSources.length > 0 || panelClosing) && <div style={{
        position: 'fixed', zIndex: 999, pointerEvents: panelClosing ? 'none' : 'auto',
        top: '50%', right: 16, width: 260,
      }}>
        <div style={{
          transform: panelClosing ? 'translateY(-50%) scale(0.95)' : 'translateY(-50%) scale(1)',
          opacity: panelClosing ? 0 : 1,
          transition: 'opacity 200ms ease, transform 200ms ease',
        }}>
          <SourcesPanel sources={panelSources} />
        </div>
      </div>}

      {isMobile && panelSources.length > 0 && (
        <button
          onClick={() => setMobileSourcesOpen(true)}
          style={{
            position: 'fixed', bottom: 80, right: 12, zIndex: 999,
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '6px 10px 6px 8px',
            background: 'var(--athena-bg)',
            border: '0.5px solid var(--athena-border)',
            borderRadius: 10,
            cursor: 'pointer',
            fontFamily: 'inherit',
            fontSize: 10.5,
            fontWeight: 500,
            color: 'var(--athena-text-2)',
            boxShadow: '0 2px 12px rgba(0,0,0,0.08)',
            transition: 'transform 120ms var(--ease-out)',
          }}
          onMouseDown={(e) => { (e.currentTarget as HTMLElement).style.transform = 'scale(0.95)'; }}
          onMouseUp={(e) => { (e.currentTarget as HTMLElement).style.transform = 'scale(1)'; }}
        >
          <div style={{ display: 'flex', alignItems: 'center' }}>
            {panelSources.slice(0, 3).map((s, i) => (
              <img key={i}
                src={`https://www.google.com/s2/favicons?domain=${s.domain}&sz=16`}
                width={14} height={14} loading="lazy"
                onError={(e) => { (e.target as HTMLImageElement).src = FALLBACK_FAVICON; }}
                style={{ borderRadius: 2, marginLeft: i === 0 ? 0 : -3, position: 'relative', zIndex: 3 - i }} />
            ))}
          </div>
          <span>{panelSources.length}</span>
        </button>
      )}

      {isMobile && (mobileSourcesOpen || mobileSourcesClosing) && panelSources.length > 0 && (
        <>
          <div
            onClick={() => { if (!mobileSourcesClosing) { setMobileSourcesClosing(true); setTimeout(() => { setMobileSourcesClosing(false); setMobileSourcesOpen(false); }, 200); } }}
            style={{
              position: 'fixed', inset: 0, zIndex: 998,
              background: 'rgba(0,0,0,0.3)',
              animation: mobileSourcesClosing ? 'fade-in 150ms ease reverse both' : 'fade-in 150ms ease both',
              pointerEvents: mobileSourcesClosing ? 'none' : 'auto',
            }}
          />
          <div
            style={{
              position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 999,
              maxHeight: '50vh', borderRadius: '16px 16px 0 0',
              background: 'var(--athena-bg)',
              border: '0.5px solid var(--athena-border)',
              borderBottom: 'none',
              overflow: 'hidden',
              display: 'flex',
              flexDirection: 'column',
              boxShadow: '0 -4px 24px rgba(0,0,0,0.08)',
              animation: mobileSourcesClosing ? 'fade-in-up 200ms var(--ease-out) reverse both' : 'fade-in-up 200ms var(--ease-out) both',
            }}
          >
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '12px 16px 8px', flexShrink: 0,
            }}>
              <div style={{ width: 24 }} />
              <div style={{
                width: 32, height: 3, borderRadius: 2,
                background: 'var(--athena-text-3)', opacity: 0.4, flexShrink: 0,
              }} />
              <button
                onClick={() => { if (!mobileSourcesClosing) { setMobileSourcesClosing(true); setTimeout(() => { setMobileSourcesClosing(false); setMobileSourcesOpen(false); }, 200); } }}
                style={{
                  width: 24, height: 24, borderRadius: 6, border: 'none',
                  background: 'none', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  color: 'var(--athena-text-3)', padding: 0,
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>
            <div style={{ flex: 1, minHeight: 0, padding: '0 4px 8px', display: 'flex', flexDirection: 'column' }}>
              <SourcesPanel sources={panelSources} maxHeight="100%" />
            </div>
          </div>
        </>
      )}

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
            finalContext={modalMsg.data?.finalContext}
            showDebugContext={debugContextEnabled}
            researchMeta={modalMsg.data ? {
              depth: modalMsg.data.research_depth,
              budget: modalMsg.data.research_budget ? {
                used: modalMsg.data.research_budget.used,
                limit: modalMsg.data.research_budget.limit,
                remaining: modalMsg.data.research_budget.limit - modalMsg.data.research_budget.used,
              } : undefined,
              notebook: modalMsg.data.research_notebook ? {
                id: modalMsg.data.research_notebook.id,
                updates: modalMsg.data.research_notebook.updates,
                updatedAt: modalMsg.data.research_notebook.updatedAt,
              } : undefined,
            } : undefined}
          />
        ) : null;
      })()}

      {citationTooltip.visible && (
        <CitationTooltip
          items={citationTooltip.items}
          pos={citationTooltipPos}
          tooltipRef={tooltipRef}
        />
      )}
      {diagramSvg && createPortal(<DiagramOverlay svg={diagramSvg} onClose={() => setDiagramSvg(null)} />, document.body)}
    </div>
  );
}

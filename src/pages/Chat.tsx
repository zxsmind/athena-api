import { useState, useEffect, useRef, useCallback, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { useParams, useLocation } from 'react-router-dom';
import { MoreHorizontal } from 'lucide-react';
import SearchInput from '../components/SearchInput';
import { getDefaultMode } from '../hooks/useDefaultMode';
import ActivityModal from '../components/ActivityModal';
import DiagramOverlay from '../components/DiagramOverlay';
import CitationTooltip from '../components/CitationTooltip';
import SourcesPanel from '../components/chat/SourcesPanel';
import { MessageUser, MessageLoading, MessageError, MessageComplete, MessageSearches } from '../components/chat/MessageComponents';
import { search, subscribeToJobEvents, fetchMessages, saveMessages, type Message, type Source } from '../lib/api';
import {
  STEP_LABELS, formatTime, normalizeSearchQuery, getSourcesForMessage,
  computeCitationTooltipPosition, estimateCitationTooltipSize,
  CITATION_TOOLTIP_MAX_HEIGHT, ABORT_TIMEOUT_MS,
  type CitationTooltipItem, type CitationTooltipPosition,
} from '../lib/chat-utils';

interface ChatProps {
  chatMessages: Record<string, Message[]>;
  onUpdateMessages: React.Dispatch<React.SetStateAction<Record<string, Message[]>>>;
  conversations: { id: string; title: string | null; query: string; timestamp: Date }[];
}

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
      setPanelSources(srcs);
      setPanelOpacity(1);
    } else {
      setPanelOpacity(0);
      panelFadeTimer.current = setTimeout(() => setPanelSources([]), 200);
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
      setMessages(existing);
      setLoaded(true);
    } else {
      fetchMessages(convId).then(msgs => {
        if (msgs.length > 0) {
          setMessages(msgs);
          onUpdateMessages(prev => ({ ...prev, [convId]: msgs }));
        }
        setLoaded(true);
      }).catch(() => setLoaded(true));
    }
  }, [convId]);

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
          onDone: (response) => {
            if (isStale()) return;
            clearTimeout(flushRef.current);
            flushRef.current = undefined;
            accumulatedAnswer = response.answer;
            doFlush();

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
                updated[updated.length - 1] = { ...last, searches, type: 'assistant', content: response.answer, data: response, loading: false, streaming: false, timerMs: response.elapsed_ms };
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
    setTimeout(() => runSearch(q, history, conversationMode.current), 0);
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
    runSearch(newText, history);
    setEditIndex(-1);
  }, [editText, runSearch]);

  const currentConv = conversations.find(c => c.id === convId);
  const title = currentConv?.title ?? currentConv?.query ?? '';

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative', isolation: 'isolate' }}>
      {title && (
        <span data-ctx="title" style={{
          position: 'absolute', top: 14, right: 28,
          fontSize: 13, fontWeight: 400, color: 'var(--athena-text-3)',
          whiteSpace: 'nowrap', opacity: 0.7,
        }}>
          {title}
        </span>
      )}

      <div ref={scrollRef} style={{
        flex: 1, overflow: 'hidden auto', padding: '14px 28px 0',
        maxWidth: 720, margin: '0 auto', width: '100%',
      }}>
        {messages.map((msg, i) => {
          const displayMs = msg.loading ? liveMs : (msg.timerMs ?? liveMs);
          return (
            <div key={i} data-msg-index={i} data-msg-type={msg.type} className="message-block" style={{ marginBottom: 20, animation: 'fade-in-up 0.3s var(--ease-out) both' }}>
              {msg.type !== 'user' && msg.searches && msg.searches.length > 0 && (
                <MessageSearches searches={msg.searches} />
              )}
              {msg.type === 'user' ? (
                <MessageUser
                  msg={msg} i={i} editIndex={editIndex} editText={editText}
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
                  liveMs={liveMs} displayMs={displayMs}
                  onDiagramClick={setDiagramSvg}
                  onOpenModal={() => setModalOpen(true)}
                  onRetry={retryLast}
                />
              ) : msg.error ? (
                <MessageError msg={msg} onRetry={retryLast} />
              ) : (
                <MessageComplete
                  msg={msg} i={i} messages={messages}
                  liveMs={liveMs} displayMs={displayMs}
                  copiedIndex={copiedIndex}
                  onDiagramClick={setDiagramSvg}
                  onCopy={() => {
                    navigator.clipboard.writeText(msg.content);
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

      <div style={{ flexShrink: 0, padding: '12px 28px 20px', maxWidth: 720, margin: '0 auto', width: '100%' }}>
        <SearchInput
          onSubmit={handleFollowUp}
          compact
          dropdownUp
          autoFocus
          initialMode={conversationMode.current}
          disabled={isSearching}
        />
      </div>

      <div style={{
        position: 'fixed', top: '50%', right: 16,
        transform: 'translateY(-50%)', width: 260,
        display: 'flex', flexDirection: 'column', zIndex: 999,
        transition: 'opacity 200ms ease', opacity: panelOpacity,
      }}>
        {panelSources.length > 0 && <SourcesPanel sources={panelSources} />}
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

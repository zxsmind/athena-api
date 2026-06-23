import { useState, useRef, useCallback, useEffect } from 'react';
import { Search, ArrowUp, X } from 'lucide-react';
import ModeDropdown from './ModeDropdown';
import type { ResearchModeValue } from './ModeDropdown';
import type { DeepDepth, SearchMode } from '../lib/api';
import { BASE } from '../lib/api';

interface SearchInputProps {
  onSubmit: (query: string, mode?: SearchMode, depth?: DeepDepth) => void;
  initialValue?: string;
  initialMode?: SearchMode;
  initialDepth?: DeepDepth;
  compact?: boolean;
  autoFocus?: boolean;
  dropdownUp?: boolean;
  disabled?: boolean;
  placeholder?: string;
}

const cache = new Map<string, string[]>();

const MAX_AUTOCOMPLETE_LENGTH = 120;

function useAutocomplete(query: string) {
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2 || q.length > MAX_AUTOCOMPLETE_LENGTH) {
      setSuggestions([]);
      return;
    }

    const cached = cache.get(q);
    if (cached) {
      setSuggestions(cached);
      return;
    }

    const timer = setTimeout(async () => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const res = await fetch(`${BASE}/autocomplete?q=${encodeURIComponent(q)}`, { signal: controller.signal });
        if (!res.ok) throw new Error('fetch failed');
        const data = await res.json() as { suggestions: string[] };
        const items = data.suggestions ?? [];
        cache.set(q, items);
        if (cache.size > 100) {
          const firstKey = cache.keys().next().value;
          if (firstKey) cache.delete(firstKey);
        }
        setSuggestions(items);
      } catch {
        // keep previous
      }
    }, 30);

    return () => {
      clearTimeout(timer);
      abortRef.current?.abort();
    };
  }, [query]);

  return suggestions;
}

function SuggestionsList({ suggestions, displayIdx, query, onSelect }: {
  suggestions: string[]; displayIdx: number; query: string; onSelect: (s: string) => void;
}) {
  return (
    <>
      {suggestions.map((s, i) => (
        <button
          key={i}
          onMouseDown={(e) => { e.preventDefault(); onSelect(s); }}
          style={{
            width: '100%', display: 'flex', alignItems: 'center', gap: 8,
            padding: '8px 18px',
            background: i === displayIdx ? 'rgba(var(--athena-accent-rgb), 0.04)' : 'none',
            border: 'none', cursor: 'pointer', textAlign: 'left',
            fontSize: 12.5, color: 'var(--athena-text-2)',
            fontFamily: 'inherit', position: 'relative', zIndex: 3,
          }}
          onMouseEnter={(e) => {
            if (i !== displayIdx) {
              (e.currentTarget as HTMLElement).style.background = 'rgba(var(--athena-accent-rgb), 0.03)';
              (e.currentTarget as HTMLElement).style.color = 'var(--athena-text)';
            }
          }}
          onMouseLeave={(e) => {
            if (i !== displayIdx) {
              (e.currentTarget as HTMLElement).style.background = 'none';
              (e.currentTarget as HTMLElement).style.color = 'var(--athena-text-2)';
            }
          }}
        >
          <Search size={11} style={{ color: 'var(--athena-text-3)', flexShrink: 0 }} strokeWidth={2} />
          <HighlightMatch text={s} query={query} />
        </button>
      ))}
    </>
  );
}

export default function SearchInput({
  onSubmit,
  initialValue = '',
  initialMode = 'quick',
  initialDepth = 'med',
  compact = false,
  autoFocus = false,
  dropdownUp = false,
  disabled = false,
  placeholder: inputPlaceholder,
}: SearchInputProps) {
  const [value, setValue] = useState(initialValue);
  const [focused, setFocused] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  const [modeValue, setModeValue] = useState<ResearchModeValue>(initialMode === 'deep' ? `deep-${initialDepth}` : 'instant');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const inputWrapRef = useRef<HTMLDivElement>(null);
  const suggestions = useAutocomplete(value);
  const LINE_HEIGHT = 22;

  useEffect(() => {
    if (autoFocus && inputRef.current) {
      const timer = setTimeout(() => inputRef.current?.focus(), 100);
      return () => clearTimeout(timer);
    }
  }, [autoFocus]);

  const autoResize = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = Math.min(el.scrollHeight, LINE_HEIGHT * 5) + 'px';
  }, []);

  useEffect(() => { autoResize(); }, [value, autoResize]);

  const safeIdx = (() => {
    if (suggestions.length === 0) return -1;
    if (activeIdx === -1 || activeIdx >= suggestions.length) return 0;
    return activeIdx;
  })();

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setValue(e.target.value);
    setActiveIdx(-1);
  }, []);

  const handleSubmit = useCallback(
    (q?: string) => {
      if (disabled) return;
      const query = (q ?? value).trim();
      if (!query) return;
      const depth = modeValue.startsWith('deep-') ? modeValue.slice(5) as DeepDepth : undefined;
      onSubmit(query, depth ? 'deep' : 'quick', depth);
      setValue('');
      setActiveIdx(-1);
      setFocused(false);
      inputRef.current?.blur();
    },
    [value, modeValue, onSubmit, disabled]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIdx((i) => Math.min(i + 1, suggestions.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIdx((i) => Math.max(i - 1, -1));
      } else if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (activeIdx >= 0 && suggestions[activeIdx]) {
          handleSubmit(suggestions[activeIdx]);
        } else {
          handleSubmit();
        }
      } else if (e.key === 'Escape') {
        setActiveIdx(-1);
        inputRef.current?.blur();
      }
    },
    [suggestions, activeIdx, handleSubmit]
  );

  const showSuggestions = focused && value.trim().length >= 2 && suggestions.length > 0;
  const displayIdx = safeIdx >= 0 ? safeIdx : 0;

  const showLongRunWarning = modeValue === 'deep-high' || modeValue === 'deep-ultra';

  return (
    <div style={{ position: 'relative', width: '100%' }}>
      {showSuggestions && (
        <div className="glass-input" style={{
          position: 'absolute',
          [dropdownUp ? 'bottom' : 'top']: '100%',
          left: 0, right: 0,
          borderRadius: dropdownUp ? '16px 16px 0 0' : '0 0 16px 16px',
          borderBottomColor: dropdownUp ? 'transparent' : undefined,
          borderTopColor: dropdownUp ? undefined : 'transparent',
          overflow: 'hidden', zIndex: 50,
          [dropdownUp ? 'paddingTop' : 'paddingBottom']: 4,
          [dropdownUp ? 'marginBottom' : 'marginTop']: 2,
          animation: 'scale-in 120ms var(--ease-out) both',
        }}>
          <SuggestionsList suggestions={suggestions} displayIdx={displayIdx} query={value} onSelect={handleSubmit} />
        </div>
      )}

      <div className="glass-input" style={{
        display: 'flex', alignItems: 'center', gap: compact ? 8 : 10,
        padding: compact ? '8px 14px' : '13px 18px',
        borderRadius: showSuggestions ? (dropdownUp ? '0 0 16px 16px' : '16px 16px 0 0') : 16,
        borderTopColor: showSuggestions && dropdownUp ? 'transparent' : undefined,
        borderBottomColor: showSuggestions && !dropdownUp ? 'transparent' : undefined,
        transition: 'box-shadow var(--duration-normal) var(--ease-out), border-radius var(--duration-fast)',
      }}>
        <Search size={compact ? 15 : 17} style={{ color: 'var(--athena-text-3)', flexShrink: 0 }} strokeWidth={2} />

        <div ref={inputWrapRef} style={{ position: 'relative', flex: 1, display: 'flex', alignItems: 'flex-end' }}>
          <textarea ref={inputRef} value={value} onChange={handleChange}
            onFocus={() => setFocused(true)}
            onBlur={() => setTimeout(() => { setFocused(false); setActiveIdx(-1); }, 150)}
            onKeyDown={handleKeyDown}
            placeholder={inputPlaceholder || "Ask anything..."}
            rows={1}
            autoComplete="off" spellCheck={false}
            style={{
              flex: 1, background: 'transparent', border: 'none', outline: 'none', resize: 'none',
              fontSize: compact ? 14 : 15.5,
              color: 'var(--athena-text)',
              caretColor: 'var(--athena-text-2)', fontFamily: 'inherit',
              position: 'relative', zIndex: 2, lineHeight: `${LINE_HEIGHT}px`,
              overflow: 'hidden',
            }} />
        </div>

        {value && (
          <button onClick={() => { setValue(''); setActiveIdx(-1); inputRef.current?.focus(); }}
            style={{
              background: 'none', border: 'none', cursor: 'pointer', padding: 2,
              borderRadius: 6, color: 'var(--athena-text-3)', display: 'flex',
              flexShrink: 0, position: 'relative', zIndex: 3,
              transition: 'color var(--duration-fast)',
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--athena-text-2)'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--athena-text-3)'; }}
          >
            <X size={13} />
          </button>
        )}

        <ModeDropdown value={modeValue} onChange={setModeValue} />

        <button onClick={() => handleSubmit()} disabled={!value.trim() || disabled}
          style={{
            width: compact ? 30 : 34, height: compact ? 30 : 34, borderRadius: compact ? 8 : 10, border: 'none',
            cursor: (!value.trim() || disabled) ? 'default' : 'pointer',
            background: (!value.trim() || disabled) ? 'var(--athena-text-3)' : 'var(--athena-text)',
            color: 'var(--athena-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexShrink: 0, position: 'relative', zIndex: 3,
            transition: 'background var(--duration-fast) var(--ease-out), transform var(--duration-fast) var(--ease-spring), opacity var(--duration-fast)',
            opacity: (!value.trim() || disabled) ? 0.35 : 1,
          }}
          onMouseDown={(e) => { if (value.trim() && !disabled) (e.currentTarget as HTMLElement).style.transform = 'scale(0.90)'; }}
          onMouseUp={(e) => { (e.currentTarget as HTMLElement).style.transform = 'scale(1)'; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.transform = 'scale(1)'; }}
        >
          <ArrowUp size={compact ? 13 : 14} strokeWidth={2.5} />
        </button>
      </div>
      {showLongRunWarning && (
        <div style={{
          marginTop: 8, padding: '8px 12px', borderRadius: 10,
          border: '0.5px solid rgba(var(--athena-accent-rgb), 0.2)',
          background: 'rgba(var(--athena-accent-rgb), 0.04)',
          fontSize: 10.5, lineHeight: 1.45, color: 'var(--athena-text-2)',
        }}>
          {modeValue === 'deep-ultra'
            ? 'Ultra research may run for hours with heavy API usage. The job runs in the background, is cancelable, and builds a durable research notebook.'
            : 'High research may run 30 minutes to 1 hour with elevated API usage. Cancel anytime; results use notebook-backed verification.'}
        </div>
      )}
    </div>
  );
}

function HighlightMatch({ text, query }: { text: string; query: string }) {
  const q = query.trim().toLowerCase();
  if (!q) return <span>{text}</span>;
  const idx = text.toLowerCase().indexOf(q);
  if (idx < 0) return <span>{text}</span>;
  return (
    <span>
      {text.slice(0, idx)}
      <strong style={{ color: 'var(--athena-text)', fontWeight: 600 }}>
        {text.slice(idx, idx + q.length)}
      </strong>
      {text.slice(idx + q.length)}
    </span>
  );
}

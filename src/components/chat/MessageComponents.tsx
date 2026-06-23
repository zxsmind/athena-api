import { useState, useMemo } from 'react';
import { MoreHorizontal, Loader2, RefreshCw, Pencil, Check, Copy } from 'lucide-react';
import { STEP_LABELS, formatTime, getSourcesForMessage, FALLBACK_FAVICON } from '../../lib/chat-utils';
import { renderMarkdown } from '../markdown';
import SearchItem from '../SearchItem';
import type { Source, Message } from '../../lib/api';

const COLLAPSE_THRESHOLD = 2048;

function CollapsibleText({ text, render }: { text: string; render: (t: string) => React.ReactNode }) {
  const byteLen = useMemo(() => new TextEncoder().encode(text).length, [text]);
  const [expanded, setExpanded] = useState(byteLen <= COLLAPSE_THRESHOLD);

  if (byteLen <= COLLAPSE_THRESHOLD) return <>{render(text)}</>;

  const truncated = text.slice(0, Math.floor(COLLAPSE_THRESHOLD * 0.4));

  if (expanded) {
    return (
      <div>
        {render(text)}
        <span onClick={() => setExpanded(false)}
          style={{
            display: 'inline', fontSize: 11.5, color: 'var(--athena-text-3)', fontWeight: 500,
            cursor: 'pointer', letterSpacing: '0.01em',
          }}
          onMouseEnter={e => (e.currentTarget as HTMLElement).style.color = 'var(--athena-text)'}
          onMouseLeave={e => (e.currentTarget as HTMLElement).style.color = 'var(--athena-text-3)'}
        >
          Show less
        </span>
      </div>
    );
  }

  return (
    <div>
      <div style={{
        WebkitMaskImage: 'linear-gradient(to bottom, black 72%, transparent 100%)',
        maskImage: 'linear-gradient(to bottom, black 72%, transparent 100%)',
      }}>
        {render(truncated)}
      </div>
      <span onClick={() => setExpanded(true)}
        style={{
          display: 'inline', fontSize: 11.5, color: 'var(--athena-text-3)', fontWeight: 500,
          cursor: 'pointer', letterSpacing: '0.01em',
        }}
        onMouseEnter={e => (e.currentTarget as HTMLElement).style.color = 'var(--athena-text)'}
        onMouseLeave={e => (e.currentTarget as HTMLElement).style.color = 'var(--athena-text-3)'}
      >
        Show more — {(byteLen / 1024).toFixed(1)}KB
      </span>
    </div>
  );
}

function SourcesBadge({ sources }: { sources: Source[] }) {
  return (
    <div style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      padding: '1px 6px 1px 4px', borderRadius: 6,
      background: 'rgba(var(--athena-accent-rgb), 0.04)',
      border: '0.5px solid rgba(var(--athena-accent-rgb), 0.08)',
      cursor: 'default', fontSize: 9.5,
      color: 'var(--athena-text-3)', fontWeight: 500,
    }}>
      <div style={{ display: 'flex', alignItems: 'center' }}>
        {sources.slice(0, 4).map((src, i) => (
          <img key={i}
            src={`https://www.google.com/s2/favicons?domain=${src.domain}&sz=16`}
            width={12} height={12} loading="lazy"
            onError={(e) => { (e.target as HTMLImageElement).src = FALLBACK_FAVICON; }}
            style={{
              borderRadius: 2, marginLeft: i === 0 ? 0 : -4,
              position: 'relative', zIndex: 4 - i,
              border: '0.5px solid var(--athena-bg)',
            }} />
        ))}
        {sources.length > 4 && (
          <span style={{ marginLeft: 0, fontSize: 8, fontWeight: 600, color: 'var(--athena-text-3)' }}>
            +{sources.length - 4}
          </span>
        )}
      </div>
      Sources
    </div>
  );
}

function StepIndicator({ step }: { step: NonNullable<Message['activeSteps']>[number] }) {
  const label = step.type === 'synthesize' ? 'Synthesizing' : (STEP_LABELS[step.type] || 'Thinking');
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10.5, color: 'var(--athena-text-3)', marginBottom: 6, padding: '0 4px' }}>
      <Loader2 size={10} style={{ flexShrink: 0, animation: 'spin 1s linear infinite' }} />
      <span style={{ opacity: 0.8, textTransform: 'uppercase', fontSize: 9, fontWeight: 600, letterSpacing: '0.05em' }}>
        {label}
      </span>
      {step.model && (
        <span style={{
          fontSize: 8.5, color: 'var(--athena-accent)',
          background: 'rgba(var(--athena-accent-rgb), 0.06)',
          padding: '1px 5px', borderRadius: 3, fontWeight: 500,
        }}>
          {step.model}
        </span>
      )}
    </div>
  );
}

function ActionButton({ onClick, children, title }: { onClick: () => void; children: React.ReactNode; title?: string }) {
  return (
    <button onClick={onClick} title={title} style={{
      background: 'none', border: 'none', cursor: 'pointer',
      padding: 1, color: 'var(--athena-text-3)', display: 'flex',
      transition: 'color var(--duration-fast)',
    }}
      onMouseEnter={e => (e.currentTarget as HTMLElement).style.color = 'var(--athena-text-2)'}
      onMouseLeave={e => (e.currentTarget as HTMLElement).style.color = 'var(--athena-text-3)'}
    >
      {children}
    </button>
  );
}

export function MessageUser({
  msg, i, editIndex, editRef, onEditStart, onEditSave, onEditCancel, onEditInput, onEditKeyDown,
}: {
  msg: Message; i: number; editIndex: number;
  editRef: React.RefObject<HTMLParagraphElement | null>;
  onEditStart: () => void; onEditSave: () => void; onEditCancel: () => void;
  onEditInput: (text: string) => void; onEditKeyDown: (e: React.KeyboardEvent) => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }} className="message-user">
      <div className="glass-panel" style={{
        padding: '10px 16px', borderRadius: 18, maxWidth: '70%',
        background: 'rgba(var(--athena-accent-rgb), 0.08)',
      }}>
        {editIndex === i ? (
          <p data-msg-content="true" ref={editRef}
            contentEditable
            suppressContentEditableWarning
            onInput={e => onEditInput((e.target as HTMLElement).innerText)}
            onKeyDown={e => onEditKeyDown(e)}
            style={{
              margin: -2, fontSize: 14, color: 'var(--athena-text)', lineHeight: 1.4,
              outline: '0.5px solid rgba(var(--athena-accent-rgb), 0.3)',
              borderRadius: 4, padding: '2px 4px',
              caretColor: 'var(--athena-accent)',
              whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            }}
          >
            {msg.content}
          </p>
        ) : (
          <CollapsibleText text={msg.content} render={t => (
            <p data-msg-content="true" style={{
              margin: 0, fontSize: 14, color: 'var(--athena-text)', lineHeight: 1.4,
              whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            }}>
              {t}
            </p>
          )} />
        )}
      </div>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6, marginTop: 4,
        opacity: editIndex === i ? 1 : 0, transition: 'opacity 0.15s',
      }} className={editIndex !== i ? 'user-edit-actions' : ''}>
        {editIndex === i ? (
          <>
            <button onClick={onEditCancel} style={{
              background: 'none', border: '0.5px solid var(--athena-border)',
              borderRadius: 5, padding: '2px 8px', fontSize: 9.5,
              cursor: 'pointer', color: 'var(--athena-text-3)', fontFamily: 'inherit',
            }}>Cancel</button>
            <button onClick={onEditSave} style={{
              background: 'rgba(var(--athena-accent-rgb), 0.12)',
              border: '0.5px solid rgba(var(--athena-accent-rgb), 0.2)',
              borderRadius: 5, padding: '2px 8px', fontSize: 9.5,
              cursor: 'pointer', color: 'var(--athena-accent)', fontFamily: 'inherit',
            }}>Save & Regenerate</button>
          </>
        ) : (
          <button onClick={onEditStart} style={{
            background: 'none', border: 'none', cursor: 'pointer',
            padding: 1, color: 'var(--athena-text-3)', display: 'flex',
          }}>
            <Pencil size={10} />
          </button>
        )}
      </div>
    </div>
  );
}

export function MessageLoading({
  msg, i, messages, displayMs, onDiagramClick, onOpenModal, showJobControls, onPause, onResume,
}: {
  msg: Message; i: number; messages: Message[];
  displayMs: number; onDiagramClick: (svg: string) => void;
  onOpenModal: () => void;
  showJobControls?: boolean;
  onPause?: () => void;
  onResume?: () => void;
}) {
  return (
    <>
      {msg.streaming && msg.content && (
        <div className="athena-prose" data-msg-content="true" style={{ opacity: 0.8 }}>
          {renderMarkdown(msg.content, getSourcesForMessage(msg, i, messages), onDiagramClick)}
        </div>
      )}
      {msg.activeSteps && msg.activeSteps.length > 0 && (
        <StepIndicator step={msg.activeSteps[msg.activeSteps.length - 1]} />
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 10.5, color: 'var(--athena-text-3)', fontVariantNumeric: 'tabular-nums' }}>
          {msg.paused ? 'Paused' : formatTime(displayMs)}
        </span>
        {msg.paused && onResume && (
          <button type="button" onClick={onResume} style={{ fontSize: 10, padding: '3px 8px', borderRadius: 6, border: '0.5px solid var(--athena-border)', background: 'var(--glass-bg)', color: 'var(--athena-text-2)', cursor: 'pointer' }}>
            Resume
          </button>
        )}
        {!msg.paused && showJobControls && onPause && (
          <button type="button" onClick={onPause} style={{ fontSize: 10, padding: '3px 8px', borderRadius: 6, border: '0.5px solid var(--athena-border)', background: 'var(--glass-bg)', color: 'var(--athena-text-2)', cursor: 'pointer' }}>
            Pause
          </button>
        )}
        <ActionButton onClick={onOpenModal}><MoreHorizontal size={11} /></ActionButton>
      </div>
    </>
  );
}

export function MessageError({ msg, onRetry }: { msg: Message; onRetry: () => void }) {
  return (
    <div>
      <p style={{ fontSize: 13, color: 'var(--athena-text-2)', margin: '0 0 12px' }}>{msg.error}</p>
      <button
        onClick={onRetry}
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
  );
}

export function MessageComplete({
  msg, i, messages, displayMs, copiedIndex, onDiagramClick, onCopy, onOpenModal, onRetry,
}: {
  msg: Message; i: number; messages: Message[];
  displayMs: number; copiedIndex: number; onDiagramClick: (svg: string) => void;
  onCopy: () => void; onOpenModal: () => void; onRetry: () => void;
}) {
  return (
    <>
      <div className="athena-prose" data-msg-content="true">
        {renderMarkdown(msg.content, getSourcesForMessage(msg, i, messages), onDiagramClick)}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4, opacity: 0, transition: 'opacity 0.15s' }}
        className="footer-actions">
        {msg.data && msg.data.sources.length > 0 && (
          <SourcesBadge sources={msg.data.sources} />
        )}
        <ActionButton onClick={onCopy}>
          {copiedIndex === i ? <Check size={11} /> : <Copy size={11} />}
        </ActionButton>
        <ActionButton onClick={onOpenModal}><MoreHorizontal size={11} /></ActionButton>
        <span style={{ fontSize: 9.5, color: 'var(--athena-text-3)', fontVariantNumeric: 'tabular-nums' }}>
          {formatTime(displayMs)}
        </span>
        <ActionButton onClick={onRetry}><RefreshCw size={10} /></ActionButton>
      </div>
    </>
  );
}

export function MessageSearches({ searches }: { searches: NonNullable<Message['searches']> }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginBottom: 8, padding: '0 4px' }}>
      {searches.map((s, si) => (
        <SearchItem key={si} search={s} index={si} />
      ))}
    </div>
  );
}

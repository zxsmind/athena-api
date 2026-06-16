import { MoreHorizontal, Loader2, RefreshCw, Pencil, Check, Copy } from 'lucide-react';
import { STEP_LABELS, formatTime, getSourcesForMessage } from '../../lib/chat-utils';
import { renderMarkdown } from '../markdown';
import SearchItem from '../SearchItem';
import type { Source, Message } from '../../lib/api';

function SourcesBadge({ sources, onCopy, copied }: { sources: Source[]; onCopy: () => void; copied: boolean }) {
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
            src={`https://icons.duckduckgo.com/ip3/${src.domain}.ico`}
            width={12} height={12} loading="lazy"
            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
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
  msg, i, editIndex, editText, editRef, onEditStart, onEditSave, onEditCancel, onEditInput, onEditKeyDown,
}: {
  msg: Message; i: number; editIndex: number; editText: string;
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
        <p data-msg-content="true" ref={editIndex === i ? editRef : undefined}
          contentEditable={editIndex === i}
          suppressContentEditableWarning
          onInput={e => onEditInput((e.target as HTMLElement).innerText)}
          onKeyDown={e => onEditKeyDown(e)}
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
  msg, i, messages, liveMs, displayMs, onDiagramClick, onOpenModal, onRetry,
}: {
  msg: Message; i: number; messages: Message[]; liveMs: number;
  displayMs: number; onDiagramClick: (svg: string) => void;
  onOpenModal: () => void; onRetry: () => void;
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
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
        <span style={{ fontSize: 10.5, color: 'var(--athena-text-3)', fontVariantNumeric: 'tabular-nums' }}>
          {formatTime(displayMs)}
        </span>
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
  msg, i, messages, liveMs, displayMs, copiedIndex, onDiagramClick, onCopy, onOpenModal, onRetry,
}: {
  msg: Message; i: number; messages: Message[]; liveMs: number;
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
          <SourcesBadge
            sources={msg.data.sources}
            onCopy={onCopy}
            copied={copiedIndex === i}
          />
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

import { useState } from 'react';
import type { Source } from '../../lib/api';
import { FALLBACK_FAVICON } from '../../lib/chat-utils';

export default function SourcesPanel({ sources, maxHeight }: { sources: Source[]; maxHeight?: string }) {
  const [expanded, setExpanded] = useState(false);
  const items = expanded ? sources : sources.slice(0, 3);
  const totalCount = sources.length;
  const mh = maxHeight || '70vh';

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
      maxHeight: mh,
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '10px 12px 8px 14px', flexShrink: 0,
        fontSize: 10, color: 'var(--athena-text-3)',
        borderBottom: '0.5px solid var(--athena-border)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center' }}>
            {sources.slice(0, 4).map((s, i) => (
              <img key={i}
                src={`https://www.google.com/s2/favicons?domain=${s.domain}&sz=16`}
                width={14} height={14} loading="lazy"
                onError={(e) => { (e.target as HTMLImageElement).src = FALLBACK_FAVICON; }}
                style={{
                  borderRadius: 2, marginLeft: i === 0 ? 0 : -4,
                  position: 'relative', zIndex: 4 - i,
                }} />
            ))}
            {sources.length > 4 && (
              <span style={{ marginLeft: 2, fontSize: 8, fontWeight: 600, color: 'var(--athena-text-3)' }}>
                +{sources.length - 4}
              </span>
            )}
          </div>
          <span style={{ fontSize: 10, color: 'var(--athena-text-2)', whiteSpace: 'nowrap' }}>{totalCount} sources</span>
        </div>
      </div>

      <div style={{ height: '0.5px', background: 'var(--athena-border)', margin: '0 12px', flexShrink: 0 }} />

      <div style={{
        overflowY: 'auto',
        maxHeight: `calc(${mh} - ${expanded && totalCount > 3 ? 100 : 80}px)`,
      }}>
        {items.map((src, i) => (
          <div key={i}>
            {i > 0 && <div style={{ height: '0.5px', background: 'var(--athena-border)', margin: '0 12px' }} />}
            <a href={src.url} target="_blank" rel="noopener noreferrer" style={{
              display: 'flex', gap: 8, padding: '10px 12px 10px 14px',
              textDecoration: 'none', transition: 'background 120ms',
            }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(var(--athena-accent-rgb), 0.04)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}
            >
              {src.image && (
                <div style={{
                  width: 48, height: 48, borderRadius: 6, overflow: 'hidden',
                  flexShrink: 0, background: 'rgba(var(--athena-accent-rgb), 0.04)',
                }}>
                  <img src={src.image} alt=""
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                    onError={(e) => { (e.target as HTMLImageElement).parentElement!.style.display = 'none'; }} />
                </div>
              )}
              <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <img src={`https://www.google.com/s2/favicons?domain=${src.domain}&sz=16`} width={14} height={14} loading="lazy"
                    onError={(e) => { (e.target as HTMLImageElement).src = FALLBACK_FAVICON; }}
                    style={{ borderRadius: 2, flexShrink: 0 }} />
                  <span style={{ fontSize: 10, color: 'var(--athena-text-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {src.domain}
                  </span>
                </div>
                <div style={{
                  fontSize: 11.5, fontWeight: 600, color: 'var(--athena-text)',
                  lineHeight: 1.3, display: '-webkit-box', WebkitLineClamp: 2,
                  WebkitBoxOrient: 'vertical', overflow: 'hidden',
                }}>
                  {src.title || src.domain}
                </div>
                {src.snippet && (
                  <div style={{
                    fontSize: 10, color: 'var(--athena-text-2)', lineHeight: 1.4,
                    display: '-webkit-box', WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical', overflow: 'hidden',
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
          <button
            onClick={() => setExpanded(!expanded)}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4,
              padding: '8px 12px', background: 'none', border: 'none', cursor: 'pointer',
              fontSize: 10.5, fontWeight: 500, color: 'var(--athena-text-3)',
              fontFamily: 'inherit', flexShrink: 0, transition: 'background 120ms',
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
}

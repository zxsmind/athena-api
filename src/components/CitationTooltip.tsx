import type { CitationTooltipItem, CitationTooltipPosition } from '../lib/chat-utils';
import { FALLBACK_FAVICON } from '../lib/chat-utils';

export default function CitationTooltip({
  items,
  pos,
  tooltipRef,
}: {
  items: CitationTooltipItem[];
  pos: CitationTooltipPosition;
  tooltipRef: React.RefObject<HTMLDivElement | null>;
}) {
  return (
    <div
      className="citation-tooltip-react"
      ref={tooltipRef}
      style={{
        position: 'fixed',
        left: pos.left,
        top: pos.top,
        minWidth: 200,
        maxWidth: 'min(320px, calc(100vw - 16px))',
        maxHeight: '160px',
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
        {items.map((item, idx) => (
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
                loading="lazy"
                onError={(e) => { (e.target as HTMLImageElement).src = FALLBACK_FAVICON; }}
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
}

import { useEffect, useRef } from 'react';

export interface ContextMenuItem {
  label: string;
  onClick: () => void;
  danger?: boolean;
}

export default function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handle = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent) {
        if (e.key === 'Escape') onClose();
        return;
      }
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    /* delay listener to avoid the same right-click closing the menu immediately */
    const t = setTimeout(() => {
      document.addEventListener('mousedown', handle);
      document.addEventListener('keydown', handle);
    }, 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener('mousedown', handle);
      document.removeEventListener('keydown', handle);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      style={{
        position: 'fixed',
        zIndex: 9999,
        left: x,
        top: y,
        minWidth: 140,
        padding: 4,
        borderRadius: 10,
        background: 'var(--glass-bg-strong)',
        border: '0.5px solid var(--athena-border)',
        boxShadow: 'var(--glass-shadow-elevated)',
        backdropFilter: 'var(--blur-glass)',
        animation: 'fade-in-up 0.15s var(--ease-out) both',
      }}
    >
      {items.map((item, i) => (
        <button
          key={i}
          onClick={() => { item.onClick(); onClose(); }}
          style={{
            display: 'block',
            width: '100%',
            padding: '6px 10px',
            background: 'none',
            border: 'none',
            borderRadius: 6,
            cursor: 'pointer',
            fontSize: 12,
            fontFamily: 'inherit',
            textAlign: 'left',
            color: item.danger ? '#e74c3c' : 'var(--athena-text-2)',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = item.danger
              ? 'rgba(231, 76, 60, 0.08)'
              : 'var(--athena-border)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'none';
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
